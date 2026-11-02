import { defineStore } from 'pinia'

/**
 * 界面状态：当前工作模块、连接管理弹窗可见性。
 */
export const useUiStore = defineStore('ui', {
  state: () => ({
    /** 左侧栏：连接树 / 历史 / 设置 */
    rail: 'connect' as 'connect' | 'history' | 'settings',
    /** 左侧连接面板是否折叠 */
    sideCollapsed: false,
    /** 主工作区：查询编辑器或表结构 */
    module: 'query' as 'query' | 'structure',
    connectionManagerVisible: false,
    /** 空串表示新建；非空为正在编辑的连接 id */
    connectionEditId: '',
    /** 只读模式，默认开启 */
    readonly: true,
    cursorLine: 1,
    cursorCol: 1,
    /** 表结构页要定位的表（由连接树右键写入） */
    focusTable: ''
  })
})
