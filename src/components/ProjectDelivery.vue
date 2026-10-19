<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from './PageHeader.vue'
import { imageProjectName, releaseDate, repositoryNamespaces } from '../utils/delivery'
import type { BuildTarget, Project, ProjectModule } from '../types'
import type { DeployConfig, HostProfile, RegistryProfile, ReleaseAction, ReleaseJob } from '../types/deployment'

const props = defineProps<{ projectId?: string; embedded?: boolean; targets?: BuildTarget[] }>()
const emit = defineEmits<{ 'targets-changed': [] }>()
const modules = ref<ProjectModule[]>([]), moduleDirectory = ref(''), scanningModules = ref(false)
const selectedModule = computed(() => modules.value.find(module => module.directory === moduleDirectory.value))
async function scanModules() {
  if (!projectId.value) return
  scanningModules.value = true
  try { modules.value = await window.api.project.modules(projectId.value) }
  catch (error) { ElMessage.error((error as Error).message) }
  finally { scanningModules.value = false }
}
async function selectModule(directory: string) {
  if (!directory) { config.value.dockerfile = 'Dockerfile'; config.value.buildContext = '.'; config.value.buildTargetId = ''; return }
  const module = modules.value.find(item => item.directory === directory)
  if (!module) return
  config.value.dockerfile = module.dockerfiles.length === 1 ? module.dockerfiles[0] : ''
  config.value.buildContext = directory
  config.value.buildTargetId = ''
  if (!module.target.commands.length) return
  await execute('选择子项目', async () => {
    const targets = await window.api.project.buildTargets(projectId.value)
    const existing = targets.find(target => target.id === module.target.id)
    if (!existing) { targets.push(module.target); await window.api.project.saveBuildTargets(projectId.value, JSON.parse(JSON.stringify(targets))) }
    buildTargets.value = targets
    config.value.buildTargetId = module.target.id
    emit('targets-changed')
  })
}
function selectDockerfile(file: string) {
  config.value.buildContext = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.'
}
const buildTargets = ref<BuildTarget[]>([])
const api = window.api.deployment
const bridgeReady = ref(!!api && typeof api.registries === 'function')
const loadingConfig = ref(false)
const route = useRoute()
const router = useRouter()
function manageConnections() { void router.push({ path: '/settings', query: { section: 'delivery' } }) }
const busy = ref(''), projects = ref<Project[]>([]), projectId = ref('')
const registries = ref<RegistryProfile[]>([]), hosts = ref<HostProfile[]>([]), jobs = ref<ReleaseJob[]>([])
const selectedJobId = ref(''), helpDialog = ref(false)
const releaseTab = ref('docker')
function releaseTag(): string { return releaseDate() }
function defaults(id: string): DeployConfig {
  return { projectId: id, registryId: '', hostId: '', repository: '', tag: releaseTag(), dockerfile: 'Dockerfile', platform: 'linux/amd64', remoteDir: '/opt/myapp', composeFile: 'compose.yaml', service: 'app', composeProject: 'myapp' }
}
const config = ref<DeployConfig>(defaults(''))
const namespaces = ref<string[]>([]), namespaceLoading = ref(false), namespaceWarning = ref('')
const namespace = computed({
  get: () => config.value.repository.includes('/') ? config.value.repository.slice(0, config.value.repository.lastIndexOf('/')) : '',
  set: (value: string) => { config.value.repository = `${value}/${repositoryLeaf.value || suggestedName.value}` }
})
const suggestedName = computed(() => imageProjectName(projects.value.find(p => p.id === projectId.value)?.name || ''))
const repositoryLeaf = computed({
  get: () => config.value.repository.split('/').at(-1) || '',
  set: (value: string) => { config.value.repository = namespace.value ? `${namespace.value}/${value}` : value }
})
const namespaceOptions = computed(() => [...new Set([...namespaces.value, ...(namespace.value ? [namespace.value] : [])])])
let namespaceRequest = 0
async function loadNamespaces(): Promise<void> {
  const id = config.value.registryId, project = projectId.value, request = ++namespaceRequest
  namespaces.value = []; namespaceWarning.value = ''
  if (!id || loadingConfig.value) { namespaceLoading.value = false; return }
  namespaceLoading.value = true
  try {
    const result = await api.registryCatalog(id)
    if (request !== namespaceRequest || config.value.registryId !== id || projectId.value !== project) return
    namespaces.value = result.namespaces || repositoryNamespaces(result.repositories)
    namespaceWarning.value = result.warning || (result.mode === 'tracked' ? result.notice : '') || (!namespaces.value.length ? '仓库未返回可用命名空间，可手动输入；空命名空间可能尚无镜像，需先在仓库控制台确认。' : '')
    if (!namespace.value && namespaces.value.length === 1) namespace.value = namespaces.value[0]
  } catch (error) {
    if (request === namespaceRequest) namespaceWarning.value = `命名空间读取失败：${String(error)}。可手动输入后继续。`
  } finally { if (request === namespaceRequest) namespaceLoading.value = false }
}
watch([() => config.value.registryId, loadingConfig], () => { void loadNamespaces() })
const portMode = computed({
  get: () => config.value.portMappings === undefined ? 'compose' : 'custom',
  set: (value: string) => { config.value.portMappings = value === 'compose' ? undefined : config.value.portMappings || [] }
})
function addPort(): void {
  config.value.portMappings ||= []
  config.value.portMappings.push({ hostPort: 8089, containerPort: 8080, hostIp: '0.0.0.0', protocol: 'tcp' })
}
function checkForm(action?: ReleaseAction): void {
  if (action !== 'deploy' && !config.value.dockerfile.trim()) throw new Error('请选择或填写 Dockerfile')
  if (!config.value.registryId) throw new Error('请选择镜像仓库连接')
  if (!namespace.value || !repositoryLeaf.value) throw new Error('请填写命名空间和镜像名称')
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/.test(config.value.repository)) throw new Error('镜像路径仅支持小写字母、数字及 . _ -，请检查命名空间和镜像名')
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(config.value.tag)) throw new Error('请填写有效镜像版本')
  if ((action === 'all' || action === 'deploy') && !config.value.hostId) throw new Error('请选择目标服务器')
}
async function saveConfig(): Promise<void> {
  await execute('保存配置', async () => { checkForm(); await api.saveConfig(JSON.parse(JSON.stringify(config.value))); ElMessage.success('发布配置已保存') })
}
const projectJobs = computed(() => jobs.value.filter(j => j.projectId === projectId.value))
const selectedJob = computed(() => jobs.value.find(j => j.id === selectedJobId.value) || projectJobs.value[0])
const pipelineStep = computed(() => {
  const job = selectedJob.value
  if (!job) return 0
  if (job.status === 'success') return job.action === 'build' ? 1 : ['push', 'buildPush'].includes(job.action) ? 2 : 3
  if (job.stage.includes('服务器') || job.log.includes('--- 服务器拉取')) return 2
  if (job.stage.includes('上传') || job.log.includes('--- 上传镜像')) return 1
  return 0
})
const running = computed(() => projectJobs.value.some(j => j.status === 'running'))
const image = computed(() => {
  const registry = registries.value.find(r => r.id === config.value.registryId)
  return registry ? `${registry.server}/${config.value.repository}:${config.value.tag}` : '请选择仓库并填写镜像路径'
})
const actions: Array<{ action: ReleaseAction; label: string }> = [{ action: 'build', label: '本地构建' }, { action: 'buildPush', label: '构建并上传' }, { action: 'push', label: '仅上传镜像' }, { action: 'deploy', label: '部署已有镜像' }, { action: 'all', label: '构建 → 上传 → 部署' }]
const visibleActions = computed(() => actions.filter(a => releaseTab.value === 'docker' ? ['build', 'buildPush', 'push'].includes(a.action) : ['deploy', 'all'].includes(a.action)))
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
  projectId.value = String(props.projectId || route.query.project || projects.value[0]?.id || '')
}))
onBeforeUnmount(() => unsubscribe?.())
let configRequest = 0
watch(() => props.targets, targets => { if (targets) buildTargets.value = targets }, { deep: true })
watch(() => props.projectId, id => { if (id) projectId.value = id })
watch(projectId, async id => {
  buildTargets.value = []; modules.value = []; moduleDirectory.value = ''
  const request = ++configRequest
  loadingConfig.value = true
  config.value = defaults(id)
  selectedJobId.value = ''
  try {
    const [saved, targets, detectedModules] = await Promise.all([
      id ? api.config(id) : Promise.resolve(null),
      id ? window.api.project.buildTargets(id) : Promise.resolve([]),
      id ? window.api.project.modules(id) : Promise.resolve([])
    ])
    if (request !== configRequest) return
    config.value = saved ? { ...defaults(id), ...saved } : defaults(id)
    if (!saved) {
      config.value.repository = suggestedName.value
      if (registries.value.length === 1) config.value.registryId = registries.value[0].id
      if (hosts.value.length === 1) config.value.hostId = hosts.value[0].id
      const name = suggestedName.value
      if (name) { config.value.remoteDir = `/opt/${name}`; config.value.composeProject = name.replace(/[.]/g, '-') }
    }
    buildTargets.value = props.targets || targets
    modules.value = detectedModules
    moduleDirectory.value = detectedModules.find(module => module.target.id === config.value.buildTargetId)?.directory || detectedModules.filter(module => config.value.dockerfile.startsWith(module.directory + '/')).sort((a, b) => b.directory.length - a.directory.length)[0]?.directory || ''
  }
  catch (error) { ElMessage.error(String(error)) }
  finally { if (request === configRequest) loadingConfig.value = false }
})
function agentContext(open = false) {
  window.dispatchEvent(new CustomEvent('project-hub:agent-context', { detail: { projectId: projectId.value, hostId: config.value.hostId, open } }))
}
watch([projectId, () => config.value.hostId], () => agentContext())
async function start(action: ReleaseAction): Promise<void> {
  await execute('启动发布', async () => {
    if (loadingConfig.value || config.value.projectId !== projectId.value) throw new Error('正在读取项目发布配置，请稍后再试')
    checkForm(action)
    const captured: DeployConfig = JSON.parse(JSON.stringify(config.value))
    if (action === 'buildPush' || action === 'all' || action === 'push') {
      // Never silently overwrite a dated release that is already in the registry.
      const tags = await api.registryTags(captured.registryId, captured.repository).catch(() => null)
      if (tags?.includes(captured.tag)) await ElMessageBox.confirm(`镜像版本 ${captured.tag} 已存在，上传将尝试覆盖该版本。建议改用新的版本号。`, '版本已存在', { confirmButtonText: '继续上传', cancelButtonText: '返回修改', type: 'warning' })
    }
    if (action === 'all' || action === 'deploy') {
      const host = hosts.value.find(h => h.id === captured.hostId)
      if (!host) throw new Error('请选择目标服务器')
      await ElMessageBox.confirm(`将 ${image.value} 部署到 ${host.name} (${host.host})，更新 Compose 服务 ${captured.composeProject}/${captured.service}。${captured.portMappings === undefined ? '保留 Compose 文件中的端口映射。' : '端口映射将替换为：' + (captured.portMappings.map(p => `${p.hostIp}:${p.hostPort} → ${p.containerPort}/${p.protocol}`).join('、') || '不向服务器发布端口') + '。'}单副本更新可能短暂中断。`, '确认部署', { confirmButtonText: '部署' })
    }
    await api.saveConfig(captured)
    selectedJobId.value = await api.start(captured.projectId, action)
    jobs.value = await api.jobs()
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
  <div class="delivery-page" :class="{ embedded: props.embedded }">
    <PageHeader v-if="!props.embedded" title="镜像与服务器" subtitle="本地打包、镜像上传、SSH 部署，在一个工作台完成"><template #actions><el-button @click="agentContext(true)"><el-icon><MagicStick /></el-icon>交给 Agent</el-button></template></PageHeader>
    <div v-if="!bridgeReady" class="bridge-recovery">
      <el-alert type="warning" :closable="false" title="需要完整重启 Project Hub" description="页面已更新，但当前 Electron 进程仍使用旧版镜像发布接口。请退出应用，并在开发终端按 Ctrl+C 停止旧的 npm run dev，再重新启动。仅刷新页面无法更新主进程。" show-icon />
      <p>在项目目录重新运行：</p>
      <pre class="console">npm run dev</pre>
      <p class="muted">重启后重新打开「镜像与服务器」。已有项目、仓库和服务器配置会保留。</p>
    </div>
    <div v-else>
        <div class="release-grid">
          <section class="panel">
            <div class="section-heading"><h3>发布配置</h3><el-button text @click="manageConnections">管理全局连接</el-button><el-button text @click="helpDialog = true">服务器准备说明</el-button></div>
            <el-form label-position="top" :disabled="!!busy || running || loadingConfig">
              <el-form-item v-if="!props.projectId" label="本地项目"><el-select v-model="projectId" filterable class="full"><el-option v-for="p in projects" :key="p.id" :value="p.id" :label="p.display_name || p.name" /></el-select></el-form-item>
              <p v-if="!projects.length" class="muted">先在项目管理的项目模块中添加本地项目。</p>
              <el-tabs v-model="releaseTab" class="release-tabs">
                <el-tab-pane label="Dockerfile 构建" name="docker" />
                <el-tab-pane label="服务器部署" name="server" />
              </el-tabs>
              <el-form-item label="镜像仓库连接（存放镜像的服务）"><el-select v-model="config.registryId" class="full" placeholder="选择全局镜像仓库" @visible-change="visible => { if (visible) execute('刷新连接', loadProfiles) }"><el-option v-for="r in registries" :key="r.id" :value="r.id" :label="`${r.name} · ${r.server}`" /></el-select></el-form-item>
              <p v-if="!registries.length" class="muted">尚未配置镜像仓库，请先在全局设置中添加连接。</p>
              <div class="two-columns">
                <el-form-item label="命名空间（账号或组织）" required>
                  <el-select v-model="namespace" class="full" filterable allow-create default-first-option :loading="namespaceLoading" placeholder="选择或输入，如 anpengyu"><el-option v-for="item in namespaceOptions" :key="item" :label="item" :value="item" /></el-select>
                  <el-button link type="primary" :disabled="!config.registryId || namespaceLoading" @click="loadNamespaces">刷新命名空间</el-button>
                </el-form-item>
                <el-form-item label="镜像名称（默认项目名）" required><el-input v-model="repositoryLeaf" :placeholder="suggestedName || '例如 qianchuan'" /></el-form-item>
              </div>
              <el-alert v-if="namespaceWarning" :title="namespaceWarning" type="warning" :closable="false" show-icon />
              <el-form-item label="命名空间/仓库"><el-input :model-value="config.repository" readonly /></el-form-item>
              <el-form-item label="镜像版本" required><el-input v-model="config.tag" placeholder="例如 20261015"><template #append><el-button @click="config.tag = releaseTag()">今天日期</el-button></template></el-input></el-form-item>
              <div v-show="releaseTab === 'docker'">
              <el-form-item label="构建子项目"><div class="module-picker"><el-select v-model="moduleDirectory" filterable clearable class="full" placeholder="项目根目录；或选择子项目" @change="selectModule"><el-option v-for="module in modules" :key="module.directory" :value="module.directory" :label="`${module.directory} · ${module.type}`" /></el-select><el-button :loading="scanningModules" @click="scanModules">扫描子项目</el-button></div></el-form-item>
              <el-form-item label="构建前准备"><el-radio-group :model-value="config.buildTargetId ? 'project' : 'docker'" @change="value => config.buildTargetId = value === 'project' ? buildTargets[0]?.id || '' : ''"><el-radio-button value="docker">直接使用 Dockerfile</el-radio-button><el-radio-button value="project" :disabled="!buildTargets.length">先执行项目构建</el-radio-button></el-radio-group></el-form-item>
              <el-form-item v-if="config.buildTargetId" label="先执行的项目构建目标"><el-select v-model="config.buildTargetId" class="full"><el-option v-for="target in buildTargets" :key="target.id" :value="target.id" :label="`${target.name} · ${target.directory}`" /></el-select><p class="muted">项目构建成功后，使用 Dockerfile 将产物打包为镜像；任一步失败都会停止发布。</p></el-form-item>
              <div class="two-columns"><el-form-item label="Dockerfile（项目内相对路径）"><el-select v-model="config.dockerfile" filterable allow-create default-first-option class="full" placeholder="选择或输入 Dockerfile 路径" @change="selectDockerfile"><el-option v-for="file in selectedModule?.dockerfiles || []" :key="file" :value="file" :label="file" /></el-select></el-form-item><el-form-item label="服务器架构"><el-select v-model="config.platform" class="full"><el-option label="x86 / amd64" value="linux/amd64" /><el-option label="ARM64" value="linux/arm64" /></el-select></el-form-item></div>
              <el-form-item label="构建目录（项目内相对路径）"><el-input v-model="config.buildContext" placeholder="留空使用 Dockerfile 所在目录，例如 server；填 . 使用项目根目录" /></el-form-item>
              <p class="muted">COPY 文件从构建目录读取；嵌套项目可选择后端目录，使用该目录内的 .dockerignore。</p>
              </div>
              <div v-show="releaseTab === 'server'">
              <el-divider>Docker Compose 部署配置</el-divider>
              <el-form-item label="目标服务器"><el-select v-model="config.hostId" clearable class="full" placeholder="选择要运行应用的服务器" @visible-change="visible => { if (visible) execute('刷新连接', loadProfiles) }"><el-option v-for="h in hosts" :key="h.id" :value="h.id" :label="`${h.name} · ${h.host}`" /></el-select></el-form-item>
              <p v-if="!hosts.length" class="muted">尚未配置服务器，请在全局设置中添加连接。</p>
              <div class="two-columns"><el-form-item label="服务器部署目录"><el-input v-model="config.remoteDir" /></el-form-item><el-form-item label="Compose 文件"><el-input v-model="config.composeFile" /></el-form-item></div>
              <div class="two-columns"><el-form-item label="Compose 项目名"><el-input v-model="config.composeProject" /></el-form-item><el-form-item label="应用服务名"><el-input v-model="config.service" /></el-form-item></div>
              <el-form-item label="端口映射方式"><el-radio-group v-model="portMode"><el-radio-button value="compose">使用服务器 Compose 配置</el-radio-button><el-radio-button value="custom">在此设置端口映射</el-radio-button></el-radio-group></el-form-item>
              <template v-if="portMode === 'custom'">
                <p class="muted">以下列表替换该服务全部端口映射（Compose 需 ≥ 2.24.4）。服务器端口如 8089；容器端口需与 server 实际监听端口一致。空列表表示不对外发布端口。</p>
                <div v-for="(port, index) in config.portMappings" :key="index" class="port-row">
                  <el-form-item label="服务器端口"><el-input-number v-model="port.hostPort" :min="1" :max="65535" controls-position="right" /></el-form-item>
                  <el-form-item label="容器端口"><el-input-number v-model="port.containerPort" :min="1" :max="65535" controls-position="right" /></el-form-item>
                  <el-form-item label="访问范围"><el-select v-model="port.hostIp"><el-option label="所有网卡（对外）" value="0.0.0.0" /><el-option label="仅服务器本机" value="127.0.0.1" /></el-select></el-form-item>
                  <el-form-item label="协议"><el-select v-model="port.protocol"><el-option label="TCP" value="tcp" /><el-option label="UDP" value="udp" /></el-select></el-form-item>
                  <el-button text type="danger" @click="config.portMappings?.splice(index, 1)">移除</el-button>
                </div>
                <el-button :disabled="(config.portMappings?.length || 0) >= 32" @click="addPort">添加端口映射</el-button>
                <p class="muted">例如千川 server 监听 8080，服务器对外使用 8089，则填 8089 → 8080。应用在容器内需监听 0.0.0.0；对外访问还需服务器防火墙或安全组放行该端口。</p>
              </template>

              </div>
              <el-button :disabled="!projectId || loadingConfig" @click="saveConfig">保存配置</el-button>
            </el-form>
          </section>
          <section class="panel">
            <h3>{{ releaseTab === 'docker' ? '构建与上传镜像' : '部署到服务器' }}</h3><el-steps :active="pipelineStep" :process-status="selectedJob?.status === 'failed' ? 'error' : 'process'" finish-status="success" simple><el-step title="构建" /><el-step title="上传仓库" /><el-step title="拉取部署" /></el-steps><p class="image-ref">{{ image }}</p>
            <p class="muted">{{ releaseTab === 'docker' ? '直接构建适合在 Dockerfile 中完成编译的项目；先执行项目构建适合需要提前生成 dist 等产物的项目。上传只负责存储镜像，不会启动应用。' : '服务器部署只拉取并运行已有镜像；完整发布会先在本机构建、上传，再更新服务器。Compose 需使用 APP_IMAGE 并配置健康检查。' }}</p>
            <div class="action-row"><el-button v-for="a in visibleActions" :key="a.action" :type="a.action === 'all' ? 'primary' : 'default'" :disabled="!projectId || !!busy || running || loadingConfig" @click="start(a.action)">{{ a.label }}</el-button></div>
            <el-alert v-if="running" type="info" :closable="false" title="发布正在执行，完成前请保持应用打开。项目构建实时显示日志，镜像与部署输出在步骤结束后显示。" />
            <el-select v-model="selectedJobId" placeholder="发布记录" class="full history-select"><el-option v-for="j in projectJobs" :key="j.id" :value="j.id" :label="`${new Date(j.startedAt).toLocaleString()} · ${statusLabels[j.status]} · ${j.image}`" /></el-select>
            <template v-if="selectedJob"><div class="job-status"><el-tag :type="selectedJob.status === 'success' ? 'success' : selectedJob.status === 'running' ? 'primary' : 'danger'">{{ statusLabels[selectedJob.status] }}</el-tag><span>{{ selectedJob.stage }}</span></div><pre class="console">{{ selectedJob.log || '任务准备中…' }}</pre></template>
            <div v-else class="empty-state">保存配置后，选择单步操作或完整发布。</div>
          </section>
        </div>
    </div>

    <el-dialog v-model="helpDialog" title="首次部署准备" width="720"><p>服务器安装 Docker Engine、Compose v2、bash 和 flock。SSH 用户需要操作 Docker 的权限。创建部署目录，把 compose.yaml 和 runtime.env 放入目录；环境变量、数据库和上传文件保留在服务器。</p><p>Compose 应用的 image 使用 APP_IMAGE，应用必须有健康检查。下例假设镜像含 wget、监听 8080 并提供 /health；按实际项目调整。</p><pre class="console">{{ composeExample }}</pre><p>部署时自动临时登录仓库，拉取指定镜像、更新应用并检查健康；失败尝试恢复原镜像。初次部署没有旧版本可回滚。镜像回滚不能撤销数据库迁移；发布可能短暂中断。</p><p>自定义端口映射要求服务器 Docker Compose ≥ 2.24.4。映射会替换所选服务的全部端口，成功后保存为部署目录下的 .project-hub-项目名-ports.yaml；原 Compose 文件不改动。手动使用 Compose 运维时，应通过第二个 -f 参数一并加载此文件。切回「使用服务器 Compose 配置」并部署成功后，会移除此映射文件。</p><p>本地需要 Docker Desktop 运行 Linux 容器。Dockerfile 和 .dockerignore 由项目提供，构建前请先完成项目测试。</p></el-dialog>
  </div>
</template>

<style scoped>
.module-picker { display: flex; width: 100%; gap: 10px; }
.delivery-page.embedded { height: auto; padding: 0; overflow: visible; }
.delivery-page { height: 100%; overflow: auto; padding: 28px; box-sizing: border-box; }
.bridge-recovery { max-width: 820px; margin-top: 24px; }
.release-grid { display: grid; grid-template-columns: minmax(330px, 1fr) minmax(350px, 1.15fr); gap: 20px; align-items: start; }
.panel { border: 1px solid var(--el-border-color); background: var(--el-bg-color); padding: 22px; border-radius: 14px; min-width: 0; }
h3 { margin: 0 0 16px; font-size: 15px; } .section-heading, .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
.section-heading h3 { margin: 0; } .two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; } .full { width: 100%; }
.port-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.port-row .el-form-item { flex: 1 1 110px; min-width: 0; }
.port-row .el-input-number, .port-row .el-select { width: 100%; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; } .image-ref { overflow-wrap: anywhere; padding: 14px; background: var(--el-fill-color-light); border-radius: 8px; font-family: monospace; }
.action-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0; } .action-row .el-button { margin: 0; } .history-select { margin: 16px 0; } .job-status { display: flex; gap: 12px; align-items: center; font-size: 13px; }
.console, .metrics { white-space: pre-wrap; overflow-wrap: anywhere; background: #101827; color: #d7e4f4; border-radius: 10px; padding: 16px; font: 12px/1.7 Consolas, monospace; max-height: 440px; overflow: auto; }
.empty-state { color: var(--el-text-color-secondary); text-align: center; padding: 80px 16px; } .host-picker { justify-content: flex-start; margin-top: 24px; }
@media (max-width: 1150px) { .release-grid { grid-template-columns: 1fr; } }
</style>
