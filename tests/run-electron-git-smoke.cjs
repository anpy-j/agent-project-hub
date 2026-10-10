const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(root, 'git-smoke-'))
try {
  const env = {
    ...process.env, PROJECT_HUB_GIT_TEST_DIR: temporary, PROJECT_HUB_GIT_TEST_ROOT: root,
    PROJECT_HUB_GIT_SMOKE_DIR: temporary, PROJECT_HUB_DB_DIR: path.join(temporary, 'database')
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const result = spawnSync(process.env.PROJECT_HUB_TEST_ELECTRON || require('electron'), [path.join(__dirname, 'electron-git-smoke.cjs')], {
    env, encoding: 'utf8', timeout: 30000, windowsHide: true
  })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
} finally {
  if (path.dirname(path.resolve(temporary)) !== root || !path.basename(temporary).startsWith('git-smoke-')) throw new Error('Unsafe fixture path')
  fs.rmSync(temporary, { recursive: true, force: true })
}
