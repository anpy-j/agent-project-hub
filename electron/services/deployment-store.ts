import { app, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { DeployConfig, HostInput, HostProfile, RegistryInput, RegistryProfile, ReleaseJob } from '../../src/types/deployment'
import { validateHost, validateRegistry } from './deployment-validation'

type StoredRegistry = RegistryProfile & { credential: string }
type StoredHost = HostProfile & { credential: string }
interface State { registries: StoredRegistry[]; hosts: StoredHost[]; configs: DeployConfig[]; jobs: ReleaseJob[] }
let state: State | undefined
const filename = () => join(app.getPath('userData'), 'deployment-v1.json')
function load(): State {
  if (!state) {
    state = existsSync(filename()) ? JSON.parse(readFileSync(filename(), 'utf8')) : { registries: [], hosts: [], configs: [], jobs: [] }
    for (const job of state!.jobs) if (job.status === 'running') {
      job.status = 'interrupted'; job.stage = '应用退出，检查服务器实际状态后再发布'; job.endedAt = new Date().toISOString()
    }
  }
  return state!
}
function persist(): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(filename() + '.tmp', JSON.stringify(load()), { encoding: 'utf8', mode: 0o600 })
  renameSync(filename() + '.tmp', filename())
}
function encrypt(value: object): string {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('系统安全存储不可用，不能保存密码或私钥')
  return safeStorage.encryptString(JSON.stringify(value)).toString('base64')
}
function decrypt<T>(value: string): T { return JSON.parse(safeStorage.decryptString(Buffer.from(value, 'base64'))) }
function publicRegistry({ credential: _secret, ...profile }: StoredRegistry): RegistryProfile { return profile }
function publicHost({ credential: _secret, ...profile }: StoredHost): HostProfile { return profile }
export const deploymentStore = {
  registries: () => load().registries.map(publicRegistry),
  hosts: () => load().hosts.map(publicHost),
  saveRegistry(input: RegistryInput): RegistryProfile {
    validateRegistry(input)
    const s = load(), existing = s.registries.find(r => r.id === input.id)
    const unchanged = existing?.server === input.server && existing?.username === input.username
    const credential = input.password ? encrypt({ password: input.password }) : unchanged ? existing!.credential : ''
    if (!credential) throw new Error('请填写仓库密码；更换地址或账号需重新输入')
    const row: StoredRegistry = { id: existing?.id || randomUUID(), name: input.name.trim(), server: input.server, username: input.username, hasPassword: true, credential }
    s.registries = [...s.registries.filter(r => r.id !== row.id), row]; persist(); return publicRegistry(row)
  },
  saveHost(input: HostInput): HostProfile {
    validateHost(input)
    const s = load(), existing = s.hosts.find(h => h.id === input.id)
    const unchanged = existing?.host === input.host && existing?.port === input.port && existing?.username === input.username && existing?.authKind === input.authKind
    const supplied = input.authKind === 'password' ? !!input.password : !!input.privateKey
    const credential = supplied ? encrypt(input.authKind === 'password' ? { password: input.password } : { privateKey: input.privateKey, passphrase: input.passphrase }) : unchanged ? existing!.credential : ''
    const row: StoredHost = { id: existing?.id || randomUUID(), name: input.name.trim(), host: input.host, port: input.port, username: input.username, authKind: input.authKind, fingerprint: input.fingerprint || '', hasCredential: !!credential, credential }
    s.hosts = [...s.hosts.filter(h => h.id !== row.id), row]; persist(); return publicHost(row)
  },
  registry(id: string): StoredRegistry { const r = load().registries.find(r => r.id === id); if (!r) throw new Error('镜像仓库不存在'); return r },
  host(id: string): StoredHost { const h = load().hosts.find(h => h.id === id); if (!h) throw new Error('服务器不存在'); return h },
  registrySecret(id: string): { password: string } { return decrypt(this.registry(id).credential) },
  hostSecret(id: string): { password?: string; privateKey?: string; passphrase?: string } {
    const h = this.host(id); if (!h.credential) throw new Error('请先填写服务器登录凭据'); return decrypt(h.credential)
  },
  removeRegistry(id: string): void {
    if (load().configs.some(c => c.registryId === id)) throw new Error('仓库仍被项目发布配置引用，请先更换配置')
    load().registries = load().registries.filter(r => r.id !== id); persist()
  },
  removeHost(id: string): void {
    if (load().configs.some(c => c.hostId === id)) throw new Error('服务器仍被项目发布配置引用，请先更换配置')
    load().hosts = load().hosts.filter(h => h.id !== id); persist()
  },
  config: (id: string) => load().configs.find(c => c.projectId === id) || null,
  saveConfig(config: DeployConfig): DeployConfig { load().configs = [...load().configs.filter(c => c.projectId !== config.projectId), config]; persist(); return config },
  jobs: () => load().jobs,
  saveJob(job: ReleaseJob): void {
    const jobs = load().jobs.filter(j => j.id !== job.id)
    load().jobs = [job, ...jobs].slice(0, 100); persist()
  }
}
