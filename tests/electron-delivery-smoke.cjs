const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const dir = process.env.PROJECT_HUB_SMOKE_DIR
const mode = process.env.PROJECT_HUB_SMOKE_MODE || 'current'
app.setPath('userData', dir)
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const { deploymentStore: store } = require(path.join(dir, 'store.cjs'))
  const password = 'FAKE-TEST-SECRET-NEVER-A-REAL-PASSWORD'
  const registry = store.saveRegistry({ id: '', name: '阿里云镜像仓库', server: 'registry.example.com', username: 'demo', password })
  assert.equal(store.registrySecret(registry.id).password, password)
  assert.ok(!JSON.stringify(store.registries()).includes(password))
  assert.ok(!fs.readFileSync(path.join(dir, 'deployment-v1.json'), 'utf8').includes(password))
  store.saveRegistry({ ...registry, name: '阿里云镜像仓库', password: '' })
  assert.equal(store.registrySecret(registry.id).password, password)
  assert.throws(() => store.saveRegistry({ ...registry, username: 'changed', password: '' }))
  const host = store.saveHost({ id: '', name: '腾讯云 · 个人服务器', host: 'server.example.com', port: 22, username: 'deploy', authKind: 'password', fingerprint: 'SHA256:' + 'A'.repeat(43), password })
  assert.ok(!JSON.stringify(store.hosts()).includes(password))
  const changedHost = store.saveHost({ ...host, host: 'changed.example.com', password: '' })
  assert.equal(changedHost.hasCredential, false)
  store.saveHost({ ...host, password })
  const config = { projectId: 'demo', registryId: registry.id, hostId: host.id, repository: 'personal/project-hub', tag: 'release-20261006', dockerfile: 'Dockerfile', platform: 'linux/amd64', remoteDir: '/opt/project-hub', composeFile: 'compose.yaml', service: 'app', composeProject: 'project-hub' }
  store.saveConfig(config)
  assert.throws(() => store.removeRegistry(registry.id), /引用/)
  assert.throws(() => store.removeHost(host.id), /引用/)
  console.log('PASS: encrypted credential storage, metadata isolation, credential invalidation and references')
  const project = { id: 'demo', name: 'project-hub', display_name: '项目管理工作台', workspace_id: 'personal', path: 'D:/develop/ai/project/example', type: 'node' }
  ipcMain.handle('workspace:list', () => [{ id: 'personal', name: '个人', kind: 'personal' }])
  ipcMain.handle('project:list', () => [project])
  let registryCalls = 0
  if (mode !== 'legacy-main') ipcMain.handle('deployment:registries', () => { registryCalls++; return store.registries() })
  ipcMain.handle('deployment:hosts', () => store.hosts())
  let jobs = []
  ipcMain.handle('deployment:jobs', () => jobs)
  ipcMain.handle('deployment:config', () => config)
  ipcMain.handle('deployment:saveConfig', (_event, value) => { assert.equal(value.projectId, 'demo'); return value })
  let launched = false
  ipcMain.handle('deployment:start', (_event, id, action) => {
    assert.equal(id, 'demo'); assert.equal(action, 'build'); launched = true
    jobs = [{ id: 'test-job', projectId: id, hostId: '', action, image: 'registry.example.com/personal/project-hub:release-20261006', status: 'success', stage: '完成', startedAt: '2026-10-06T06:30:00Z', log: '界面测试示例（未执行实际发布）\n\n--- Docker 构建 ---\n示例项目镜像已构建\n\n可以继续上传镜像，或选择完整发布。' }]
    return 'test-job'
  })
  const window = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { preload: mode === 'legacy' ? path.join(dir, 'legacy-preload.cjs') : path.join(root, 'out/preload/index.js'), offscreen: true, backgroundThrottling: false, sandbox: false, contextIsolation: true, nodeIntegration: false } })
  const errors = []
  window.webContents.on('console-message', (_event, level, text) => { if (level >= 3) errors.push(text) })
  await window.loadFile(path.join(root, 'out/renderer/index.html'), { hash: '/delivery?project=demo' })
  const evaluate = code => window.webContents.executeJavaScript(code)
  async function until(code) {
    for (let i = 0; i < 100; i++) { if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 30)) }
    throw new Error('UI condition timed out: ' + code)
  }
  if (mode !== 'current') {
    await until(`document.body.innerText.includes('需要完整重启 Project Hub')`)
    assert.equal(registryCalls, 0)
    assert.equal(await evaluate(`document.querySelector('.release-grid') === null`), true)
    assert.ok(!errors.length, errors.join('\n'))
    console.log(`PASS: ${mode} interface shows restart guidance without undefined API calls`)
    window.destroy()
    app.exit(0)
    return
  }
  await until(`document.body.innerText.includes('registry.example.com/personal/project-hub:release-20261006')`)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '本地构建').disabled`), false)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '本地构建').click()`)
  for (let i = 0; i < 100 && !launched; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(launched, 'build control should call typed IPC with selected project')
  if (process.env.PROJECT_HUB_SMOKE_SCREENSHOT) {
    await new Promise(resolve => setTimeout(resolve, 350))
    await until(`getComputedStyle(document.querySelector('.delivery-page')).opacity === '1'`)
    assert.equal(await evaluate(`document.querySelector('.release-grid').getBoundingClientRect().width > 600`), true)
    const image = await window.webContents.capturePage()
    fs.writeFileSync(process.env.PROJECT_HUB_SMOKE_SCREENSHOT, image.toPNG())
  }
  await evaluate(`Array.from(document.querySelectorAll('.el-tabs__item')).find(e => e.innerText.includes('仓库账号')).click()`)
  await until(`document.body.innerText.includes('阿里云镜像仓库')`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '添加仓库').click()`)
  await until(`document.body.innerText.includes('镜像仓库登录')`)
  assert.equal(await evaluate(`document.querySelector('.el-dialog input[type="password"]').value`), '')
  const runtimeErrors = errors.filter(text => text !== 'ResizeObserver loop completed with undelivered notifications.')
  assert.ok(!runtimeErrors.length, runtimeErrors.join('\n'))
  console.log('PASS: renderer loading, selected-project configuration, build IPC and credential dialog')
  window.destroy()
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
