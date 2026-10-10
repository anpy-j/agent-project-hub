import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { registerRagflowIpc } from '../electron/ipc/ragflow'
const dir = process.env.PROJECT_HUB_RAGFLOW_SMOKE_DIR!
const root = process.env.PROJECT_HUB_RAGFLOW_ROOT!
app.setPath('userData', dir)
app.whenReady().then(async () => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== 'Bearer fixture-key') { res.end(JSON.stringify({ code: 401 })); return }
    res.end(JSON.stringify({ code: 0, data: req.url!.includes('/documents') ? { docs: [{ id: 'doc', name: '连接测试文章.md', run: '3', progress: 1 }] } : [{ id: 'fec3d0e093d34a0c91a5fe1b65841f0e', name: '本机资料库' }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    registerRagflowIpc()
    for (const name of ['workspace:list', 'project:list', 'agent:tasks', 'runtime:list', 'ai:providers', 'deployment:hosts']) ipcMain.handle(name, () => [])
    ipcMain.handle('system:logUsage', () => ({ files: 0, bytes: 0 }))
    ipcMain.handle('ai:getConfig', () => ({ provider: 'ollama', base_url: '', model: '', api_key: '' }))
    ipcMain.handle('gitAuth:snapshot', () => ({ keys: [], platforms: [] }))
    ipcMain.handle('agent:getConfig', () => ({ provider: 'ollama', base_url: '', model: '', api_key: '' }))
    const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: join(root, 'out/preload/index.js'), contextIsolation: true, sandbox: false, offscreen: true } })
    await win.loadFile(join(root, 'out/renderer/index.html'), { hash: '/settings?section=knowledge' })
    const evaluate = (code: string) => win.webContents.executeJavaScript(code, true)
    async function waitFor(code: string) {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        if (await evaluate(code)) return
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error(`Timeout: ${await evaluate('document.body.innerText')}`)
    }
    await waitFor(`document.body.innerText.includes('RAGFlow 知识库连接') && document.querySelector('input[placeholder="http://127.0.0.1:14310"]').value`)
    async function fill(placeholder: string, value: string) {
      await evaluate(`(() => { const input = document.querySelector('input[placeholder='+${JSON.stringify(JSON.stringify(placeholder))}+']'); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    }
    await fill('http://127.0.0.1:14310', `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`)
    await fill('填写 RAGFlow 生成的 API Key', 'fixture-key')
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim()==='验证并保存').click()`)
    await waitFor(`document.body.innerText.includes('连接测试文章.md')`)
    assert(!readFileSync(join(dir, 'ragflow-v1.json'), 'utf8').includes('fixture-key'))
    const cfg = await evaluate('window.api.ragflow.getConfig()')
    assert.equal(cfg.hasApiKey, true)
    assert.equal(cfg.apiKey, undefined)
    writeFileSync('/tmp/project-hub-ragflow-preview.png', (await win.webContents.capturePage()).toPNG())
    win.destroy()
    console.log('RAGFlow UI, IPC, encrypted persistence and document preview passed')
  } finally { server.closeAllConnections(); server.close() }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
