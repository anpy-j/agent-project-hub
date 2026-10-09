import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, parse as parsePath } from 'node:path'
import { homedir } from 'node:os'
import type { SkillCandidate, SkillContext, SkillHistory, SkillImportInput, SkillInstallInput, SkillInstallation, SkillPackage, SkillPreview, SkillSnapshot, SkillSource, SkillTargetInfo, SkillUpdate } from '../../src/types/skills'
import type { SkillsStore } from './skills-store'
import { copySkill, extractSkillZip, findSkillRoots, inside, manifest, readSkillText, safeRelative, skillFiles, skillHash, skillMetadata, SKILL_LIMITS, zipSkill } from './skills-files'
import { downloadSkill, resolveGithub } from './skills-source'
import { skillTargets, targetPath } from './skills-targets'

interface Candidate extends SkillCandidate { root: string; hash: string }
interface Stage { directory: string; candidates: Candidate[]; created: number }
interface Options { root: string; store: SkillsStore; home?: string; targets?: SkillTargetInfo[]; bundledRoot?: string; project: (id: string) => { path: string } | null; projects?: () => Array<{ id: string; path: string }> }
const now = () => new Date().toISOString()
const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

export class SkillsManager {
  readonly root: string
  readonly targets: SkillTargetInfo[]
  private stages = new Map<string, Stage>()
  private updateStages = new Map<string, { skillId: string; hash: string }>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private options: Options) {
    this.root = resolve(options.root)
    this.targets = options.targets || skillTargets(options.home)
    mkdirSync(this.root, { recursive: true })
  }
  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(fn)
    this.queue = operation.catch(() => undefined)
    return operation
  }
  private package(id: string): SkillPackage {
    const value = this.options.store.packages().find(s => s.id === id)
    if (!value) throw new Error('技能不存在，请刷新列表')
    return value
  }
  private packageRoot(id: string): string { this.package(id); return inside(this.root, `packages/${id}/current`) }
  private log(skillId: string, action: string, message: string): void {
    this.options.store.log({ id: randomUUID(), skillId, action, message, createdAt: now() })
  }
  private deleteOwned(path: string): void {
    inside(this.root, path)
    if (samePath(this.root, path)) throw new Error('不能移除技能库根目录')
    if (existsSync(path)) { inside(realpathSync(this.root), realpathSync(path)); rmSync(path, { recursive: true, force: true }) }
  }
  private safeDestination(path: string): void {
    let current = resolve(path)
    for (;;) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('安装目录包含符号链接，请使用真实目录')
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    if (samePath(path, parsePath(path).root)) throw new Error('不能操作文件系统根目录')
  }
  snapshot(): SkillSnapshot {
    const installations = this.options.store.installations().map(i => {
      if (i.target === 'hub') return { ...i, status: i.enabled ? 'installed' as const : 'disabled' as const }
      const actual = i.enabled ? i.path : inside(this.root, `disabled/${i.id}`)
      let status: SkillInstallation['status'] = i.enabled ? 'installed' : 'disabled'
      try { if (!existsSync(actual)) status = 'missing'; else if (skillHash(actual) !== i.hash) status = 'modified' } catch { status = 'modified' }
      return { ...i, status }
    })
    return { skills: this.options.store.packages().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), installations, targets: this.targets, bundledPath: this.options.bundledRoot }
  }
  private newStage(): { token: string; stage: Stage } {
    for (const [token, stage] of this.stages) if (Date.now() - stage.created > 30 * 60 * 1000) this.discard(token)
    if (this.stages.size >= 10) this.discard(this.stages.keys().next().value!)
    const token = randomUUID(), directory = inside(this.root, `staging/${token}`)
    mkdirSync(directory, { recursive: true })
    const stage = { directory, candidates: [] as Candidate[], created: Date.now() }
    this.stages.set(token, stage); return { token, stage }
  }
  discard(token: string): void {
    const stage = this.stages.get(token)
    if (stage) { this.deleteOwned(stage.directory); this.stages.delete(token); this.updateStages.delete(token) }
  }
  private candidate(stage: Stage, sourceRoot: string, source: SkillSource, discovered?: SkillCandidate['discovered']): Candidate {
    const metadata = skillMetadata(sourceRoot), id = randomUUID(), root = join(stage.directory, 'candidates', id)
    copySkill(sourceRoot, root)
    const hash = skillHash(root)
    const existingId = this.options.store.packages().find(p => p.name === metadata.name && p.hash === hash)?.id
    const value = { id, ...metadata, source, hash, root, existingId, discovered }
    stage.candidates.push(value); return value
  }
  private publicPreview(token: string, stage: Stage, errors: string[]): SkillPreview {
    return { token, candidates: stage.candidates.map(({ root: _root, hash: _hash, ...rest }) => rest), errors }
  }
  async preview(input: SkillImportInput): Promise<SkillPreview> {
    if (!input || !['local', 'github', 'url'].includes(input.kind) || typeof input.location !== 'string' || !input.location.trim()) throw new Error('请选择来源并填写地址或路径')
    const { token, stage } = this.newStage(), errors: string[] = []
    try {
      let base: string, source: SkillSource = { kind: input.kind, location: input.location.trim() }
      if (input.kind === 'local') {
        const path = resolve(input.location.trim())
        if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error('文件不存在，或路径是符号链接')
        source.location = path
        if (lstatSync(path).isDirectory()) base = path
        else if (/\.zip$/i.test(path)) { if (lstatSync(path).size > SKILL_LIMITS.download) throw new Error('压缩包超过 32 MB'); base = join(stage.directory, 'extracted'); mkdirSync(base); extractSkillZip(readFileSync(path), base) }
        else if (basename(path) === 'SKILL.md') base = dirname(path)
        else throw new Error('请选择技能文件夹、ZIP 或 SKILL.md')
      } else {
        const url = new URL(source.location)
        const github = (input.kind === 'github' || ['github.com', 'www.github.com', 'raw.githubusercontent.com'].includes(url.hostname)) && !/\.zip$/i.test(url.pathname)
        let buffer: Buffer
        if (github) {
          const githubSource = await resolveGithub(source.location, input.ref)
          source = githubSource.source; buffer = await downloadSkill(githubSource.archive)
        } else { source.kind = 'url'; buffer = await downloadSkill(source.location) }
        base = join(stage.directory, 'extracted'); mkdirSync(base)
        if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
          extractSkillZip(buffer, base)
          const children = readdirSync(base, { withFileTypes: true })
          if (github && children.length === 1 && children[0].isDirectory()) base = join(base, children[0].name)
        } else {
          if (buffer.length > SKILL_LIMITS.text) throw new Error('下载内容不是 ZIP，且超过单个 SKILL.md 大小限制')
          manifest(buffer.toString('utf8'), 'downloaded-skill')
          writeFileSync(join(base, 'SKILL.md'), buffer)
        }
      }
      const archiveRoot = base
      if (source.kind === 'github' && source.subpath) {
        base = inside(base, safeRelative(source.subpath))
        if (!existsSync(base)) throw new Error('仓库内找不到指定技能目录')
      }
      for (const root of findSkillRoots(base)) {
        try {
          const candidateSource = source.kind === 'github' ? { ...source, subpath: relative(archiveRoot, root).replace(/\\/g, '/') } : source
          const candidate = this.candidate(stage, root, candidateSource)
          if (candidate.files.length === 1) candidate.warnings.push('单文件技能：如果正文引用其他资源，请确认它们已包含在包中。')
        } catch (error) { errors.push(`${basename(root)}：${(error as Error).message}`) }
      }
      if (!stage.candidates.length) throw new Error(errors.join('\n') || '未找到有效 SKILL.md，请检查下载地址或目录')
      return this.publicPreview(token, stage, errors)
    } catch (error) { this.discard(token); throw error }
  }
  async scan(projectId?: string): Promise<SkillPreview> {
    const { token, stage } = this.newStage(), errors: string[] = []
    const home = this.options.home || homedir(), project = projectId ? this.options.project(projectId) : null
    if (projectId && !project) { this.discard(token); throw new Error('项目不存在') }
    const roots: Array<{ target: SkillCandidate['discovered']; root: string }> = []
    for (const info of this.targets.filter(t => t.id !== 'hub')) {
      roots.push({ root: info.globalPath, target: { target: info.id, scope: 'global', path: '' } })
      if (project) roots.push({ root: join(project.path, info.projectFolder), target: { target: info.id, scope: 'project', projectId, path: '' } })
    }
    for (const path of [join(home, '.agents', 'skills'), join(home, '.gemini', 'antigravity', 'skills'), join(home, '.gemini', 'antigravity-cli', 'skills')]) {
      if (!roots.some(r => samePath(r.root, path))) roots.push({ root: path, target: { target: path.includes('.gemini') ? 'antigravity' : 'codex', scope: 'global', path: '' } })
    }
    if (project && existsSync(join(project.path, '.agent', 'skills'))) roots.push({ root: join(project.path, '.agent', 'skills'), target: { target: 'antigravity', scope: 'project', projectId, path: '' } })
    for (const entry of roots) {
      if (!existsSync(entry.root)) continue
      try {
        for (const root of findSkillRoots(entry.root)) {
          try { this.candidate(stage, root, { kind: 'discovered', location: root }, { ...entry.target!, path: root }) } catch (error) { errors.push(`${basename(root)}：${(error as Error).message}`) }
        }
      } catch (error) { errors.push(`${entry.root}：${(error as Error).message}`) }
    }
    return this.publicPreview(token, stage, errors)
  }
  import(token: string, ids: string[]): Promise<SkillPackage[]> {
    return this.exclusive(() => {
      const stage = this.stages.get(token)
      if (!stage || Date.now() - stage.created > 30 * 60 * 1000) throw new Error('导入预览已过期，请重新解析')
      if (!Array.isArray(ids) || !ids.length || ids.some(id => !stage.candidates.some(c => c.id === id))) throw new Error('请选择有效技能')
      const result: SkillPackage[] = []
      for (const candidate of stage.candidates.filter(c => ids.includes(c.id))) {
        let entry = this.options.store.packages().find(p => p.name === candidate.name && p.hash === candidate.hash)
        if (!entry) {
          const id = randomUUID(), root = join(this.root, 'packages', id, 'current')
          copySkill(candidate.root, root)
          entry = { id, name: candidate.name, title: candidate.title, description: candidate.description, source: candidate.source, hash: candidate.hash, files: candidate.files, warnings: candidate.warnings, createdAt: now(), updatedAt: now() }
          this.options.store.savePackage(entry); this.log(id, 'import', `从 ${candidate.source.location} 导入技能`)
        }
        const found = candidate.discovered
        if (found && !this.options.store.installations().some(i => i.target === found.target && samePath(i.path, found.path))) {
          this.options.store.saveInstallation({ ...found, id: randomUUID(), skillId: entry.id, enabled: true, managed: false, hash: candidate.hash, installedAt: now() })
          this.log(entry.id, 'discover', `${found.target} 外部安装已关联（只读）`)
        }
        if (!result.some(s => s.id === entry!.id)) result.push(entry)
      }
      this.discard(token); return result
    })
  }
  readFile(id: string, path: string): string { return readSkillText(this.packageRoot(id), path) }
  private installation(id: string): SkillInstallation {
    const value = this.options.store.installations().find(i => i.id === id)
    if (!value) throw new Error('安装记录不存在')
    return value
  }
  install(input: SkillInstallInput): Promise<SkillInstallation> {
    return this.exclusive(() => {
      const skill = this.package(input.skillId), source = this.packageRoot(skill.id)
      if (!this.targets.some(t => t.id === input.target) || !['global', 'project'].includes(input.scope)) throw new Error('无效的安装目标或范围')
      if (skillHash(source) !== skill.hash) throw new Error('技能库文件已被修改，请重新导入')
      const project = input.scope === 'project' ? this.options.project(input.projectId || '') : null
      if (input.scope === 'project' && !project) throw new Error('请选择有效项目')
      if (input.target === 'opencode' && skill.description.length > 1024) throw new Error('此技能 description 超过 OpenCode 限制，无法安装')
      const path = input.target === 'hub' ? source : targetPath(this.targets, input.target, input.scope, skill.name, project?.path)
      const previous = this.options.store.installations().find(i => i.target === input.target && i.scope === input.scope && (i.projectId || '') === (input.projectId || '') && samePath(i.path, path))
      const others = this.options.store.installations().filter(i => i.id !== previous?.id && input.target !== 'hub' && samePath(i.path, path))
      if (others.some(i => i.skillId !== skill.id)) throw new Error('此目录由其他技能或工具共享，请先处理已有安装')
      if (previous?.managed && previous.enabled && previous.skillId === skill.id && previous.hash === skill.hash && (input.target === 'hub' || existsSync(path) && skillHash(path) === skill.hash)) return previous
      if (previous && !previous.enabled) throw new Error('该安装已停用，请先启用或卸载后重新安装')
      const id = previous?.id || randomUUID()
      if (input.target !== 'hub') {
        this.safeDestination(path)
        if (existsSync(path) && !input.replace) throw new Error('目录已存在：请勾选“备份后替换已有目录”再安装')
        if (others.length && existsSync(path) && skillHash(path) !== skill.hash) throw new Error('共享目录已被修改，不能单独覆盖')
        const pending = join(dirname(path), `.project-hub-${randomUUID()}`)
        mkdirSync(dirname(path), { recursive: true })
        try {
          copySkill(source, pending)
          if (existsSync(path)) {
            const backup = join(this.root, 'backups', id, `${Date.now()}-${randomUUID()}`)
            copySkill(path, backup)
            this.log(skill.id, 'backup', `原目录备份：${backup}`)
            // Keep rollback on the same filesystem; the retained copy is stored in the app library.
            const rollback = `${pending}-previous`
            renameSync(path, rollback)
            try { renameSync(pending, path) } catch (error) { renameSync(rollback, path); throw error }
            rmSync(rollback, { recursive: true })
          } else renameSync(pending, path)
        } finally { if (existsSync(pending)) rmSync(pending, { recursive: true, force: true }) }
      }
      const value: SkillInstallation = { id, skillId: skill.id, target: input.target, scope: input.scope, projectId: input.scope === 'project' ? input.projectId : undefined, path, enabled: true, managed: true, hash: skill.hash, installedAt: now() }
      this.options.store.saveInstallation(value)
      this.log(skill.id, 'install', `安装到 ${input.target} · ${input.scope} · ${path}`)
      return value
    })
  }
  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.exclusive(() => {
      const value = this.installation(id)
      if (!value.managed) throw new Error('外部安装仅提供关联查看，请使用来源工具管理，或备份后重新安装纳入管理')
      if (typeof enabled !== 'boolean') throw new Error('无效启用状态')
      if (value.enabled === enabled) return
      if (value.target !== 'hub') {
        if (this.options.store.installations().some(i => i.id !== id && samePath(i.path, value.path))) throw new Error('该目录由多个工具共享，不能单独停用；请在目标工具中配置权限')
        const disabled = join(this.root, 'disabled', id), source = enabled ? disabled : value.path, target = enabled ? value.path : disabled
        this.safeDestination(value.path)
        if (!existsSync(source) || skillHash(source) !== value.hash) throw new Error('目录不存在或有本地修改，请先备份处理')
        if (existsSync(target)) throw new Error('目标目录已有文件，不能覆盖')
        const pending = join(dirname(target), `.project-hub-${randomUUID()}`)
        try {
          copySkill(source, pending); renameSync(pending, target)
          try { rmSync(source, { recursive: true }) } catch (error) { rmSync(target, { recursive: true }); throw error }
        } finally { if (existsSync(pending)) rmSync(pending, { recursive: true, force: true }) }
      }
      value.enabled = enabled; this.options.store.saveInstallation(value)
      this.log(value.skillId, enabled ? 'enable' : 'disable', `${enabled ? '启用' : '停用'} ${value.target} 的技能安装；目标可能需要刷新会话`)
    })
  }
  uninstall(id: string): Promise<void> {
    return this.exclusive(() => {
      const value = this.installation(id)
      if (value.managed && value.target !== 'hub') {
        const shared = this.options.store.installations().some(i => i.id !== id && samePath(i.path, value.path))
        const path = value.enabled ? value.path : join(this.root, 'disabled', id)
        this.safeDestination(path)
        if (!shared && existsSync(path)) {
          if (skillHash(path) !== value.hash) throw new Error('安装目录有本地修改，已阻止卸载；请先导出或自行处理')
          const backup = join(this.root, 'backups', id, `uninstall-${Date.now()}`)
          copySkill(path, backup); rmSync(path, { recursive: true }); this.log(value.skillId, 'backup', `卸载前备份：${backup}`)
        }
      }
      this.options.store.removeInstallation(id)
      this.log(value.skillId, value.managed ? 'uninstall' : 'unlink', value.managed ? `移除 ${value.target} 安装关联；共享目录仍保留` : `移除 ${value.target} 外部关联，原文件保留`)
    })
  }
  remove(id: string): Promise<void> {
    return this.exclusive(() => {
      this.package(id)
      if (this.options.store.installations().some(i => i.skillId === id)) throw new Error('请先卸载或移除所有安装关联，再删除库条目')
      this.deleteOwned(join(this.root, 'packages', id)); this.options.store.removePackage(id)
    })
  }
  history(id: string): SkillHistory[] { this.package(id); return this.options.store.history(id) }
  saveAnalysis(id: string, text: string): void { const value = this.package(id); value.analysis = text; this.options.store.savePackage(value) }
  async checkUpdate(id: string): Promise<SkillUpdate> {
    const skill = this.package(id)
    if (skill.source.kind === 'discovered') throw new Error('已有技能由来源工具管理；可通过本地目录重新导入')
    const input: SkillImportInput = skill.source.kind === 'github'
      ? { kind: 'github', location: `${skill.source.location}/tree/${skill.source.ref}/${skill.source.subpath || ''}`, ref: skill.source.ref }
      : { kind: skill.source.kind, location: skill.source.location }
    const preview = await this.preview(input), stage = this.stages.get(preview.token)!
    const candidate = stage.candidates.find(c => c.name === skill.name && (skill.source.kind !== 'github' || c.source.subpath === skill.source.subpath))
    if (!candidate) { this.discard(preview.token); throw new Error('来源中已找不到该技能') }
    const current = this.packageRoot(id), changes: SkillUpdate['changes'] = []
    const all = [...new Set([...skill.files.map(f => f.path), ...candidate.files.map(f => f.path)])]
    for (const path of all) {
      const oldFile = join(current, path), newFile = join(candidate.root, path)
      if (existsSync(oldFile) && existsSync(newFile) && readFileSync(oldFile).equals(readFileSync(newFile))) continue
      const text = (root: string) => { try { return readSkillText(root, path) } catch { return '（二进制资源或文件超过预览大小）' } }
      changes.push({ path, kind: !existsSync(oldFile) ? 'added' : !existsSync(newFile) ? 'removed' : 'changed', before: existsSync(oldFile) ? text(current) : '', after: existsSync(newFile) ? text(candidate.root) : '' })
    }
    this.updateStages.set(preview.token, { skillId: id, hash: skill.hash })
    return { token: preview.token, candidateId: candidate.id, currentHash: skill.hash, nextHash: candidate.hash, changed: candidate.hash !== skill.hash, changes }
  }
  applyUpdate(id: string, token: string, candidateId: string): Promise<SkillPackage> {
    return this.exclusive(() => {
      const skill = this.package(id), stage = this.stages.get(token), candidate = stage?.candidates.find(c => c.id === candidateId)
      const bound = this.updateStages.get(token)
      if (!bound || bound.skillId !== id || bound.hash !== skill.hash) throw new Error('更新预览不属于此技能或版本已变化，请重新检查')
      if (!candidate || Date.now() - stage!.created > 30 * 60 * 1000 || candidate.name !== skill.name) throw new Error('更新预览已过期或技能不匹配')
      const root = this.packageRoot(id)
      if (skillHash(root) !== skill.hash) throw new Error('技能库有外部修改，请重新导入后再更新')
      const backup = join(this.root, 'packages', id, 'previous'), previousMetadata = join(this.root, 'packages', id, 'previous.json')
      const pending = join(this.root, 'packages', id, `pending-${randomUUID()}`)
      try {
        copySkill(candidate.root, pending)
        this.deleteOwned(backup); renameSync(root, backup)
        try { renameSync(pending, root) } catch (error) { renameSync(backup, root); throw error }
        writeFileSync(previousMetadata, JSON.stringify(skill))
      } finally { if (existsSync(pending)) this.deleteOwned(pending) }
      const value = { ...skill, title: candidate.title, description: candidate.description, source: candidate.source, hash: candidate.hash, files: candidate.files, warnings: candidate.warnings, analysis: undefined, updatedAt: now() }
      this.options.store.savePackage(value); this.log(id, 'update', '技能库已更新；外部工具的安装副本需在安装位置中重新部署')
      for (const installation of this.options.store.installations().filter(i => i.skillId === id && i.target === 'hub')) this.options.store.saveInstallation({ ...installation, hash: value.hash })
      this.discard(token); return value
    })
  }
  restore(id: string): Promise<SkillPackage> {
    return this.exclusive(() => {
      const root = this.packageRoot(id), parent = dirname(root), backup = join(parent, 'previous'), metadata = join(parent, 'previous.json')
      if (!existsSync(backup) || !existsSync(metadata)) throw new Error('没有可恢复的上一版本')
      const current = this.package(id), previous = JSON.parse(readFileSync(metadata, 'utf8')) as SkillPackage
      if (skillHash(root) !== current.hash || skillHash(backup) !== previous.hash) throw new Error('当前或备份文件有外部修改，无法恢复')
      const temporary = join(parent, `swap-${randomUUID()}`)
      renameSync(root, temporary); renameSync(backup, root); renameSync(temporary, backup)
      writeFileSync(metadata, JSON.stringify(current)); previous.updatedAt = now()
      this.options.store.savePackage(previous); this.log(id, 'restore', '已恢复技能库上一版本；安装副本不自动覆盖')
      for (const installation of this.options.store.installations().filter(i => i.skillId === id && i.target === 'hub')) this.options.store.saveInstallation({ ...installation, hash: previous.hash })
      return previous
    })
  }
  export(id: string): Buffer { const skill = this.package(id); return zipSkill(this.packageRoot(id), skill.name) }
  bundle(id: string, replace = false): Promise<import('../../src/types/skills').SkillBundleResult> {
    return this.exclusive(() => {
      if (!this.options.bundledRoot) throw new Error('请在项目开发环境中使用随包分发；安装版可导出 ZIP 后放入源码项目。')
      const skill = this.package(id), source = this.packageRoot(id)
      if (skillHash(source) !== skill.hash) throw new Error('技能库文件已改变，请重新导入后分发')
      const base = resolve(this.options.bundledRoot), destination = inside(base, safeRelative(skill.name))
      this.safeDestination(destination)
      if (existsSync(destination)) {
        if (skillHash(destination) === skill.hash) return { path: destination, status: 'unchanged' }
        if (!replace) return { path: destination, status: 'conflict' }
      }
      mkdirSync(base, { recursive: true })
      const temporary = inside(base, `.pending-${randomUUID()}`), rollback = inside(base, `.previous-${randomUUID()}`)
      let moved = false
      try {
        copySkill(source, temporary)
        if (existsSync(destination)) {
          const backup = join(this.root, 'backups', id, `bundled-${Date.now()}-${randomUUID()}`)
          copySkill(destination, backup)
          this.log(id, 'bundle-backup', `随包分发旧版本已备份：${backup}`)
          renameSync(destination, rollback); moved = true
        }
        try { renameSync(temporary, destination) }
        catch (error) { if (moved) { renameSync(rollback, destination); moved = false }; throw error }
        this.log(id, 'bundle', `已复制到随包分发目录：${destination}`)
        return { path: destination, status: 'copied' }
      } finally {
        for (const path of [temporary, ...(moved ? [rollback] : [])]) {
          // Fixed generated children only; never remove the resource root or destination.
          inside(base, path)
          if (existsSync(path)) { inside(realpathSync(base), realpathSync(path)); rmSync(path, { recursive: true, force: true }) }
        }
      }
    })
  }
  context(projectId?: string, ids?: string[]): SkillContext[] {
    if (projectId && !this.options.project(projectId)) throw new Error('项目不存在')
    const available = this.options.store.installations().filter(i => i.target === 'hub' && i.enabled && (i.scope === 'global' || i.projectId === projectId))
    const allowed = new Set(available.map(i => i.skillId))
    if (ids?.some(id => !allowed.has(id))) throw new Error('所选技能未在当前项目或全局启用')
    return this.options.store.packages().filter(s => allowed.has(s.id) && (!ids || ids.includes(s.id))).map(s => ({ skillId: s.id, name: s.name, description: s.description, root: this.packageRoot(s.id), files: s.files, instructions: this.readFile(s.id, 'SKILL.md') }))
  }
}
