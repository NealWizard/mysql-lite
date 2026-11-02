/**
 * 主进程与渲染进程共享的 IPC 类型定义。
 * 仅作类型导入（import type），不产生跨进程的运行时代码依赖。
 */

/** 连接配置（不含明文密码，密码存 safeStorage） */
export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  defaultDatabase: string
  charset: string
  /** 连接超时（秒） */
  timeout: number
  /**
   * 连接树保留的库。null 表示不筛选、显示全部；
   * 空数组表示一个都不显示；非空则只显示列出的库。
   */
  visibleDatabases: string[] | null
}

/** 编辑区工作区：选项卡文本和结果区高度，供下次启动恢复 */
export interface WorkspaceTab {
  id: string
  title: string
  sql: string
}

export interface WorkspaceState {
  activeTabId: string
  tabs: WorkspaceTab[]
  /** 结果区外框高度，像素。没有则用默认 540 */
  resultHeight?: number
}

/** 测试连接结果 */
export interface TestConnectionResult {
  ok: boolean
  version?: string
  currentUser?: string
  latencyMs?: number
  error?: string
}

/** 打开连接结果 */
export interface OpenConnectionResult {
  ok: boolean
  databases?: string[]
  version?: string
  error?: string
}

/** 结果集列元数据 */
export interface ColumnMeta {
  name: string
  type: string
  /** 列注释。执行时为空，悬停表头后再填 */
  comment: string
  /** 真实库名。表达式列为空串 */
  schema: string
  /** 真实表名。表达式列为空串 */
  table: string
  /** 真实列名。表达式列为空串 */
  orgName: string
}

/** 结果可写回时的定位信息。null 表示这批结果不能编辑 */
export interface ResultEdit {
  table: string
  /** 主键在结果里的列名，顺序与主键一致 */
  keyColumns: string[]
}

/** 单元格值 */
export type CellValue = string | number | null

/** 结果区一次保存提交的结构化改动，不含拼好的 SQL */
export interface ApplyEdits {
  database: string
  table: string
  updates: Array<{
    /** 改之前的主键 */
    keys: Array<{ column: string; value: CellValue }>
    /** 只含改过的列，column 为真实列名 */
    set: Array<{ column: string; value: CellValue }>
  }>
  inserts: Array<Array<{ column: string; value: CellValue }>>
  deletes: Array<Array<{ column: string; value: CellValue }>>
}

/** 单行数据：值已被主进程转为 IPC 可安全序列化的形态 */
export type RowData = Record<string, string | number | null>

/** 单个语句的执行结果集 */
export interface ResultSet {
  /** 产生该结果的 SQL 语句 */
  statement: string
  columns: ColumnMeta[]
  rows: RowData[]
  /** 返回行数（SELECT）；写操作为 0 */
  rowCount: number
  /** 影响行数（INSERT/UPDATE/DELETE），查询语句为 null */
  affectedRows: number | null
  durationMs: number
  /** 行数是否被 maxRows 截断 */
  truncated: boolean
  /** 客户端补的预览偏移。null 表示没改写语句（已有 LIMIT，或不是 SELECT） */
  previewOffset: number | null
  /** 能按主键写回时非空 */
  edit: ResultEdit | null
}

/** 执行错误信息 */
export interface ExecuteError {
  /** 失败语句序号（从 0 开始） */
  index: number
  message: string
  code?: string
  statement: string
}

/** 批量执行响应 */
export interface ExecuteResponse {
  ok: boolean
  sets: ResultSet[]
  error?: ExecuteError
  /** 只读模式拦截原因（非空表示被只读模式拒绝，未执行） */
  blocked?: string
  /** 命中危险语句，需用户确认后带 confirmed=true 重试 */
  needConfirm?: StatementRisk[]
}

/** 危险语句描述 */
export interface StatementRisk {
  index: number
  reason: string
  statement: string
}

/** SQL 分析结果（语句拆分 + 风险识别） */
export interface AnalyzeResult {
  statements: string[]
  risks: StatementRisk[]
}

/** 执行选项 */
export interface ExecuteOptions {
  database: string
  readonly: boolean
  maxRows: number
  timeoutMs: number
  /** 用户已确认执行危险语句 */
  confirmed: boolean
  /** 预览分页偏移，仅对自动补 LIMIT 的 SELECT 生效 */
  offset?: number
}

/** 表清单项（表结构管理左栏） */
export interface TableInfo {
  name: string
  comment: string
  rows: number
  createTime: string
}

/** 字段信息 */
export interface ColumnInfo {
  ordinal: number
  name: string
  type: string
  nullable: boolean
  defaultValue: string | null
  comment: string
  key: string
  /** information_schema.EXTRA，例如 auto_increment、on update CURRENT_TIMESTAMP */
  extra: string
}

/** 索引信息 */
export interface IndexInfo {
  name: string
  columns: string
  unique: boolean
}

/** 表结构详情（表结构管理右栏） */
export interface TableDetail {
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  ddl: string
  stats: {
    rows: number
    dataSizeMb: number
    collation: string
    engine: string
    comment: string
  }
}
