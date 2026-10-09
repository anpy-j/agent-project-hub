export type SkillTarget = 'codex' | 'opencode' | 'antigravity' | 'hub'
export type SkillScope = 'global' | 'project'
export interface SkillSource {
  kind: 'local' | 'github' | 'url' | 'discovered'
  location: string
  ref?: string
  commit?: string
  subpath?: string
}
export interface SkillFile { path: string; bytes: number }
export interface SkillPackage {
  id: string
  name: string
  title: string
  description: string
  source: SkillSource
  hash: string
  files: SkillFile[]
  warnings: string[]
  createdAt: string
  updatedAt: string
  analysis?: string
}
export interface SkillInstallation {
  id: string
  skillId: string
  target: SkillTarget
  scope: SkillScope
  projectId?: string
  path: string
  enabled: boolean
  hash: string
  installedAt: string
  managed: boolean
  status?: 'installed' | 'disabled' | 'modified' | 'missing'
}
export interface SkillCandidate {
  id: string
  name: string
  title: string
  description: string
  source: SkillSource
  files: SkillFile[]
  warnings: string[]
  existingId?: string
  discovered?: { target: SkillTarget; scope: SkillScope; projectId?: string; path: string }
}
export interface SkillPreview { token: string; candidates: SkillCandidate[]; errors: string[] }
export interface SkillTargetInfo { id: SkillTarget; name: string; globalPath: string; projectFolder: string; hint: string }
export interface SkillImportInput { kind: 'local' | 'github' | 'url'; location: string; ref?: string }
export interface SkillInstallInput { skillId: string; target: SkillTarget; scope: SkillScope; projectId?: string; replace?: boolean }
export interface SkillHistory { id: string; skillId: string; action: string; message: string; createdAt: string }
export interface SkillUpdate {
  token: string
  candidateId: string
  currentHash: string
  nextHash: string
  changed: boolean
  changes: Array<{ path: string; kind: 'added' | 'removed' | 'changed'; before: string; after: string }>
}
export interface SkillSnapshot { skills: SkillPackage[]; installations: SkillInstallation[]; targets: SkillTargetInfo[]; bundledPath?: string }
export interface SkillBundleResult { path: string; status: 'copied' | 'unchanged' | 'conflict' }
export interface SkillContext { skillId: string; name: string; description: string; instructions: string; root: string; files: SkillFile[] }
export interface SkillsAPI {
  snapshot(): Promise<SkillSnapshot>
  preview(input: SkillImportInput): Promise<SkillPreview>
  scan(projectId?: string): Promise<SkillPreview>
  import(token: string, candidateIds: string[]): Promise<SkillPackage[]>
  discard(token: string): Promise<void>
  readFile(skillId: string, path: string): Promise<string>
  install(input: SkillInstallInput): Promise<SkillInstallation>
  setEnabled(id: string, enabled: boolean): Promise<void>
  uninstall(id: string): Promise<void>
  remove(skillId: string): Promise<void>
  history(skillId: string): Promise<SkillHistory[]>
  explain(skillId: string): Promise<string>
  checkUpdate(skillId: string): Promise<SkillUpdate>
  applyUpdate(skillId: string, token: string, candidateId: string): Promise<SkillPackage>
  restore(skillId: string): Promise<SkillPackage>
  export(skillId: string): Promise<string | null>
  bundle(skillId: string, replace?: boolean): Promise<SkillBundleResult>
  pickLocal(kind: 'folder' | 'file'): Promise<string | null>
  context(projectId?: string, skillIds?: string[]): Promise<SkillContext[]>
  chat(input: { prompt: string; projectId?: string; skillIds: string[] }): Promise<{ answer: string; skills: string[] }>
}
