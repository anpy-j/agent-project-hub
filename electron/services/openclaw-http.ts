export interface HttpChatMessage { role: 'user' | 'assistant'; content: string }
export function normalizeChatUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('请填写不含凭据或查询参数的 HTTP 接口地址')
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('远程 HTTP 接口请使用 https://')
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/chat/completions') ? path : path ? `${path}/chat/completions` : '/v1/chat/completions'
  return url.toString()
}
function contentText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => typeof part?.text === 'string' ? part.text : '').join('')
  return ''
}
function apiError(body: any, status?: number): Error {
  const detail = typeof body?.error === 'string' ? body.error : body?.error?.message || body?.message || ''
  const label = status === 401 || status === 403 ? '鉴权失败，请检查 API Key 和接口权限' : status === 404 ? '接口或模型不存在，请核对地址和模型名' : status === 429 ? '接口限流，请稍后再试' : `聊天接口请求失败${status ? ` (${status})` : ''}`
  return new Error(`${label}${detail ? `：${String(detail).slice(0, 1000)}` : ''}`)
}
export async function completeHttpChat(options: {
  url: string; token: string; model: string; stream: boolean; messages: HttpChatMessage[]; user?: string; signal: AbortSignal; onDelta?: (text: string) => void
}): Promise<string> {
  const response = await fetch(normalizeChatUrl(options.url), {
    method: 'POST', redirect: 'error', signal: options.signal,
    headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    body: JSON.stringify({ model: options.model, messages: options.messages, stream: options.stream, ...(options.user ? { user: options.user } : {}) })
  })
  if (!response.ok) {
    let body: any = {}
    try { body = await response.json() } catch { /* Do not expose HTML error pages or proxy internals. */ }
    throw apiError(body, response.status)
  }
  if (!(response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')) {
    const body: any = await response.json()
    if (body.error) throw apiError(body)
    const text = contentText(body.choices?.[0]?.message?.content)
    if (!text) throw new Error('接口未返回有效的聊天回复')
    options.onDelta?.(text)
    return text
  }
  if (!response.body) throw new Error('接口未返回响应内容')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  const cancel = () => { void reader.cancel(options.signal.reason).catch(() => {}) }
  options.signal.addEventListener('abort', cancel, { once: true })
  if (options.signal.aborted) cancel()
  let buffer = '', text = '', finished = false, done = false
  function event(block: string): void {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim()
    if (!data) return
    if (data === '[DONE]') { done = true; finished = true; return }
    let chunk: any
    try { chunk = JSON.parse(data) } catch { throw new Error('接口返回了无法解析的流式回复') }
    if (chunk.error) throw apiError(chunk)
    const choice = chunk.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finished = true
    const delta = contentText(choice.delta?.content)
    if (delta) { text += delta; if (text.length > 2 * 1024 * 1024) throw new Error('回复内容过长，请开启新对话'); options.onDelta?.(text) }
  }
  try {
    while (!done) {
      const chunk = await reader.read()
      if (options.signal.aborted) throw options.signal.reason || new Error('Request aborted')
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        event(block)
        if (done) break
      }
      if (buffer.length > 2 * 1024 * 1024) throw new Error('接口返回的流式数据过大')
      if (chunk.done) { if (buffer.trim()) event(buffer); break }
    }
    if (!finished) throw new Error('流式连接提前结束，回复可能不完整；不会自动重发消息')
    if (!text) throw new Error('接口未返回文本回复')
    return text
  } finally { options.signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock() }
}
