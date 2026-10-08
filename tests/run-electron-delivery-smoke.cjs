const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(root, 'delivery-smoke-'))
try {
  esbuild.buildSync({ entryPoints: [path.join(root, 'electron/services/deployment-store.ts')], outfile: path.join(temporary, 'store.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  fs.writeFileSync(path.join(temporary, 'legacy-preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron'); contextBridge.exposeInMainWorld('api',{workspace:{list:()=>ipcRenderer.invoke('workspace:list')},project:{list:()=>ipcRenderer.invoke('project:list')}});`)
  const electron = process.env.PROJECT_HUB_TEST_ELECTRON || require('electron')
  const env = { ...process.env, PROJECT_HUB_SMOKE_DIR: temporary }
  delete env.ELECTRON_RUN_AS_NODE
  for (const mode of ['current', 'legacy', 'legacy-main']) {
    const result = spawnSync(electron, [path.join(__dirname, 'electron-delivery-smoke.cjs')], { env: { ...env, PROJECT_HUB_SMOKE_MODE: mode }, encoding: 'utf8', timeout: 30000, windowsHide: true })
    process.stdout.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    if (result.error) throw result.error
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break }
  }
} finally {
  if (!temporary.startsWith(root + path.sep)) throw new Error('Unsafe temporary path')
  fs.rmSync(temporary, { recursive: true, force: true })
}
