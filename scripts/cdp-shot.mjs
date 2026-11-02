/**
 * CDP 截图工具：node scripts/cdp-shot.mjs <输出png路径> [点击按钮文本]
 * 可选先点击指定文本的按钮/菜单项，等待 1.5s 后截取当前页面。
 */
import { writeFileSync } from 'node:fs'

const [shotPath, clickText] = process.argv.slice(2)
if (!shotPath) { console.error('用法: node scripts/cdp-shot.mjs <png路径> [点击文本]'); process.exit(1) }

const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((t) => t.type === 'page' && t.url.includes('localhost:5173'))
if (!page) { console.error('找不到渲染页'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})

if (clickText) {
  await send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('.n-menu-item-content, button')].find(e => e.textContent.includes(${JSON.stringify(clickText)}))?.click()`,
    returnByValue: true
  })
  await new Promise((r) => setTimeout(r, 1500))
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
console.log(`截图已保存: ${shotPath}`)
ws.close()
