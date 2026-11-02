import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WorkspaceState, WorkspaceTab } from '../../src/types'

/** 单个选项卡 SQL 上限，大于启动时的加载提示阈值，避免同意加载后存不回去 */
const MAX_SQL = 20 * 1024 * 1024
const MAX_TABS = 100

function workspaceFile(): string {
  return join(app.getPath('userData'), 'workspace.json')
}

export function loadWorkspace(): WorkspaceState {
  const file = workspaceFile()
  if (!existsSync(file)) return { activeTabId: '', tabs: [] }
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8')) as WorkspaceState
    const tabs = Array.isArray(data?.tabs) ? data.tabs.flatMap(normalizeTab) : []
    const activeTabId = tabs.some((t) => t.id === data?.activeTabId) ? data.activeTabId : (tabs[0]?.id ?? '')
    return { activeTabId, tabs, resultHeight: normalizeResultHeight(data?.resultHeight) }
  } catch {
    return { activeTabId: '', tabs: [] }
  }
}

export function saveWorkspace(state: WorkspaceState): void {
  const tabs = state.tabs.slice(0, MAX_TABS).flatMap(normalizeTab)
  const activeTabId = tabs.some((t) => t.id === state.activeTabId) ? state.activeTabId : (tabs[0]?.id ?? '')
  const file = workspaceFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({ activeTabId, tabs, resultHeight: normalizeResultHeight(state.resultHeight) ?? 540 }),
    'utf-8'
  )
}

function normalizeResultHeight(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const n = Math.round(v)
  if (n < 160 || n > 4000) return undefined
  return n
}

function normalizeTab(raw: unknown): WorkspaceTab[] {
  const tab = raw as WorkspaceTab
  if (!tab || typeof tab.id !== 'string' || typeof tab.title !== 'string' || typeof tab.sql !== 'string') {
    return []
  }
  if (!tab.id || tab.id.length > 80 || tab.sql.length > MAX_SQL) return []
  return [{ id: tab.id, title: tab.title.slice(0, 200) || '查询.sql', sql: tab.sql }]
}
