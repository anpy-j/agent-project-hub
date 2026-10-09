import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillsManager } from './skills.service'
import { findSkillRoots } from './skills-files'

/** Seed independent user copies once per skill name. Never reinstall user deletions. */
export async function seedBundledSkills(manager: SkillsManager, directory: string): Promise<void> {
  if (!existsSync(directory)) return
  const statePath = join(manager.root, 'bundled-state.json')
  const state: string[] = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : []
  if (!Array.isArray(state) || state.some(name => typeof name !== 'string')) throw new Error('内置技能导入记录无效')
  // An empty resource directory is allowed during development.
  if (!findSkillRoots(directory).length) return
  const preview = await manager.preview({ kind: 'local', location: directory })
  try {
    if (preview.errors.length) throw new Error(preview.errors.join('\n'))
    const existing = new Set(manager.snapshot().skills.map(skill => skill.name))
    const pending = preview.candidates.filter(skill => !state.includes(skill.name) && !existing.has(skill.name))
    if (pending.length) await manager.import(preview.token, pending.map(skill => skill.id))
    const names = [...new Set([...state, ...preview.candidates.map(skill => skill.name)])]
    const temporary = `${statePath}.tmp`
    writeFileSync(temporary, JSON.stringify(names, null, 2))
    renameSync(temporary, statePath)
  } finally { manager.discard(preview.token) }
}
