import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { StringDecoder } from 'string_decoder'
import { BrowserWindow } from 'electron'
import { projectRepo } from '../db/repositories'
import { deploymentStore as store } from './deployment-store'
import { connectHost, sshExec } from './deployment-ssh'
import { deployScript } from './deployment-script'
import { prepareDockerBuild } from './deployment-build'
import { dockerfilePath, quote, remoteCommand, validateConfig } from './deployment-validation'
import type { DeployConfig, ReleaseAction, ReleaseJob, RemoteAction, RemoteSnapshot } from '../../src/types/deployment'

const activeProjects = new Set<string>(), activeHosts = new Set<string>()
export function hasActiveReleases(): boolean { return activeProjects.size > 0 }
export function hostBusy(id: string): boolean { return activeHosts.has(id) }
export function dockerCommand(args: string[], options: { cwd?: string; input?: string; log?: (text: string) => void; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: options.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, options.timeout || 20 * 60 * 1000)
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8')
    const append = (text: string) => { output = (output + text).slice(-512000); options.log?.(text) }
    child.stdout.on('data', data => append(stdout.write(data)))
    child.stderr.on('data', data => append(stderr.write(data)))
    child.stdin.on('error', () => { /* exit/error handlers report the command failure */ })
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Docker 不可用：${error.message}`)) })
    child.on('close', code => {
      clearTimeout(timer); append(stdout.end()); append(stderr.end())
      if (timedOut || code !== 0) reject(new Error(timedOut ? 'Docker 命令超时' : `Docker 命令失败 (${code})\n${output.slice(-4000)}`))
      else resolve(output)
    })
    child.stdin.end(options.input || '')
  })
}
async function withDockerConfig<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'project-hub-docker-'))
  try { return await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}
export async function testRegistry(id: string): Promise<string> {
  const registry = store.registry(id), secret = store.registrySecret(id)
  await withDockerConfig(directory => dockerCommand(['--config', directory, 'login', registry.server, '-u', registry.username, '--password-stdin'], { input: secret.password + '\n', timeout: 60000 }))
  return '仓库登录成功（临时登录凭据已清理）'
}
async function withHost<T>(id: string, run: (client: Awaited<ReturnType<typeof connectHost>>) => Promise<T>): Promise<T> {
  const client = await connectHost(store.host(id), store.hostSecret(id))
  try { return await run(client) } finally { client.end() }
}
export async function testHost(id: string): Promise<string> {
  return withHost(id, client => sshExec(client, 'uname -sm; docker version --format "{{.Server.Version}}"; docker compose version'))
}
function jsonLines(text: string): Array<Record<string, string>> {
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
export async function remoteSnapshot(id: string): Promise<RemoteSnapshot> {
  return withHost(id, async client => {
    // Commands are independent; a host without systemd can still inspect Docker.
    const metrics = await sshExec(client, `set -e
cpu_sample() { awk '/^cpu / {total=0; for(i=2;i<=9;i++) total+=$i; print total,$5+$6}' /proc/stat; }
first=$(cpu_sample)
sleep 0.4
second=$(cpu_sample)
awk -v first="$first" -v second="$second" 'BEGIN {split(first,a); split(second,b); total=b[1]-a[1]; idle=b[2]-a[2]; if(total>0) printf "CPU: %.1f%%\\n",100*(1-idle/total)}'
uptime
free -h
df -h /`)
    const containers = jsonLines(await sshExec(client, `docker ps -a --format '{{json .}}'`))
    const images = jsonLines(await sshExec(client, `docker images --format '{{json .}}'`))
    let services: RemoteSnapshot['services'] = []
    try {
      const text = await sshExec(client, 'systemctl list-units --type=service --all --no-pager --no-legend --plain')
      services = text.split('\n').map(line => line.trim().replace(/^[●○•]\s*/, '').split(/\s+/)).filter(parts => parts.length >= 4)
        .map(parts => ({ name: parts[0], active: parts[2], sub: parts[3], description: parts.slice(4).join(' ') }))
    } catch { /* systemd is optional; Docker management remains available */ }
    return { metrics, containers, images, services }
  })
}
export async function remoteAction(id: string, request: RemoteAction): Promise<string> {
  if (activeHosts.has(id)) throw new Error('该服务器正在发布，请等待发布完成')
  const command = remoteCommand(request)
  activeHosts.add(id)
  try { return await withHost(id, client => sshExec(client, command, { timeout: request.action === 'pull' ? 10 * 60 * 1000 : 60000 })) }
  finally { activeHosts.delete(id) }
}
export function saveDeployConfig(config: DeployConfig): DeployConfig {
  validateConfig(config)
  const project = projectRepo.get(config.projectId)
  if (!project) throw new Error('项目不存在')
  dockerfilePath(project.path, config.dockerfile)
  store.registry(config.registryId)
  if (config.hostId) store.host(config.hostId)
  if (activeProjects.has(config.projectId)) throw new Error('项目正在发布，不能修改配置')
  return store.saveConfig(config)
}
export function startRelease(projectId: string, action: ReleaseAction): string {
  if (!['build', 'push', 'deploy', 'all'].includes(action)) throw new Error('不支持的发布动作')
  if (activeProjects.has(projectId)) throw new Error('项目已有发布任务正在执行')
  const config = store.config(projectId), project = projectRepo.get(projectId)
  if (!config || !project) throw new Error('请先保存项目发布配置')
  validateConfig(config)
  const registry = store.registry(config.registryId)
  const deploy = action === 'deploy' || action === 'all'
  if (deploy) {
    const host = store.host(config.hostId)
    if (!host.fingerprint || !host.hasCredential) throw new Error('请配置服务器登录凭据并核对 SSH 指纹')
    if (activeHosts.has(host.id)) throw new Error('该服务器正在执行另一项操作')
  }
  const job: ReleaseJob = { id: randomUUID(), projectId, hostId: deploy ? config.hostId : '', action,
    image: `${registry.server}/${config.repository}:${config.tag}`, status: 'running', stage: '准备', startedAt: new Date().toISOString(), log: '' }
  activeProjects.add(projectId); if (deploy) activeHosts.add(config.hostId)
  publish(job)
  void executeRelease(job, { ...config }, project.path).catch(error => {
    job.status = 'failed'; job.stage = '失败'; job.log += '\n' + String(error); job.endedAt = new Date().toISOString(); publish(job)
  }).finally(() => { activeProjects.delete(projectId); if (deploy) activeHosts.delete(config.hostId) })
  return job.id
}
function publish(job: ReleaseJob): void {
  store.saveJob({ ...job })
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('deployment:job', { ...job })
}
async function executeRelease(job: ReleaseJob, config: DeployConfig, cwd: string): Promise<void> {
  const registry = store.registry(config.registryId), secret = store.registrySecret(config.registryId)
  const secretValues = [secret.password]
  const redact = (text: string) => secretValues.filter(Boolean).reduce((s, value) => s.split(value).join('[REDACTED]'), text)
  // Buffer command output before logging so secrets split across data chunks cannot leak.
  const log = (text: string) => { job.log = (job.log + redact(text)).slice(-100000); publish(job) }
  const stage = (text: string) => { job.stage = text; log(`\n--- ${text} ---\n`) }
  try {
    await withDockerConfig(async directory => {
      const docker = (args: string[], input?: string) => dockerCommand(['--config', directory, ...args], { cwd, input })
      if (job.action === 'build' || job.action === 'all') {
        const build = await prepareDockerBuild(cwd, config, job.image)
        stage('登录镜像仓库')
        await docker(['login', registry.server, '-u', registry.username, '--password-stdin'], secret.password + '\n')
        stage('Docker 构建')
        log(`Dockerfile：${build.file}\n构建目录：${build.context}\n`)
        log(await docker(build.args))
      }
      if (job.action === 'push' || job.action === 'all') {
        stage('上传镜像')
        await docker(['login', registry.server, '-u', registry.username, '--password-stdin'], secret.password + '\n')
        log(await docker(['push', job.image]))
      }
    })
    if (job.action === 'deploy' || job.action === 'all') {
      stage('服务器拉取、部署与健康检查')
      await withHost(config.hostId, async client => {
        log(await sshExec(client, `bash -c ${quote(deployScript(config, registry.server, registry.username, job.image))}`, { input: secret.password + '\n', timeout: 20 * 60 * 1000 }))
      })
    }
    job.status = 'success'; job.stage = '完成'
  } catch (error) {
    job.status = 'failed'; job.stage = '失败'; log('\n' + redact(error instanceof Error ? error.message : String(error)))
  } finally {
    job.endedAt = new Date().toISOString(); publish(job)
  }
}
