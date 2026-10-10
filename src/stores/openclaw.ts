import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { OpenClawConnection, OpenClawInstance } from '../types/openclaw'
export interface ClawMessage { role: string; content: any; localId?: string }
export function messageText(message: any): string {
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) return message.content.map((part: any) => part.text || (part.type === 'toolCall' || part.type === 'tool_use' ? `工具：${part.name || '执行中'}` : '')).filter(Boolean).join('\n')
  return message?.text || ''
}
export const useOpenClawStore = defineStore('openclaw', () => {
  const instances = ref<OpenClawInstance[]>([])
  const selected = ref(localStorage.getItem('project-hub.openclaw.instance') || '')
  const states = ref<Record<string, OpenClawConnection>>({})
  const sessions = ref<Record<string, any[]>>({})
  const agents = ref<Record<string, any[]>>({})
  const activeSession = ref<Record<string, string>>({})
  const messages = ref<Record<string, ClawMessage[]>>({})
  const runs = ref<Record<string, { id: string; text: string; status: string; error?: string }>>({})
  const approvals = ref<Record<string, any[]>>({})
  const activity = ref<Record<string, string[]>>({})
  const approvalRevision: Record<string, number> = {}
  let subscribed = false
  const key = (id: string, session: string) => `${id}\n${session}`
  async function refresh(id: string) {
    if (instances.value.find(row => row.id === id)?.transport === 'http') {
      const result = await window.api.openclaw.request(id, 'sessions.list')
      sessions.value[id] = result?.sessions || []; agents.value[id] = []; approvals.value[id] = []
      return
    }
    const revision = approvalRevision[id] || 0
    void window.api.openclaw.request(id, 'exec.approval.list').then(result => {
      if ((approvalRevision[id] || 0) === revision && states.value[id]?.status === 'connected') approvals.value[id] = Array.isArray(result) ? result : []
    }).catch(() => {})
    const [sessionResult, agentResult] = await Promise.allSettled([
      window.api.openclaw.request(id, 'sessions.list', { limit: 100, includeDerivedTitles: true }),
      window.api.openclaw.request(id, 'agents.list')
    ])
    if (sessionResult.status === 'fulfilled') sessions.value[id] = sessionResult.value?.sessions || []
    if (agentResult.status === 'fulfilled') agents.value[id] = agentResult.value?.agents || []
    if (sessionResult.status === 'rejected') throw sessionResult.reason
    if (agentResult.status === 'rejected') throw agentResult.reason
  }
  async function history(id: string, session: string) {
    const result = await window.api.openclaw.request(id, 'chat.history', { sessionKey: session, limit: 200 })
    messages.value[key(id, session)] = result?.messages || []
    if (result?.error && !['sending', 'running'].includes(runs.value[key(id, session)]?.status)) runs.value[key(id, session)] = { id: '', text: '', status: 'interrupted', error: result.error }
  }
  async function init() {
    if (!subscribed) {
      window.api.openclaw.onEvent(value => {
        const { instanceId: id, event, payload: p } = value
        if (event === 'connection') {
          states.value[id] = p
          if (p.status === 'connected' && instances.value.some(row => row.id === id)) { void refresh(id).catch(() => {}); const session = activeSession.value[id]; if (session && instances.value.find(row => row.id === id)?.transport !== 'http') void history(id, session).catch(() => {}) }
          if (p.status === 'error' || p.status === 'disconnected') {
            approvals.value[id] = []; approvalRevision[id] = (approvalRevision[id] || 0) + 1
            for (const [k, run] of Object.entries(runs.value)) if (k.startsWith(`${id}\n`) && ['sending', 'running'].includes(run.status)) { run.status = 'interrupted'; run.error = '连接已断开，重连后请检查历史；消息不会自动重发' }
          }
        } else if (event === 'chat' && p?.sessionKey) {
          const k = key(id, p.sessionKey)
          const run = runs.value[k]
          if (run && (run.id === p.runId || run.status === 'sending')) {
            run.id = p.runId || run.id
            run.status = p.state === 'delta' ? 'running' : p.state
            if (p.message) run.text = messageText(p.message)
            if (p.errorMessage) run.error = p.errorMessage
            if (['final', 'aborted', 'error'].includes(p.state)) {
              if (run.text) (messages.value[k] ||= []).push({ role: 'assistant', content: run.text, localId: run.id })
              run.text = ''
              void refresh(id).catch(() => {})
              // Preserve optimistic messages if durable history has not caught up yet.
              void window.api.openclaw.request(id, 'chat.history', { sessionKey: p.sessionKey, limit: 200 }).then(result => {
                const transcript = result?.messages || []
                const last = messages.value[k]?.at(-1)
                if (instances.value.find(row => row.id === id)?.transport === 'http') { messages.value[k] = transcript; return }
                if (last && transcript.some((m: any) => m.role === last.role && messageText(m) === messageText(last))) messages.value[k] = transcript
              }).catch(() => {})
            }
          }
        } else if (event === 'exec.approval.requested') {
          approvalRevision[id] = (approvalRevision[id] || 0) + 1
          if (p?.id) approvals.value[id] = [...(approvals.value[id] || []).filter(a => a.id !== p.id), p]
        } else if (event === 'exec.approval.resolved') {
          approvalRevision[id] = (approvalRevision[id] || 0) + 1
          approvals.value[id] = (approvals.value[id] || []).filter(a => a.id !== p?.id)
        } else if (event === 'agent' && p?.stream === 'tool') {
          const text = `${p.data?.phase || '执行'} · ${p.data?.name || p.data?.toolName || '工具'}`
          activity.value[id] = [...(activity.value[id] || []), text].slice(-20)
        }
      })
      subscribed = true
    }
    instances.value = await window.api.openclaw.list()
    for (const state of await window.api.openclaw.connections()) states.value[state.instanceId] = state
    if (!instances.value.some(row => row.id === selected.value)) selected.value = instances.value[0]?.id || ''
    for (const row of instances.value.filter(row => row.transport === 'http')) {
      await refresh(row.id)
      if (!activeSession.value[row.id] && sessions.value[row.id]?.length) activeSession.value[row.id] = sessions.value[row.id][0].key
      if (activeSession.value[row.id] && !['sending', 'running'].includes(runs.value[key(row.id, activeSession.value[row.id])]?.status)) await history(row.id, activeSession.value[row.id])
    }
  }
  function select(id: string) { selected.value = id; localStorage.setItem('project-hub.openclaw.instance', id) }
  async function send(id: string, session: string, text: string) {
    const k = key(id, session), idempotencyKey = crypto.randomUUID()
    if (runs.value[k] && ['sending', 'running'].includes(runs.value[k].status)) throw new Error('请等待当前回复结束')
    runs.value[k] = { id: idempotencyKey, text: '', status: 'sending' }
    ;(messages.value[k] ||= []).push({ role: 'user', content: text, localId: idempotencyKey })
    try {
      const result = await window.api.openclaw.request(id, 'chat.send', { sessionKey: session, message: text, deliver: false, idempotencyKey })
      const run = runs.value[k]
      if (run.status === 'sending') { run.id = result?.runId || idempotencyKey; run.status = 'running' }
    } catch (error) { runs.value[k].status = 'error'; runs.value[k].error = (error as Error).message; throw error }
  }
  return { instances, selected, states, sessions, agents, activeSession, messages, runs, approvals, activity, key, init, refresh, history, select, send }
})
