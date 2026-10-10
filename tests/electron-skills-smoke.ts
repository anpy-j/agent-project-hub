import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SkillsManager } from '../electron/services/skills.service'
import { seedBundledSkills } from '../electron/services/skills-bundled'
import { createSkillsStore } from '../electron/db/skills'
import { getDb, closeDb } from '../electron/db'
import { registerSkillsIpc } from '../electron/ipc/skills'
import type { SkillTargetInfo } from '../src/types/skills'

const dir = process.env.PROJECT_HUB_SKILLS_SMOKE_DIR!, root = process.env.PROJECT_HUB_SKILLS_ROOT!
app.setPath('userData', dir)
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const source = join(dir, 'sample-skill'); mkdirSync(join(source, 'references'), { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), '---\nname: sample-skill\ndescription: Electron 界面测试技能\n---\n# 界面测试技能\n\n查看 references/guide.md。')
  writeFileSync(join(source, 'references/guide.md'), '# 原始引用\n完整资源文件')
  const project = { id: 'demo', name: '测试项目', display_name: '测试项目', workspace_id: 'personal', path: join(dir, 'project'), type: 'node' }
  mkdirSync(project.path)
  const targets: SkillTargetInfo[] = ['codex', 'opencode', 'antigravity', 'hub'].map(id => ({ id: id as SkillTargetInfo['id'], name: ({ codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity', hub: 'Project Hub AI' })[id], globalPath: join(dir, 'targets', id), projectFolder: '.agents/skills', hint: '隔离测试目录' }))
  const options = { root: join(dir, 'skills'), home: join(dir, 'home'), targets, bundledRoot: join(dir, 'project', 'resources', 'bundled-skills'), store: createSkillsStore(), project: (id: string) => id === 'demo' ? project : null }
  const manager = new SkillsManager(options)
  await registerSkillsIpc(manager)
  ipcMain.handle('workspace:list', () => [{ id: 'personal', name: '个人', kind: 'personal' }])
  ipcMain.handle('project:list', () => [project])
  const exported = join(dir, 'export.zip')
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: exported })
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { preload: join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, offscreen: true, backgroundThrottling: false } })
  const errors: string[] = []
  win.webContents.on('console-message', (_event, level, text) => { if (level >= 3) errors.push(text) })
  await win.loadFile(join(root, 'out/renderer/index.html'), { hash: '/ai/skills' })
  const evaluate = async (code: string) => {
    try { return await win.webContents.executeJavaScript(code, true) }
    catch (error) { throw new Error(`Renderer evaluation failed: ${code}\n${errors.join('\n')}\n${(error as Error).message}`) }
  }
  async function waitFor(code: string) {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (await evaluate(code)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`UI condition not reached: ${code}\n${await evaluate('document.body.innerText')}`)
  }
  await waitFor(`document.body.innerText.includes('Skills 管理') && document.body.innerText.includes('导入技能包')`)
  assert.equal(await evaluate('typeof window.api.skills.preview'), 'function')
  // Import through the real dialog, native picker, preview, preload and IPC.
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='导入技能').click()`)
  await waitFor(`document.body.innerText.includes('本地文件')`)
  await evaluate(`Array.from(document.querySelectorAll('.el-radio-button')).find(b=>b.textContent.trim()==='本地文件').click()`)
  await waitFor(`document.body.innerText.includes('选择文件夹')`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='选择文件夹').click()`)
  await waitFor(`Array.from(document.querySelectorAll('input')).some(i=>i.value===${JSON.stringify(source)})`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='解析并预览').click()`)
  await waitFor(`document.querySelector('.candidate')?.textContent.includes('sample-skill')`)
  await waitFor(`document.querySelector('.candidate-description')?.textContent.includes('Electron 界面测试技能')`)
  assert.equal(await evaluate(`document.querySelector('.candidate-location code')?.textContent`), source)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='加入技能库').click()`)
  await waitFor(`document.querySelector('.skill-row')?.textContent.includes('sample-skill')`)
  const importedId = manager.snapshot().skills[0].id
  // Empty installed filter must clear the previously selected detail.
  await evaluate(`Array.from(document.querySelectorAll('.state-tabs .el-radio-button')).find(b=>b.textContent.trim()==='已安装').click()`)
  await waitFor(`!document.querySelector('.skill-detail') && document.body.innerText.includes('当前筛选没有技能')`)
  await evaluate(`Array.from(document.querySelectorAll('.state-tabs .el-radio-button')).find(b=>b.textContent.trim().startsWith('全部')).click()`)
  await waitFor(`document.querySelector('.skill-detail')?.textContent.includes('sample-skill')`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='加入随包分发').click()`)
  await waitFor(`document.body.innerText.includes('已加入随包分发')`)
  assert.ok(existsSync(join(options.bundledRoot, 'sample-skill', 'references', 'guide.md')))
  assert.equal(await evaluate(`window.api.skills.readFile(${JSON.stringify(importedId)},'references/guide.md')`), '# 原始引用\n完整资源文件')
  await evaluate(`Array.from(document.querySelectorAll('[role=tab]')).find(b=>b.textContent==='安装位置').click()`)
  await waitFor(`document.body.innerText.includes('Project Hub AI') && document.querySelectorAll('.target-block').length===4`)
  // At a small desktop window the bottom targets remain reachable by scrolling.
  win.setSize(1000, 640)
  await waitFor(`document.querySelector('.skill-detail').scrollHeight > document.querySelector('.skill-detail').clientHeight`)
  assert.equal(await evaluate(`(()=>{const el=document.querySelector('.skill-detail');el.scrollTop=el.scrollHeight;return el.scrollTop>0 && ['auto','scroll'].includes(getComputedStyle(el).overflowY)})()`), true, 'detail can scroll')
  const geometry = await evaluate(`(()=>{const el=document.querySelector('.skill-detail');const last=document.querySelector('.target-block:last-child').getBoundingClientRect();const panel=el.getBoundingClientRect();return {lastBottom:last.bottom,panelBottom:panel.bottom,viewport:innerHeight,scrollTop:el.scrollTop,height:el.clientHeight,total:el.scrollHeight}})()`)
  assert.ok(geometry.lastBottom <= geometry.panelBottom + 1 && geometry.panelBottom <= geometry.viewport + 1, JSON.stringify(geometry))
  win.setSize(1400, 1000)
  // Use the visible install dialog for the Codex deployment.
  await evaluate(`document.querySelector('.target-block button').click()`)
  await waitFor(`document.body.innerText.includes('确认安装')`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='确认安装').click()`)
  await waitFor(`document.querySelector('.installation')?.textContent.includes('已安装')`)
  assert.ok(existsSync(join(dir, 'targets', 'codex', 'sample-skill', 'references', 'guide.md')))
  const installId = manager.snapshot().installations[0].id
  await evaluate(`document.querySelector('.installation-actions button').click()`)
  await waitFor(`document.querySelector('.installation')?.textContent.includes('已停用')`)
  assert.equal(existsSync(join(dir, 'targets', 'codex', 'sample-skill')), false)
  await evaluate(`document.querySelector('.installation-actions button').click()`)
  await waitFor(`document.querySelector('.installation')?.textContent.includes('已安装')`)
  // Export and persistence are real filesystem/SQLite operations in the fixture.
  await evaluate(`window.api.skills.export(${JSON.stringify(importedId)})`)
  assert.ok(readFileSync(exported).length > 0)
  const reloaded = new SkillsManager({ ...options, store: createSkillsStore() })
  assert.equal(reloaded.snapshot().skills[0].id, importedId)
  assert.equal(reloaded.snapshot().installations[0].id, installId)
  assert.ok(getDb().prepare('SELECT COUNT(*) AS n FROM skill_history').get())
  await evaluate(`window.api.skills.install({skillId:${JSON.stringify(importedId)},target:'hub',scope:'project',projectId:'demo'})`)
  const context = await evaluate(`window.api.skills.context('demo')`)
  assert.equal(context.length, 1)
  await evaluate(`location.hash='/ai/assistant?projectId=demo'`)
  await waitFor(`location.hash.includes('/ai/skills')`)
  await evaluate(`Array.from(document.querySelectorAll('[role=tab]')).find(el => el.textContent === '概览').click()`)
  await waitFor(`!!document.querySelector('.assistant-config') && document.body.innerText.includes('当前提供说明与草稿')`)
  assert.equal(await evaluate(`location.hash.includes('/ai/skills?') && location.hash.includes('projectId=demo')`), true)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.side-nav .nav-item')).some(el => el.textContent.includes('技能助手'))`), false)
  assert.equal(await evaluate(`!!document.querySelector('.skill-detail .assistant-config') && !document.querySelector('.section-tabs')`), true)
  assert.equal(await evaluate(`document.querySelector('.assistant-heading').textContent.includes(document.querySelector('.detail-title h2').textContent)`), true)
  if (process.env.PROJECT_HUB_SKILLS_SCREENSHOT) {
    await evaluate(`Array.from(document.querySelectorAll('[role=tab]')).find(b=>b.textContent==='概览').click()`)
    await waitFor(`Array.from(document.querySelectorAll('.el-loading-mask,.el-overlay,.el-message')).every(el=>!el.getClientRects().length || getComputedStyle(el).display==='none' || getComputedStyle(el).visibility==='hidden' || Number(getComputedStyle(el).opacity)===0)`)
    const screenshot = await win.webContents.capturePage()
    writeFileSync(process.env.PROJECT_HUB_SKILLS_SCREENSHOT, screenshot.toPNG())
  }
  assert.deepEqual(errors, [])
  await seedBundledSkills(manager, join(root, 'resources', 'bundled-skills'))
  const bundled = manager.snapshot().skills.find(skill => skill.name === 'github-release-desktop')
  assert.ok(bundled, 'actual project resource is imported into isolated SQLite library')
  assert.ok(manager.readFile(bundled.id, 'references/electron.md').length > 0)
  console.log('PASS: Electron preload/IPC, SQLite persistence, Skills UI install/disable/enable, ZIP export and Hub context')
  win.destroy(); closeDb(); app.quit()
}).catch(error => { console.error(error); app.exit(1) })
