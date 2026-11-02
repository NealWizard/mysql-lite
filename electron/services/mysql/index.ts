import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { ColumnInfo, IndexInfo, TableDetail, TableInfo } from '../../../src/types'

/**
 * 元数据服务：库表清单、表结构（字段/索引/DDL/统计）。
 * 标识符统一使用 ?? 占位符转义，值使用 ? 参数化，杜绝拼接注入。
 */

export async function listTables(pool: Pool, database: string): Promise<TableInfo[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment,
            IFNULL(TABLE_ROWS, 0) AS \`rows\`,
            IFNULL(DATE_FORMAT(CREATE_TIME, '%Y-%m-%d %H:%i:%s'), '') AS createTime
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`,
    [database]
  )
  return rows as unknown as TableInfo[]
}

/** 补全用：只要当前库的表名和视图名 */
export async function listObjectNames(pool: Pool, database: string): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS name
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
     ORDER BY TABLE_NAME`,
    [database]
  )
  return namesOf(rows)
}

/** 列注释。悬停表头时再查，不放进查询耗时 */
export async function listColumnComments(
  pool: Pool,
  database: string,
  table: string
): Promise<Array<{ name: string; comment: string }>> {
  const [rows] = await pool.query<RowDataPacket[]>(`SHOW FULL COLUMNS FROM ?? . ??`, [database, table])
  return rows
    .map((r) => ({ name: String(r.Field ?? ''), comment: String(r.Comment ?? '') }))
    .filter((r) => r.name.length > 0)
}
export async function listColumnNames(pool: Pool, database: string, table: string): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [database, table]
  )
  return namesOf(rows)
}

function namesOf(rows: RowDataPacket[]): string[] {
  const names: string[] = []
  for (const row of rows) {
    const name = String((row as { name?: unknown }).name ?? '')
    if (name) names.push(name)
  }
  return names
}

async function listColumns(pool: Pool, database: string, table: string): Promise<ColumnInfo[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ORDINAL_POSITION AS ordinal, COLUMN_NAME AS name, COLUMN_TYPE AS type,
            IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue,
            COLUMN_COMMENT AS comment, COLUMN_KEY AS \`key\`,
            IFNULL(EXTRA, '') AS extra
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [database, table]
  )
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    ordinal: Number(r.ordinal),
    name: String(r.name),
    type: String(r.type),
    nullable: r.nullable === 'YES',
    defaultValue: r.defaultValue === null ? null : String(r.defaultValue),
    comment: String(r.comment ?? ''),
    key: String(r.key ?? ''),
    extra: String(r.extra ?? '')
  }))
}

async function listIndexes(pool: Pool, database: string, table: string): Promise<IndexInfo[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT INDEX_NAME AS name,
            GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS \`columns\`,
            MAX(NON_UNIQUE) = 0 AS \`unique\`
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     GROUP BY INDEX_NAME
     ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME`,
    [database, table]
  )
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    name: String(r.name),
    columns: String(r.columns),
    unique: Boolean(r.unique)
  }))
}

async function showCreateTable(pool: Pool, database: string, table: string): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>(`SHOW CREATE TABLE ?? . ??`, [database, table])
  const row = rows[0] as Record<string, unknown> | undefined
  return String(row?.['Create Table'] ?? row?.['Create View'] ?? '')
}

export async function tableDetail(
  pool: Pool,
  database: string,
  table: string
): Promise<TableDetail> {
  const [columns, indexes, ddl, [statRows]] = await Promise.all([
    listColumns(pool, database, table),
    listIndexes(pool, database, table),
    showCreateTable(pool, database, table),
    pool.query<RowDataPacket[]>(
      `SELECT IFNULL(TABLE_ROWS, 0) AS \`rows\`,
              ROUND((IFNULL(DATA_LENGTH, 0) + IFNULL(INDEX_LENGTH, 0)) / 1024 / 1024, 2) AS dataSizeMb,
              IFNULL(TABLE_COLLATION, '') AS collation,
              IFNULL(ENGINE, '') AS engine,
              IFNULL(TABLE_COMMENT, '') AS comment
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, table]
    )
  ])
  const s = (statRows[0] ?? {}) as Record<string, unknown>
  return {
    columns,
    indexes,
    ddl,
    stats: {
      rows: Number(s.rows ?? 0),
      dataSizeMb: Number(s.dataSizeMb ?? 0),
      collation: String(s.collation ?? ''),
      engine: String(s.engine ?? ''),
      comment: String(s.comment ?? '')
    }
  }
}
