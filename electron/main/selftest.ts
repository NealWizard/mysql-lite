import type { App } from 'electron'
import { getPool } from '../services/connection'
import {
  closeAllPools,
  openConnection,
  removeProfile,
  saveProfile,
  testConnection
} from '../services/connection'
import { listTables, tableDetail } from '../services/mysql'
import { executeSql } from '../services/query'
import type { ConnectionProfile } from '../../src/types'

/**
 * 端到端自检：以真实主进程服务直连本机测试库，覆盖连接、元数据、
 * 查询执行、只读拦截、危险确认、结果清洗、错误定位等关键链路。
 * 运行方式：electron-vite build 后，设 MYSQL_LITE_SELFTEST=1 启动 electron。
 * 全程不写业务表（临时表会话级，自动清理），结束自动删除自检连接配置。
 */

const PROFILE: ConnectionProfile = {
  id: 'selftest-local',
  name: 'selftest',
  host: '127.0.0.1',
  port: 33066,
  username: 'root',
  defaultDatabase: 'test',
  charset: 'utf8mb4',
  timeout: 10,
  visibleDatabases: null
}

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`PASS: ${name}`)
  } else {
    failed++
    console.error(`FAIL: ${name} ${detail}`)
  }
}

export async function runSelftest(app: App): Promise<void> {
  try {
    // 1. 保存配置 + 测试连接（含 safeStorage 凭据落盘）
    await saveProfile(PROFILE, 'root')
    const t = await testConnection(PROFILE)
    check('测试连接', t.ok === true && !!t.version, JSON.stringify(t))

    // 2. 打开连接池，拿到库清单
    const opened = await openConnection(PROFILE.id)
    check('打开连接', opened.ok === true, JSON.stringify(opened))
    check('库清单含 test', (opened.databases ?? []).includes('test'))
    const pool = getPool(PROFILE.id)

    // 3. 元数据：表清单 + 表详情
    const tables = await listTables(pool, 'test')
    check('表清单非空', tables.length >= 20, `实际 ${tables.length} 张`)
    const detail = await tableDetail(pool, 'test', tables[0].name)
    check('表详情字段', detail.columns.length > 0)
    check('表详情 DDL', /CREATE TABLE/i.test(detail.ddl))
    check('表详情统计', typeof detail.stats.dataSizeMb === 'number' && !!detail.stats.engine)

    // 4. 只读模式：SELECT 放行、UPDATE 拦截、多语句逐条执行
    const base = { database: 'test', maxRows: 100, timeoutMs: 10000, confirmed: false }
    const sel = await executeSql(PROFILE.id, 'SELECT 1 AS one', { ...base, readonly: true })
    // bigNumberStrings 开启后数值以字符串返回（防精度丢失），此处为预期行为
    check('只读放行 SELECT', sel.ok && String(sel.sets[0]?.rows[0]?.one) === '1')
    const upd = await executeSql(PROFILE.id, `UPDATE ${tables[0].name} SET id = id`, {
      ...base,
      readonly: true
    })
    check('只读拦截 UPDATE', !upd.ok && !!upd.blocked, JSON.stringify(upd))
    const multi = await executeSql(PROFILE.id, 'SELECT 1 AS a; SELECT 2 AS b', {
      ...base,
      readonly: true
    })
    check('多语句逐条执行', multi.ok && multi.sets.length === 2)

    // 5. 危险语句识别：DROP / 无 WHERE 的 DELETE 需二次确认，确认后可执行
    const drop = await executeSql(PROFILE.id, 'DROP TEMPORARY TABLE IF EXISTS __st', {
      ...base,
      readonly: false
    })
    check('DROP 触发确认', !drop.ok && (drop.needConfirm ?? []).length > 0)
    const del = await executeSql(PROFILE.id, `DELETE FROM ${tables[0].name}`, {
      ...base,
      readonly: false
    })
    check('无 WHERE 的 DELETE 触发确认', !del.ok && (del.needConfirm ?? []).length > 0)
    const tmp = await executeSql(
      PROFILE.id,
      'CREATE TEMPORARY TABLE __st (id INT); DROP TEMPORARY TABLE __st',
      { ...base, readonly: false, confirmed: true }
    )
    check('确认后危险语句可执行（临时表）', tmp.ok && tmp.sets.length === 2, JSON.stringify(tmp.error ?? ''))

    // 6. maxRows 截断
    const union = Array.from({ length: 20 }, (_, i) => `SELECT ${i + 1} AS n`).join(' UNION ALL ')
    const trunc = await executeSql(PROFILE.id, union, { ...base, maxRows: 5, readonly: true })
    check(
      'maxRows 截断',
      trunc.ok && trunc.sets[0].rowCount === 5 && trunc.sets[0].truncated === true
    )

    // 7. 结果清洗：Date → 字符串、Buffer → 十六进制、列类型名
    const clean = await executeSql(
      PROFILE.id,
      `SELECT NOW() AS dt, UNHEX('AABB') AS bin, 1.5 AS deci`,
      { ...base, readonly: true }
    )
    const row = clean.sets[0]?.rows[0] ?? {}
    check('Date 清洗为字符串', typeof row.dt === 'string' && /\d{4}-\d{2}-\d{2}/.test(String(row.dt)))
    check('Buffer 清洗为 hex', row.bin === '0xAABB', String(row.bin))
    check('列类型名存在', (clean.sets[0]?.columns ?? []).every((c) => !!c.type))

    // 8.1 列注释反查：真实表的列应带 comment 字段（表达式列为空串）
    const cmt = await executeSql(PROFILE.id, `SELECT * FROM ${tables[0].name} LIMIT 1`, {
      ...base,
      readonly: true
    })
    check(
      '列注释元数据存在',
      cmt.ok && (cmt.sets[0]?.columns ?? []).every((c) => typeof c.comment === 'string')
    )

    // 8. 错误定位：第二条语句语法错误，应报 index=1
    // 用语法合法但服务端报错的语句（不存在的表），避免被只读白名单提前拦截
    const bad = await executeSql(PROFILE.id, 'SELECT 1; SELECT * FROM __not_exist__', {
      ...base,
      readonly: true
    })
    check('错误定位到失败语句', !bad.ok && bad.error?.index === 1, JSON.stringify(bad.error ?? ''))
  } catch (err) {
    failed++
    console.error('FAIL: 自检异常', err)
  } finally {
    await closeAllPools()
    await removeProfile(PROFILE.id).catch(() => undefined)
    console.log(`SELFTEST RESULT: ${passed} PASS, ${failed} FAIL`)
    app.exit(failed === 0 ? 0 : 1)
  }
}
