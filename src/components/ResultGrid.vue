<script setup lang="ts">
/**
 * 查询结果网格（参照原型图）：
 * - 信息行：文字式「返回行数/已截断/执行耗时」，右侧「复制」「导出 CSV」
 * - 表头只显示字段名；有列注释时，鼠标悬停在字段名上才出现
 * - 数据区：NULL 斜体置灰；能定位主键时单击选中、双击或 Enter 编辑，否则双击复制；勾选复制行
 * - 分页：共 X 条 / 条数切换 / 页码 / 跳至 X 页
 */
import { computed, defineComponent, h, nextTick, ref, watch } from 'vue'
import { NCheckbox, NDataTable, useMessage, type DataTableColumns } from 'naive-ui'
import type { ApplyEdits, CellValue, ResultSet, RowData } from '../types'
import { api } from '../services/api'

const props = defineProps<{
  set: ResultSet
  maxRows: number
  saving?: boolean
  tools?: boolean
  connectionId?: string
}>()
const emit = defineEmits<{ save: [] }>()
const message = useMessage()

type GridRow = RowData & { __key: number }
interface Draft {
  id: number
  values: Record<string, CellValue>
  touched: boolean
  /** 加在当前页，翻页后仍留在这一页 */
  page: number
}

const page = ref(1)
const pageSize = ref(20)
const checkedKeys = ref<number[]>([])
/** 已有行的未保存修改，键是结果行号 */
const changes = ref<Record<number, Record<string, CellValue>>>({})
const deleted = ref<number[]>([])
const drafts = ref<Draft[]>([])
const editing = ref<{ key: number; column: string } | null>(null)
/** column 为 * 时表示点了行头，选中整行 */
const selected = ref<{ key: number; column: string } | null>(null)
let draftSeq = 1
let typing = ''
let typingStart = ''
let skipBlur = false

const COMMENT_CAP = 16
const commentCache = new Map<string, Map<string, string>>()
const commentPending = new Map<string, Promise<Map<string, string>>>()
const tip = ref({ text: '', x: 0, y: 0 })
let tipCell: HTMLElement | null = null

function commentKey(schema: string, table: string): string {
  return `${props.connectionId ?? ''}\0${schema}\0${table}`
}

function commentsFor(schema: string, table: string): Promise<Map<string, string>> {
  const key = commentKey(schema, table)
  const hit = commentCache.get(key)
  if (hit) {
    commentCache.delete(key)
    commentCache.set(key, hit)
    return Promise.resolve(hit)
  }
  const wait = commentPending.get(key)
  if (wait) return wait
  const connId = props.connectionId
  if (!connId) return Promise.resolve(new Map())
  const job = api()
    .meta.columnComments(connId, schema, table)
    .then((rows) => {
      const map = new Map(rows.map((r) => [r.name, r.comment]))
      if (commentCache.has(key)) commentCache.delete(key)
      commentCache.set(key, map)
      while (commentCache.size > COMMENT_CAP) {
        const oldest = commentCache.keys().next().value
        if (oldest === undefined) break
        commentCache.delete(oldest)
      }
      commentPending.delete(key)
      return map
    })
    .catch(() => {
      commentPending.delete(key)
      return new Map<string, string>()
    })
  commentPending.set(key, job)
  return job
}

/** 浏览器自带 title 会固定等一会儿。注释已在本地时用自己的提示，移到整格表头马上出现 */
function showTip(cell: HTMLElement, text: string): void {
  const host = root.value
  cell.removeAttribute('title')
  if (!host || !text) {
    tip.value = { text: '', x: 0, y: 0 }
    return
  }
  const hostBox = host.getBoundingClientRect()
  const box = cell.getBoundingClientRect()
  tip.value = { text, x: box.left - hostBox.left, y: box.bottom - hostBox.top + 2 }
}

function onHeadOver(e: MouseEvent): void {
  const target = e.target
  if (!(target instanceof Element)) return
  const cell = target.closest('.n-data-table-th')
  if (!(cell instanceof HTMLElement)) return
  const key = cell.dataset.colKey
  if (!key || key === '__check') return
  const column = props.set.columns.find((c) => c.name === key)
  if (!column?.schema || !column.table || !column.orgName) return
  if (tipCell === cell && tip.value.text) return
  tipCell = cell
  const cached = commentCache.get(commentKey(column.schema, column.table))
  if (cached) {
    showTip(cell, cached.get(column.orgName) ?? '')
    return
  }
  const stamp = `${column.schema}\0${column.table}\0${column.orgName}`
  if (cell.dataset.tip === stamp) return
  cell.dataset.tip = stamp
  void commentsFor(column.schema, column.table).then((map) => {
    if (tipCell !== cell) return
    showTip(cell, map.get(column.orgName) ?? '')
  })
}

function onHeadOut(e: MouseEvent): void {
  if (!tipCell) return
  const next = e.relatedTarget
  if (next instanceof Node && tipCell.contains(next)) return
  tipCell = null
  tip.value = { text: '', x: 0, y: 0 }
}

function blankDraft(): Draft {
  draftSeq += 1
  return { id: -draftSeq, values: {}, touched: false, page: page.value }
}

function resetDrafts(): void {
  changes.value = {}
  deleted.value = []
  editing.value = null
  selected.value = null
  checkedKeys.value = []
  drafts.value = []
}

const root = ref<HTMLElement | null>(null)

function addRow(): void {
  if (!props.set.edit) return
  const draft = blankDraft()
  draft.touched = true
  drafts.value = [...drafts.value, draft]
  selected.value = { key: draft.id, column: '*' }
  void nextTick(() => {
    const box = root.value?.querySelector('.n-scrollbar-container')
    if (box) box.scrollTop = box.scrollHeight
    root.value?.focus()
  })
}

/** 长文本只在值变化时截断一次。勾选重画时直接用截好的字 */
const shownCache = new Map<string, { raw: CellValue; full: string; shown: string }>()

watch(() => props.set, () => {
  page.value = 1
  resetDrafts()
  shownCache.clear()
}, { immediate: true })

const dirty = computed(
  () =>
    Object.keys(changes.value).length > 0 ||
    deleted.value.length > 0 ||
    drafts.value.some((d) => d.touched)
)

function draftToRow(d: Draft): GridRow {
  const values: RowData = {}
  for (const c of props.set.columns) values[c.name] = d.values[c.name] ?? null
  return { ...values, __key: d.id }
}

/** 已有行叠上未保存的修改。新增行不进分页，只挂在被添加的那一页 */
const dataRows = computed<GridRow[]>(() =>
  props.set.rows.map((row, i) => {
    const over = changes.value[i]
    return { ...(over ? { ...row, ...over } : row), __key: i }
  })
)

const viewRows = computed<GridRow[]>(() => {
  if (!props.set.edit) return dataRows.value
  return [...dataRows.value, ...drafts.value.map(draftToRow)]
})

/** 只把当前页交给表格。editing 放进依赖，单击后才会换成输入框 */
const tableData = computed<GridRow[]>(() => {
  const active = editing.value
  const start = (page.value - 1) * pageSize.value
  const extra = props.set.edit ? drafts.value.filter((d) => d.page === page.value).map(draftToRow) : []
  return [...dataRows.value.slice(start, start + pageSize.value), ...extra].map((row) =>
    active && active.key === row.__key ? { ...row } : row
  )
})

const isQueryResult = computed(() => props.set.columns.length > 0)

const COL_MIN = 48
const COL_MAX = 300

/** 量到上限就停。中文按 12 像素、英文按 7 像素估算 */
function measureText(text: string): number {
  let px = 0
  for (const ch of text) {
    px += ch.charCodeAt(0) > 255 ? 12 : 7
    if (px >= COL_MAX) return COL_MAX
  }
  return px
}

/** 表头和这一批已取回的内容取较宽者，不超过 300。手拖的宽度由表格自己留着，这里只给初始值 */
const fittedWidths = computed(() => {
  const map = new Map<string, number>()
  const rows = props.set.rows
  for (const col of props.set.columns) {
    let px = measureText(col.name) + 28
    for (const row of rows) {
      const v = row[col.name]
      const text = v == null ? 'NULL' : typeof v === 'string' ? v : String(v)
      const sample = text.length > 32 ? text.slice(0, 32) : text
      const w = measureText(sample) + 16
      if (w > px) px = w
      if (px >= COL_MAX) break
    }
    map.set(col.name, Math.max(COL_MIN, Math.min(COL_MAX, px)))
  }
  return map
})

function columnWidth(name: string): number {
  return fittedWidths.value.get(name) ?? COL_MIN
}

const columnKey = computed(() => props.set.columns.map((c) => c.name).join('\0'))
/** 拖列宽后表格总宽跟着变，否则缩列时会被原来的最小宽度撑住 */
const scrollX = ref(0)

watch(
  fittedWidths,
  (map) => {
    let sum = 48
    for (const c of props.set.columns) sum += map.get(c.name) ?? COL_MIN
    scrollX.value = sum
  },
  { immediate: true }
)

/** 一列只出现一次才可编辑。勾选会重画每个格子，不能在格子里再扫全部列 */
const writableNames = computed(() => {
  const names = new Set<string>()
  if (!props.set.edit) return names
  const counts = new Map<string, number>()
  for (const col of props.set.columns) {
    if (!col.table || !col.orgName) continue
    const id = `${col.table}\0${col.orgName}`
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  for (const col of props.set.columns) {
    if (!col.table || !col.orgName) continue
    if (counts.get(`${col.table}\0${col.orgName}`) === 1) names.add(col.name)
  }
  return names
})

function writable(name: string): boolean {
  return writableNames.value.has(name)
}

function preview(key: number, column: string, value: CellValue): { full: string; shown: string } {
  const id = `${key}\0${column}`
  const hit = shownCache.get(id)
  if (hit && hit.raw === value) return hit
  const full = String(value)
  const rec = { raw: value, full, shown: full.length > 80 ? `${full.slice(0, 80)}…` : full }
  shownCache.set(id, rec)
  // 翻页/多列时防止截断缓存无限涨
  if (shownCache.size > 4000) {
    const drop = shownCache.size - 3000
    let i = 0
    for (const key of shownCache.keys()) {
      shownCache.delete(key)
      if (++i >= drop) break
    }
  }
  return rec
}

function currentValue(key: number, column: string): CellValue {
  if (key >= 0) {
    const over = changes.value[key]?.[column]
    if (over !== undefined) return over
    return props.set.rows[key]?.[column] ?? null
  }
  const draft = drafts.value.find((d) => d.id === key)
  return draft?.values[column] === undefined ? null : draft.values[column]
}

function sameValue(original: CellValue, next: CellValue): boolean {
  if (original === null || next === null) return original === next
  return String(original) === String(next)
}

function setChange(key: number, column: string, value: CellValue): void {
  changes.value = { ...changes.value, [key]: { ...changes.value[key], [column]: value } }
}

function clearChange(key: number, column: string): void {
  const prev = { ...changes.value[key] }
  delete prev[column]
  const next = { ...changes.value }
  if (Object.keys(prev).length === 0) delete next[key]
  else next[key] = prev
  changes.value = next
}

function cellDirty(key: number, column: string): boolean {
  if (key >= 0) return changes.value[key]?.[column] !== undefined
  const draft = drafts.value.find((d) => d.id === key)
  return !!draft?.touched && draft.values[column] !== undefined
}

function beginEdit(key: number, column: string): void {
  if (!writable(column) || deleted.value.includes(key)) return
  const value = currentValue(key, column)
  typingStart = value === null ? '' : String(value)
  typing = typingStart
  editing.value = { key, column }
}

function commit(value: CellValue): void {
  const cur = editing.value
  editing.value = null
  if (!cur) return
  writeCell(cur.key, cur.column, value)
}

function writeCell(key: number, column: string, value: CellValue): void {
  if (key < 0) {
    const draft = drafts.value.find((d) => d.id === key)
    if (!draft) return
    const next = { ...draft, touched: true, values: { ...draft.values, [column]: value } }
    drafts.value = drafts.value.map((d) => (d.id === next.id ? next : d))
    return
  }
  const original = props.set.rows[key]?.[column] ?? null
  if (sameValue(original, value)) clearChange(key, column)
  else setChange(key, column, value)
}

function selectCell(key: number, column: string): void {
  selected.value = { key, column }
  root.value?.focus()
}

/** 剪贴板里用 NULL 四个字表示数据库 NULL，空字符串仍是空字符串 */
function cellText(key: number, column: string): string {
  const value = currentValue(key, column)
  return value == null ? 'NULL' : String(value)
}

function pasteValue(text: string): CellValue {
  return text === 'NULL' ? null : text
}

async function copySelection(): Promise<void> {
  const cur = selected.value
  if (!cur) return
  const text =
    cur.column === '*'
      ? props.set.columns.map((c) => cellText(cur.key, c.name)).join('\t')
      : cellText(cur.key, cur.column)
  await navigator.clipboard.writeText(text)
  message.success(cur.column === '*' ? '已复制整行' : '已复制单元格')
}

async function pasteSelection(): Promise<void> {
  const cur = selected.value
  if (!cur || !props.set.edit) {
    message.warning('当前结果不能粘贴')
    return
  }
  const text = (await navigator.clipboard.readText()).replace(/\r\n/g, '\n').replace(/\n$/, '')
  if (!text) return
  const lines = text.split('\n')
  const cols = props.set.columns
  const startCol = cur.column === '*' ? 0 : cols.findIndex((c) => c.name === cur.column)
  const keys = tableData.value.map((row) => row.__key)
  const startRow = keys.indexOf(cur.key)
  if (startCol < 0 || startRow < 0) return
  let wrote = 0
  for (let r = 0; r < lines.length; r++) {
    const key = keys[startRow + r]
    if (key === undefined || deleted.value.includes(key)) continue
    const fields = lines[r].split('\t')
    for (let c = 0; c < fields.length; c++) {
      const col = cols[startCol + c]
      if (!col || !writable(col.name)) continue
      writeCell(key, col.name, pasteValue(fields[c]))
      wrote++
    }
  }
  if (wrote === 0) message.warning('没有可粘贴的格子')
}

function onGridKey(e: KeyboardEvent): void {
  const target = e.target
  if (target instanceof HTMLElement && target.closest('input, textarea')) return
  if (!selected.value) return
  const key = e.key.toLowerCase()
  if (e.ctrlKey && key === 'c') {
    e.preventDefault()
    void copySelection()
  } else if (e.ctrlKey && key === 'v') {
    e.preventDefault()
    void pasteSelection()
  } else if (e.key === 'Enter' && selected.value.column !== '*') {
    e.preventDefault()
    beginEdit(selected.value.key, selected.value.column)
  }
}

function onEditBlur(): void {
  if (skipBlur) {
    skipBlur = false
    return
  }
  if (typing === typingStart) {
    editing.value = null
    return
  }
  commit(typing)
}

function onColumnResize(
  _resizedWidth: number,
  limitedWidth: number,
  column: { key?: string | number },
  getColumnWidth: (key: string | number) => number | undefined
): void {
  let sum = 48
  for (const c of props.set.columns) {
    sum += c.name === column.key ? limitedWidth : (getColumnWidth(c.name) ?? columnWidth(c.name))
  }
  scrollX.value = Math.round(sum)
}

function toggleRow(key: number, on: boolean): void {
  const next = new Set(checkedKeys.value)
  if (on) next.add(key)
  else next.delete(key)
  checkedKeys.value = [...next]
}

function togglePage(on: boolean): void {
  const next = new Set(checkedKeys.value)
  for (const row of tableData.value) {
    if (on) next.add(row.__key)
    else next.delete(row.__key)
  }
  checkedKeys.value = [...next]
}

/** 勾选状态放在复选框自己身上。表格的选中列会在勾选时把每一格重画一遍 */
const RowCheck = defineComponent({
  name: 'ResultRowCheck',
  props: { rowKey: { type: Number, required: true } },
  setup(props) {
    return () =>
      h(NCheckbox, {
        checked: checkedKeys.value.includes(props.rowKey),
        'onUpdate:checked': (on: boolean) => toggleRow(props.rowKey, on)
      })
  }
})

const HeadCheck = defineComponent({
  name: 'ResultHeadCheck',
  setup() {
    return () => {
      const keys = tableData.value.map((row) => row.__key)
      let n = 0
      for (const key of keys) if (checkedKeys.value.includes(key)) n += 1
      return h(NCheckbox, {
        checked: keys.length > 0 && n === keys.length,
        indeterminate: n > 0 && n < keys.length,
        disabled: keys.length === 0,
        'onUpdate:checked': (on: boolean) => togglePage(on)
      })
    }
  }
})

function rowKeyOf(row: GridRow): number {
  return row.__key
}

const tableClass = computed(() => (props.tools ? 'grid-table has-tools' : 'grid-table'))

const columns = computed<DataTableColumns<GridRow>>(() => {
  const mark = selected.value
  const cols: DataTableColumns<GridRow> = [
    {
      key: '__check',
      width: 48,
      title: () => h(HeadCheck),
      cellProps(row) {
        return {
          title: '单击选中整行',
          onClick: (e: MouseEvent) => {
            if ((e.target as HTMLElement).closest('.n-checkbox')) return
            selectCell(row.__key, '*')
          }
        }
      },
      render: (row) => h(RowCheck, { rowKey: row.__key })
    }
  ]
  for (const c of props.set.columns) {
    const width = columnWidth(c.name)
    cols.push({
      key: c.name,
      width,
      minWidth: 48,
      resizable: true,
      // 只做样式截断。带 tooltip 的省略组件会在勾选时为每个格子挂提示，长文本会卡死界面
      ellipsis: true,
      cellProps(row) {
        const canEdit = writable(c.name) && !deleted.value.includes(row.__key)
        const picked = mark?.key === row.__key && mark.column === c.name
        const td: { style?: string; title?: string; onClick?: (e: MouseEvent) => void; onDblclick?: () => void } = {}
        const style: string[] = []
        if (cellDirty(row.__key, c.name)) style.push('background:#e8f8ee')
        if (picked) style.push('box-shadow:inset 0 0 0 1px #2f6bff')
        if (style.length) td.style = style.join(';')
        td.onClick = (e) => {
          if ((e.target as HTMLElement).closest('.cell-edit')) return
          selectCell(row.__key, c.name)
        }
        if (canEdit) {
          td.title = '单击选中，双击编辑'
          td.onDblclick = () => beginEdit(row.__key, c.name)
        } else {
          td.title = '单击选中，Ctrl+C 复制'
          td.onDblclick = () => {
            const v = row[c.name]
            void navigator.clipboard.writeText(v == null ? 'NULL' : preview(row.__key, c.name, v).full).then(() => message.success('已复制单元格'))
          }
        }
        return td
      },
      title: () => h('div', { class: 'col-name' }, c.name),
      render(row) {
        const active = editing.value
        if (active && active.key === row.__key && active.column === c.name) {
          return h('span', { class: 'cell-edit' }, [
            h('input', {
              value: typing,
              spellcheck: 'false',
              autocomplete: 'off',
              onInput: (e: Event) => {
                typing = (e.target as HTMLInputElement).value
              },
              onBlur: onEditBlur,
              onKeydown: (e: KeyboardEvent) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') {
                  skipBlur = true
                  editing.value = null
                }
              },
              onVnodeMounted: (vnode) => (vnode.el as HTMLInputElement | null)?.focus()
            })
          ])
        }
        const v = row[c.name]
        if (v === null || v === undefined) {
          return h('span', { class: 'cell-text', style: 'color:#c0c4cc;font-style:italic' }, 'NULL')
        }
        return h('span', { class: 'cell-text' }, preview(row.__key, c.name, v).shown)
      }
    })
  }
  return cols
})

/** 原型图分页：共 X 条 / 20 条每页 / 页码 / 跳至 X 页。数据只含当前页 */
const pagination = computed(() => ({
  page: page.value,
  pageSize: pageSize.value,
  itemCount: props.set.rows.length,
  showSizePicker: true,
  pageSizes: [20, 50, 100],
  showQuickJumper: true,
  prefix: () => `共 ${props.set.rows.length} 条`,
  onUpdatePage: (p: number) => {
    page.value = p
  },
  onUpdatePageSize: (size: number) => {
    pageSize.value = size
    page.value = 1
    if (drafts.value.length > 0) drafts.value = drafts.value.map((d) => ({ ...d, page: 1 }))
  }
}))

/** 导出当前可见结果（含未保存修改，不含已划掉删除的行） */
function toCsvRows(): Array<Array<string | number | null>> {
  const names = props.set.columns.map((c) => c.name)
  const gone = new Set(deleted.value)
  const out: Array<Array<string | number | null>> = []
  for (const row of viewRows.value) {
    if (gone.has(row.__key)) continue
    out.push(
      names.map((n) => {
        const v = currentValue(row.__key, n)
        if (v === null) return null
        return typeof v === 'number' ? v : String(v)
      })
    )
  }
  return out
}

/** 表名-本机时间。getHours 等取的是系统时区，上海就是东八区 */
function exportFileName(): string {
  const names = [...new Set(props.set.columns.map((c) => c.table).filter((name) => name.length > 0))]
  const table = (names.length > 0 ? names.join('_') : 'result').replace(/[\\/:*?"<>|]/g, '_')
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`
  return `${table}-${stamp}.csv`
}

async function exportCsv(): Promise<void> {
  try {
    const path = await api().file.saveCsv(
      exportFileName(),
      props.set.columns.map((c) => c.name),
      toCsvRows()
    )
    if (path) message.success(`已导出：${path}`)
  } catch (e) {
    message.error(`导出失败：${String(e)}`)
  }
}

const rowClassName = computed(() => {
  const marked = new Set(deleted.value)
  const picked = selected.value
  return (row: GridRow) => {
    const names: string[] = []
    if (marked.has(row.__key)) names.push('row-deleted')
    else if (row.__key < 0) names.push('row-new')
    if (picked?.key === row.__key && picked.column === '*') names.push('row-picked')
    return names.join(' ')
  }
})

function columnOrg(name: string): string {
  return props.set.columns.find((c) => c.name === name)?.orgName ?? ''
}

function keyPairs(row: RowData): Array<{ column: string; value: CellValue }> {
  return (props.set.edit?.keyColumns ?? []).map((name) => ({
    column: columnOrg(name),
    value: row[name] ?? null
  }))
}

function collect(): ApplyEdits | null {
  const edit = props.set.edit
  if (!edit || !dirty.value) return null
  const updates: ApplyEdits['updates'] = []
  for (const [index, cols] of Object.entries(changes.value)) {
    const i = Number(index)
    if (deleted.value.includes(i)) continue
    const set = Object.entries(cols)
      .map(([name, value]) => ({ column: columnOrg(name), value }))
      .filter((pair) => pair.column.length > 0)
    if (set.length === 0) continue
    const source = props.set.rows[i]
    if (!source) continue
    updates.push({ keys: keyPairs(source), set })
  }
  const inserts = drafts.value
    .filter((d) => d.touched)
    .map((d) =>
      Object.entries(d.values)
        .map(([name, value]) => ({ column: columnOrg(name), value }))
        .filter((pair) => pair.column.length > 0)
    )
    .filter((row) => row.length > 0)
  const deletes = deleted.value
    .map((i) => props.set.rows[i])
    .filter((row): row is RowData => row !== undefined)
    .map((row) => keyPairs(row))
  if (updates.length + inserts.length + deletes.length === 0) return null
  const schemas = new Set(props.set.columns.map((c) => c.schema).filter((s) => s.length > 0))
  const database = schemas.size === 1 ? [...schemas][0] : ''
  return { database, table: edit.table, updates, inserts, deletes }
}

function deleteChecked(): void {
  if (!props.set.edit) return
  const keys = checkedKeys.value.map(Number)
  if (keys.length === 0) {
    message.warning('请先勾选要删除的行')
    return
  }
  const marked = new Set(deleted.value)
  const drop = new Set<number>()
  for (const key of keys) {
    if (key >= 0) marked.add(key)
    else if (drafts.value.some((d) => d.id === key && d.touched)) drop.add(key)
  }
  deleted.value = [...marked]
  if (drop.size > 0) drafts.value = drafts.value.filter((d) => !drop.has(d.id))
  checkedKeys.value = []
  editing.value = null
}

function revert(): void {
  resetDrafts()
}

async function copySelected(): Promise<void> {
  const names = props.set.columns.map((c) => c.name)
  const byKey = new Map(viewRows.value.map((row) => [row.__key, row]))
  const selected = checkedKeys.value.map((key) => byKey.get(Number(key))).filter((r) => r !== undefined)
  if (selected.length === 0) {
    message.warning('请先勾选要复制的行')
    return
  }
  const cell = (v: string | number | null): string => {
    if (v === null) return ''
    const s = String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [names.join(',')]
  for (const row of selected) lines.push(names.map((n) => cell(row[n] ?? null)).join(','))
  await navigator.clipboard.writeText(lines.join('\n'))
  message.success(`已复制 ${selected.length} 行`)
}

defineExpose({ exportCsv, copySelected, dirty, collect, deleteChecked, revert, addRow })
</script>

<template>
  <div
    ref="root"
    class="result-grid selectable"
    tabindex="0"
    @mouseover="onHeadOver"
    @mouseout="onHeadOut"
    @keydown="onGridKey"
  >
    <template v-if="isQueryResult">
      <NDataTable
        :key="columnKey"
        @unstable-column-resize="onColumnResize"
        :columns="columns"
        remote
        :data="tableData"
        :row-key="rowKeyOf"
        :row-class-name="rowClassName"
        size="small"
        flex-height
        :class="tableClass"
        :paginate-single-page="!!tools"
        :scroll-x="scrollX"
        :pagination="pagination"
      />
      <div v-show="tip.text" class="col-tip" :style="{ left: tip.x + 'px', top: tip.y + 'px' }">{{ tip.text }}</div>
      <div v-if="tools" class="edit-tools">
        <button type="button" title="新增行" :disabled="!set.edit || saving" @click="addRow">+</button>
        <button type="button" title="删除行" :disabled="!set.edit || saving || checkedKeys.length === 0" @click="deleteChecked">−</button>
        <button type="button" title="撤销修改" :disabled="saving || !dirty" @click="revert">×</button>
        <button type="button" title="保存" :disabled="!set.edit || saving || !dirty" @click="emit('save')">✓</button>
        <span class="edit-selected">{{ checkedKeys.length }} 行已选</span>
      </div>
    </template>
    <div v-else class="ok-packet">
      执行成功，影响行数：{{ set.affectedRows ?? 0 }}（耗时 {{ set.durationMs }} ms）
    </div>
  </div>
</template>

<style scoped>
.result-grid {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  outline: none;
}

.edit-tools {
  position: absolute;
  left: 0;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  height: 28px;
  gap: 2px;
}

.edit-tools button {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: #262626;
  cursor: pointer;
  padding: 0;
  font-size: 16px;
  line-height: 1;
}

.edit-tools button:disabled {
  color: #c0c4cc;
  cursor: default;
}

.edit-selected {
  margin-left: 6px;
  font-size: 12px;
  color: #8c8c8c;
}

.grid-table.has-tools :deep(.n-data-table__pagination) {
  padding-left: 188px;
  box-sizing: border-box;
}

.grid-table {
  flex: 1;
  min-height: 0;
  font-size: 12px;
}

.col-name {
  font-weight: 600;
  white-space: nowrap;
}

.col-tip {
  position: absolute;
  z-index: 5;
  max-width: 360px;
  padding: 4px 8px;
  background: #262626;
  color: #fff;
  font-size: 12px;
  line-height: 1.4;
  border-radius: 2px;
  pointer-events: none;
  white-space: pre-wrap;
  word-break: break-all;
}

.grid-table :deep(.n-data-table-th__title),
.col-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.grid-table :deep(.n-data-table-th),
.grid-table :deep(.n-data-table-td) {
  border-right: 1px solid #e4e7ed;
  line-height: 1.2;
  padding: 2px 4px;
}

.grid-table :deep(.n-data-table-th) {
  white-space: nowrap;
}

.grid-table :deep(.n-data-table-td) {
  overflow: hidden;
}

.grid-table :deep(.n-data-table-th:first-child),
.grid-table :deep(.n-data-table-td:first-child) {
  padding: 0;
  text-align: center;
}

.grid-table :deep(.n-checkbox-box),
.grid-table :deep(.n-checkbox-box__border),
.grid-table :deep(.n-checkbox-icon .check-icon),
.grid-table :deep(.n-checkbox-icon .line-icon) {
  transition: none;
}

/* 滚动区域让出 12px，滚动条落在内容外侧 */
.grid-table :deep(.n-data-table-base-table-body.n-scrollbar:has(> .n-scrollbar-rail--horizontal:not(.n-scrollbar-rail--disabled)) > .n-scrollbar-container) {
  height: calc(100% - 12px);
}

.grid-table :deep(.n-data-table-base-table-body.n-scrollbar:has(> .n-scrollbar-rail--vertical:not(.n-scrollbar-rail--disabled)) > .n-scrollbar-container) {
  width: calc(100% - 12px);
}

.grid-table :deep(.n-data-table-base-table:has(.n-scrollbar-rail--vertical:not(.n-scrollbar-rail--disabled)) > .n-data-table-base-table-header) {
  width: calc(100% - 12px);
}

.grid-table :deep(.n-data-table-base-table-body .n-scrollbar-rail--horizontal) {
  left: 0;
  right: 0;
  bottom: 0;
}

.grid-table :deep(.n-data-table-base-table-body .n-scrollbar-rail--vertical) {
  top: 0;
  right: 0;
  bottom: 0;
}

.grid-table :deep(.n-scrollbar:has(.n-scrollbar-rail--vertical:not(.n-scrollbar-rail--disabled)) .n-scrollbar-rail--horizontal) {
  right: 12px;
}

.grid-table :deep(.n-scrollbar:has(.n-scrollbar-rail--horizontal:not(.n-scrollbar-rail--disabled)) .n-scrollbar-rail--vertical) {
  bottom: 12px;
}

/* 行数不满一屏时，最后一行也要保留下边框 */
.grid-table :deep(.n-data-table-td.n-data-table-td--last-row) {
  border-bottom: 1px solid var(--n-merged-border-color);
}

.cell-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grid-table :deep(.n-data-table-td:has(.cell-edit)) {
  position: relative;
  padding: 0;
  box-shadow: inset 0 0 0 1px #2f6bff;
}

.grid-table :deep(.cell-edit) {
  position: absolute;
  inset: 0;
}

.grid-table :deep(.cell-edit input) {
  appearance: none;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  margin: 0;
  border: 0;
  border-radius: 0;
  outline: none;
  box-shadow: none;
  padding: 0 4px;
  background: transparent;
  font: inherit;
  color: inherit;
}

.grid-table :deep(.row-deleted .n-data-table-td) {
  text-decoration: line-through;
  color: #b0b3b8;
}

.grid-table :deep(.row-new .n-data-table-td) {
  background: #f6ffed;
}

.grid-table :deep(.row-picked .n-data-table-td),
.grid-table :deep(.n-data-table-tr.row-picked:hover .n-data-table-td) {
  background: #e8f1ff;
}

.ok-packet {
  padding: 16px;
  color: #18a058;
  background: #f6fffa;
  border: 1px solid #b7ebc6;
  border-radius: 4px;
}
</style>
