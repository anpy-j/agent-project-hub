import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import type { ProjectType, DetectResult, SubProject } from '../../src/types'
import { readRemotes, gitSummary } from './git.service'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv',
  'env', '__pycache__', '.idea', '.vscode', '.gradle', 'out', 'coverage'
])

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function getDeps(pkg: Record<string, unknown>): Record<string, string> {
  return {
    ...((pkg.dependencies as Record<string, string>) || {}),
    ...((pkg.devDependencies as Record<string, string>) || {})
  }
}

function detectFramework(
  type: ProjectType,
  projectPath: string,
  pkg?: Record<string, unknown> | null
): string | null {
  switch (type) {
    case 'java-maven': {
      const pom = readFileSync(join(projectPath, 'pom.xml'), 'utf-8')
      if (pom.includes('spring-boot-starter-parent') || pom.includes('spring-boot-starter-web')) {
        return 'spring-boot'
      }
      return null
    }
    case 'java-gradle': {
      const gradlePath = ['build.gradle', 'build.gradle.kts']
        .map((f) => join(projectPath, f))
        .find((f) => existsSync(f))
      if (!gradlePath) return null
      const content = readFileSync(gradlePath, 'utf-8')
      if (content.includes('org.springframework.boot')) return 'spring-boot'
      return null
    }
    case 'python': {
      const reqPath = ['requirements.txt', 'pyproject.toml']
        .map((f) => join(projectPath, f))
        .find((f) => existsSync(f))
      if (!reqPath) return null
      const content = readFileSync(reqPath, 'utf-8')
      if (content.match(/^fastapi\b/im)) return 'fastapi'
      if (content.match(/^django\b/im)) return 'django'
      if (content.match(/^flask\b/im)) return 'flask'
      return null
    }
    case 'flutter':
      return 'app'
    case 'vue':
    case 'react':
    case 'node': {
      if (!pkg) return null
      const deps = getDeps(pkg)
      if (deps['next']) return 'next'
      if (deps['nuxt']) return 'nuxt'
      if (deps['vite']) return 'vite'
      if (deps['webpack']) return 'webpack'
      return null
    }
    default:
      return null
  }
}

interface DetectAtResult {
  type: ProjectType
  framework: string | null
}

export function detectAt(projectPath: string): DetectAtResult | null {
  if (existsSync(join(projectPath, 'pom.xml'))) {
    return { type: 'java-maven', framework: detectFramework('java-maven', projectPath) }
  }
  if (
    existsSync(join(projectPath, 'build.gradle')) ||
    existsSync(join(projectPath, 'build.gradle.kts'))
  ) {
    return { type: 'java-gradle', framework: detectFramework('java-gradle', projectPath) }
  }
  if (existsSync(join(projectPath, 'pubspec.yaml'))) {
    return { type: 'flutter', framework: detectFramework('flutter', projectPath) }
  }
  if (
    existsSync(join(projectPath, 'requirements.txt')) ||
    existsSync(join(projectPath, 'pyproject.toml')) ||
    existsSync(join(projectPath, 'Pipfile'))
  ) {
    return { type: 'python', framework: detectFramework('python', projectPath) }
  }
  if (existsSync(join(projectPath, 'package.json'))) {
    const pkg = safeReadJson(join(projectPath, 'package.json'))
    if (pkg) {
      const deps = getDeps(pkg)
      const hasVue = !!deps['vue']
      const hasReact = !!deps['react']
      const hasNext = !!deps['next']
      if (hasNext || hasReact) {
        return { type: 'react', framework: detectFramework('react', projectPath, pkg) }
      }
      if (hasVue) {
        return { type: 'vue', framework: detectFramework('vue', projectPath, pkg) }
      }
      return { type: 'node', framework: detectFramework('node', projectPath, pkg) }
    }
  }
  return null
}

function scanSubProjects(projectPath: string, rootType: ProjectType): SubProject[] {
  const subs: SubProject[] = []
  let entries: string[]
  try {
    entries = readdirSync(projectPath)
  } catch {
    return subs
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
    const subPath = join(projectPath, name)
    try {
      if (!statSync(subPath).isDirectory()) continue
    } catch {
      continue
    }
    const result = detectAt(subPath)
    if (result && result.type !== 'unknown') {
      subs.push({
        path: subPath,
        name,
        type: result.type,
        framework: result.framework
      })
    }
  }
  return subs
}

export async function detectProject(projectPath: string): Promise<DetectResult> {
  const suggestedName = basename(projectPath)
  const root = detectAt(projectPath)
  const [summary, remotes] = await Promise.all([gitSummary(projectPath), readRemotes(projectPath)])

  if (!root) {
    const subs = scanSubProjects(projectPath, 'unknown')
    return { type: 'unknown', framework: null, suggestedName, isGit: summary.isGit, branch: summary.branch, remotes, subProjects: subs }
  }

  const subs = scanSubProjects(projectPath, root.type)
  return {
    type: root.type,
    framework: root.framework,
    suggestedName,
    isGit: summary.isGit,
    branch: summary.branch,
    remotes,
    subProjects: subs.length ? subs : undefined
  }
}
