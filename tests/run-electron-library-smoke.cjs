const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(root, 'library-smoke-'))
try {
  require('esbuild').buildSync({ entryPoints: [path.join(__dirname, 'electron-library-smoke.ts')], outfile: path.join(temporary, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] })
  const env = { ...process.env, PROJECT_HUB_LIBRARY_SMOKE_DIR: temporary, PROJECT_HUB_LIBRARY_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(process.env.PROJECT_HUB_TEST_ELECTRON || require('electron'), [path.join(temporary, 'main.cjs')], { env, encoding: 'utf8', timeout: 60000, windowsHide: true })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
  else if (!result.stdout.includes('UI capture and note editing passed')) throw new Error('Electron exited before the full smoke test completed')
} finally {
  if (path.dirname(path.resolve(temporary)) !== root || !path.basename(temporary).startsWith('library-smoke-')) throw new Error('Unsafe fixture path')
  fs.rmSync(temporary, { recursive: true, force: true })
}
