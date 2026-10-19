import type { RegistryProfile } from '../../src/types/deployment'

export function repositoryName(value: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(value)) throw new Error('镜像仓库路径不正确')
  return value
}
export class RegistryCatalogUnavailable extends Error {}

// Credentials and tokens stay in the main process. Never follow authenticated redirects.
export class RegistryClient {
  private origin: string
  constructor(private registry: RegistryProfile, private password: string, private request: typeof fetch = fetch) {
    this.origin = new URL(`https://${['docker.io', 'index.docker.io'].includes(registry.server) ? 'registry-1.docker.io' : registry.server}`).origin
  }
  private async get(path: string): Promise<Response> {
    const url = new URL(path, this.origin)
    if (url.origin !== this.origin || !url.pathname.startsWith('/v2/')) throw new Error('仓库分页地址不可信')
    const send = (authorization?: string) => this.request(url, { headers: authorization ? { Authorization: authorization } : {}, redirect: 'error', signal: AbortSignal.timeout(20000) })
    let response = await send()
    if (response.status !== 401) return response
    const challenge = response.headers.get('www-authenticate') || ''
    const basic = 'Basic ' + Buffer.from(`${this.registry.username}:${this.password}`).toString('base64')
    if (/^Basic\s/i.test(challenge)) return send(basic)
    if (!/^Bearer\s/i.test(challenge)) throw new Error('仓库未提供支持的认证方式')
    const parts = Object.fromEntries([...challenge.matchAll(/([a-z]+)="([^"]*)"/gi)].map(match => [match[1].toLowerCase(), match[2]]))
    let realm: URL
    try { realm = new URL(parts.realm) } catch { throw new Error('仓库未返回有效的认证服务地址，未发送登录凭据') }
    // A registry can delegate authentication to a separate HTTPS service (e.g. Aliyun).
    // Trust its challenge over the configured registry's verified TLS connection, not an
    // origin allowlist. Still reject insecure endpoints and authenticated redirects.
    if (realm.protocol !== 'https:' || realm.username || realm.password || realm.hash) throw new Error('仓库认证服务必须使用不含用户信息和片段的 HTTPS 地址，未发送登录凭据')
    if (parts.service) realm.searchParams.set('service', parts.service)
    if (parts.scope) realm.searchParams.set('scope', parts.scope)
    const tokenResponse = await this.request(realm, { headers: { Authorization: basic }, redirect: 'error', signal: AbortSignal.timeout(20000) })
    if (!tokenResponse.ok) throw new Error(`仓库身份认证失败 (${tokenResponse.status})`)
    const token = await tokenResponse.json() as { token?: string; access_token?: string }
    if (!(token.token || token.access_token)) throw new Error('仓库认证没有返回访问令牌')
    response = await send('Bearer ' + (token.token || token.access_token))
    return response
  }
  private async pages(path: string, key: string): Promise<string[]> {
    const result = new Set<string>(), visited = new Set<string>()
    for (let page = 0; path && page < 100; page++) {
      if (visited.has(path)) throw new Error('仓库返回了重复分页地址')
      visited.add(path)
      const response = await this.get(path)
      if (!response.ok) {
        if (key === 'repositories' && [401, 403, 404, 405].includes(response.status)) {
          throw new RegistryCatalogUnavailable(`仓库目录不可用或当前账号无权列出目录 (${response.status})`)
        }
        throw new Error(`镜像${key === 'tags' ? '标签' : '仓库'}读取失败 (${response.status})`)
      }
      const body = await response.json() as Record<string, unknown>
      if (body[key] !== null && !Array.isArray(body[key])) throw new Error('镜像仓库返回的数据格式不正确')
      for (const value of (body[key] || []) as unknown[]) if (typeof value === 'string') result.add(value)
      const link = response.headers.get('link') || ''
      const next = link.split(',').find(item => /rel="?next"?/i.test(item))?.match(/<([^>]+)>/)?.[1]
      path = next ? new URL(next, new URL(path, this.origin)).href : ''
    }
    if (path) throw new Error('镜像列表超过 100 页，请使用具体镜像路径缩小范围')
    return [...result].sort()
  }
  async checkConnection(): Promise<void> {
    const response = await this.get('/v2/')
    if (!response.ok) throw new Error(`镜像仓库连接验证失败 (${response.status})，请检查账号和仓库地址`)
  }
  repositories(): Promise<string[]> { return this.pages('/v2/_catalog?n=100', 'repositories') }
  tags(repository: string): Promise<string[]> { return this.pages(`/v2/${repositoryName(repository)}/tags/list?n=100`, 'tags') }
}
