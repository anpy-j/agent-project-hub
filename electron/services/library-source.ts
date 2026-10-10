import { createHash } from 'node:crypto'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import type { ResourceKind } from '../../src/types/library'
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024
export interface ExtractedSource { title: string; author: string; url: string; version: string; content: string; raw: string; warnings: string[] }
export const contentHash = (content: string) => createHash('sha256').update(content).digest('hex')
export function normalizeSourceUrl(input: string): string {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('请输入完整的 HTTP/HTTPS 链接') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('资料链接仅支持 HTTP/HTTPS，不能包含账号密码')
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key)
  if (url.hostname === 'github.com') {
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
    if (match) { url.pathname = `/${match[1]}/${match[2]}`; url.search = '' }
  }
  return url.toString()
}
export function inferKind(url: string, content = ''): ResourceKind {
  if (url && new URL(url).hostname === 'github.com' && /^\/[^/]+\/[^/]+\/?$/.test(new URL(url).pathname)) return 'github'
  if (/^---[\s\S]*?\nname:\s*[^\n]+[\s\S]*?\n---/.test(content)) return 'skill'
  return url ? 'article' : 'document'
}
export function identityTags(kind: ResourceKind, content: string): string[] {
  const tags: string[] = []
  if (kind === 'github') tags.push('GitHub')
  if (/\bMCP\b|model context protocol/i.test(content)) tags.push('MCP')
  if (/SKILL\.md|\bagent skill[s]?\b/i.test(content) || kind === 'skill') tags.push('Skill')
  return tags
}
function markdownNode(node: any, baseUrl: string): string {
  if (node.nodeType === 3) return node.textContent || ''
  if (node.nodeType !== 1) return ''
  const tag = node.tagName.toLowerCase()
  if (['script', 'style', 'iframe', 'form', 'button', 'svg', 'img', 'noscript'].includes(tag)) return ''
  const inner = [...node.childNodes].map(child => markdownNode(child, baseUrl)).join('')
  if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${inner.trim()}\n\n`
  if (tag === 'pre') return `\n\n\`\`\`\n${node.textContent}\n\`\`\`\n\n`
  if (tag === 'code') return `\`${inner}\``
  if (tag === 'br') return '\n'
  if (tag === 'li') return `\n- ${inner.trim()}\n`
  if (['p', 'div', 'section', 'article', 'ul', 'ol', 'table', 'tr', 'blockquote'].includes(tag)) return `\n\n${inner.trim()}\n\n`
  if (tag === 'td' || tag === 'th') return `${inner.trim()} | `
  if (tag === 'a') {
    try {
      const href = new URL(node.getAttribute('href') || '', baseUrl)
      if (['http:', 'https:'].includes(href.protocol) && inner.trim()) return `[${inner.trim().replace(/[\[\]]/g, '')}](${href.href})`
    } catch { /* Preserve text without unsafe links. */ }
  }
  return inner
}
export function extractHtml(html: string, url: string): ExtractedSource {
  const { document } = parseHTML(html)
  if (new URL(url).hostname === 'mp.weixin.qq.com') {
    const body = document.querySelector('#js_content')
    if (body && (body.textContent?.trim().length || 0) >= 20) {
      const content = markdownNode(body, url).replace(/\n{3,}/g, '\n\n').trim()
      if (content) return {
        title: document.querySelector('#activity-name')?.textContent?.trim() || document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.querySelector('title')?.textContent?.trim() || '微信公众号文章',
        author: document.querySelector('#js_name')?.textContent?.trim() || document.querySelector('.rich_media_meta_text')?.textContent?.trim() || '',
        url, version: '', content, raw: html, warnings: ['正文从微信公众号文章区域提取，图片未保存。']
      }
    }
    if (document.querySelector('#js_verify') || /环境异常|完成验证后|访问过于频繁/.test(document.querySelector('.weui-msg')?.textContent || '')) throw new Error('微信返回了访问验证页面，未获取到正文。请使用“浏览器获取”，手动完成验证后点击“保存当前文章”')
    throw new Error('微信页面未提供可读取的文章正文，可能已删除、需要登录或依赖脚本。请使用“浏览器获取”或补充正文')
  }
  const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.querySelector('title')?.textContent || ''
  const author = document.querySelector('meta[name="author"]')?.getAttribute('content') || ''
  const parsed = new Readability(document as unknown as Document, { charThreshold: 80 }).parse()
  if (!parsed?.content || (parsed.textContent?.trim().length || 0) < 80) throw new Error('未获取到足够的正文，可能需要登录或页面依赖脚本。请手动粘贴正文')
  const { document: article } = parseHTML(`<html><body>${parsed.content}</body></html>`)
  const content = markdownNode(article.body, url).replace(/\n{3,}/g, '\n\n').trim()
  if (!content) throw new Error('正文为空，请手动补充正文')
  return { title: parsed.title || title || new URL(url).hostname, author: parsed.byline || author, url, version: '', content, raw: html, warnings: ['网页正文由自动提取生成，可在原文页核对；图片未保存。'] }
}
export async function fetchLimited(url: string, accept = 'text/html,text/plain,application/json'): Promise<{ text: string; url: string; type: string }> {
  normalizeSourceUrl(url)
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000)
  try {
    let current = url, response: Response | undefined
    for (let i = 0; i < 6; i++) {
      response = await fetch(current, { headers: { Accept: accept, 'User-Agent': 'ProjectHub-Library/1.0' }, signal: controller.signal, redirect: 'manual' })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location || i === 5) throw new Error('链接重定向次数过多')
      current = normalizeSourceUrl(new URL(location, current).href)
    }
    if (!response?.ok) throw new Error(`获取内容失败（HTTP ${response?.status}），可手动粘贴正文；GitHub 可能达到公开 API 限额`)
    if (Number(response.headers.get('content-length')) > MAX_SOURCE_BYTES) throw new Error('资料超过 5MB，请拆分后导入')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('来源没有返回内容')
    const chunks: Uint8Array[] = []; let bytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_SOURCE_BYTES) { await reader.cancel(); throw new Error('资料超过 5MB，请拆分后导入') }
      chunks.push(value)
    }
    return { text: Buffer.concat(chunks).toString('utf8'), url: current, type: response.headers.get('content-type') || '' }
  } catch (e) {
    if (controller.signal.aborted) throw new Error('获取来源超时，请重试或手动粘贴正文')
    throw e
  } finally { clearTimeout(timeout) }
}
export async function fetchGithub(url: string): Promise<ExtractedSource> {
  const parts = new URL(url).pathname.split('/').filter(Boolean)
  const owner = encodeURIComponent(parts[0]), repo = encodeURIComponent(parts[1])
  const api = `https://api.github.com/repos/${owner}/${repo}`
  const meta = JSON.parse((await fetchLimited(api, 'application/vnd.github+json')).text)
  const commit = JSON.parse((await fetchLimited(`${api}/commits/${encodeURIComponent(meta.default_branch)}`, 'application/vnd.github+json')).text)
  if (!commit.sha) throw new Error('无法确定仓库版本')
  const readme = JSON.parse((await fetchLimited(`${api}/readme?ref=${encodeURIComponent(commit.sha)}`, 'application/vnd.github+json')).text)
  if (readme.encoding !== 'base64' || !readme.content) throw new Error('仓库没有可读取的 README，可手动粘贴使用文档')
  const markdown = Buffer.from(readme.content, 'base64').toString('utf8')
  const warnings = ['仓库分析基于 README 和最多 3 份关联 Markdown 文档，不代表完整代码审计。']
  const docs: string[] = [], rawDocs: object[] = []
  const basePath = readme.path?.includes('/') ? readme.path.slice(0, readme.path.lastIndexOf('/') + 1) : ''
  const candidates = [...markdown.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]*)?\)/gi)].map(match => match[1])
  for (const candidate of [...new Set(candidates)].slice(0, 3)) {
    try {
      if (/^(?:https?:|\/\/)/i.test(candidate)) continue
      const path = new URL(candidate, `https://github.com/${owner}/${repo}/blob/${commit.sha}/${basePath}`).pathname.split(`/blob/${commit.sha}/`)[1]
      if (!path || /(^|\/)\.\.(\/|$)/.test(path)) continue
      const doc = JSON.parse((await fetchLimited(`${api}/contents/${path.split('/').map(p => encodeURIComponent(decodeURIComponent(p))).join('/')}?ref=${commit.sha}`, 'application/vnd.github+json')).text)
      if (doc.encoding !== 'base64' || !doc.content) continue
      const text = Buffer.from(doc.content, 'base64').toString('utf8')
      if (Buffer.byteLength(markdown + docs.join('') + text) > MAX_SOURCE_BYTES) { warnings.push('关联文档过大，未全部收录'); break }
      docs.push(`\n\n## 关联文档：${path}\n\n${text}`); rawDocs.push(doc)
    } catch { warnings.push(`关联文档未能获取：${candidate}`) }
  }
  return { title: meta.full_name || `${parts[0]}/${parts[1]}`, author: meta.owner?.login || parts[0], url, version: commit.sha, content: `# ${meta.full_name}\n\n${meta.description || ''}\n\n来源：${url}\n提交版本：${commit.sha}\n\n${markdown}${docs.join('')}`, raw: JSON.stringify({ meta, commit: commit.sha, readme, docs: rawDocs }), warnings }
}
export async function fetchSource(url: string, kind: ResourceKind): Promise<ExtractedSource> {
  if (new URL(url).hostname === 'github.com' && /^\/[^/]+\/[^/]+\/?$/.test(new URL(url).pathname)) return fetchGithub(url)
  const result = await fetchLimited(url)
  if (/html/i.test(result.type) || /^\s*<!doctype html|^\s*<html/i.test(result.text)) return extractHtml(result.text, result.url)
  if (!/text\/|json|markdown|yaml|xml/i.test(result.type)) throw new Error('此链接不是可读取的网页或文本，请导入文本文件或粘贴正文')
  if (!result.text.trim()) throw new Error('来源内容为空')
  return { title: new URL(result.url).pathname.split('/').pop() || kind, author: '', url: result.url, version: '', content: result.text, raw: result.text, warnings: [] }
}
