import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { getDb, closeDb } from './db'
import { registerIpcHandlers } from './ipc/handlers'
import { runnerService } from './services/runner.service'
import { runtimeService } from './services/runtime.service'
import { serviceManager } from './services/service-manager.service'

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'Project Hub',
    backgroundColor: '#0b0f1a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 11 },
    ...(process.platform !== 'darwin'
      ? { titleBarOverlay: { color: '#0b0f1a', symbolColor: '#e6e9f2', height: 36 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.anpy.projecthub')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  getDb()
  registerIpcHandlers()
  runtimeService.scan()
  serviceManager.autostart()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  runnerService.cleanupAll()
  serviceManager.cleanupAll()
  closeDb()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
