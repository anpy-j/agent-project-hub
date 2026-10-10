import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchGitProject } from '../electron/services/git-watch.service'
import { gitSummary } from '../electron/services/git.service'

test('filesystem notifications refresh external saves and commits, without status-read loops; disposal closes watchers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-watch-'))
  const run = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
  let stop = () => {}
  let events = 0
  let next: (() => void) | undefined
  let failure: Error | undefined
  const event = (action: () => void) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Missing filesystem notification')), 5000)
    next = () => { clearTimeout(timeout); next = undefined; resolve() }
    action()
  })
  try {
    run(['init', '-b', 'main'])
    run(['config', 'user.name', 'Test']); run(['config', 'user.email', 'test@example.com'])
    run(['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(root, 'file.txt'), 'initial')
    run(['add', '.']); run(['commit', '-m', 'initial'])
    stop = watchGitProject(root, () => { events++; next?.() }, error => { failure = error })
    await event(() => writeFileSync(join(root, 'file.txt'), 'updated'))
    assert.equal((await gitSummary(root)).changes[0].path, 'file.txt')
    await event(() => { run(['add', '.']); run(['commit', '-m', 'external | 中文']) })
    const summary = await gitSummary(root)
    assert.equal(summary.changes.length, 0)
    assert.equal(summary.pendingCommits?.[0].message, 'external | 中文')
    const count = events
    await gitSummary(root)
    await new Promise(resolve => setTimeout(resolve, 650))
    assert.equal(events, count, 'reading status must not modify the index or trigger another refresh')
    stop()
    writeFileSync(join(root, 'file.txt'), 'after disposal')
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(events, count)
    assert.equal(failure, undefined)
  } finally { stop(); rmSync(root, { recursive: true, force: true }) }
})

test('worktree watches external Git metadata and shared remote refs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-watch-worktree-'))
  const main = join(root, 'main'), worktree = join(root, 'worktree')
  const run = (args: string[]) => execFileSync('git', args, { stdio: 'pipe' })
  let stop = () => {}
  let next: (() => void) | undefined
  try {
    run(['init', '-b', 'main', main])
    run(['-C', main, 'config', 'user.name', 'Test']); run(['-C', main, 'config', 'user.email', 'test@example.com'])
    run(['-C', main, 'config', 'commit.gpgsign', 'false'])
    writeFileSync(join(main, 'file.txt'), 'initial')
    run(['-C', main, 'add', '.']); run(['-C', main, 'commit', '-m', 'initial'])
    run(['-C', main, 'worktree', 'add', '-b', 'feature', worktree])
    stop = watchGitProject(worktree, () => next?.(), error => { throw error })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Missing shared refs notification')), 5000)
      next = () => { clearTimeout(timeout); next = undefined; resolve() }
      run(['-C', main, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
    })
    assert.equal((await gitSummary(worktree)).ahead, 0)
  } finally { stop(); rmSync(root, { recursive: true, force: true }) }
})
