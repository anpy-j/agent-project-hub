const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { EventEmitter } = require('node:events')
const { parse, compileScript } = require('@vue/compiler-sfc')
const vue = require('vue')

function evaluate(source, requireMock) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, {
    module, exports: module.exports, require: requireMock, process,
    setTimeout, clearTimeout, crypto: require('node:crypto'),
    window: { api: requireMock.api }, document: {},
  })
  return module.exports
}

test('runner permits concurrent commands, rejects duplicates, and stops only the selected task', async () => {
  const children = []
  const updates = []
  const service = evaluate(fs.readFileSync(path.join(__dirname, '../electron/services/runner.service.ts'), 'utf8'), name => {
    if (name === 'child_process') return { spawn() {
      const child = new EventEmitter()
      child.pid = children.length + 1
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      children.push(child)
      return child
    } }
    if (name === './process-tree') return { stopProcessTree: async child => { child.emit('close', null, 'SIGTERM') } }
    if (name === 'electron') return {}
    if (name === 'crypto' || name === 'path') return require(name)
    if (name === 'fs') return { appendFileSync() {} }
    if (name === '../db/repositories') return { projectRepo: { get: () => ({ path: '/project' }), update() {} } }
    if (name === './flutter-environment') return { isFlutter: () => false }
    if (name === './notify.service') return { notify() {} }
    return {}
  }).runnerService
  service.ensureLogPath = id => id
  service.persistTask = () => {}
  service.updateRunningRow = () => {}
  service.updateTaskStatus = () => {}
  service.isAutoRestartEnabled = () => false
  const send = (channel, task) => { if (channel === 'runner:status') updates.push(task) }
  const backend = { bin: 'npm', args: ['run', 'backend'], display: 'npm run backend' }
  const frontend = { bin: 'npm', args: ['run', 'frontend'], display: 'npm run frontend' }
  const first = await service.startCustom('project', backend, send)
  const second = await service.startCustom('project', frontend, send)
  assert.equal(service.listRunning().length, 2)
  await assert.rejects(service.startCustom('project', { ...backend, display: 'another label' }, send), /该命令/)
  await service.stop(first)
  await new Promise(setImmediate)
  assert.deepEqual(Array.from(service.listRunning(), task => task.id), [second])
  assert.equal(updates.findLast(task => task.id === first).status, 'stopped')
  await service.startCustom('project', backend, send)
  assert.equal(service.listRunning().length, 2)
})

function createPage(api) {
  const filename = path.join(__dirname, '../src/views/ProjectDetail.vue')
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const mock = name => {
    if (name === 'vue') return { ...vue, onMounted() {}, onUnmounted() {} }
    if (name === 'vue-router') return { useRoute: () => ({ params: { id: 'project' } }), useRouter: () => ({}) }
    if (name === 'element-plus') return { ElMessage: { warning() {}, error() {}, info() {} }, ElMessageBox: {} }
    if (name === '@element-plus/icons-vue') return {}
    throw new Error(name)
  }
  mock.api = api
  return evaluate(compileScript(descriptor, { id: 'runner-test' }).content, mock).default.setup({}, { expose() {} })
}

test('detail tracks concurrent tasks, separate logs, individual stopping, and early exit events', async () => {
  let page
  let count = 0
  const stopped = []
  const suggestion = name => ({ cmd: name, bin: name, args: [] })
  const task = (id, command, status = 'running') => ({ id, command, status, project_id: 'project', type: 'run' })
  page = createPage({ runner: {
    startCustom: async (_project, input) => {
      const id = String(++count)
      page.onRunStatus(task(id, input.display))
      if (input.display === 'short') page.onRunStatus(task(id, input.display, 'success'))
      return id
    },
    stop: async id => { stopped.push(id); page.onRunStatus(task(id, 'backend', 'stopped')) }
  } })
  await page.runCommand(suggestion('backend'))
  await page.runCommand(suggestion('frontend'))
  await page.runCommand(suggestion('backend'))
  assert.equal(count, 2)
  assert.equal(page.activeRunTasks.value.length, 2)
  page.appendRunLog({ taskId: '1', data: 'backend output' })
  page.appendRunLog({ taskId: '2', data: 'frontend output' })
  assert.match(page.runLogsText.value, /frontend output/)
  assert.doesNotMatch(page.runLogsText.value, /backend output/)
  page.runTaskId.value = '1'
  assert.match(page.runLogsText.value, /backend output/)
  await page.stopRun(page.runningCommand('backend'))
  assert.deepEqual(stopped, ['1'])
  assert.equal(page.activeRunTasks.value.length, 1)
  assert.equal(page.runningCommand('frontend').id, '2')
  await page.runCommand(suggestion('short'))
  assert.equal(page.activeRunTasks.value.length, 1)
})

test('detail restores every run task and excludes builds from run state', async () => {
  const page = createPage({ runner: {
    listRunning: async () => [
      { id: '1', project_id: 'project', type: 'run', command: 'backend', status: 'running' },
      { id: '2', project_id: 'project', type: 'run', command: 'frontend', status: 'running' },
      { id: '3', project_id: 'project', type: 'build', status: 'running' },
      { id: '4', project_id: 'other', type: 'run', status: 'running' }
    ], probeExternal: async () => ({ running: false, processes: [] })
  }, task: { readLog: async id => `log ${id}` } })
  await page.loadRunState()
  assert.equal(page.activeRunTasks.value.length, 2)
  assert.equal(page.runLogsText.value, 'log 1')
  page.runTaskId.value = '2'
  assert.equal(page.runLogsText.value, 'log 2')
})
