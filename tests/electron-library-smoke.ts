import { app, BrowserWindow, WebContentsView, ipcMain, dialog } from 'electron'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { getDb, closeDb } from '../electron/db'
import { projectRepo, workspaceRepo } from '../electron/db/repositories'
import { registerLibraryIpc } from '../electron/ipc/library'
import { registerRagflowIpc } from '../electron/ipc/ragflow'
import { libraryService, LibraryService } from '../electron/services/library.service'
import { LibraryStore } from '../electron/services/library-store'
import { aiService } from '../electron/services/ai.service'
import { ragflowService } from '../electron/services/ragflow.service'
const dir = process.env.PROJECT_HUB_LIBRARY_SMOKE_DIR!
const root = process.env.PROJECT_HUB_LIBRARY_ROOT!
app.setPath('userData', dir)
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  let uploads = 0, parses = 0, failParse = false, failAi = false, articleVersion = 1
  const docs: { id: string; name: string; run: string; progress: number; pipeline_id: string; body: string }[] = []
  const sentPrompts: any[] = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fixture')
    let body = ''; for await (const part of req) body += part.toString()
    if (url.pathname === '/article') {
      res.setHeader('Content-Type', 'text/html')
      res.end(`<html><head><title>RAG 实践文章</title></head><body><article><h1>RAG 实践</h1><p>${'知识库应该保存原文和引用，摘要应和个人笔记分开。'.repeat(20)}版本${articleVersion}</p><pre>npm install example</pre></article><script>window.PWNED=true</script></body></html>`); return
    }
    if (url.pathname === '/blocked') { res.writeHead(403); res.end('login'); return }
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/v1/chat/completions') {
      const prompt = JSON.parse(body); sentPrompts.push(prompt)
      if (failAi) { res.writeHead(503); res.end('fixture unavailable'); return }
      res.end(JSON.stringify({ choices: [{ message: { content: prompt.messages[1].content.includes('问题：') ? '## 答复\n依据原文，先保存正文。' : '这是一份关于知识库实践的资料。\n\n## 核心观点\n原文指出应保留来源。\n\n## AI 建议\n先验证再入库。' } }] })); return
    }
    if (req.headers.authorization !== 'Bearer library-fixture-key') { res.end(JSON.stringify({ code: 401 })); return }
    let data: unknown = null
    if (url.pathname === '/api/v1/datasets') data = [{ id: 'fixture-dataset', name: '本机知识库' }]
    else if (url.pathname === '/api/v1/datasets/fixture-dataset/documents' && req.method === 'POST') {
      const name = body.match(/filename="([^"]+)"/)?.[1]
      assert(name); uploads++
      const document = { id: `document-${uploads}`, name: name!, run: 'UNSTART', progress: 0, pipeline_id: '', body }
      docs.push(document); data = [document]
    } else if (url.pathname === '/api/v1/datasets/fixture-dataset/documents') {
      data = { docs: docs.filter(doc => (!url.searchParams.get('id') || doc.id === url.searchParams.get('id')) && (!url.searchParams.get('name') || doc.name === url.searchParams.get('name'))), total: docs.length }
    } else if (url.pathname === '/api/v1/datasets/fixture-dataset/chunks' || url.pathname === '/api/v1/documents/ingest') {
      parses++
      if (failParse) { failParse = false; res.end(JSON.stringify({ code: 101 })); return }
      const payload = JSON.parse(body), ids = payload.document_ids || payload.doc_ids
      assert(ids?.length)
      for (const doc of docs) if (ids.includes(doc.id)) { doc.run = 'DONE'; doc.progress = 1 }
      data = true
    } else { res.writeHead(404); res.end('{}'); return }
    res.end(JSON.stringify({ code: 0, data }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  async function waitUntil(condition: () => boolean | Promise<boolean>) {
    const until = Date.now() + 15000
    while (Date.now() < until) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 30)) }
    throw new Error('Timed out waiting for library processing')
  }
  let win: BrowserWindow | undefined
  try {
    getDb()
    const project = projectRepo.insert({ id: 'library-project', workspace_id: workspaceRepo.list()[0].id, name: '资料项目', path: dir, type: 'node', framework: null, description: '验证资料与项目关联' })
    aiService.saveConfig({ provider: 'custom', base_url: `${origin}/v1`, api_key: '', model: 'fixture-model' })
    ragflowService.saveConfig({ baseUrl: origin, datasetId: 'fixture-dataset', apiKey: 'library-fixture-key' })
    libraryService.init()
    const finished = (id: string) => { const row = libraryService.detail(id); return !row.jobAction && !['queued', 'fetching', 'analyzing'].includes(row.processing) }
    const captured = libraryService.capture({ url: `${origin}/article?utm_source=test`, reason: '用于知识库项目', tags: ['RAG'], projectIds: [project.id], autoAnalyze: true, autoSync: true }).resource
    assert.equal(captured.processing, 'queued')
    await waitUntil(() => finished(captured.id))
    let detail = libraryService.detail(captured.id)
    assert.equal(detail.title, 'RAG 实践文章')
    assert.equal(detail.analyses.length, 1)
    assert(detail.source?.raw.includes('<script>'))
    assert(!detail.source?.content.includes('window.PWNED'))
    assert.equal(detail.sync?.state, 'parsing')
    assert.equal(uploads, 1)
    assert(!docs[0].body.includes('## AI 建议'))
    await libraryService.refreshSync(captured.id)
    assert.equal(libraryService.detail(captured.id).sync?.state, 'ready')
    assert(libraryService.capture({ url: `${origin}/article#fragment` }).duplicate)
    assert.equal(libraryService.list({ query: 'npm install', projectId: project.id }).length, 1)
    assert.equal(libraryService.list({ query: '不存在关键词' }).length, 0)
    libraryService.update(captured.id, { notes: '个人实践记录必须保留', reading: 'practiced' })
    libraryService.process(captured.id, 'analyze')
    await waitUntil(() => finished(captured.id))
    detail = libraryService.detail(captured.id)
    assert.equal(detail.analyses.length, 2)
    assert.equal(detail.notes, '个人实践记录必须保留')
    assert.equal(uploads, 1)
    articleVersion++
    libraryService.process(captured.id, 'fetch')
    await waitUntil(() => finished(captured.id))
    detail = libraryService.detail(captured.id)
    assert.equal(detail.sources.length, 2)
    assert.equal(detail.notes, '个人实践记录必须保留')
    assert.equal(uploads, 2)
    assert(detail.sources[1].id !== detail.sourceId)
    const answer = await libraryService.ask(captured.id, '核心观点是什么？')
    assert(answer.includes('依据原文'))
    assert(sentPrompts.some(prompt => prompt.messages[1].content.includes('验证资料与项目关联')))
    // A real sandboxed browser view can capture a rendered page through its local toolbar.
    libraryService.browse(captured.id)
    const browser = BrowserWindow.getAllWindows().find(window => window.getTitle() === '浏览器获取资料')!
    assert(browser)
    const remote = browser.contentView.children[0] as WebContentsView
    await waitUntil(async () => !remote.webContents.isLoading() && remote.webContents.getURL().includes('/article'))
    assert.equal(await remote.webContents.executeJavaScript('typeof window.api'), 'undefined')
    await waitUntil(async () => !browser.webContents.isLoading())
    await browser.webContents.executeJavaScript("document.querySelector('a').click()", true)
    await waitUntil(async () => (await browser.webContents.executeJavaScript("document.getElementById('status').textContent")).includes('文章已保存'))
    await waitUntil(() => finished(captured.id))
    browser.destroy()
    failParse = true
    const retry = libraryService.capture({ title: '解析重试', content: '# 文本\n测试解析失败后的重试', autoAnalyze: false, autoSync: true }).resource
    await waitUntil(() => finished(retry.id))
    assert.equal(libraryService.detail(retry.id).sync?.state, 'failed')
    const uploadedBeforeRetry = uploads, parseBefore = parses
    libraryService.process(retry.id, 'sync')
    await waitUntil(() => finished(retry.id))
    assert.equal(uploads, uploadedBeforeRetry)
    assert(parses > parseBefore)
    await libraryService.refreshSync(retry.id)
    assert.equal(libraryService.detail(retry.id).sync?.state, 'ready')
    // A fresh pipeline document uses the ingest route, with the same stable document ID.
    docs.find(doc => doc.id === libraryService.detail(retry.id).sync?.documentId)!.pipeline_id = 'pipeline'
    docs.find(doc => doc.id === libraryService.detail(retry.id).sync?.documentId)!.run = 'FAIL'
    await libraryService.refreshSync(retry.id)
    libraryService.process(retry.id, 'sync')
    await waitUntil(() => finished(retry.id))
    failAi = true
    const failedAi = libraryService.capture({ title: 'AI 失败仍入库', content: 'AI 失败不能丢失原文', autoAnalyze: true, autoSync: true }).resource
    await waitUntil(() => finished(failedAi.id))
    assert.equal(libraryService.detail(failedAi.id).processing, 'failed')
    assert.equal(libraryService.detail(failedAi.id).sync?.state, 'parsing')
    assert(libraryService.detail(failedAi.id).source)
    failAi = false
    const failedFetch = libraryService.capture({ url: `${origin}/blocked`, autoAnalyze: false }).resource
    await waitUntil(() => finished(failedFetch.id))
    assert.equal(libraryService.detail(failedFetch.id).processing, 'failed')
    libraryService.supply(failedFetch.id, '这是手动补充的正文，保持来源链接。')
    await waitUntil(() => finished(failedFetch.id))
    assert.equal(libraryService.detail(failedFetch.id).source?.version, '用户补充的正文')
    libraryService.archive(failedFetch.id, true)
    assert(libraryService.list({ archived: true }).some(row => row.id === failedFetch.id))
    assert(!libraryService.list().some(row => row.id === failedFetch.id))
    libraryService.archive(failedFetch.id, false)
    // Import and export retain the full source, without invoking any external file path supplied by renderer.
    const importPath = join(dir, 'SKILL.md')
    writeFileSync(importPath, '---\nname: test-skill\ndescription: 测试\n---\n# 测试 Skill\n使用方法。')
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [importPath] })) as typeof dialog.showOpenDialog
    const imported = (await libraryService.importFile({ autoAnalyze: false }))!.resource
    await waitUntil(() => finished(imported.id))
    assert.equal(libraryService.detail(imported.id).kind, 'skill')
    assert(libraryService.detail(imported.id).source?.version.includes('SKILL.md'))
    assert.equal(libraryService.detail(imported.id).sources.length, 1)
    const exportPath = join(dir, 'export.md')
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: exportPath })) as typeof dialog.showSaveDialog
    await libraryService.export(captured.id)
    assert(readFileSync(exportPath, 'utf8').includes('个人实践记录必须保留'))
    // Reopening the persistent store keeps original snapshots, analysis history and notes.
    assert.equal(new LibraryStore(getDb()).detail(captured.id).notes, '个人实践记录必须保留')
    const store = new LibraryStore(getDb())
    store.patch(imported.id, { processing: 'fetching', jobAction: 'fetch' })
    store.recover()
    assert.equal(store.get(imported.id).processing, 'failed')
    assert(store.detail(imported.id).source)
    libraryService.process(imported.id, 'analyze')
    await waitUntil(() => finished(imported.id))
    registerLibraryIpc(); registerRagflowIpc()
    ipcMain.handle('workspace:list', () => workspaceRepo.list())
    ipcMain.handle('project:list', () => projectRepo.list())
    ipcMain.handle('agent:tasks', () => [])
    ipcMain.handle('deployment:hosts', () => [])
    const errors: string[] = []
    win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: join(root, 'out/preload/index.js'), contextIsolation: true, sandbox: false, offscreen: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
    await win.loadFile(join(root, 'out/renderer/index.html'), { hash: '/ai/library' })
    const evaluate = async (code: string) => { try { return await win!.webContents.executeJavaScript(code, true) } catch(e) { console.error('Failed UI action:', code, errors.join('\n'), await win!.webContents.executeJavaScript('document.body.innerText')); throw e } }
    const click = (label: string) => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`)
    await waitUntil(() => evaluate(`document.body.innerText.includes('RAG 实践文章')`))
    await evaluate(`(() => { const style=document.createElement('style'); style.textContent='*,*::before,*::after { transition-duration: 0s !important; animation-duration: 0s !important; }'; document.head.appendChild(style); })()`)
    await evaluate(`Array.from(document.querySelectorAll('.resource-card')).find(b=>b.textContent.includes('RAG 实践文章')).click()`)
    await waitUntil(() => evaluate(`document.querySelector('.library-drawer')?.innerText.includes('这是一份关于知识库实践的资料')`))
    await evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).find(e=>e.textContent.trim()==='我的笔记与项目').click()`)
    await waitUntil(() => evaluate(`document.querySelector('textarea[placeholder^="你的理解"]')?.value.includes('个人实践记录必须保留')`))
    await evaluate(`(() => { const input = document.querySelector('textarea[placeholder^="你的理解"]'); input.value='界面保存的笔记'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await click('保存笔记与信息')
    await waitUntil(() => libraryService.detail(captured.id).notes === '界面保存的笔记')
    await evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).find(e=>e.textContent.trim()==='原文与来源').click()`)
    await waitUntil(() => evaluate(`document.querySelector('.library-drawer')?.innerText.includes('npm install example')`))
    assert.equal(await evaluate('window.PWNED'), undefined)
    await evaluate(`document.querySelector('.el-drawer__close-btn').click()`)
    await new Promise(resolve => setTimeout(resolve, 350))
    await click('收藏资料')
    await evaluate(`Array.from(document.querySelectorAll('.el-radio-button')).find(e=>e.textContent.trim()==='粘贴文字').click()`)
    await evaluate(`(() => { const input=document.querySelector('textarea[placeholder="粘贴文章、使用说明、Skill 或 MCP 文档"]'); input.value=${JSON.stringify('# 界面创建资料\n这里是原文。')}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await click('收藏并整理')
    await waitUntil(() => libraryService.list().some(row => row.title === '界面创建资料' && finished(row.id)))
    await waitUntil(() => evaluate(`document.querySelector('.library-drawer')?.innerText.includes('这是一份关于知识库实践的资料')`))
    await evaluate(`document.querySelector('.el-drawer__close-btn').click()`)
    await new Promise(resolve => setTimeout(resolve, 800))
    writeFileSync('/tmp/project-hub-library-preview.png', (await win.webContents.capturePage()).toPNG())
    assert.deepEqual(errors, [])
    console.log('Library capture, source snapshots, AI history, project search, RAGFlow retry, file import/export, persistence, UI capture and note editing passed')
    win.destroy(); win = undefined
  } finally {
    win?.destroy(); libraryService.cleanup(); server.closeAllConnections(); server.close(); closeDb()
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
