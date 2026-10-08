import { realpath, stat } from 'fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'path'
import type { DeployConfig } from '../../src/types/deployment'
import { dockerfilePath, validateConfig } from './deployment-validation'

export async function prepareDockerBuild(projectPath: string, config: DeployConfig, image: string): Promise<{ file: string; context: string; args: string[] }> {
  validateConfig(config)
  const root = await realpath(projectPath)
  const requestedFile = dockerfilePath(projectPath, config.dockerfile)
  const requestedContext = config.buildContext ? resolve(projectPath, config.buildContext) : dirname(requestedFile)
  let file: string, context: string
  try { file = await realpath(requestedFile) } catch { throw new Error(`找不到 Dockerfile：${config.dockerfile}`) }
  try { context = await realpath(requestedContext) } catch { throw new Error(`找不到构建目录：${config.buildContext || dirname(config.dockerfile)}`) }
  for (const path of [file, context]) {
    const rel = relative(root, path)
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Dockerfile 和构建目录不能通过链接指向项目外部')
  }
  if (!(await stat(file)).isFile()) throw new Error('Dockerfile 路径必须是文件')
  if (!(await stat(context)).isDirectory()) throw new Error('构建目录路径必须是目录')
  return { file, context, args: ['build', '--platform', config.platform, '-f', file, '-t', image, context] }
}
