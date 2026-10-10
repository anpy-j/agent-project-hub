<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { Project } from '../types'
import type { HostProfile } from '../types/deployment'
import type { AgentTask } from '../types/agent'
const route = useRoute(), router = useRouter()
const opened = ref(false), projects = ref<Project[]>([]), hosts = ref<HostProfile[]>([]), tasks = ref<AgentTask[]>([])
const projectId = ref(''), hostId = ref(''), selectedId = ref(''), prompt = ref(''), busy = ref(false)
const timeline = ref<HTMLElement>()
const active = computed(() => tasks.value.filter(t => ['running', 'awaiting_confirmation', 'stopping'].includes(t.status)))
const selected = computed(() => tasks.value.find(t => t.id === selectedId.value))
const scopedTasks = computed(() => tasks.value.filter(t => (t.context.projectId || '') === projectId.value && (t.context.hostId || '') === hostId.value))
const selectedActive = computed(() => selected.value && ['running', 'awaiting_confirmation', 'stopping'].includes(selected.value.status))
const labels: Record<AgentTask['status'], string> = { running: '执行中', awaiting_confirmation: '等待确认', stopping: '正在停止', success: '已回复', failed: '失败', cancelled: '已停止', interrupted: '已中断' }
function update(task: AgentTask) {
  const index = tasks.value.findIndex(t => t.id === task.id)
  if (index < 0) tasks.value.unshift(task); else tasks.value[index] = task
}
let off: (() => void) | undefined
async function refresh() {
  try {
    const [p, h, t] = await Promise.all([window.api.project.list(), window.api.deployment.hosts(), window.api.agent.tasks()])
    projects.value = p; hosts.value = h
    // Keep updates received during the snapshot request.
    for (const task of t) { const live = tasks.value.find(x => x.id === task.id); if (!live || live.events.length < task.events.length) update(task) }
    if (!selectedId.value) selectedId.value = scopedTasks.value[0]?.id || ''
  } catch (e) { ElMessage.error((e as Error).message) }
}
function contextFromPage() {
  const id = route.name === 'project-detail' ? route.params.id : route.query.project || route.query.projectId
  if (typeof id === 'string' && route.name !== 'delivery') projectId.value = id
}
watch(() => route.fullPath, (_value, previous) => { if (previous?.startsWith('/delivery') && route.name !== 'delivery') hostId.value = ''; contextFromPage() }, { immediate: true })
watch([projectId, hostId], () => { selectedId.value = scopedTasks.value[0]?.id || '' })
watch(opened, value => { if (value) { contextFromPage(); void refresh() } })
watch([() => selected.value?.events.length, selectedId, opened], async () => { await nextTick(); if (timeline.value) timeline.value.scrollTop = timeline.value.scrollHeight })
onMounted(() => { off = window.api.agent.onTask(update); void refresh(); window.addEventListener('project-hub:agent-context', pageContext) })
onBeforeUnmount(() => { off?.(); window.removeEventListener('project-hub:agent-context', pageContext) })
function pageContext(event: Event) {
  const detail = (event as CustomEvent).detail as { projectId?: string; hostId?: string; open?: boolean; prompt?: string }
  projectId.value = detail.projectId || ''; hostId.value = detail.hostId || ''
  if (detail.prompt) prompt.value = detail.prompt
  if (detail.open) opened.value = true
}
async function submit() {
  if (!prompt.value.trim() || busy.value) return
  busy.value = true
  try {
    selectedId.value = await window.api.agent.start({ context: { projectId: projectId.value || undefined, hostId: hostId.value || undefined, page: route.path }, prompt: prompt.value.trim() })
    prompt.value = ''
  } catch (e) { ElMessage.error((e as Error).message) } finally { busy.value = false }
}
async function confirm(approve: boolean) {
  if (!selected.value || busy.value) return
  busy.value = true
  try { await window.api.agent.confirm(selected.value.id, approve) } catch (e) { ElMessage.error((e as Error).message) } finally { busy.value = false }
}
async function stop() {
  if (!selected.value) return
  try { await window.api.agent.cancel(selected.value.id) } catch (e) { ElMessage.error((e as Error).message) }
}
function settings() { opened.value = false; router.push({ path: '/settings', query: { section: 'ai', ai: 'agent' } }) }
</script>
<template>
  <button class="agent-fab" type="button" aria-label="打开全局 Agent" @click="opened = true"><el-icon :size="21"><MagicStick /></el-icon><span>{{ active.length ? `Agent · ${active.length}` : 'Agent' }}</span><span v-if="active.length" class="agent-dot" /></button>
  <el-drawer v-model="opened" title="Project Hub Agent" size="min(560px, 100vw)" :destroy-on-close="false" class="global-agent-drawer">
    <template #header><div class="agent-heading"><strong>Project Hub Agent</strong><el-button size="small" @click="settings">AI 设置</el-button></div></template>
    <div class="agent-panel">
      <p class="agent-note">{{ route.path }} · 关闭面板或切换页面后任务继续。每个任务固定使用发起时选定的操作对象。</p>
      <div class="agent-context"><el-select v-model="projectId" clearable filterable placeholder="选择项目"><el-option v-for="p in projects" :key="p.id" :label="p.display_name || p.name" :value="p.id" /></el-select><el-select v-model="hostId" clearable filterable placeholder="选择服务器"><el-option v-for="h in hosts" :key="h.id" :label="`${h.name} · ${h.host}`" :value="h.id" /></el-select></div>
      <el-select v-model="selectedId" clearable placeholder="当前对象的任务记录" class="agent-history"><el-option v-for="t in scopedTasks" :key="t.id" :label="`${labels[t.status]} · ${t.events[0]?.text.slice(0, 45)}`" :value="t.id" /></el-select>
      <div v-if="active.some(t => !scopedTasks.some(s => s.id === t.id))" class="other-tasks"><el-button v-for="t in active.filter(t => !scopedTasks.some(s => s.id === t.id))" :key="t.id" size="small" @click="projectId = t.context.projectId || ''; hostId = t.context.hostId || ''; nextTick(() => selectedId = t.id)">{{ labels[t.status] }}：{{ t.events[0]?.text.slice(0, 20) }}</el-button></div>
      <div ref="timeline" class="agent-timeline" aria-live="polite">
        <div v-if="!selected" class="agent-empty"><el-icon :size="36"><MagicStick /></el-icon><h3>让 Agent 完成项目操作</h3><p>选择项目或服务器，然后描述需求。</p><div class="agent-examples"><el-button @click="prompt = '查看当前项目的构建目标和部署配置'">查看项目配置</el-button><el-button @click="prompt = '构建当前项目，并列出产物'">构建项目</el-button><el-button @click="prompt = '检查所选服务器的容器与镜像状态'">检查服务器</el-button></div></div>
        <template v-else><div class="agent-task-context">任务对象：{{ projects.find(p => p.id === selected?.context.projectId)?.name || '未选项目' }} · {{ hosts.find(h => h.id === selected?.context.hostId)?.name || '未选服务器' }}<el-tag size="small">{{ labels[selected.status] }}</el-tag></div><div v-for="(e, i) in selected.events" :key="i" :class="['agent-event', e.kind]"><span class="agent-event-label">{{ { user: '你', assistant: 'Agent', tool: '执行记录', error: '执行提示' }[e.kind] }}</span><details v-if="e.kind === 'tool'"><summary>{{ e.text.startsWith('执行：') ? e.text.split('\n')[0] : e.text.startsWith('构建任务：') || e.text.startsWith('发布任务：') ? '查看任务编号' : '查看日志与执行结果' }}</summary><pre>{{ e.text }}</pre></details><pre v-else>{{ e.text }}</pre></div></template>
      </div>
      <div v-if="selected?.status === 'awaiting_confirmation'" class="agent-confirm"><p>请核对上方操作对象、路径与发布配置。</p><el-button :disabled="busy" @click="confirm(false)">取消操作</el-button><el-button type="primary" :loading="busy" @click="confirm(true)">确认执行</el-button></div>
      <div class="agent-compose"><el-input v-model="prompt" type="textarea" :rows="3" maxlength="12000" placeholder="例如：构建 macOS 安装包；上传 dist/app.zip 到服务器 /opt/app.zip" @keydown.ctrl.enter.prevent="submit" @keydown.meta.enter.prevent="submit" /><div class="agent-compose-actions"><span class="agent-note">⌘ / Ctrl + Enter 发送</span><el-button v-if="selectedActive" :disabled="selected?.status === 'stopping'" @click="stop">停止任务</el-button><el-button type="primary" :loading="busy" :disabled="!prompt.trim() || !!selectedActive" @click="submit">发送</el-button></div></div>
    </div>
  </el-drawer>
</template>
<style scoped>
.agent-fab { position:fixed; right:24px; bottom:24px; z-index:1900; display:flex; align-items:center; gap:9px; padding:13px 19px; border:1px solid rgba(255,255,255,.2); border-radius:28px; color:white; background:linear-gradient(135deg,var(--ph-accent),var(--ph-primary-strong)); box-shadow:0 6px 24px rgba(79,70,229,.3); cursor:pointer; font:600 14px inherit }
.agent-fab:focus-visible { outline:3px solid var(--el-color-primary-light-5); outline-offset:3px }
.agent-dot { width:7px; height:7px; border-radius:50%; background:#a7f3d0 }
.agent-heading { display:flex; justify-content:space-between; align-items:center; width:100%; gap:12px }
.agent-panel { height:100%; display:flex; flex-direction:column; gap:12px; min-height:0 }
.agent-note { margin:0; font-size:12px; color:var(--el-text-color-secondary); line-height:1.6 }
.agent-context { display:grid; grid-template-columns:1fr 1fr; gap:10px }
.agent-history { width:100% }
.agent-timeline { flex:1; min-height:0; overflow:auto; padding:4px 2px }
.agent-empty { padding:30px 12px; text-align:center; color:var(--el-text-color-secondary) }
.agent-empty h3 { color:var(--el-text-color-primary) }
.agent-examples { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; margin-top:20px }
.agent-examples .el-button { margin:0 }
.agent-event { margin:12px 0; padding:12px 14px; border-radius:10px; background:var(--el-fill-color-light); border:1px solid var(--el-border-color-lighter) }
.agent-event.user { background:var(--el-color-primary-light-9) }
.agent-event.error { border-color:var(--el-color-danger-light-5) }
.agent-event summary { margin-top:8px; font-size:13px; cursor:pointer; color:var(--el-text-color-regular) }
.agent-event-label { font-size:12px; color:var(--el-text-color-secondary) }
.agent-event pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:8px 0 0; font-family:inherit; font-size:13px; line-height:1.65 }
.agent-event.tool pre { font-family:monospace; font-size:12px; max-height:260px; overflow:auto }
.agent-task-context { font-size:12px; display:flex; flex-wrap:wrap; align-items:center; gap:8px; color:var(--el-text-color-secondary) }
.agent-confirm { padding:12px; border-radius:10px; background:var(--el-color-warning-light-9) }
.agent-confirm p { margin:0 0 10px; font-size:13px }
.agent-compose-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-top:10px }
.agent-compose-actions .agent-note { margin-right:auto }
.other-tasks { display:flex; gap:6px; flex-wrap:wrap }
</style>
<style>
.global-agent-drawer .el-drawer__body { overflow:hidden; padding-top:0 }
.global-agent-drawer .el-drawer__header { margin-bottom:18px }
</style>
