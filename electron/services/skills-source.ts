import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { get } from 'node:https'
import { SKILL_LIMITS } from './skills-files'
import type { SkillSource } from '../../src/types/skills'

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)))
  }
  // Only globally routable IPv6; reject mapped IPv4 and private/link-local ranges.
  return isIP(address) === 6 && /^[23][a-f0-9]{3}:/i.test(address) && !/^2001:db8:/i.test(address)
}

export async function downloadSkill(url: string, redirects = 0): Promise<Buffer> {
  if (redirects > 5) throw new Error('下载重定向次数过多')
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw new Error('仅支持无内嵌凭据的 HTTPS 公共下载链接')
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true })
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('下载链接不能指向本机、内网或保留地址')
  const pinned = addresses[0]
  return new Promise<Buffer>((resolve, reject) => {
    const request = get(parsed, {
      headers: { 'User-Agent': 'Project-Hub-Skills', Accept: 'application/vnd.github+json, application/octet-stream;q=0.9' },
      lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
      family: pinned.family,
      timeout: 30000
    }, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume(); downloadSkill(new URL(response.headers.location, parsed).href, redirects + 1).then(resolve, reject); return
      }
      if (response.statusCode !== 200) {
        response.resume(); reject(new Error(`下载失败（HTTP ${response.statusCode}），请检查链接、访问权限或 GitHub API 限流`)); return
      }
      if (Number(response.headers['content-length']) > SKILL_LIMITS.download) { response.destroy(); reject(new Error('下载文件超过 32 MB')); return }
      const chunks: Buffer[] = []; let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > SKILL_LIMITS.download) { response.destroy(new Error('下载文件超过 32 MB')); return }
        chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error('下载超时，请稍后重试')))
    request.on('error', reject)
  })
}

async function githubJSON(path: string): Promise<any> {
  return JSON.parse((await downloadSkill(`https://api.github.com${path}`)).toString('utf8'))
}

export async function resolveGithub(location: string, requestedRef?: string): Promise<{ source: SkillSource; archive: string }> {
  const url = new URL(location)
  if (url.protocol !== 'https:' || url.username || url.password || !['github.com', 'www.github.com', 'raw.githubusercontent.com'].includes(url.hostname)) throw new Error('请输入 GitHub 的 HTTPS 仓库、目录或 SKILL.md 链接')
  const pieces = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const owner = pieces[0], repo = pieces[1]?.replace(/\.git$/, '')
  if (!owner || !repo || !/^[a-z0-9_.-]+$/i.test(owner + repo)) throw new Error('无法识别 GitHub 仓库')
  const base = `/repos/${owner}/${repo}`
  const tail = url.hostname === 'raw.githubusercontent.com' ? pieces.slice(2) : ['tree', 'blob'].includes(pieces[2]) ? pieces.slice(3) : []
  let ref = requestedRef?.trim(), subpath = '', commit: string
  if (ref) {
    if (tail.length) {
      const refParts = ref.split('/')
      const prefixMatches = refParts.every((p, i) => tail[i] === p)
      subpath = tail.slice(prefixMatches ? refParts.length : 1).join('/')
    }
    commit = (await githubJSON(`${base}/commits/${encodeURIComponent(ref)}`)).sha
  } else if (tail.length) {
    let resolved: { ref: string; sha: string; used: number } | undefined
    // A slash is valid in branch names. Probe longest prefixes instead of assuming a one-segment ref.
    for (let used = Math.min(tail.length, 10); used >= 1; used--) {
      const candidate = tail.slice(0, used).join('/')
      try { const data = await githubJSON(`${base}/commits/${encodeURIComponent(candidate)}`); resolved = { ref: candidate, sha: data.sha, used }; break } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('HTTP 404') && !error.message.includes('HTTP 422')) throw error
      }
    }
    if (!resolved) throw new Error('无法识别分支或标签，请填写版本/ref')
    ref = resolved.ref; commit = resolved.sha; subpath = tail.slice(resolved.used).join('/')
  } else {
    ref = (await githubJSON(base)).default_branch
    commit = (await githubJSON(`${base}/commits/${encodeURIComponent(ref!)}`)).sha
  }
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error('GitHub 未返回有效提交')
  if (subpath.endsWith('/SKILL.md') || subpath === 'SKILL.md') subpath = subpath.split('/').slice(0, -1).join('/')
  return { source: { kind: 'github', location: `https://github.com/${owner}/${repo}`, ref, commit, subpath }, archive: `https://api.github.com${base}/zipball/${commit}` }
}
