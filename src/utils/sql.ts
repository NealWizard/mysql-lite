/**
 * Renderer 侧 SQL 工具：语句拆分（含位置信息），用于「执行当前语句」定位。
 * 与主进程 electron/services/query 中的拆分逻辑保持一致（主进程执行为权威）。
 */

export interface StatementSpan {
  text: string
  start: number
  end: number
}

/**
 * 按分号拆分 SQL，返回每条语句及其在原文中的范围。
 * 跳过单/双引号、反引号、行注释（-- 与 #）与块注释内的分号。
 */
export function splitStatementsWithRange(sql: string): StatementSpan[] {
  const spans: StatementSpan[] = []
  let segStart = 0
  let i = 0
  const n = sql.length

  const pushSpan = (a: number, b: number): void => {
    const raw = sql.slice(a, b)
    const text = raw.trim()
    if (!text) return
    const start = a + raw.indexOf(text)
    spans.push({ text, start, end: start + text.length })
  }

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]

    if ((ch === '-' && next === '-' && /\s/.test(sql[i + 2] ?? ' ')) || ch === '#') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < n) {
        if (sql[i] === '\\' && quote !== '`' && i + 1 < n) {
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
      pushSpan(segStart, i)
      segStart = i + 1
      i++
      continue
    }
    i++
  }
  pushSpan(segStart, n)
  return spans
}

/** 光标所在语句；找不到时回退第一条 */
export function statementAtOffset(sql: string, offset: number): string {
  const spans = splitStatementsWithRange(sql)
  if (spans.length === 0) return ''
  const hit = spans.find((s) => offset >= s.start && offset <= s.end)
  return (hit ?? spans[0]).text
}
