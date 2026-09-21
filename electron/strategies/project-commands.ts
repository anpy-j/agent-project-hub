import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname, relative } from 'path'
import type { Project, RunCommand, RuntimeKind } from '../../src/types'
import { runtimeService } from '../services/runtime.service'

const isWin = process.platform === 'win32'

function shellWrap(bin: string, args: string[]): { bin: string; args: string[] } {
  if (isWin) return { bin: process.env.Comspec || 'cmd.exe', args: ['/c', bin, ...args] }
  return { bin, args }
}

export interface ResolvedCommand {
  bin: string
  args: string[]
  env: Record<string, string | undefined>
  cwd: string
  display: string
}

function resolveRuntimeBin(kind: RuntimeKind, fallback: string): string {
  const path = runtimeService.getDefaultPath(kind)
  if (path) {
    const dir = dirname(path)
    if (dir) return path
  }
  return fallback
}

function findPythonEntry(projectPath: string): string | null {
  const candidates = [
    'app/main.py',
    'main.py',
    'app.py',
    'run.py',
    'manage.py',
    'server.py',
    'src/main.py'
  ]
  for (const c of candidates) {
    if (existsSync(join(projectPath, c))) return c
  }
  return null
}

function findVenvPython(projectPath: string): string | null {
  const venvs = ['.venv', 'venv', 'env']
  for (const v of venvs) {
    const py = isWin
      ? join(projectPath, v, 'Scripts', 'python.exe')
      : join(projectPath, v, 'bin', 'python')
    if (existsSync(py)) return py
  }
  return null
}

function findFastApiApp(projectPath: string): string | null {
  const pattern = /=\s*FastAPI\s*\(/
  const skip = new Set(['__pycache__', 'node_modules', '.git', 'venv', '.venv', 'tests', 'test'])
  let result: string | null = null

  function walk(dir: string, depth: number): void {
    if (result || depth > 3) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (result) return
      if (skip.has(name)) continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full, depth + 1)
      } else if (name.endsWith('.py')) {
        try {
          if (pattern.test(readFileSync(full, 'utf-8'))) {
            result = relative(projectPath, full)
              .replace(/\.py$/, '')
              .replace(/\//g, '.') + ':app'
          }
        } catch {
          // ignore
        }
      }
    }
  }

  walk(projectPath, 0)
  return result
}

function resolvePythonRun(project: Project): { bin: string; args: string[] } {
  const venvPy = findVenvPython(project.path)
  const entry = findPythonEntry(project.path)
  const py = venvPy || resolveRuntimeBin('python', 'python3')

  if (project.framework === 'fastapi') {
    const appMod = findFastApiApp(project.path)
    if (appMod) {
      return { bin: py, args: ['-m', 'uvicorn', appMod, '--reload'] }
    }
  }
  if (project.framework === 'django') {
    return { bin: py, args: ['manage.py', 'runserver'] }
  }
  if (entry) {
    return { bin: py, args: [entry] }
  }
  return { bin: py, args: [] }
}

export function resolveRunCommand(project: Project): ResolvedCommand {
  const cwd = project.path
  const env: Record<string, string | undefined> = { ...process.env }
  const map: Record<string, () => { bin: string; args: string[] }> = {
    'java-maven': () => ({ bin: 'mvn', args: ['spring-boot:run'] }),
    'java-gradle': () => ({ bin: './gradlew', args: ['bootRun'] }),
    python: () => resolvePythonRun(project),
    flutter: () => ({ bin: 'flutter', args: ['run'] }),
    vue: () => ({ bin: 'npm', args: ['run', 'dev'] }),
    react: () => ({ bin: 'npm', args: ['run', 'dev'] }),
    node: () => ({ bin: 'npm', args: ['run', 'dev'] }),
    unknown: () => ({ bin: 'echo', args: ['未识别的项目类型，请在设置中配置运行命令'] })
  }
  const wrapped = (map[project.type] || map.unknown)()
  const { bin, args } = shellWrap(wrapped.bin, wrapped.args)
  return { bin, args, env, cwd, display: `${wrapped.bin} ${wrapped.args.join(' ')}` }
}

export function resolveBuildCommand(project: Project): ResolvedCommand {
  const cwd = project.path
  const env: Record<string, string | undefined> = { ...process.env }
  const map: Record<string, () => { bin: string; args: string[] }> = {
    'java-maven': () => ({ bin: 'mvn', args: ['clean', 'package', '-DskipTests'] }),
    'java-gradle': () => ({ bin: './gradlew', args: ['clean', 'build', '-x', 'test'] }),
    python: () => ({ bin: 'pyinstaller', args: ['--onefile', 'main.py'] }),
    flutter: () => ({ bin: 'flutter', args: ['build', 'apk'] }),
    vue: () => ({ bin: 'npm', args: ['run', 'build'] }),
    react: () => ({ bin: 'npm', args: ['run', 'build'] }),
    node: () => ({ bin: 'npm', args: ['run', 'build'] }),
    unknown: () => ({ bin: 'echo', args: ['未识别的项目类型'] })
  }
  const wrapped = (map[project.type] || map.unknown)()
  const { bin, args } = shellWrap(wrapped.bin, wrapped.args)
  return { bin, args, env, cwd, display: `${wrapped.bin} ${wrapped.args.join(' ')}` }
}

export function findArtifacts(project: Project): string[] {
  const cwd = project.path
  const candidates: Record<string, string[]> = {
    'java-maven': ['target'],
    'java-gradle': ['build/libs'],
    flutter: ['build'],
    vue: ['dist'],
    react: ['dist'],
    node: ['dist', 'build']
  }
  const result: string[] = []
  for (const dir of candidates[project.type] || []) {
    const full = join(cwd, dir)
    if (existsSync(full)) result.push(full)
  }
  return result
}

export type { RunCommand }

export interface RunSuggestion {
  name: string
  cmd: string
  bin: string
  args: string[]
}

function safeReadJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function pkgScripts(projectPath: string): Array<{ name: string; cmd: string; bin: string; args: string[] }> {
  const pkg = safeReadJsonFile(join(projectPath, 'package.json'))
  if (!pkg) return []
  const scripts = (pkg.scripts as Record<string, string>) || {}
  const priority = ['dev', 'start', 'serve', 'preview', 'build', 'test', 'lint']
  const rank = (key: string): number => (priority.indexOf(key) === -1 ? 99 : priority.indexOf(key))
  const keys = Object.keys(scripts).sort((a, b) => {
    const pa = rank(a)
    const pb = rank(b)
    // 同优先级（含都未命中）时保持 package.json 里的声明顺序
    return pa === pb ? 0 : pa - pb
  })
  return keys.slice(0, 6).map((key) => ({
    name: `npm run ${key}`,
    cmd: `npm run ${key}`,
    bin: 'npm',
    args: ['run', key]
  }))
}

export function suggestCommands(project: Project): Array<{ name: string; cmd: string; bin: string; args: string[] }> {
  switch (project.type) {
    case 'vue':
    case 'react':
    case 'node': {
      const list = pkgScripts(project.path)
      if (list.length) return list
      return [{ name: 'npm run dev', cmd: 'npm run dev', bin: 'npm', args: ['run', 'dev'] }]
    }
    case 'flutter':
      return [
        { name: 'flutter run -d macos', cmd: 'flutter run -d macos', bin: 'flutter', args: ['run', '-d', 'macos'] },
        { name: 'flutter run', cmd: 'flutter run', bin: 'flutter', args: ['run'] },
        { name: 'flutter build macos', cmd: 'flutter build macos', bin: 'flutter', args: ['build', 'macos'] }
      ]
    case 'java-maven': {
      const out = [{ name: 'mvn spring-boot:run', cmd: 'mvn spring-boot:run', bin: 'mvn', args: ['spring-boot:run'] }]
      if (existsSync(join(project.path, 'pom.xml'))) return out
      return [{ name: 'mvn compile', cmd: 'mvn compile', bin: 'mvn', args: ['compile'] }]
    }
    case 'java-gradle':
      return [
        { name: './gradlew bootRun', cmd: './gradlew bootRun', bin: './gradlew', args: ['bootRun'] },
        { name: './gradlew build', cmd: './gradlew build', bin: './gradlew', args: ['build'] }
      ]
    case 'python': {
      const r = resolvePythonRun(project)
      if (!r.bin) return []
      return [{ name: `${r.bin} ${r.args.join(' ')}`.trim(), cmd: `${r.bin} ${r.args.join(' ')}`.trim(), bin: r.bin, args: r.args }]
    }
    default: {
      const cmd = resolveRunCommand(project)
      return [{ name: cmd.display, cmd: cmd.display, bin: cmd.bin, args: cmd.args }]
    }
  }
}
