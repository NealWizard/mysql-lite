<script setup lang="ts">
/**
 * Monaco SQL 编辑器封装。
 * - MySQL 语法高亮（monaco 内置 sql 语言包，仅需 editor.worker）
 * - 补全当前库的表、视图和列；写了其他库名后再补那个库
 * - Ctrl+Enter 触发执行；右键菜单「执行(ctrl+enter)」走同一条路径；Ctrl+D 复制当前行
 * - 撤销、重做、剪贴板、全选、查找替换、行注释、移动行使用编辑器默认键
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as monaco from 'monaco-editor/editor/editor.api'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/comment/browser/comment.js'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'
import 'monaco-editor/languages/definitions/mysql/register'
import { registerSqlSuggest } from '../services/sqlSuggest'
import { statementAtOffset } from '../utils/sql'

self.MonacoEnvironment = { getWorker: () => new editorWorker() }

// Ctrl+D 改为复制当前行。未选用的默认键卸掉，避免和这次确认的范围不一致。
monaco.editor.addKeybindingRules([
  {
    keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD,
    command: '-editor.action.addSelectionToNextFindMatch'
  },
  {
    keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD,
    command: 'editor.action.copyLinesDownAction',
    when: 'editorTextFocus && !editorReadonly'
  },
  {
    keybinding: monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyA,
    command: '-editor.action.blockComment'
  },
  {
    keybinding: monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.UpArrow,
    command: '-editor.action.copyLinesUpAction'
  },
  {
    keybinding: monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.DownArrow,
    command: '-editor.action.copyLinesDownAction'
  },
  {
    keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyK,
    command: '-editor.action.deleteLines'
  },
  {
    keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG,
    command: '-editor.action.gotoLine'
  },
  {
    keybinding: monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
    command: '-editor.action.formatDocument'
  }
])

const props = defineProps<{ tabId: string; modelValue: string; openTabIds: string[] }>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  execute: []
  cursor: [line: number, column: number]
}>()

const container = ref<HTMLElement>()
const menuEl = ref<HTMLElement>()
const menu = ref<{ x: number; y: number } | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let suggestDispose: monaco.IDisposable | null = null
/** 每个选项卡一份文档，切换时只换文档，撤销记录留在文档上 */
const models = new Map<string, monaco.editor.ITextModel>()

function modelFor(id: string, value: string): monaco.editor.ITextModel {
  let model = models.get(id)
  if (!model || model.isDisposed()) {
    model = monaco.editor.createModel(value, 'mysql')
    models.set(id, model)
  }
  return model
}

function showTab(id: string, value: string): void {
  if (!editor) return
  const model = modelFor(id, value)
  if (editor.getModel() !== model) editor.setModel(model)
  if (model.getValue() !== value) model.setValue(value)
}

onMounted(() => {
  suggestDispose = registerSqlSuggest()
  window.addEventListener('mousedown', onDocDown)
  window.addEventListener('keydown', onDocKey)
  window.addEventListener('blur', closeMenu)
  monaco.editor.defineTheme('mysql-lite', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      // 行号与语句之间不画高亮边框
      'editor.lineHighlightBorder': '#00000000'
    }
  })
  editor = monaco.editor.create(container.value!, {
    model: modelFor(props.tabId, props.modelValue),
    theme: 'mysql-lite',
    fontSize: 13,
    minimap: { enabled: false },
    automaticLayout: true,
    tabSize: 2,
    wordWrap: 'on',
    scrollBeyondLastLine: false,
    wordBasedSuggestions: 'off',
    quickSuggestions: { other: true, comments: false, strings: false },
    suggestOnTriggerCharacters: true,
    fixedOverflowWidgets: true,
    renderLineHighlight: 'line',
    contextmenu: false,
    folding: false,
    glyphMargin: false,
    // 保留行号与语句之间的空隙，竖线由主题和样式去掉
    lineDecorationsWidth: 16,
    lineNumbersMinChars: 3
  })

  editor.onDidChangeModelContent(() => {
    emit('update:modelValue', editor?.getValue() ?? '')
  })

  editor.onDidChangeCursorPosition((e) => {
    emit('cursor', e.position.lineNumber, e.position.column)
  })

  // Ctrl+Enter 与右键「执行(ctrl+enter)」都交给工作台：有选中执行选中，否则执行光标所在语句
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => emit('execute'))
  editor.onContextMenu((e) => {
    e.event.preventDefault()
    const ev = e.event.browserEvent
    const maxX = window.innerWidth - 168
    const maxY = window.innerHeight - 40
    menu.value = {
      x: Math.max(4, Math.min(ev.clientX, maxX)),
      y: Math.max(4, Math.min(ev.clientY, maxY))
    }
  })
  editor.onDidScrollChange(() => {
    menu.value = null
  })
})

function closeMenu(): void {
  menu.value = null
}

function onDocDown(ev: MouseEvent): void {
  if (!menu.value) return
  const target = ev.target
  if (target instanceof Node && menuEl.value?.contains(target)) return
  closeMenu()
}

function onDocKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') closeMenu()
}

function runFromMenu(): void {
  closeMenu()
  emit('execute')
}

watch(
  () => props.tabId,
  (id) => showTab(id, props.modelValue)
)

watch(
  () => props.modelValue,
  (value) => {
    const model = models.get(props.tabId)
    if (model && model.getValue() !== value) model.setValue(value)
  }
)

watch(
  () => props.openTabIds.join('\0'),
  () => {
    const keep = new Set(props.openTabIds)
    for (const [id, model] of models) {
      if (keep.has(id)) continue
      if (editor?.getModel() === model) editor.setModel(null)
      model.dispose()
      models.delete(id)
    }
  }
)

onBeforeUnmount(() => {
  suggestDispose?.dispose()
  suggestDispose = null
  window.removeEventListener('mousedown', onDocDown)
  window.removeEventListener('keydown', onDocKey)
  window.removeEventListener('blur', closeMenu)
  editor?.dispose()
  editor = null
  for (const model of models.values()) model.dispose()
  models.clear()
})

/** 选中文本（无选中返回空串） */
function getSelectedText(): string {
  if (!editor) return ''
  const selection = editor.getSelection()
  const model = editor.getModel()
  if (!selection || !model || selection.isEmpty()) return ''
  return model.getValueInRange(selection)
}

/** 光标所在语句 */
function getCursorStatement(): string {
  if (!editor) return ''
  const model = editor.getModel()
  const position = editor.getPosition()
  if (!model || !position) return ''
  return statementAtOffset(model.getValue(), model.getOffsetAt(position))
}

defineExpose({ getSelectedText, getCursorStatement })
</script>

<template>
  <div ref="container" class="sql-editor" @contextmenu.prevent></div>
  <Teleport to="body">
    <div
      v-if="menu"
      ref="menuEl"
      class="editor-menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @mousedown.stop
      @contextmenu.prevent
    >
      <button type="button" @click="runFromMenu">执行(ctrl+enter)</button>
    </div>
  </Teleport>
</template>

<style scoped>
.sql-editor {
  width: 100%;
  height: 100%;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  overflow: hidden;
}

/* 当前行高亮默认带左右边框，贴在行号右侧会看起来像分隔线 */
.sql-editor :deep(.current-line) {
  border: none !important;
}

.editor-menu {
  position: fixed;
  z-index: 4000;
  min-width: 148px;
  padding: 4px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}

.editor-menu button {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  padding: 6px 10px;
  font-size: 13px;
  color: #262626;
  cursor: pointer;
  border-radius: 4px;
}

.editor-menu button:hover {
  background: #f2f6ff;
  color: #2f6bff;
}
</style>
