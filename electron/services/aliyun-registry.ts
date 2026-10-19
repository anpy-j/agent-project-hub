import SDK from '@alicloud/pop-core'
import type { RegistryCatalog } from '../../src/types/deployment'
import { repositoryName } from './registry-client'

export interface AliyunCredential { accessKeyId: string; accessKeySecret: string }
type Request = (method: string, path: string, query?: Record<string, number | string>, body?: string, headers?: Record<string, string>, options?: Record<string, unknown>) => Promise<unknown>
interface ROA { request: Request; keepAliveAgent: { destroy(): void } }
const ROAClient = (SDK as unknown as { ROAClient: new (config: Record<string, unknown>) => ROA }).ROAClient

export function validateAliyunRegion(region: string, server: string): void {
  if (!/^[a-z]{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(region)) throw new Error('阿里云地域格式不正确，例如 cn-hangzhou')
  const match = server.match(/^registry(?:-vpc)?\.([a-z0-9-]+)\.aliyuncs\.com$/) || server.match(/^crpi-[a-z0-9]+\.([a-z0-9-]+)\.personal\.cr\.aliyuncs\.com$/)
  if (!match || match[1] !== region) throw new Error('个人版仓库地址与管理 API 地域不匹配，请填写该实例实际地域；自定义地址请使用 Docker 通用连接')
}

/** Personal Edition uses ROA 2016-06-07, not Enterprise Edition RPC APIs. */
export class AliyunRegistryClient {
  private request: Request
  private sdk?: ROA
  constructor(private region: string, server: string, credential: AliyunCredential, request?: Request) {
    validateAliyunRegion(region, server)
    if (request) this.request = request
    else {
      this.sdk = new ROAClient({ ...credential, endpoint: `https://cr.${region}.aliyuncs.com`, apiVersion: '2016-06-07', opts: { timeout: 20000, followRedirect: false } })
      this.request = this.sdk.request.bind(this.sdk)
    }
  }
  close(): void { this.sdk?.keepAliveAgent.destroy() }
  private async get(path: string, query: Record<string, number | string> = {}): Promise<Record<string, unknown>> {
    let response: any
    try { response = await this.request('GET', path, query, '', {}, { timeout: 20000, followRedirect: false }) }
    catch (error) {
      // SDK errors can contain request details. Only expose bounded identifiers.
      const e = error as { code?: string; statusCode?: number; result?: { code?: string; Code?: string; errorCode?: string; RequestId?: string; requestId?: string } }
      const rawCode = e.code || e.result?.code || e.result?.Code || e.result?.errorCode
      const code = typeof rawCode === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(rawCode) ? rawCode : String(e.statusCode || 'NETWORK_ERROR')
      const requestId = e.result?.RequestId || e.result?.requestId
      const hint = code === 'USER_NOT_REGISTERED'
        ? '此 RAM 用户尚未完成 ACR 个人版初始化。请使用该 RAM 用户登录容器镜像服务控制台，按页面完成个人版开通和 Registry 密码设置后重试；无需更换已保存的 AccessKey'
        : /AUTH|DENIED|FORBIDDEN|INVALIDACCESSKEY|SIGNATURE/i.test(code) || [401, 403].includes(e.statusCode || 0)
        ? '请核对 AccessKey、三项查询权限，以及个人版实例是否位于 ' + this.region : '请检查网络和阿里云服务状态'
      throw new Error(`阿里云目录查询失败 (${code})。${hint}${typeof requestId === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(requestId) ? `；请求 ID：${requestId}` : ''}`)
    }
    if (!response || typeof response !== 'object' || response.code && !['200', 'SUCCESS', 'success'].includes(String(response.code))) throw new Error('阿里云返回查询失败，请检查实例权限和地域')
    if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw new Error('阿里云响应缺少 data，无法确认查询结果')
    return response.data
  }
  private async pages(path: string, key: 'repos' | 'tags'): Promise<any[]> {
    const rows: any[] = [], fingerprints = new Set<string>()
    for (let page = 1; page <= 100; page++) {
      const data = await this.get(path, { Page: page, PageSize: 100 })
      const items = data[key]
      if (!Array.isArray(items)) throw new Error(`阿里云响应缺少 ${key} 列表`)
      const fingerprint = JSON.stringify(items)
      if (items.length && fingerprints.has(fingerprint)) throw new Error('阿里云返回重复分页，已停止查询，请重试')
      fingerprints.add(fingerprint); rows.push(...items)
      if (typeof data.total === 'number' ? rows.length >= data.total : items.length < 100) return rows
    }
    throw new Error('阿里云目录超过 100 页，请缩小查询范围')
  }
  async catalog(): Promise<RegistryCatalog> {
    const [data, repos] = await Promise.all([this.get('/namespace'), this.pages('/repos', 'repos')])
    if (!Array.isArray(data.namespaces)) throw new Error('阿里云响应缺少命名空间列表')
    const namespaces = data.namespaces.map((row: any) => {
      if (typeof row?.namespace !== 'string') throw new Error('阿里云命名空间格式不正确')
      return repositoryName(row.namespace)
    })
    const repositories = repos.map(row => repositoryName(`${row?.repoNamespace}/${row?.repoName}`))
    return { namespaces: [...new Set(namespaces)].sort(), repositories: [...new Set(repositories)].sort(), mode: 'catalog', notice: `已通过阿里云个人版管理 API 读取 ${this.region} 的命名空间和镜像仓库。` }
  }
  async tags(repository: string): Promise<string[]> {
    repositoryName(repository)
    const parts = repository.split('/')
    if (parts.length !== 2) throw new Error('阿里云个人版镜像路径应为命名空间/镜像名')
    const rows = await this.pages(`/repos/${parts.map(encodeURIComponent).join('/')}/tags`, 'tags')
    return [...new Set(rows.map(row => {
      if (typeof row?.tag !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(row.tag)) throw new Error('阿里云镜像版本格式不正确')
      return row.tag as string
    }))].sort()
  }
}
