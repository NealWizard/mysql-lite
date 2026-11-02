<script setup lang="ts">
/**
 * 单表结构编辑。从连接树右键「编辑表结构」进入，只展示这一张表。
 * 字段、索引可改，保存时生成一条 ALTER，确认后执行。
 */
import { computed, h, ref, watch } from 'vue'
import {
  NButton,
  NCheckbox,
  NDataTable,
  NEmpty,
  NInput,
  NSelect,
  NSpace,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  useDialog,
  useMessage,
  type DataTableColumns
} from 'naive-ui'
import { useConnectionStore } from '../../stores/connection'
import { useQueryStore } from '../../stores/query'
import { useUiStore } from '../../stores/ui'
import { api } from '../../services/api'
import type { TableDetail } from '../../types'
import {
  buildAlterSql,
  fieldFromColumn,
  indexFromInfo,
  isViewDdl,
  type FieldDraft,
  type IndexDraft
} from './alterSql'

const conn = useConnectionStore()
const qs = useQueryStore()
const ui = useUiStore()
const message = useMessage()
const dialog = useDialog()

const tableName = ref('')
const detail = ref<TableDetail | null>(null)
const detailLoading = ref(false)
const fields = ref<FieldDraft[]>([])
const indexes = ref<IndexDraft[]>([])
const selectedField = ref('')
const selectedIndex = ref('')
const saving = ref(false)
/** 当前正在编辑的格子。其余格子只显示文字 */
const editing = ref<{ key: string; column: string } | null>(null)
let baselineFields: FieldDraft[] = []
let baselineIndexes: IndexDraft[] = []
let draftSeq = 0

const TYPE_OPTIONS = [
  'varchar', 'char', 'text', 'tinytext', 'mediumtext', 'longtext',
  'int', 'bigint', 'tinyint', 'smallint', 'mediumint',
  'decimal', 'float', 'double',
  'datetime', 'timestamp', 'date', 'time', 'year',
  'json', 'blob', 'tinyblob', 'mediumblob', 'longblob',
  'bit', 'boolean', 'enum', 'set'
].map((value) => ({ label: value, value }))

const viewOnly = computed(() => !!detail.value && isViewDdl(detail.value.ddl))
const dirty = computed(
  () =>
    JSON.stringify(fields.value) !== JSON.stringify(baselineFields) ||
    JSON.stringify(indexes.value) !== JSON.stringify(baselineIndexes)
)

function nextKey(prefix: string): string {
  draftSeq += 1
  return `${prefix}${draftSeq}`
}

function blankField(): FieldDraft {
  return {
    key: nextKey('n'),
    originalName: null,
    name: '',
    type: 'varchar',
    length: '255',
    decimals: '',
    nullable: true,
    defaultValue: null,
    comment: '',
    primary: false,
    extra: '',
    unsigned: false,
    zerofill: false,
    enumMode: false,
    fullType: ''
  }
}

async function loadDetail(name: string): Promise<void> {
  if (!conn.connected || !conn.currentDb) return
  tableName.value = name
  detailLoading.value = true
  detail.value = null
  try {
    const loaded = await api().meta.tableDetail(conn.activeId, conn.currentDb, name)
    const nextFields = loaded.columns.map((col) => fieldFromColumn(col, nextKey('f')))
    const nextIndexes = loaded.indexes
      .map((idx) => indexFromInfo(idx, nextKey('i')))
      .filter((idx): idx is IndexDraft => !!idx)
    baselineFields = structuredClone(nextFields)
    baselineIndexes = structuredClone(nextIndexes)
    fields.value = nextFields
    indexes.value = nextIndexes
    selectedField.value = ''
    selectedIndex.value = ''
    editing.value = null
    detail.value = loaded
  } catch (e) {
    message.error(`加载表结构失败：${String(e)}`)
  } finally {
    detailLoading.value = false
  }
}

watch(
  () => ui.focusTable,
  (name) => {
    if (!name) return
    const target = name
    ui.focusTable = ''
    if (dirty.value && tableName.value && tableName.value !== target) {
      dialog.warning({
        title: '放弃修改',
        content: '表结构已修改，离开后将丢弃。',
        positiveText: '离开',
        negativeText: '留下',
        onPositiveClick: () => void loadDetail(target)
      })
      return
    }
    void loadDetail(target)
  },
  { immediate: true }
)

watch(
  () => conn.connected,
  (ok) => {
    if (ok) return
    detail.value = null
    tableName.value = ''
    fields.value = []
    indexes.value = []
    baselineFields = []
    baselineIndexes = []
  }
)

function renameField(row: FieldDraft, name: string): void {
  const prev = row.name
  row.name = name
  if (!prev || prev === name) return
  for (const idx of indexes.value) {
    idx.columns = idx.columns.map((col) => (col === prev ? name : col))
  }
}

function setType(row: FieldDraft, value: string): void {
  if (value === 'enum' || value === 'set') {
    row.enumMode = true
    if (!row.type.toLowerCase().startsWith(value)) row.type = `${value}()`
    return
  }
  row.enumMode = false
  row.type = value
}

function fieldIndex(): number {
  return fields.value.findIndex((row) => row.key === selectedField.value)
}

function addField(at?: number): void {
  const row = blankField()
  if (at === undefined || at < 0) fields.value.push(row)
  else fields.value.splice(at, 0, row)
  selectedField.value = row.key
}

function removeField(): void {
  const at = fieldIndex()
  if (at < 0) return
  const removed = fields.value[at]
  fields.value.splice(at, 1)
  for (const idx of indexes.value) idx.columns = idx.columns.filter((col) => col !== removed.name)
  selectedField.value = fields.value[Math.min(at, fields.value.length - 1)]?.key ?? ''
}

function moveField(step: number): void {
  const at = fieldIndex()
  const to = at + step
  if (at < 0 || to < 0 || to >= fields.value.length) return
  const [row] = fields.value.splice(at, 1)
  fields.value.splice(to, 0, row)
}

function addIndex(): void {
  const row: IndexDraft = { key: nextKey('i'), originalName: null, name: '', columns: [], unique: false }
  indexes.value.push(row)
  selectedIndex.value = row.key
}

function removeIndex(): void {
  const at = indexes.value.findIndex((row) => row.key === selectedIndex.value)
  if (at < 0) return
  indexes.value.splice(at, 1)
  selectedIndex.value = indexes.value[Math.min(at, indexes.value.length - 1)]?.key ?? ''
}

const fieldNames = computed(() =>
  fields.value.map((row) => row.name.trim()).filter((name) => name.length > 0).map((name) => ({ label: name, value: name }))
)

function editingCell(key: string, column: string): boolean {
  return editing.value?.key === key && editing.value.column === column
}

function beginEdit(key: string, column: string, which: 'field' | 'index'): void {
  if (viewOnly.value) return
  if (which === 'field') selectedField.value = key
  else selectedIndex.value = key
  editing.value = { key, column }
}

function endEdit(): void {
  editing.value = null
}

/** 输入框挂上后直接聚焦，点一下就能改 */
function focusInput(vnode: unknown): void {
  const root = (vnode as { el?: unknown }).el
  if (!(root instanceof HTMLElement)) return
  const input = (root.matches('input') ? root : root.querySelector('input')) as HTMLInputElement | null
  input?.focus()
}

/** 整格可点，不依赖文字宽度 */
const NAME_COL_MIN = 80
const NAME_COL_MAX = 300

/** 与结果网格相同的估算：中文 12、英文 7 */
function measureText(text: string): number {
  let px = 0
  for (const ch of text) {
    px += ch.charCodeAt(0) > 255 ? 12 : 7
    if (px >= NAME_COL_MAX) return NAME_COL_MAX
  }
  return px
}

/** 字段名列：表头与全部字段名取较宽，加左右边距，上限 300 */
const nameColWidth = computed(() => {
  let px = measureText('字段名') + 28
  for (const row of fields.value) {
    const w = measureText(row.name || ' ') + 24
    if (w > px) px = w
    if (px >= NAME_COL_MAX) break
  }
  return Math.max(NAME_COL_MIN, Math.min(NAME_COL_MAX, px))
})

function textCell(key: string, column: string, text: string, which: 'field' | 'index', muted = false) {
  return h(
    'div',
    {
      class: muted ? 'cell-hit muted' : 'cell-hit',
      onClick: (event: MouseEvent) => {
        event.stopPropagation()
        beginEdit(key, column, which)
      }
    },
    text || '\u00a0'
  )
}

function editShell(child: ReturnType<typeof h>) {
  return h('div', { class: 'cell-edit', onClick: (event: MouseEvent) => event.stopPropagation() }, [child])
}

const fieldColumns = computed<DataTableColumns<FieldDraft>>(() => [
  {
    title: '序号',
    key: 'ordinal',
    width: 52,
    minWidth: 40,
    resizable: true,
    render: (_row, index) => h('div', { class: 'cell-hit center' }, String(index + 1))
  },
  {
    title: '字段名',
    key: 'name',
    width: nameColWidth.value,
    minWidth: NAME_COL_MIN,
    resizable: true,
    render: (row) =>
      editingCell(row.key, 'name')
        ? editShell(
            h(NInput, {
              size: 'small',
              value: row.name,
              onVnodeMounted: focusInput,
              onBlur: endEdit,
              onUpdateValue: (value: string) => renameField(row, value)
            })
          )
        : textCell(row.key, 'name', row.name, 'field')
  },
  {
    title: '类型',
    key: 'type',
    width: 100,
    minWidth: 72,
    resizable: true,
    render: (row) => {
      const shown = row.enumMode ? (row.type.toLowerCase().startsWith('set') ? 'set' : 'enum') : row.type
      return editingCell(row.key, 'type')
        ? editShell(
            h(NSelect, {
              size: 'small',
              value: shown,
              options: TYPE_OPTIONS,
              consistentMenuWidth: false,
              showOnFocus: true,
              onUpdateValue: (value: string) => {
                setType(row, value)
                endEdit()
              }
            })
          )
        : textCell(row.key, 'type', shown, 'field')
    }
  },
  {
    title: '长度',
    key: 'length',
    width: 64,
    minWidth: 56,
    resizable: true,
    render: (row) =>
      editingCell(row.key, 'length')
        ? editShell(
            h(NInput, {
              size: 'small',
              value: row.enumMode ? row.type : row.length,
              placeholder: row.enumMode ? "enum('a','b')" : '',
              onVnodeMounted: focusInput,
              onBlur: endEdit,
              onUpdateValue: (value: string) => {
                if (row.enumMode) row.type = value
                else row.length = value
              }
            })
          )
        : textCell(row.key, 'length', row.enumMode ? row.type : row.length, 'field')
  },
  {
    title: '小数位',
    key: 'decimals',
    width: 72,
    minWidth: 72,
    resizable: true,
    render: (row) =>
      !row.enumMode && editingCell(row.key, 'decimals')
        ? editShell(
            h(NInput, {
              size: 'small',
              value: row.decimals,
              onVnodeMounted: focusInput,
              onBlur: endEdit,
              onUpdateValue: (value: string) => (row.decimals = value)
            })
          )
        : textCell(row.key, 'decimals', row.enumMode ? '' : row.decimals, 'field')
  },
  {
    title: '非空',
    key: 'nullable',
    width: 56,
    minWidth: 56,
    resizable: true,
    render: (row) =>
      h(
        'div',
        { class: 'cell-hit center', onClick: (event: MouseEvent) => event.stopPropagation() },
        [
          h(NCheckbox, {
            checked: !row.nullable,
            disabled: viewOnly.value,
            'onUpdate:checked': (value: boolean) => (row.nullable = !value)
          })
        ]
      )
  },
  {
    title: '默认值',
    key: 'defaultValue',
    width: 100,
    minWidth: 72,
    resizable: true,
    render: (row) =>
      editingCell(row.key, 'defaultValue')
        ? editShell(
            h(NInput, {
              size: 'small',
              value: row.defaultValue ?? '',
              placeholder: 'NULL',
              onVnodeMounted: focusInput,
              onBlur: endEdit,
              onUpdateValue: (value: string) => (row.defaultValue = value === '' ? null : value)
            })
          )
        : textCell(row.key, 'defaultValue', row.defaultValue ?? 'NULL', 'field', row.defaultValue === null)
  },
  {
    title: '主键',
    key: 'primary',
    width: 56,
    minWidth: 56,
    resizable: true,
    render: (row) =>
      h(
        'div',
        { class: 'cell-hit center', onClick: (event: MouseEvent) => event.stopPropagation() },
        [
          h(NCheckbox, {
            checked: row.primary,
            disabled: viewOnly.value,
            'onUpdate:checked': (value: boolean) => (row.primary = value)
          })
        ]
      )
  },
  {
    title: '注释',
    key: 'comment',
    minWidth: 120,
    resizable: true,
    render: (row) =>
      editingCell(row.key, 'comment')
        ? editShell(
            h(NInput, {
              size: 'small',
              value: row.comment,
              onVnodeMounted: focusInput,
              onBlur: endEdit,
              onUpdateValue: (value: string) => (row.comment = value)
            })
          )
        : textCell(row.key, 'comment', row.comment, 'field')
  }
])

const indexColumns = computed<DataTableColumns<IndexDraft>>(() => [
  {
    title: '索引名',
    key: 'name',
    width: 180,
    minWidth: 80,
    resizable: true,
    render: (row) =>
      editingCell(row.key, 'name')
        ? editShell(
            h(NInput, {
              size: 'small',
              value: row.name,
              onVnodeMounted: focusInput,
              onBlur: endEdit,
              onUpdateValue: (value: string) => (row.name = value)
            })
          )
        : textCell(row.key, 'name', row.name, 'index')
  },
  {
    title: '字段',
    key: 'columns',
    width: 240,
    minWidth: 100,
    resizable: true,
    render: (row) =>
      editingCell(row.key, 'columns')
        ? editShell(
            h(NSelect, {
              size: 'small',
              multiple: true,
              value: row.columns,
              options: fieldNames.value,
              onUpdateValue: (value: string[]) => (row.columns = value)
            })
          )
        : textCell(row.key, 'columns', row.columns.join(', '), 'index')
  },
  {
    title: '唯一',
    key: 'unique',
    width: 70,
    minWidth: 48,
    resizable: true,
    render: (row) =>
      h(
        'div',
        { class: 'cell-hit center', onClick: (event: MouseEvent) => event.stopPropagation() },
        [
          h(NCheckbox, {
            checked: row.unique,
            disabled: viewOnly.value,
            'onUpdate:checked': (value: boolean) => (row.unique = value)
          })
        ]
      )
  }
])

function backToQuery(): void {
  if (!dirty.value) {
    ui.module = 'query'
    return
  }
  dialog.warning({
    title: '放弃修改',
    content: '表结构已修改，离开后将丢弃。',
    positiveText: '离开',
    negativeText: '留下',
    onPositiveClick: () => {
      ui.module = 'query'
    }
  })
}

function queryData(): void {
  const sql = `SELECT * FROM \`${conn.currentDb}\`.\`${tableName.value}\` LIMIT 200;`
  qs.newTab(sql, true)
  ui.module = 'query'
}

async function copyTableName(): Promise<void> {
  await navigator.clipboard.writeText(tableName.value)
  message.success('已复制表名')
}

async function copyDdl(): Promise<void> {
  if (!detail.value) return
  await navigator.clipboard.writeText(detail.value.ddl)
  message.success('已复制 DDL')
}

async function exportDdl(): Promise<void> {
  if (!detail.value) return
  const path = await api().file.saveText(`${tableName.value}.sql`, `${detail.value.ddl};\n`)
  if (path) message.success(`已导出：${path}`)
}

function save(): void {
  if (saving.value) return
  const built = buildAlterSql(
    conn.currentDb,
    tableName.value,
    fields.value,
    indexes.value,
    baselineFields,
    baselineIndexes
  )
  if (built.error) {
    message.error(built.error)
    return
  }
  if (!built.sql) {
    message.info('没有修改')
    return
  }
  dialog.warning({
    title: '保存表结构',
    style: { width: '640px' },
    content: () =>
      h(
        'pre',
        {
          style:
            'margin:0;max-height:320px;overflow:auto;white-space:pre-wrap;font-family:Consolas,monospace;font-size:12px'
        },
        built.sql
      ),
    positiveText: '执行',
    negativeText: '取消',
    onPositiveClick: async () => {
      if (saving.value) return false
      saving.value = true
      try {
        const resp = await api().query.run(conn.activeId, built.sql, {
          database: conn.currentDb,
          readonly: false,
          maxRows: 1,
          timeoutMs: 60000,
          confirmed: true
        })
        if (!resp.ok) {
          message.error(resp.error?.message || resp.blocked || '保存失败')
          return
        }
        message.success('已保存')
        await loadDetail(tableName.value)
      } finally {
        saving.value = false
      }
    }
  })
}
</script>

<template>
  <div class="structure-view">
    <div class="view-header">
      <NButton size="small" type="primary" @click="backToQuery">返回查询</NButton>
      <span class="conn-text">{{ conn.statusText }}</span>
      <NTag v-if="conn.currentDb" size="small" :bordered="false">{{ conn.currentDb }}</NTag>
      <span v-if="tableName" class="detail-title">{{ tableName }}</span>
      <NTag v-if="viewOnly" size="small" type="warning" :bordered="false">视图只读</NTag>
      <span style="flex: 1" />
      <NSpace v-if="detail" :size="8">
        <NButton v-if="!viewOnly" size="small" type="primary" :disabled="!dirty || saving" @click="save">保存</NButton>
        <NButton size="small" secondary @click="queryData">查询数据</NButton>
        <NButton size="small" secondary @click="copyTableName">复制表名</NButton>
        <NButton size="small" secondary type="primary" @click="exportDdl">导出结构</NButton>
      </NSpace>
    </div>
    <div v-if="detail" class="meta-row">
      <div class="detail-comment">{{ detail.stats.comment ? `表说明：${detail.stats.comment}` : '' }}</div>
      <NSpace :size="8">
        <NTag size="small" :bordered="false">记录数 {{ detail.stats.rows }}</NTag>
        <NTag size="small" :bordered="false">表大小 {{ detail.stats.dataSizeMb }} MB</NTag>
        <NTag size="small" :bordered="false">字符集 {{ detail.stats.collation || '-' }}</NTag>
        <NTag size="small" :bordered="false">引擎 {{ detail.stats.engine || '-' }}</NTag>
      </NSpace>
    </div>

    <div v-if="!conn.connected" class="not-connected">
      <NEmpty description="请先在顶栏选择并打开一个连接" />
    </div>
    <div v-else-if="detailLoading" class="not-connected">
      <NSpin size="small">加载中…</NSpin>
    </div>
    <div v-else-if="!detail" class="not-connected">
      <NEmpty description="在连接树右键表，选择「编辑表结构」" />
    </div>

    <div v-else class="view-body">
      <NTabs type="line" size="small" :animated="false" class="detail-tabs">
        <NTabPane name="columns" :tab="`字段（${fields.length}）`">
          <div class="pane">
            <div v-if="!viewOnly" class="pane-tools">
              <NButton size="tiny" @click="addField()">添加</NButton>
              <NButton size="tiny" @click="addField(fieldIndex())">插入</NButton>
              <NButton size="tiny" :disabled="fieldIndex() < 0" @click="removeField">删除</NButton>
              <NButton size="tiny" :disabled="fieldIndex() <= 0" @click="moveField(-1)">上移</NButton>
              <NButton size="tiny" :disabled="fieldIndex() < 0 || fieldIndex() >= fields.length - 1" @click="moveField(1)">
                下移
              </NButton>
            </div>
            <NDataTable
              :columns="fieldColumns"
              :data="fields"
              :row-key="(row: FieldDraft) => row.key"
              size="small"
              flex-height
              class="selectable pane-table"
              :row-class-name="(row: FieldDraft) => (row.key === selectedField ? 'selected-row' : '')"
              :row-props="(row: FieldDraft) => ({ onClick: () => (selectedField = row.key) })"
            />
          </div>
        </NTabPane>
        <NTabPane name="indexes" :tab="`索引（${indexes.length}）`">
          <div class="pane">
            <div v-if="!viewOnly" class="pane-tools">
              <NButton size="tiny" @click="addIndex">添加</NButton>
              <NButton size="tiny" :disabled="!selectedIndex" @click="removeIndex">删除</NButton>
            </div>
            <NDataTable
              :columns="indexColumns"
              :data="indexes"
              :row-key="(row: IndexDraft) => row.key"
              size="small"
              flex-height
              class="selectable pane-table"
              :row-class-name="(row: IndexDraft) => (row.key === selectedIndex ? 'selected-row' : '')"
              :row-props="(row: IndexDraft) => ({ onClick: () => (selectedIndex = row.key) })"
            />
          </div>
        </NTabPane>
        <NTabPane name="ddl" tab="DDL 预览">
          <div class="ddl-pane">
            <NButton size="tiny" secondary class="ddl-copy" @click="copyDdl">复制 DDL</NButton>
            <pre class="ddl-text selectable">{{ detail.ddl }}</pre>
          </div>
        </NTabPane>
      </NTabs>
    </div>
    <div v-if="saving" class="save-mask">
      <NSpin size="small">执行中…</NSpin>
    </div>
  </div>
</template>

<style scoped>
.structure-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 8px 12px;
  box-sizing: border-box;
}

.save-mask {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
}

.view-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 6px;
  flex-shrink: 0;
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  flex-shrink: 0;
  min-height: 24px;
}

.conn-text,
.detail-title {
  font-weight: 600;
}

.not-connected {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.view-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.detail-comment {
  flex: 1;
  min-width: 0;
  color: #909399;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.detail-tabs :deep(.n-tabs-pane-wrapper) {
  flex: 1;
  min-height: 0;
}

.detail-tabs :deep(.n-tab-pane) {
  height: 100%;
}

.pane {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.pane-tools {
  display: flex;
  gap: 6px;
  padding-bottom: 6px;
  flex-shrink: 0;
}

.pane-table {
  flex: 1;
  min-height: 0;
}

/* 与结果网格同一套线色；格子内容由 render 画出，样式必须 :deep */
.pane-table :deep(.n-data-table-th),
.pane-table :deep(.n-data-table-td) {
  border-right: 1px solid #e4e7ed;
  border-bottom: 1px solid #e4e7ed;
  line-height: 1.2;
  padding: 0;
}

.pane-table :deep(.n-data-table-th) {
  background: #fafafa;
  color: #606266;
  font-weight: 600;
  white-space: nowrap;
}

.pane-table :deep(.n-data-table-th .n-data-table-th__title) {
  padding: 8px 10px;
  white-space: nowrap;
}

.pane-table :deep(.n-data-table-table) {
  width: 100%;
}

.pane-table :deep(.n-data-table-td.n-data-table-td--last-row) {
  border-bottom: 1px solid #e4e7ed;
}

.pane-table :deep(.selected-row td) {
  background: #e8f1ff !important;
}

.pane-table :deep(.cell-hit) {
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 6px 10px;
  box-sizing: border-box;
  width: 100%;
  cursor: cell;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pane-table :deep(.cell-hit.center) {
  justify-content: center;
  cursor: default;
}

.pane-table :deep(.cell-hit.muted) {
  color: #c0c4cc;
  font-style: italic;
}

.pane-table :deep(.cell-edit) {
  min-height: 32px;
  display: flex;
  align-items: center;
  padding: 2px 4px;
  box-sizing: border-box;
  width: 100%;
}

.pane-table :deep(.cell-edit .n-input),
.pane-table :deep(.cell-edit .n-base-selection) {
  --n-height: 26px !important;
}

.ddl-pane {
  height: 100%;
  position: relative;
  overflow: auto;
  background: #fafafa;
  border: 1px solid #efeff5;
  border-radius: 4px;
}

.ddl-copy {
  position: absolute;
  top: 8px;
  right: 8px;
}

.ddl-text {
  margin: 0;
  padding: 12px;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
