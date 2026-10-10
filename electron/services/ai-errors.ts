export function aiRequestError(error: unknown, base: string, aborted: boolean): string {
  if (aborted) return '请求超时，请检查 AI 服务是否可用'
  const err = error as { message?: string; code?: string; cause?: { code?: string } }
  const code = err?.cause?.code || err?.code
  let endpoint: URL
  try { endpoint = new URL(base) } catch { return 'Base URL 无效，请填写完整的 http:// 或 https:// 地址' }
  if (code === 'ECONNREFUSED') {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    if (local && endpoint.port === '11434') {
      return '无法连接本机 Ollama（11434 端口）。请先启动 Ollama；若启动后退出，请检查 OLLAMA_MODELS 模型目录是否存在'
    }
    return `连接被拒绝（${endpoint.host}），请检查 AI 服务是否启动以及端口是否正确`
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `无法解析服务域名（${endpoint.hostname}），请检查地址和网络`
  if (err?.message === 'fetch failed') return `无法连接 AI 服务（${endpoint.host}），请检查网络、代理及证书设置${code ? `（${code}）` : ''}`
  return err?.message || '未知请求错误'
}
