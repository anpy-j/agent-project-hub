import { execFile } from 'node:child_process'
import { lstat, mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export async function cloneProject(url: string, parent: string, directory: string): Promise<string> {
  url = url.trim()
  directory = directory.trim()
  if (!/^(https?:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:)/i.test(url) || /[\s\x00-\x1f]/.test(url)) {
    throw new Error('请填写有效的 HTTPS 或 SSH Git 仓库地址')
  }
  if (!isAbsolute(parent) || !(await stat(parent)).isDirectory()) throw new Error('请选择有效的存放目录')
  if (!directory || directory === '.' || directory === '..' || /[\\/\x00-\x1f]/.test(directory)) {
    throw new Error('项目文件夹名称不能包含路径分隔符')
  }
  const destination = join(parent, directory)
  try {
    await lstat(destination)
    throw new Error('目标文件夹已存在，请使用其他名称，或通过本地项目添加')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // 先独占创建目标目录，避免覆盖已存在的文件。
  await mkdir(destination)
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['clone', '--', url, destination], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes' }
    }, (error) => {
      if (error) reject(new Error(`拉取失败，请检查仓库地址、网络和本机 Git 认证。目标目录可能保留部分文件：${destination}`))
      else resolve()
    })
  })
  return destination
}
