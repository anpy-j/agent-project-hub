import { BrowserWindow, ipcMain } from 'electron'
import { libraryService } from '../services/library.service'
export function registerLibraryIpc(): void {
  for (const name of ['list', 'detail', 'capture', 'importFile', 'update', 'archive', 'process', 'supply', 'browse', 'refreshSync', 'source', 'ask', 'export'] as const) {
    ipcMain.handle(`library:${name}`, (event, ...args) => {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('不允许的调用来源')
      return (libraryService[name] as (...values: any[]) => unknown).apply(libraryService, args)
    })
  }
}
