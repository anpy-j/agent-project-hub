import { app, BrowserWindow, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { aiConfigRepo, projectRepo } from '../electron/db/repositories'
import { getDb, closeDb } from '../electron/db'
import { saveBuildTargets } from '../electron/services/build-targets'
import { agentService } from '../electron/services/agent.service'
import { aiService } from '../electron/services/ai.service'
import { registerAgentIpc } from '../electron/ipc/agent'
const dir = process.env.PROJECT_HUB_AGENT_SMOKE_DIR!, root = process.env.PROJECT_HUB_AGENT_ROOT!
app.setPath('userData', dir); app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const prompts: any[] = [], replies: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      prompts.push(JSON.parse(body)); res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: replies.shift() || '{"reply":"完成"}' } }] }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const projectPath = join(dir, 'project'); mkdirSync(projectPath)
  const workspace = (getDb().prepare('SELECT id FROM workspace LIMIT 1').get() as { id: string }).id
  const project = projectRepo.insert({ id: 'agent-demo', name: 'Agent 测试项目', path: projectPath, type: 'node', workspace_id: workspace, framework: null, description: null })
  const target = { id: 'fixture', name: '本地测试产物', directory: '.', platform: 'any' as const, commands: ['node build.cjs'], artifactPaths: ['artifact.txt'] }
  writeFileSync(join(projectPath, 'build.cjs'), "require('fs').writeFileSync('artifact.txt', 'built'); console.log('BUILD_SUCCESS')")
  saveBuildTargets(project, [target])
  const cfg = { provider: 'custom' as const, base_url: `http://127.0.0.1:${address.port}/v1`, api_key: '', model: 'agent-fixture' }
  aiConfigRepo.save({ ...cfg, model: 'general-fixture' })
  aiConfigRepo.save(cfg, 'agent')
  assert.equal(aiConfigRepo.get().model, 'general-fixture')
  getDb().exec('CREATE TABLE IF NOT EXISTS agent_tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
  getDb().prepare('INSERT INTO agent_tasks VALUES (?, ?)').run('interrupted-fixture', JSON.stringify({ id: 'interrupted-fixture', context: {page:'/test'}, status: 'running', events: [], createdAt: new Date().toISOString() }))
  assert.equal(agentService.tasks().find(t => t.id === 'interrupted-fixture')?.status, 'interrupted')
  registerAgentIpc()
  ipcMain.handle('diskCleaner:getDrives', () => [])
  ipcMain.handle('ai:providers', () => aiService.providers())
  ipcMain.handle('ai:getConfig', () => aiConfigRepo.get())
  ipcMain.handle('ai:listModels', () => [])
  ipcMain.handle('gitAuth:snapshot', () => ({version:'test',username:'',email:'',helpers:[],keys:[],agentStatus:'',hosts:[],warnings:[]}))
  ipcMain.handle('runtime:list', () => [])
  ipcMain.handle('system:logUsage', () => ({files:0,bytes:0}))
  ipcMain.handle('workspace:list', () => [])
  ipcMain.handle('project:list', () => [project])
  ipcMain.handle('deployment:hosts', () => [])
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, offscreen: true, backgroundThrottling: false } })
  await win.loadFile(join(root, 'out/renderer/index.html'), { hash: '/disk-cleaner' })
  const evalUI = (code: string) => win.webContents.executeJavaScript(code, true)
  async function waitFor(check: () => boolean | Promise<boolean>) { const until = Date.now() + 15000; while (Date.now() < until) { if (await check()) return; await new Promise(r => setTimeout(r, 50)) } throw new Error('Timed out waiting for Agent state') }
  const task = (id: string) => agentService.tasks().find(t => t.id === id)!
  await waitFor(() => evalUI(`!!document.querySelector('.agent-fab')`))
  await evalUI(`document.querySelector('.agent-fab').click()`)
  await waitFor(() => evalUI(`!!document.querySelector('.agent-panel')`))
  await evalUI(`window.dispatchEvent(new CustomEvent('project-hub:agent-context', { detail: {projectId:'agent-demo',open:true,prompt:'构建测试产物'} }))`)
  replies.push('{"action":{"tool":"project_info","args":{}}}', '{"action":{"tool":"build","args":{"targetId":"fixture"}}}', '{"reply":"构建成功，产物 artifact.txt"}')
  await evalUI(`Array.from(document.querySelectorAll('.agent-compose-actions button')).find(b=>b.textContent.trim()==='发送').click()`)
  await waitFor(() => agentService.tasks()[0]?.status === 'awaiting_confirmation')
  const id = agentService.tasks()[0].id
  assert.equal(existsSync(join(projectPath, 'artifact.txt')), false)
  await waitFor(() => evalUI(`document.body.innerText.includes('确认执行')`))
  await evalUI(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='确认执行').click()`)
  // Closing the panel does not terminate a build.
  await evalUI(`document.querySelector('.global-agent-drawer .el-drawer__close-btn').click()`)
  await waitFor(() => task(id).status === 'success')
  assert.ok(existsSync(join(projectPath, 'artifact.txt')))
  assert.ok(task(id).events.some(e => e.text.includes('BUILD_SUCCESS')))
  assert.ok(prompts.every(p => p.model === 'agent-fixture'))
  // Refusing a write never executes it.
  replies.push('{"action":{"tool":"git_push","args":{}}}')
  const rejected = agentService.start({ context: { page: '/projects', projectId: project.id }, prompt: '上传代码' })
  await waitFor(() => task(rejected).status === 'awaiting_confirmation')
  agentService.confirm(rejected, false)
  assert.equal(task(rejected).status, 'cancelled')
  // Configuration changes invalidate pending approvals.
  replies.push('{"action":{"tool":"build","args":{"targetId":"fixture"}}}')
  const stale = agentService.start({ context: { page: '/projects', projectId: project.id }, prompt: '再次构建' })
  await waitFor(() => task(stale).status === 'awaiting_confirmation')
  saveBuildTargets(project, [{ ...target, commands: ['node changed.cjs'] }])
  assert.throws(() => agentService.confirm(stale, true), /配置已变化/)
  await agentService.cancel(stale)
  assert.equal(task(stale).status, 'cancelled')
  // Cancel a real running process without scheduling another model step.
  writeFileSync(join(projectPath, 'slow.cjs'), "console.log('SLOW_STARTED'); setTimeout(() => console.log('SHOULD_NOT_COMPLETE'), 30000)")
  saveBuildTargets(project, [{ ...target, commands: ['node slow.cjs'] }])
  replies.push('{"action":{"tool":"build","args":{"targetId":"fixture"}}}')
  const stopped = agentService.start({ context: { page: '/projects', projectId: project.id }, prompt: '构建慢任务' })
  await waitFor(() => task(stopped).status === 'awaiting_confirmation')
  agentService.confirm(stopped, true)
  await waitFor(() => task(stopped).events.some(e => e.text.includes('SLOW_STARTED')))
  await agentService.cancel(stopped)
  await waitFor(() => task(stopped).status === 'cancelled')
  assert.equal(task(stopped).events.some(e => e.kind === 'tool' && e.text.includes('SHOULD_NOT_COMPLETE')), false)
  await evalUI(`document.querySelector('.agent-fab').click()`)
  await waitFor(() => evalUI(`document.querySelector('.global-agent-drawer')?.getBoundingClientRect().width > 0`))
  await new Promise(resolve => setTimeout(resolve, 350))
  writeFileSync('/tmp/project-hub-agent-preview.png', (await win.webContents.capturePage()).toPNG())
  // Existing general configuration is still intact.
  assert.equal(aiConfigRepo.get().model, 'general-fixture')
  await evalUI(`location.hash = '/settings?section=ai&ai=agent'`)
  await waitFor(() => evalUI(`document.body.innerText.includes('Agent AI（独立配置）')`))
  assert.equal(await evalUI(`document.querySelector('#agent-ai-settings').textContent.includes('agent-fixture')`), true)
  assert.equal(await evalUI(`document.body.innerText.includes('general-fixture')`), true)
  win.destroy(); server.close(); closeDb()
  console.log('Agent smoke passed: independent config, global UI, real build, logs, confirmation, cancellation, stale approval, restart recovery, running process stop')
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
