import { watch, readFileSync, statSync, existsSync, type FSWatcher } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'

// 文件系统通知驱动；短延迟只用于合并一次保存/提交产生的多条事件。
export function watchGitProject(directory: string, changed: () => void, failed: (error: Error) => void): () => void {
  const watchers: FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const notify = () => {
    if (closed || timer) return
    timer = setTimeout(() => { timer = undefined; if (!closed) changed() }, 250)
  }
  const stop = () => {
    closed = true
    if (timer) clearTimeout(timer)
    for (const watcher of watchers) watcher.close()
  }
  const relevant = (filename: string, metadata = false) => {
    const parts = filename.replace(/\\/g, '/').split('/')
    const gitIndex = parts.indexOf('.git')
    if (metadata || gitIndex >= 0) {
      const path = metadata ? parts : parts.slice(gitIndex + 1)
      return !path.some(p => ['objects', 'logs', 'hooks'].includes(p) || p.endsWith('.lock'))
    }
    return !parts.some(p => ['node_modules', '.venv', 'venv', '.DS_Store'].includes(p))
  }
  const add = (path: string, metadata = false) => {
    const watcher = watch(path, { recursive: true }, (_event, filename) => {
      if (!filename || relevant(String(filename), metadata)) notify()
    })
    watcher.on('error', error => { stop(); failed(error) })
    watchers.push(watcher)
  }
  try {
    add(directory)
    // worktree 的 .git 是文件，真正的 index/HEAD 和公共 refs 位于项目目录外。
    const marker = join(directory, '.git')
    if (existsSync(marker) && statSync(marker).isFile()) {
      const match = readFileSync(marker, 'utf8').match(/^gitdir:\s*(.+)/)
      if (match) {
        const gitDir = resolve(directory, match[1].trim())
        const commonFile = join(gitDir, 'commondir')
        const commonDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim()) : gitDir
        const external = new Set([gitDir, commonDir])
        for (const path of external) {
          const rel = relative(directory, path)
          if (rel.startsWith('..') || isAbsolute(rel)) add(path, true)
        }
      }
    }
  } catch (error) { stop(); throw error }
  return stop
}
