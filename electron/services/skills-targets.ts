import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SkillScope, SkillTarget, SkillTargetInfo } from '../../src/types/skills'

export function skillTargets(home = homedir(), codexHome = process.env.CODEX_HOME): SkillTargetInfo[] {
  const legacyCodex = join(codexHome || join(home, '.codex'), 'skills')
  return [
    { id: 'codex', name: 'Codex', globalPath: codexHome || existsSync(legacyCodex) ? legacyCodex : join(home, '.agents', 'skills'), projectFolder: '.agents/skills', hint: '兼容本机 .codex/skills 与 CODEX_HOME；项目技能使用共享 .agents/skills。安装后刷新或重新打开会话。' },
    { id: 'opencode', name: 'OpenCode', globalPath: join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'skills'), projectFolder: '.opencode/skills', hint: '保留完整技能文件。调用方式及权限由 OpenCode 控制，安装后重新打开会话。' },
    { id: 'antigravity', name: 'Antigravity', globalPath: existsSync(join(home, '.gemini', 'antigravity', 'skills')) && !existsSync(join(home, '.gemini', 'config', 'skills')) ? join(home, '.gemini', 'antigravity', 'skills') : join(home, '.gemini', 'config', 'skills'), projectFolder: '.agents/skills', hint: 'IDE/桌面技能目录，兼容已有旧目录；项目位置与 Codex 共享。CLI 的已有技能可通过扫描导入。' },
    { id: 'hub', name: 'Project Hub AI', globalPath: '应用本地技能库', projectFolder: '', hint: '由应用加载技能说明与引用资源；用途解读复用 AI 服务。执行类任务仍需要 Agent 工具运行器。' }
  ]
}

export function targetPath(targets: SkillTargetInfo[], target: SkillTarget, scope: SkillScope, name: string, projectPath?: string): string {
  const info = targets.find(t => t.id === target)
  if (!info || !['global', 'project'].includes(scope)) throw new Error('无效的目标或安装范围')
  if (target === 'hub') return ''
  if (scope === 'project' && !projectPath) throw new Error('请选择一个有效项目')
  return resolve(scope === 'global' ? info.globalPath : join(projectPath!, info.projectFolder), name)
}
