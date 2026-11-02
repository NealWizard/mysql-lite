/**
 * 环境模块声明（纯环境文件，不得包含顶层 import/export）。
 * monaco-editor 0.57 的 exports 映射仅为主入口提供类型；
 * 核心编辑器与 MySQL 语言注册的深导入路径在此补充声明。
 */
declare module 'monaco-editor/editor/editor.api' {
  export * from 'monaco-editor'
}

declare module 'monaco-editor/languages/definitions/mysql/register' {}
