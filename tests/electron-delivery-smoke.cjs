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
  const managementId = 'FAKEALICLOUDKEY123', managementSecret = 'FAKEONLYMANAGEMENTSECRET123'
  const aliyun = store.saveRegistry({id:'',name:'Aliyun metadata',server:'registry.cn-hangzhou.aliyuncs.com',username:'demo',password,aliyun:{regionId:'cn-hangzhou',accessKeyId:managementId,accessKeySecret:managementSecret}})
  assert.equal(aliyun.aliyun.hasAccessKey, true)
  assert.ok(!JSON.stringify(store.registries()).includes(managementId))
  assert.ok(!JSON.stringify(store.registries()).includes(managementSecret))
  assert.ok(!fs.readFileSync(path.join(dir, 'deployment-v1.json'), 'utf8').includes(managementSecret))
  store.saveRegistry({...aliyun,aliyun:{regionId:'cn-hangzhou'},password:''})
  assert.equal(store.registryManagementSecret(aliyun.id).accessKeySecret, managementSecret)
  assert.equal(store.registrySecret(aliyun.id).password, password)
  assert.throws(() => store.saveRegistry({...aliyun,server:'registry.cn-beijing.aliyuncs.com',password,aliyun:{regionId:'cn-beijing'}}), /AccessKey/)
  store.saveRegistry({...aliyun,aliyun:null,password:''})
  assert.throws(() => store.registryManagementSecret(aliyun.id), /配置/)
  store.removeRegistry(aliyun.id)
  console.log('PASS: management AccessKey encryption, metadata isolation, retained edits, region invalidation and independent Docker password')
  const host = store.saveHost({ id: '', name: '腾讯云 · 个人服务器', host: 'server.example.com', port: 22, username: 'deploy', authKind: 'password', fingerprint: 'SHA256:' + 'A'.repeat(43), password })
  assert.ok(!JSON.stringify(store.hosts()).includes(password))
  const changedHost = store.saveHost({ ...host, host: 'changed.example.com', password: '' })
  assert.equal(changedHost.hasCredential, false)
  store.saveHost({ ...host, password })
  const secondHost = store.saveHost({ ...host, id: '', name: '第二台服务器', host: 'second.example.com', password })
  const config = { projectId: 'demo', registryId: registry.id, hostId: host.id, repository: 'personal/project-hub', tag: 'release-20261006', dockerfile: 'Dockerfile', platform: 'linux/amd64', remoteDir: '/opt/project-hub', composeFile: 'compose.yaml', service: 'app', composeProject: 'project-hub' }
  store.saveConfig(config)
  assert.throws(() => store.removeRegistry(registry.id), /引用/)
  assert.throws(() => store.removeHost(host.id), /引用/)
  console.log('PASS: encrypted credential storage, metadata isolation, credential invalidation and references')
  const project = { id: 'demo', name: 'project-hub', display_name: '项目管理工作台', workspace_id: 'personal', path: 'D:/develop/ai/project/example', type: 'node' }
  ipcMain.handle('workspace:list', () => [{ id: 'personal', name: '个人', kind: 'personal' }])
  ipcMain.handle('project:list', () => [project])
  ipcMain.handle('project:buildTargets', () => [{ id: 'web-build', name: '前端构建', directory: '.', commands: ['npm run build'], artifactPaths: ['dist'], platform: 'any' }])
  let registryCalls = 0
  if (mode !== 'legacy-main') ipcMain.handle('deployment:registries', () => { registryCalls++; return store.registries() })
  ipcMain.handle('deployment:hosts', () => store.hosts())
  ipcMain.handle('agent:tasks', () => [])
  ipcMain.handle('deployment:registryCatalog', () => ({ repositories: [...new Set(['personal/project-hub', 'team/worker', ...(store.registries().find(r => r.id === registry.id).repositories || [])])], mode: 'tracked', notice: '仓库连接正常，添加的镜像路径将在全局保存' }))
  ipcMain.handle('deployment:registryTags', (_event, id, repository) => { assert.equal(id, registry.id); store.rememberRepository(id, repository, registry.server); return repository === 'team/worker' ? ['v2'] : ['latest', 'v1'] })
  if (mode === 'management') {
    ipcMain.handle('gitAuth:snapshot', () => ({keys:[],helpers:[],hosts:[],warnings:[]}))
    ipcMain.handle('agent:getConfig', () => ({provider:'custom',base_url:'',model:'',api_key:''}))
    ipcMain.handle('runtime:list', () => [])
    ipcMain.handle('system:logUsage', () => ({files:0,bytes:0}))
    ipcMain.handle('ai:providers', () => [])
    ipcMain.handle('ai:getConfig', () => ({provider:'custom',base_url:'',model:'',api_key:''}))
    ipcMain.handle('deployment:saveRegistry', (_event,input) => store.saveRegistry(input))
    ipcMain.removeHandler('deployment:registryCatalog')
    ipcMain.handle('deployment:registryCatalog', (_event,id) => { assert.equal(store.registryManagementSecret(id).accessKeySecret, managementSecret); return {mode:'catalog',namespaces:['anpengyu'],repositories:['anpengyu/qianchuan']} })
  }
  const snapshot = { metrics: '', containers: [{ ID: 'a'.repeat(64), Names: 'api', Image: 'registry.example.com/personal/project-hub:latest', State: 'running', Status: 'Up 2 hours', Ports: '8080:80' }], images: [{ ID: 'sha256:old', Repository: 'registry.example.com/personal/project-hub', Tag: 'latest', Size: '80MB' }], services: [{ name: 'api.service', active: 'active', description: 'API service' }] }
  ipcMain.handle('deployment:snapshot', (_event, id, scope) => { assert.equal(id, host.id); assert.ok(['docker', 'services'].includes(scope)); return snapshot })
  const operations = []
  ipcMain.handle('deployment:remoteAction', (_event, id, request) => { assert.equal(id, host.id); operations.push(request); return request.kind === 'logs' ? 'API listening on port 80' : request.action === 'update' ? '新容器已启动，更新完成' : '操作完成' })
  const window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { preload: mode === 'legacy' ? path.join(dir, 'legacy-preload.cjs') : path.join(root, 'out/preload/index.js'), offscreen: true, backgroundThrottling: false, sandbox: false, contextIsolation: true, nodeIntegration: false } })
  const errors = []
  window.webContents.on('console-message', (_event, level, text) => { if (level >= 3) errors.push(text) })
  await window.loadFile(path.join(root, 'out/renderer/index.html'), { hash: mode === 'management' ? '/settings?section=delivery' : '/delivery' })
  const evaluate = async code => { try { return await window.webContents.executeJavaScript(code) } catch (error) { throw new Error('Renderer evaluation failed: ' + code + '\n' + errors.join('\n') + '\n' + error.message) } }
  async function until(code) {
    for (let i = 0; i < 150; i++) { if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 30)) }
    throw new Error('UI condition timed out: ' + code)
  }
  if (mode === 'management') {
    await until(`document.body.innerText.includes('添加仓库')`)
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.innerText.trim()==='添加仓库').click()`)
    await until(`document.querySelector('.el-dialog .el-switch') !== null`)
    await evaluate(`document.querySelector('.el-dialog .el-switch').click()`)
    await until(`document.body.innerText.includes('AccessKey ID（编辑时留空保留）')`)
    await evaluate(`(() => {
      const dialog = document.querySelector('.el-dialog'), set = (label,value) => {const item=Array.from(dialog.querySelectorAll('.el-form-item')).find(e=>e.querySelector('label')?.innerText.replace('*','').trim()===label);const input=item.querySelector('input'); input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}))}
      set('名称','个人版只读查询');set('Docker 仓库地址（不含协议和路径）','registry.cn-hangzhou.aliyuncs.com');set('登录用户名','demo');set('仓库密码（编辑时留空保留）','${password}');set('AccessKey ID（编辑时留空保留）','${managementId}');set('AccessKey Secret（编辑时留空保留）','${managementSecret}');
      Array.from(dialog.querySelectorAll('button')).find(b=>b.innerText.trim()==='保存并验证目录').click()
    })()`)
    await until(`document.body.innerText.includes('目录验证成功：1 个命名空间、1 个镜像仓库')`)
    const saved=store.registries().find(row=>row.name==='个人版只读查询')
    assert.equal(saved.aliyun.regionId,'cn-hangzhou')
    assert.ok(!JSON.stringify(saved).includes(managementSecret))
    await evaluate(`Array.from(document.querySelectorAll('.el-table__row')).find(r=>r.innerText.includes('个人版只读查询')).querySelectorAll('button')[1].click()`)
    await until(`document.querySelector('.el-dialog input[placeholder="与 AccessKey ID 一起填写"]') !== null`)
    assert.equal(await evaluate(`document.querySelector('.el-dialog input[placeholder="与 AccessKey ID 一起填写"]').value`),'')
    if (process.env.PROJECT_HUB_SMOKE_SCREENSHOT) fs.writeFileSync(process.env.PROJECT_HUB_SMOKE_SCREENSHOT,(await window.webContents.capturePage()).toPNG())
    assert.ok(!errors.filter(e=>!e.includes('ResizeObserver')).length,errors.join('\n'))
    console.log('PASS: actual settings form enables management API, saves and verifies directory, and never echoes saved keys')
    window.destroy();app.exit(0);return
  }
  if (mode !== 'current') {
    await until(`document.body.innerText.includes('需要完整重启 Project Hub')`)
    assert.equal(registryCalls, 0)
    assert.equal(await evaluate(`document.querySelector('.registry-grid') === null`), true)
    assert.ok(!errors.length, errors.join('\n'))
    console.log(`PASS: ${mode} interface shows restart guidance`)
    window.destroy(); app.exit(0); return
  }
  await until(`document.body.innerText.includes('personal/project-hub:latest')`)
  await until(`document.body.innerText.includes('仓库连接正常')`)
  assert.equal(await evaluate(`document.body.innerText.includes('仓库目录不可用')`), false)
  await evaluate(`(() => { const input = document.querySelector('input[placeholder="镜像路径，例如 team/api"]'); input.value = 'team/new-api'; input.dispatchEvent(new Event('input', { bubbles: true })); Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '查询并保存路径').click() })()`)
  await until(`document.body.innerText.includes('team/new-api:latest')`)
  assert.ok(store.registries().find(r => r.id === registry.id).repositories.includes('team/new-api'))
  store.saveRegistry({ ...store.registries().find(r => r.id === registry.id), name: '阿里云镜像仓库', password: '' })
  assert.ok(store.registries().find(r => r.id === registry.id).repositories.includes('team/new-api'), 'editing a global connection keeps tracked repositories')
  assert.throws(() => store.saveRegistry({ ...registry, repositories: ['../escape'] }))
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '刷新仓库').click()`)
  await until(`Array.from(document.querySelectorAll('.registry-grid .el-table__row')).some(e => e.innerText.includes('team/new-api'))`)
  assert.equal(await evaluate(`document.body.innerText.includes('构建并上传') || document.body.innerText.includes('发布配置')`), false, 'resource page must not duplicate project publishing')
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '拉取到服务器').click()`)
  await until(`document.body.innerText.includes('拉取镜像到服务器')`)
  await evaluate(`Array.from(document.querySelector('.el-dialog').querySelectorAll('button')).find(b => b.innerText.trim() === '拉取镜像').click()`)
  await until(`document.body.innerText.includes('镜像已拉取')`)
  assert.equal(operations[0].action, 'pull'); assert.equal(operations[0].registryId, registry.id)
  await evaluate(`document.querySelector('.el-drawer__close-btn').click()`)
  await evaluate(`Array.from(document.querySelectorAll('.el-tabs__item')).find(e => e.innerText.trim() === '服务器').click()`)
  await until(`document.body.innerText.includes('容器列表')`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '暂停').click()`)
  await until(`document.querySelector('.el-message-box') !== null`)
  await evaluate(`Array.from(document.querySelectorAll('.el-message-box button')).find(b => b.innerText.trim() === '执行').click()`)
  await until(`document.body.innerText.includes('操作完成')`)
  assert.equal(operations.at(-1).action, 'pause')
  await evaluate(`document.querySelector('.el-drawer__close-btn').click()`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '查看日志').click()`)
  await until(`document.body.innerText.includes('API listening on port 80')`)
  await evaluate(`document.querySelector('.el-drawer__close-btn').click()`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '更新镜像并部署').click()`)
  await until(`document.body.innerText.includes('拉取并更新部署')`)
  await evaluate(`Array.from(document.querySelectorAll('.el-dialog button')).find(b => b.innerText.trim() === '拉取并更新部署').click()`)
  await until(`document.body.innerText.includes('新容器已启动，更新完成')`)
  assert.equal(operations.at(-1).kind, 'container'); assert.equal(operations.at(-1).action, 'update'); assert.equal(operations.at(-1).target, 'a'.repeat(64))
  await evaluate(`document.querySelector('.el-drawer__close-btn').click()`)
  if (process.env.PROJECT_HUB_SMOKE_SCREENSHOT) {
    await until(`Array.from(document.querySelectorAll('.el-overlay')).every(e => getComputedStyle(e).display === 'none')`)
    await new Promise(resolve => setTimeout(resolve, 500))
    fs.writeFileSync(process.env.PROJECT_HUB_SMOKE_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
  }
  await evaluate(`Array.from(document.querySelectorAll('.el-tabs__item')).find(e => e.innerText.trim() === '自有服务').click()`)
  await until(`document.body.innerText.includes('api.service')`)
  // Reproduce overflowing server lists in the minimum supported window size.
  snapshot.containers = Array.from({ length: 50 }, (_, i) => ({ ...snapshot.containers[0], Names: 'container-' + i }))
  snapshot.images = Array.from({ length: 50 }, (_, i) => ({ ...snapshot.images[0], Repository: 'team/image-' + i }))
  snapshot.services = Array.from({ length: 50 }, (_, i) => ({ name: 'app-' + i + '.service', active: 'active', description: 'service ' + i }))
  window.setSize(1024, 640)
  async function verifyServerScrolling(lastRow) {
    await until(`document.body.innerText.includes(${JSON.stringify(lastRow)})`)
    await until(`Array.from(document.querySelectorAll('.el-overlay')).every(e => getComputedStyle(e).display === 'none')`)
    const selector = '.resource-tabs > .el-tabs__content'
    const bounds = await evaluate(`(() => { const e = document.querySelector('${selector}'); e.scrollTop = 0; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 40), y: Math.round(r.y + 100), bottom: r.bottom, height: innerHeight, overflow: e.scrollHeight > e.clientHeight } })()`)
    assert.equal(bounds.overflow, true, 'server content must have a bounded scroll area')
    assert.ok(bounds.bottom <= bounds.height + 1, 'scroll area must remain inside the window')
    window.webContents.sendInputEvent({ type: 'mouseMove', x: bounds.x, y: bounds.y })
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    await window.webContents.capturePage() // Wait for the resized/tab-switched compositor frame.
    window.webContents.sendInputEvent({ type: 'mouseWheel', x: bounds.x, y: bounds.y, deltaX: 0, deltaY: -500, canScroll: true })
    try { await until(`document.querySelector('${selector}').scrollTop > 0`) }
    catch (error) { console.log('Scroll diagnostics:', bounds, await evaluate(`(() => { const e = document.querySelector('${selector}'); const hit = document.elementFromPoint(${bounds.x}, ${bounds.y}); return { scrollTop: e.scrollTop, height: e.clientHeight, content: e.scrollHeight, hit: hit?.outerHTML.slice(0, 250) } })()`)); throw error }

    await evaluate(`(() => { const e = document.querySelector('${selector}'); e.scrollTop = e.scrollHeight })()`)
    assert.equal(await evaluate(`(() => { const e = document.querySelector('${selector}'); return e.scrollHeight - e.clientHeight - e.scrollTop < 2 })()`), true, 'last list row must be reachable')
  }
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '刷新服务器').click()`)
  await verifyServerScrolling('app-49.service')
  await evaluate(`Array.from(document.querySelectorAll('.el-tabs__item')).find(e => e.innerText.trim() === 'Docker').click()`)
  await verifyServerScrolling('team/image-49')
  console.log('PASS: Docker and native service lists scroll by mouse wheel and reach the bottom at 1024x640')
  const runtimeErrors = errors.filter(text => text !== 'ResizeObserver loop completed with undelivered notifications.')
  assert.ok(!runtimeErrors.length, runtimeErrors.join('\n'))
  console.log('PASS: registry catalog/tags, authenticated remote pull, server Docker list, pause, logs, update deployment and native services')
  window.destroy(); app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
