import type { AgentAction } from '../../src/types/agent'
export const AGENT_TOOLS = ['project_info', 'build', 'artifacts', 'release', 'server_status', 'server_logs', 'git_push', 'git_pull', 'upload_file', 'download_file'] as const
export function parseAgentResponse(raw: string): { reply?: string; action?: AgentAction } {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let value: any
  try { value = JSON.parse(text) } catch { throw new Error('模型未返回有效的任务格式，请重试或更换 Agent 模型') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent 响应格式不正确')
  if (typeof value.reply === 'string' && !value.action && value.reply.trim()) return { reply: value.reply.slice(0, 16000) }
  const action = value.action
  if (!action || !AGENT_TOOLS.includes(action.tool) || !action.args || typeof action.args !== 'object' || Array.isArray(action.args)) throw new Error('Agent 请求了不支持的工具')
  if (Object.values(action.args).some(v => typeof v !== 'string' || v.length > 4096 || v.includes('\0'))) throw new Error('工具参数格式不正确')
  return { action: { tool: action.tool, args: { ...action.args } } }
}
export function needsAgentApproval(action: AgentAction): boolean {
  return ['build', 'release', 'git_push', 'git_pull', 'upload_file', 'download_file'].includes(action.tool)
}
