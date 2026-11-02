/**
 * 补全上下文：只看光标前的文本和整条语句里写到的表。
 * 没有库名前缀时用当前库；用户写了其他库名时用那个库。
 */

export interface TableUse {
  db: string
  table: string
  alias: string
}

export type SuggestTarget =
  | { type: 'none' }
  | { type: 'use' }
  | { type: 'mixed' }
  | { type: 'tables'; db: string; dotted: boolean; withDatabases?: boolean }
  | { type: 'columns'; tables: Array<{ db: string; table: string }>; dotted: boolean }

export const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'ON',
  'GROUP', 'ORDER', 'BY', 'HAVING', 'LIMIT', 'OFFSET',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'AS',
  'UNION', 'ALL', 'DISTINCT',
  'USE', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'EXISTS',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END'
]

const ALIAS_STOP = new Set([
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'WHERE', 'ON', 'GROUP', 'ORDER',
  'HAVING', 'LIMIT', 'UNION', 'SET', 'SELECT', 'FROM', 'USING', 'STRAIGHT_JOIN', 'NATURAL',
  'FULL', 'IGNORE', 'FORCE', 'PARTITION', 'WINDOW', 'QUALIFY', 'AND', 'OR'
])

const CLAUSE_RE =
  /\b(SELECT|FROM|JOIN|UPDATE|INTO|TABLE|WHERE|GROUP|ORDER|HAVING|ON|SET|USE|AND|OR|BY)\b/gi

const IDENT = '`(?:``|[^`])+`|[A-Za-z0-9_$\\u0080-\\uFFFF]+'
const QUAL_RE = new RegExp(
  `(${IDENT})\\s*\\.\\s*(${IDENT})\\s*\\.\\s*$|(${IDENT})\\s*\\.\\s*$`,
  'u'
)

export function canonical(name: string, list: string[]): string | null {
  const lower = name.toLowerCase()
  for (const item of list) {
    if (item.toLowerCase() === lower) return item
  }
  return null
}

/** 光标在字符串或注释里时不补全 */
export function insideLiteral(sql: string): boolean {
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    if ((ch === '-' && next === '-' && /\s/.test(sql[i + 2] ?? ' ')) || ch === '#') {
      i += ch === '#' ? 1 : 2
      while (i < n && sql[i] !== '\n') i++
      if (i >= n) return true
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      if (i >= n) return true
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      let closed = false
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) {
          i += 2
          continue
        }
        if (sql[i] === quote) {
          closed = true
          i++
          break
        }
        i++
      }
      if (!closed) return true
      continue
    }
    i++
  }
  return false
}

export function suggestTarget(
  statement: string,
  beforeWord: string,
  currentDb: string,
  databases: string[]
): SuggestTarget {
  if (insideLiteral(beforeWord)) return { type: 'none' }
  const qual = qualifierAtEnd(beforeWord)
  if (!qual) return { type: 'none' }
  const refs = tableRefs(statement, currentDb, databases)
  if (qual.parts.length === 2) {
    const db = canonical(qual.parts[0], databases)
    if (!db) return { type: 'none' }
    return { type: 'columns', tables: [{ db, table: qual.parts[1] }], dotted: true }
  }
  if (qual.parts.length === 1) {
    const name = qual.parts[0]
    const alias = refs.find((r) => r.alias.toLowerCase() === name.toLowerCase())
    if (alias) return { type: 'columns', tables: [{ db: alias.db, table: alias.table }], dotted: true }
    const db = canonical(name, databases)
    if (db) return { type: 'tables', db, dotted: true }
    if (!currentDb) return { type: 'none' }
    return { type: 'columns', tables: [{ db: currentDb, table: name }], dotted: true }
  }
  const clause = lastClause(beforeWord.slice(0, qual.start))
  if (clause === 'USE') return { type: 'use' }
  if (clause === 'FROM' || clause === 'JOIN') {
    return currentDb ? { type: 'tables', db: currentDb, dotted: false, withDatabases: true } : { type: 'none' }
  }
  if (clause === 'UPDATE' || clause === 'INTO' || clause === 'TABLE' || clause === 'DESC') {
    return currentDb ? { type: 'tables', db: currentDb, dotted: false } : { type: 'none' }
  }
  if (
    clause === 'SELECT' || clause === 'WHERE' || clause === 'ON' || clause === 'SET' ||
    clause === 'AND' || clause === 'OR' || clause === 'GROUP' || clause === 'ORDER' ||
    clause === 'HAVING' || clause === 'BY'
  ) {
    if (refs.length === 0) return currentDb ? { type: 'tables', db: currentDb, dotted: false } : { type: 'none' }
    return { type: 'columns', tables: uniqueTables(refs), dotted: false }
  }
  return { type: 'mixed' }
}

/** 按前缀取有限条，调用方用 more 决定要不要再问一次 */
export function matchPrefix(names: string[], prefix: string, limit: number): { items: string[]; more: boolean } {
  const p = prefix.toLowerCase()
  const items: string[] = []
  let more = false
  for (const name of names) {
    if (p && !name.toLowerCase().startsWith(p)) continue
    if (items.length >= limit) {
      more = true
      break
    }
    items.push(name)
  }
  return { items, more }
}

function qualifierAtEnd(sql: string): { parts: string[]; start: number } | null {
  const m = QUAL_RE.exec(sql)
  if (!m) return { parts: [], start: sql.length }
  const lead = sql.slice(0, m.index).trimEnd()
  if (lead.endsWith('.')) return null
  if (m[1]) return { parts: [unquote(m[1]), unquote(m[2])], start: m.index }
  return { parts: [unquote(m[3] ?? '')], start: m.index }
}

function unquote(raw: string): string {
  if (raw.startsWith('`') && raw.endsWith('`')) return raw.slice(1, -1).replace(/``/g, '`')
  return raw
}

function lastClause(sql: string): string {
  const text = readableSql(sql)
  if (/^\s*(DESC|DESCRIBE)\b/i.test(text)) return 'DESC'
  let last = ''
  for (const m of text.matchAll(CLAUSE_RE)) last = (m[1] ?? '').toUpperCase()
  return last
}

function tableRefs(statement: string, currentDb: string, databases: string[]): TableUse[] {
  const text = readableSql(statement)
  const refs: TableUse[] = []
  const starter = /\b(FROM|JOIN|UPDATE|INTO|TABLE|DESC|DESCRIBE)\b/gi
  for (const m of text.matchAll(starter)) {
    let i = m.index + m[0].length
    while (i < text.length) {
      i = skipSpace(text, i)
      const first = readIdent(text, i)
      if (!first) break
      i = skipSpace(text, first.next)
      let db = currentDb
      let table = first.name
      if (text[i] === '.') {
        const second = readIdent(text, skipSpace(text, i + 1))
        if (!second) break
        db = canonical(first.name, databases) ?? first.name
        table = second.name
        i = skipSpace(text, second.next)
      }
      let alias = table
      if (/^AS\b/i.test(text.slice(i))) {
        const named = readIdent(text, skipSpace(text, i + 2))
        if (named) {
          alias = named.name
          i = named.next
        }
      } else {
        const named = readIdent(text, i)
        if (named && !ALIAS_STOP.has(named.name.toUpperCase())) {
          alias = named.name
          i = named.next
        }
      }
      if (db && table) refs.push({ db, table, alias })
      i = skipSpace(text, i)
      if (text[i] !== ',') break
      i++
    }
  }
  return refs
}

function uniqueTables(refs: TableUse[]): Array<{ db: string; table: string }> {
  const seen = new Set<string>()
  const out: Array<{ db: string; table: string }> = []
  for (const ref of refs) {
    const key = `${ref.db.toLowerCase()}\0${ref.table.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ db: ref.db, table: ref.table })
    if (out.length >= 8) break
  }
  return out
}

function readableSql(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    if ((ch === '-' && next === '-' && /\s/.test(sql[i + 2] ?? ' ')) || ch === '#') {
      const start = i
      while (i < n && sql[i] !== '\n') i++
      out += ' '.repeat(i - start)
      continue
    }
    if (ch === '/' && next === '*') {
      const start = i
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i = Math.min(n, i + 2)
      out += ' '.repeat(i - start)
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      const start = i
      i++
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) {
          i += 2
          continue
        }
        if (sql[i] === quote) {
          i++
          break
        }
        i++
      }
      out += ' '.repeat(i - start)
      continue
    }
    out += ch
    i++
  }
  return out
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

function readIdent(text: string, i: number): { name: string; next: number } | null {
  if (text[i] === '`') {
    let j = i + 1
    let name = ''
    while (j < text.length) {
      if (text[j] === '`' && text[j + 1] === '`') {
        name += '`'
        j += 2
        continue
      }
      if (text[j] === '`') return name ? { name, next: j + 1 } : null
      name += text[j]
      j++
    }
    return null
  }
  const m = /^[A-Za-z0-9_$\u0080-\uFFFF]+/u.exec(text.slice(i))
  if (!m) return null
  return { name: m[0], next: i + m[0].length }
}
