import { randomUUID } from 'node:crypto'
import mysql, { type Pool } from 'mysql2/promise'
import type {
  ConnectionProfile,
  OpenConnectionResult,
  TestConnectionResult
} from '../../../src/types'
import { decryptPassword, encryptPassword } from '../credential'
import { loadProfiles, saveProfiles, type StoredProfile } from '../../main/store'

/**
 * 连接服务：连接配置 CRUD、测试连接、连接池生命周期。
 * 所有数据库连接只在本服务（主进程）内创建，Renderer 不可直接触达驱动。
 */

const pools = new Map<string, Pool>()

/** 将底层驱动错误归类为可理解的中文提示 */
export function classifyError(err: unknown): string {
  const e = err as { code?: string; message?: string }
  const code = e?.code ?? ''
  const msg = e?.message ?? '未知错误'
  if (['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
    return `网络不可达：${msg}`
  }
  if (code === 'ER_ACCESS_DENIED_ERROR') return `认证失败：用户名或密码错误（${msg}）`
  if (code === 'ER_DBACCESS_DENIED_ERROR') return `权限不足：${msg}`
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) return `连接超时：${msg}`
  if (code === 'ER_NOT_SUPPORTED_AUTH_MODE') return `认证插件不受支持：${msg}`
  return msg
}

function buildPoolOptions(p: StoredProfile, password: string) {
  return {
    host: p.host,
    port: p.port,
    user: p.username,
    password,
    database: p.defaultDatabase || undefined,
    charset: p.charset || 'utf8mb4',
    connectTimeout: (p.timeout || 10) * 1000,
    waitForConnections: true,
    connectionLimit: 4,
    // 大整数以字符串返回，避免 JS Number 精度丢失
    supportBigNumbers: true,
    bigNumberStrings: true,
    // 禁用多语句，逐条执行以便定位失败语句
    multipleStatements: false,
    namedPlaceholders: false
  }
}

export function listProfiles(): ConnectionProfile[] {
  // 返回时剥离凭据字段
  return loadProfiles().map(({ credential: _c, createdAt: _a, updatedAt: _b, ...p }) => p)
}

export async function saveProfile(
  profile: ConnectionProfile,
  password?: string
): Promise<ConnectionProfile> {
  const profiles = loadProfiles()
  const now = new Date().toISOString()
  const idx = profiles.findIndex((p) => p.id === profile.id)

  if (idx >= 0) {
    // 编辑：未提供新密码则保留原凭据
    const credential =
      password !== undefined ? encryptPassword(password) : profiles[idx].credential
    profiles[idx] = { ...profiles[idx], ...profile, credential, updatedAt: now }
  } else {
    profile.id = profile.id || randomUUID()
    profiles.push({
      ...profile,
      credential: encryptPassword(password ?? ''),
      createdAt: now,
      updatedAt: now
    })
  }
  saveProfiles(profiles)
  return profile
}

export async function removeProfile(id: string): Promise<void> {
  await closeConnection(id)
  saveProfiles(loadProfiles().filter((p) => p.id !== id))
}

export async function testConnection(
  profile: ConnectionProfile,
  password?: string
): Promise<TestConnectionResult> {
  // 编辑场景下未输入密码时，取已存凭据测试
  let pwd = password ?? ''
  if (password === undefined && profile.id) {
    const stored = loadProfiles().find((p) => p.id === profile.id)
    if (stored) pwd = decryptPassword(stored.credential)
  }
  const started = Date.now()
  let conn: mysql.Connection | null = null
  try {
    conn = await mysql.createConnection({
      host: profile.host,
      port: profile.port,
      user: profile.username,
      password: pwd,
      charset: profile.charset || 'utf8mb4',
      connectTimeout: (profile.timeout || 10) * 1000
    })
    const [rows] = await conn.query('SELECT VERSION() AS version, CURRENT_USER() AS currentUser')
    const r = (rows as Array<{ version: string; currentUser: string }>)[0]
    return {
      ok: true,
      version: r?.version,
      currentUser: r?.currentUser,
      latencyMs: Date.now() - started
    }
  } catch (err) {
    return { ok: false, error: classifyError(err) }
  } finally {
    if (conn) await conn.end().catch(() => undefined)
  }
}

/** 列出实例上的全部库，供编辑连接时勾选保留项。未传密码则用已存凭据。 */
export async function listServerDatabases(
  profile: ConnectionProfile,
  password?: string
): Promise<string[]> {
  let pwd = password ?? ''
  if (password === undefined && profile.id) {
    const stored = loadProfiles().find((p) => p.id === profile.id)
    if (stored) pwd = decryptPassword(stored.credential)
  }
  let conn: mysql.Connection | null = null
  try {
    conn = await mysql.createConnection({
      host: profile.host,
      port: profile.port,
      user: profile.username,
      password: pwd,
      charset: profile.charset || 'utf8mb4',
      connectTimeout: (profile.timeout || 10) * 1000
    })
    const [rows] = await conn.query('SHOW DATABASES')
    return (rows as Array<Record<string, string>>).map((r) => Object.values(r)[0])
  } finally {
    if (conn) await conn.end().catch(() => undefined)
  }
}

export async function openConnection(id: string): Promise<OpenConnectionResult> {
  await closeConnection(id)
  const stored = loadProfiles().find((p) => p.id === id)
  if (!stored) return { ok: false, error: '连接配置不存在' }

  try {
    const pool = mysql.createPool(buildPoolOptions(stored, decryptPassword(stored.credential)))
    const [dbRows] = await pool.query('SHOW DATABASES')
    const [verRows] = await pool.query('SELECT VERSION() AS version')
    pools.set(id, pool)
    const databases = (dbRows as Array<Record<string, string>>).map((r) => Object.values(r)[0])
    return {
      ok: true,
      databases,
      version: (verRows as Array<{ version: string }>)[0]?.version
    }
  } catch (err) {
    return { ok: false, error: classifyError(err) }
  }
}

export async function closeConnection(id: string): Promise<void> {
  const pool = pools.get(id)
  if (pool) {
    pools.delete(id)
    await pool.end().catch(() => undefined)
  }
}

export function getPool(id: string): Pool {
  const pool = pools.get(id)
  if (!pool) throw new Error('连接未打开或已断开，请重新连接')
  return pool
}

export async function closeAllPools(): Promise<void> {
  await Promise.all([...pools.keys()].map((id) => closeConnection(id)))
}
