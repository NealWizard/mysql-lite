import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { closeAllPools } from '../services/connection'

/**
 * 主进程入口：窗口生命周期 + IPC 注册。
 * 安全边界：contextIsolation 开启、NodeIntegration 关闭，
 * Renderer 无 Node 权限，仅能通过 preload 暴露的白名单 API 访问能力。
 * 注：sandbox 保持 false（electron-vite 官方模板默认），安全边界由
 * contextIsolation + 白名单 IPC 提供；sandbox 模式下 preload 桥接注入不稳定。
 */

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'MySQL Lite',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 关掉 Ctrl+R / Ctrl+Shift+R，避免查询中误刷新整窗
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'r') {
      event.preventDefault()
    }
  })

  // preload 加载失败时输出主进程日志
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[mysql-lite] preload-error:', preloadPath, error.message)
  })

  // 桥接看门狗：Electron 偶发不执行 preload（无报错），导致桥接缺失。
  // 页面加载完成后主进程直接在主世界探测桥接，缺失则重载页面自愈（最多 3 次）。
  let bridgeRetries = 0
  mainWindow.webContents.on('did-finish-load', () => {
    void (async () => {
      const wc = mainWindow?.webContents
      if (!wc || wc.isDestroyed()) return
      const bridgeType = await wc
        .executeJavaScript('typeof window.mysqlLite')
        .catch(() => 'error')
      if (bridgeType === 'object') {
        bridgeRetries = 0
        return
      }
      if (bridgeRetries < 3) {
        bridgeRetries++
        console.warn(`[mysql-lite] 桥接未注入，重载页面（第 ${bridgeRetries} 次）`)
        wc.reload()
      } else {
        console.error('[mysql-lite] 桥接多次注入失败，请重启应用')
      }
    })()
  })

  // electron-vite 开发环境注入渲染页 URL；生产环境加载构建产物
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 自检模式：MYSQL_LITE_SELFTEST=1 时不创建窗口，直接跑端到端自检并退出
if (process.env.MYSQL_LITE_SELFTEST === '1') {
  app.whenReady().then(() => {
    void import('./selftest').then((m) => m.runSelftest(app))
  })
} else {
  app.whenReady().then(() => {
    // 去掉默认菜单，否则 Ctrl+Z / Ctrl+F 等会被菜单截走，到不了编辑器
    Menu.setApplicationMenu(null)
    registerIpc(() => mainWindow)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  void closeAllPools()
})
