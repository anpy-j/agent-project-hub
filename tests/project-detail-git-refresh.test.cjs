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
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, window: { api },
    require(name) {
      if (name === 'vue') return { ...vue, onMounted() {} }
      if (name === 'vue-router') return { useRoute: () => ({ params: { id: 'project' } }), useRouter: () => ({}) }
      if (name === 'element-plus') return { ElMessage: { success() {}, warning() {}, error: (message) => errors.push(message) }, ElMessageBox: {} }
      if (name === '@element-plus/icons-vue') return {}
      throw new Error(`Unexpected import: ${name}`)
    }
  })
  return { page: module.exports.default.setup({}, { expose() {} }), errors }
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
