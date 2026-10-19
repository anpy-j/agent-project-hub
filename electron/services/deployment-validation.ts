import { validateAliyunRegion } from './aliyun-registry'
import { repositoryName } from './registry-client'
import { isAbsolute, relative, resolve } from 'path'
import type { DeployConfig, HostInput, RegistryInput, RemoteAction } from '../../src/types/deployment'

function requireMatch(value: string, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label}格式不正确`)
  return value
}
export function registryServer(value: string): string {
  return requireMatch(value, /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::[0-9]{1,5})?$/, '仓库地址（仅主机名，可带端口，不含 https://）')
}
export function validateRegistry(input: RegistryInput): void {
  registryServer(input.server)
  if (input.aliyun) {
    validateAliyunRegion(input.aliyun.regionId, input.server)
    if (!!input.aliyun.accessKeyId !== !!input.aliyun.accessKeySecret) throw new Error('AccessKey ID 和 Secret 必须一起填写；编辑时可同时留空保留')
    if (input.aliyun.accessKeyId && (!/^[A-Za-z0-9]{8,128}$/.test(input.aliyun.accessKeyId) || !/^[A-Za-z0-9+/=_-]{8,256}$/.test(input.aliyun.accessKeySecret || ''))) throw new Error('AccessKey 格式不正确，请检查是否包含空格或换行')
  }
  if (input.repositories !== undefined) {
    if (!Array.isArray(input.repositories) || input.repositories.length > 500) throw new Error('镜像路径最多保存 500 个')
    input.repositories.forEach(repositoryName)
  }
  if (!input.name?.trim() || !input.username?.trim() || /[\r\n\0]/.test(input.username)) throw new Error('请填写仓库名称和登录用户名')
}
export function validateEndpoint(host: string, port: number): void {
  requireMatch(host, /^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/, '主机地址')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口不正确')
}
export function validateHost(input: HostInput): void {
  validateEndpoint(input.host, input.port)
  requireMatch(input.username, /^[a-zA-Z_][a-zA-Z0-9_-]*$/, 'SSH 用户名')
  if (!input.name?.trim() || !['password', 'privateKey'].includes(input.authKind)) throw new Error('主机配置不正确')
  if (input.fingerprint) requireMatch(input.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/, 'SSH SHA256 指纹')
}
export function validateConfig(c: DeployConfig): void {
  if (c.portMappings !== undefined) {
    if (!Array.isArray(c.portMappings) || c.portMappings.length > 32) throw new Error('端口映射最多支持 32 条')
    const used: Array<{ hostPort: number; hostIp: string; protocol: string }> = []
    for (const mapping of c.portMappings) {
      if (!mapping || !['tcp', 'udp'].includes(mapping.protocol) || !['0.0.0.0', '127.0.0.1'].includes(mapping.hostIp)) throw new Error('端口映射协议或绑定地址不正确')
      for (const port of [mapping.hostPort, mapping.containerPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('映射端口必须是 1–65535 的整数')
      if (used.some(p => p.hostPort === mapping.hostPort && p.protocol === mapping.protocol && (p.hostIp === mapping.hostIp || p.hostIp === '0.0.0.0' || mapping.hostIp === '0.0.0.0'))) throw new Error('服务器端口映射重复或冲突')
      used.push(mapping)
    }
  }
  requireMatch(c.repository, /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/, '镜像路径（命名空间/仓库）')
  requireMatch(c.tag, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, '镜像标签')
  requireMatch(c.dockerfile, /^[a-zA-Z0-9_.\/-]+$/, 'Dockerfile 相对路径')
  if (c.buildContext) {
    requireMatch(c.buildContext, /^[a-zA-Z0-9_.\/-]+$/, '构建目录相对路径')
    if (c.buildContext.startsWith('/') || c.buildContext.split('/').includes('..')) throw new Error('构建目录必须位于项目内')
  }
  requireMatch(c.remoteDir, /^\/[a-zA-Z0-9_./-]+$/, '服务器绝对目录')
  if (c.remoteDir.split('/').includes('..')) throw new Error('服务器目录不能含 ..')
  requireMatch(c.composeFile, /^[a-zA-Z0-9_.\/-]+$/, 'Compose 相对路径')
  if (c.composeFile.startsWith('/') || c.composeFile.split('/').includes('..')) throw new Error('Compose 文件必须位于部署目录内')
  requireMatch(c.service, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Compose 服务名')
  requireMatch(c.composeProject, /^[a-z0-9][a-z0-9_-]*$/, 'Compose 项目名')
  if (!['linux/amd64', 'linux/arm64'].includes(c.platform)) throw new Error('请选择目标 CPU 架构')
}
export function dockerfilePath(root: string, path: string): string {
  const result = resolve(root, path)
  const rel = relative(root, result)
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Dockerfile 必须位于项目目录内')
  return result
}
export function quote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'` }
export function remoteCommand(request: RemoteAction): string {
  const { kind, action, target } = request
  if (kind === 'image') {
    requireMatch(target, /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/, '镜像名')
    if (!['pull', 'rmi'].includes(action)) throw new Error('不支持的镜像操作')
    return `docker ${action} ${quote(target)}`
  }
  if (kind === 'service') {
    requireMatch(target, /^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*\.service$/, 'systemd 服务名')
    if (!['start', 'stop', 'restart'].includes(action)) throw new Error('不支持的服务操作')
    return `systemctl ${action} ${quote(target)}`
  }
  requireMatch(target, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, '容器名')
  if (kind === 'logs' && action === 'tail') return `docker logs --tail 120 ${quote(target)}`
  if (kind !== 'container' || !['start', 'stop', 'pause', 'unpause', 'restart', 'rm'].includes(action)) throw new Error('不支持的容器操作')
  return `docker ${action} ${quote(target)}`
}
