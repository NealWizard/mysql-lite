<script setup lang="ts">
/**
 * SQL 查询工作台（对应原型图 2）：
 * - 工具栏：数据库切换、只读模式
 * - 编辑器：多标签、Monaco 高亮、执行(Ctrl+Enter)/格式化/美化/EXPLAIN
 * - 结果区：多结果集标签页、行数/耗时/影响行数、复制、导出 CSV、分页
 * 执行规则：有选中执行选中；无选中执行光标所在语句；「执行全部」为单独动作。
 */
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NDropdown, NEmpty, NSelect, NSpin, useDialog, useMessage } from 'naive-ui'
import { format as formatSql } from 'sql-formatter'
import SqlEditor from '../../components/SqlEditor.vue'
import ResultGrid from '../../components/ResultGrid.vue'
import { useConnectionStore } from '../../stores/connection'
import { useQueryStore, type EditorTab } from '../../stores/query'
import { useUiStore } from '../../stores/ui'
import { api } from '../../services/api'
import { compressSql } from '../../utils/compressSql'
import type { ApplyEdits, StatementRisk, WorkspaceTab } from '../../types'

/** 结果集硬上限与执行超时（文档 5.2/5.4 节保护要求） */
const MAX_ROWS = 1000
const TIMEOUT_MS = 60000
/** 超过该长度则启动时询问是否加载，避免大文本卡住编辑器 */
const WORKSPACE_LOAD_LIMIT = 1024 * 1024
let countSeq = 0

const conn = useConnectionStore()
const qs = useQueryStore()
const ui = useUiStore()
const message = useMessage()
const dialog = useDialog()

const editorRef = ref<InstanceType<typeof SqlEditor>>()
const workspaceRef = ref<HTMLElement | null>(null)
/** 结果区外框高度。默认 540，拖动后写入工作区，重启保持 */
const DEFAULT_RESULT_HEIGHT = 540
const resultHeight = ref(DEFAULT_RESULT_HEIGHT)
const MIN_EDITOR = 180
const MIN_RESULT = 160
const resultStyle = computed(() => ({ flex: '0 0 auto', height: `${resultHeight.value}px` }))
let stopSplit: (() => void) | null = null

function onSplitDown(e: MouseEvent): void {
  if (e.button !== 0) return
  const root = workspaceRef.value
  const result = root?.querySelector('.result-pane') as HTMLElement | null
  if (!root || !result) return
  e.preventDefault()
  const startY = e.clientY
  const startH = result.getBoundingClientRect().height
  const onMove = (ev: MouseEvent) => {
    const available = root.clientHeight - 16 - 8
    const max = available - MIN_EDITOR
    if (max < MIN_RESULT) return
    const next = startH - (ev.clientY - startY)
    resultHeight.value = Math.round(Math.min(max, Math.max(MIN_RESULT, next)))
  }
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
    stopSplit = null
    persistWorkspace()
  }
  stopSplit = onUp
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
const gridRef = ref<{
  exportCsv: () => void
  copySelected: () => void
  collect: () => ApplyEdits | null
} | null>(null)
const saving = ref(false)

const tab = computed(() => qs.activeTab)
/** 结果区三个固定页：查询结果 / 执行信息 / 执行计划 */
const resultMode = ref<'data' | 'info' | 'plan'>('data')
const setIndex = ref(0)
const activeSet = computed(() => tab.value?.sets[setIndex.value])

/** 用户选择不加载的大选项卡，写回文件时原样保留 */
const heldTabs: WorkspaceTab[] = []
const workspaceReady = ref(false)
let saveTimer: ReturnType<typeof setTimeout> | undefined

function workspacePayload() {
  const open = qs.tabs.map((t) => ({ id: t.id, title: t.title, sql: t.sql }))
  const held = heldTabs.filter((t) => !open.some((o) => o.id === t.id))
  return { activeTabId: qs.activeTabId, tabs: [...open, ...held], resultHeight: resultHeight.value }
}

function persistWorkspace(): void {
  if (!workspaceReady.value) return
  void api().workspace.save(workspacePayload()).catch(() => undefined)
}

function flushWorkspace(): void {
  if (!workspaceReady.value) return
  try {
    api().workspace.saveSync(workspacePayload())
  } catch {
    // 关闭窗口时桥接可能已不可用
  }
}

function askLoad(title: string): Promise<boolean> {
  return new Promise((resolve) => {
    dialog.warning({
      title: '提示',
      content: `“${title}”工作区内容过大，是否加载`,
      positiveText: '加载',
      negativeText: '不加载',
      closable: false,
      maskClosable: false,
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false)
    })
  })
}

async function bootWorkspace(): Promise<void> {
  try {
    const saved = await api().workspace.load()
    const accepted: WorkspaceTab[] = []
    for (const tab of saved.tabs) {
      if (tab.sql.length > WORKSPACE_LOAD_LIMIT) {
        const yes = await askLoad(tab.title)
        if (!yes) {
          heldTabs.push(tab)
          continue
        }
      }
      accepted.push(tab)
    }
    if (typeof saved.resultHeight === 'number' && saved.resultHeight >= MIN_RESULT) {
      resultHeight.value = saved.resultHeight
    }
    if (accepted.length > 0) qs.replaceTabs(accepted, saved.activeTabId)
    else qs.ensureTab()
  } catch {
    if (qs.tabs.length === 0) qs.ensureTab()
  } finally {
    workspaceReady.value = true
  }
}

onMounted(() => {
  window.addEventListener('beforeunload', flushWorkspace)
  void bootWorkspace()
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', flushWorkspace)
  clearTimeout(saveTimer)
  flushWorkspace()
  stopSplit?.()
})

const openTabIds = computed(() => qs.tabs.map((t) => t.id))

watch(
  () => qs.tabs.map((t) => `${t.id}\0${t.title}\0${t.sql}`).join('\u0001'),
  () => {
    if (!workspaceReady.value) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(persistWorkspace, 400)
  }
)

// 「查询数据」等入口创建的 autoRun 标签：激活后自动执行
watch(
  () => qs.activeTabId,
  async () => {
    const t = qs.activeTab
    if (t?.autoRun && conn.connected) {
      t.autoRun = false
      await nextTick()
      void execute(t, t.sql)
    }
  },
  { immediate: true }
)

/** 危险语句二次确认：展示目标连接/库与风险明细 */
function confirmRisks(risks: StatementRisk[]): Promise<boolean> {
  return new Promise((resolve) => {
    dialog.warning({
      title: '危险操作确认',
      content: () =>
        h('div', [
          h('p', { style: 'font-weight:600' }, `目标：${conn.statusText} / 数据库 ${conn.currentDb}`),
          ...risks.map((r) =>
            h('p', { style: 'color:#d03050;margin:4px 0' }, `第 ${r.index + 1} 条：${r.reason}`)
          ),
          h('p', { style: 'color:#909399' }, '确认继续执行吗？')
        ]),
      positiveText: '仍要执行',
      negativeText: '取消',
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false)
    })
  })
}

async function execute(t: EditorTab, sql: string, confirmed = false, offset = 0): Promise<void> {
  if (!sql.trim()) return
  if (!conn.connected) {
    message.warning('请先连接数据库')
    return
  }
  t.running = true
  t.error = null
  t.countToken = ++countSeq
  t.counting = false
  if (offset === 0) t.totalRows = null
  void api().query.cancelCount().catch(() => undefined)
  qs.remember(sql)
  const named = sql.match(/\bfrom\s+(?:`[^`]+`\.)?`?([A-Za-z0-9_]+)`?/i)
  if (named) t.title = `${named[1]}.sql`
  resultMode.value = 'data'
  setIndex.value = 0
  try {
    const resp = await api().query.run(conn.activeId, sql, {
      database: conn.currentDb,
      readonly: ui.readonly,
      maxRows: MAX_ROWS,
      timeoutMs: TIMEOUT_MS,
      confirmed,
      offset
    })

    if (resp.blocked) {
      message.warning(resp.blocked)
      return
    }
    if (resp.needConfirm) {
      const ok = await confirmRisks(resp.needConfirm)
      if (ok) await execute(t, sql, true, offset)
      return
    }
    t.sets = resp.sets
    t.error = resp.error ?? null
    if (resp.error) {
      message.error(`第 ${resp.error.index + 1} 条语句执行失败：${resp.error.code ?? ''}`)
    } else {
      const preview = resp.sets.find((s) => s.previewOffset !== null)
      if (preview && preview.previewOffset !== null && !preview.truncated) {
        t.totalRows = preview.previewOffset + preview.rowCount
      } else if (preview && t.totalRows === null) {
        void startCount(t, preview.statement)
      }
    }
  } catch (e) {
    t.error = { index: 0, message: String(e), statement: sql }
  } finally {
    t.running = false
  }
}

/** 执行：选中内容优先，其次光标所在语句 */
function turnPage(dir: -1 | 1): void {
  const t = tab.value
  const set = activeSet.value
  if (!t || !set || set.previewOffset === null || t.running) return
  const offset = set.previewOffset + dir * MAX_ROWS
  if (offset < 0) return
  void execute(t, set.statement, false, offset)
}

function confirmDelete(count: number): Promise<boolean> {
  return new Promise((resolve) => {
    dialog.warning({
      title: '保存',
      content: `将删除 ${count} 行`,
      positiveText: '保存',
      negativeText: '取消',
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false)
    })
  })
}

async function saveEdits(): Promise<void> {
  const t = tab.value
  const set = activeSet.value
  const grid = gridRef.value
  if (!t || !set || !grid || saving.value) return
  const edits = grid.collect()
  if (!edits) {
    message.warning('没有需要保存的修改')
    return
  }
  if (!edits.database) edits.database = conn.currentDb
  if (!edits.database) {
    message.warning('请先选择数据库')
    return
  }
  if (edits.deletes.length > 0) {
    const ok = await confirmDelete(edits.deletes.length)
    if (!ok) return
  }
  saving.value = true
  try {
    await api().query.apply(conn.activeId, edits)
    message.success('已保存')
    await execute(t, set.statement, false, set.previewOffset ?? 0)
  } catch (e) {
    const err = e as { message?: string }
    message.error(err?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

function runSmart(): void {
  const t = tab.value
  if (!t) return
  const selected = editorRef.value?.getSelectedText().trim()
  const sql = selected || editorRef.value?.getCursorStatement() || t.sql
  void execute(t, sql)
}

async function runExplain(): Promise<void> {
  const t = tab.value
  if (!t || !conn.connected) return
  const selected = editorRef.value?.getSelectedText().trim()
  const stmt = (selected || editorRef.value?.getCursorStatement() || t.sql).replace(/;+\s*$/, '').trim()
  if (!stmt) {
    message.warning('没有可解释的语句')
    return
  }
  const resp = await api().query.run(conn.activeId, `EXPLAIN ${stmt}`, {
    database: conn.currentDb,
    readonly: true,
    maxRows: MAX_ROWS,
    timeoutMs: TIMEOUT_MS,
    confirmed: false
  })
  t.plan = resp.sets[0] ?? null
  if (!resp.ok) message.error(resp.error?.message || resp.blocked || 'EXPLAIN 失败')
}

async function startCount(t: EditorTab, statement: string): Promise<void> {
  const token = ++countSeq
  t.countToken = token
  t.counting = true
  try {
    const total = await api().query.count(conn.activeId, statement, conn.currentDb, TIMEOUT_MS)
    if (t.countToken !== token) return
    t.totalRows = total
  } catch {
    if (t.countToken !== token) return
    t.totalRows = null
  } finally {
    if (t.countToken === token) t.counting = false
  }
}

function stopQuery(): void {
  const t = tab.value
  if (t) {
    t.countToken = ++countSeq
    t.counting = false
  }
  void api().query.cancel()
}

function clearSql(): void {
  if (tab.value) tab.value.sql = ''
}

function onCursor(line: number, column: number): void {
  ui.cursorLine = line
  ui.cursorCol = column
}

function onSql(value: string): void {
  const current = tab.value
  if (current) current.sql = value
}

const instanceOptions = computed(() => conn.profiles.map((p) => ({ label: p.name, value: p.id })))
const dbOptions = computed(() => conn.shownDatabases.map((d) => ({ label: d, value: d })))

async function onInstance(id: string): Promise<void> {
  if (!id || (id === conn.activeId && conn.connected)) return
  if (conn.connected && conn.activeId && conn.activeId !== id) await conn.disconnect()
  const result = await conn.open(id)
  if (!result.ok) message.error(result.error || '连接失败')
}

const historyOptions = computed(() =>
  qs.history.map((sql, i) => ({ key: String(i), label: sql.replace(/\s+/g, ' ').slice(0, 72) }))
)

function onHistory(key: string): void {
  const sql = qs.history[Number(key)]
  if (sql) qs.newTab(sql)
}

function compress(): void {
  const t = tab.value
  if (!t || !t.sql.trim()) return
  t.sql = compressSql(t.sql)
}

/** 格式化/美化：失败时保留原文（文档 2.3 节要求） */
function reformat(style: 'compact' | 'pretty'): void {
  const t = tab.value
  if (!t || !t.sql.trim()) return
  try {
    t.sql = formatSql(t.sql, {
      language: 'mysql',
      keywordCase: 'upper',
      tabWidth: style === 'pretty' ? 4 : 2,
      expressionWidth: style === 'pretty' ? 24 : 50,
      linesBetweenQueries: style === 'pretty' ? 2 : 1
    })
  } catch {
    message.warning('格式化失败，已保留原文')
  }
}

</script>

<template>
  <div v-if="tab" ref="workspaceRef" class="query-workspace">
    <!-- 右上：选项卡、工具栏、编辑器同一块，中间不加分隔线 -->
    <section class="editor-card">
    <div class="file-tabs">
      <button
        v-for="t in qs.tabs"
        :key="t.id"
        class="file-tab"
        :class="{ active: t.id === qs.activeTabId }"
        @click="qs.activeTabId = t.id"
      >
        <svg class="file-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
          <path d="M14 3v5h5" />
        </svg>
        {{ t.title }}
        <span class="file-close" @click.stop="qs.closeTab(t.id)">×</span>
      </button>
      <button class="file-add" @click="qs.newTab()">+</button>
    </div>

    <div class="toolbar">
      <NSelect
        class="toolbar-select"
        size="small"
        :value="conn.connected ? conn.activeId : null"
        :options="instanceOptions"
        placeholder="实例"
        :disabled="tab.running || conn.connecting"
        :consistent-menu-width="false"
        @update:value="onInstance"
      />
      <NSelect
        class="toolbar-select"
        size="small"
        :value="conn.currentDb || null"
        :options="dbOptions"
        placeholder="库"
        filterable
        :disabled="!conn.connected || tab.running"
        :consistent-menu-width="false"
        @update:value="(v: string) => (conn.currentDb = v)"
      />
      <NButton size="small" type="primary" :disabled="!conn.connected || tab.running" @click="runSmart">
        ▶ 执行
      </NButton>
      <NButton size="small" quaternary :disabled="!tab.running && !tab.counting" @click="stopQuery">■ 停止</NButton>
      <NButton size="small" quaternary @click="reformat('pretty')">格式化</NButton>
      <NButton size="small" quaternary @click="compress">压缩</NButton>
      <NButton size="small" quaternary @click="clearSql">清空</NButton>
      <NDropdown trigger="click" :options="historyOptions" @select="onHistory">
        <NButton size="small" quaternary :disabled="qs.history.length === 0">历史 ▾</NButton>
      </NDropdown>
    </div>

    <div class="editor-box">
      <SqlEditor
        ref="editorRef"
        :tab-id="tab.id"
        :open-tab-ids="openTabIds"
        :model-value="tab.sql"
        @update:model-value="onSql"
        @execute="runSmart"
        @cursor="onCursor"
      />
    </div>
    </section>

    <div class="split-bar" title="拖动调整编辑区和结果区高度" @mousedown="onSplitDown" />

    <!-- 右下：结果面板，完整外边框 -->
    <div class="result-pane" :style="resultStyle">
      <div class="result-tabbar">
        <button class="rtab" :class="{ on: resultMode === 'data' }" @click="resultMode = 'data'">查询结果</button>
        <button class="rtab" :class="{ on: resultMode === 'info' }" @click="resultMode = 'info'">执行信息</button>
        <button
          class="rtab"
          :class="{ on: resultMode === 'plan' }"
          @click="resultMode = 'plan'; runExplain()"
        >
          执行计划
        </button>
        <span class="set-switch" v-if="tab.sets.length > 1 && resultMode === 'data'">
          <button
            v-for="(_s, i) in tab.sets"
            :key="i"
            class="set-btn"
            :class="{ on: setIndex === i }"
            @click="setIndex = i"
          >
            结果 {{ i + 1 }}
          </button>
        </span>
        <span style="flex: 1" />
        <NButton size="small" quaternary :disabled="!activeSet" @click="gridRef?.exportCsv()">↓ 导出</NButton>
        <NButton size="small" quaternary :disabled="!activeSet" @click="gridRef?.copySelected()">复制</NButton>
      </div>

      <div class="result-body">
        <NSpin v-if="tab.running && !saving" size="small" class="result-center">执行中…</NSpin>
        <template v-else-if="resultMode === 'data'">
          <NAlert v-if="tab.error" type="error" :bordered="false">
            第 {{ tab.error.index + 1 }} 条失败：{{ tab.error.message }}
          </NAlert>
          <div v-if="activeSet && activeSet.columns.length" class="result-stack">
            <ResultGrid
              ref="gridRef"
              :set="activeSet"
              :max-rows="MAX_ROWS"
              tools
              :saving="saving"
              :connection-id="conn.activeId"
              @save="saveEdits"
            />
            <div v-if="saving && tab.running" class="result-mask">
              <NSpin size="small">执行中…</NSpin>
            </div>
          </div>
          <div v-else-if="activeSet" class="ok-line">执行成功，影响行数 {{ activeSet.affectedRows ?? 0 }}</div>
          <NEmpty v-else description="执行 SQL 后在此查看结果" class="result-center" />
        </template>
        <div v-else-if="resultMode === 'info'" class="info-pane">
          <template v-if="activeSet || tab.error">
            <p>状态：{{ tab.error ? '失败' : '成功' }}</p>
            <p v-if="activeSet">耗时：{{ activeSet.durationMs }} ms</p>
            <p v-if="activeSet">返回行数：{{ activeSet.rowCount }}<span v-if="tab.totalRows !== null"> / 共 {{ tab.totalRows }} 行</span><span v-else-if="tab.counting"> / 统计中…</span></p>
            <p v-if="activeSet && activeSet.affectedRows !== null">影响行数：{{ activeSet.affectedRows }}</p>
            <p v-if="tab.error">错误：{{ tab.error.message }}</p>
            <pre>{{ tab.error?.statement || activeSet?.statement }}</pre>
          </template>
          <NEmpty v-else description="尚无执行信息" class="result-center" />
        </div>
        <template v-else>
          <ResultGrid v-if="tab.plan" :set="tab.plan" :max-rows="MAX_ROWS" />
          <NEmpty v-else description="将解释当前语句" class="result-center" />
        </template>
      </div>

      <div class="result-foot">
        <template v-if="activeSet">
          查询耗时：{{ activeSet.durationMs }} ms<span class="foot-sep">|</span>
          <template v-if="activeSet.previewOffset !== null">
            第 {{ activeSet.previewOffset + 1 }}–{{ activeSet.previewOffset + activeSet.rowCount }} 行
            <template v-if="tab.counting"> · 统计中…</template>
            <template v-else-if="tab.totalRows !== null"> / 共 {{ tab.totalRows }} 行</template>
          </template>
          <template v-else>{{ activeSet.rowCount }} 条记录</template>
        </template>
        <template v-else-if="tab.error">执行失败</template>
        <span style="flex: 1" />
        <template v-if="activeSet && activeSet.previewOffset !== null">
          <button class="page-btn" :disabled="tab.running || activeSet.previewOffset === 0" @click="turnPage(-1)">上一批</button>
          <button class="page-btn" :disabled="tab.running || !activeSet.truncated" @click="turnPage(1)">下一批</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.query-workspace {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 0;
  padding: 8px;
  box-sizing: border-box;
  background: #f4f6f9;
}

.editor-card {
  flex: 1 1 0;
  min-height: 180px;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  overflow: hidden;
}

.file-tabs {
  display: flex;
  align-items: stretch;
  height: 36px;
  background: #fff;
  flex-shrink: 0;
  border-bottom: none;
}

.file-tab,
.file-add {
  border: none;
  border-right: 1px solid #e4e7ed;
  background: transparent;
  cursor: pointer;
  color: #606266;
  font-size: 13px;
}

.file-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
}

.file-tab.active {
  color: #262626;
  font-weight: 600;
  background: #f7f9fc;
}

.file-ico {
  width: 14px;
  height: 14px;
}

.file-close {
  color: #a8abb2;
  padding: 0 2px;
}

.file-close:hover {
  color: #262626;
}

.file-add {
  width: 36px;
  font-size: 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  flex-shrink: 0;
}

.toolbar-select {
  width: 148px;
  flex-shrink: 0;
}

.editor-box {
  flex: 1;
  min-height: 0;
  padding: 0 12px 10px;
}

.split-bar {
  flex: 0 0 8px;
  cursor: row-resize;
  position: relative;
}

.split-bar::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 3px;
  width: 36px;
  height: 2px;
  margin-left: -18px;
  border-radius: 1px;
  background: #d0d5dd;
}

.split-bar:hover::after {
  background: #2f6bff;
}

.result-pane {
  flex: 0 0 auto;
  box-sizing: border-box;
  height: 540px;
  min-height: 160px;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  overflow: hidden;
}

.result-tabbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border-bottom: 1px solid #eef0f3;
  flex-shrink: 0;
}

.rtab {
  border: none;
  background: transparent;
  padding: 8px 12px;
  cursor: pointer;
  color: #606266;
  font-size: 13px;
  border-bottom: 2px solid transparent;
}

.rtab.on {
  color: #2f6bff;
  border-bottom-color: #2f6bff;
  font-weight: 600;
}

.set-switch {
  display: flex;
  gap: 4px;
  margin-left: 8px;
}

.set-btn {
  border: 1px solid #e6e8eb;
  background: #fff;
  border-radius: 4px;
  font-size: 12px;
  padding: 2px 8px;
  cursor: pointer;
}

.set-btn.on {
  border-color: #2f6bff;
  color: #2f6bff;
}

.result-body {
  flex: 1;
  min-height: 0;
  padding: 8px 12px 0;
  display: flex;
  flex-direction: column;
}

.result-body > :deep(.result-grid),
.result-body > .result-grid,
.result-stack > :deep(.result-grid),
.result-stack > .result-grid {
  flex: 1;
  min-height: 0;
}

.result-stack {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.result-mask {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
}

.result-center {
  margin: 28px auto;
}

.info-pane {
  font-size: 13px;
  color: #434343;
  line-height: 1.7;
}

.info-pane pre {
  background: #f7f8fa;
  padding: 8px 10px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: Consolas, monospace;
  font-size: 12px;
}

.ok-line {
  color: #18a058;
  padding: 12px;
}

.result-foot {
  height: 28px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-size: 12px;
  color: #8c8c8c;
  border-top: 1px solid #f2f3f5;
}

.page-btn {
  border: none;
  background: transparent;
  color: #2f6bff;
  cursor: pointer;
  font-size: 12px;
  padding: 0 6px;
}

.page-btn:disabled {
  color: #c0c4cc;
  cursor: default;
}

.foot-sep {
  margin: 0 10px;
  color: #d0d3d9;
}
</style>
