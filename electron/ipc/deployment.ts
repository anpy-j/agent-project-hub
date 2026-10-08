import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile } from 'fs/promises'
import type { IpcMainInvokeEvent } from 'electron'
import type { HostInput, RegistryInput, DeployConfig, RemoteAction, ReleaseAction } from '../../src/types/deployment'
import { deploymentStore as store } from '../services/deployment-store'
import { discoverFingerprint } from '../services/deployment-ssh'
import { hasActiveReleases, hostBusy, remoteAction, remoteSnapshot, saveDeployConfig, startRelease, testHost, testRegistry } from '../services/deployment.service'

function guard(event: IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('不允许的调用来源')
}
export function registerDeploymentIpc(): void {
  const handle = (name: string, fn: (...args: any[]) => unknown) => ipcMain.handle(`deployment:${name}`, (event, ...args) => { guard(event); return fn(...args) })
  handle('registries', () => store.registries())
  handle('saveRegistry', (input: RegistryInput) => { if (hasActiveReleases()) throw new Error('发布过程中不能修改仓库凭据'); return store.saveRegistry(input) })
  handle('removeRegistry', (id: string) => { if (hasActiveReleases()) throw new Error('请等待发布完成'); store.removeRegistry(id) })
  handle('testRegistry', testRegistry)
  handle('hosts', () => store.hosts())
  handle('saveHost', (input: HostInput) => { if (hostBusy(input.id)) throw new Error('服务器正在执行操作'); return store.saveHost(input) })
  handle('removeHost', (id: string) => { if (hostBusy(id)) throw new Error('服务器正在执行操作'); store.removeHost(id) })
  handle('fingerprint', discoverFingerprint)
  handle('testHost', testHost)
  handle('snapshot', remoteSnapshot)
  handle('remoteAction', remoteAction)
  handle('config', (id: string) => store.config(id))
  handle('saveConfig', (config: DeployConfig) => saveDeployConfig(config))
  handle('start', (projectId: string, action: ReleaseAction) => startRelease(projectId, action))
  handle('jobs', () => store.jobs())
  handle('pickPrivateKey', async () => {
    const result = await dialog.showOpenDialog({ title: '选择 SSH 私钥（仅保存在系统加密存储）', properties: ['openFile'] })
    if (result.canceled) return null
    const key = await readFile(result.filePaths[0], 'utf8')
    if (key.length > 65536 || !key.includes('PRIVATE KEY')) throw new Error('不是可识别的 SSH 私钥文件')
    return key
  })
  handle('importBridgebox', async () => {
    const result = await dialog.showOpenDialog({ title: '导入 Bridgebox 主机 JSON / shared_preferences.json', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
    if (result.canceled) return 0
    const text = await readFile(result.filePaths[0], 'utf8')
    if (text.length > 1024 * 1024) throw new Error('主机配置文件过大')
    const parsed = JSON.parse(text)
    const value = Array.isArray(parsed) ? parsed : parsed['bridgebox.hosts.v1'] ?? parsed['flutter.bridgebox.hosts.v1']
    const rows = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(rows)) throw new Error('未找到 Bridgebox 主机列表')
    let count = 0
    for (const row of rows) {
      if (store.hosts().some(h => h.host === row.host && h.port === row.port && h.username === row.username)) continue
      store.saveHost({ id: '', name: row.name, host: row.host, port: row.port, username: row.username, authKind: row.authKind, fingerprint: '' })
      count++
    }
    return count
  })
}
