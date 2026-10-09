import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, isAbsolute } from 'node:path'
import type { GitAuthSnapshot, GitAuthResult } from '../../src/types/git-auth'

function run(bin: string, args: string[], timeout = 10000): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    execFile(bin, args, { timeout, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout || ''}${stderr || ''}`.trim() })
    })
  })
}

export function parsePublicKey(line: string) {
  const match = line.trim().match(/^(ssh-\S+|ecdsa-\S+|sk-\S+)\s+([A-Za-z0-9+/=]+)(?:\s+(.*))?$/)
  if (!match) return null
  const fingerprint = 'SHA256:' + createHash('sha256').update(Buffer.from(match[2], 'base64')).digest('base64').replace(/=+$/, '')
  return { type: match[1], fingerprint, comment: match[3] || '', publicKey: line.trim() }
}

export async function gitAuthSnapshot(): Promise<GitAuthSnapshot> {
  const root = join(homedir(), '.ssh')
  const [version, username, email, helpers, agent] = await Promise.all([
    run('git', ['--version']), run('git', ['config', '--global', '--get', 'user.name']),
    run('git', ['config', '--global', '--get', 'user.email']),
    run('git', ['config', '--get-all', 'credential.helper']), run('ssh-add', ['-L'])
  ])
  const snapshot: GitAuthSnapshot = {
    version: version.ok ? version.output : '未检测到 Git', username: username.ok ? username.output : '',
    email: email.ok ? email.output : '', helpers: helpers.ok ? helpers.output.split('\n').map(h => {
      const known = ['osxkeychain', 'manager', 'manager-core', 'wincred', 'libsecret', 'cache', 'store']
      return known.find(k => h.trim().split(/\s/)[0] === k) || '自定义凭据管理器'
    }) : [], keys: [], hosts: [], warnings: [],
    agentStatus: agent.ok ? '可用' : /no identities/i.test(agent.output) ? '未加载密钥' : '不可用'
  }
  const loaded = new Set(agent.output.split('\n').map(parsePublicKey).filter(Boolean).map(k => k!.fingerprint))
  const paths = new Set<string>()
  try {
    for (const file of await readdir(root)) if (file.endsWith('.pub')) paths.add(join(root, file))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') snapshot.warnings.push('无法读取 SSH 目录')
  }
  try {
    const config = await readFile(join(root, 'config'), 'utf8')
    let current: GitAuthSnapshot['hosts'] = []
    for (const line of config.split('\n')) {
      const match = line.trim().match(/^(Host|HostName|IdentityFile|Include)\s+(?:=\s*)?(.+)$/i)
      if (!match) continue
      const key = match[1].toLowerCase(), value = match[2].replace(/\s+#.*$/, '').replace(/^"|"$/g, '')
      if (key === 'include') snapshot.warnings.push('SSH 配置含 Include，部分外部密钥可能未列出；连接测试仍使用完整本机配置')
      if (key === 'host') {
        current = value.split(/\s+/).filter(h => !/[*!?]/.test(h)).map(alias => ({ alias, hostname: alias, identityFile: '' }))
        snapshot.hosts.push(...current)
      }
      if (key === 'hostname') current.forEach(h => { h.hostname = value })
      if (key === 'identityfile') {
        const path = value.replace(/^~(?=\/)/, homedir()).replace(/%d/g, homedir())
        current.forEach(h => { h.identityFile = path })
        if (isAbsolute(path) && !path.includes('%')) paths.add(path.endsWith('.pub') ? path : path + '.pub')
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') snapshot.warnings.push('无法读取 SSH 配置')
  }
  for (const path of paths) {
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > 64 * 1024) continue
      const key = parsePublicKey(await readFile(path, 'utf8'))
      if (!key) continue
      const privateKeyExists = await stat(path.slice(0, -4)).then(s => s.isFile(), () => false)
      snapshot.keys.push({ ...key, path, name: basename(path), privateKeyExists, loaded: loaded.has(key.fingerprint) })
    } catch { snapshot.warnings.push(`无法读取公钥：${basename(path)}`) }
  }
  return snapshot
}

export function classifyGitAuth(output: string, success: boolean, repository: boolean): GitAuthResult {
  const checkedAt = new Date().toISOString()
  if (success || (!repository && /successfully authenticated|successfully auth|welcome to (gitee|gitlab)|Hi .+!.*authenticated/is.test(output))) {
    return { status: 'success', message: repository ? '仓库可读取（公开仓库无需账号认证；读取成功不代表可推送）' : 'SSH 认证成功', checkedAt }
  }
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(output)) return { status: 'host-untrusted', message: '主机身份未确认或发生变化，请先核实主机指纹', checkedAt }
  if (/permission denied|authentication failed|could not read Username|terminal prompts disabled|access denied|repository not found/i.test(output)) return { status: 'auth-failed', message: '认证失败或没有仓库访问权限，请检查密钥、凭据和仓库地址', checkedAt }
  if (/timed out|could not resolve|connection refused|network is unreachable|unable to access|connection reset/i.test(output)) return { status: 'network-failed', message: '网络连接失败，请检查网络、主机和端口', checkedAt }
  return { status: 'unknown', message: '未能确认认证状态，可能超时、认证需要交互或平台返回格式不受支持', checkedAt }
}

export async function testGitAuth(data: { platform: string; url?: string }): Promise<GitAuthResult> {
  if (data.url?.trim()) {
    const url = data.url.trim()
    if (!/^(https:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:)/i.test(url) || /[\s\x00-\x1f]/.test(url)) throw new Error('请输入有效的仓库地址')
    if (/^https:\/\//i.test(url) && new URL(url).password) throw new Error('请使用本机凭据管理器，不要在地址中填写密码或 Token')
    const result = await new Promise<{ ok: boolean; output: string }>(resolve => {
      execFile('git', ['ls-remote', '--', url], { timeout: 20000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10' } }, (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout || ''}${stderr || ''}` }))
    })
    return classifyGitAuth(result.output, result.ok, true)
  }
  const host = data.platform === 'github' ? 'github.com' : data.platform === 'gitee' ? 'gitee.com' : ''
  if (!host) throw new Error('请填写该平台的仓库地址，以检测实际仓库主机')
  const result = await run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', `git@${host}`], 15000)
  return classifyGitAuth(result.output, result.ok, false)
}
