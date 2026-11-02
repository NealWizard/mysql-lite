/**
 * Monaco 补全：关键字是固定小表。
 * 表名按库缓存最多 3 个库，列名最多 16 张表，超过 60 秒再查。
 */
import * as monaco from 'monaco-editor/editor/editor.api'
import { useConnectionStore } from '../stores/connection'
import { SQL_KEYWORDS, matchPrefix, suggestTarget } from '../utils/sqlComplete'
import { splitStatementsWithRange } from '../utils/sql'
import { api } from './api'

const FRESH_MS = 60_000
const TABLE_DB_CAP = 3
const COLUMN_CAP = 16
const LIST_CAP = 50

interface Slot {
  at: number
  names: string[]
}

let boundConn = ''
const tableCache = new Map<string, Slot>()
const columnCache = new Map<string, Slot>()
const pending = new Map<string, Promise<string[]>>()
const keywordSet = new Set(SQL_KEYWORDS.map((w) => w.toUpperCase()))
/** 关键字按这份顺序出现，不按字母。WHERE 在 WHEN 前面 */
const keywordRank = new Map(SQL_KEYWORDS.map((name, i) => [name, String(i).padStart(3, '0')]))

export function registerSqlSuggest(): monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider('mysql', {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      return complete(model, position)
    }
  })
}

async function complete(
  model: monaco.editor.ITextModel,
  position: monaco.Position
): Promise<monaco.languages.CompletionList> {
  const word = model.getWordUntilPosition(position)
  const range: monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn
  }
  const wordOffset = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn })
  const full = model.getValue()
  const statement = statementAround(full, wordOffset)
  const local = statement ? full.slice(statement.start, wordOffset) : ''
  const conn = useConnectionStore()
  const databases = conn.connected ? conn.databases : []
  const shownDatabases = conn.connected ? conn.shownDatabases : []
  const currentDb = conn.connected ? conn.currentDb : ''
  const target = suggestTarget(statement?.text ?? '', local, currentDb, databases)
  const prefix = word.word
  const items: monaco.languages.CompletionItem[] = []
  let incomplete = false

  const add = (
    names: string[],
    kind: monaco.languages.CompletionItemKind,
    sort: string,
    limit = LIST_CAP,
    detail?: string
  ) => {
    const room = Math.min(limit, LIST_CAP - items.length)
    if (room <= 0) {
      incomplete = true
      return
    }
    const matched = matchPrefix(names, prefix, room)
    if (matched.more) incomplete = true
    const asKeyword = kind === monaco.languages.CompletionItemKind.Keyword
    for (const name of matched.items) {
      items.push({
        label: name,
        kind,
        insertText: asKeyword ? name : quoteIdent(name),
        filterText: name,
        sortText: asKeyword ? `0${keywordRank.get(name) ?? '999'}` : `${sort}${name}`,
        detail,
        range
      })
    }
  }

  if (target.type === 'none') return { suggestions: [], incomplete: false }
  if (target.type === 'use') {
    if (currentDb) add([currentDb], monaco.languages.CompletionItemKind.Module, '0')
    return { suggestions: items, incomplete }
  }
  // 点号后面只要库、表、列。其余位置始终带上关键字，避免 WHERE / FROM 被表名挤掉。
  const withKeywords = target.type === 'mixed' || !target.dotted
  const keywordLimit = prefix || target.type === 'mixed' ? LIST_CAP : 16

  if (!conn.connected || !conn.activeId) {
    if (withKeywords) add(SQL_KEYWORDS, monaco.languages.CompletionItemKind.Keyword, '0', keywordLimit)
    return { suggestions: items, incomplete }
  }

  bind(conn.activeId)
  if (withKeywords) add(SQL_KEYWORDS, monaco.languages.CompletionItemKind.Keyword, '0', keywordLimit)
  if (target.type === 'mixed') {
    if (currentDb) add(await loadTables(conn.activeId, currentDb), monaco.languages.CompletionItemKind.Struct, '1')
  } else if (target.type === 'tables') {
    const dbHits = target.withDatabases ? matchPrefix(shownDatabases, prefix, 20).items : []
    const tableLimit = Math.max(0, LIST_CAP - items.length - dbHits.length)
    if (target.db) {
      add(await loadTables(conn.activeId, target.db), monaco.languages.CompletionItemKind.Struct, '1', tableLimit)
    }
    if (dbHits.length) add(dbHits, monaco.languages.CompletionItemKind.Folder, '2', dbHits.length, '库')
  } else {
    const lists = await Promise.all(target.tables.map((t) => loadColumns(conn.activeId, t.db, t.table)))
    const names: string[] = []
    const seen = new Set<string>()
    for (const list of lists) {
      for (const name of list) {
        const key = name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        names.push(name)
      }
    }
    add(names, monaco.languages.CompletionItemKind.Field, '2')
  }
  return { suggestions: items, incomplete }
}

/** 光标落在语句末尾的空白上时，仍算这一条 */
function statementAround(sql: string, offset: number): { text: string; start: number } | null {
  const spans = splitStatementsWithRange(sql)
  for (let i = 0; i < spans.length; i++) {
    const next = spans[i + 1]?.start ?? sql.length + 1
    if (offset >= spans[i].start && offset < next) return spans[i]
  }
  return null
}

function quoteIdent(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && !keywordSet.has(name.toUpperCase())) return name
  return '`' + name.replace(/`/g, '``') + '`'
}

function bind(connId: string): void {
  if (boundConn === connId) return
  boundConn = connId
  tableCache.clear()
  columnCache.clear()
  pending.clear()
}

async function loadTables(connId: string, db: string): Promise<string[]> {
  return load(`t\0${connId}\0${db}`, TABLE_DB_CAP, tableCache, () => api().meta.objectNames(connId, db))
}

async function loadColumns(connId: string, db: string, table: string): Promise<string[]> {
  const names = await loadTables(connId, db)
  const lower = table.toLowerCase()
  const actual = names.find((n) => n.toLowerCase() === lower) ?? table
  return load(`c\0${connId}\0${db}\0${actual}`, COLUMN_CAP, columnCache, () =>
    api().meta.columnNames(connId, db, actual)
  )
}

async function load(
  key: string,
  cap: number,
  cache: Map<string, Slot>,
  fetchNames: () => Promise<string[]>
): Promise<string[]> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < FRESH_MS) {
    cache.delete(key)
    cache.set(key, hit)
    return hit.names
  }
  const wait = pending.get(key)
  if (wait) return wait
  const job = fetchNames()
    .then((names) => {
      if (cache.has(key)) cache.delete(key)
      cache.set(key, { at: Date.now(), names })
      while (cache.size > cap) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
      pending.delete(key)
      return names
    })
    .catch(() => {
      pending.delete(key)
      return []
    })
  pending.set(key, job)
  return job
}
