import type { AiConfig } from './index'
export interface AgentContext { projectId?: string; hostId?: string; page: string }
export interface AgentAction { tool: string; args: Record<string, string> }
export interface AgentEvent { at: string; kind: 'user' | 'assistant' | 'tool' | 'error'; text: string }
export interface AgentTask {
  id: string; context: AgentContext; status: 'running' | 'awaiting_confirmation' | 'stopping' | 'success' | 'failed' | 'cancelled' | 'interrupted'
  events: AgentEvent[]; pending?: AgentAction; createdAt: string
}
export interface AgentAPI {
  getConfig: () => Promise<AiConfig>
  saveConfig: (config: AiConfig) => Promise<AiConfig>
  test: (config: AiConfig) => Promise<string>
  tasks: () => Promise<AgentTask[]>
  start: (input: { context: AgentContext; prompt: string }) => Promise<string>
  confirm: (id: string, approve: boolean) => Promise<void>
  cancel: (id: string) => Promise<void>
  onTask: (callback: (task: AgentTask) => void) => () => void
}
