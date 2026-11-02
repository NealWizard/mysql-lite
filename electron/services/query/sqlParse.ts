import type { AnalyzeResult, StatementRisk } from '../../../src/types'

/**
 * SQL 文本解析（纯函数，无 Electron/驱动依赖，可独立单测）。
 * - 语句拆分：按分号切分，正确跳过引号与注释内的分号
 * - 语句分类：取首关键字，用于只读白名单与危险语句识别
 *
 * 已知限制：不支持存储过程的 DELIMITER 指令（P2 范围外）。
 */

/** 只读模式下允许执行的语句首词 */
export const READONLY_WHITELIST = new Set(['SELECT', 'SHOW', 'EXPLAIN', 'DESC', 'DESCRIBE', 'USE'])
/** 高危语句首词（需二次确认） */
const RISKY_KEYWORDS = new Set(['DROP', 'TRUNCATE', 'ALTER', 'GRANT', 'REVOKE', 'RENAME'])

/**
 * 将 SQL 文本按分号拆分为独立语句。
 * 正确处理单/双引号、反引号、行注释（-- 与 #）与块注释，避免误切分字符串内的分号。
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0
  const n = sql.length

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]

    // 行注释：-- 后需跟空白（MySQL 规则），或 # 开头
    if ((ch === '-' && next === '-' && /\s/.test(sql[i + 2] ?? ' ')) || ch === '#') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    // 块注释
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    // 引号字符串/标识符
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      current += ch
      i++
      while (i < n) {
        current += sql[i]
        if (sql[i] === '\\' && quote !== '`' && i + 1 < n) {
          current += sql[i + 1]
          i += 2
          continue
        }
        if (sql[i] === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === ';') {
      const stmt = current.trim()
      if (stmt) statements.push(stmt)
      current = ''
      i++
      continue
    }
    current += ch
    i++
  }
  const tail = current.trim()
  if (tail) statements.push(tail)
  return statements
}

/** 取语句首个关键字（大写） */
export function firstKeyword(statement: string): string {
  const m = /^[\s(]*([a-zA-Z]+)/.exec(statement)
  return (m?.[1] ?? '').toUpperCase()
}

/**
 * 单条 SELECT/WITH 且最外层没有 LIMIT、INTO、FOR UPDATE 时，
 * 补上 LIMIT/OFFSET，避免 SELECT * 把整表拉回客户端。
 */
export function withPreviewLimit(
  statement: string,
  maxRows: number,
  offset: number
): { sql: string; limited: boolean } {
  const kw = firstKeyword(statement)
  if (kw !== 'SELECT' && kw !== 'WITH') return { sql: statement, limited: false }
  const blocked = topLevelWords(statement)
  if (blocked.has('LIMIT') || blocked.has('INTO') || blocked.has('FOR')) {
    return { sql: statement, limited: false }
  }
  const body = statement.replace(/;+\s*$/, '')
  return { sql: `${body} LIMIT ${maxRows + 1} OFFSET ${offset}`, limited: true }
}

/**
 * 生成统计总数的语句。仅用于客户端补过 LIMIT 的 SELECT。
 * 简单查询改成 SELECT COUNT(*) FROM ...；含 JOIN / GROUP BY 等时再套子查询。
 * 外层 ORDER BY 会去掉，避免 MySQL 5.7 在派生表里拒绝排序。
 */
export function toCountSql(statement: string): string | null {
  if (!withPreviewLimit(statement, 1, 0).limited) return null
  const body = stripOuterOrderBy(statement.replace(/;+\s*$/, '').trim())
  const words = topLevelWords(body)
  const complex = ['UNION', 'JOIN', 'GROUP', 'DISTINCT', 'HAVING', 'WINDOW', 'WITH', 'INTO', 'FOR'].some((w) =>
    words.has(w)
  )
  if (!complex) {
    const fromAt = indexOfTopLevelWord(body, 'FROM')
    if (fromAt >= 0) return `SELECT COUNT(*) AS cnt ${body.slice(fromAt)}`
  }
  return `SELECT COUNT(*) AS cnt FROM (${body}) _cnt`
}

/** 去掉最外层 ORDER BY 及其后的内容 */
function stripOuterOrderBy(statement: string): string {
  const at = indexOfTopLevelWord(statement, 'ORDER')
  if (at < 0) return statement
  const rest = statement.slice(at + 'ORDER'.length)
  if (!/^\s+BY\b/i.test(rest)) return statement
  return statement.slice(0, at).trim()
}

/** 最外层关键字（跳过引号、注释和括号内的子查询） */
function topLevelWords(statement: string): Set<string> {
  return new Set(scanTopLevelWords(statement).map((w) => w.word))
}

function indexOfTopLevelWord(statement: string, word: string): number {
  return scanTopLevelWords(statement).find((w) => w.word === word)?.index ?? -1
}

function scanTopLevelWords(statement: string): Array<{ word: string; index: number }> {
  const found: Array<{ word: string; index: number }> = []
  let i = 0
  let depth = 0
  const n = statement.length
  while (i < n) {
    const ch = statement[i]
    const next = statement[i + 1]
    if ((ch === '-' && next === '-' && /\s/.test(statement[i + 2] ?? ' ')) || ch === '#') {
      while (i < n && statement[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(statement[i] === '*' && statement[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < n) {
        if (statement[i] === '\\' && quote !== '`' && i + 1 < n) {
          i += 2
          continue
        }
        if (statement[i] === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      i++
      continue
    }
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      const start = i
      while (i < n && /[A-Za-z0-9_]/.test(statement[i])) i++
      found.push({ word: statement.slice(start, i).toUpperCase(), index: start })
      continue
    }
    i++
  }
  return found
}

/** 识别危险语句：高危 DDL/DCL，或无 WHERE 的 DELETE/UPDATE */
function detectRisks(statements: string[]): StatementRisk[] {
  const risks: StatementRisk[] = []
  statements.forEach((stmt, index) => {
    const kw = firstKeyword(stmt)
    if (RISKY_KEYWORDS.has(kw)) {
      risks.push({ index, reason: `${kw} 属于高危操作，可能造成结构或权限变更`, statement: stmt })
    } else if ((kw === 'DELETE' || kw === 'UPDATE') && !/\bwhere\b/i.test(stmt)) {
      risks.push({ index, reason: `${kw} 未携带 WHERE 条件，将影响全表数据`, statement: stmt })
    }
  })
  return risks
}

export function analyzeSql(sql: string): AnalyzeResult {
  const statements = splitStatements(sql)
  return { statements, risks: detectRisks(statements) }
}
