/**
 * 把 SQL 收成一行。字符串和反引号内的空白保留；
 * 行注释改成块注释，避免换行被吃掉后把后面的语句注释掉。
 */
export function compressSql(sql: string): string {
  let out = ''
  let i = 0
  let quote: "'" | '"' | '`' | null = null

  const pushSpace = (): void => {
    if (out && !out.endsWith(' ')) out += ' '
  }

  while (i < sql.length) {
    const c = sql[i]
    if (quote) {
      out += c
      if (c === '\\' && quote !== '`' && i + 1 < sql.length) {
        out += sql[i + 1]
        i += 2
        continue
      }
      if (c === quote) {
        if (quote !== '`' && sql[i + 1] === quote) {
          out += sql[i + 1]
          i += 2
          continue
        }
        quote = null
      }
      i += 1
      continue
    }

    if (c === "'" || c === '"' || c === '`') {
      quote = c
      out += c
      i += 1
      continue
    }

    if (c === '-' && sql[i + 1] === '-') {
      i += 2
      let body = ''
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') {
        body += sql[i]
        i += 1
      }
      out += `/*${body.replace(/\*\//g, '* /')}*/`
      continue
    }

    if (c === '#') {
      i += 1
      let body = ''
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') {
        body += sql[i]
        i += 1
      }
      out += `/*${body.replace(/\*\//g, '* /')}*/`
      continue
    }

    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      const block = end < 0 ? sql.slice(i) : sql.slice(i, end + 2)
      out += block.replace(/\s+/g, ' ')
      i = end < 0 ? sql.length : end + 2
      continue
    }

    if (/\s/.test(c)) {
      pushSpace()
      i += 1
      continue
    }

    out += c
    i += 1
  }

  return out.trim()
}
