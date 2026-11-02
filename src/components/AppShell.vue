<script setup lang="ts">
/**
 * 主界面（严格对齐原型）：
 * 左图标栏（连接 / 历史 / 设置）+ 侧栏 + 查询或表结构 + 底栏状态。
 */
import { onMounted } from 'vue'
import { NEmpty, NSwitch } from 'naive-ui'
import QueryWorkspace from '../views/QueryWorkspace/index.vue'
import TableStructure from '../views/TableStructure/index.vue'
import ConnectionManager from '../views/ConnectionManager/index.vue'
import ConnectionTree from './ConnectionTree.vue'
import { useConnectionStore } from '../stores/connection'
import { useQueryStore } from '../stores/query'
import { useUiStore } from '../stores/ui'

const conn = useConnectionStore()
const qs = useQueryStore()
const ui = useUiStore()

const rails = [
  { key: 'connect' as const, label: '连接' },
  { key: 'history' as const, label: '历史' },
  { key: 'settings' as const, label: '设置' }
]

function onRail(key: 'connect' | 'history' | 'settings'): void {
  ui.rail = key
  ui.sideCollapsed = false
}

function toggleSide(): void {
  ui.sideCollapsed = !ui.sideCollapsed
}

function openHistory(sql: string): void {
  ui.module = 'query'
  ui.rail = 'connect'
  qs.newTab(sql, false)
}

onMounted(async () => {
  try {
    await conn.refresh()
  } catch {
    // 桥接未就绪时主进程看门狗会重载页面
  }
})
</script>

<template>
  <div class="shell">
    <div class="main">
      <nav class="rail">
        <button
          v-for="r in rails"
          :key="r.key"
          class="rail-btn"
          :class="{ active: ui.rail === r.key }"
          @click="onRail(r.key)"
        >
          <svg class="rail-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <path v-if="r.key === 'connect'" d="M4 7h16M4 12h16M4 17h10" stroke-linecap="round" />
            <path v-else-if="r.key === 'history'" d="M12 8v5l3 2M21 12a9 9 0 1 1-3-6.7L21 8" stroke-linecap="round" />
            <path v-else d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" stroke-linecap="round" />
          </svg>
          <span>{{ r.label }}</span>
        </button>
        <button class="rail-btn" :title="ui.sideCollapsed ? '展开侧栏' : '折叠侧栏'" @click="toggleSide">
          <svg class="rail-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <path
              v-if="ui.sideCollapsed"
              d="M4 5h16v14H4zM9 5v14M12 12h6M15 9l3 3-3 3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              v-else
              d="M4 5h16v14H4zM9 5v14M15 12H9M12 9l-3 3 3 3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span>{{ ui.sideCollapsed ? '展开' : '折叠' }}</span>
        </button>
      </nav>

      <aside v-show="!ui.sideCollapsed" class="side">
        <ConnectionTree v-show="ui.rail === 'connect'" />
        <div v-show="ui.rail === 'history'" class="side-pane">
          <div class="side-title">历史</div>
          <button v-for="(sql, i) in qs.history" :key="i" class="history-item" @click="openHistory(sql)">
            {{ sql.replace(/\s+/g, ' ').slice(0, 80) }}
          </button>
          <NEmpty v-if="qs.history.length === 0" description="执行过的 SQL 会出现在这里" style="margin-top: 40px" />
        </div>
        <div v-show="ui.rail === 'settings'" class="side-pane">
          <div class="side-title">设置</div>
          <div class="setting-row">
            <span>只读模式</span>
            <NSwitch v-model:value="ui.readonly" size="small" />
          </div>
          <p class="setting-tip">开启后仅允许 SELECT / SHOW / EXPLAIN / DESC。删除表等显式操作不受此开关限制，仍会二次确认。</p>
        </div>
      </aside>

      <section class="content">
        <QueryWorkspace v-show="ui.module === 'query'" />
        <TableStructure v-show="ui.module === 'structure'" />
      </section>
    </div>

    <footer class="statusbar">
      <span class="st-left">
        <i class="dot" :class="{ on: conn.connected }" />
        {{ conn.connected ? '已连接' : '未连接' }}
        <template v-if="conn.connected && conn.activeProfile">
          {{ conn.activeProfile.name }}（{{ conn.activeProfile.username }}）
          {{ conn.activeProfile.host }}:{{ conn.activeProfile.port }}
        </template>
      </span>
      <span class="st-right">
        行 {{ ui.cursorLine }}，列 {{ ui.cursorCol }}
        <span class="sep">{{ conn.activeProfile?.charset || 'utf8mb4' }}</span>
        <span class="sep">MySQL {{ conn.serverVersion || '' }}</span>
      </span>
    </footer>

    <ConnectionManager />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #fff;
}

.main {
  flex: 1;
  min-height: 0;
  display: flex;
  background: #f4f6f9;
}

.rail {
  width: 64px;
  flex-shrink: 0;
  border-right: 1px solid #eef0f3;
  background: #f7f9fc;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 8px;
  gap: 4px;
}

.rail-btn {
  width: 52px;
  border: none;
  background: transparent;
  border-radius: 8px;
  padding: 8px 0 6px;
  cursor: pointer;
  color: #8c8c8c;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 11px;
}

.rail-btn.active {
  background: #e8f1ff;
  color: #2f6bff;
}

.rail-ico {
  width: 18px;
  height: 18px;
}

.side {
  width: 280px;
  flex-shrink: 0;
  min-height: 0;
  margin: 8px 0 8px 8px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.side > :deep(.tree-pane),
.side > .side-pane {
  flex: 1;
  min-height: 0;
}

.side-pane {
  height: 100%;
  overflow: auto;
}

.side-title {
  padding: 12px 14px;
  font-weight: 600;
}

.history-item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 8px 14px;
  cursor: pointer;
  color: #434343;
  font-size: 12px;
  font-family: Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-item:hover {
  background: #f5f7fa;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 14px 8px;
}

.setting-tip {
  margin: 0;
  padding: 0 14px;
  color: #a8abb2;
  font-size: 12px;
  line-height: 1.6;
}

.content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.content > * {
  flex: 1;
  min-height: 0;
}

.statusbar {
  height: 28px;
  flex-shrink: 0;
  border-top: 1px solid #eef0f3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  font-size: 12px;
  color: #8c8c8c;
  background: #fafbfc;
}

.st-left,
.st-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d0d3d9;
}

.dot.on {
  background: #22c55e;
}

.sep {
  padding-left: 8px;
  border-left: 1px solid #e6e8eb;
}
</style>
