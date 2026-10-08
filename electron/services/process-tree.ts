import { execFile, spawnSync } from 'child_process'
import type { ChildProcess } from 'child_process'

function ownedPid(child: ChildProcess): number | undefined {
  const pid = child.pid
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)) {
    throw new Error('拒绝停止无效进程 PID')
  }
  return pid
}

/** Kill only the recorded launch PID's tree, never all processes with a name. */
export async function stopProcessTree(child: ChildProcess): Promise<void> {
  const pid = ownedPid(child)
  if (!pid) return
  let closeTimer: NodeJS.Timeout | undefined
  let closed = (child.exitCode !== null || child.signalCode !== null)
    && (!child.stdout || child.stdout.destroyed) && (!child.stderr || child.stderr.destroyed)
  if (closed) return
  let onClose: () => void
  const close = new Promise<void>((resolve) => {
    onClose = () => { closed = true; resolve() }
    child.once('close', onClose)
    if (closed) resolve()
  })
  let escalation: NodeJS.Timeout | undefined
  try {
    if (process.platform === 'win32') {
      // /T must run before killing the parent, while descendant ownership exists.
      await new Promise<void>((resolve, reject) => {
        execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'],
          { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
            if (error && !(closed && error.code === 128)) reject(new Error(`停止进程树失败：${stderr || stdout || error.message}`))
            else resolve()
          })
      })
    } else {
      const signalGroup = (signal: NodeJS.Signals) => {
        try { process.kill(-pid, signal) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      signalGroup('SIGTERM')
      escalation = setTimeout(() => signalGroup('SIGKILL'), 3000)
    }
    await Promise.race([close, new Promise<never>((_, reject) => {
      closeTimer = setTimeout(() => reject(new Error(`进程树 ${pid} 停止超时`)), 5000)
    })])
  } finally {
    if (closeTimer) clearTimeout(closeTimer)
    if (escalation) clearTimeout(escalation)
    child.removeListener('close', onClose!)
  }
}

/** before-quit is synchronous: complete tree cleanup before Electron exits. */
export function stopProcessTreeSync(child: ChildProcess): void {
  const pid = ownedPid(child)
  if (!pid) return
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 15000, encoding: 'utf8' })
    if (result.error || (result.status !== 0 && child.exitCode === null && child.signalCode === null)) {
      throw new Error(`清理进程树 ${pid} 失败：${result.stderr || result.error?.message || result.status}`)
    }
  } else {
    try { process.kill(-pid, 'SIGKILL') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
}
