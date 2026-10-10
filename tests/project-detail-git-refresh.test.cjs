const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { parse, compileScript } = require('@vue/compiler-sfc')
const vue = require('vue')

const filename = path.join(__dirname, '../src/views/ProjectDetail.vue')
const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
const script = compileScript(descriptor, { id: 'git-refresh-test' })
const compiled = ts.transpileModule(script.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function createPage(api) {
  const errors = []
  const cleanup = []
  const listeners = new Map()
  api.git = { branches: async () => [], summary: async () => (await api.project.detail('project')).git, ...api.git }
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, crypto: require('node:crypto'),
    window: { api, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    require(name) {
      if (name === 'vue') return { ...vue, onMounted() {}, onUnmounted: callback => cleanup.push(callback) }
      if (name === 'vue-router') return { useRoute: () => ({ params: { id: 'project' } }), useRouter: () => ({}) }
      if (name === 'element-plus') return { ElMessage: { success() {}, warning() {}, error: (message) => errors.push(message) }, ElMessageBox: {} }
      if (name === '@element-plus/icons-vue') return {}
      throw new Error(`Unexpected import: ${name}`)
    }
  })
  return { page: module.exports.default.setup({}, { expose() {} }), errors, listeners, dispose: () => cleanup.forEach(callback => callback()) }
}

function detail(changes, ahead = 0) {
  return { name: 'project', remotes: [{ name: 'origin' }], git: { isGit: true, changes, ahead, behind: 0 } }
}

test('push waits for fresh status and history, retaining real uncommitted changes', async () => {
  let resolveDetail
  let resolveLog
  const { page } = createPage({
    project: { detail: () => new Promise((resolve) => { resolveDetail = resolve }) },
    git: { push: async () => 'pushed', log: () => new Promise((resolve) => { resolveLog = resolve }) }
  })
  page.git.value = detail([{ path: 'old.txt', status: 'M' }], 1).git
  page.selectedChanges.value = new Set(['old.txt', 'remaining.txt'])
  const pending = page.doPush()
  await new Promise(setImmediate)
  assert.equal(page.busy.value, 'push')
  resolveDetail(detail([{ path: 'remaining.txt', status: 'M' }]))
  resolveLog([{ hash: 'new', message: 'latest' }])
  await pending
  assert.equal(page.busy.value, '')
  assert.equal(page.git.value.ahead, 0)
  assert.deepEqual(page.git.value.changes.map((change) => change.path), ['remaining.txt'])
  assert.deepEqual([...page.selectedChanges.value], ['remaining.txt'])
  assert.equal(page.commits.value[0].hash, 'new')
})

test('successful commit followed by failed push still clears committed changes and updates history', async () => {
  let committed = false
  const { page, errors } = createPage({
    project: { detail: async () => detail(committed ? [] : [{ path: 'file.txt', status: 'M' }], 1) },
    git: {
      commit: async () => { committed = true; return 'committed' },
      push: async () => { throw new Error('network unavailable') },
      log: async () => [{ hash: 'new-commit', message: 'fix' }]
    }
  })
  page.commitMessage.value = 'fix'
  page.git.value = detail([{ path: 'file.txt', status: 'M' }]).git
  await page.commitAndPush()
  assert.equal(page.git.value.changes.length, 0)
  assert.equal(page.git.value.ahead, 1)
  assert.equal(page.commits.value[0].hash, 'new-commit')
  assert.equal(page.busy.value, '')
  assert.match(errors[0], /network unavailable/)
  assert.match(errors[0], /已提交到本地，但推送失败/)
  assert.equal(page.gitPushError.value, errors[0])
})

test('pull refreshes status and commit history before releasing its busy state', async () => {
  const { page } = createPage({
    project: { detail: async () => detail([]) },
    git: { pull: async () => 'pulled', log: async () => [{ hash: 'remote-commit' }] }
  })
  await page.doPull()
  assert.equal(page.git.value.changes.length, 0)
  assert.equal(page.commits.value[0].hash, 'remote-commit')
  assert.equal(page.busy.value, '')
})

test('commit all ignores checkbox selection, while commit selected passes only checked paths', async () => {
  const calls = []
  const { page } = createPage({
    project: { detail: async () => detail([]) },
    git: {
      commit: async (...args) => { calls.push(args); return 'committed' },
      log: async () => []
    }
  })
  page.commitMessage.value = 'all changes'
  page.selectedChanges.value = new Set(['uv.lock'])
  await page.doCommit(false)
  assert.equal(calls[0][2], undefined)

  page.commitMessage.value = 'selected changes'
  page.selectedChanges.value = new Set(['uv.lock'])
  await page.doCommit(false, true)
  assert.deepEqual(Array.from(calls[1][2]), ['uv.lock'])
})

test('run command deletion supports built-in and custom commands and reloads the saved list', async () => {
  const commands = [
    { cmd: 'npm run dev', custom: false },
    { cmd: './run.sh', custom: true }
  ]
  const removed = new Set()
  const { page } = createPage({
    project: {
      removeRunCommand: async (id, cmd) => { assert.equal(id, 'project'); removed.add(cmd) },
      runCommands: async () => commands.filter((command) => !removed.has(command.cmd))
    }
  })
  await page.loadRunCommands()
  await page.removeRunCommand('npm run dev')
  assert.equal(page.runCommands.value.length, 1)
  assert.equal(page.runCommands.value[0].cmd, './run.sh')
  await page.loadRunCommands()
  assert.equal(page.runCommands.value.length, 1)
  await page.removeRunCommand('./run.sh')
  assert.equal(page.runCommands.value.length, 0)
})

test('live Git refresh preserves drafts and merges events arriving during a read', async () => {
  let reads = 0
  let resolveFirst
  const { page } = createPage({
    project: { detail: () => { throw new Error('Must not reload project forms') } },
    git: {
      summary: () => ++reads === 1 ? new Promise(resolve => { resolveFirst = resolve }) : Promise.resolve(detail([{ path: 'latest.txt', status: 'M' }], 2).git),
      log: async () => [{ hash: 'latest' }]
    }
  })
  page.commitMessage.value = 'draft commit'
  page.editForm.value = { name: 'unsaved name', description: 'draft description' }
  page.selectedChanges.value = new Set(['latest.txt', 'removed.txt'])
  const first = page.refreshGit()
  const second = page.refreshGit()
  assert.equal(first, second)
  resolveFirst(detail([{ path: 'latest.txt', status: 'M' }]).git)
  await first
  assert.equal(reads, 2)
  assert.equal(page.git.value.ahead, 2)
  assert.equal(page.commitMessage.value, 'draft commit')
  assert.equal(page.editForm.value.name, 'unsaved name')
  assert.deepEqual([...page.selectedChanges.value], ['latest.txt'])
})

test('project-scoped events and focus refresh Git, and unmount removes the subscription', async () => {
  let changed, token, unwatched, removed = false, reads = 0
  const { page, listeners, dispose } = createPage({
    git: {
      onChanged: callback => { changed = callback; return () => { removed = true } },
      watch: async (id, value) => { assert.equal(id, 'project'); token = value },
      unwatch: async value => { unwatched = value },
      summary: async () => { reads++; return detail([]).git }, log: async () => []
    }
  })
  page.startGitWatching()
  changed({ id: 'other-project', token })
  assert.equal(reads, 0)
  changed({ id: 'project', token })
  await new Promise(setImmediate)
  assert.equal(reads, 1)
  listeners.get('focus')()
  await new Promise(setImmediate)
  assert.equal(reads, 2)
  dispose()
  assert.equal(removed, true)
  assert.equal(unwatched, token)
  assert.equal(listeners.has('focus'), false)
  changed({ id: 'project', token })
  assert.equal(reads, 2)
})

test('groups index and worktree changes independently, including partial staging, untracked files and conflicts', () => {
  const { page } = createPage({})
  page.git.value = detail([
    { path: 'staged.txt', status: 'M', indexStatus: 'M', worktreeStatus: '' },
    { path: 'unstaged.txt', status: 'M', indexStatus: '', worktreeStatus: 'M' },
    { path: 'partial.txt', status: 'MM', indexStatus: 'M', worktreeStatus: 'M' },
    { path: 'new.txt', status: '??', indexStatus: '?', worktreeStatus: '?' },
    { path: 'conflict.txt', status: 'UU', indexStatus: 'U', worktreeStatus: 'U' },
    { path: 'both-added.txt', status: 'AA', indexStatus: 'A', worktreeStatus: 'A' },
    { path: 'deleted.txt', status: 'D', indexStatus: 'D', worktreeStatus: '' }
  ]).git
  const [staged, unstaged] = page.changeGroups.value
  assert.deepEqual(Array.from(staged.files, f => f.path), ['staged.txt', 'partial.txt', 'deleted.txt'])
  assert.deepEqual(Array.from(unstaged.files, f => f.path), ['unstaged.txt', 'partial.txt', 'new.txt', 'conflict.txt', 'both-added.txt'])
  assert.equal(unstaged.files.find(f => f.path === 'new.txt').displayStatus, '未跟踪')
  assert.equal(unstaged.files.find(f => f.path === 'conflict.txt').displayStatus, '冲突')
})

test('failed branch checkout restores the actual branch and keeps edit drafts', async () => {
  const { page, errors } = createPage({
    git: {
      checkout: async () => { throw new Error('Local changes would be overwritten') },
      summary: async () => ({ ...detail([]).git, branch: 'main' }), log: async () => [],
      branches: async () => [{ name: 'main', current: true }, { name: 'feature', current: false }]
    }
  })
  page.branches.value = [{ name: 'main', current: true }, { name: 'feature', current: false }]
  page.selectedBranch.value = 'feature'
  page.editForm.value = { name: 'draft name', description: 'draft description' }
  page.commitMessage.value = 'draft commit'
  await page.switchBranch('feature')
  assert.equal(page.selectedBranch.value, 'main')
  assert.equal(page.busy.value, '')
  assert.equal(page.editForm.value.name, 'draft name')
  assert.equal(page.commitMessage.value, 'draft commit')
  assert.match(errors[0], /Local changes would be overwritten/)
})

test('non-fast-forward push explains how to recover without misreporting a successful commit', async () => {
  const { page, errors } = createPage({
    git: {
      commit: async () => '已提交：fix',
      push: async () => { throw new Error("Error invoking remote method 'git:push': Error: Command failed: git push\n! [rejected] master -> master (fetch first)") },
      summary: async () => ({ ...detail([], 1).git, behind: 1 }), log: async () => [{ hash: 'local-commit' }]
    }
  })
  page.commitMessage.value = 'fix'
  await page.commitAndPush()
  assert.match(errors[0], /已提交到本地，但推送失败/)
  assert.match(errors[0], /先拉取并合并/)
  assert.doesNotMatch(errors[0], /Error invoking|Command failed/)
  assert.equal(page.commitMessage.value, '')
  assert.equal(page.git.value.ahead, 1)
  assert.equal(page.git.value.behind, 1)
  assert.equal(page.busy.value, '')
})

test('commit failure keeps the message draft and does not claim that a push failed', async () => {
  const { page, errors } = createPage({
    git: {
      commit: async () => { throw new Error('identity missing') },
      push: () => { throw new Error('Push must not run') },
      summary: async () => detail([{ path: 'file.txt', status: 'M' }]).git, log: async () => []
    }
  })
  page.commitMessage.value = 'draft'
  await page.commitAndPush()
  assert.match(errors[0], /提交失败/)
  assert.equal(page.gitPushError.value, '')
  assert.equal(page.commitMessage.value, 'draft')
})
