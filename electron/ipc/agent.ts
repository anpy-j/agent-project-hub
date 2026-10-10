import { BrowserWindow, ipcMain } from 'electron'
import { aiConfigRepo } from '../db/repositories'
import { aiService } from '../services/ai.service'
import { agentService } from '../services/agent.service'
import { parseAgentResponse } from '../services/agent-protocol'
import type { AiConfig } from '../../src/types'
export function registerAgentIpc(): void {
  const handle = (name: string, fn: (...args: any[]) => unknown) => ipcMain.handle(`agent:${name}`, (event, ...args) => {
    if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('不允许的调用来源')
    return fn(...args)
  })
  handle('getConfig', () => aiConfigRepo.get('agent'))
  handle('saveConfig', (cfg: AiConfig) => aiService.saveConfig(cfg, 'agent'))
  handle('test', async (cfg: AiConfig) => {
    const parsed = parseAgentResponse(await aiService.chat([{ role: 'user', content: '仅输出 JSON：{"action":{"tool":"project_info","args":{}}}，不要执行任何操作。' }], cfg, true))
    if (parsed.action?.tool !== 'project_info') throw new Error('模型连接成功，但未按要求返回工具请求，请尝试更换模型')
    return '连接正常，结构化工具请求格式可用'
  })
  handle('tasks', () => agentService.tasks())
  handle('start', input => agentService.start(input))
  handle('confirm', (id, approve) => { if (typeof approve !== 'boolean') throw new Error('确认参数不正确'); return agentService.confirm(id, approve) })
  handle('cancel', id => agentService.cancel(id))
}
