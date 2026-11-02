import { defineStore } from 'pinia'
import type { ExecuteError, ResultSet, WorkspaceTab } from '../types'

/**
 * SQL 工作台状态：编辑器多标签、各标签的执行结果。
 * 每个标签独立保存 SQL 文本与结果集（对应原型结果区多标签）。
 */

export interface EditorTab {
  id: string
  title: string
  sql: string
  running: boolean
  sets: ResultSet[]
  error: ExecuteError | null
  /** 执行计划（EXPLAIN）结果 */
  plan: ResultSet | null
  /** 新标签创建后请求自动执行（表结构管理「查询数据」入口） */
  autoRun: boolean
  /** 后台统计出的总行数；null 表示还没有或统计失败 */
  totalRows: number | null
  counting: boolean
  countToken: number
}

let seq = 0

export const useQueryStore = defineStore('query', {
  state: () => ({
    tabs: [] as EditorTab[],
    activeTabId: '' as string,
    /** 本次会话已执行的 SQL，供工具栏「历史」 */
    history: [] as string[]
  }),

  getters: {
    activeTab(state): EditorTab | undefined {
      return state.tabs.find((t) => t.id === state.activeTabId)
    }
  },

  actions: {
    newTab(sql = '', autoRun = false, title = ''): EditorTab {
      seq += 1
      const tab: EditorTab = {
        id: `tab-${Date.now()}-${seq}`,
        title: title || `查询 ${seq}.sql`,
        sql,
        running: false,
        sets: [],
        error: null,
        plan: null,
        autoRun,
        totalRows: null,
        counting: false,
        countToken: 0
      }
      this.tabs.push(tab)
      this.activeTabId = tab.id
      return tab
    },

    replaceTabs(tabs: WorkspaceTab[], activeTabId: string): void {
      this.tabs = tabs.map((t) => ({
        id: t.id,
        title: t.title,
        sql: t.sql,
        running: false,
        sets: [],
        error: null,
        plan: null,
        autoRun: false,
        totalRows: null,
        counting: false,
        countToken: 0
      }))
      seq = Math.max(seq, this.tabs.length)
      this.activeTabId = this.tabs.some((t) => t.id === activeTabId) ? activeTabId : (this.tabs[0]?.id ?? '')
    },

    ensureTab(): EditorTab {
      if (this.tabs.length === 0) return this.newTab()
      return this.activeTab ?? this.tabs[0]
    },

    closeTab(id: string): void {
      const idx = this.tabs.findIndex((t) => t.id === id)
      if (idx < 0) return
      this.tabs.splice(idx, 1)
      if (this.activeTabId === id) {
        this.activeTabId = this.tabs[Math.min(idx, this.tabs.length - 1)]?.id ?? ''
      }
      if (this.tabs.length === 0) this.newTab()
    },

    remember(sql: string): void {
      const text = sql.trim()
      if (!text) return
      this.history = [text, ...this.history.filter((s) => s !== text)].slice(0, 30)
    }
  }
})
