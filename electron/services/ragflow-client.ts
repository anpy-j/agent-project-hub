import type { RagflowDataset, RagflowDocument } from '../../src/types/ragflow'

export function normalizeRagflowUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('请输入有效的 RAGFlow 服务地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务地址仅支持 HTTP/HTTPS，不能包含账号、查询参数或锚点')
  // Accept the dataset page supplied by the user, but use the service origin for API calls.
  if (url.pathname !== '/' && !/^\/dataset\/files\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) throw new Error('请填写服务地址，例如 http://127.0.0.1:14310')
  return url.origin
}
export function validateDatasetId(value: string): string {
  const id = value.trim()
  if (id && !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('知识库 ID 格式不正确')
  return id
}
export class RagflowClient {
  readonly baseUrl: string
  constructor(baseUrl: string, private apiKey: string) {
    this.baseUrl = normalizeRagflowUrl(baseUrl)
    if (!apiKey.trim() || /[\r\n]/.test(apiKey)) throw new Error('请填写 RAGFlow API Key')
  }
  private async request(path: string, init: RequestInit = {}): Promise<any> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/v1/${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${this.apiKey.trim()}` },
        signal: AbortSignal.timeout(15000), redirect: 'error'
      })
    } catch { throw new Error('无法连接 RAGFlow，请检查服务地址及服务是否运行（请求最长等待 15 秒）') }
    if (response.status === 401 || response.status === 403) throw new Error('RAGFlow 认证失败，请检查 API Key 和访问权限')
    if (!response.ok) throw new Error(`RAGFlow 请求失败（HTTP ${response.status}）`)
    let body: any
    try { body = await response.json() } catch { throw new Error('服务未返回有效的 API 数据，请检查端口是否正确') }
    if (body.code === 401 || body.code === 403 || body.code === 109 || body.code === 108) throw new Error('RAGFlow 认证失败，请检查 API Key 和访问权限')
    if (body.code !== 0) throw new Error(`RAGFlow 接口失败（错误码 ${String(body.code)}）`)
    return body.data
  }
  async datasets(): Promise<RagflowDataset[]> {
    const rows: RagflowDataset[] = []
    for (let page = 1; ; page++) {
      const data = await this.request(`datasets?page=${page}&page_size=100`)
      const batch = Array.isArray(data) ? data : data?.datasets
      if (!Array.isArray(batch)) throw new Error('知识库列表格式不兼容，请检查 RAGFlow 版本')
      for (const item of batch) if (typeof item.id === 'string' && typeof item.name === 'string') rows.push({ id: item.id, name: item.name })
      if (batch.length < 100) return rows
      if (page >= 100) throw new Error('知识库数量过多，请缩小访问范围')
    }
  }
  async upload(datasetId: string, name: string, content: string): Promise<string> {
    const id = validateDatasetId(datasetId)
    if (!id) throw new Error('请先选择知识库')
    const form = new FormData()
    form.append('file', new Blob([content], { type: 'text/markdown;charset=utf-8' }), name)
    const data = await this.request(`datasets/${encodeURIComponent(id)}/documents`, { method: 'POST', body: form })
    const document = Array.isArray(data) ? data[0] : data?.docs?.[0]
    if (typeof document?.id !== 'string') throw new Error('上传接口未返回文档 ID，请检查 RAGFlow 文档列表后重试')
    return document.id
  }
  async lookup(datasetId: string, filter: { id?: string; name?: string }): Promise<(RagflowDocument & { pipelineId: string }) | null> {
    const id = validateDatasetId(datasetId)
    if (!id) throw new Error('请先选择知识库')
    const query = new URLSearchParams({ page: '1', page_size: '100', ...filter })
    const data = await this.request(`datasets/${encodeURIComponent(id)}/documents?${query}`)
    if (!Array.isArray(data?.docs)) throw new Error('文档列表格式不兼容')
    const doc = data.docs.find((doc: any) => filter.id ? doc.id === filter.id : doc.name === filter.name)
    return doc ? { id: doc.id, name: doc.name, run: String(doc.run ?? ''), progress: Number(doc.progress ?? 0), pipelineId: doc.pipeline_id || '' } : null
  }
  async parse(datasetId: string, documentId: string): Promise<void> {
    const doc = await this.lookup(datasetId, { id: documentId })
    if (!doc) throw new Error('已上传文档不存在，请检查知识库')
    await this.request(doc.pipelineId ? 'documents/ingest' : `datasets/${encodeURIComponent(validateDatasetId(datasetId))}/chunks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc.pipelineId ? { doc_ids: [documentId], run: '1', delete: false } : { document_ids: [documentId] })
    })
  }
  async documents(datasetId: string): Promise<RagflowDocument[]> {
    const id = validateDatasetId(datasetId)
    if (!id) throw new Error('请先选择并保存知识库')
    const data = await this.request(`datasets/${encodeURIComponent(id)}/documents?page=1&page_size=20`)
    if (!Array.isArray(data?.docs)) throw new Error('文档列表格式不兼容，请检查 RAGFlow 版本')
    return data.docs.map((doc: any) => ({ id: String(doc.id), name: String(doc.name), run: String(doc.run ?? ''), progress: Number(doc.progress ?? 0) }))
  }
}
