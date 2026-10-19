import { RegistryCatalogUnavailable, type RegistryClient } from './registry-client'
import type { RegistryCatalog } from '../../src/types/deployment'

export async function readRegistryCatalog(client: Pick<RegistryClient, 'repositories' | 'checkConnection'>, known: string[]): Promise<RegistryCatalog> {
  try { return { repositories: await client.repositories(), mode: 'catalog' } }
  catch (error) {
    if (!(error instanceof RegistryCatalogUnavailable)) throw error
    // Verify the connection separately: catalog access and registry login are different capabilities.
    await client.checkConnection()
    return {
      repositories: [...new Set(known)].sort(), mode: 'tracked',
      notice: '仓库连接正常，但 Docker 通用目录接口不可用或当前凭据无权列出目录。阿里云个人版可在全局连接中启用管理 API 并配置专用只读 AccessKey；也可在右侧添加具体镜像路径，验证后保存到全局连接。'
    }
  }
}
