import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { completeHttpChat, normalizeChatUrl } from '../electron/services/openclaw-http'
async function fixture(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void) {
  const server = createServer((req, res) => {
    let body = ''; req.on('data', part => { body += part }); req.on('end', () => handler(req, res, body ? JSON.parse(body) : {}))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1/chat/completions`, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}
const args = { model: 'openclaw', token: 'fixture-secret', stream: true, messages: [{ role: 'user' as const, content: '你好' }], signal: new AbortController().signal }
test('normalizes complete and base URLs without putting credentials in URLs', () => {
  assert.equal(normalizeChatUrl('https://example.com/v1'), 'https://example.com/v1/chat/completions')
  assert.equal(normalizeChatUrl('https://example.com'), 'https://example.com/v1/chat/completions')
  assert.equal(normalizeChatUrl('https://example.com/v1/chat/completions/'), 'https://example.com/v1/chat/completions')
  assert.throws(() => normalizeChatUrl('http://example.com/v1'))
  assert.throws(() => normalizeChatUrl('https://user:key@example.com/v1'))
  assert.throws(() => normalizeChatUrl('https://example.com/v1?token=key'))
})
test('sends bearer auth, model, context and stable session user; supports JSON response', async () => {
  const api = await fixture((req, res, body) => {
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.method, 'POST')
    assert.equal(req.headers.authorization, 'Bearer fixture-secret')
    assert.equal(body.model, 'openclaw'); assert.equal(body.user, 'conversation-1'); assert.equal(body.stream, false)
    assert.equal(body.messages[1].content, '你好')
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '你好，测试回复' } }] }))
  })
  try { assert.equal(await completeHttpChat({ ...args, url: api.url, stream: false, user: 'conversation-1', messages: [{ role: 'assistant', content: '上文' }, ...args.messages] }), '你好，测试回复') } finally { await api.close() }
})
test('SSE handles split UTF-8, split CRLF frames, comments and DONE', async () => {
  const api = await fixture((_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    const bytes = Buffer.from(':keepalive\r\n\r\ndata: ' + JSON.stringify({ choices: [{ delta: { content: '你好🙂' } }] }) + '\r\n\r\ndata: ' + JSON.stringify({ choices: [{ delta: { content: '世界' }, finish_reason: 'stop' }] }) + '\r\n\r\ndata: [DONE]\r\n\r\n')
    let position = 0
    const timer = setInterval(() => { if (position < bytes.length) { res.write(bytes.subarray(position, position + 7)); position += 7 } else { clearInterval(timer); res.end() } }, 1)
    res.on('close', () => clearInterval(timer))
  })
  const updates: string[] = []
  try {
    assert.equal(await completeHttpChat({ ...args, url: api.url, onDelta: text => updates.push(text) }), '你好🙂世界')
    assert.deepEqual(updates, ['你好🙂', '你好🙂世界'])
  } finally { await api.close() }
})
test('stream errors and premature closure never report success or resend the request', async () => {
  let requests = 0
  const api = await fixture((_req, res) => {
    requests++; res.setHeader('Content-Type', 'text/event-stream')
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '部分回复' } }] }) + '\n\n' + (requests === 1 ? 'data: {"error":{"message":"provider failed"}}\n\ndata: [DONE]\n\n' : ''))
  })
  try {
    await assert.rejects(completeHttpChat({ ...args, url: api.url }), /provider failed/)
    assert.equal(requests, 1)
    await assert.rejects(completeHttpChat({ ...args, url: api.url }), /提前结束/)
    assert.equal(requests, 2)
  } finally { await api.close() }
})
test('abort cancels the active HTTP request and 401 exposes a useful authentication error', async () => {
  const api = await fixture((_req, res, body) => {
    if (body.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.write('data: {"choices":[{"delta":{"content":"等待"}}]}\n\n') }
    else { res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); res.end('{"error":{"message":"invalid key"}}') }
  })
  const controller = new AbortController()
  try {
    const request = completeHttpChat({ ...args, url: api.url, signal: controller.signal, onDelta: () => controller.abort() })
    await assert.rejects(request, /abort/i)
    await assert.rejects(completeHttpChat({ ...args, url: api.url, stream: false }), /鉴权失败/)
  } finally { await api.close() }
})
