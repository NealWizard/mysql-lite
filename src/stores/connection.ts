import { defineStore } from 'pinia'
import { api } from '../services/api'
import type { ConnectionProfile } from '../types'

/**
 * 连接状态：配置列表、当前活动连接、数据库列表与当前库。
 */
export const useConnectionStore = defineStore('connection', {
  state: () => ({
    profiles: [] as ConnectionProfile[],
    activeId: '' as string,
    connected: false,
    connecting: false,
    serverVersion: '' as string,
    databases: [] as string[],
    currentDb: '' as string
  }),

  getters: {
    activeProfile(state): ConnectionProfile | undefined {
      return state.profiles.find((p) => p.id === state.activeId)
    },
    /** 连接树实际展示的库：未配置筛选时为全部 */
    shownDatabases(state): string[] {
      const keep = state.profiles.find((p) => p.id === state.activeId)?.visibleDatabases
      if (!keep) return state.databases
      const allow = new Set(keep)
      return state.databases.filter((d) => allow.has(d))
    },
    /** 顶栏连接状态展示文本 */
    statusText(state): string {
      if (!state.connected) return '未连接'
      const p = state.profiles.find((x) => x.id === state.activeId)
      return p ? `${p.name}（${p.host}:${p.port}）` : '已连接'
    }
  },

  actions: {
    async refresh(): Promise<void> {
      this.profiles = await api().connections.list()
    },

    async open(id: string): Promise<{ ok: boolean; error?: string }> {
      this.connecting = true
      try {
        const result = await api().connections.open(id)
        if (!result.ok) {
          return { ok: false, error: result.error }
        }
        this.activeId = id
        this.connected = true
        this.serverVersion = result.version ?? ''
        this.databases = result.databases ?? []
        // 优先使用配置的默认库
        const profile = this.profiles.find((p) => p.id === id)
        const shown = this.shownDatabases
        this.currentDb =
          profile?.defaultDatabase && shown.includes(profile.defaultDatabase)
            ? profile.defaultDatabase
            : (shown[0] ?? '')
        return { ok: true }
      } finally {
        this.connecting = false
      }
    },

    async disconnect(): Promise<void> {
      if (this.activeId) {
        await api().connections.close(this.activeId).catch(() => undefined)
      }
      this.connected = false
      this.activeId = ''
      this.serverVersion = ''
      this.databases = []
      this.currentDb = ''
    }
  }
})
