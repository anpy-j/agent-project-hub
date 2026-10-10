const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(root, 'openclaw-smoke-'))
try {
  esbuild.buildSync({ entryPoints: [path.join(__dirname, 'electron-openclaw-smoke.ts')], outfile: path.join(temporary, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3', 'ssh2'] })
  const env = { ...process.env, PROJECT_HUB_OPENCLAW_SMOKE_DIR: temporary, PROJECT_HUB_OPENCLAW_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(process.env.PROJECT_HUB_TEST_ELECTRON || require('electron'), [path.join(temporary, 'main.cjs')], { env, encoding: 'utf8', timeout: 60000, windowsHide: true })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (fs.existsSync(path.join(temporary, 'openclaw-preview.png'))) fs.copyFileSync(path.join(temporary, 'openclaw-preview.png'), '/tmp/project-hub-openclaw-preview.png')
  if (fs.existsSync(path.join(temporary, 'openclaw-chat-preview.png'))) fs.copyFileSync(path.join(temporary, 'openclaw-chat-preview.png'), '/tmp/project-hub-openclaw-chat-preview.png')
  if (fs.existsSync(path.join(temporary, 'openclaw-http-preview.png'))) fs.copyFileSync(path.join(temporary, 'openclaw-http-preview.png'), '/tmp/project-hub-openclaw-http-preview.png')
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
} finally {
  if (path.dirname(path.resolve(temporary)) !== root || !path.basename(temporary).startsWith('openclaw-smoke-')) throw new Error('Unsafe smoke fixture path')
  fs.rmSync(temporary, { recursive: true, force: true })
}
