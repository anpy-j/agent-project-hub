import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { extractHtml, normalizeSourceUrl, inferKind, identityTags, contentHash, fetchLimited, fetchGithub } from '../electron/services/library-source'
import { analysisMessages, summaryFromMarkdown, MAX_AI_CHARS } from '../electron/services/library-analysis'
test('canonical links deduplicate tracking parameters and GitHub .git URLs', () => {
  assert.equal(normalizeSourceUrl('https://example.com/article?utm_source=test&q=1#part'), 'https://example.com/article?q=1')
  assert.equal(normalizeSourceUrl('https://github.com/owner/repo.git/'), 'https://github.com/owner/repo')
  assert.throws(() => normalizeSourceUrl('file:///etc/passwd'))
  assert.throws(() => normalizeSourceUrl('https://user:pass@example.com'))
  assert.equal(inferKind('https://github.com/owner/repo'), 'github')
  assert.equal(inferKind('', '---\nname: skill\ndescription: desc\n---\n# Skill'), 'skill')
  assert.deepEqual(identityTags('github', 'An MCP service with SKILL.md'), ['GitHub', 'MCP', 'Skill'])
  assert.notEqual(contentHash('a'), contentHash('b'))
})
test('extracts readable article headings and commands without executing scripts', () => {
  const html = `<html><head><title>正文提取</title><meta name="author" content="作者"></head><body><nav>广告导航</nav><article><h1>正文提取</h1><p>${'这是一段测试文章，包含足够的内容用于阅读器识别。'.repeat(20)}</p><pre>npm install example\nnpm run demo</pre><p><a href="/guide">使用指南</a></p></article><script>globalThis.PWNED=true</script></body></html>`
  const source = extractHtml(html, 'https://example.com/article')
  assert(source.content.includes('npm install example'))
  assert(source.content.includes('https://example.com/guide'))
  assert(!source.content.includes('globalThis.PWNED'))
  assert.equal(source.raw, html)
  assert.throws(() => extractHtml('<html><body>登录</body></html>', 'https://example.com'))
})
test('GitHub ingestion pins README and referenced docs to the same commit', async () => {
  const original = globalThis.fetch, requests: string[] = []
  globalThis.fetch = (async (input: any) => {
    const url = String(input); requests.push(url)
    let data: unknown
    if (url.endsWith('/repos/owner/repo')) data = { full_name: 'owner/repo', default_branch: 'main', description: 'MCP tool', owner: { login: 'owner' } }
    else if (url.includes('/commits/main')) data = { sha: 'fixed-sha' }
    else if (url.includes('/readme?ref=fixed-sha')) data = { path: 'README.md', encoding: 'base64', content: Buffer.from('# README\n[Install](docs/install.md)\n[External](https://outside.invalid/info.md)').toString('base64') }
    else if (url.includes('/contents/docs/install.md?ref=fixed-sha')) data = { encoding: 'base64', content: Buffer.from('# Install\nnpm install package').toString('base64') }
    else throw new Error(`Unexpected request ${url}`)
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const source = await fetchGithub('https://github.com/owner/repo')
    assert.equal(source.version, 'fixed-sha')
    assert(source.content.includes('npm install package'))
    assert(!requests.some(url => url.includes('outside.invalid')))
    assert(source.raw.includes('README.md'))
  } finally { globalThis.fetch = original }
})
test('analysis uses distinct templates, reports truncation, and retains command text', () => {
  const prompt = analysisMessages('mcp', '测试', '用于项目', '', 'x'.repeat(MAX_AI_CHARS + 1), '项目描述')
  assert.equal(prompt.truncated, true)
  assert(prompt.messages[0].content.includes('客户端配置'))
  assert(prompt.messages[0].content.includes('不能执行'))
  assert(prompt.messages[1].content.includes('前 60000'))
  assert.equal(summaryFromMarkdown('# 一句话总结\n\n## 细节'), '一句话总结')
})
test('fetch rejects oversized and non-HTTP redirected sources', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/big') { res.writeHead(200, { 'Content-Length': 6000000 }); res.end('large'); return }
    res.writeHead(302, { Location: 'file:///etc/passwd' }); res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    await assert.rejects(fetchLimited(`${origin}/big`), /5MB/)
    await assert.rejects(fetchLimited(`${origin}/redirect`), /HTTP/)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('WeChat article containers retain short and initially hidden content without Readability', () => {
  const html = '<html><head><title>微信文章</title></head><body><h1 id="activity-name">公众号文章标题</h1><a id="js_name">测试公众号</a><div id="js_content" style="display:none"><section><p>这是一篇微信公众号的短文，正文长度超过二十字，应该被准确提取。</p><pre>npm install example</pre></section></div><footer>关注广告</footer></body></html>'
  const source = extractHtml(html, 'https://mp.weixin.qq.com/s/example')
  assert.equal(source.title, '公众号文章标题')
  assert.equal(source.author, '测试公众号')
  assert(source.content.includes('npm install example'))
  assert(!source.content.includes('关注广告'))
  assert.equal(source.raw, html)
})
test('WeChat challenge pages are identified and never archived as article content', () => {
  const html = '<html><body><div class="weui-msg"><h2>环境异常</h2><p>当前环境异常，完成验证后即可继续访问。</p><a id="js_verify">去验证</a></div></body></html>'
  assert.throws(() => extractHtml(html, 'https://mp.weixin.qq.com/s/example'), /浏览器获取/)
})
