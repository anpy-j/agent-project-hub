<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '../components/PageHeader.vue'
import { useOpenClawStore, messageText } from '../stores/openclaw'
import type { OpenClawInput, OpenClawInstance } from '../types/openclaw'
import type { HostProfile } from '../types/deployment'
const store = useOpenClawStore()
const tab = ref('chat'), busy = ref(false), loadingHistory = ref(false), draft = ref(''), agentId = ref('main')
const dialog = ref(false), hosts = ref<HostProfile[]>([]), output = ref(''), managementBusy = ref(false)
const transcript = ref<HTMLElement>()
const form = reactive<OpenClawInput>({ id: '', name: '', transport: 'http', url: 'https://play.anpy.top/v1/chat/completions', model: 'openclaw', stream: true, management: 'none', managementPort: 18789, adminAccess: false, pairingAccess: false, hostId: '', cliPath: 'openclaw', authMode: 'token', token: '', clearToken: false })
const current = computed(() => store.instances.find(row => row.id === store.selected))
const state = computed(() => store.states[store.selected])
const isHttp = computed(() => current.value?.transport === 'http')
const connected = computed(() => isHttp.value || state.value?.status === 'connected')
const canManage = computed(() => current.value?.transport !== 'direct' && (!isHttp.value || ['local', 'ssh'].includes(current.value?.management || 'none')))
const canReadLogs = computed(() => canManage.value || (!isHttp.value && connected.value))
const session = computed(() => store.activeSession[store.selected] || '')
const sessionTitle = computed(() => { const item = store.sessions[store.selected]?.find(row => row.key === session.value); return item?.displayName || item?.derivedTitle || item?.label || '新对话' })
const messages = computed(() => store.messages[store.key(store.selected, session.value)] || [])
const run = computed(() => store.runs[store.key(store.selected, session.value)])
const running = computed(() => ['sending', 'running'].includes(run.value?.status || ''))
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
const statusLabel = computed(() => isHttp.value ? (state.value?.verified ? '接口已验证' : '接口已配置') : ({ connected: '已连接', connecting: '连接中', error: '连接失败', disconnected: '未连接' }[state.value?.status || 'disconnected']))
async function perform(fn: () => Promise<unknown>) { try { return await fn() } catch (error) { ElMessage.error((error as Error).message); return undefined } }
async function initialize() { await perform(async () => { await store.init(); hosts.value = await window.api.deployment.hosts() }) }
onMounted(initialize)
watch(() => store.selected, () => { draft.value = ''; output.value = ''; agentId.value = session.value.split(':')[1] || store.agents[store.selected]?.[0]?.id || 'main' })
watch(() => form.transport, value => {
  if (!dialog.value) return
  if (value === 'http' && /^wss?:/i.test(form.url)) form.url = 'https://play.anpy.top/v1/chat/completions'
  if (value !== 'http' && /^https?:/i.test(form.url)) form.url = value === 'direct' ? 'wss://' : 'ws://127.0.0.1:18789'
})
watch(() => [messages.value.length, run.value?.text], async () => { await nextTick(); if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight })
function edit(row?: OpenClawInstance) { Object.assign(form, { id: '', name: '', transport: 'http', url: 'https://play.anpy.top/v1/chat/completions', model: 'openclaw', stream: true, management: 'none', managementPort: 18789, adminAccess: false, pairingAccess: false, hostId: '', cliPath: 'openclaw', authMode: 'token', token: '', clearToken: false }, row || {}); dialog.value = true }
async function save() {
  busy.value = true
  await perform(async () => { const row = await window.api.openclaw.save({ ...form }); await store.init(); store.select(row.id); dialog.value = false; form.token = ''; ElMessage.success('实例已保存') })
  busy.value = false
}
async function discover() {
  busy.value = true
  await perform(async () => { const row = await window.api.openclaw.discover(); await store.init(); store.select(row.id); await connect() })
  busy.value = false
}
async function disconnect() { await perform(() => window.api.openclaw.disconnect(store.selected)) }
async function connect() {
  const id = store.selected
  await perform(async () => {
    store.states[id] = await window.api.openclaw.connect(id)
    if (store.states[id].status === 'connected') {
      await store.refresh(id)
      agentId.value = store.agents[id]?.[0]?.id || 'main'
      const selectedSession = store.activeSession[id]
      if (selectedSession) await store.history(id, selectedSession)
    }
  })
}
async function selectSession(key: string) {
  const id = store.selected
  store.activeSession[id] = key; agentId.value = key.split(':')[1] || 'main'
  loadingHistory.value = true
  await perform(() => store.history(id, key)); loadingHistory.value = false
}
function newSession() {
  if (isHttp.value) { store.activeSession[store.selected] = `http-${crypto.randomUUID()}`; draft.value = ''; return }
  store.activeSession[store.selected] = `agent:${agentId.value}:project-hub-${crypto.randomUUID()}`
  draft.value = ''
}
async function send() {
  const text = draft.value.trim(), id = store.selected
  if (!text || !connected.value || running.value) return
  if (!session.value) newSession()
  const key = session.value; draft.value = ''
  await perform(() => store.send(id, key, text))
}
async function testHttp() { busy.value = true; await perform(async () => { ElMessage.success(await window.api.openclaw.request(store.selected, 'http.test')) }); busy.value = false }
async function stop() { await perform(() => window.api.openclaw.request(store.selected, 'chat.abort', { sessionKey: session.value, runId: run.value?.id })) }
async function resolveApproval(id: string, decision: 'allow-once' | 'deny') {
  const instanceId = store.selected
  await perform(async () => { await window.api.openclaw.request(instanceId, 'exec.approval.resolve', { id, decision }); store.approvals[instanceId] = (store.approvals[instanceId] || []).filter(a => a.id !== id) })
}
async function service(action: 'status' | 'start' | 'stop' | 'restart' | 'logs') {
  const row = current.value
  if (!row) return
  if (action === 'stop' || action === 'restart') {
    try { await ElMessageBox.confirm(`${action === 'stop' ? '停止' : '重启'}「${row.name}」会中断该实例正在执行的任务。`, '服务操作', { type: 'warning', confirmButtonText: '继续', cancelButtonText: '取消' }) } catch { return }
  }
  managementBusy.value = true
  await perform(async () => {
    if (action === 'logs' && row.transport !== 'http' && store.states[row.id]?.status === 'connected') {
      const logs = await window.api.openclaw.request(row.id, 'logs.tail', { limit: 200, maxBytes: 200000 }); output.value = (logs.lines || []).join('\n') || '暂无日志'
    } else output.value = await window.api.openclaw.service(row.id, action)
    if (row.transport !== 'http' && ['start', 'restart'].includes(action)) store.states[row.id] = await window.api.openclaw.connect(row.id)
  })
  managementBusy.value = false
}
async function remove(row: OpenClawInstance) {
  try { await ElMessageBox.confirm(`移除「${row.name}」的连接配置？OpenClaw 服务和会话不会被删除。`, '移除实例', { type: 'warning' }) } catch { return }
  await perform(async () => { await window.api.openclaw.remove(row.id); await store.init() })
}
async function copy(text: string) { await perform(async () => { await navigator.clipboard.writeText(text); ElMessage.success('已复制') }) }
function openLink(event: MouseEvent) {
  const target = (event.target as HTMLElement).closest('a')
  if (!target) return
  event.preventDefault()
  if (/^https?:\/\//i.test(target.href)) void window.api.system.openExternal(target.href)
}
</script>

<template>
  <div class="claw-page">
    <PageHeader title="OpenClaw" subtitle="连接本机与服务器，让对话和管理在一个地方完成">
      <template #actions><el-button :loading="busy" @click="discover">连接本机</el-button><el-button type="primary" @click="edit()">添加实例</el-button></template>
    </PageHeader>
    <div class="instance-bar">
      <el-select :model-value="store.selected" placeholder="选择 OpenClaw 实例" @change="store.select"><el-option v-for="row in store.instances" :key="row.id" :value="row.id" :label="row.name" /></el-select>
      <el-tag :type="connected ? 'success' : state?.status === 'error' ? 'danger' : 'info'">{{ statusLabel }}</el-tag>
      <span v-if="current" class="muted">{{ current.transport === 'http' ? 'HTTP 接口 · ' + (current.model || 'openclaw') : current.transport === 'local' ? '本机' : current.transport === 'ssh' ? '服务器 · SSH 隧道' : '远程直连' }}<template v-if="state?.version"> · {{ state.version }}</template></span>
      <div class="bar-spacer" />
      <el-button v-if="isHttp" :loading="busy" @click="testHttp">测试接口</el-button>
      <el-button v-if="current && !isHttp && !connected" :loading="state?.status === 'connecting'" @click="connect">连接</el-button>
      <el-button v-if="!isHttp && connected" @click="disconnect">断开</el-button>
      <el-button v-if="current" text @click="edit(current)">编辑连接</el-button>
    </div>
    <el-alert v-if="state?.error" class="connection-error" :title="state.error" type="error" :closable="false" show-icon>
      <template v-if="/pair|配对/i.test(state.error)">请在目标 OpenClaw 管理端核对并批准 Project Hub 设备后重新连接。设备 ID：{{ state.deviceId }}</template>
    </el-alert>
    <el-alert v-if="!isHttp && connected" class="permission-note" :title="'服务端授予的权限：' + (state?.scopes?.join('、') || '未返回权限信息')" type="info" :closable="false" />
    <el-alert v-if="!isHttp && connected && ((current?.adminAccess && !state?.scopes?.includes('operator.admin')) || (current?.pairingAccess && !state?.scopes?.includes('operator.pairing') && !state?.scopes?.includes('operator.admin')))" title="申请的管理权限尚未获服务端授予，请在 OpenClaw 端核对设备审批，再重新连接。" type="warning" :closable="false" />
    <div v-if="!store.instances.length" class="welcome">
      <el-icon :size="48"><ChatDotRound /></el-icon><h2>连接你的 OpenClaw</h2><p>填写聊天接口地址、API Key 和模型名即可开始对话。</p>
      <div><el-button type="primary" @click="edit()">添加 HTTP 接口</el-button><el-button :loading="busy" @click="discover">连接本机 Gateway</el-button></div>
    </div>
    <el-tabs v-else v-model="tab" class="claw-tabs">
      <el-tab-pane label="对话" name="chat">
        <div class="chat-layout">
          <aside class="sessions-panel">
            <div class="session-controls"><el-tag v-if="isHttp" class="http-model">{{ current?.model || 'openclaw' }}</el-tag><el-select v-else v-model="agentId" placeholder="选择 Agent" :disabled="!connected"><el-option v-for="agent in store.agents[store.selected] || []" :key="agent.id" :value="agent.id" :label="agent.name || agent.identity?.name || agent.id" /></el-select><el-button :disabled="!connected" @click="newSession">新对话</el-button></div>
            <div class="session-heading"><span>会话</span><el-button text size="small" :disabled="!connected" @click="perform(() => store.refresh(store.selected))">刷新</el-button></div>
            <button v-for="item in store.sessions[store.selected] || []" :key="item.key" class="session-row" :class="{ active: session === item.key }" :disabled="!connected" @click="selectSession(item.key)"><strong>{{ item.displayName || item.derivedTitle || item.label || '未命名会话' }}</strong><span>{{ item.updatedAt ? new Date(item.updatedAt).toLocaleString() : 'OpenClaw 会话' }}</span></button>
            <p v-if="!store.sessions[store.selected]?.length" class="muted empty-sessions">{{ connected ? '暂无会话，开始一段新对话' : '连接后查看会话' }}</p>
          </aside>
          <section class="conversation">
            <div class="conversation-title"><strong>{{ current?.name }}</strong><span class="muted">{{ session ? '当前会话 · ' + sessionTitle : '选择会话或开始新对话' }}</span></div>
            <p v-if="isHttp" class="http-note">会话历史保存在本机。测试接口会发送一条简短消息。</p>
            <div ref="transcript" v-loading="loadingHistory" class="transcript" @click="openLink">
              <div v-if="!messages.length && !run?.text" class="chat-empty"><el-icon :size="36"><ChatLineRound /></el-icon><h3>{{ connected ? '准备好开始对话了' : '先连接 OpenClaw' }}</h3><p>消息会发送给 {{ current?.name }}，执行能力由该实例的 Agent 配置决定。</p></div>
              <article v-for="(message, index) in messages" :key="message.localId || index" class="message" :class="message.role">
                <div class="message-label"><span>{{ message.role === 'user' ? '你' : message.role === 'assistant' ? 'OpenClaw' : '工具结果' }}</span><el-button text size="small" @click="copy(messageText(message))">复制</el-button></div>
                <div class="markdown" v-html="md.render(messageText(message))" />
              </article>
              <article v-if="run?.text" class="message assistant"><div class="message-label">OpenClaw · 回复中</div><div class="markdown" v-html="md.render(run.text)" /></article>
              <p v-if="running && !run?.text" class="muted">OpenClaw 正在处理…</p>
              <el-alert v-if="run?.error" :title="run.error" type="error" :closable="false" />
            </div>
            <div v-if="store.activity[store.selected]?.length" class="activity"><el-collapse><el-collapse-item title="最近的工具执行" name="tools"><div v-for="(item, i) in store.activity[store.selected]" :key="i">{{ item }}</div></el-collapse-item></el-collapse></div>
            <div v-for="approval in store.approvals[store.selected] || []" :key="approval.id" class="approval"><strong>等待执行审批 · {{ current?.name }}</strong><pre>{{ approval.request?.command || approval.request?.commandPreview || JSON.stringify(approval.request || approval, null, 2) }}</pre><el-button type="primary" @click="resolveApproval(approval.id, 'allow-once')">允许一次</el-button><el-button @click="resolveApproval(approval.id, 'deny')">拒绝</el-button></div>
            <div class="compose"><el-input v-model="draft" type="textarea" :rows="3" resize="none" :disabled="!connected || loadingHistory" :placeholder="connected ? '输入消息，⌘ / Ctrl + Enter 发送' : '请先连接当前实例'" @keydown.meta.enter.prevent="send" @keydown.ctrl.enter.prevent="send" /><div class="compose-actions"><span class="muted">发送至 {{ current?.name }}</span><el-button v-if="running" type="danger" plain @click="stop">停止回复</el-button><el-button type="primary" :disabled="!connected || !draft.trim() || running || loadingHistory" @click="send">发送</el-button></div></div>
          </section>
        </div>
      </el-tab-pane>
      <el-tab-pane label="管理" name="manage">
        <div class="manage-panel"><h3>{{ current?.name }} · 服务管理</h3><p class="muted">服务控制独立于聊天接口，本机通过 CLI，服务器通过 SSH。</p><div class="manage-actions"><el-button :disabled="managementBusy || !canManage" @click="service('status')">查看状态</el-button><el-button :disabled="managementBusy || !canManage" @click="service('start')">启动</el-button><el-button :disabled="managementBusy || !canManage" @click="service('restart')">重启</el-button><el-button type="danger" plain :disabled="managementBusy || !canManage" @click="service('stop')">停止</el-button><el-button :disabled="managementBusy || !canReadLogs" @click="service('logs')">读取日志</el-button></div><el-alert v-if="isHttp && !canManage" title="HTTP 聊天接口只提供对话，服务管理需在「编辑连接」中绑定本机或 SSH 主机。" type="info" :closable="false" /><p v-if="current?.transport === 'direct'" class="muted">服务控制需要 SSH；远程直连支持在线日志。</p><pre v-loading="managementBusy" class="service-output">{{ output || '选择一个操作，结果将在这里显示。' }}</pre></div>
      </el-tab-pane>
      <el-tab-pane label="连接设置" name="settings">
        <div class="settings-list"><div v-for="row in store.instances" :key="row.id" class="settings-row"><div><strong>{{ row.name }}</strong><p class="muted">{{ row.url }} · {{ row.transport === 'http' ? 'HTTP · ' + row.model : row.transport === 'ssh' ? 'SSH' : row.transport === 'local' ? '本机' : '直连' }} · {{ row.hasToken ? '已保存凭据' : '未保存凭据' }}</p></div><el-button @click="edit(row)">编辑</el-button><el-button type="danger" text @click="remove(row)">移除</el-button></div></div>
      </el-tab-pane>
    </el-tabs>
    <el-dialog v-model="dialog" :title="form.id ? '编辑 OpenClaw 实例' : '添加 OpenClaw 实例'" width="580px" :close-on-click-modal="false">
      <el-form label-position="top">
        <el-form-item label="实例名称"><el-input v-model="form.name" placeholder="例如：服务器 OpenClaw" /></el-form-item>
        <el-form-item label="接入方式">
          <el-select v-model="form.transport"><el-option label="HTTP 聊天接口（OpenAI 兼容）" value="http" /><el-option label="本机 Gateway" value="local" /><el-option label="服务器 Gateway（SSH 隧道）" value="ssh" /><el-option label="远程 Gateway（WSS）" value="direct" /></el-select>
        </el-form-item>
        <template v-if="form.transport === 'http'">
          <el-form-item label="聊天接口地址"><el-input v-model="form.url" placeholder="https://你的域名/v1/chat/completions" /><p class="form-tip">支持完整接口地址或 /v1 地址。</p></el-form-item>
          <el-form-item label="模型名称"><el-input v-model="form.model" placeholder="openclaw" /></el-form-item>
          <el-form-item label="API Key"><el-input v-model="form.token" type="password" show-password autocomplete="new-password" :placeholder="form.id ? '留空保留已有凭据' : '填写完整 Key，无需 Bearer 前缀'" /></el-form-item>
          <el-checkbox v-model="form.stream">流式回复</el-checkbox><p class="form-tip">接口不支持流式输出时可关闭；不会自动重试或重复发送。</p>
          <el-divider content-position="left">服务管理（可选）</el-divider>
          <el-form-item label="管理方式"><el-select v-model="form.management"><el-option label="仅使用聊天接口" value="none" /><el-option label="本机 OpenClaw 服务" value="local" /><el-option label="服务器 OpenClaw 服务（SSH）" value="ssh" /></el-select></el-form-item>
        </template>
        <template v-else>
          <el-form-item :label="form.transport === 'ssh' ? '服务器上的 Gateway 地址' : 'Gateway 地址'"><el-input v-model="form.url" placeholder="ws://127.0.0.1:18789 或 wss://你的域名" /><p class="form-tip">SSH 模式填服务器回环 ws:// 地址，应用自动建立隧道。</p></el-form-item>
          <el-form-item label="鉴权方式"><el-radio-group v-model="form.authMode"><el-radio-button value="token">Token</el-radio-button><el-radio-button value="password">密码</el-radio-button></el-radio-group></el-form-item>
          <el-form-item :label="form.authMode === 'password' ? 'Gateway 密码' : 'Gateway Token'"><el-input v-model="form.token" type="password" show-password autocomplete="new-password" :placeholder="form.id ? '留空保留凭据，更换鉴权方式需重新填写' : '填写目标 Gateway 的凭据'" /></el-form-item>
          <el-form-item label="申请的管理权限"><el-checkbox v-model="form.adminAccess">配置管理（operator.admin）</el-checkbox><el-checkbox v-model="form.pairingAccess">设备配对管理（operator.pairing）</el-checkbox><p class="form-tip">默认仅申请读会话、发消息和执行审批。增加权限后重新连接，可能需要在 OpenClaw 端再次批准设备。</p></el-form-item>
        </template>
        <el-checkbox v-if="form.id" v-model="form.clearToken">清除已保存凭据</el-checkbox>
        <el-form-item v-if="form.transport === 'ssh' || (form.transport === 'http' && form.management === 'ssh')" label="服务器"><el-select v-model="form.hostId" placeholder="选择已保存的 SSH 主机"><el-option v-for="host in hosts" :key="host.id" :value="host.id" :label="host.name + ' · ' + host.host" /></el-select><p class="form-tip">主机和 SSH 登录凭据在「镜像与服务器」中配置。</p></el-form-item>
        <el-form-item v-if="form.transport === 'http' && form.management !== 'none'" label="受管理的 OpenClaw 服务端口"><el-input-number v-model="form.managementPort" :min="1" :max="65535" /><p class="form-tip">用于核对 CLI 管理的服务，默认 18789；聊天仍使用上面的 HTTP 接口。</p></el-form-item>
        <el-form-item v-if="form.transport !== 'direct' && (form.transport !== 'http' || form.management !== 'none')" label="OpenClaw CLI 路径"><el-input v-model="form.cliPath" placeholder="openclaw 或可执行文件绝对路径" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialog = false">取消</el-button><el-button type="primary" :loading="busy" @click="save">保存实例</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.permission-note { margin-bottom: 12px; }.http-note { padding: 8px 22px; margin: 0; color: var(--ph-muted); font-size: 12px; border-bottom: 1px solid var(--ph-line); }.http-model { align-self: flex-start; }
.claw-page { padding: 28px 32px; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; overflow: auto; }
.instance-bar { display: flex; align-items: center; gap: 12px; padding: 16px 0; flex-wrap: wrap; }
.instance-bar .el-select { width: 230px; }.bar-spacer { flex: 1; }.muted,.form-tip { color: var(--ph-muted); font-size: 12px; }.connection-error { margin-bottom: 12px; }
.welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: var(--ph-muted); }.welcome h2 { color: var(--el-text-color-primary); margin: 0; }
.claw-tabs { flex: 1; min-height: 0; display: flex; flex-direction: column; }.claw-tabs :deep(.el-tabs__content) { flex: 1; overflow: auto; }.claw-tabs :deep(.el-tab-pane) { height: 100%; }
.chat-layout { display: grid; grid-template-columns: 230px minmax(0,1fr); height: 100%; min-height: 480px; border: 1px solid var(--ph-line); border-radius: var(--ph-radius-md); background: var(--ph-panel); overflow: hidden; }
.sessions-panel { border-right: 1px solid var(--ph-line); padding: 14px; overflow: auto; }.session-controls { display: flex; flex-direction: column; gap: 10px; }.session-heading { display: flex; align-items: center; justify-content: space-between; margin-top: 18px; font-size: 12px; color: var(--ph-muted); }
.session-row { width: 100%; border: 0; background: transparent; color: var(--el-text-color-primary); text-align: left; padding: 12px 10px; margin-top: 4px; border-radius: var(--ph-radius-sm); cursor: pointer; }.session-row:hover,.session-row.active { background: var(--el-color-primary-light-9); }.session-row strong,.session-row span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.session-row strong { font-size: 13px; font-weight: 500; }.session-row span { color: var(--ph-muted); font-size: 10px; margin-top: 6px; }.empty-sessions { padding: 16px 4px; }
.conversation { display: flex; flex-direction: column; min-height: 0; min-width: 0; }.conversation-title { display: flex; flex-direction: column; gap: 6px; padding: 16px 22px; border-bottom: 1px solid var(--ph-line); overflow-wrap: anywhere; }.transcript { flex: 1; min-height: 180px; overflow: auto; padding: 20px 24px; }.chat-empty { text-align: center; color: var(--ph-muted); padding: 50px 20px; }.chat-empty h3 { color: var(--el-text-color-primary); }.chat-empty p { font-size: 13px; line-height: 1.7; }
.message { margin: 0 0 20px; padding: 14px 18px; border-radius: var(--ph-radius-md); background: var(--ph-panel-2); }.message.user { background: var(--el-color-primary-light-9); }.message-label { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--ph-muted); margin-bottom: 8px; }.markdown { line-height: 1.75; font-size: 14px; overflow-wrap: anywhere; }.markdown :deep(p) { margin: 8px 0; }.markdown :deep(pre) { overflow: auto; padding: 14px; background: var(--ph-term-bg); color: var(--ph-term-fg); border-radius: var(--ph-radius-sm); }.markdown :deep(code) { font-family: var(--ph-font-mono); }.markdown :deep(a) { color: var(--el-color-primary); }.markdown :deep(table) { border-collapse: collapse; }.markdown :deep(td),.markdown :deep(th) { border: 1px solid var(--ph-line); padding: 6px; }
.compose { border-top: 1px solid var(--ph-line); padding: 16px 20px; }.compose-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 12px; padding-right: 100px; }.compose-actions .muted { margin-right: auto; }.approval { margin: 8px 20px; padding: 12px; background: var(--el-color-warning-light-9); border-radius: var(--ph-radius-sm); }.approval pre { white-space: pre-wrap; max-height: 150px; overflow: auto; }.activity { padding: 0 20px; max-height: 160px; overflow: auto; font-size: 12px; }
.manage-panel,.settings-list { padding: 20px; border: 1px solid var(--ph-line); border-radius: var(--ph-radius-md); background: var(--ph-panel); }.manage-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 20px 0; }.manage-actions .el-button { margin-left: 0; }.service-output { min-height: 300px; max-height: 60vh; overflow: auto; background: var(--ph-term-bg); color: var(--ph-term-fg); padding: 18px; border-radius: var(--ph-radius-sm); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.7; }.settings-row { display: flex; align-items: center; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--ph-line); }.settings-row > div { flex: 1; }.settings-row:last-child { border-bottom: 0; }.form-tip { margin: 6px 0 0; line-height: 1.6; }
@media (max-width:1100px) { .claw-page { padding: 20px; }.chat-layout { grid-template-columns: 190px minmax(0,1fr); } }
</style>
