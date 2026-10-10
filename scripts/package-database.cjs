const { spawnSync } = require('node:child_process')
const path = require('node:path')
module.exports = async context => {
  const root = context.packager.projectDir
  const result = spawnSync(require('electron'), [path.join(root, 'scripts/snapshot-database.cjs'), root], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8'
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Database snapshot failed')
}
