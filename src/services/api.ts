/**
 * Renderer 侧 API 封装：统一访问 preload 暴露的 window.mysqlLite。
 * 若 API 不存在（如纯浏览器调试），抛出明确错误。
 */

export function api(): Window['mysqlLite'] {
  const bridge = window.mysqlLite
  if (!bridge) {
    throw new Error('mysqlLite 桥接不可用：请在 Electron 环境中运行')
  }
  return bridge
}
