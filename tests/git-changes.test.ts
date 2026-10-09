import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitSummary, gitCommitFiles, gitPushUpstream, parseGitChanges } from '../electron/services/git.service'

test('porcelain paths preserve initial status whitespace, Unicode, spaces and rename destinations', () => {
  assert.deepEqual(parseGitChanges(' M src/views/ProjectDetail.vue\0?? 中文 文件.txt\0R  new name.txt\0old name.txt\0'), [
    { status: 'M', path: 'src/views/ProjectDetail.vue' },
    { status: '??', path: '中文 文件.txt' },
    { status: 'R', path: 'new name.txt' }
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
    await gitCommitFiles(local, [summary.changes[0].path], 'fix path parsing')
    await gitPushUpstream(local)
    assert.equal(run(['--git-dir', remote, 'show', 'main:' + relative]), 'updated')
    const renamed = 'src/views/中文 页面.vue'
    renameSync(join(local, relative), join(local, renamed))
    run(['-C', local, 'add', '-A'])
    assert.equal((await gitSummary(local)).changes[0].path, renamed)
    await gitCommitFiles(local, [renamed], 'rename page')
    assert.equal(run(['-C', local, 'status', '--porcelain']), '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
