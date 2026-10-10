import { randomUUID } from 'crypto'
import { lstat, rename, unlink } from 'fs/promises'
import { posix } from 'path'
import { projectChild } from './build-targets'
import { connectHost } from './deployment-ssh'
import { deploymentStore } from './deployment-store'
import { hostBusy } from './deployment.service'

// Transfer single files only. Downloads replace the destination only after completion.
export async function transferAgentFile(root: string, hostId: string, direction: 'upload' | 'download', localPath: string, remotePath: string): Promise<string> {
  if (!localPath || localPath === '.' || !remotePath?.startsWith('/') || remotePath.includes('\0') || remotePath.split('/').includes('..') || remotePath === '/') throw new Error('请指定项目内文件路径和服务器绝对文件路径')
  if (hostBusy(hostId)) throw new Error('服务器正在发布，请等待完成后传输')
  const local = projectChild(root, localPath)
  try { if ((await lstat(local)).isSymbolicLink()) throw new Error('不能传输符号链接') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (direction === 'upload' && !(await lstat(local)).isFile()) throw new Error('上传暂时仅支持单个文件')
  const localSize = direction === 'upload' ? (await lstat(local)).size : undefined
  const client = await connectHost(deploymentStore.host(hostId), deploymentStore.hostSecret(hostId))
  const temp = direction === 'download' ? local + `.agent-${randomUUID()}.tmp` : posix.join(posix.dirname(remotePath), `.agent-${randomUUID()}.tmp`)
  let channel: import('ssh2').SFTPWrapper | undefined
  let completed = false
  try {
    const sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => client.sftp((e, s) => e ? reject(e) : resolve(s)))
    channel = sftp
    const remoteSize = direction === 'download' ? await new Promise<number>((resolve, reject) => sftp.stat(remotePath, (e, stats) => e ? reject(e) : resolve(stats.size))) : undefined
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { client.destroy(); reject(new Error('文件传输超时（10 分钟）')) }, 600000)
      const done = (error?: Error | null) => { clearTimeout(timeout); error ? reject(error) : resolve() }
      client.once('error', done)
      client.once('close', () => done(new Error('文件传输连接已关闭')))
      if (direction === 'upload') sftp.fastPut(local, temp, done)
      else sftp.fastGet(remotePath, temp, done)
    })
    if (direction === 'download') {
      if ((await lstat(temp)).size !== remoteSize) throw new Error('下载文件大小校验失败')
      await rename(temp, local)
    } else {
      const size = await new Promise<number>((resolve, reject) => sftp.stat(temp, (e, stats) => e ? reject(e) : resolve(stats.size)))
      if (size !== localSize) throw new Error('上传文件大小校验失败')
      await new Promise<void>((resolve, reject) => sftp.ext_openssh_rename(temp, remotePath, e => {
        if (!e) resolve()
        else if ((e as Error & { code?: number }).code === 8) sftp.rename(temp, remotePath, error => error ? reject(error) : resolve())
        else reject(e)
      }))
    }
    completed = true
    return `已${direction === 'upload' ? '上传' : '下载'}：${localPath} ↔ ${remotePath}`
  } finally {
    if (direction === 'download') await unlink(temp).catch(() => {})
    else if (!completed && channel) await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 2000)
      channel!.unlink(temp, () => { clearTimeout(timeout); resolve() })
    })
    client.end()
  }
}
