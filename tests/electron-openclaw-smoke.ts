import { app, BrowserWindow, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { openclawHistory } from '../electron/services/openclaw-history'
import { closeDb } from '../electron/db'
import { generateKeyPairSync } from 'node:crypto'
import { connect as connectSocket } from 'node:net'
import { Server as SshServer, utils } from 'ssh2'
import { deploymentStore } from '../electron/services/deployment-store'
import { keyFingerprint } from '../electron/services/deployment-ssh'
import { registerOpenClawIpc } from '../electron/ipc/openclaw'
import { openclawService } from '../electron/services/openclaw.service'
const dir = process.env.PROJECT_HUB_OPENCLAW_SMOKE_DIR!
const root = process.env.PROJECT_HUB_OPENCLAW_ROOT!
app.setPath('userData', dir)
app.whenReady().then(async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const gatewaySockets: import('ws').WebSocket[] = []
  let gatewayModel = 'fixture/first'
  const sent: any[] = [], histories = new Map<string, any[]>()
  server.on('connection', socket => {
    gatewaySockets.push(socket)
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture-nonce' } }))
    socket.on('message', raw => {
      const req = JSON.parse(raw.toString()); sent.push(req)
      let payload: any = {}
      if (req.method === 'connect') {
        assert.equal(req.params.auth.token, 'fixture-secret')
        payload = { auth: { scopes: req.params.scopes }, server: { version: 'fixture-2026' }, features: { methods: ['chat.send'] } }
      }
      if (req.method === 'config.get') payload = { hash: 'fixture-hash', config: { agents: { defaults: { model: { primary: gatewayModel, fallbacks: ['fixture/fallback'] } } } } }
      if (req.method === 'models.list') {
        assert.equal(req.params.view, 'configured')
        payload = { models: [{provider:'fixture',id:'first',name:'First',available:true},{provider:'fixture',id:'second',name:'Second',available:true}] }
      }
      if (req.method === 'config.patch') {
        assert.equal(req.params.baseHash, 'fixture-hash')
        const patch = JSON.parse(req.params.raw)
        assert.deepEqual(Object.keys(patch), ['agents'])
        assert.deepEqual(Object.keys(patch.agents.defaults.model), ['primary'])
        gatewayModel = patch.agents.defaults.model.primary
        payload = { config: { agents: { defaults: { model: {primary:gatewayModel,fallbacks:['fixture/fallback']} } } } }
      }
      if (req.method === 'agents.list') payload = { agents: [{ id: 'main', name: '测试助手' }] }
      if (req.method === 'sessions.list') payload = { sessions: [{ key: 'agent:main:fixture', derivedTitle: '已有会话' }] }
      if (req.method === 'chat.history') payload = { messages: histories.get(req.params.sessionKey) || [{ role: 'assistant', content: '来自 Gateway 的历史消息' }] }
      if (req.method === 'chat.send') {
        payload = { runId: req.params.idempotencyKey }
        histories.set(req.params.sessionKey, [{ role: 'user', content: req.params.message }, { role: 'assistant', content: '**测试回复**，支持 Markdown' }])
      }
      if (req.method === 'logs.tail') payload = { lines: ['FIXTURE_GATEWAY_LOG'] }
      socket.send(JSON.stringify({ type: 'res', id: req.id, ok: true, payload }))
      if (req.method === 'chat.send') {
        socket.send(JSON.stringify({ type: 'event', event: 'chat', payload: { sessionKey: req.params.sessionKey, runId: req.params.idempotencyKey, state: 'delta', message: { content: '正在回复' } } }))
        socket.send(JSON.stringify({ type: 'event', event: 'exec.approval.requested', payload: { id: 'approval-1', request: { command: 'echo fixture' } } }))
        setTimeout(() => socket.send(JSON.stringify({ type: 'event', event: 'chat', payload: { sessionKey: req.params.sessionKey, runId: req.params.idempotencyKey, state: 'final', message: { content: '**测试回复**，支持 Markdown' } } })), 300)
      }
    })
  })
  const endpoint = `ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const first = openclawService.save({ id: '', name: '测试本机', transport: 'local', url: endpoint, hostId: '', cliPath: 'openclaw', token: 'fixture-secret' })
  const second = openclawService.save({ id: '', name: '测试服务器', transport: 'direct', url: endpoint, hostId: '', cliPath: 'openclaw', token: 'fixture-secret' })
  assert(!readFileSync(join(dir, 'openclaw-v1.json'), 'utf8').includes('fixture-secret'))
  assert(!('credential' in first))
  assert.equal(openclawService.save({ ...first, token: '' }).hasToken, true)
  registerOpenClawIpc()
  ipcMain.handle('workspace:list', () => [])
  ipcMain.handle('project:list', () => [])
  ipcMain.handle('agent:tasks', () => [])
  ipcMain.handle('deployment:hosts', () => [])
  const errors: string[] = []
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, text) => { if (level >= 3) errors.push(text) })
  await win.loadFile(join(root, 'out/renderer/index.html'), { hash: '/ai/openclaw' })
  const evaluate = async (code: string) => { try { return await win.webContents.executeJavaScript(code, true) } catch (error) { throw new Error(`Renderer script failed: ${code}\n${errors.join('\n')}\n${(error as Error).message}`) } }
  async function waitFor(code: string) { const until = Date.now() + 12000; while (Date.now() < until) { if (await evaluate(code)) return; await new Promise(r => setTimeout(r, 50)) } throw new Error(`Timed out: ${code}\n${await evaluate('document.body.innerText')}\n${errors.join('\n')}`) }
  const click = (label: string) => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`)
  await waitFor(`document.body.innerText.includes('测试本机')`)
  await click('连接')
  await waitFor(`document.body.innerText.includes('已连接') && document.body.innerText.includes('已有会话')`)
  await evaluate(`document.querySelector('.session-row').click()`)
  await waitFor(`document.body.innerText.includes('来自 Gateway 的历史消息')`)
  await click('新对话')
  await evaluate(`var area=document.querySelector('.compose textarea'); area.value='第一条测试消息'; area.dispatchEvent(new Event('input',{bubbles:true}))`)
  await click('发送')
  await waitFor(`document.body.innerText.includes('等待执行审批')`)
  await click('允许一次')
  await waitFor(`document.querySelector('.markdown strong')?.textContent==='测试回复'`)
  assert(sent.some(req => req.method === 'exec.approval.resolve' && req.params.decision === 'allow-once'))
  assert(sent.some(req => req.method === 'chat.send' && req.params.deliver === false))
  writeFileSync(join(dir, 'openclaw-chat-preview.png'), (await win.capturePage()).toPNG())
  // Navigation preserves the running connection and selected conversation.
  await evaluate(`location.hash='/projects'`)
  await waitFor(`!document.querySelector('.claw-page')`)
  await evaluate(`location.hash='/ai/openclaw'`)
  await waitFor(`document.querySelector('.claw-page') && document.body.innerText.includes('第一条测试消息')`)
  await evaluate(`Array.from(document.querySelectorAll('.el-tabs__item')).find(e=>e.textContent==='管理').click()`)
  await waitFor(`document.querySelector('.el-tabs__item.is-active')?.textContent==='管理'`)
  await click('读取日志')
  await waitFor(`document.body.innerText.includes('FIXTURE_GATEWAY_LOG')`)
  // Users can opt into administrator and device-pairing scopes; the granted scopes are displayed.
  await click('菜单 ···')
  await click('编辑连接')
  await waitFor(`document.querySelector('.el-dialog')?.textContent.includes('配置管理')`)
  await evaluate(`Array.from(document.querySelectorAll('.el-dialog .el-checkbox')).find(e=>e.textContent.includes('operator.admin')).click()`)
  await evaluate(`Array.from(document.querySelectorAll('.el-dialog .el-checkbox')).find(e=>e.textContent.includes('operator.pairing')).click()`)
  await click('保存实例')
  await waitFor(`document.body.innerText.includes('未连接')`)
  await click('连接')
  await waitFor(`document.body.innerText.includes('服务端授予的权限：') && document.querySelector('.permission-note')?.textContent.includes('operator.admin')`)
  const managedConnect = sent.filter(req => req.method === 'connect').at(-1)
  assert(managedConnect.params.scopes.includes('operator.admin'))
  assert(managedConnect.params.scopes.includes('operator.pairing'))
  await click('刷新模型')
  await waitFor(`document.querySelector('.model-panel')?.textContent.includes('fixture/first')`)
  assert.equal((await evaluate(`window.api.openclaw.models(${JSON.stringify(first.id)}, 'fixture/second')`)).current, 'fixture/second')
  await assert.rejects(openclawService.models(first.id, 'unknown/model'), /已配置/)
  const directAdmin = openclawService.save({ ...second, id: '', name: 'Direct admin fixture', adminAccess: true, token: 'fixture-secret' })
  await openclawService.connect(directAdmin.id)
  assert.equal((await openclawService.models(directAdmin.id, 'fixture/first')).current, 'fixture/first')
  openclawService.remove(directAdmin.id)
  // A second connection does not overwrite the first instance's state.
  assert.equal((await openclawService.connect(second.id)).status, 'connected')
  assert.equal(openclawService.connections().filter(s => s.status === 'connected').length, 2)
  await assert.rejects(openclawService.models(second.id), /operator.admin/)
  const sendsBeforeReconnect = sent.filter(req => req.method === 'chat.send').length
  await new Promise(resolve => setTimeout(resolve, 100))
  gatewaySockets.at(-1)!.terminate()
  await new Promise(resolve => setTimeout(resolve, 2500))
  assert.equal(openclawService.connections().find(state => state.instanceId === second.id)?.status, 'connected')
  assert.equal(sent.filter(req => req.method === 'chat.send').length, sendsBeforeReconnect)
  await assert.rejects(openclawService.request(first.id, 'config.set', {}), /不支持/)
  await assert.rejects(openclawService.service(second.id, 'restart'), /直连/)
  await win.capturePage().then(img => require('node:fs').writeFileSync(join(dir, 'openclaw-preview.png'), img.toPNG()))
  // The SSH fixture exercises real authentication, host pinning, forwarding and remote CLI calls.
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  const remoteCommands: string[] = []
  const sshServer = new SshServer({ hostKeys: [hostKey] }, client => {
    client.on('error', () => {})
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === 'ssh-secret' ? ctx.accept() : ctx.reject())
    client.on('ready', () => {
      client.on('tcpip', accept => {
        const stream = accept(), tcp = connectSocket(Number(new URL(endpoint).port), '127.0.0.1')
        stream.on('error', () => tcp.destroy()); tcp.on('error', () => stream.destroy())
        stream.on('close', () => tcp.destroy()); tcp.on('close', () => stream.destroy()); stream.pipe(tcp).pipe(stream)
      })
      client.on('session', accept => {
        const session = accept()
        session.on('exec', (acceptExec, _reject, info) => {
          remoteCommands.push(info.command)
          const stream = acceptExec(); stream.write(info.command.includes('status') ? JSON.stringify({ service: { runtime: { status: 'running' } }, gateway: { port: Number(new URL(endpoint).port) } }) : 'FIXTURE_SERVICE_OK')
          stream.exit(0); stream.end()
        })
      })
    })
  })
  await new Promise<void>(resolve => sshServer.listen(0, '127.0.0.1', resolve))
  const host = deploymentStore.saveHost({ id: '', name: 'SSH fixture', host: '127.0.0.1', port: (sshServer.address() as import('node:net').AddressInfo).port, username: 'fixture', authKind: 'password', password: 'ssh-secret', fingerprint: keyFingerprint((utils.parseKey(hostKey) as any).getPublicSSH()) })
  const remote = openclawService.save({ id: '', name: 'SSH OpenClaw', transport: 'ssh', url: endpoint, hostId: host.id, cliPath: '/opt/fixture/openclaw', token: 'fixture-secret' })
  assert.equal((await openclawService.connect(remote.id)).status, 'connected')
  assert((await openclawService.request(remote.id, 'agents.list')).agents.length)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert((await openclawService.service(remote.id, 'status')).includes('running'))
  assert.equal(await openclawService.service(remote.id, 'restart'), 'FIXTURE_SERVICE_OK')
  assert.equal(await openclawService.service(remote.id, 'stop'), 'FIXTURE_SERVICE_OK')
  assert(remoteCommands.some(command => command === "'/opt/fixture/openclaw' 'gateway' 'restart'"))
  openclawService.disconnect(remote.id)
  await new Promise<void>(resolve => sshServer.close(() => resolve()))
  // Offline Gateway logs are read from the service status log path, with credential redaction.
  const logPath = join(dir, 'fixture-gateway.log'), fakeCli = join(dir, 'fixture-openclaw')
  writeFileSync(logPath, 'OFFLINE_FIXTURE_LOG fixture-secret')
  writeFileSync(fakeCli, '#!/usr/bin/env node\nif(process.argv[2] === "logs") process.exit(1); console.log(JSON.stringify({logFile:' + JSON.stringify(logPath) + ',gateway:{port:' + Number(new URL(endpoint).port) + '}}))')
  const modelFile = join(dir, 'fixture-model.txt')
  writeFileSync(modelFile, 'fixture/first')
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('fs'), file = ${JSON.stringify(modelFile)};
if(process.argv[2] === 'logs') process.exit(1);
if(process.argv[2] === 'models') {
  if(process.argv[3] === 'set') fs.writeFileSync(file, process.argv[4]);
  console.log(JSON.stringify({ models: ['fixture/first','fixture/second'].map(key => ({key,name:key,available:true,tags:fs.readFileSync(file,'utf8') === key ? ['default','configured'] : ['configured']})) }));
} else console.log(JSON.stringify({logFile:${JSON.stringify(logPath)},gateway:{port:${Number(new URL(endpoint).port)}}}));
`)
  chmodSync(fakeCli, 0o700)
  const offline = openclawService.save({ id: '', name: 'Offline fixture', transport: 'local', url: endpoint, hostId: '', cliPath: fakeCli, token: 'fixture-secret' })
  assert.equal(await openclawService.service(offline.id, 'logs'), 'OFFLINE_FIXTURE_LOG [已隐藏凭据]')
  assert.equal((await openclawService.models(offline.id)).current, 'fixture/first')
  assert.equal((await openclawService.models(offline.id, 'fixture/second')).current, 'fixture/second')
  await assert.rejects(openclawService.models(offline.id, 'unconfigured/model'), /已配置/)
  assert.equal(readFileSync(modelFile, 'utf8'), 'fixture/second')
  const mismatched = openclawService.save({ ...offline, id: '', name: 'Wrong service target', url: 'ws://127.0.0.1:1', token: 'fixture-secret' })
  await assert.rejects(openclawService.service(mismatched.id, 'stop'), /端口.*不一致/)
  await assert.rejects(openclawService.models(mismatched.id, 'fixture/first'), /端口.*不一致/)
  assert.equal(readFileSync(modelFile, 'utf8'), 'fixture/second')
  openclawService.remove(mismatched.id)
  openclawService.remove(offline.id)
  // HTTP uses the user's OpenAI-compatible request format without WebSocket or device pairing.
  const httpRequests: any[] = []
  const httpServer = createServer((req, res) => {
    let raw = ''; req.on('data', part => { raw += part }); req.on('end', () => {
      const body = JSON.parse(raw), text = body.messages.at(-1).content
      httpRequests.push({ path: req.url, authorization: req.headers.authorization, body })
      if (req.headers.authorization !== 'Bearer http-fixture-key') { res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: { message: 'invalid key http-fixture-key' } })); return }
      if (text === '失败请求') { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: { message: 'provider failure http-fixture-key' } })); return }
      if (!body.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'HTTP 普通回复' } }] })); return }
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text === '暂停请求' ? 'HTTP 部分内容' : 'HTTP 流式' } }] }) + '\n\n')
      if (text !== '暂停请求') {
        const timer = setTimeout(() => res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '回复' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'), 300)
        res.on('close', () => clearTimeout(timer))
      }
    })
  })
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const httpUrl = `http://127.0.0.1:${(httpServer.address() as import('node:net').AddressInfo).port}/v1/chat/completions`
  const http = openclawService.save({ id: '', name: 'HTTP 测试实例', transport: 'http', url: httpUrl, hostId: '', cliPath: 'openclaw', model: 'openclaw', stream: true, token: 'Bearer http-fixture-key' })
  assert(!readFileSync(join(dir, 'openclaw-v1.json'), 'utf8').includes('http-fixture-key'))
  // Reload the renderer to exercise local history initialization and the HTTP-only page flow.
  await evaluate(`localStorage.setItem('project-hub.openclaw.instance', ${JSON.stringify(http.id)})`)
  await win.reload()
  await waitFor(`document.body.innerText.includes('HTTP 测试实例') && document.body.innerText.includes('接口已配置')`)
  assert.equal(httpRequests.length, 0, 'Opening HTTP configuration must not send a test message')
  await click('新对话')
  await evaluate(`var area=document.querySelector('.compose textarea'); area.value='HTTP 第一轮'; area.dispatchEvent(new Event('input',{bubbles:true}))`)
  await click('发送')
  await waitFor(`document.body.innerText.includes('HTTP 流式回复') && !document.body.innerText.includes('停止回复')`)
  assert.equal(httpRequests[0].path, '/v1/chat/completions')
  assert.equal(httpRequests[0].authorization, 'Bearer http-fixture-key')
  assert.equal(httpRequests[0].body.model, 'openclaw')
  assert.equal(httpRequests[0].body.messages[0].content, 'HTTP 第一轮')
  const stableUser = httpRequests[0].body.user
  const firstHttpSession = openclawHistory.list(http.id)[0].key
  await evaluate(`var area=document.querySelector('.compose textarea'); area.value='HTTP 第二轮'; area.dispatchEvent(new Event('input',{bubbles:true}))`)
  await click('发送')
  await waitFor(`document.body.innerText.includes('HTTP 第二轮') && !document.body.innerText.includes('停止回复')`)
  assert.equal(httpRequests[1].body.user, stableUser)
  assert.deepEqual(httpRequests[1].body.messages.map((m:any)=>m.role), ['user', 'assistant', 'user'])
  const countBeforeDuplicate = httpRequests.length
  const persisted = openclawHistory.get(http.id, firstHttpSession)!
  await openclawService.request(http.id, 'chat.send', { sessionKey: firstHttpSession, message: 'HTTP 第二轮', idempotencyKey: persisted.lastRunId })
  assert.equal(httpRequests.length, countBeforeDuplicate)
  // SQLite history survives closing the database and reloading the renderer.
  closeDb()
  await win.reload()
  await waitFor(`document.body.innerText.includes('HTTP 第一轮') && document.body.innerText.includes('HTTP 第二轮')`)
  assert.equal(openclawHistory.get(http.id, firstHttpSession)?.messages.length, 4)
  await new Promise(resolve => setTimeout(resolve, 200))
  writeFileSync(join(dir, 'openclaw-http-preview.png'), (await win.capturePage()).toPNG())
  await click('新对话')
  await evaluate(`var area=document.querySelector('.compose textarea'); area.value='暂停请求'; area.dispatchEvent(new Event('input',{bubbles:true}))`)
  await click('发送')
  await waitFor(`document.body.innerText.includes('HTTP 部分内容') && document.body.innerText.includes('停止回复')`)
  await click('停止回复')
  await waitFor(`document.body.innerText.includes('已停止回复')`)
  assert.notEqual(httpRequests.at(-1).body.user, stableUser)
  const stopped = openclawHistory.list(http.id)[0]
  assert.equal(stopped.messages.at(-1)?.content, 'HTTP 部分内容')
  assert.equal(stopped.pending, false)
  const beforeError = httpRequests.length
  await click('新对话')
  await evaluate(`var area=document.querySelector('.compose textarea'); area.value='失败请求'; area.dispatchEvent(new Event('input',{bubbles:true}))`)
  await click('发送')
  await waitFor(`document.body.innerText.includes('provider failure')`)
  assert(!await evaluate(`document.body.innerText.includes('http-fixture-key')`))
  assert.equal(httpRequests.length, beforeError + 1)
  await click('测试接口')
  await waitFor(`document.body.innerText.includes('接口已验证')`)
  assert.equal(httpRequests.at(-1).body.stream, false)
  assert.equal(httpRequests.at(-1).body.user, undefined, 'A connectivity test must not mutate a conversation session')
  await evaluate(`Array.from(document.querySelectorAll('.el-tabs__item')).find(e=>e.textContent==='管理').click()`)
  await waitFor(`document.body.innerText.includes('HTTP 聊天接口只提供对话')`)
  assert(await evaluate(`Array.from(document.querySelectorAll('.manage-actions button')).every(b=>b.disabled)`))
  await assert.rejects(openclawService.request(http.id, 'exec.approval.resolve', { id: 'other', decision: 'allow-once' }), /不提供/)
  await assert.rejects(openclawService.service(http.id, 'restart'), /不提供/)
  // The same HTTP endpoint can fall back to ordinary JSON replies without automatic resends.
  const jsonHttp = openclawService.save({ ...http, id: '', name: 'JSON HTTP', stream: false, token: 'http-fixture-key' })
  await openclawService.request(jsonHttp.id, 'chat.send', { sessionKey: 'plain', message: '你好', idempotencyKey: 'json-run' })
  const deadline = Date.now() + 5000
  while (openclawHistory.get(jsonHttp.id, 'plain')?.pending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(openclawHistory.get(jsonHttp.id, 'plain')?.messages.at(-1)?.content, 'HTTP 普通回复')
  assert.notEqual(httpRequests.at(-1).body.user, stableUser)
  openclawService.disconnect(http.id); openclawService.disconnect(jsonHttp.id)
  await new Promise<void>(resolve => { httpServer.close(() => resolve()); httpServer.closeAllConnections() })
  if (process.env.PROJECT_HUB_OPENCLAW_LIVE === '1') {
    // Read-only live integration: no model request and no service lifecycle changes.
    openclawService.remove(first.id)
    const local = await openclawService.discover()
    const state = await openclawService.connect(local.id)
    console.log('LIVE_CONNECTION', state.status, state.version, state.error)
    assert.equal(state.status, 'connected', state.error)
    for (const method of ['agents.list', 'sessions.list', 'chat.history', 'logs.tail']) {
      const result = await openclawService.request(local.id, method, method === 'sessions.list' ? { limit: 5 } : method === 'chat.history' ? { sessionKey: 'agent:main:main', limit: 1 } : method === 'logs.tail' ? { limit: 1 } : {})
      console.log('LIVE_RPC_OK', method, Object.keys(result || {}))
    }
  }
  win.destroy(); openclawService.cleanup()
  await new Promise<void>(resolve => server.close(() => resolve()))
  closeDb()
  console.log('OpenClaw Electron smoke passed')
  app.quit()
}).catch(error => { console.error(error); openclawService.cleanup(); app.exit(1) })
