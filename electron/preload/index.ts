import { contextBridge, ipcRenderer } from 'electron'
import type {
  AnalyzeResult,
  ColumnMeta,
  ConnectionProfile,
  ApplyEdits,
  ExecuteOptions,
  ExecuteResponse,
  OpenConnectionResult,
  WorkspaceState,
  TableDetail,
  TableInfo,
  TestConnectionResult
} from '../../src/types'

/**
 * Preload：通过 contextBridge 向 Renderer 暴露白名单 API。
 * Renderer 无 Node/驱动访问权，所有能力均经 ipcRenderer.invoke 转发到主进程校验执行。
 */

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

const api = {
  connections: {
    list: () => invoke<ConnectionProfile[]>('conn:list'),
    save: (profile: ConnectionProfile, password?: string) =>
      invoke<ConnectionProfile>('conn:save', profile, password),
    remove: (id: string) => invoke<void>('conn:remove', id),
    test: (profile: ConnectionProfile, password?: string) =>
      invoke<TestConnectionResult>('conn:test', profile, password),
    databases: (profile: ConnectionProfile, password?: string) =>
      invoke<string[]>('conn:databases', profile, password),
    open: (id: string) => invoke<OpenConnectionResult>('conn:open', id),
    close: (id: string) => invoke<void>('conn:close', id)
  },
  meta: {
    tables: (connectionId: string, database: string) =>
      invoke<TableInfo[]>('meta:tables', connectionId, database),
    tableDetail: (connectionId: string, database: string, table: string) =>
      invoke<TableDetail>('meta:tableDetail', connectionId, database, table),
    objectNames: (connectionId: string, database: string) =>
      invoke<string[]>('meta:objectNames', connectionId, database),
    columnNames: (connectionId: string, database: string, table: string) =>
      invoke<string[]>('meta:columnNames', connectionId, database, table),
    columnComments: (connectionId: string, database: string, table: string) =>
      invoke<Array<{ name: string; comment: string }>>('meta:columnComments', connectionId, database, table)
  },
  query: {
    analyze: (sql: string) => invoke<AnalyzeResult>('query:analyze', sql),
    run: (connectionId: string, sql: string, options: ExecuteOptions) =>
      invoke<ExecuteResponse>('query:run', connectionId, sql, options),
    count: (connectionId: string, sql: string, database: string, timeoutMs: number) =>
      invoke<number | null>('query:count', connectionId, sql, database, timeoutMs),
    cancel: () => invoke<void>('query:cancel'),
    cancelCount: () => invoke<void>('query:cancelCount'),
    apply: (connectionId: string, edits: ApplyEdits) => invoke<void>('query:apply', connectionId, edits)
  },
  workspace: {
    load: () => invoke<WorkspaceState>('workspace:load'),
    save: (state: WorkspaceState) => invoke<void>('workspace:save', state),
    saveSync: (state: WorkspaceState) => {
      ipcRenderer.sendSync('workspace:saveSync', state)
    }
  },
  file: {
    saveCsv: (defaultName: string, columns: string[], rows: Array<Array<string | number | null>>) =>
      invoke<string | null>('file:saveCsv', defaultName, columns, rows),
    saveText: (defaultName: string, text: string) =>
      invoke<string | null>('file:saveText', defaultName, text)
  }
}

export type MysqlLiteApi = typeof api

contextBridge.exposeInMainWorld('mysqlLite', api)
