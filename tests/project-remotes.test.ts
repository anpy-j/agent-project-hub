import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { readRemotes } from '../electron/services/git.service'

test('reads real Git fetch remotes, keeping spaced URLs and ignoring distinct push URLs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-remotes-'))
  const run = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
  try {
    run(['init'])
    const localUrl = join(root, '中文 remote.git')
    run(['remote', 'add', 'backup', localUrl])
    let remotes = await readRemotes(root)
    assert.deepEqual(remotes, [{ name: 'backup', url: localUrl, platform: 'other', is_default: 1 }])
    run(['remote', 'add', 'origin', 'git@github.com:example/project.git'])
    run(['remote', 'set-url', '--push', 'origin', 'git@gitee.com:example/push.git'])
    run(['remote', 'add', 'mirror', 'https://gitee.com/example/project.git'])
    remotes = await readRemotes(root)
    assert.equal(remotes.length, 3)
    assert.deepEqual(remotes.find((r) => r.name === 'origin'), {
      name: 'origin', url: 'git@github.com:example/project.git', platform: 'github', is_default: 1
    })
    assert.equal(remotes.find((r) => r.name === 'backup')?.is_default, 0)
    assert.equal(remotes.find((r) => r.name === 'mirror')?.platform, 'gitee')
    const plain = join(root, 'plain')
    mkdirSync(plain)
    assert.deepEqual(await readRemotes(plain), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('project list repairs missing associations and returns them without erasing existing remotes', async () => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const existing = [{ id: 'saved-remote', name: 'origin', url: 'https://github.com/example/saved.git' }]
  const projects = [
    { id: 'missing', path: '/missing', remotes: [] },
    { id: 'plain', path: '/plain', remotes: [] },
    { id: 'saved', path: '/saved', remotes: existing }
  ]
  const diskRemote = { name: 'origin', url: 'git@github.com:example/recovered.git', platform: 'github', is_default: 1 }
  const reads: string[] = []
  const writes: string[] = []
  const source = readFileSync(join(__dirname, '../electron/ipc/handlers.ts'), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} as { registerIpcHandlers: () => void } }
  runInNewContext(compiled, {
    module, exports: module.exports,
    require(name: string) {
      if (name === 'electron') return { ipcMain: { handle: (key: string, fn: (...args: any[]) => any) => handlers.set(key, fn) } }
      if (name === '../db/repositories') return {
        projectRepo: { list: (workspaceId: string) => { assert.equal(workspaceId, 'workspace'); return projects } },
        remoteRepo: { replaceAll: (id: string, remotes: object[]) => { writes.push(id); return remotes.map((r) => ({ ...r, id: 'recovered', project_id: id })) } }
      }
      if (name === '../services/git.service') return {
        readRemotes: async (path: string) => { reads.push(path); return path === '/missing' ? [diskRemote] : [] }
      }
      return {}
    }
  })
  module.exports.registerIpcHandlers()
  const result = await handlers.get('project:list')!(null, 'workspace')
  assert.deepEqual(reads.sort(), ['/missing', '/plain'])
  assert.deepEqual(writes, ['missing'])
  assert.equal(result[0].remotes[0].url, diskRemote.url)
  assert.equal(result[0].remotes[0].project_id, 'missing')
  assert.equal(result[1].remotes.length, 0)
  assert.equal(result[2].remotes, existing)
})
