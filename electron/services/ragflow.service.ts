import { app, safeStorage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RagflowConfig, RagflowInput } from '../../src/types/ragflow'
import { normalizeRagflowUrl, validateDatasetId, RagflowClient } from './ragflow-client'
interface Stored { baseUrl: string; datasetId: string; credential: string }
const defaults: Stored = { baseUrl: 'http://127.0.0.1:14310', datasetId: 'fec3d0e093d34a0c91a5fe1b65841f0e', credential: '' }
const filename = () => join(app.getPath('userData'), 'ragflow-v1.json')
function load(): Stored { return existsSync(filename()) ? JSON.parse(readFileSync(filename(), 'utf8')) : { ...defaults } }
function publicConfig(config: Stored): RagflowConfig { return { baseUrl: config.baseUrl, datasetId: config.datasetId, hasApiKey: !!config.credential } }
function resolve(input: RagflowInput): { baseUrl: string; datasetId: string; apiKey: string } {
  const baseUrl = normalizeRagflowUrl(input.baseUrl), datasetId = validateDatasetId(input.datasetId), stored = load()
  const apiKey = input.apiKey?.trim() || (stored.baseUrl === baseUrl && stored.credential ? safeStorage.decryptString(Buffer.from(stored.credential, 'base64')) : '')
  if (!apiKey) throw new Error('请填写 API Key；更换服务地址后需要重新填写')
  if (/[\r\n]/.test(apiKey)) throw new Error('API Key 格式不正确')
  return { baseUrl, datasetId, apiKey }
}
export const ragflowService = {
  getConfig: () => publicConfig(load()),
  connection() {
    const config = resolve(load())
    if (!config.datasetId) throw new Error('请在设置中选择并保存 RAGFlow 知识库')
    return { baseUrl: config.baseUrl, datasetId: config.datasetId, client: new RagflowClient(config.baseUrl, config.apiKey) }
  },
  saveConfig(input: RagflowInput): RagflowConfig {
    const config = resolve(input)
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('系统安全存储不可用，不能保存 API Key')
    const stored: Stored = { baseUrl: config.baseUrl, datasetId: config.datasetId, credential: safeStorage.encryptString(config.apiKey).toString('base64') }
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(filename() + '.tmp', JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 })
    renameSync(filename() + '.tmp', filename())
    return publicConfig(stored)
  },
  async test(input: RagflowInput) {
    const config = resolve(input), datasets = await new RagflowClient(config.baseUrl, config.apiKey).datasets()
    const selected = datasets.find(item => item.id === config.datasetId) || null
    if (config.datasetId && !selected) throw new Error('认证成功，但指定知识库不存在或当前 API Key 无权访问；可清空知识库 ID 后测试并重新选择')
    return { datasets, selected }
  },
  async documents() {
    const config = resolve(load())
    return new RagflowClient(config.baseUrl, config.apiKey).documents(config.datasetId)
  },
  async open() {
    const config = load(), baseUrl = normalizeRagflowUrl(config.baseUrl), datasetId = validateDatasetId(config.datasetId)
    await shell.openExternal(datasetId ? `${baseUrl}/dataset/files/${encodeURIComponent(datasetId)}` : baseUrl)
  }
}
