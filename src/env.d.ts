/// <reference types="vite/client" />

import type {
  AnalyzeResult,
  ConnectionProfile,
  ApplyEdits,
  ExecuteOptions,
  ExecuteResponse,
  OpenConnectionResult,
  WorkspaceState,
  TableDetail,
  TableInfo,
  TestConnectionResult
} from './types'

/**
 * window.mysqlLite：preload 通过 contextBridge 暴露的白名单 API。
 * 与 electron/preload/index.ts 中的实现保持签名一致。
 */
declare global {
  interface Window {
    mysqlLite: {
      connections: {
        list: () => Promise<ConnectionProfile[]>
        save: (profile: ConnectionProfile, password?: string) => Promise<ConnectionProfile>
        remove: (id: string) => Promise<void>
        test: (profile: ConnectionProfile, password?: string) => Promise<TestConnectionResult>
        databases: (profile: ConnectionProfile, password?: string) => Promise<string[]>
        open: (id: string) => Promise<OpenConnectionResult>
        close: (id: string) => Promise<void>
      }
      meta: {
        tables: (connectionId: string, database: string) => Promise<TableInfo[]>
        tableDetail: (connectionId: string, database: string, table: string) => Promise<TableDetail>
        objectNames: (connectionId: string, database: string) => Promise<string[]>
        columnNames: (connectionId: string, database: string, table: string) => Promise<string[]>
        columnComments: (
          connectionId: string,
          database: string,
          table: string
        ) => Promise<Array<{ name: string; comment: string }>>
      }
      query: {
        analyze: (sql: string) => Promise<AnalyzeResult>
        run: (connectionId: string, sql: string, options: ExecuteOptions) => Promise<ExecuteResponse>
        count: (connectionId: string, sql: string, database: string, timeoutMs: number) => Promise<number | null>
        cancel: () => Promise<void>
        cancelCount: () => Promise<void>
        apply: (connectionId: string, edits: ApplyEdits) => Promise<void>
      }
      workspace: {
        load: () => Promise<WorkspaceState>
        save: (state: WorkspaceState) => Promise<void>
        saveSync: (state: WorkspaceState) => void
      }
      file: {
        saveCsv: (
          defaultName: string,
          columns: string[],
          rows: Array<Array<string | number | null>>
        ) => Promise<string | null>
        saveText: (defaultName: string, text: string) => Promise<string | null>
      }
    }
  }
}

export {}
