import { app, BrowserWindow, shell, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { getDb, closeDb } from './db'
import { registerIpcHandlers } from './ipc/handlers'
import { runnerService } from './services/runner.service'
import { runtimeService } from './services/runtime.service'
import { serviceManager } from './services/service-manager.service'
import { runStartupMaintenance } from './services/maintenance.service'
import { registerDeploymentIpc } from './ipc/deployment'
import { hasActiveReleases } from './services/deployment.service'

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

  mainWindow.on('close', (event) => {
    if (hasActiveReleases()) {
      event.preventDefault()
      dialog.showMessageBoxSync(mainWindow, { type: 'info', message: '镜像发布正在执行，请等待完成后再关闭窗口。' })
    }
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
  runStartupMaintenance()
  registerIpcHandlers()
  registerDeploymentIpc()
  runtimeService.scan()
  serviceManager.autostart()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (event) => {
  if (hasActiveReleases()) {
    event.preventDefault()
    dialog.showMessageBoxSync({ type: 'info', message: '镜像发布正在执行，请等待完成后再退出。' })
    return
  }
  runnerService.cleanupAll()
  serviceManager.cleanupAll()
  closeDb()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
