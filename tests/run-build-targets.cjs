const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(root, 'build-target-test-'))
try {
  esbuild.buildSync({ stdin: { contents: `export * from './electron/services/build-targets'; export * from './electron/services/flutter-environment'; export { runnerService } from './electron/services/runner.service'; export { getDb, closeDb } from './electron/db'; export { registerIpcHandlers } from './electron/ipc/handlers'`, resolveDir: root }, outfile: path.join(dir, 'services.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] })
  const env = { ...process.env, PROJECT_HUB_BUILD_TEST_DIR: dir }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [path.join(__dirname, 'electron-build-targets.cjs')], { env, encoding: 'utf8', timeout: 30000 })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
