import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { connectParams, GatewayConnection, validateGatewayUrl } from '../electron/services/openclaw-protocol'
const pair = generateKeyPairSync('ed25519')
const identity = { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
test('device signatures bind nonce, token, client and scopes', () => {
  const params = connectParams(identity, 'nonce', 'secret', 'darwin', 123)
  const payload = ['v3', params.device.id, 'gateway-client', 'backend', 'operator', params.scopes.join(','), '123', 'secret', 'nonce', 'darwin', ''].join('|')
  assert.equal(verify(null, Buffer.from(payload), createPublicKey(identity.publicKey), Buffer.from(params.device.signature, 'base64url')), true)
  assert.equal(verify(null, Buffer.from(payload.replace('nonce', 'other')), createPublicKey(identity.publicKey), Buffer.from(params.device.signature, 'base64url')), false)
})
test('administration and pairing scopes are opt-in and included in the signed device proof', () => {
  const basic = connectParams(identity, 'nonce', 'secret', 'darwin', 123)
  assert(!basic.scopes.includes('operator.admin'))
  assert(!basic.scopes.includes('operator.pairing'))
  const managed = connectParams(identity, 'nonce', 'secret', 'darwin', 123, 'token', { adminAccess: true, pairingAccess: true })
  assert(managed.scopes.includes('operator.admin'))
  assert(managed.scopes.includes('operator.pairing'))
  const payload = ['v3', managed.device.id, 'gateway-client', 'backend', 'operator', managed.scopes.join(','), '123', 'secret', 'nonce', 'darwin', ''].join('|')
  assert(verify(null, Buffer.from(payload), createPublicKey(identity.publicKey), Buffer.from(managed.device.signature, 'base64url')))
  assert.notEqual(managed.device.signature, basic.device.signature)
})
test('password auth sends a password and signs without using it as the token', () => {
  const params = connectParams(identity, 'nonce', 'password-secret', 'darwin', 123, 'password')
  assert.deepEqual(params.auth, { password: 'password-secret' })
  const payload = ['v3', params.device.id, 'gateway-client', 'backend', 'operator', params.scopes.join(','), '123', '', 'nonce', 'darwin', ''].join('|')
  assert(verify(null, Buffer.from(payload), createPublicKey(identity.publicKey), Buffer.from(params.device.signature, 'base64url')))
})
test('remote endpoints require TLS and never embed credentials', () => {
  assert.throws(() => validateGatewayUrl('ws://example.com:18789', 'direct'))
  assert.throws(() => validateGatewayUrl('wss://user:secret@example.com', 'direct'))
  assert.throws(() => validateGatewayUrl('ws://127.0.0.1:18789?token=secret', 'local'))
  assert.throws(() => validateGatewayUrl('ws://example.com:18789', 'ssh'))
  assert.equal(validateGatewayUrl('wss://example.com', 'direct').hostname, 'example.com')
})
test('gateway correlates concurrent responses, forwards events and rejects pending work on disconnect', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  let socket: import('ws').WebSocket | undefined
  server.on('connection', ws => {
    socket = ws
    ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'test' } }))
    ws.on('message', raw => {
      const req = JSON.parse(raw.toString())
      if (req.method === 'pending') return
      ws.send(JSON.stringify({ type: 'res', id: req.id, ok: true, payload: req.method === 'connect' ? { server: { version: 'fixture' } } : { method: req.method } }))
    })
  })
  const events: string[] = []
  const gateway = new GatewayConnection(`ws://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`, identity, 'secret', event => events.push(event), () => {})
  try {
    assert.equal((await gateway.connect()).server.version, 'fixture')
    const result = await Promise.all([gateway.request('one'), gateway.request('two')])
    assert.deepEqual(result, [{ method: 'one' }, { method: 'two' }])
    socket!.send(JSON.stringify({ type: 'event', event: 'chat', payload: {} }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(events, ['chat'])
    const pending = gateway.request('pending')
    const rejected = assert.rejects(pending, /连接已断开/)
    gateway.close(); await rejected
    await assert.rejects(gateway.request('one'), /先连接/)
  } finally { gateway.close(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
