import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { getDb } from '../db'
import type { Runtime, RuntimeKind } from '../../src/types'

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim()
  } catch {
    return null
  }
}

function parseVersion(raw: string): string {
  const match = raw.match(/(\d+(?:\.\d+){0,2})/)
  return match ? match[1] : raw
}

interface ProbeResult {
  version: string
  path: string
  source: string
  binName: string
}

const KIND_BINARIES: Record<RuntimeKind, string[]> = {
  jdk: ['java'],
  node: ['node'],
  python: ['python3', 'python'],
  flutter: ['flutter']
}

const VERSION_FLAGS: Record<RuntimeKind, string> = {
  jdk: '-version',
  node: '--version',
  python: '--version',
  flutter: '--version'
}

function whichCmd(binary: string): string {
  return process.platform === 'win32' ? `where ${binary}` : `which ${binary}`
}

function probeOne(kind: RuntimeKind): ProbeResult[] {
  const results: ProbeResult[] = []
  const binaries = KIND_BINARIES[kind]
  const seenPaths = new Set<string>()

  for (const binary of binaries) {
    const versionRaw = tryExec(`${binary} ${VERSION_FLAGS[kind]} 2>&1`)
    const whichRaw = tryExec(whichCmd(binary))
    if (versionRaw && whichRaw) {
      if (seenPaths.has(whichRaw)) continue
      seenPaths.add(whichRaw)
      results.push({
        version: parseVersion(versionRaw.split('\n')[0]),
        path: whichRaw,
        source: 'system',
        binName: binary
      })
    }
  }
  return results
}

export const runtimeService = {
  scan(): Runtime[] {
    const kinds: RuntimeKind[] = ['jdk', 'node', 'python', 'flutter']
    const scanned: Runtime[] = []
    for (const kind of kinds) {
      const probes = probeOne(kind)
      for (const p of probes) {
        const existing = getDb()
          .prepare('SELECT 1 FROM runtime WHERE kind = ? AND path = ?')
          .get(kind, p.path)
        if (existing) {
          getDb().prepare('UPDATE runtime SET version = ? WHERE kind = ? AND path = ?').run(p.version, kind, p.path)
        } else {
          const id = randomUUID()
          const isDefault = getDb()
            .prepare('SELECT COUNT(*) as c FROM runtime WHERE kind = ?')
            .get(kind) as { c: number }
          getDb()
            .prepare(
              `INSERT INTO runtime (id, kind, version, path, is_default, source)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(id, kind, p.version, p.path, isDefault.c === 0 ? 1 : 0, p.source)
          scanned.push({
            id,
            kind,
            version: p.version,
            path: p.path,
            is_default: isDefault.c === 0 ? 1 : 0,
            source: p.source,
            created_at: new Date().toISOString()
          })
        }
      }
    }
    return scanned
  },

  list(): Runtime[] {
    return getDb()
      .prepare('SELECT * FROM runtime ORDER BY kind, is_default DESC, version DESC')
      .all() as Runtime[]
  },

  getDefaultPath(kind: RuntimeKind): string | null {
    const row = getDb()
      .prepare('SELECT path FROM runtime WHERE kind = ? AND is_default = 1')
      .get(kind) as { path: string } | undefined
    return row?.path ?? null
  }
}
