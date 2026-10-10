import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { resolve, relative, isAbsolute, delimiter } from 'path'
import type { BuildTarget, Project } from '../../src/types'
import { getDb } from '../db'
import { resolveBuildCommand } from '../strategies/project-commands'

export function projectChild(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error('请使用项目内的相对路径')
  const base = realpathSync(root)
  const full = resolve(base, path || '.')
  const check = (value: string) => {
    const rel = relative(base, value)
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('目录必须位于项目内')
  }
  check(full)
  let parent = full
  while (!existsSync(parent)) parent = resolve(parent, '..')
  check(realpathSync(parent))
  return full
}

export function buildEnvironment(target: BuildTarget, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...inherited }
  if (!target.flutterSdk) return env
  if (!isAbsolute(target.flutterSdk)) throw new Error('Flutter SDK 请填写绝对路径')
  const binary = resolve(target.flutterSdk, 'bin', process.platform === 'win32' ? 'flutter.bat' : 'flutter')
  if (!existsSync(binary) || !statSync(binary).isFile()) throw new Error(`所选目录 ${target.flutterSdk} 中找不到 ${process.platform === 'win32' ? 'bin/flutter.bat' : 'bin/flutter'}。请选择 Flutter 安装目录；项目目录请填在“子项目目录”。也可清空 Flutter SDK，使用终端环境中的 Flutter。`)
  if (process.platform !== 'win32') {
    try { accessSync(binary, constants.X_OK) } catch { throw new Error('Flutter SDK 中的 flutter 文件没有执行权限') }
  }
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH'
  env[pathKey] = resolve(target.flutterSdk, 'bin') + delimiter + (env[pathKey] || '')
  env.FLUTTER_ROOT = target.flutterSdk
  return env
}

export function defaultBuildTargets(project: Project): BuildTarget[] {
  const target = (name: string, command: string, platform: BuildTarget['platform'] = 'any', artifactPaths: string[] = ['dist']) => ({ id: `default-${platform}-${name}`, name, directory: '.', platform, commands: [command], artifactPaths })
  if (project.type === 'flutter') return [
    target('Android APK', 'flutter build apk --release', 'any', ['build/app/outputs/flutter-apk']),
    target('Android App Bundle', 'flutter build appbundle --release', 'any', ['build/app/outputs/bundle/release']),
    target('macOS 桌面', 'flutter build macos --release', 'darwin', ['build/macos/Build/Products/Release']),
    target('Windows 桌面', 'flutter build windows --release', 'win32', ['build/windows']),
    target('iOS IPA', 'flutter build ipa --release', 'darwin', ['build/ios/ipa'])
  ]
  try {
    const pkg = JSON.parse(readFileSync(resolve(project.path, 'package.json'), 'utf8'))
    if (pkg.devDependencies?.electron || pkg.dependencies?.electron) return [
      target('Windows 安装包', 'npm run build && npx electron-builder --win --publish never', 'win32'),
      target('macOS 安装包', 'npm run build && npx electron-builder --mac --publish never', 'darwin')
    ]
  } catch { /* 非 Node 项目 */ }
  if (project.type === 'unknown') return []
  return [target('默认构建', resolveBuildCommand(project).display, 'any', project.type === 'java-maven' ? ['target'] : project.type === 'java-gradle' ? ['build/libs'] : ['dist', 'build'])]
}

export function listBuildTargets(project: Project): BuildTarget[] {
  const row = getDb().prepare('SELECT targets FROM build_targets WHERE project_id = ?').get(project.id) as { targets: string } | undefined
  return row ? JSON.parse(row.targets) : defaultBuildTargets(project)
}

export function saveBuildTargets(project: Project, targets: BuildTarget[]): void {
  if (!Array.isArray(targets) || targets.length > 100) throw new Error('构建目标格式不正确')
  const ids = new Set<string>()
  for (const t of targets) {
    if (!t.id || ids.has(t.id) || !t.name?.trim() || !['any', 'darwin', 'win32', 'linux'].includes(t.platform)) throw new Error('目标名称、标识或平台不正确')
    ids.add(t.id)
    buildEnvironment(t)
    const directory = projectChild(project.path, t.directory)
    if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error('子项目目录不存在')
    if (!Array.isArray(t.commands) || !t.commands.length || t.commands.some(c => typeof c !== 'string' || !c.trim() || c.includes('\0'))) throw new Error('请填写构建步骤')
    if (!Array.isArray(t.artifactPaths)) throw new Error('产物路径格式不正确')
    for (const path of t.artifactPaths) projectChild(directory, path)
  }
  getDb().prepare('INSERT INTO build_targets (project_id, targets) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET targets = excluded.targets').run(project.id, JSON.stringify(targets))
}
