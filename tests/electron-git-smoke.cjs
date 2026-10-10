const { app } = require('electron')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { mkdirSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const fixture = process.env.PROJECT_HUB_GIT_TEST_DIR
const local = join(fixture, 'local'), remote = join(fixture, 'remote.git')
const git = args => execFileSync('git', args, { stdio: 'pipe' })
mkdirSync(local)
git(['init', '-b', 'main', local]); git(['init', '--bare', remote])
git(['-C', local, 'config', 'user.name', 'Test']); git(['-C', local, 'config', 'user.email', 'test@example.com'])
git(['-C', local, 'config', 'commit.gpgsign', 'false'])
writeFileSync(join(local, 'file.txt'), 'initial')
git(['-C', local, 'add', '.']); git(['-C', local, 'commit', '-m', 'initial'])
git(['-C', local, 'remote', 'add', 'origin', remote]); git(['-C', local, 'push', '-u', 'origin', 'main'])
app.setPath('userData', join(fixture, 'userData'))
app.setAppPath(process.env.PROJECT_HUB_GIT_TEST_ROOT)
const timer = setTimeout(() => { console.error('Git UI smoke timed out'); app.exit(1) }, 25000)
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
process.on('unhandledRejection', error => { console.error(error); app.exit(1) })
app.on('browser-window-created', (_event, win) => {
  win.show = () => {}
  win.webContents.once('did-finish-load', async () => {
    const evaluate = code => win.webContents.executeJavaScript(code, true)
    const waitFor = async code => {
      const deadline = Date.now() + 7000
      while (!await evaluate(code)) {
        if (Date.now() > deadline) throw new Error('UI condition timed out: ' + code)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    try {
      const project = await evaluate(`(async () => {
        const workspaces = await window.api.workspace.list()
        return window.api.project.add({ workspace_id: workspaces[0].id, name: 'Git live test', path: ${JSON.stringify(local)} })
      })()`)
      await evaluate(`location.hash = ${JSON.stringify('#/projects/' + project.id)}`)
      await waitFor(`document.body.innerText.includes('未提交变更')`)
      await evaluate(`(() => {
        const input = document.querySelector('input[placeholder^="提交说明"]')
        input.value = 'preserved draft'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      writeFileSync(join(local, 'file.txt'), 'external save')
      await waitFor(`document.querySelector('.changes-unstaged .changes-list')?.innerText.includes('file.txt') && !document.querySelector('.changes-staged .changes-list')`)
      assert.equal(await evaluate(`document.querySelector('input[placeholder^="提交说明"]').value`), 'preserved draft')
      git(['-C', local, 'add', '.'])
      await waitFor(`document.querySelector('.changes-staged .changes-list')?.innerText.includes('file.txt') && !document.querySelector('.changes-unstaged .changes-list')`)
      writeFileSync(join(local, 'file.txt'), 'changed after staging')
      await waitFor(`document.querySelector('.changes-staged .changes-list')?.innerText.includes('file.txt') && document.querySelector('.changes-unstaged .changes-list')?.innerText.includes('file.txt')`)
      git(['-C', local, 'add', '.']); git(['-C', local, 'commit', '-m', 'external pending commit'])
      await waitFor(`document.querySelector('.el-tab-pane .commit-list')?.innerText.includes('external pending commit') && !document.querySelector('.changes-list')`)
      git(['-C', local, 'push'])
      await waitFor(`!document.querySelector('.el-tab-pane .commit-list') && document.querySelector('.el-tab-pane')?.innerText.includes('没有待推送提交')`)
      assert.equal(await evaluate(`document.querySelector('input[placeholder^="提交说明"]').value`), 'preserved draft')
      await evaluate(`location.hash = '#/projects'`)
      await waitFor(`!document.querySelector('input[placeholder^="提交说明"]')`)
      clearTimeout(timer)
      console.log('Built Electron Git UI: saves, git add, partial staging, commits and push refresh automatically; draft preserved; page exits cleanly')
      app.quit()
    } catch (error) { console.error(error); app.exit(1) }
  })
})
require(join(process.env.PROJECT_HUB_GIT_TEST_ROOT, 'out/main/index.js'))
