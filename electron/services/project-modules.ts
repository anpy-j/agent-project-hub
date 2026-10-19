import type { Dirent } from 'fs'
import { existsSync, readdirSync, realpathSync } from 'fs'
import { basename, dirname, join, relative } from 'path'
import { detectAt } from './detector.service'
import type { BuildTarget, ProjectModule, ProjectType } from '../../src/types'

const excluded = new Set(['node_modules', 'dist', 'build', 'target', 'out', 'coverage', 'venv', 'env', '__pycache__', 'vendor', 'Pods', 'src'])
const slash = (value: string) => value.replace(/\\/g, '/')
export function discoverProjectModules(projectPath: string): ProjectModule[] {
  const root = realpathSync(projectPath), directories: string[] = [], dockerfiles: string[] = []
  let visited = 0
  function walk(directory: string, depth: number) {
    if (++visited > 3000) throw new Error('子项目目录过多，请将目标子项目单独添加后构建')
    let entries: Dirent[]
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    const detected = detectAt(directory)
    if (directory !== root && (detected || entries.some(entry => entry.isFile() && /^Dockerfile(?:[.-].+)?$/.test(entry.name)))) directories.push(directory)
    for (const entry of entries) {
      const name = entry.name
      if (name.startsWith('.') || excluded.has(name)) continue
      const full = join(directory, name)
      if (entry?.isSymbolicLink()) continue
      if (entry?.isFile() && /^Dockerfile(?:[.-].+)?$/.test(name)) dockerfiles.push(slash(relative(root, full)))
      if (depth < 4 && entry?.isDirectory()) walk(full, depth + 1)
    }
  }
  walk(root, 0)
  const modules = directories.sort().map(directory => {
    const detection = detectAt(directory), path = slash(relative(root, directory)), type = detection?.type || 'unknown'
    const target = moduleBuildTarget(root, directory, type)
    return { name: basename(directory), directory: path, type, framework: detection?.framework || null,
      dockerfiles: dockerfiles.filter(file => file.startsWith(path + '/')), target }
  })
  for (const module of modules) {
    if (module.type === 'java-gradle' && module.target.directory === module.directory) {
      const childPaths = modules.filter(child => child.type === 'java-gradle' && child.directory.startsWith(module.directory + '/'))
        .map(child => child.directory.slice(module.directory.length + 1) + '/build/libs')
      module.target.artifactPaths = [...new Set([...module.target.artifactPaths, ...childPaths])]
    }
  }
  return modules
}
function moduleBuildTarget(root: string, directory: string, type: ProjectType): BuildTarget {
  const path = slash(relative(root, directory))
  const target: BuildTarget = { id: `module-${path}`, name: `${path} 构建`, directory: path, platform: 'any', commands: [], artifactPaths: [] }
  if (type === 'java-gradle') {
    let gradleRoot = directory
    for (let current = directory; ; current = dirname(current)) {
      if (existsSync(join(current, 'settings.gradle')) || existsSync(join(current, 'settings.gradle.kts'))) { gradleRoot = current; break }
      if (current === root) break
    }
    const module = slash(relative(gradleRoot, directory))
    const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'
    const binary = existsSync(join(gradleRoot, wrapper)) ? (process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew') : 'gradle'
    if (/^[a-zA-Z0-9_.\/-]*$/.test(module)) {
      const prefix = module ? ':' + module.replace(/\//g, ':') + ':' : ''
      target.directory = slash(relative(root, gradleRoot)) || '.'
      target.commands = [`${binary} ${prefix}clean ${prefix}build -x test`]
      target.artifactPaths = [(module ? module + '/' : '') + 'build/libs']
    }
  } else if (type === 'java-maven') { target.commands = [existsSync(join(directory, 'mvnw')) ? './mvnw clean package -DskipTests' : 'mvn clean package -DskipTests']; target.artifactPaths = ['target'] }
  else if (['node', 'vue', 'react'].includes(type)) {
    const manager = existsSync(join(directory, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(directory, 'yarn.lock')) ? 'yarn' : 'npm'
    target.commands = [`${manager} run build`]; target.artifactPaths = ['dist', 'build']
  } else if (type === 'flutter') { target.commands = ['flutter build apk --release']; target.artifactPaths = ['build/app/outputs/flutter-apk'] }
  else if (type === 'python') { target.commands = ['python -m build']; target.artifactPaths = ['dist'] }
  return target
}
