import type { ColumnInfo, IndexInfo } from '../../types'

/** 字段草稿。originalName 为空表示新增行 */
export interface FieldDraft {
  key: string
  originalName: string | null
  name: string
  /** 普通类型的基名；enum/set 时为整段 COLUMN_TYPE */
  type: string
  length: string
  decimals: string
  nullable: boolean
  defaultValue: string | null
  comment: string
  primary: boolean
  extra: string
  unsigned: boolean
  zerofill: boolean
  enumMode: boolean
  /** 原始 COLUMN_TYPE。类型各部分没变时原样写回 */
  fullType: string
}

/** 二级索引草稿。PRIMARY 不进这份列表 */
export interface IndexDraft {
  key: string
  originalName: string | null
  name: string
  columns: string[]
  unique: boolean
}

const INT_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint'])
const TIME_TYPES = new Set(['datetime', 'timestamp'])
const NUMERIC_TYPES = new Set([
  ...INT_TYPES,
  'decimal',
  'numeric',
  'float',
  'double',
  'real',
  'bit'
])

const TYPE_RE = /^([a-zA-Z]+)(?:\((.*)\))?( unsigned)?( zerofill)?$/i

export function parseColumnType(full: string): Pick<
  FieldDraft,
  'type' | 'length' | 'decimals' | 'unsigned' | 'zerofill' | 'enumMode'
> {
  const trimmed = full.trim()
  const matched = TYPE_RE.exec(trimmed)
  if (!matched) {
    return { type: trimmed, length: '', decimals: '', unsigned: false, zerofill: false, enumMode: true }
  }
  const base = matched[1]
  const inner = matched[2] ?? ''
  const unsigned = Boolean(matched[3])
  const zerofill = Boolean(matched[4])
  if (/^(enum|set)$/i.test(base) || (inner !== '' && !/^\d+(,\d+)?$/.test(inner))) {
    return { type: trimmed, length: '', decimals: '', unsigned, zerofill, enumMode: true }
  }
  const [length, decimals] = inner.split(',')
  return {
    type: base.toLowerCase(),
    length: length ?? '',
    decimals: decimals ?? '',
    unsigned,
    zerofill,
    enumMode: false
  }
}

export function fieldFromColumn(col: ColumnInfo, key: string): FieldDraft {
  const parsed = parseColumnType(col.type)
  return {
    key,
    originalName: col.name,
    name: col.name,
    ...parsed,
    nullable: col.nullable,
    defaultValue: col.defaultValue,
    comment: col.comment,
    primary: col.key === 'PRI',
    extra: col.extra ?? '',
    fullType: col.type
  }
}

export function indexFromInfo(idx: IndexInfo, key: string): IndexDraft | null {
  if (idx.name === 'PRIMARY') return null
  return {
    key,
    originalName: idx.name,
    name: idx.name,
    columns: idx.columns.split(',').map((part) => part.trim()).filter((part) => part.length > 0),
    unique: idx.unique
  }
}

export function isViewDdl(ddl: string): boolean {
  return /^\s*CREATE\b(?:(?!\bTABLE\b)[\s\S]){0,300}?\bVIEW\b/i.test(ddl)
}

export function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

function quoteString(value: string): string {
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
}

/** 类型各部分没改时用原始 COLUMN_TYPE，避免把 unsigned 等写丢 */
export function typeSql(field: FieldDraft, base?: FieldDraft): string {
  if (field.enumMode) return field.type.trim()
  const same =
    !!base &&
    !base.enumMode &&
    field.type.toLowerCase() === base.type.toLowerCase() &&
    field.length === base.length &&
    field.decimals === base.decimals
  if (same) return base.fullType
  let sql = field.type.trim()
  if (field.length) sql += field.decimals ? `(${field.length},${field.decimals})` : `(${field.length})`
  const numeric = NUMERIC_TYPES.has(field.type.trim().toLowerCase())
  if (field.unsigned && numeric) sql += ' unsigned'
  if (field.zerofill && numeric) sql += ' zerofill'
  return sql
}

function defaultSql(value: string | null, nullable: boolean): string {
  if (value === null) return nullable ? 'DEFAULT NULL' : ''
  const text = value.trim()
  if (/^null$/i.test(text)) return 'DEFAULT NULL'
  if (/^-?\d+(\.\d+)?$/.test(text)) return `DEFAULT ${text}`
  if (/^(current_timestamp|current_date|current_time)(\(\d*\))?$/i.test(text)) return `DEFAULT ${text}`
  return `DEFAULT ${quoteString(value)}`
}

function typeChanged(field: FieldDraft, base?: FieldDraft): boolean {
  if (!base) return true
  return typeSql(field, base) !== base.fullType
}

function keptExtra(field: FieldDraft, base?: FieldDraft): string {
  const extra = (base?.extra ?? '').toLowerCase()
  if (!extra) return ''
  const changed = typeChanged(field, base)
  const baseName = field.enumMode ? '' : field.type.trim().toLowerCase()
  const bits: string[] = []
  if (extra.includes('auto_increment') && (!changed || INT_TYPES.has(baseName))) bits.push('AUTO_INCREMENT')
  if (extra.includes('on update') && (!changed || TIME_TYPES.has(baseName))) bits.push('ON UPDATE CURRENT_TIMESTAMP')
  return bits.join(' ')
}

function columnDefinition(field: FieldDraft, base?: FieldDraft): string {
  const parts = [typeSql(field, base), field.nullable ? 'NULL' : 'NOT NULL']
  const def = defaultSql(field.defaultValue, field.nullable)
  if (def) parts.push(def)
  const extra = keptExtra(field, base)
  if (extra) parts.push(extra)
  parts.push(`COMMENT ${quoteString(field.comment)}`)
  return parts.join(' ')
}

function identOf(field: FieldDraft): string {
  return field.originalName ?? `+${field.key}`
}

function positionSql(fields: FieldDraft[], index: number, original: FieldDraft[]): string {
  const id = identOf(fields[index])
  const origIds = original.map(identOf)
  const origIndex = origIds.indexOf(id)
  if (index === 0) return origIndex === 0 ? '' : ' FIRST'
  const prevNow = identOf(fields[index - 1])
  const prevOrig = origIndex > 0 ? origIds[origIndex - 1] : null
  if (origIndex >= 0 && prevOrig === prevNow) return ''
  return ` AFTER ${quoteIdent(fields[index - 1].name.trim())}`
}

function columnChanged(field: FieldDraft, base: FieldDraft | undefined, position: string): boolean {
  if (!base || position) return true
  return (
    field.name.trim() !== base.name ||
    field.nullable !== base.nullable ||
    (field.defaultValue ?? null) !== (base.defaultValue ?? null) ||
    field.comment !== base.comment ||
    typeSql(field, base) !== base.fullType
  )
}

/**
 * 对比草稿和加载时的结构，拼成一条 ALTER。
 * 没有变化时 sql 为空字符串。校验失败时只返回 error。
 */
export function buildAlterSql(
  database: string,
  table: string,
  fields: FieldDraft[],
  indexes: IndexDraft[],
  baseFields: FieldDraft[],
  baseIndexes: IndexDraft[]
): { sql: string; error?: string } {
  const names = fields.map((field) => field.name.trim())
  if (names.some((name) => !name)) return { sql: '', error: '字段名不能为空' }
  const lower = names.map((name) => name.toLowerCase())
  if (new Set(lower).size !== lower.length) return { sql: '', error: '字段名重复' }
  for (const field of fields) {
    if (field.enumMode) {
      if (!field.type.trim()) return { sql: '', error: `字段 ${field.name} 的类型不能为空` }
      continue
    }
    if (!field.type.trim()) return { sql: '', error: `字段 ${field.name} 的类型不能为空` }
    if (field.length && !/^\d+$/.test(field.length)) return { sql: '', error: `字段 ${field.name} 的长度无效` }
    if (field.decimals && !/^\d+$/.test(field.decimals)) return { sql: '', error: `字段 ${field.name} 的小数位无效` }
  }

  const fieldNames = new Set(lower)
  const indexNames = indexes.map((idx) => idx.name.trim())
  if (indexNames.some((name) => !name)) return { sql: '', error: '索引名不能为空' }
  if (indexNames.some((name) => name.toUpperCase() === 'PRIMARY')) return { sql: '', error: '主键请在字段页勾选，不要建成 PRIMARY 索引' }
  const indexLower = indexNames.map((name) => name.toLowerCase())
  if (new Set(indexLower).size !== indexLower.length) return { sql: '', error: '索引名重复' }
  for (const idx of indexes) {
    if (idx.columns.length === 0) return { sql: '', error: `索引 ${idx.name} 至少选择一个字段` }
    const missing = idx.columns.find((col) => !fieldNames.has(col.toLowerCase()))
    if (missing) return { sql: '', error: `索引 ${idx.name} 引用了不存在的字段 ${missing}` }
  }

  const baseByName = new Map(baseFields.map((field) => [field.originalName ?? field.name, field]))
  const clauses: string[] = []

  const pkNow = fields.filter((field) => field.primary).map((field) => field.name.trim())
  const pkWas = baseFields.filter((field) => field.primary).map((field) => field.name)
  const pkChanged = pkNow.join('\0') !== pkWas.join('\0')
  if (pkChanged && pkWas.length) clauses.push('DROP PRIMARY KEY')

  const keptIndexIds = new Set(indexes.map((idx) => idx.originalName).filter((name): name is string => !!name))
  const baseByIndex = new Map(baseIndexes.map((idx) => [idx.originalName ?? idx.name, idx]))
  for (const idx of baseIndexes) {
    const id = idx.originalName ?? idx.name
    if (!keptIndexIds.has(id)) {
      clauses.push(`DROP INDEX ${quoteIdent(id)}`)
      continue
    }
    const draft = indexes.find((item) => item.originalName === id)
    if (!draft) continue
    const sameCols = draft.columns.join('\0') === idx.columns.join('\0')
    const sameUnique = draft.unique === idx.unique
    if (!sameCols || !sameUnique) clauses.push(`DROP INDEX ${quoteIdent(id)}`)
  }

  const removedFields = baseFields.filter((field) => !fields.some((item) => item.originalName === field.originalName))
  for (const field of removedFields) clauses.push(`DROP COLUMN ${quoteIdent(field.name)}`)

  fields.forEach((field, index) => {
    const base = field.originalName ? baseByName.get(field.originalName) : undefined
    const position = positionSql(fields, index, baseFields)
    if (!columnChanged(field, base, position)) return
    const def = `${columnDefinition(field, base)}${position}`
    const name = quoteIdent(field.name.trim())
    if (!base) clauses.push(`ADD COLUMN ${name} ${def}`)
    else if (field.name.trim() !== base.name) clauses.push(`CHANGE COLUMN ${quoteIdent(base.name)} ${name} ${def}`)
    else clauses.push(`MODIFY COLUMN ${name} ${def}`)
  })

  if (pkChanged && pkNow.length) {
    clauses.push(`ADD PRIMARY KEY (${pkNow.map(quoteIdent).join(', ')})`)
  }

  for (const idx of indexes) {
    const base = idx.originalName ? baseByIndex.get(idx.originalName) : undefined
    const cols = `(${idx.columns.map(quoteIdent).join(', ')})`
    const kind = idx.unique ? 'UNIQUE INDEX' : 'INDEX'
    if (!base) {
      clauses.push(`ADD ${kind} ${quoteIdent(idx.name.trim())} ${cols}`)
      continue
    }
    const sameCols = idx.columns.join('\0') === base.columns.join('\0')
    const sameUnique = idx.unique === base.unique
    const sameName = idx.name.trim() === base.name
    if (sameCols && sameUnique && sameName) continue
    if (sameCols && sameUnique) {
      clauses.push(`RENAME INDEX ${quoteIdent(base.name)} TO ${quoteIdent(idx.name.trim())}`)
      continue
    }
    clauses.push(`ADD ${kind} ${quoteIdent(idx.name.trim())} ${cols}`)
  }

  if (clauses.length === 0) return { sql: '' }
  return { sql: `ALTER TABLE ${quoteIdent(database)}.${quoteIdent(table)}\n  ${clauses.join(',\n  ')}` }
}
