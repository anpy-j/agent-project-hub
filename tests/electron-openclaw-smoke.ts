import { app, BrowserWindow, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { WebSocketServer } from 'ws'
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
  const sent: any[] = [], histories = new Map<string, any[]>()
  server.on('connection', socket => {
    gatewaySockets.push(socket)
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture-nonce' } }))
    socket.on('message', raw => {
      const req = JSON.parse(raw.toString()); sent.push(req)
      let payload: any = {}
      if (req.method === 'connect') {
        assert.equal(req.params.auth.token, 'fixture-secret')
        payload = { server: { version: 'fixture-2026' }, features: { methods: ['chat.send'] } }
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
  const evaluate = (code: string) => win.webContents.executeJavaScript(code, true)
  async function waitFor(code: string) { const until = Date.now() + 12000; while (Date.now() < until) { if (await evaluate(code)) return; await new Promise(r => setTimeout(r, 50)) } throw new Error(`Timed out: ${code}\n${await evaluate('document.body.innerText')}\n${errors.join('\n')}`) }
  const click = (label: string) => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`)
  await waitFor(`document.body.innerText.includes('测试本机')`)
  await click('连接')
  await waitFor(`document.body.innerText.includes('已连接') && document.body.innerText.includes('已有会话')`)
  await evaluate(`document.querySelector('.session-row').click()`)
  await waitFor(`document.body.innerText.includes('来自 Gateway 的历史消息')`)
  await click('新对话')
  await evaluate(`const area=document.querySelector('.compose textarea'); area.value='第一条测试消息'; area.dispatchEvent(new Event('input',{bubbles:true}))`)
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
  // A second connection does not overwrite the first instance's state.
  assert.equal((await openclawService.connect(second.id)).status, 'connected')
  assert.equal(openclawService.connections().filter(s => s.status === 'connected').length, 2)
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
  chmodSync(fakeCli, 0o700)
  const offline = openclawService.save({ id: '', name: 'Offline fixture', transport: 'local', url: endpoint, hostId: '', cliPath: fakeCli, token: 'fixture-secret' })
  assert.equal(await openclawService.service(offline.id, 'logs'), 'OFFLINE_FIXTURE_LOG [已隐藏凭据]')
  const mismatched = openclawService.save({ ...offline, id: '', name: 'Wrong service target', url: 'ws://127.0.0.1:1', token: 'fixture-secret' })
  await assert.rejects(openclawService.service(mismatched.id, 'stop'), /端口.*不一致/)
  openclawService.remove(mismatched.id)
  openclawService.remove(offline.id)
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
  console.log('OpenClaw Electron smoke passed')
  app.quit()
}).catch(error => { console.error(error); openclawService.cleanup(); app.exit(1) })
