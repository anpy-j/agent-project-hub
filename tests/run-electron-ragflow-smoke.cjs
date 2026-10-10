const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'project-hub-ragflow-smoke-'))
try {
  require('esbuild').buildSync({ entryPoints: [path.join(__dirname, 'electron-ragflow-smoke.ts')], outfile: path.join(temporary, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const env = { ...process.env, PROJECT_HUB_RAGFLOW_SMOKE_DIR: temporary, PROJECT_HUB_RAGFLOW_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [path.join(temporary, 'main.cjs')], { env, encoding: 'utf8', timeout: 45000 })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
} finally { fs.rmSync(temporary, { recursive: true, force: true }) }
