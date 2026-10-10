import type { SkillCandidate } from '../../src/types/skills'

const builtInDescriptions: Record<string, string> = {
  imagegen: '生成或编辑图片，适用于插画、照片、贴图、产品效果图和透明背景素材。',
  'openai-docs': '查阅 OpenAI 官方资料，解答 Codex、ChatGPT、API、模型选择、配置和使用问题。',
  'review-agent': '审查代码变更，找出缺陷并给出可操作的修改建议。',
  'skill-creator': '创建或更新技能，编写技能说明及所需的配套资源。',
  'skill-installer': '从推荐目录或 GitHub 仓库安装技能。',
  'find-skills': '查找适合当前任务的技能，帮助发现和安装新的能力。',
  documents: '创建、编辑和检查 Word 文档，支持排版、修订与批注。',
  pdf: '读取、创建和检查 PDF，支持版式验证及表单处理。',
  presentations: '创建、阅读或编辑演示文稿，适用于 PowerPoint 和 Google Slides。',
  spreadsheets: '创建、编辑和分析电子表格，支持公式、格式、图表和数据处理。',
  'excel-live-control': '操作已连接的 Excel 工作簿，读取和修改单元格、公式及格式。',
  visualize: '制作交互式图表和可视化工具，帮助解释概念、比较方案与探索变化。',
  sites: '构建或修改网站，适用于落地页、作品集、仪表盘和在线工具。',
  'plugin-management': '查找和管理插件，检查权限、依赖及连接状态。',
  'template-creator': '根据参考材料创建或更新可重复使用的个人文档模板技能。',
  'ui-ux-pro-max': '辅助设计网页和移动应用界面，提供布局、配色、字体和交互建议。',
  'flutter-apply-architecture-best-practices': '按界面、逻辑和数据分层组织 Flutter 应用，适用于项目搭建和架构重构。'
}
const cache = new Map<string, string>()
const hasChinese = (text: string) => /[\u3400-\u9fff]/.test(text)
export function localSkillDescription(skill: Pick<SkillCandidate, 'name' | 'description'>): string | undefined {
  if (hasChinese(skill.description)) return skill.description
  return builtInDescriptions[skill.name.split(':').pop()!]
}

export async function describeSkills(
  skills: Array<Pick<SkillCandidate, 'id' | 'name' | 'description'>>,
  translate?: (content: string) => Promise<string>
): Promise<Record<string, string>> {
  const result: Record<string, string> = {}, pending: typeof skills = []
  for (const skill of skills) {
    const value = localSkillDescription(skill) || cache.get(JSON.stringify([skill.name, skill.description]))
    if (value) result[skill.id] = value
    else pending.push(skill)
  }
  if (!translate) return result
  for (let offset = 0; offset < pending.length; offset += 20) {
    const batch = pending.slice(offset, offset + 20)
    const reply = await translate(JSON.stringify(batch))
    const parsed: unknown = JSON.parse(reply.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))
    if (!Array.isArray(parsed)) throw new Error('中文说明返回格式不正确')
    for (const item of parsed) {
      const skill = batch.find(s => s.id === item?.id)
      if (!skill || typeof item.description !== 'string' || !hasChinese(item.description) || item.description.length > 500) continue
      result[skill.id] = item.description.trim()
      cache.set(JSON.stringify([skill.name, skill.description]), result[skill.id])
    }
  }
  return result
}
