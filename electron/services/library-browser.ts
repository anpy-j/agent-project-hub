import { BrowserWindow, WebContentsView } from 'electron'
import { normalizeSourceUrl, extractHtml, MAX_SOURCE_BYTES, type ExtractedSource } from './library-source'

// The toolbar is a trusted local document with no preload. Remote pages live in a
// separate sandboxed view without access to Project Hub's IPC or local files.
export function openLibraryBrowser(url: string, save: (source: ExtractedSource) => void): void {
  const initial = normalizeSourceUrl(url)
  const window = new BrowserWindow({ width: 1080, height: 820, title: '浏览器获取资料', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const page = new WebContentsView({ webPreferences: { partition: 'persist:library-browser', sandbox: true, contextIsolation: true, nodeIntegration: false } })
  page.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  page.webContents.session.setPermissionCheckHandler(() => false)
  window.contentView.addChildView(page)
  const bounds = () => { const [width, height] = window.getContentSize(); page.setBounds({ x: 0, y: 78, width, height: Math.max(0, height - 78) }) }
  bounds(); window.on('resize', bounds)
  let saving = false
  const html = `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;background:#111827;color:#e5e7eb;font:13px system-ui;padding:12px 18px}nav{display:flex;align-items:center;justify-content:space-between;gap:12px}a{color:white;background:#6366f1;padding:8px 16px;border-radius:7px;text-decoration:none}p{margin:6px 0 0;color:#a5b4fc;font-size:12px}</style></head><body><nav><span>看到完整正文后，点击保存。微信验证请在下方页面中手动完成。</span><a href="projecthub-library://save">保存当前文章</a></nav><p id="status">文章保存在当前收藏记录中，随后按设置分析和入库。</p></body></html>`
  const status = (message: string) => { if (!window.isDestroyed()) void window.webContents.executeJavaScript(`document.getElementById('status').textContent=${JSON.stringify(message)}`).catch(() => {}) }
  window.webContents.on('will-navigate', (event, target) => {
    event.preventDefault()
    if (target !== 'projecthub-library://save' || saving || page.webContents.isDestroyed()) return
    saving = true
    void (async () => {
      try {
        const current = normalizeSourceUrl(page.webContents.getURL())
        if (new URL(current).origin !== new URL(initial).origin) throw new Error('请返回原网站的文章页面后保存')
        const raw = await page.webContents.executeJavaScript('document.documentElement.outerHTML') as string
        if (Buffer.byteLength(raw) > MAX_SOURCE_BYTES) throw new Error('页面超过 5MB，请使用补充正文')
        const source = extractHtml(raw, current)
        save({ ...source, url: initial, warnings: [...source.warnings, '正文由用户在浏览器中确认并保存。'] })
        status('文章已保存，可以返回 AI 资料库查看处理进度。')
      } catch (error) { status((error as Error).message) }
      finally { saving = false }
    })()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  page.webContents.on('will-navigate', (event, target) => { try { normalizeSourceUrl(target) } catch { event.preventDefault() } })
  page.webContents.on('will-redirect', (event, target) => { try { normalizeSourceUrl(target) } catch { event.preventDefault() } })
  page.webContents.setWindowOpenHandler(({ url: target }) => {
    try { void page.webContents.loadURL(normalizeSourceUrl(target)).catch(error => status(error.message)) } catch { status('此链接不是网页链接') }
    return { action: 'deny' }
  })
  const preventDownload = (event: Electron.Event) => event.preventDefault()
  page.webContents.session.on('will-download', preventDownload)
  window.on('closed', () => {
    page.webContents.session.removeListener('will-download', preventDownload)
    if (!page.webContents.isDestroyed()) page.webContents.close()
  })
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => page.webContents.loadURL(initial)).catch(error => status(`加载失败：${error.message}`))
}
