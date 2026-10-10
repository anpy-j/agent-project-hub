import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import type { GitChange, GitPlatform, GitSummary } from '../../src/types'

export function detectPlatformOf(url: string): GitPlatform {
  if (url.includes('github.com')) return 'github'
  if (url.includes('gitee.com')) return 'gitee'
  if (url.includes('gitlab')) return 'gitlab'
  return 'other'
}

function git(dir: string, args: string[], raw = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-optional-locks', '-C', dir, ...args], { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(raw ? String(stdout || '') : String(stdout || '').trim())
    })
  })
}

export function parseGitChanges(output: string): GitChange[] {
  const records = output.split('\0')
  const changes: GitChange[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    const status = record.slice(0, 2)
    changes.push({
      status: status.trim() || 'M', path: record.slice(3),
      indexStatus: status[0].trim(), worktreeStatus: status[1].trim()
    })
    // porcelain -z 的重命名/复制记录先输出目标路径，再输出原路径。
    if (/[RC]/.test(status)) i++
  }
  return changes
}

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

export async function readRemotes(dir: string): Promise<Array<{ name: string; url: string; platform: GitPlatform; is_default: number }>> {
  if (!isGitRepo(dir)) return []
  try {
    const out = await git(dir, ['remote', '-v'])
    const seen = new Map<string, string>()
    for (const line of out.split('\n')) {
      const match = line.trim().match(/^(\S+)\s+(.+?)\s+\(fetch\)$/)
      if (!match) continue
      const [, name, url] = match
      if (!seen.has(name)) seen.set(name, url)
    }
    return [...seen.entries()].map(([name, url]) => ({
      name,
      url,
      platform: detectPlatformOf(url),
      is_default: name === 'origin' ? 1 : 0
    })).map((r, i) => (i === 0 && !seen.has('origin') ? { ...r, is_default: 1 } : r))
  } catch {
    return []
  }
}

export async function gitSummary(dir: string): Promise<GitSummary> {
  if (!isGitRepo(dir)) {
    return { isGit: false, branch: null, ahead: 0, behind: 0, changes: [], lastCommit: null }
  }
  const empty: GitSummary = { isGit: true, branch: null, ahead: 0, behind: 0, changes: [], lastCommit: null }
  try {
    const branch = await git(dir, ['symbolic-ref', '--short', 'HEAD']).catch(() => '(detached)')
    let ahead = 0
    let behind = 0
    const upstream = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => null)
    let pendingCommits: GitCommit[] = []
    try {
      // 无上游时，以本地已知的所有远程引用为依据，避免把已发布历史全部算作待推送。
      const range = upstream ? ['@{upstream}..HEAD'] : ['HEAD', '--not', '--remotes']
      const [count, raw, behindCount] = await Promise.all([
        git(dir, ['rev-list', '--count', ...range]),
        git(dir, ['log', '-50', '--pretty=format:%h%x00%s%x00%an%x00%aI%x00', ...range], true),
        upstream ? git(dir, ['rev-list', '--count', 'HEAD..@{upstream}']) : Promise.resolve('0')
      ])
      ahead = Number(count)
      behind = Number(behindCount)
      const fields = raw.split('\0')
      for (let i = 0; i + 3 < fields.length; i += 4) {
        pendingCommits.push({ hash: fields[i].trim(), message: fields[i + 1], author: fields[i + 2], date: fields[i + 3] })
      }
    } catch {
      // 无 upstream
    }
    let lastCommit: GitSummary['lastCommit'] = null
    try {
      const raw = await git(dir, ['log', '-1', '--pretty=format:%h|%s|%an|%aI'])
      const [hash, message, author, date] = raw.split('|')
      if (hash) lastCommit = { hash, message: message || '', author: author || '', date: date || '' }
    } catch {
      // 空仓库
    }
    let changes: GitChange[] = []
    try {
      const st = await git(dir, ['status', '--porcelain=v1', '-z'], true)
      changes = parseGitChanges(st)
    } catch {
      // ignore
    }
    return { isGit: true, branch, ahead, behind, upstream, pendingCommits, changes, lastCommit }
  } catch {
    return empty
  }
}

export interface GitCommit {
  hash: string
  message: string
  author: string
  date: string
}

export async function gitLog(dir: string, count = 20): Promise<GitCommit[]> {
  if (!isGitRepo(dir)) return []
  try {
    const raw = await git(dir, ['log', `-${count}`, '--pretty=format:%h|%s|%an|%aI'])
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, message, author, date] = line.split('|')
        return { hash: hash || '', message: message || '', author: author || '', date: date || '' }
      })
  } catch {
    return []
  }
}

export async function gitInit(dir: string): Promise<void> {
  if (!isGitRepo(dir)) {
    await git(dir, ['init', '-b', 'main'])
  }
}

export async function gitSetRemote(dir: string, name: string, url: string): Promise<void> {
  try {
    await git(dir, ['remote', 'add', name, url])
  } catch {
    await git(dir, ['remote', 'set-url', name, url])
  }
}

export async function gitCommitAll(dir: string, message: string): Promise<string> {
  await git(dir, ['add', '-A'])
  const status = await git(dir, ['status', '--porcelain'])
  if (!status.trim()) return '没有可提交的变更'
  await git(dir, ['commit', '-m', message])
  return '已提交全部变更'
}

export async function gitPushUpstream(dir: string): Promise<string> {
  await git(dir, ['push', '-u', 'origin', 'HEAD'])
  return '已推送到远端并建立跟踪'
}

export async function gitPullSafe(dir: string): Promise<string> {
  await git(dir, ['pull'])
  return '已拉取远端更新'
}

export async function gitCommitFiles(dir: string, paths: string[] | null, message: string): Promise<string> {
  if (paths && paths.length) {
    await git(dir, ['add', '--', ...paths])
  } else {
    await git(dir, ['add', '-A'])
  }
  try {
    await git(dir, ['diff', '--cached', '--quiet'])
    return '没有可提交的变更'
  } catch {
    // 有暂存内容，继续提交
  }
  await git(dir, ['commit', '-m', message])
  return `已提交：${message}`
}

export async function gitPushSimple(dir: string): Promise<string> {
  await git(dir, ['push'])
  return '已推送到远端'
}

export function toWebUrl(url: string): string {
  const m = url.match(/^git@([^:]+):(.+?)(\.git)?$/)
  if (m) return `https://${m[1]}/${m[2]}`
  return url.replace(/\.git$/, '')
}

export interface GitBranch {
  name: string
  current: boolean
}

export async function gitBranches(dir: string): Promise<GitBranch[]> {
  if (!isGitRepo(dir)) return []
  try {
    const out = await git(dir, ['branch', '--format=%(refname:short)|%(HEAD)'])
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, head] = line.split('|')
        return { name, current: head.trim() === '*' }
      })
  } catch {
    return []
  }
}

export async function gitCheckout(dir: string, branch: string, create = false): Promise<string> {
  const args = create ? ['checkout', '-b', branch] : ['checkout', branch]
  await git(dir, args)
  return `已切换到 ${branch}`
}
