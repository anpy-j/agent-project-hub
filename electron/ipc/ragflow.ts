import { BrowserWindow, ipcMain } from 'electron'
import { ragflowService } from '../services/ragflow.service'
export function registerRagflowIpc(): void {
  for (const name of ['getConfig', 'saveConfig', 'test', 'documents', 'open'] as const) {
    ipcMain.handle(`ragflow:${name}`, (event, ...args) => {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('不允许的调用来源')
      return (ragflowService[name] as (...values: any[]) => unknown).apply(ragflowService, args)
    })
  }
}
