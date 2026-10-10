<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '../components/PageHeader.vue'
import type { Project } from '../types'
import type { DeployConfig, HostInput, HostProfile, RegistryInput, RegistryProfile, ReleaseAction, ReleaseJob, RemoteAction, RemoteSnapshot } from '../types/deployment'

const api = window.api.deployment
const bridgeReady = ref(!!api && typeof api.registries === 'function')
const loadingConfig = ref(false)
const route = useRoute()
const tab = ref('release'), busy = ref(''), projects = ref<Project[]>([]), projectId = ref('')
const registries = ref<RegistryProfile[]>([]), hosts = ref<HostProfile[]>([]), jobs = ref<ReleaseJob[]>([])
const selectedJobId = ref(''), selectedHostId = ref(''), snapshot = ref<RemoteSnapshot | null>(null), remoteLog = ref(''), imageToPull = ref('')
const registryDialog = ref(false), hostDialog = ref(false), helpDialog = ref(false)
const registryForm = ref<RegistryInput>({ id: '', name: '', server: '', username: '', password: '' })
const hostForm = ref<HostInput>({ id: '', name: '', host: '', port: 22, username: '', authKind: 'privateKey', fingerprint: '', privateKey: '', passphrase: '', password: '' })
function releaseTag(): string { return 'release-' + new Date().toISOString().replace(/[-:.TZ]/g, '') }
function defaults(id: string): DeployConfig {
  return { projectId: id, registryId: '', hostId: '', repository: '', tag: releaseTag(), dockerfile: 'Dockerfile', platform: 'linux/amd64', remoteDir: '/opt/myapp', composeFile: 'compose.yaml', service: 'app', composeProject: 'myapp' }
}
const config = ref<DeployConfig>(defaults(''))
const projectJobs = computed(() => jobs.value.filter(j => j.projectId === projectId.value))
const selectedJob = computed(() => jobs.value.find(j => j.id === selectedJobId.value) || projectJobs.value[0])
const running = computed(() => projectJobs.value.some(j => j.status === 'running'))
const image = computed(() => {
  const registry = registries.value.find(r => r.id === config.value.registryId)
  return registry ? `${registry.server}/${config.value.repository}:${config.value.tag}` : '请选择仓库并填写镜像路径'
})
const actions: Array<{ action: ReleaseAction; label: string }> = [{ action: 'build', label: '本地构建' }, { action: 'push', label: '上传镜像' }, { action: 'deploy', label: '服务器部署' }, { action: 'all', label: '构建 → 上传 → 部署' }]
const statusLabels = { running: '执行中', success: '成功', failed: '失败', interrupted: '中断，需检查服务器' }
async function execute(name: string, fn: () => Promise<void>): Promise<void> {
  if (!bridgeReady.value) return
  if (busy.value) return
  busy.value = name
  try { await fn() } catch (error) {
    if (String(error).includes('No handler registered') && String(error).includes('deployment:')) {
      bridgeReady.value = false
      return
    }
    if (error !== 'cancel' && error !== 'close') ElMessage.error(String(error instanceof Error ? error.message : error))
  } finally { busy.value = '' }
}
async function loadProfiles(): Promise<void> {
  [registries.value, hosts.value] = await Promise.all([api.registries(), api.hosts()])
}
let unsubscribe: (() => void) | undefined
onMounted(() => execute('加载', async () => {
  await loadProfiles()
  projects.value = await window.api.project.list()
  jobs.value = await api.jobs()
  unsubscribe = api.onJob(job => { jobs.value = [job, ...jobs.value.filter(j => j.id !== job.id)].slice(0, 100) })
  projectId.value = String(route.query.project || projects.value[0]?.id || '')
  selectedHostId.value = hosts.value[0]?.id || ''
}))
onBeforeUnmount(() => unsubscribe?.())
let configRequest = 0
watch(projectId, async id => {
  const request = ++configRequest
  loadingConfig.value = true
  config.value = defaults(id)
  selectedJobId.value = ''
  try { const saved = id ? await api.config(id) : null; if (request === configRequest) config.value = saved || defaults(id) }
  catch (error) { ElMessage.error(String(error)) }
  finally { if (request === configRequest) loadingConfig.value = false }
})
function agentContext(open = false) {
  window.dispatchEvent(new CustomEvent('project-hub:agent-context', { detail: { projectId: projectId.value, hostId: tab.value === 'hosts' ? selectedHostId.value : config.value.hostId, open } }))
}
watch([projectId, selectedHostId, tab, () => config.value.hostId], () => agentContext())
watch(selectedHostId, () => { snapshot.value = null; remoteLog.value = '' })
function editRegistry(id?: string): void {
  const profile = registries.value.find(r => r.id === id)
  registryForm.value = profile ? { id: profile.id, name: profile.name, server: profile.server, username: profile.username, password: '' } : { id: '', name: '', server: '', username: '', password: '' }
  registryDialog.value = true
}
function editHost(id?: string): void {
  const profile = hosts.value.find(h => h.id === id)
  hostForm.value = profile ? { id: profile.id, name: profile.name, host: profile.host, port: profile.port, username: profile.username, authKind: profile.authKind, fingerprint: profile.fingerprint, password: '', privateKey: '', passphrase: '' } : { id: '', name: '', host: '', port: 22, username: '', authKind: 'privateKey', fingerprint: '', password: '', privateKey: '', passphrase: '' }
  hostDialog.value = true
}
async function saveRegistry(): Promise<void> {
  await execute('保存仓库', async () => { await api.saveRegistry({ ...registryForm.value }); registryDialog.value = false; registryForm.value.password = ''; await loadProfiles(); ElMessage.success('仓库凭据已加密保存') })
}
async function saveHost(): Promise<void> {
  await execute('保存主机', async () => { await api.saveHost({ ...hostForm.value }); hostDialog.value = false; hostForm.value.password = ''; hostForm.value.privateKey = ''; hostForm.value.passphrase = ''; await loadProfiles(); ElMessage.success('主机已保存') })
}
async function checkFingerprint(): Promise<void> {
  await execute('获取指纹', async () => {
    const fingerprint = await api.fingerprint(hostForm.value.host, hostForm.value.port)
    await ElMessageBox.confirm(`收到主机指纹：\n${fingerprint}\n请通过腾讯云控制台或可信终端独立核对。确认与真实服务器一致后才保存。`, '核对 SSH 主机身份', { confirmButtonText: '已独立核对，一致', cancelButtonText: '暂不信任' })
    hostForm.value.fingerprint = fingerprint
  })
}
async function removeProfile(kind: 'host' | 'registry', id: string): Promise<void> {
  await execute('删除配置', async () => { await ElMessageBox.confirm('删除配置及其加密凭据？不会删除服务器或仓库。', '删除配置'); kind === 'host' ? await api.removeHost(id) : await api.removeRegistry(id); await loadProfiles() })
}
async function start(action: ReleaseAction): Promise<void> {
  await execute('启动发布', async () => {
    if (loadingConfig.value || config.value.projectId !== projectId.value) throw new Error('正在读取项目发布配置，请稍后再试')
    const captured = { ...config.value }
    if (action === 'all' || action === 'deploy') {
      const host = hosts.value.find(h => h.id === captured.hostId)
      if (!host) throw new Error('请选择目标服务器')
      await ElMessageBox.confirm(`将 ${image.value} 部署到 ${host.name} (${host.host})，更新 Compose 服务 ${captured.composeProject}/${captured.service}。单副本更新可能短暂中断。`, '确认部署', { confirmButtonText: '部署' })
    }
    await api.saveConfig(captured)
    selectedJobId.value = await api.start(captured.projectId, action)
    jobs.value = await api.jobs()
  })
}
async function refreshHost(): Promise<void> {
  const id = selectedHostId.value
  const next = await api.snapshot(id)
  if (id === selectedHostId.value) snapshot.value = next
}
async function control(request: RemoteAction): Promise<void> {
  const id = selectedHostId.value
  await execute('远端操作', async () => {
    if (request.kind !== 'logs') await ElMessageBox.confirm(`在 ${hosts.value.find(h => h.id === id)?.name} 执行 ${request.action}：${request.target}？`, '确认服务器操作')
    const output = await api.remoteAction(id, request)
    if (id !== selectedHostId.value) return
    remoteLog.value = output || '操作完成'
    if (request.kind !== 'logs') await refreshHost()
  })
}
const composeExample = `name: myapp
services:
  app:
    image: \${APP_IMAGE:?APP_IMAGE required}
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    env_file:
      - runtime.env
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:8080/health"]
      interval: 10s
      timeout: 3s
      retries: 6
      start_period: 30s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"`
</script>

<template>
  <div class="delivery-page">
    <PageHeader title="镜像与服务器" subtitle="本地打包、镜像上传、SSH 部署，在一个工作台完成"><template #actions><el-button @click="agentContext(true)"><el-icon><MagicStick /></el-icon>交给 Agent</el-button></template></PageHeader>
    <div v-if="!bridgeReady" class="bridge-recovery">
      <el-alert type="warning" :closable="false" title="需要完整重启 Project Hub" description="页面已更新，但当前 Electron 进程仍使用旧版镜像发布接口。请退出应用，并在开发终端按 Ctrl+C 停止旧的 npm run dev，再重新启动。仅刷新页面无法更新主进程。" show-icon />
      <p>在项目目录重新运行：</p>
      <pre class="console">npm run dev</pre>
      <p class="muted">重启后重新打开「镜像与服务器」。已有项目、仓库和服务器配置会保留。</p>
    </div>
    <el-tabs v-else v-model="tab">
      <el-tab-pane label="项目发布" name="release">
        <div class="release-grid">
          <section class="panel">
            <div class="section-heading"><h3>发布配置</h3><el-button text @click="helpDialog = true">服务器准备说明</el-button></div>
            <el-form label-position="top" :disabled="!!busy || running">
              <el-form-item label="本地项目"><el-select v-model="projectId" filterable class="full"><el-option v-for="p in projects" :key="p.id" :value="p.id" :label="p.display_name || p.name" /></el-select></el-form-item>
              <p v-if="!projects.length" class="muted">先在项目管理的项目模块中添加本地项目。</p>
              <el-form-item label="镜像仓库"><el-select v-model="config.registryId" class="full" placeholder="先在仓库账号页添加"><el-option v-for="r in registries" :key="r.id" :value="r.id" :label="`${r.name} · ${r.server}`" /></el-select></el-form-item>
              <div class="two-columns"><el-form-item label="命名空间/仓库"><el-input v-model="config.repository" placeholder="personal/myapp" /></el-form-item><el-form-item label="镜像版本"><el-input v-model="config.tag"><template #append><el-button @click="config.tag = releaseTag()">新版本</el-button></template></el-input></el-form-item></div>
              <div class="two-columns"><el-form-item label="Dockerfile（项目内相对路径）"><el-input v-model="config.dockerfile" /></el-form-item><el-form-item label="服务器架构"><el-select v-model="config.platform" class="full"><el-option label="x86 / amd64" value="linux/amd64" /><el-option label="ARM64" value="linux/arm64" /></el-select></el-form-item></div>
              <el-form-item label="构建目录（项目内相对路径）"><el-input v-model="config.buildContext" placeholder="留空使用 Dockerfile 所在目录，例如 server；填 . 使用项目根目录" /></el-form-item>
              <p class="muted">COPY 文件从构建目录读取；嵌套项目可选择后端目录，使用该目录内的 .dockerignore。</p>
              <el-divider>服务器部署</el-divider>
              <el-form-item label="目标服务器"><el-select v-model="config.hostId" clearable class="full" placeholder="仅构建/上传可以不选"><el-option v-for="h in hosts" :key="h.id" :value="h.id" :label="`${h.name} · ${h.host}`" /></el-select></el-form-item>
              <div class="two-columns"><el-form-item label="服务器部署目录"><el-input v-model="config.remoteDir" /></el-form-item><el-form-item label="Compose 文件"><el-input v-model="config.composeFile" /></el-form-item></div>
              <div class="two-columns"><el-form-item label="Compose 项目名"><el-input v-model="config.composeProject" /></el-form-item><el-form-item label="应用服务名"><el-input v-model="config.service" /></el-form-item></div>
              <el-button :disabled="!projectId" @click="execute('保存配置', async () => { await api.saveConfig({ ...config }); ElMessage.success('发布配置已保存') })">保存配置</el-button>
            </el-form>
          </section>
          <section class="panel">
            <h3>发布流水线</h3><p class="image-ref">{{ image }}</p>
            <p class="muted">上传会使用当前标签；每次发布建议生成新版本。服务器 Compose 需使用 APP_IMAGE 并配置健康检查。</p>
            <div class="action-row"><el-button v-for="a in actions" :key="a.action" :type="a.action === 'all' ? 'primary' : 'default'" :disabled="!projectId || !!busy || running" @click="start(a.action)">{{ a.label }}</el-button></div>
            <el-alert v-if="running" type="info" :closable="false" title="发布正在执行，完成前请保持应用打开。输出在各步骤结束后显示。" />
            <el-select v-model="selectedJobId" placeholder="发布记录" class="full history-select"><el-option v-for="j in projectJobs" :key="j.id" :value="j.id" :label="`${new Date(j.startedAt).toLocaleString()} · ${statusLabels[j.status]} · ${j.image}`" /></el-select>
            <template v-if="selectedJob"><div class="job-status"><el-tag :type="selectedJob.status === 'success' ? 'success' : selectedJob.status === 'running' ? 'primary' : 'danger'">{{ statusLabels[selectedJob.status] }}</el-tag><span>{{ selectedJob.stage }}</span></div><pre class="console">{{ selectedJob.log || '任务准备中…' }}</pre></template>
            <div v-else class="empty-state">保存配置后，选择单步操作或完整发布。</div>
          </section>
        </div>
      </el-tab-pane>
      <el-tab-pane label="仓库账号" name="registries">
        <div class="toolbar"><p class="muted">填写阿里云控制台提供的 Docker 仓库登录地址，支持其他兼容 Docker 的仓库。</p><el-button type="primary" @click="editRegistry()">添加仓库</el-button></div>
        <el-table :data="registries" empty-text="还没有镜像仓库账号"><el-table-column prop="name" label="名称" /><el-table-column prop="server" label="仓库地址" /><el-table-column prop="username" label="用户名" /><el-table-column label="操作" width="250"><template #default="{ row }"><el-button text :disabled="!!busy" @click="execute('登录测试', async () => { ElMessage.success(await api.testRegistry(row.id)) })">登录测试</el-button><el-button text @click="editRegistry(row.id)">编辑</el-button><el-button text type="danger" @click="removeProfile('registry', row.id)">删除</el-button></template></el-table-column></el-table>
      </el-tab-pane>
      <el-tab-pane label="服务器 · Bridgebox" name="hosts">
        <div class="toolbar"><p class="muted">通过 SSH 管理 Linux 主机，无需安装服务器 Agent。</p><div><el-button :disabled="!!busy" @click="execute('导入主机', async () => { const n = await api.importBridgebox(); await loadProfiles(); ElMessage.success(`导入 ${n} 台主机，请重新填写凭据并核对指纹`) })">导入 Bridgebox</el-button><el-button type="primary" @click="editHost()">添加服务器</el-button></div></div>
        <el-table :data="hosts" empty-text="添加腾讯云服务器或导入 Bridgebox 主机"><el-table-column prop="name" label="名称" /><el-table-column prop="host" label="地址" /><el-table-column prop="username" label="用户" /><el-table-column label="身份核验"><template #default="{ row }"><el-tag :type="row.fingerprint && row.hasCredential ? 'success' : 'warning'">{{ row.fingerprint && row.hasCredential ? '已配置' : '待补凭据/指纹' }}</el-tag></template></el-table-column><el-table-column label="操作" width="240"><template #default="{ row }"><el-button text :disabled="!!busy" @click="execute('连接测试', async () => { remoteLog = await api.testHost(row.id); selectedHostId = row.id; ElMessage.success('SSH / Docker 连接成功') })">测试</el-button><el-button text @click="editHost(row.id)">编辑</el-button><el-button text type="danger" @click="removeProfile('host', row.id)">删除</el-button></template></el-table-column></el-table>
        <div class="toolbar host-picker"><el-select v-model="selectedHostId" placeholder="选择管理主机"><el-option v-for="h in hosts" :key="h.id" :value="h.id" :label="h.name" /></el-select><el-button :disabled="!selectedHostId || !!busy" :loading="busy === '刷新服务器'" @click="execute('刷新服务器', refreshHost)">刷新指标与服务</el-button></div>
        <template v-if="snapshot">
          <pre class="metrics">{{ snapshot.metrics }}</pre>
          <h3>Docker 容器</h3><el-table :data="snapshot.containers"><el-table-column prop="Names" label="名称" /><el-table-column prop="Image" label="镜像" /><el-table-column prop="Status" label="状态" /><el-table-column label="操作" width="320"><template #default="{ row }"><el-button v-for="action in ['start', 'stop', 'restart', 'rm']" :key="action" text :disabled="!!busy" @click="control({ kind: 'container', action, target: row.ID })">{{ { start: '启动', stop: '停止', restart: '重启', rm: '删除' }[action] }}</el-button><el-button text :disabled="!!busy" @click="control({ kind: 'logs', action: 'tail', target: row.ID })">日志</el-button></template></el-table-column></el-table>
          <h3>Docker 镜像</h3><div class="toolbar"><el-input v-model="imageToPull" placeholder="完整镜像引用，手动拉取私有镜像需服务器已有登录凭据" /><el-button :disabled="!!busy || !imageToPull" @click="control({ kind: 'image', action: 'pull', target: imageToPull })">拉取</el-button></div><el-table :data="snapshot.images"><el-table-column prop="Repository" label="仓库" /><el-table-column prop="Tag" label="标签" /><el-table-column prop="Size" label="大小" /><el-table-column label="操作" width="100"><template #default="{ row }"><el-button text type="danger" :disabled="!!busy" @click="control({ kind: 'image', action: 'rmi', target: row.ID })">删除</el-button></template></el-table-column></el-table>
          <h3>systemd 服务</h3><el-table :data="snapshot.services" max-height="320" empty-text="此主机没有可用的 systemd 服务列表"><el-table-column prop="name" label="服务" /><el-table-column prop="active" label="状态" /><el-table-column prop="description" label="说明" /><el-table-column label="操作" width="240"><template #default="{ row }"><el-button v-for="action in ['start', 'stop', 'restart']" :key="action" text :disabled="!!busy" @click="control({ kind: 'service', action, target: row.name })">{{ { start: '启动', stop: '停止', restart: '重启' }[action] }}</el-button></template></el-table-column></el-table>
        </template>
        <pre v-if="remoteLog" class="console">{{ remoteLog }}</pre>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="registryDialog" title="镜像仓库登录" width="560" @closed="registryForm.password = ''"><el-form label-position="top"><el-form-item label="名称"><el-input v-model="registryForm.name" placeholder="阿里云个人仓库" /></el-form-item><el-form-item label="Docker 仓库地址（不含协议和路径）"><el-input v-model="registryForm.server" placeholder="复制控制台 docker login 的服务器地址" /></el-form-item><el-form-item label="登录用户名"><el-input v-model="registryForm.username" /></el-form-item><el-form-item label="仓库密码（编辑时留空保留）"><el-input v-model="registryForm.password" type="password" show-password autocomplete="new-password" /></el-form-item></el-form><p class="muted">使用系统加密存储，不写入项目代码；Docker 登录密码通过标准输入传递。</p><template #footer><el-button @click="registryDialog = false">取消</el-button><el-button type="primary" :loading="busy === '保存仓库'" @click="saveRegistry">保存</el-button></template></el-dialog>
    <el-dialog v-model="hostDialog" title="SSH 主机" width="620" @closed="hostForm.password = ''; hostForm.privateKey = ''; hostForm.passphrase = ''"><el-form label-position="top"><el-form-item label="名称"><el-input v-model="hostForm.name" /></el-form-item><div class="two-columns"><el-form-item label="地址"><el-input v-model="hostForm.host" /></el-form-item><el-form-item label="SSH 端口"><el-input-number v-model="hostForm.port" :min="1" :max="65535" /></el-form-item></div><el-form-item label="SSH 用户"><el-input v-model="hostForm.username" /></el-form-item><el-form-item label="登录方式"><el-radio-group v-model="hostForm.authKind"><el-radio-button value="privateKey">私钥</el-radio-button><el-radio-button value="password">密码</el-radio-button></el-radio-group></el-form-item><el-form-item v-if="hostForm.authKind === 'password'" label="密码（编辑时留空保留）"><el-input v-model="hostForm.password" type="password" show-password autocomplete="new-password" /></el-form-item><template v-else><el-form-item label="SSH 私钥（编辑时不导入则保留）"><el-button :disabled="!!busy" @click="execute('选择私钥', async () => { const key = await api.pickPrivateKey(); if (key) hostForm.privateKey = key })">{{ hostForm.privateKey ? '已选择私钥，重新选择' : '从本机选择私钥文件' }}</el-button></el-form-item><el-form-item label="私钥口令（随新私钥一起保存）"><el-input v-model="hostForm.passphrase" type="password" show-password /></el-form-item></template><el-form-item label="已核对的主机 SHA256 指纹"><el-input v-model="hostForm.fingerprint" placeholder="SHA256:..."><template #append><el-button :disabled="!!busy" @click="checkFingerprint">获取并核对</el-button></template></el-input></el-form-item></el-form><p class="muted">更换服务器地址后需重新核对指纹及输入凭据。Bridgebox 导入不迁移密码/私钥。</p><template #footer><el-button @click="hostDialog = false">取消</el-button><el-button type="primary" :loading="busy === '保存主机'" @click="saveHost">保存</el-button></template></el-dialog>
    <el-dialog v-model="helpDialog" title="首次部署准备" width="720"><p>服务器安装 Docker Engine、Compose v2、bash 和 flock。SSH 用户需要操作 Docker 的权限。创建部署目录，把 compose.yaml 和 runtime.env 放入目录；环境变量、数据库和上传文件保留在服务器。</p><p>Compose 应用的 image 使用 APP_IMAGE，应用必须有健康检查。下例假设镜像含 wget、监听 8080 并提供 /health；按实际项目调整。</p><pre class="console">{{ composeExample }}</pre><p>部署时自动临时登录仓库，拉取指定镜像、更新应用并检查健康；失败尝试恢复原镜像。初次部署没有旧版本可回滚。镜像回滚不能撤销数据库迁移；发布可能短暂中断。</p><p>本地需要 Docker Desktop 运行 Linux 容器。Dockerfile 和 .dockerignore 由项目提供，构建前请先完成项目测试。</p></el-dialog>
  </div>
</template>

<style scoped>
.delivery-page { height: 100%; overflow: auto; padding: 28px; box-sizing: border-box; }
.bridge-recovery { max-width: 820px; margin-top: 24px; }
.release-grid { display: grid; grid-template-columns: minmax(330px, 1fr) minmax(350px, 1.15fr); gap: 20px; align-items: start; }
.panel { border: 1px solid var(--el-border-color); background: var(--el-bg-color); padding: 22px; border-radius: 14px; min-width: 0; }
h3 { margin: 0 0 16px; font-size: 15px; } .section-heading, .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
.section-heading h3 { margin: 0; } .two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; } .full { width: 100%; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; } .image-ref { overflow-wrap: anywhere; padding: 14px; background: var(--el-fill-color-light); border-radius: 8px; font-family: monospace; }
.action-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0; } .action-row .el-button { margin: 0; } .history-select { margin: 16px 0; } .job-status { display: flex; gap: 12px; align-items: center; font-size: 13px; }
.console, .metrics { white-space: pre-wrap; overflow-wrap: anywhere; background: #101827; color: #d7e4f4; border-radius: 10px; padding: 16px; font: 12px/1.7 Consolas, monospace; max-height: 440px; overflow: auto; }
.empty-state { color: var(--el-text-color-secondary); text-align: center; padding: 80px 16px; } .host-picker { justify-content: flex-start; margin-top: 24px; }
@media (max-width: 1150px) { .release-grid { grid-template-columns: 1fr; } }
</style>
