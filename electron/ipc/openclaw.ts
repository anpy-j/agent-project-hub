import { BrowserWindow, ipcMain } from 'electron'
import { openclawService } from '../services/openclaw.service'
export function registerOpenClawIpc(): void {
  for (const name of ['list', 'save', 'remove', 'discover', 'connections', 'connect', 'disconnect', 'request', 'service'] as const) {
    ipcMain.handle(`openclaw:${name}`, (event, ...args) => {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('不允许的调用来源')
      return (openclawService[name] as (...values: any[]) => unknown).apply(openclawService, args)
    })
  }
}
