import type { PoolConnection } from 'mysql2/promise'
import type { ApplyEdits, CellValue } from '../../../src/types'
import { getPool } from '../connection'

/**
 * 结果区保存：只接受结构化改动，标识符校验后用占位符写回。
 * 不走只读开关。任一语句失败则整单回滚。
 */

const MAX_OPS = 1000
const MAX_CELL = 1_000_000

function assertIdent(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64 || /[\u0000`\\.]/.test(v)) {
    throw new Error(`参数非法：${name}`)
  }
  return v
}

function assertCell(v: unknown): CellValue {
  if (v === null) return null
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('参数非法：单元格')
    return v
  }
  if (typeof v === 'string') {
    if (v.length > MAX_CELL) throw new Error('单元格内容过长')
    return v
  }
  throw new Error('参数非法：单元格')
}

function assertPairs(
  v: unknown,
  name: string
): Array<{ column: string; value: CellValue }> {
  if (!Array.isArray(v) || v.length === 0 || v.length > 200) throw new Error(`参数非法：${name}`)
  return v.map((item) => {
    const pair = item as { column?: unknown; value?: unknown }
    return { column: assertIdent(pair?.column, name), value: assertCell(pair?.value) }
  })
}

function assertEdits(v: unknown): ApplyEdits {
  const raw = v as ApplyEdits
  const updates = Array.isArray(raw?.updates) ? raw.updates : null
  const inserts = Array.isArray(raw?.inserts) ? raw.inserts : null
  const deletes = Array.isArray(raw?.deletes) ? raw.deletes : null
  if (!updates || !inserts || !deletes) throw new Error('参数非法：edits')
  if (updates.length + inserts.length + deletes.length > MAX_OPS) throw new Error('一次保存的行数过多')
  return {
    database: assertIdent(raw.database, 'database'),
    table: assertIdent(raw.table, 'table'),
    updates: updates.map((row) => ({
      keys: assertPairs(row?.keys, 'keys'),
      set: assertPairs(row?.set, 'set')
    })),
    inserts: inserts.map((row) => assertPairs(row, 'insert')),
    deletes: deletes.map((row) => assertPairs(row, 'delete'))
  }
}

async function runUpdate(conn: PoolConnection, table: string, row: ApplyEdits['updates'][number]): Promise<void> {
  const setSql = row.set.map(() => '?? = ?').join(', ')
  const whereSql = row.keys.map(() => '?? <=> ?').join(' AND ')
  const values: Array<string | number | null> = [table]
  for (const pair of row.set) values.push(pair.column, pair.value)
  for (const pair of row.keys) values.push(pair.column, pair.value)
  await conn.query({ sql: `UPDATE ?? SET ${setSql} WHERE ${whereSql}`, values })
}

async function runInsert(
  conn: PoolConnection,
  table: string,
  row: ApplyEdits['inserts'][number]
): Promise<void> {
  const cols = row.map(() => '??').join(', ')
  const marks = row.map(() => '?').join(', ')
  const values: Array<string | number | null> = [table]
  for (const pair of row) values.push(pair.column)
  for (const pair of row) values.push(pair.value)
  await conn.query({ sql: `INSERT INTO ?? (${cols}) VALUES (${marks})`, values })
}

async function runDelete(
  conn: PoolConnection,
  table: string,
  keys: ApplyEdits['deletes'][number]
): Promise<void> {
  const whereSql = keys.map(() => '?? <=> ?').join(' AND ')
  const values: Array<string | number | null> = [table]
  for (const pair of keys) values.push(pair.column, pair.value)
  await conn.query({ sql: `DELETE FROM ?? WHERE ${whereSql}`, values })
}

export async function applyEdits(connectionId: string, edits: unknown): Promise<void> {
  const parsed = assertEdits(edits)
  const pool = getPool(connectionId)
  const conn = await pool.getConnection()
  try {
    await conn.query({ sql: 'USE ??', values: [parsed.database] })
    await conn.beginTransaction()
    try {
      for (const row of parsed.updates) await runUpdate(conn, parsed.table, row)
      for (const row of parsed.inserts) await runInsert(conn, parsed.table, row)
      for (const row of parsed.deletes) await runDelete(conn, parsed.table, row)
      await conn.commit()
    } catch (err) {
      await conn.rollback()
      throw err
    }
  } finally {
    conn.release()
  }
}
