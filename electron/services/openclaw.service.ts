import { app, BrowserWindow, safeStorage } from 'electron'
import { generateKeyPairSync, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, fstatSync, readSync } from 'fs'
import { homedir } from 'os'
import { join, isAbsolute } from 'path'
import { createServer, type Server } from 'net'
import { execFile } from 'child_process'
import type { Client } from 'ssh2'
import type { OpenClawConnection, OpenClawEvent, OpenClawInput, OpenClawInstance, OpenClawModels } from '../../src/types/openclaw'
import { deploymentStore } from './deployment-store'
import { connectHost, sshExec } from './deployment-ssh'
import { completeHttpChat, normalizeChatUrl } from './openclaw-http'
import { openclawHistory } from './openclaw-history'
import { GatewayConnection, deviceId, validateGatewayUrl, type DeviceIdentity } from './openclaw-protocol'

type Stored = OpenClawInstance & { credential: string; identity: string }
let rows: Stored[] | undefined
const connections = new Map<string, { state: OpenClawConnection; client?: GatewayConnection; ssh?: Client; server?: Server; retry?: ReturnType<typeof setTimeout>; wanted: boolean; attempt: number }>()
const httpRuns = new Map<string, { runId: string; controller: AbortController; text: string; sessionKey: string }>()
const httpRunKey = (id: string, session: string) => `${id}\n${session}`
const operations = new Set<string>()
const closeTunnels = new WeakMap<Server, () => void>()
const filename = () => join(app.getPath('userData'), 'openclaw-v1.json')
function load(): Stored[] { return rows ??= existsSync(filename()) ? JSON.parse(readFileSync(filename(), 'utf8')) : [] }
function persist(): void { mkdirSync(app.getPath('userData'), { recursive: true }); writeFileSync(filename() + '.tmp', JSON.stringify(load()), { mode: 0o600 }); renameSync(filename() + '.tmp', filename()) }
function encrypt(text: string): string {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('系统安全存储不可用，不能保存 OpenClaw 凭据')
  return safeStorage.encryptString(text).toString('base64')
}
function decrypt(text: string): string { return text ? safeStorage.decryptString(Buffer.from(text, 'base64')) : '' }
function publicRow({ credential: _credential, identity: _identity, ...row }: Stored): OpenClawInstance { return row }
function get(id: string): Stored { const row = load().find(r => r.id === id); if (!row) throw new Error('OpenClaw 实例不存在'); return row }
function emit(instanceId: string, event: string, payload: any): void {
  const value: OpenClawEvent = { instanceId, event, payload }
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('openclaw:event', value)
}
function cleanup(entry: ReturnType<typeof connections.get>): void {
  if (!entry) return
  clearTimeout(entry.retry); entry.client?.close(); if (entry.server) { closeTunnels.get(entry.server)?.(); entry.server.close() }; entry.ssh?.end()
  entry.client = undefined; entry.server = undefined; entry.ssh = undefined
}
function redact(row: Stored, text: string): string { const token = decrypt(row.credential); return token ? text.split(token).join('[已隐藏凭据]') : text }
function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'" }
function parseStatus(output: string): any {
  try { return JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1)) } catch { throw new Error('无法解析 OpenClaw 服务状态，请检查 CLI 路径及安装版本') }
}
function verifyServiceTarget(row: Stored, output: string): void {
  const status = parseStatus(output)
  const port = status.gateway?.port
  const configuredPort = row.transport === 'http' ? (row.managementPort || 18789) : Number(new URL(row.url).port || (new URL(row.url).protocol === 'wss:' ? 443 : 80))
  if (typeof port !== 'number' || port !== configuredPort) throw new Error('CLI 管理的 Gateway 端口与当前实例不一致，已停止服务操作；请检查 Gateway 地址和 CLI 路径')
}
function statusLogPath(output: string): string {
  try {
    const status = parseStatus(output)
    if (typeof status.logFile === 'string' && isAbsolute(status.logFile)) return status.logFile
  } catch { /* Diagnostics below retain the original service error. */ }
  return ''
}
function logTail(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size, length = Math.min(size, 200000), buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8').split('\n').slice(-200).join('\n') || '暂无日志'
  } finally { closeSync(fd) }
}
function localCli(row: Stored, args: string[]): Promise<string> {
  const searchPath = [process.env.PATH, join(homedir(), 'Library/pnpm'), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(process.platform === 'win32' ? ';' : ':')
  return new Promise((resolve, reject) => execFile(row.cliPath || 'openclaw', args, { timeout: 45000, maxBuffer: 1024 * 1024, env: { ...process.env, PATH: searchPath, ELECTRON_RUN_AS_NODE: undefined }, windowsHide: true }, (error, stdout, stderr) => error ? reject(new Error(redact(row, `${error.message}\n${stderr}`).slice(-4000))) : resolve(redact(row, stdout + stderr))))
}
async function tunnel(ssh: Client, url: URL): Promise<Server> {
  const sockets = new Set<import('net').Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => socket.destroy()); socket.on('close', () => sockets.delete(socket))
    ssh.forwardOut('127.0.0.1', socket.remotePort || 0, url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/[\[\]]/g, ''), Number(url.port || (url.protocol === 'wss:' ? 443 : 80)), (error, stream) => {
      if (error) { socket.destroy(); return }
      stream.on('close', () => socket.destroy()); stream.on('error', () => socket.destroy()); socket.on('close', () => stream.destroy()); socket.pipe(stream).pipe(socket)
    })
  })
  closeTunnels.set(server, () => { for (const socket of sockets) socket.destroy() })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  server.on('error', () => { for (const socket of sockets) socket.destroy() })
  return server
}
export const openclawService = {
  list: () => load().map(publicRow),
  save(input: OpenClawInput): OpenClawInstance {
    if (!input || !['http', 'local', 'ssh', 'direct'].includes(input.transport) || !input.name?.trim() || input.name.length > 100) throw new Error('请填写实例名称和连接方式')
    const url = input.transport === 'http' ? normalizeChatUrl(input.url) : (validateGatewayUrl(input.url, input.transport), input.url)
    if (input.transport === 'http' && (!input.model?.trim() || input.model.length > 200)) throw new Error('请填写模型名称，例如 openclaw')
    if (input.management && !['none', 'local', 'ssh'].includes(input.management)) throw new Error('无效管理方式')
    if (input.managementPort !== undefined && (!Number.isInteger(input.managementPort) || input.managementPort < 1 || input.managementPort > 65535)) throw new Error('服务端口无效')
    if (input.authMode && !['token', 'password'].includes(input.authMode)) throw new Error('无效鉴权方式')
    if (operations.has(input.id)) throw new Error('请等待服务操作完成')
    if ([...httpRuns.keys()].some(key => key.startsWith(`${input.id}\n`))) throw new Error('请等待当前回复结束或停止回复后再编辑连接')
    if (input.transport === 'ssh' || (input.transport === 'http' && input.management === 'ssh')) deploymentStore.host(input.hostId)
    if (input.cliPath && input.cliPath !== 'openclaw' && !isAbsolute(input.cliPath)) throw new Error('CLI 路径请填写绝对路径')
    if (input.token && (typeof input.token !== 'string' || input.token.length > 16384)) throw new Error('Token 格式无效')
    const existing = load().find(r => r.id === input.id)
    const identity: DeviceIdentity | undefined = input.transport === 'http' ? undefined : existing?.identity ? JSON.parse(decrypt(existing.identity)) : (() => { const pair = generateKeyPairSync('ed25519'); return { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } })()
    const same = existing?.url === url && existing?.transport === input.transport && (input.transport === 'http' || existing?.hostId === input.hostId) && (existing?.authMode || 'token') === (input.authMode || 'token')
    const credential = input.clearToken ? '' : input.token ? encrypt(input.transport === 'http' ? input.token.trim().replace(/^Bearer\s+/i, '') : input.token.trim()) : same ? existing!.credential : ''
    const row: Stored = { id: existing?.id || randomUUID(), name: input.name.trim(), transport: input.transport, url, hostId: input.transport === 'ssh' || (input.transport === 'http' && input.management === 'ssh') ? input.hostId : '', cliPath: input.cliPath || 'openclaw', authMode: input.authMode || 'token', hasToken: !!credential, credential, identity: identity ? encrypt(JSON.stringify(identity)) : '', model: input.transport === 'http' ? input.model!.trim() : undefined, stream: input.stream !== false, management: input.management || 'none', managementPort: input.managementPort || 18789, adminAccess: !!input.adminAccess, pairingAccess: !!input.pairingAccess }
    this.disconnect(row.id); connections.delete(row.id); emit(row.id, 'connection', { instanceId: row.id, status: 'disconnected', error: '' }); rows = existing ? load().map(r => r.id === row.id ? row : r) : [...load(), row]; persist(); return publicRow(row)
  },
  remove(id: string): void { if (operations.has(id)) throw new Error('请等待服务操作完成'); this.disconnect(id); rows = load().filter(r => r.id !== id); persist() },
  async discover(): Promise<OpenClawInstance> {
    const existing = load().find(r => r.transport === 'local')
    if (existing) return publicRow(existing)
    const cliPath = [join(homedir(), 'Library/pnpm/openclaw'), join(homedir(), '.local/bin/openclaw'), '/opt/homebrew/bin/openclaw', '/usr/local/bin/openclaw'].find(existsSync) || 'openclaw'
    const configPath = join(process.env.OPENCLAW_STATE_DIR || join(homedir(), '.openclaw'), 'openclaw.json')
    let config: any = {}
    if (existsSync(configPath)) { try { config = JSON.parse(readFileSync(configPath, 'utf8')) } catch { /* Custom/JSON5 configurations can be entered manually. */ } }
    const authMode = config.gateway?.auth?.mode === 'password' ? 'password' : 'token'
    const configured = authMode === 'password' ? config.gateway?.auth?.password : config.gateway?.auth?.token
    const token = typeof configured === 'string' ? configured : ''
    const port = Number(config.gateway?.port || 18789)
    return this.save({ id: '', name: '本机 OpenClaw', transport: 'local', url: `ws://127.0.0.1:${port}`, hostId: '', cliPath, authMode, token: (authMode === 'password' ? process.env.OPENCLAW_GATEWAY_PASSWORD : process.env.OPENCLAW_GATEWAY_TOKEN) || token })
  },
  connections: () => [...connections.values()].map(entry => entry.state),
  async connect(id: string): Promise<OpenClawConnection> {
    const row = get(id)
    if (row.transport === 'http') {
      normalizeChatUrl(row.url)
      const previousHttp = connections.get(id)
      const state: OpenClawConnection = { instanceId: id, status: 'connected', error: '', verified: previousHttp?.state.verified || false }
      connections.set(id, { state, wanted: true, attempt: 0 }); emit(id, 'connection', state); return state
    }
    const previous = connections.get(id)
    if (previous?.state.status === 'connected' || previous?.state.status === 'connecting') return previous.state
    cleanup(previous)
    const identity: DeviceIdentity = JSON.parse(decrypt(row.identity))
    const entry = { state: { instanceId: id, status: 'connecting', error: '', deviceId: deviceId(identity) } as OpenClawConnection, wanted: true, attempt: (previous?.attempt || 0) + 1 } as NonNullable<ReturnType<typeof connections.get>>
    connections.set(id, entry); emit(id, 'connection', entry.state)
    const lost = (reason: string) => {
        if (!entry.wanted || connections.get(id) !== entry || entry.state.status === 'error') return
        entry.state = { ...entry.state, status: 'error', error: redact(row, reason) }; emit(id, 'connection', entry.state)
        // Reconnect only transport failures; pairing and authentication failures require explicit retry.
        cleanup(entry)
        entry.retry = setTimeout(() => { if (entry.wanted) void this.connect(id).catch(() => {}) }, Math.min(30000, 2000 * Math.max(1, entry.attempt)))
      }
    try {
      const url = validateGatewayUrl(row.url, row.transport)
      let endpoint = row.url
      if (row.transport === 'ssh') {
        entry.ssh = await connectHost(deploymentStore.host(row.hostId), deploymentStore.hostSecret(row.hostId))
        if (!entry.wanted) { cleanup(entry); return entry.state }
        entry.server = await tunnel(entry.ssh, url)
        // SSH supplies encryption; the target Gateway should bind plain WS to loopback.
        if (url.protocol !== 'ws:') throw new Error('SSH 模式请使用服务器回环 ws:// 地址；wss:// 请使用远程直连')
        endpoint = `ws://127.0.0.1:${(entry.server.address() as import('net').AddressInfo).port}${url.pathname}`
        entry.ssh.on('error', error => { entry.client?.close(); lost(error.message) })
        entry.ssh.on('close', () => lost('SSH 隧道已断开'))
      }
      if (!entry.wanted) { cleanup(entry); return entry.state }
      entry.client = new GatewayConnection(endpoint, identity, decrypt(row.credential), (event, payload) => emit(id, event, payload), lost, row.authMode || 'token', { adminAccess: row.adminAccess, pairingAccess: row.pairingAccess })
      const hello = await entry.client.connect()
      if (!entry.wanted) { cleanup(entry); return entry.state }
      entry.state = { ...entry.state, status: 'connected', error: '', version: hello.server?.version, methods: hello.features?.methods || [], scopes: hello.auth?.scopes || [] }; entry.attempt = 0
    } catch (error) {
      if (entry.wanted) entry.state = { ...entry.state, status: 'error', error: redact(row, (error as Error).message) }
      cleanup(entry)
      if (entry.wanted && entry.attempt < 5 && /ECONN|ENOTFOUND|ETIMEDOUT|关闭|超时|socket|连接中断|隧道已断开/i.test(entry.state.error) && !/unauthorized|auth|pair|配对|指纹|signature|protocol/i.test(entry.state.error)) {
        entry.retry = setTimeout(() => { if (entry.wanted) void this.connect(id).catch(() => {}) }, Math.min(30000, 2000 * entry.attempt))
      }
    }
    emit(id, 'connection', entry.state); return entry.state
  },
  disconnect(id: string): void { for (const [key, run] of httpRuns) if (key.startsWith(`${id}\n`)) run.controller.abort(); const entry = connections.get(id); if (!entry) return; entry.wanted = false; cleanup(entry); entry.state = { ...entry.state, status: 'disconnected', error: '' }; emit(id, 'connection', entry.state) },
  async request(id: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
    const row = get(id)
    if (row.transport === 'http') return this.httpRequest(row, method, params)
    const allowed = ['health', 'status', 'agents.list', 'sessions.list', 'chat.history', 'chat.send', 'chat.abort', 'logs.tail', 'exec.approval.resolve', 'exec.approval.list']
    if (!allowed.includes(method)) throw new Error('不支持的 OpenClaw 操作')
    const entry = connections.get(id)
    if (entry?.state.status !== 'connected' || !entry.client) throw new Error('请先连接当前 OpenClaw 实例')
    if (method === 'chat.send' && (typeof params.message !== 'string' || !params.message.trim() || params.message.length > 100000 || typeof params.idempotencyKey !== 'string')) throw new Error('消息或请求标识无效')
    if (method === 'exec.approval.resolve' && !['allow-once', 'deny'].includes(String(params.decision))) throw new Error('不支持的审批决定')
    try { return await entry.client.request(method, params) } catch (error) { throw new Error(redact(get(id), (error as Error).message)) }
  },
  async service(id: string, action: 'status' | 'start' | 'stop' | 'restart' | 'logs'): Promise<string> {
    if (!['status', 'start', 'stop', 'restart', 'logs'].includes(action)) throw new Error('无效服务操作')
    const row = get(id)
    if (row.transport === 'http' && (!row.management || row.management === 'none')) throw new Error('HTTP 聊天接口不提供服务管理；请在连接设置中绑定本机或 SSH 服务')
    if (row.transport === 'direct') throw new Error('远程直连仅支持 Gateway；服务控制请配置 SSH 实例')
    if (operations.has(id)) throw new Error('当前实例正在执行服务操作')
    operations.add(id)
    try {
      const args = action === 'logs' ? ['logs', '--plain', '--limit', '200', '--timeout', '5000'] : ['gateway', action, ...(action === 'status' ? ['--json'] : [])]
      if (row.transport === 'local' || (row.transport === 'http' && row.management === 'local')) {
        if (['start', 'stop', 'restart', 'logs'].includes(action)) {
          verifyServiceTarget(row, await localCli(row, ['gateway', 'status', '--json']))
          if (action === 'stop' || action === 'restart') this.disconnect(id)
        }
        if (action !== 'logs') return await localCli(row, args)
        try { return await localCli(row, args) } catch (error) {
          const status = await localCli(row, ['gateway', 'status', '--json'])
          verifyServiceTarget(row, status)
          const path = statusLogPath(status)
          if (!path) throw error
          return redact(row, logTail(path))
        }
      }
      const ssh = await connectHost(deploymentStore.host(row.hostId), deploymentStore.hostSecret(row.hostId))
      try {
        if (['start', 'stop', 'restart', 'logs'].includes(action)) {
          verifyServiceTarget(row, await sshExec(ssh, `${quote(row.cliPath)} gateway status --json`))
          if (action === 'stop' || action === 'restart') this.disconnect(id)
        }
        const command = `${quote(row.cliPath)} ${args.map(quote).join(' ')}`
        try { return redact(row, await sshExec(ssh, command)) } catch (error) {
          if (action !== 'logs') throw error
          const status = await sshExec(ssh, `${quote(row.cliPath)} gateway status --json`)
          verifyServiceTarget(row, status)
          const path = statusLogPath(status)
          if (!path) throw error
          return redact(row, await sshExec(ssh, `tail -n 200 -- ${quote(path)}`))
        }
      } finally { ssh.end() }
    } finally { operations.delete(id) }
  },
  async models(id: string, selection?: string): Promise<OpenClawModels> {
    const row = get(id)
    if (row.transport === 'http' && !['local', 'ssh'].includes(row.management || 'none')) throw new Error('HTTP 模型管理需要绑定本机或 SSH 主机，请先编辑连接')
    if (selection !== undefined && (typeof selection !== 'string' || !selection || selection.length > 300)) throw new Error('无效模型')
    if (operations.has(id)) throw new Error('请等待当前管理操作完成')
    operations.add(id)
    let ssh: Client | undefined
    try {
      const entry = connections.get(id)
      if (row.transport !== 'http' && (row.transport === 'direct' || entry?.state.status === 'connected')) {
        if (entry?.state.status !== 'connected' || !entry.client) throw new Error('请先连接当前 OpenClaw Gateway')
        if (!entry.state.scopes?.includes('operator.admin')) throw new Error('模型配置需要 operator.admin 权限，请在编辑连接中申请配置管理权限，服务端批准后重新连接')
        const client = entry.client
        const snapshot = await client.request('config.get', {})
        const primary = (config: any): string => {
          const model = config?.agents?.defaults?.model
          return typeof model === 'string' ? model : typeof model?.primary === 'string' ? model.primary : ''
        }
        const catalog = await client.request('models.list', { view: 'configured' })
        if (!Array.isArray(catalog.models)) throw new Error('Gateway 未返回模型列表，请检查服务端版本')
        const models: OpenClawModels['models'] = catalog.models.filter((m: any) => typeof m.id === 'string' && typeof m.provider === 'string').map((m: any) => ({ key: `${m.provider}/${m.id}`, name: typeof m.name === 'string' ? m.name : m.id, available: m.available !== false }))
        const current = primary(snapshot.config)
        if (selection === undefined || selection === current) return { current, models }
        if (!models.some(m => m.key === selection && m.available)) throw new Error('请选择服务端已配置且可用的模型，刷新列表后重试')
        if (typeof snapshot.hash !== 'string' || !snapshot.hash) throw new Error('Gateway 未返回配置版本，不能安全切换模型')
        const result = await client.request('config.patch', { baseHash: snapshot.hash, raw: JSON.stringify({ agents: { defaults: { model: { primary: selection } } } }), note: 'Project Hub 切换默认模型' })
        if (primary(result.config) !== selection) throw new Error('已提交切换，但 Gateway 未确认默认模型，请刷新检查')
        return { current: selection, models }
      }
      const local = row.transport === 'local' || (row.transport === 'http' && row.management === 'local')
      if (!local) ssh = await connectHost(deploymentStore.host(row.hostId), deploymentStore.hostSecret(row.hostId))
      const execute = (args: string[]) => local ? localCli(row, args) : sshExec(ssh!, `${quote(row.cliPath)} ${args.map(quote).join(' ')}`)
      verifyServiceTarget(row, await execute(['gateway', 'status', '--json']))
      const read = async (): Promise<OpenClawModels> => {
        const result = parseStatus(await execute(['models', 'list', '--json']))
        if (!Array.isArray(result.models)) throw new Error('服务端未返回模型列表，请检查 OpenClaw 版本')
        const models = result.models.filter((m: any) => typeof m.key === 'string').map((m: any) => ({ key: m.key, name: typeof m.name === 'string' ? m.name : m.key, available: m.available !== false }))
        const current = result.models.find((m: any) => Array.isArray(m.tags) && m.tags.includes('default'))?.key || ''
        return { models, current }
      }
      const before = await read()
      if (selection === undefined) return before
      if (!before.models.some(m => m.key === selection && m.available)) throw new Error('请选择服务端已配置且可用的模型，刷新列表后重试')
      if (before.current === selection) return before
      await execute(['models', 'set', selection])
      const after = await read()
      if (after.current !== selection) throw new Error('已提交切换，但服务端未确认默认模型，请刷新检查')
      return after
    } catch (error) { throw new Error(redact(row, (error as Error).message)) }
    finally { ssh?.end(); operations.delete(id) }
  },
  async httpRequest(row: Stored, method: string, params: Record<string, unknown>): Promise<any> {
    const id = row.id
    if (method === 'sessions.list') return { sessions: openclawHistory.list(id).map(session => ({ key: session.key, derivedTitle: session.title, updatedAt: session.updatedAt })) }
    if (method === 'agents.list') return { agents: [] }
    if (method === 'chat.history') {
      const session = openclawHistory.get(id, String(params.sessionKey || ''))
      return { messages: session?.messages || [], error: session?.pending && !httpRuns.has(httpRunKey(id, session.key)) ? '上次请求在应用关闭时中断，请确认实际结果；消息不会自动重发' : session?.error }
    }
    if (method === 'http.test') {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000)
      try {
        await completeHttpChat({ url: row.url, token: decrypt(row.credential), model: row.model || 'openclaw', stream: false, messages: [{ role: 'user', content: '请只回复 OK' }], signal: controller.signal })
        const state: OpenClawConnection = { instanceId: id, status: 'connected', verified: true, error: '' }
        connections.set(id, { state, wanted: true, attempt: 0 }); emit(id, 'connection', state)
        return '接口测试成功'
      } catch (error) { throw new Error(redact(row, (error as Error).message)) } finally { clearTimeout(timer) }
    }
    if (method === 'chat.abort') {
      const run = httpRuns.get(httpRunKey(id, String(params.sessionKey || '')))
      if (run && (!params.runId || params.runId === run.runId)) run.controller.abort()
      return { aborted: !!run }
    }
    if (method !== 'chat.send') throw new Error('HTTP 聊天接口不提供此管理功能')
    if (typeof params.message !== 'string' || !params.message.trim() || params.message.length > 100000 || typeof params.sessionKey !== 'string' || !params.sessionKey || params.sessionKey.length > 500 || typeof params.idempotencyKey !== 'string') throw new Error('消息、会话或请求标识无效')
    const key = httpRunKey(id, params.sessionKey)
    let session = openclawHistory.get(id, params.sessionKey)
    if (session?.lastRunId === params.idempotencyKey) return { runId: session.lastRunId, duplicate: true }
    if (httpRuns.has(key)) throw new Error('请等待当前会话回复结束')
    session ||= { instanceId: id, key: params.sessionKey, title: params.message.trim().slice(0, 40), updatedAt: Date.now(), messages: [] }
    const requestMessages = [...session.messages, { role: 'user' as const, content: params.message }]
    if (JSON.stringify(requestMessages).length > 2 * 1024 * 1024) throw new Error('当前会话内容过长，请开始新对话')
    session.messages = requestMessages; session.updatedAt = Date.now(); session.lastRunId = params.idempotencyKey; session.pending = true; session.error = ''
    openclawHistory.save(session)
    if (!connections.has(id)) connections.set(id, { state: { instanceId: id, status: 'connected', verified: false, error: '' }, wanted: true, attempt: 0 })
    const run = { runId: params.idempotencyKey, controller: new AbortController(), text: '', sessionKey: params.sessionKey }
    httpRuns.set(key, run)
    const history = session
    const timer = setTimeout(() => run.controller.abort(new Error('请求超过 3 分钟，已停止等待；消息不会自动重发')), 180000)
    void completeHttpChat({ url: row.url, token: decrypt(row.credential), model: row.model || 'openclaw', stream: row.stream !== false, messages: requestMessages, user: `project-hub:${id}:${params.sessionKey}`, signal: run.controller.signal, onDelta: text => {
      run.text = text
      emit(id, 'chat', { sessionKey: run.sessionKey, runId: run.runId, state: 'delta', message: { content: text } })
    } }).then(text => {
      history.messages.push({ role: 'assistant', content: text }); history.pending = false; history.updatedAt = Date.now(); openclawHistory.save(history)
      emit(id, 'chat', { sessionKey: run.sessionKey, runId: run.runId, state: 'final', message: { content: text } })
      const entry = connections.get(id)
      if (entry) { entry.state = { ...entry.state, status: 'connected', error: '', verified: true }; emit(id, 'connection', entry.state) }
    }).catch(error => {
      if (run.text) history.messages.push({ role: 'assistant', content: run.text })
      const aborted = run.controller.signal.aborted, timedOut = run.controller.signal.reason instanceof Error && run.controller.signal.reason.message.includes('3 分钟')
      history.pending = false; history.error = timedOut ? run.controller.signal.reason.message : aborted ? '已停止回复，已接收的内容保留在本地' : redact(row, (error as Error).message)
      history.updatedAt = Date.now(); openclawHistory.save(history)
      emit(id, 'chat', { sessionKey: run.sessionKey, runId: run.runId, state: aborted && !timedOut ? 'aborted' : 'error', errorMessage: history.error, message: { content: run.text } })
    }).finally(() => { clearTimeout(timer); if (httpRuns.get(key) === run) httpRuns.delete(key) })
    return { runId: run.runId }
  },
  cleanup(): void { for (const run of httpRuns.values()) run.controller.abort(); for (const id of connections.keys()) this.disconnect(id) }
}
