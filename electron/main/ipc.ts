import { BrowserWindow, dialog, ipcMain } from 'electron'
import { createWriteStream } from 'node:fs'
import type { ConnectionProfile, ExecuteOptions, WorkspaceState } from '../../src/types'
import {
  closeConnection,
  listProfiles,
  listServerDatabases,
  openConnection,
  removeProfile,
  saveProfile,
  testConnection
} from '../services/connection'
import { listColumnComments, listColumnNames, listObjectNames, listTables, tableDetail } from '../services/mysql'
import { analyzeSql, cancelCounting, cancelRunning, countRows, executeSql } from '../services/query'
import { applyEdits } from '../services/query/apply'
import { getPool } from '../services/connection'
import { loadWorkspace, saveWorkspace } from './workspace'

/**
 * IPC 注册：Renderer 仅能调用此处登记的白名单通道。
 * 所有入参在主进程侧做类型校验，不信任 Renderer 输入。
 */

function assertString(v: unknown, name: string, maxLen = 2000): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > maxLen) {
    throw new Error(`参数非法：${name}`)
  }
  return v
}

function assertProfile(v: unknown): ConnectionProfile {
  const p = v as ConnectionProfile
  assertString(p?.name ?? '', 'name', 100)
  assertString(p?.host ?? '', 'host', 255)
  if (!Number.isInteger(p?.port) || p.port < 1 || p.port > 65535) {
    throw new Error('参数非法：port')
  }
  assertString(p?.username ?? '', 'username', 100)
  return {
    id: typeof p.id === 'string' ? p.id : '',
    name: p.name.trim(),
    host: p.host.trim(),
    port: p.port,
    username: p.username.trim(),
    defaultDatabase: typeof p.defaultDatabase === 'string' ? p.defaultDatabase.trim() : '',
    charset: typeof p.charset === 'string' && p.charset ? p.charset : 'utf8mb4',
    timeout: Number.isInteger(p.timeout) && p.timeout > 0 ? p.timeout : 10,
    visibleDatabases: Array.isArray(p.visibleDatabases)
      ? p.visibleDatabases.filter((d) => typeof d === 'string' && d.length > 0 && d.length <= 128).slice(0, 500)
      : null
  }
}

function assertWorkspace(v: unknown): WorkspaceState {
  const state = v as WorkspaceState
  if (!state || !Array.isArray(state.tabs)) throw new Error('参数非法：workspace')
  const resultHeight =
    typeof state.resultHeight === 'number' && Number.isFinite(state.resultHeight)
      ? Math.round(state.resultHeight)
      : undefined
  return {
    activeTabId: typeof state.activeTabId === 'string' ? state.activeTabId : '',
    tabs: state.tabs,
    resultHeight
  }
}

function assertExecuteOptions(v: unknown): ExecuteOptions {
  const o = v as ExecuteOptions
  return {
    database: typeof o?.database === 'string' ? o.database : '',
    readonly: Boolean(o?.readonly),
    maxRows: Number.isInteger(o?.maxRows) && o.maxRows > 0 ? Math.min(o.maxRows, 100000) : 1000,
    timeoutMs:
      Number.isInteger(o?.timeoutMs) && o.timeoutMs > 0 ? Math.min(o.timeoutMs, 600000) : 60000,
    confirmed: Boolean(o?.confirmed),
    offset: Number.isInteger(o?.offset) && (o?.offset ?? 0) >= 0 ? Math.min(o?.offset ?? 0, 10_000_000) : 0
  }
}

/** CSV 单元格转义：含逗号/引号/换行时加引号并双写引号 */
function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function saveTextFile(
  win: BrowserWindow | null,
  defaultName: string,
  filterName: string,
  ext: string,
  content: string
): Promise<string | null> {
  const opts: Electron.SaveDialogOptions = {
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions: [ext] }]
  }
  const result = win
    ? await dialog.showSaveDialog(win, opts)
    : await dialog.showSaveDialog(opts)
  if (result.canceled || !result.filePath) return null
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(result.filePath!, { encoding: 'utf-8' })
    stream.on('error', reject)
    stream.on('finish', () => resolve())
    stream.end(content)
  })
  return result.filePath
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  // ---------- 连接管理 ----------
  ipcMain.handle('conn:list', () => listProfiles())

  ipcMain.handle('conn:save', (_e, profile: unknown, password: unknown) => {
    const pwd = typeof password === 'string' ? password : undefined
    return saveProfile(assertProfile(profile), pwd)
  })

  ipcMain.handle('conn:remove', (_e, id: unknown) => removeProfile(assertString(id, 'id', 64)))

  ipcMain.handle('conn:test', (_e, profile: unknown, password: unknown) => {
    const pwd = typeof password === 'string' ? password : undefined
    return testConnection(assertProfile(profile), pwd)
  })

  ipcMain.handle('conn:databases', (_e, profile: unknown, password: unknown) => {
    const pwd = typeof password === 'string' ? password : undefined
    return listServerDatabases(assertProfile(profile), pwd)
  })

  ipcMain.handle('conn:open', (_e, id: unknown) => openConnection(assertString(id, 'id', 64)))

  ipcMain.handle('conn:close', (_e, id: unknown) => closeConnection(assertString(id, 'id', 64)))

  // ---------- 元数据 ----------
  ipcMain.handle('meta:tables', (_e, connId: unknown, db: unknown) =>
    listTables(getPool(assertString(connId, 'connId', 64)), assertString(db, 'database', 128))
  )

  ipcMain.handle('meta:objectNames', (_e, connId: unknown, db: unknown) =>
    listObjectNames(getPool(assertString(connId, 'connId', 64)), assertString(db, 'database', 128))
  )

  ipcMain.handle('meta:columnComments', (_e, connId: unknown, db: unknown, table: unknown) =>
    listColumnComments(
      getPool(assertString(connId, 'connId', 64)),
      assertString(db, 'database', 128),
      assertString(table, 'table', 128)
    )
  )

  ipcMain.handle('meta:columnNames', (_e, connId: unknown, db: unknown, table: unknown) =>
    listColumnNames(
      getPool(assertString(connId, 'connId', 64)),
      assertString(db, 'database', 128),
      assertString(table, 'table', 128)
    )
  )

  ipcMain.handle('meta:tableDetail', (_e, connId: unknown, db: unknown, table: unknown) =>
    tableDetail(
      getPool(assertString(connId, 'connId', 64)),
      assertString(db, 'database', 128),
      assertString(table, 'table', 128)
    )
  )

  // ---------- 查询 ----------
  ipcMain.handle('query:analyze', (_e, sql: unknown) =>
    analyzeSql(assertString(sql, 'sql', 1024 * 1024))
  )

  ipcMain.handle('query:run', (_e, connId: unknown, sql: unknown, options: unknown) =>
    executeSql(
      assertString(connId, 'connId', 64),
      assertString(sql, 'sql', 1024 * 1024),
      assertExecuteOptions(options)
    )
  )

  ipcMain.handle('query:count', (_e, connId: unknown, sql: unknown, database: unknown, timeoutMs: unknown) =>
    countRows(
      assertString(connId, 'connId', 64),
      assertString(sql, 'sql', 1024 * 1024),
      typeof database === 'string' ? database : '',
      Number.isInteger(timeoutMs) && (timeoutMs as number) > 0 ? Math.min(timeoutMs as number, 600000) : 60000
    )
  )

  ipcMain.handle('query:cancel', () => {
    cancelRunning()
    cancelCounting()
  })

  ipcMain.handle('query:cancelCount', () => {
    cancelCounting()
  })

  // 结果区保存。明确写库，不看只读开关
  ipcMain.handle('query:apply', (_e, connId: unknown, edits: unknown) =>
    applyEdits(assertString(connId, 'connId', 64), edits)
  )

  // ---------- 文件导出 ----------
  ipcMain.handle('file:saveCsv', async (_e, defaultName: unknown, columns: unknown, rows: unknown) => {
    const cols = (columns as unknown[]).map((c) => String(c))
    const data = rows as Array<Array<string | number | null>>
    if (!Array.isArray(data)) throw new Error('参数非法：rows')
    const lines = [cols.map(csvCell).join(',')]
    for (const row of data) lines.push(row.map(csvCell).join(','))
    // 带 BOM 的 UTF-8，保证 Excel 打开中文不乱码
    const content = `\uFEFF${lines.join('\r\n')}`
    return saveTextFile(getWindow(), String(defaultName ?? 'result.csv'), 'CSV 文件', 'csv', content)
  })

  ipcMain.handle('workspace:load', () => loadWorkspace())

  ipcMain.handle('workspace:save', (_e, state: unknown) => {
    saveWorkspace(assertWorkspace(state))
  })

  ipcMain.on('workspace:saveSync', (e, state: unknown) => {
    saveWorkspace(assertWorkspace(state))
    e.returnValue = true
  })

  ipcMain.handle('file:saveText', (_e, defaultName: unknown, text: unknown) =>
    saveTextFile(
      getWindow(),
      String(defaultName ?? 'export.sql'),
      'SQL 文件',
      'sql',
      assertString(text, 'text', 10 * 1024 * 1024)
    )
  )
}
