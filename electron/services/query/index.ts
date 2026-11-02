import type { FieldPacket, PoolConnection } from 'mysql2/promise'
import { Types } from 'mysql2'
import type {
  ColumnMeta,
  ExecuteOptions,
  ExecuteResponse,
  ResultEdit,
  ResultSet,
  RowData
} from '../../../src/types'
import { getPool } from '../connection'
import { analyzeSql, firstKeyword, READONLY_WHITELIST, toCountSql, withPreviewLimit } from './sqlParse'

/**
 * 查询执行服务：只读拦截、危险语句确认、逐条执行与结果清洗。
 * SQL 拆分与风险识别逻辑见 sqlParse.ts（纯函数，可独立单测）。
 * 安全约定：multipleStatements=false，一次一条；标识符/值由驱动转义。
 */

export { analyzeSql }

/** 当前正在执行的连接，供「停止」销毁以中断查询 */
let runningConn: PoolConnection | null = null
/** 后台统计总数的连接，与查询分开，避免统计拖住结果返回 */
let countingConn: PoolConnection | null = null

export function cancelRunning(): void {
  const conn = runningConn
  runningConn = null
  conn?.destroy()
}

export function cancelCounting(): void {
  const conn = countingConn
  countingConn = null
  conn?.destroy()
}

function isStopped(err: unknown): boolean {
  const e = err as { message?: string; code?: string }
  return e?.code === 'PROTOCOL_CONNECTION_LOST' || /closed state|connection lost/i.test(e?.message ?? '')
}

/** 统计原语句总行数。取消或无需统计时返回 null。 */
export async function countRows(
  connectionId: string,
  sql: string,
  database: string,
  timeoutMs: number
): Promise<number | null> {
  const countSql = toCountSql(sql)
  if (!countSql) return null
  const pool = getPool(connectionId)
  let conn: PoolConnection | null = null
  try {
    conn = await pool.getConnection()
    countingConn = conn
    if (database) await conn.query({ sql: 'USE ??', values: [database] })
    const [rows] = await conn.query({ sql: countSql, timeout: timeoutMs })
    const value = Object.values((rows as Array<Record<string, unknown>>)[0] ?? {})[0]
    const total = Number(value)
    return Number.isFinite(total) ? total : null
  } catch (err) {
    if (isStopped(err)) return null
    throw err
  } finally {
    if (conn && countingConn === conn) {
      countingConn = null
      conn.release()
    }
  }
}

/** mysql2 数值类型码 → 名称（仅用于结果列头展示） */
const TYPE_NAMES: Record<number, string> = Object.entries(Types).reduce(
  (acc, [name, code]) => {
    if (typeof code === 'number') acc[code] = name.toUpperCase()
    return acc
  },
  {} as Record<number, string>
)

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 将驱动返回的单元格值转换为 IPC 可安全序列化且前端可直接展示的形态。
 * Buffer（BLOB/BINARY/BIT）转截断十六进制；Date 转本地时间字符串；JSON 对象序列化。
 */
function sanitizeValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) {
    const hex = value.subarray(0, 32).toString('hex').toUpperCase()
    return `0x${hex}${value.length > 32 ? '…' : ''}`
  }
  if (value instanceof Date) return formatDate(value)
  if (typeof value === 'number' || typeof value === 'string') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? 1 : 0
  return JSON.stringify(value)
}

/** MySQL 协议里的主键标记。结果列自带，不必再查 information_schema */
const PRI_KEY_FLAG = 2

function fieldOrigin(f: FieldPacket): { schema: string; table: string; orgName: string } {
  return {
    schema: f.schema || f.db || '',
    table: f.orgTable || '',
    orgName: f.orgName || ''
  }
}

/** 自连接会有多个别名，不能当成单表更新 */
function singleTable(fields: FieldPacket[]): boolean {
  const origins = new Set<string>()
  const aliases = new Set<string>()
  for (const f of fields) {
    if (f.orgTable) origins.add(f.orgTable)
    if (f.table) aliases.add(f.table)
  }
  return origins.size === 1 && aliases.size === 1
}

function primaryKeyNames(fields: FieldPacket[]): string[] {
  const names: string[] = []
  for (const f of fields) {
    const flags = typeof f.flags === 'number' ? f.flags : 0
    if ((flags & PRI_KEY_FLAG) === 0) continue
    const name = f.orgName || ''
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * 只有全部基表列来自同一张表，且主键每一列都出现在结果里，才能写回。
 * keyColumns 用结果列名，方便按行取值；写库时再换成真实列名。
 */
function buildEdit(columns: ColumnMeta[], primaryKey: string[]): ResultEdit | null {
  const tables = [...new Set(columns.map((c) => c.table).filter((t) => t.length > 0))]
  if (tables.length !== 1 || primaryKey.length === 0) return null
  const table = tables[0]
  const keyColumns: string[] = []
  for (const pk of primaryKey) {
    const found = columns.find((c) => c.table === table && c.orgName === pk)
    if (!found) return null
    keyColumns.push(found.name)
  }
  return { table, keyColumns }
}

function buildResultSet(
  statement: string,
  result: unknown,
  fields: FieldPacket[] | undefined,
  durationMs: number,
  maxRows: number,
  primaryKey: string[],
  previewOffset: number | null
): ResultSet {
  // SELECT/SHOW 等：result 为行数组
  if (Array.isArray(result)) {
    const columns: ColumnMeta[] = (fields ?? []).map((f) => {
      const origin = fieldOrigin(f)
      return {
        name: f.name,
        type: TYPE_NAMES[f.type ?? -1] ?? 'UNKNOWN',
        comment: '',
        schema: origin.schema,
        table: origin.table,
        orgName: origin.orgName
      }
    })
    const truncated = result.length > maxRows
    const rows: RowData[] = (result.slice(0, maxRows) as Array<Record<string, unknown>>).map(
      (row) => {
        const out: RowData = {}
        for (const key of Object.keys(row)) out[key] = sanitizeValue(row[key])
        return out
      }
    )
    return {
      statement,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows: null,
      durationMs,
      truncated,
      previewOffset,
      edit: buildEdit(columns, primaryKey)
    }
  }
  // INSERT/UPDATE/DELETE 等：OkPacket
  const ok = result as { affectedRows?: number }
  return {
    statement,
    columns: [],
    rows: [],
    rowCount: 0,
    affectedRows: ok?.affectedRows ?? 0,
    durationMs,
    truncated: false,
    previewOffset: null,
    edit: null
  }
}

export async function executeSql(
  connectionId: string,
  sql: string,
  options: ExecuteOptions
): Promise<ExecuteResponse> {
  const pool = getPool(connectionId)
  const { statements, risks } = analyzeSql(sql)

  if (statements.length === 0) return { ok: true, sets: [] }

  // 只读模式：存在白名单外语句则整体拒绝执行
  if (options.readonly) {
    for (const stmt of statements) {
      const kw = firstKeyword(stmt)
      if (!READONLY_WHITELIST.has(kw)) {
        return {
          ok: false,
          sets: [],
          blocked: `只读模式已开启：仅允许 SELECT/SHOW/EXPLAIN/DESC，已拦截 ${kw || '未知'} 语句`
        }
      }
    }
  }

  // 危险语句：未经确认则返回风险清单，由前端二次确认后带 confirmed 重试
  if (risks.length > 0 && !options.confirmed) {
    return { ok: false, sets: [], needConfirm: risks }
  }

  let conn: PoolConnection | null = null
  const sets: ResultSet[] = []
  try {
    conn = await pool.getConnection()
    runningConn = conn
    if (options.database) {
      await conn.query({ sql: 'USE ??', values: [options.database] })
    }
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i]
      const started = Date.now()
      const preview = withPreviewLimit(stmt, options.maxRows, options.offset ?? 0)
      try {
        const [result, fields] = await conn.query({ sql: preview.sql, timeout: options.timeoutMs })
        const durationMs = Date.now() - started
        const packets = (fields ?? []) as FieldPacket[]
        sets.push(
          buildResultSet(
            stmt,
            result,
            packets,
            durationMs,
            options.maxRows,
            Array.isArray(result) && singleTable(packets) ? primaryKeyNames(packets) : [],
            preview.limited ? (options.offset ?? 0) : null
          )
        )
      } catch (err) {
        const e = err as { message?: string; code?: string }
        const stopped = isStopped(err)
        return {
          ok: false,
          sets,
          error: {
            index: i,
            message: stopped ? '查询已停止' : (e?.message ?? '执行失败'),
            code: e?.code,
            statement: stmt
          }
        }
      }
    }
    return { ok: true, sets }
  } finally {
    if (conn && runningConn === conn) {
      runningConn = null
      conn.release()
    }
  }
}
