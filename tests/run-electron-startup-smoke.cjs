const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(root, 'startup-smoke-'))
try {
  // Load the actual electron-vite output. Do not re-bundle dependencies in this test:
  // re-bundling hid the LinkeDOM CommonJS -> ESM startup incompatibility.
  fs.writeFileSync(path.join(temporary, 'main.cjs'), `
const { app } = require('electron')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { join } = require('node:path')
app.setPath('userData', process.env.PROJECT_HUB_STARTUP_DIR)
app.setAppPath(process.env.PROJECT_HUB_STARTUP_ROOT)
const timer = setTimeout(() => { console.error('Startup test timed out'); app.exit(1) }, 20000)
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
process.on('unhandledRejection', error => { console.error(error); app.exit(1) })
app.on('browser-window-created', (_event, win) => {
  win.show = () => {}
  win.webContents.once('did-finish-load', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end('<html><head><title>启动解析验证</title></head><body><article><h1>启动解析验证</h1><p>' + '验证真实主进程可以启动并且解析文章，保留原文而不运行网页脚本。'.repeat(20) + '</p><canvas width=10 height=10></canvas></article></body></html>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/article'
      const result = await win.webContents.executeJavaScript('window.api.library.capture(' + JSON.stringify({ url, autoAnalyze: false, autoSync: false }) + ')', true)
      let detail
      const deadline = Date.now() + 10000
      do {
        await new Promise(resolve => setTimeout(resolve, 30))
        detail = await win.webContents.executeJavaScript('window.api.library.detail(' + JSON.stringify(result.resource.id) + ')', true)
      } while (detail.jobAction && Date.now() < deadline)
      assert.equal(detail.processing, 'ready')
      assert.equal(detail.title, '启动解析验证')
      assert(detail.source.content.includes('验证真实主进程'))
      assert(detail.source.raw.includes('<article>'))
      clearTimeout(timer)
      console.log('Actual built Electron main loaded, renderer IPC connected, article extraction passed')
      app.quit()
    } catch(error) { console.error(error); app.exit(1) }
    finally { server.closeAllConnections(); server.close() }
  })
})
require(join(process.env.PROJECT_HUB_STARTUP_ROOT, 'out/main/index.js'))
`)
  const env = { ...process.env, PROJECT_HUB_STARTUP_DIR: temporary, PROJECT_HUB_STARTUP_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const result = spawnSync(process.env.PROJECT_HUB_TEST_ELECTRON || require('electron'), [path.join(temporary, 'main.cjs')], { env, encoding: 'utf8', timeout: 30000, windowsHide: true })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
} finally {
  if (path.dirname(path.resolve(temporary)) !== root || !path.basename(temporary).startsWith('startup-smoke-')) throw new Error('Unsafe fixture path')
  fs.rmSync(temporary, { recursive: true, force: true })
}
