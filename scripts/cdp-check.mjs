/**
 * CDP 界面诊断：通过 --remote-debugging-port 驱动真实渲染界面。
 * 流程：播种连接配置 → 重载 → 点「连接」→ 表结构页选表 → 「查询数据」
 * → 等待结果渲染 → 输出布局实测数据 + 截图，结束后清理播种配置。
 * 用法：先带 ELECTRON_CLI_ARGS=--remote-debugging-port=9222 启动 dev，再 node scripts/cdp-check.mjs
 */
import { writeFileSync } from 'node:fs'

const CDP_PORT = 9222
const SHOT_PATH = process.env.SHOT_PATH ?? 'C:/temp/ui-check.png'

// ---------- CDP 基础 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getPageWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.includes('localhost:5173'))
      if (page) return page.webSocketDebuggerUrl
    } catch { /* dev server 未就绪 */ }
    await sleep(1000)
  }
  throw new Error('找不到渲染进程 CDP 目标')
}

let msgId = 0
const pending = new Map()
let ws

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/** 在页面主世界执行表达式并返回其值（可 await Promise） */
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.exceptionDetails) throw new Error(`页面执行出错: ${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)}`)
  return r.result?.value
}

/** 轮询直到表达式返回真值 */
async function waitFor(expression, timeoutMs = 20000, label = expression) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evaluate(expression)) return
    } catch { /* 页面可能在重载 */ }
    await sleep(400)
  }
  throw new Error(`等待超时: ${label}`)
}

// ---------- 诊断主流程 ----------
async function main() {
  ws = new WebSocket(await getPageWsUrl())
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
  }
  await send('Page.enable')

  // 1. 等桥接就绪，播种连接配置（密码经主进程 safeStorage 加密）
  await waitFor(`typeof window.mysqlLite === 'object'`, 30000, '桥接就绪')
  await evaluate(`window.mysqlLite.connections.save(
    { id: 'ui-check', name: '本地测试库', host: '127.0.0.1', port: 33066,
      username: 'root', defaultDatabase: 'test', charset: 'utf8mb4', timeout: 10 }, 'root')`)
  console.log('已播种连接配置')

  // 2. 重载后展开「本地测试库」（展开即连接）
  await evaluate(`location.reload()`)
  await sleep(1500)
  await waitFor(`typeof window.mysqlLite === 'object'`, 30000, '重载后桥接就绪')
  await waitFor(`[...document.querySelectorAll('.n-tree-node-content__text')].some(e => e.textContent.includes('本地测试库'))`, 15000, '连接树出现')
  await evaluate(`(() => {
    const node = [...document.querySelectorAll('.n-tree-node')].find(n => n.querySelector('.n-tree-node-content__text')?.textContent.includes('本地测试库'))
    node.querySelector('.n-tree-node-switcher').click()
  })()`)
  await waitFor(`document.querySelector('.statusbar')?.textContent.includes('已连接')`, 15000, '连接成功')
  console.log('已连接测试库')

  // 3. 展开 test 库，双击第一张表查询
  await waitFor(`[...document.querySelectorAll('.n-tree-node-content__text')].some(e => e.textContent.trim() === 'test')`, 15000, '库节点出现')
  await evaluate(`(() => {
    const node = [...document.querySelectorAll('.n-tree-node')].find(n => n.querySelector(':scope > .n-tree-node-content .n-tree-node-content__text')?.textContent.trim() === 'test')
    node.querySelector('.n-tree-node-switcher').click()
  })()`)
  await sleep(1500)
  const tableCount = await evaluate(`[...document.querySelectorAll('.n-tree-node-content__text')].filter(e => e.textContent && !['test','information_schema','mysql','performance_schema','sys'].includes(e.textContent.trim()) && !e.textContent.includes('本地测试库')).length`)
  console.log(`树中可见表节点约: ${tableCount}`)
  await evaluate(`(() => {
    const names = [...document.querySelectorAll('.n-tree-node-content__text')]
    const table = names.find(e => e.textContent.trim() && !['test','information_schema','mysql','performance_schema','sys'].includes(e.textContent.trim()) && !e.textContent.includes('本地测试库'))
    table.closest('.n-tree-node-content').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })()`)
  await waitFor(`document.querySelector('.result-grid') !== null || document.querySelector('.n-alert') !== null`, 20000, '结果区出现')
  await sleep(1200)

  // 5. 采集布局实测数据
  const metrics = await evaluate(`JSON.stringify((() => {
    const q = (s) => { const el = document.querySelector(s); if (!el) return null
      const r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) }
    return {
      app: q('#app'), shell: q('.shell'), body: q('.body'), workspace: q('.workspace'),
      queryWorkspace: q('.query-workspace'), editorTabs: q('.editor-tabs'),
      paneWrapper: q('.editor-tabs .n-tabs-pane-wrapper'), tabPane: q('.editor-tabs .n-tab-pane'),
      editorBox: q('.editor-box'), monaco: q('.sql-editor'), resultArea: q('.result-area'),
      resultTabs: q('.result-tabs'), resultGrid: q('.result-grid'),
      gridTable: q('.grid-table'), gridTableEl: q('.grid-table .n-data-table'),
      gridThead: q('.grid-table thead'), gridTbody: q('.grid-table tbody'),
      headerCells: document.querySelectorAll('.grid-table thead th').length,
      headerComments: [...document.querySelectorAll('.grid-table thead .col-comment')].map(e => e.textContent),
      bodyRows: document.querySelectorAll('.grid-table tbody tr').length,
      metaText: document.querySelector('.result-meta')?.textContent ?? null,
      paginationText: document.querySelector('.n-pagination')?.textContent?.slice(0, 80) ?? null,
      emptyText: document.querySelector('.grid-table .n-data-table-empty')?.textContent ?? null,
      resultError: document.querySelector('.result-error')?.textContent?.slice(0, 200) ?? null,
      viewport: innerWidth + 'x' + innerHeight
    }
  })())`)
  console.log('=== 布局实测 ===')
  console.log(JSON.stringify(JSON.parse(metrics), null, 2))

  // 6. 截图
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'))
  console.log(`截图已保存: ${SHOT_PATH}`)

  // 7. 清理播种配置
  await evaluate(`window.mysqlLite.connections.remove('ui-check')`)
  console.log('已清理播种配置')
  ws.close()
}

main().catch((e) => { console.error('诊断失败:', e.message); process.exit(1) })
