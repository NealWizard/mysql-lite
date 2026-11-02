<script setup lang="ts">
/**
 * 左侧连接树（原型：连接 → 库 → 表）。
 * 展开连接即打开；展开库懒加载表；表双击 / 右键「查询表数据」生成 SELECT。
 */
import { computed, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NDropdown, NTree, useDialog, useMessage, type TreeOption } from 'naive-ui'
import { useConnectionStore } from '../stores/connection'
import { useQueryStore } from '../stores/query'
import { useUiStore } from '../stores/ui'
import { api } from '../services/api'

type Kind = 'conn' | 'db' | 'table'
type Node = TreeOption & { kind: Kind; connId?: string; db?: string; table?: string }

const conn = useConnectionStore()
const qs = useQueryStore()
const ui = useUiStore()
const message = useMessage()
const dialog = useDialog()

const nodes = ref<Node[]>([])
const expanded = ref<Array<string | number>>([])
const selected = ref<Array<string | number>>([])
const pane = ref<HTMLElement | null>(null)
/** 已键入的筛选文字。Esc 清空，退格删最后一个字 */
const seek = ref('')

const menuShow = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuNode = ref<Node | null>(null)

const dot = (on: boolean) => () => h('i', { class: on ? 'dot on' : 'dot' })

function dbIcon() {
  return h('svg', { class: 'node-ico', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7' }, [
    h('ellipse', { cx: '12', cy: '6', rx: '7', ry: '3' }),
    h('path', { d: 'M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6' }),
    h('path', { d: 'M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6' })
  ])
}

function tableIcon() {
  return h('svg', { class: 'node-ico', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7' }, [
    h('rect', { x: '4', y: '4', width: '16', height: '16', rx: '2' }),
    h('path', { d: 'M4 9h16M4 14h16M9 4v16' })
  ])
}

function rebuild(): void {
  const prev = new Map<string, TreeOption[] | undefined>()
  for (const c of nodes.value) {
    for (const d of c.children ?? []) prev.set(String(d.key), d.children)
  }
  nodes.value = conn.profiles.map((p) => {
    const opened = conn.connected && conn.activeId === p.id
    const node: Node = {
      key: `c:${p.id}`,
      label: `${p.name} (${p.username})`,
      kind: 'conn',
      connId: p.id,
      isLeaf: false,
      prefix: dot(opened)
    }
    node.children = opened
      ? conn.shownDatabases.map((db) => ({
          key: `d:${p.id}:${db}`,
          label: db,
          kind: 'db' as const,
          connId: p.id,
          db,
          isLeaf: false,
          prefix: dbIcon,
          children: prev.get(`d:${p.id}:${db}`)
        }))
      : []
    return node
  })
}

/** 展开连接节点时才真正打开连接，展开后 rebuild 会填入库列表 */
async function onExpanded(keys: Array<string | number>): Promise<void> {
  expanded.value = keys
  for (const key of keys) {
    if (!String(key).startsWith('c:')) continue
    const id = String(key).slice(2)
    if (conn.connected && conn.activeId === id) continue
    const result = await conn.open(id)
    if (!result.ok) message.error(result.error ?? '连接失败')
    else message.success('连接成功')
    expanded.value = [...new Set([...expanded.value, String(key)])]
  }
}

watch(
  () =>
    `${conn.profiles.map((p) => p.id + p.name + (p.visibleDatabases?.join(',') ?? '*')).join()}|${conn.connected}|${conn.activeId}|${conn.shownDatabases.join()}`,
  () => rebuild(),
  { immediate: true }
)

watch(
  () => conn.connected && conn.activeId,
  (id) => {
    if (id && !expanded.value.includes(`c:${conn.activeId}`)) {
      expanded.value = [...expanded.value, `c:${conn.activeId}`]
    }
  }
)

async function onLoad(option: TreeOption): Promise<void> {
  const node = findNode(option.key) ?? (option as Node)
  if (node.kind === 'db' && node.db) {
    const tables = await api().meta.tables(conn.activeId, node.db)
    node.children = tables.map((t) => ({
      key: `t:${node.db}:${t.name}`,
      label: t.name,
      kind: 'table' as const,
      db: node.db,
      table: t.name,
      isLeaf: true,
      prefix: tableIcon
    }))
  }
}

function findNode(key: TreeOption['key']): Node | undefined {
  const walk = (list: TreeOption[] | undefined): Node | undefined => {
    if (!list) return
    for (const raw of list) {
      const node = raw as Node
      if (node.key === key) return node
      const hit = walk(node.children)
      if (hit) return hit
    }
  }
  return walk(nodes.value)
}

function queryTable(db: string, table: string): void {
  conn.currentDb = db
  ui.module = 'query'
  ui.rail = 'connect'
  const sql = `SELECT * FROM \`${db}\`.\`${table}\` LIMIT 200;`
  qs.newTab(sql, true, `${table}.sql`)
}

function openMenu(node: Node, e: MouseEvent): void {
  menuNode.value = node
  menuShow.value = false
  menuX.value = e.clientX
  menuY.value = e.clientY
  menuShow.value = true
}

/** 名称包含筛选字，或子孙里有命中。null 表示不过滤 */
const visibleKeys = computed(() => {
  const q = seek.value.trim().toLowerCase()
  if (!q) return null
  const keys = new Set<string>()
  const walk = (list: Node[] | undefined): boolean => {
    let any = false
    for (const node of list ?? []) {
      const childHit = walk(node.children as Node[] | undefined)
      const self = String(node.label ?? '').toLowerCase().includes(q)
      if ((self || childHit) && node.key != null) {
        keys.add(String(node.key))
        any = true
      }
    }
    return any
  }
  walk(nodes.value)
  return keys
})

const nodeProps = computed(() => {
  const keys = visibleKeys.value
  return ({ option }: { option: TreeOption }) => {
    const node = option as Node
    const hidden = !!keys && !keys.has(String(node.key))
    return {
      class: hidden ? 'seek-hide' : undefined,
      onClick() {
        selected.value = [node.key as string]
        if (node.kind === 'db' && node.db) conn.currentDb = node.db
        pane.value?.focus()
      },
      onDblclick() {
        if (node.kind === 'table' && node.db && node.table) queryTable(node.db, node.table)
      },
      onContextmenu(e: MouseEvent) {
        e.preventDefault()
        if (node.kind === 'table' || node.kind === 'conn' || node.kind === 'db') openMenu(node, e)
      }
    }
  }
})

const tableMenu = [
  { key: 'query', label: '查询表数据', extra: 'Ctrl+Enter' },
  { key: 'structure', label: '编辑表结构', extra: 'Ctrl+E' },
  { key: 'copy', label: '复制表名' },
  { key: 'export', label: '导出数据', extra: 'Ctrl+Alt+E' },
  { key: 'drop', label: '删除表', extra: 'Del' },
  { key: 'refresh', label: '刷新', extra: 'F5' }
]

const connMenu = [
  { key: 'edit', label: '编辑连接' },
  { key: 'disconnect', label: '断开连接' },
  { key: 'remove', label: '删除连接' }
]

const dbMenu = [{ key: 'refresh', label: '刷新', extra: 'F5' }]

function menuOptions() {
  const kind = menuNode.value?.kind
  if (kind === 'conn') return connMenu
  if (kind === 'db') return dbMenu
  return tableMenu
}

async function refreshDb(db: string): Promise<void> {
  const tables = await api().meta.tables(conn.activeId, db)
  const children: Node[] = tables.map((t) => ({
    key: `t:${db}:${t.name}`,
    label: t.name,
    kind: 'table' as const,
    db,
    table: t.name,
    isLeaf: true,
    prefix: tableIcon
  }))
  // 换掉库节点引用，Naive 树才会重新画，新建表才会出现
  nodes.value = nodes.value.map((c) => {
    const kids = c.children as Node[] | undefined
    if (!kids?.some((d) => d.db === db)) return c
    return {
      ...c,
      children: kids.map((d) => (d.db === db ? { ...d, children } : d))
    }
  })
  message.success(`已刷新 ${db}`)
}

async function exportTable(db: string, table: string): Promise<void> {
  const resp = await api().query.run(conn.activeId, `SELECT * FROM \`${db}\`.\`${table}\` LIMIT 1000`, {
    database: db,
    readonly: true,
    maxRows: 1000,
    timeoutMs: 60000,
    confirmed: false
  })
  const set = resp.sets[0]
  if (!resp.ok || !set) {
    message.error(resp.error?.message || resp.blocked || '导出失败')
    return
  }
  const path = await api().file.saveCsv(
    `${table}.csv`,
    set.columns.map((c) => c.name),
    set.rows.map((r) => set.columns.map((c) => r[c.name] ?? null))
  )
  if (path) message.success(`已导出：${path}`)
}

function dropTable(db: string, table: string): void {
  dialog.warning({
    title: '删除表',
    content: `确认删除 ${db}.${table}？表及数据将不可恢复。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const resp = await api().query.run(conn.activeId, `DROP TABLE \`${db}\`.\`${table}\``, {
        database: db,
        readonly: false,
        maxRows: 1,
        timeoutMs: 30000,
        confirmed: true
      })
      if (!resp.ok) {
        message.error(resp.error?.message || resp.blocked || '删除失败')
        return
      }
      message.success('已删除')
      await refreshDb(db)
    }
  })
}

function onMenuSelect(key: string): void {
  menuShow.value = false
  const node = menuNode.value
  if (!node) return
  if (node.kind === 'conn' && node.connId) {
    if (key === 'edit') {
      ui.connectionEditId = node.connId
      ui.connectionManagerVisible = true
    } else if (key === 'disconnect' && conn.activeId === node.connId) {
      void conn.disconnect()
    } else if (key === 'remove') {
      const id = node.connId
      dialog.warning({
        title: '删除连接',
        content: '确认删除该连接配置？',
        positiveText: '删除',
        negativeText: '取消',
        onPositiveClick: async () => {
          if (conn.activeId === id) await conn.disconnect()
          await api().connections.remove(id)
          await conn.refresh()
        }
      })
    }
    return
  }
  if (node.kind === 'db' && node.db) {
    if (key === 'refresh') void refreshDb(node.db)
    return
  }
  if (!node.db || !node.table) return
  if (key === 'query') queryTable(node.db, node.table)
  else if (key === 'structure') {
    conn.currentDb = node.db
    ui.focusTable = node.table
    ui.module = 'structure'
  } else if (key === 'copy') {
    void navigator.clipboard.writeText(node.table).then(() => message.success('已复制表名'))
  } else if (key === 'export') void exportTable(node.db, node.table)
  else if (key === 'drop') dropTable(node.db, node.table)
  else if (key === 'refresh') void refreshDb(node.db)
}

function createConnection(): void {
  ui.connectionEditId = ''
  ui.connectionManagerVisible = true
}

let expandedSnapshot: Array<string | number> | null = null

function ancestorKeys(list: Node[], q: string): string[] {
  const keys: string[] = []
  const walk = (items: Node[]): boolean => {
    let hit = false
    for (const node of items) {
      const kids = (node.children as Node[] | undefined) ?? []
      const childHit = kids.length > 0 && walk(kids)
      const self = String(node.label ?? '').toLowerCase().includes(q)
      if (childHit && node.key != null) keys.push(String(node.key))
      if (self || childHit) hit = true
    }
    return hit
  }
  walk(list)
  return keys
}

watch(seek, (value) => {
  const q = value.trim().toLowerCase()
  if (q) {
    if (!expandedSnapshot) expandedSnapshot = [...expanded.value]
    const next = [...new Set([...expanded.value.map(String), ...ancestorKeys(nodes.value, q)])]
    const same = next.length === expanded.value.length && next.every((key, i) => String(expanded.value[i]) === key)
    if (!same) expanded.value = next
    void nextTick(paintSeek)
    return
  }
  if (expandedSnapshot) {
    expanded.value = expandedSnapshot
    expandedSnapshot = null
  }
  void nextTick(paintSeek)
})

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}

function highlightHtml(text: string, needle: string): string {
  const lower = text.toLowerCase()
  let html = ''
  let i = 0
  while (i < text.length) {
    const at = lower.indexOf(needle, i)
    if (at < 0) {
      html += escapeHtml(text.slice(i))
      break
    }
    if (at > i) html += escapeHtml(text.slice(i, at))
    html += `<span class="seek-hit">${escapeHtml(text.slice(at, at + needle.length))}</span>`
    i = at + needle.length
  }
  return html
}

/** 渲染后再标黄。把高亮 vnode 交给树，退格时会把节点补丁打崩 */
let painting = false
let seekObserver: MutationObserver | null = null
let seekPaintTimer = 0

function observeSeek(): void {
  if (!pane.value || !seekObserver) return
  seekObserver.observe(pane.value, { subtree: true, childList: true, characterData: true })
}

function paintSeek(): void {
  const root = pane.value
  if (!root || painting) return
  painting = true
  seekObserver?.disconnect()
  const needle = seek.value.trim().toLowerCase()
  root.querySelectorAll<HTMLElement>('.n-tree-node-content__text').forEach((el) => {
    const text = el.textContent ?? ''
    if (!needle) {
      if (el.querySelector('.seek-hit')) el.textContent = text
      return
    }
    const html = highlightHtml(text, needle)
    if (el.innerHTML !== html) el.innerHTML = html
  })
  painting = false
  observeSeek()
}

/** 树节点批量插入时合并为一次高亮，避免 MutationObserver 连刷 */
function schedulePaintSeek(): void {
  window.clearTimeout(seekPaintTimer)
  seekPaintTimer = window.setTimeout(() => paintSeek(), 32)
}

onMounted(() => {
  seekObserver = new MutationObserver(() => schedulePaintSeek())
  observeSeek()
})
onUnmounted(() => {
  window.clearTimeout(seekPaintTimer)
  seekObserver?.disconnect()
})

function firstHit(q: string): Node | undefined {
  const walk = (list: Node[] | undefined): Node | undefined => {
    if (!list) return
    for (const node of list) {
      if (String(node.label ?? '').toLowerCase().includes(q)) return node
      const hit = walk(node.children as Node[] | undefined)
      if (hit) return hit
    }
  }
  return walk(nodes.value)
}

function onTypeAhead(e: KeyboardEvent): void {
  if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return
  if (e.key === 'Escape') {
    seek.value = ''
    return
  }
  if (e.key === 'Backspace') {
    if (!seek.value) return
    e.preventDefault()
    seek.value = seek.value.slice(0, -1)
    return
  }
  if (e.key.length !== 1) return
  e.preventDefault()
  seek.value += e.key
  const hit = firstHit(seek.value.trim().toLowerCase())
  if (!hit) return
  selected.value = [hit.key as string]
  if (hit.kind === 'db' && hit.db) conn.currentDb = hit.db
  void nextTick(() => pane.value?.querySelector('.n-tree-node--selected')?.scrollIntoView({ block: 'nearest' }))
}
</script>

<template>
  <div ref="pane" class="tree-pane" tabindex="0" @keydown="onTypeAhead">
    <div class="tree-head">
      <span>连接</span>
      <NButton size="small" type="primary" @click="createConnection">+ 新建连接</NButton>
    </div>
    <NTree
      v-if="nodes.length"
      :expanded-keys="expanded"
      @update:expanded-keys="onExpanded"
      v-model:selected-keys="selected"
      class="tree"
      block-line
      :animated="false"
      :data="nodes"
      :on-load="onLoad"
      :node-props="nodeProps"
      :cancelable="false"
    />
    <div v-else class="tree-empty">暂无连接，点击「新建连接」</div>
    <NDropdown
      placement="bottom-start"
      trigger="manual"
      :x="menuX"
      :y="menuY"
      :options="menuOptions()"
      :show="menuShow"
      :on-clickoutside="() => (menuShow = false)"
      @select="onMenuSelect"
    />
  </div>
</template>

<style scoped>
.tree-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  outline: none;
}

.tree-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.tree {
  flex: 1;
  overflow: auto;
  padding: 0 6px 8px;
}

.tree :deep(.n-tree-node) {
  align-items: center;
}

.tree :deep(.n-tree-node--selected > .n-tree-node-content),
.tree :deep(.n-tree-node-content--selected) {
  background: #e8f1ff;
}

.tree :deep(.n-tree-node-wrapper:has(.seek-hide)) {
  display: none;
}

.tree :deep(.seek-hide) {
  display: none;
}

.tree :deep(.seek-hit) {
  background: #ffe56a;
  border-radius: 2px;
}

.tree :deep(.n-tree-node--highlight .n-tree-node-content__text) {
  border-bottom-color: transparent;
}

.tree :deep(.node-ico) {
  width: 14px;
  height: 14px;
  color: #8c8c8c;
}

.tree :deep(.dot) {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d0d3d9;
  display: inline-block;
}

.tree :deep(.dot.on) {
  background: #22c55e;
}

.tree-empty {
  color: #a8abb2;
  text-align: center;
  padding: 32px 12px;
  font-size: 12px;
}
</style>
