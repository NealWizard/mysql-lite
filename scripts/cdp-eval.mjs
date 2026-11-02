/**
 * CDP 单行表达式求值工具：node scripts/cdp-eval.mjs "<expression>"
 * 在 5173 渲染页主世界执行并打印返回值（需 dev 带 --remote-debugging-port=9222 启动）。
 */
const expr = process.argv[2]
if (!expr) { console.error('用法: node scripts/cdp-eval.mjs "<expression>"'); process.exit(1) }

const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((t) => t.type === 'page' && t.url.includes('localhost:5173'))
if (!page) { console.error('找不到渲染页'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
const result = await new Promise((resolve, reject) => {
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id === 1) msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
  }
  ws.send(JSON.stringify({
    id: 1, method: 'Runtime.evaluate',
    params: { expression: expr, returnByValue: true, awaitPromise: true }
  }))
})
if (result.exceptionDetails) {
  console.error('页面执行出错:', result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  process.exit(1)
}
console.log(typeof result.result?.value === 'string' ? result.result.value : JSON.stringify(result.result?.value, null, 2))
ws.close()
