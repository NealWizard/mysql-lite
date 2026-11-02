<script setup lang="ts">
/**
 * 应用根组件：Naive UI 全局提供者（中文语言包、消息/对话框上下文）。
 * 主题：主色按原型图定为蓝色系（执行类按钮），红色仅用于 logo 与只读开关。
 */
import { NConfigProvider, NDialogProvider, NMessageProvider, dateZhCN, zhCN } from 'naive-ui'
import AppShell from './components/AppShell.vue'

const themeOverrides = {
  common: {
    primaryColor: '#2f6bff',
    primaryColorHover: '#5a8dff',
    primaryColorPressed: '#1f53d6',
    primaryColorSuppl: '#2f6bff',
    scrollbarWidth: '12px',
    scrollbarHeight: '12px',
    scrollbarBorderRadius: '6px'
  }
}
</script>

<template>
  <NConfigProvider :locale="zhCN" :date-locale="dateZhCN" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <NDialogProvider>
        <AppShell />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
