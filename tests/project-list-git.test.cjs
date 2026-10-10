const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const vue = require('vue')
const { parse, compileScript } = require('@vue/compiler-sfc')

function compile(content) {
  return ts.transpileModule(content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
}
function createMonitor(projects, api) {
  const lifecycle = {}, listeners = new Map(), module = { exports: {} }
  vm.runInNewContext(compile(fs.readFileSync(path.join(__dirname, '../src/composables/useProjectGitStatus.ts'), 'utf8')), {
    module, exports: module.exports, crypto: require('node:crypto'),
    window: { api: { git: api }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    require: () => ({ ...vue, onMounted: fn => { lifecycle.start = fn }, onActivated() {}, onDeactivated: fn => { lifecycle.stop = fn }, onUnmounted() {} })
  })
  return { ...module.exports.useProjectGitStatus(projects), lifecycle, listeners }
}
const tick = () => new Promise(setImmediate)
const summary = ahead => ({ isGit: true, ahead, changes: [] })

test('list monitoring bounds concurrency, merges changes and disposes subscriptions on deactivation', async () => {
  const projects = vue.ref(Array.from({ length: 12 }, (_, id) => ({ id: String(id), path: `/project/${id}` })))
  const tokens = new Map(), unwatched = [], pending = []
  let onChanged, active = 0, maximum = 0, reads = 0
  const monitor = createMonitor(projects, {
    watch: async (id, token) => tokens.set(id, token), unwatch: async token => unwatched.push(token),
    onChanged: fn => { onChanged = fn; return () => { onChanged = undefined } },
    summary: id => {
      reads++; active++; maximum = Math.max(maximum, active)
      return new Promise(resolve => pending.push({ id, resolve })).finally(() => { active-- })
    }
  })
  monitor.lifecycle.start()
  await tick()
  assert.equal(reads, 4)
  onChanged({ id: '0', token: tokens.get('0') })
  onChanged({ id: '0', token: tokens.get('0') })
  onChanged({ id: '1', token: 'unrelated subscription' })
  while (pending.length) {
    pending.splice(0).forEach(read => read.resolve(summary(1)))
    await tick()
  }
  assert.equal(maximum, 4)
  assert.equal(reads, 13, 'events during a read require only one additional read')
  assert.equal(Object.keys(monitor.summaries.value).length, 12)
  monitor.listeners.get('focus')()
  assert.equal(pending.length, 4)
  monitor.lifecycle.stop()
  pending.splice(0).forEach(read => read.resolve(summary(9)))
  await tick()
  assert.equal(monitor.summaries.value['0'].ahead, 1, 'in-flight reads cannot overwrite state after leaving')
  assert.equal(unwatched.length, 12)
  assert.equal(onChanged, undefined)
  assert.equal(monitor.listeners.size, 0)
})

test('removed projects release their watcher and cannot return from stale reads; errors remain visible', async () => {
  const projects = vue.ref([{ id: 'old', path: '/old' }])
  let resolveOld
  const unwatched = []
  const monitor = createMonitor(projects, {
    watch: async () => {}, unwatch: async token => unwatched.push(token), onChanged: () => () => {},
    summary: id => id === 'old' ? new Promise(resolve => { resolveOld = resolve }) : Promise.reject(new Error('missing directory'))
  })
  monitor.lifecycle.start()
  await tick()
  projects.value = [{ id: 'new', path: '/new' }]
  await vue.nextTick()
  await tick()
  resolveOld(summary(8))
  await tick()
  assert.equal(monitor.summaries.value.old, undefined)
  assert.match(monitor.errors.value.new, /missing directory/)
  assert.equal(unwatched.length, 1)
  monitor.lifecycle.stop()
})

test('status badges distinguish tracked changes, untracked files and unpublished commits', () => {
  const filename = path.join(__dirname, '../src/components/ProjectGitStatus.vue')
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const module = { exports: {} }
  vm.runInNewContext(compile(compileScript(descriptor, { id: 'git-list-status' }).content), {
    module, exports: module.exports, require: () => vue
  })
  const props = vue.reactive({ summary: { isGit: true, ahead: 3, changes: [{ status: 'MM' }, { status: 'UU' }, { status: '??' }] } })
  const status = module.exports.default.setup(props, { expose() {}, emit() {} })
  assert.deepEqual(Array.from(status.indicators.value, item => [item.label, item.count]), [['未提交', 2], ['未跟踪', 1], ['未推送', 3]])
  props.summary = { isGit: true, ahead: 0, changes: [] }
  assert.equal(status.indicators.value.length, 0)
  props.error = 'Git unavailable'
  assert.match(status.description.value, /无法读取 Git 状态/)
})
