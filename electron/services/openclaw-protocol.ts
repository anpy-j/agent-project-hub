import { createHash, createPublicKey, sign, randomUUID } from 'crypto'
import WebSocket from 'ws'

export interface DeviceIdentity { publicKey: string; privateKey: string }
export function deviceId(identity: DeviceIdentity): string {
  return createHash('sha256').update(createPublicKey(identity.publicKey).export({ type: 'spki', format: 'der' }).subarray(-32)).digest('hex')
}
export function connectParams(identity: DeviceIdentity, nonce: string, token: string, platform = process.platform, signedAt = Date.now(), authMode: 'token' | 'password' = 'token', permissions: { adminAccess?: boolean; pairingAccess?: boolean } = {}) {
  const scopes = ['operator.read', 'operator.write', 'operator.approvals', ...(permissions.adminAccess ? ['operator.admin'] : []), ...(permissions.pairingAccess ? ['operator.pairing'] : [])]
  const id = deviceId(identity)
  const payload = ['v3', id, 'gateway-client', 'backend', 'operator', scopes.join(','), String(signedAt), authMode === 'token' ? token : '', nonce, platform.toLowerCase(), ''].join('|')
  return {
    minProtocol: 4, maxProtocol: 4,
    client: { id: 'gateway-client', displayName: 'Project Hub', version: '0.1.0', platform, mode: 'backend' },
    role: 'operator', scopes, caps: ['tool-events', 'exec-approvals'],
    ...(token ? { auth: authMode === 'password' ? { password: token } : { token } } : {}),
    device: { id, publicKey: createPublicKey(identity.publicKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'), signature: sign(null, Buffer.from(payload), identity.privateKey).toString('base64url'), signedAt, nonce }
  }
}
export class GatewayConnection {
  private socket?: WebSocket
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private closed = false
  private ready = false
  private heartbeat?: ReturnType<typeof setInterval>
  constructor(private url: string, private identity: DeviceIdentity, private token: string,
    private onEvent: (event: string, payload: any) => void, private onClose: (reason: string) => void, private authMode: 'token' | 'password' = 'token', private permissions: { adminAccess?: boolean; pairingAccess?: boolean } = {}) {}
  connect(): Promise<any> {
    return new Promise((resolve, reject) => {
      const socket = this.socket = new WebSocket(this.url, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 15000 })
      let settled = false
      const finish = (error?: Error, hello?: any) => {
        if (settled) return
        settled = true; clearTimeout(timer)
        if (error) { reject(error); this.close() } else { this.ready = true
          let alive = true
          socket.on('pong', () => { alive = true })
          this.heartbeat = setInterval(() => { if (!alive) { socket.terminate(); return }; alive = false; if (socket.readyState === WebSocket.OPEN) socket.ping() }, 30000)
          resolve(hello) }
      }
      const timer = setTimeout(() => finish(new Error('Gateway 连接超时')), 18000)
      socket.on('error', error => finish(new Error(error.message)))
      socket.on('close', (code, reason) => {
        clearInterval(this.heartbeat)
        const message = `Gateway 连接已关闭 (${code}) ${reason.toString()}`
        finish(new Error(message)); this.rejectPending(message)
        if (!this.closed) this.onClose(message)
      })
      socket.on('message', raw => {
        let frame: any
        try { frame = JSON.parse(raw.toString()) } catch { return }
        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          if (!frame.payload?.nonce) { finish(new Error('Gateway 未提供设备验证 nonce')); return }
          void this.request('connect', connectParams(this.identity, frame.payload.nonce, this.token, process.platform, Date.now(), this.authMode, this.permissions)).then(hello => finish(undefined, hello), error => finish(error))
        } else if (frame.type === 'res') {
          const request = this.pending.get(frame.id)
          if (!request) return
          // Some RPCs produce an intermediate acknowledgement before their final result.
          this.pending.delete(frame.id); clearTimeout(request.timer)
          frame.ok ? request.resolve(frame.payload) : request.reject(new Error(`${frame.error?.message || 'Gateway 请求失败'}${frame.error?.details?.requestId ? `；配对请求 ${frame.error.details.requestId}` : ''}`))
        } else if (frame.type === 'event' && this.ready) this.onEvent(frame.event, frame.payload)
      })
    })
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('请先连接 OpenClaw'))
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 请求超时，请检查实际状态，避免重复发送`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket!.send(JSON.stringify({ type: 'req', id, method, params }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
      })
    })
  }
  private rejectPending(message: string) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)) }
    this.pending.clear()
  }
  close(): void { clearInterval(this.heartbeat); this.closed = true; this.ready = false; this.rejectPending('连接已断开'); this.socket?.terminate() }
}
export function validateGatewayUrl(value: string, transport: string): URL {
  const url = new URL(value)
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('请填写不含凭据或查询参数的 ws:// 或 wss:// 地址')
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (transport !== 'direct' && !loopback) throw new Error('本机和 SSH 模式必须连接回环地址')
  if (transport === 'direct' && url.protocol !== 'wss:' && !loopback) throw new Error('远程直连请使用 wss:// 地址，或改用 SSH 隧道')
  return url
}
