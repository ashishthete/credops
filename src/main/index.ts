import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { AuditLog } from './audit/audit-log'
import { openDatabase, type Db } from './db/connection'
import { windowOptions } from './window'

let mainWindow: BrowserWindow | null = null
let db: Db | null = null
let audit: AuditLog | null = null
let quitAudited = false

function createWindow(): void {
  const win = new BrowserWindow(windowOptions(join(__dirname, '../preload/index.js')))
  mainWindow = win

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    mainWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app
    .whenReady()
    .then(() => {
      db = openDatabase(join(app.getPath('userData'), 'opsdeck.db'))
      audit = new AuditLog(db)
      audit.append({ action: 'app.start', outcome: 'info', details: { version: app.getVersion() } })
      createWindow()
    })
    .catch((err) => {
      console.error('Startup failed:', err)
      app.quit()
    })

  app.on('before-quit', () => {
    if (!audit || quitAudited) return
    quitAudited = true
    try {
      audit.append({ action: 'app.quit', outcome: 'info' })
    } catch (err) {
      console.error('Failed to audit app.quit:', err)
    }
  })

  app.on('will-quit', () => {
    audit = null
    db?.close()
    db = null
  })

  // Quit on all platforms, including macOS (v1 simplicity).
  app.on('window-all-closed', () => app.quit())
}
