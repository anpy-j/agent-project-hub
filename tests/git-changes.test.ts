import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitSummary, gitCommitFiles, gitPushUpstream, parseGitChanges } from '../electron/services/git.service'

test('porcelain paths preserve initial status whitespace, Unicode, spaces and rename destinations', () => {
  assert.deepEqual(parseGitChanges(' M src/views/ProjectDetail.vue\0?? 中文 文件.txt\0R  new name.txt\0old name.txt\0'), [
    { status: 'M', path: 'src/views/ProjectDetail.vue', indexStatus: '', worktreeStatus: 'M' },
    { status: '??', path: '中文 文件.txt', indexStatus: '?', worktreeStatus: '?' },
    { status: 'R', path: 'new name.txt', indexStatus: 'R', worktreeStatus: '' }
  ])
})

test('selected modified file commits and pushes with its complete path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-changes-'))
  const local = join(root, 'local'), remote = join(root, 'remote.git')
  const run = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    mkdirSync(local)
    run(['init', '-b', 'main', local]); run(['init', '--bare', remote])
    run(['-C', local, 'config', 'user.name', 'Test']); run(['-C', local, 'config', 'user.email', 'test@example.com'])
    run(['-C', local, 'config', 'commit.gpgsign', 'false'])
    mkdirSync(join(local, 'src', 'views'), { recursive: true })
    const relative = 'src/views/ProjectDetail.vue'
    writeFileSync(join(local, relative), 'initial\n')
    run(['-C', local, 'add', '.']); run(['-C', local, 'commit', '-m', 'initial'])
    run(['-C', local, 'remote', 'add', 'origin', remote])
    writeFileSync(join(local, relative), 'updated\n')
    const summary = await gitSummary(local)
    assert.equal(summary.changes[0].path, relative)
    assert.equal(summary.changes[0].indexStatus, '')
    assert.equal(summary.changes[0].worktreeStatus, 'M')
    run(['-C', local, 'add', '.'])
    const staged = (await gitSummary(local)).changes[0]
    assert.equal(staged.indexStatus, 'M')
    assert.equal(staged.worktreeStatus, '')
    writeFileSync(join(local, relative), 'updated again\n')
    const partial = (await gitSummary(local)).changes[0]
    assert.equal(partial.indexStatus, 'M')
    assert.equal(partial.worktreeStatus, 'M')
    assert.equal(summary.upstream, null)
    assert.equal(summary.ahead, 1)
    assert.equal(summary.pendingCommits?.[0].message, 'initial')
    await gitCommitFiles(local, [summary.changes[0].path], 'fix path parsing')
    await gitPushUpstream(local)
    assert.equal((await gitSummary(local)).upstream, 'origin/main')
    assert.deepEqual((await gitSummary(local)).pendingCommits, [])
    assert.equal(run(['--git-dir', remote, 'show', 'main:' + relative]), 'updated again')
    const renamed = 'src/views/中文 页面.vue'
    renameSync(join(local, relative), join(local, renamed))
    run(['-C', local, 'add', '-A'])
    assert.equal((await gitSummary(local)).changes[0].path, renamed)
    await gitCommitFiles(local, [renamed], 'rename page')
    assert.equal((await gitSummary(local)).ahead, 1)
    assert.equal((await gitSummary(local)).pendingCommits?.[0].message, 'rename page')
    assert.equal(run(['-C', local, 'status', '--porcelain']), '')
    // 提交全部必须同时覆盖已修改文件和新增文件，不能只提交暂存区中的 lock 文件。
    writeFileSync(join(local, renamed), 'modified again\n')
    writeFileSync(join(local, 'new file.txt'), 'new\n')
    writeFileSync(join(local, 'uv.lock'), 'lock\n')
    run(['-C', local, 'add', 'uv.lock'])
    await gitCommitFiles(local, null, 'commit all changes')
    assert.equal(run(['-C', local, 'status', '--porcelain']), '')
    assert.equal(run(['-C', local, 'show', 'HEAD:new file.txt']), 'new')
    assert.equal(run(['-C', local, 'show', `HEAD:${renamed}`]), 'modified again')
    await gitPushUpstream(local)
    assert.equal((await gitSummary(local)).ahead, 0)
    assert.equal(run(['--git-dir', remote, 'show', 'main:new file.txt']), 'new')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('unborn branch still reports new files without a commit or upstream', async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-unborn-'))
  try {
    execFileSync('git', ['init', '-b', 'main', root])
    writeFileSync(join(root, 'new.txt'), 'new')
    const summary = await gitSummary(root)
    assert.equal(summary.branch, 'main')
    assert.deepEqual(summary.changes, [{ path: 'new.txt', status: '??', indexStatus: '?', worktreeStatus: '?' }])
    assert.equal(summary.ahead, 0)
    assert.deepEqual(summary.pendingCommits, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
