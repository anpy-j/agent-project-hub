<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '../components/PageHeader.vue'
import type { HostProfile, RegistryProfile, RemoteAction, RemoteSnapshot } from '../types/deployment'

const router = useRouter(), api = window.api.deployment
const ready = ref(!!api?.registryCatalog), tab = ref('images'), serverTab = ref('docker')
const registries = ref<RegistryProfile[]>([]), hosts = ref<HostProfile[]>([])
const registryId = ref(''), hostId = ref(''), repositories = ref<string[]>([]), repository = ref(''), tags = ref<string[]>([])
const catalogNotice = ref(''), catalogMode = ref<'catalog' | 'tracked'>('catalog')
const catalogWarning = ref(''), registryError = ref(''), hostError = ref(''), output = ref(''), logTitle = ref(''), logVisible = ref(false)
const repositoryQuery = ref('')
function queryRepository() {
  const name = repositoryQuery.value.trim()
  if (name === repository.value) void refreshTags()
  else repository.value = name
}
const loadingCatalog = ref(false), loadingTags = ref(false), loadingHost = ref(false), actionBusy = ref(false)
const logTarget = ref('')
const snapshot = ref<RemoteSnapshot | null>(null), search = ref(''), imageToPull = ref('')
const pullDialog = ref(false), pullImage = ref(''), pullRegistryId = ref(''), pullHostId = ref('')
const updateRegistryId = ref('')
const updateDialog = ref(false), updateTargets = ref<Array<Record<string, string>>>([]), selectedTargets = ref<string[]>([])
const selectedHost = computed(() => hosts.value.find(host => host.id === hostId.value))
const selectedRegistry = computed(() => registries.value.find(registry => registry.id === registryId.value))
const filteredRepositories = computed(() => repositories.value.filter(name => name.toLowerCase().includes(search.value.toLowerCase())))
const runningCount = computed(() => snapshot.value?.containers.filter(container => container.State === 'running').length || 0)
const imageRef = (tag: string) => `${selectedRegistry.value?.server}/${repository.value}:${tag}`
const imageName = (row: Record<string, string>) => row.Repository && row.Repository !== '<none>' && row.Tag !== '<none>' ? `${row.Repository}:${row.Tag}` : ''
function settings() { void router.push({ path: '/settings', query: { section: 'delivery' } }) }
function errorMessage(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') }
let catalogRequest = 0, tagRequest = 0, hostRequest = 0
async function refreshCatalog() {
  const id = registryId.value, request = ++catalogRequest
  if (!id || !ready.value) return
  loadingCatalog.value = true; catalogWarning.value = ''; catalogNotice.value = ''; registryError.value = ''
  try {
    const result = await api.registryCatalog(id)
    if (request !== catalogRequest || id !== registryId.value) return
    repositories.value = result.repositories; catalogWarning.value = result.warning || ''; catalogNotice.value = result.notice || ''; catalogMode.value = result.mode || 'catalog'
    if (!repository.value && result.repositories.length) repository.value = result.repositories[0]
  } catch (error) { if (request === catalogRequest) registryError.value = errorMessage(error) }
  finally { if (request === catalogRequest) loadingCatalog.value = false }
}
async function refreshTags() {
  const id = registryId.value, name = repository.value.trim(), request = ++tagRequest
  tags.value = []; loadingTags.value = false; registryError.value = ''
  if (!id || !name || !ready.value) return
  loadingTags.value = true
  try { const result = await api.registryTags(id, name); if (request === tagRequest && id === registryId.value && name === repository.value.trim()) { tags.value = result; if (!repositories.value.includes(name)) repositories.value = [...repositories.value, name].sort() } }
  catch (error) { if (request === tagRequest) registryError.value = errorMessage(error) }
  finally { if (request === tagRequest) loadingTags.value = false }
}
async function refreshHost() {
  const id = hostId.value, scope = serverTab.value === 'docker' ? 'docker' : 'services', request = ++hostRequest
  snapshot.value = null; hostError.value = ''
  if (!id || !ready.value) return
  loadingHost.value = true
  try { const result = await api.snapshot(id, scope); if (request === hostRequest && id === hostId.value) snapshot.value = result }
  catch (error) { if (request === hostRequest) hostError.value = errorMessage(error) }
  finally { if (request === hostRequest) loadingHost.value = false }
}
watch(registryId, () => { ++tagRequest; tags.value = []; repository.value = ''; repositories.value = []; void refreshCatalog() })
watch(hostId, () => { logVisible.value = false; void refreshHost() })
watch(serverTab, () => { void refreshHost() })
watch(repository, name => { repositoryQuery.value = name; tags.value = []; ++tagRequest; void refreshTags() })
let loadingConnections = false
async function loadConnections() {
  if (!ready.value || loadingConnections || actionBusy.value) return
  loadingConnections = true
  try {
    const [globalRegistries, globalHosts] = await Promise.all([api.registries(), api.hosts()])
    registries.value = globalRegistries; hosts.value = globalHosts
    if (!globalRegistries.some(registry => registry.id === registryId.value)) registryId.value = globalRegistries[0]?.id || ''
    if (!globalHosts.some(host => host.id === hostId.value)) hostId.value = globalHosts[0]?.id || ''
  } catch (error) { registryError.value = errorMessage(error); if (registryError.value.includes('No handler registered')) ready.value = false }
  finally { loadingConnections = false }
}
onMounted(loadConnections)
async function operate(request: RemoteAction, title: string) {
  if (!hostId.value || actionBusy.value) return
  const id = hostId.value, host = selectedHost.value
  actionBusy.value = true
  if (request.kind === 'logs') logTarget.value = request.target
  try {
    if (request.kind !== 'logs') await ElMessageBox.confirm(`在 ${host?.name}（${host?.host}）${title}：${request.target}${request.action === 'rm' ? '。请先停止容器；挂载数据卷不会删除' : ''}？`, title, { type: request.action === 'rm' || request.action === 'rmi' ? 'warning' : 'info', confirmButtonText: '执行', cancelButtonText: '取消' })
    actionBusy.value = true; logTitle.value = title; output.value = '正在执行…'; logVisible.value = true
    output.value = await api.remoteAction(id, request) || '操作完成'
    if (request.kind !== 'logs') { ElMessage.success('操作完成'); await refreshHost() }
  } catch (error) { if (error !== 'cancel' && error !== 'close') { output.value = errorMessage(error); logTitle.value = title; logVisible.value = true } }
  finally { actionBusy.value = false }
}
function preparePull(image: string, registry = '') {
  pullImage.value = image; pullRegistryId.value = registry; pullHostId.value = hostId.value || hosts.value[0]?.id || ''; pullDialog.value = true
}
async function confirmPull() {
  if (!pullHostId.value || actionBusy.value) return
  actionBusy.value = true; const id = pullHostId.value
  logTitle.value = `拉取镜像 · ${hosts.value.find(host => host.id === id)?.name}`; output.value = '正在登录仓库并拉取镜像…'; logVisible.value = true
  try {
    output.value = await api.remoteAction(id, { kind: 'image', action: 'pull', target: pullImage.value, registryId: pullRegistryId.value || undefined })
    pullDialog.value = false; ElMessage.success('镜像已拉取；需要更新容器时，使用“更新镜像并部署”')
    if (id === hostId.value) await refreshHost()
  } catch (error) { output.value = errorMessage(error) }
  finally { actionBusy.value = false }
}
function prepareUpdate(containers: Array<Record<string, string>>) {
  updateRegistryId.value = ''; updateTargets.value = containers; selectedTargets.value = containers.map(container => container.ID); updateDialog.value = true
}
async function updateContainers() {
  if (!selectedTargets.value.length || actionBusy.value) return
  const id = hostId.value, targets = updateTargets.value.filter(container => selectedTargets.value.includes(container.ID))
  actionBusy.value = true; output.value = ''; logTitle.value = '拉取最新镜像并更新部署'; logVisible.value = true
  try {
    for (const container of targets) {
      output.value += `\n--- ${container.Names} · ${container.Image} ---\n`
      output.value += await api.remoteAction(id, { kind: 'container', action: 'update', target: container.ID, registryId: updateRegistryId.value || undefined })
    }
    updateDialog.value = false; ElMessage.success('所选容器更新完成')
  } catch (error) { output.value += '\n' + errorMessage(error) + '\n后续容器未执行，请检查结果后再重试。' }
  finally { actionBusy.value = false; await refreshHost() }
}
function containersForImage(row: Record<string, string>) {
  const normalize = (image: string) => image.slice(image.lastIndexOf('/') + 1).includes(':') || image.includes('@') ? image : image + ':latest'
  return snapshot.value?.containers.filter(container => normalize(container.Image) === normalize(imageName(row))) || []
}
</script>

<template>
  <div class="page resource-page">
    <PageHeader title="镜像与服务器" subtitle="使用全局仓库与服务器连接，查看镜像、管理容器与部署更新">
      <template #actions><el-button @click="settings">管理全局连接</el-button></template>
    </PageHeader>
    <el-alert v-if="!ready" title="需要完整重启 Project Hub 后使用镜像与服务器管理" type="warning" :closable="false" />
    <el-tabs v-else v-model="tab" class="resource-tabs">
      <el-tab-pane label="镜像仓库" name="images">
        <div class="toolbar"><el-select v-model="registryId" @visible-change="visible => { if (visible) loadConnections() }" :disabled="actionBusy" placeholder="选择全局镜像仓库" aria-label="镜像仓库"><el-option v-for="registry in registries" :key="registry.id" :value="registry.id" :label="`${registry.name} · ${registry.server}`" /></el-select><el-button :disabled="!registryId" :loading="loadingCatalog" @click="refreshCatalog">刷新仓库</el-button></div>
        <el-empty v-if="!registries.length" description="先在全局设置添加镜像仓库连接"><el-button type="primary" @click="settings">添加连接</el-button></el-empty>
        <template v-else>
          <el-alert v-if="catalogNotice" :title="catalogNotice" type="info" :closable="false" show-icon />
          <el-alert v-if="catalogWarning" :title="catalogWarning" type="warning" :closable="false" show-icon />
          <el-alert v-if="registryError" :title="registryError" type="error" :closable="false" show-icon />
          <div class="registry-grid">
            <section class="panel"><h3>{{ catalogMode === 'tracked' ? '已添加的镜像路径' : '镜像仓库' }} <span class="muted">{{ repositories.length }}</span></h3><el-input v-model="search" placeholder="筛选仓库名称" clearable /><el-table v-loading="loadingCatalog" :data="filteredRepositories.map(name => ({ name }))" highlight-current-row empty-text="尚未添加镜像路径，在右侧输入后查询即可保存" @row-click="row => repository = row.name"><el-table-column prop="name" label="仓库路径" /></el-table></section>
            <section class="panel"><h3>镜像版本</h3><div class="toolbar"><el-input v-model="repositoryQuery" placeholder="镜像路径，例如 team/api" @keyup.enter="queryRepository" /><el-button :disabled="!registryId || !repositoryQuery.trim()" :loading="loadingTags" @click="queryRepository">查询并保存路径</el-button></div><p class="muted">镜像列表从仓库实时读取。部分云仓库不开放仓库目录，可直接输入镜像路径查询。</p><el-table v-loading="loadingTags" :data="tags.map(tag => ({ tag }))" empty-text="选择仓库或输入路径，查看镜像标签"><el-table-column prop="tag" label="标签" width="160" /><el-table-column label="镜像引用" min-width="220"><template #default="{ row }"><span class="mono">{{ imageRef(row.tag) }}</span></template></el-table-column><el-table-column label="操作" width="150"><template #default="{ row }"><el-button text type="primary" :disabled="actionBusy" @click="preparePull(imageRef(row.tag), registryId)">拉取到服务器</el-button></template></el-table-column></el-table></section>
          </div>
        </template>
      </el-tab-pane>
      <el-tab-pane label="服务器" name="servers">
        <div class="toolbar"><el-select v-model="hostId" @visible-change="visible => { if (visible) loadConnections() }" :disabled="actionBusy" placeholder="选择全局服务器" aria-label="服务器"><el-option v-for="host in hosts" :key="host.id" :value="host.id" :label="`${host.name} · ${host.host}`" /></el-select><el-button :disabled="!hostId || actionBusy" :loading="loadingHost" @click="refreshHost">刷新服务器</el-button><span class="muted">{{ selectedHost?.username }}{{ selectedHost ? '@' : '' }}{{ selectedHost?.host }}</span></div>
        <el-empty v-if="!hosts.length" description="先在全局设置添加服务器连接"><el-button type="primary" @click="settings">添加连接</el-button></el-empty>
        <template v-else>
          <el-tabs v-model="serverTab"><el-tab-pane label="Docker" name="docker" :disabled="actionBusy" /><el-tab-pane label="自有服务" name="services" :disabled="actionBusy" /></el-tabs>
          <el-alert v-if="hostError" :title="hostError" type="error" :closable="false" show-icon />
          <div v-loading="loadingHost">
            <template v-if="snapshot && serverTab === 'docker'">
              <div class="summary"><div><b>{{ snapshot.containers.length }}</b><span>容器</span></div><div><b>{{ runningCount }}</b><span>运行中</span></div><div><b>{{ snapshot.images.length }}</b><span>本地镜像</span></div></div>
              <section class="panel"><h3>容器列表</h3><el-table :data="snapshot.containers" empty-text="服务器上暂无容器"><el-table-column prop="Names" label="容器" min-width="160" /><el-table-column prop="Image" label="镜像" min-width="220" show-overflow-tooltip /><el-table-column prop="Status" label="状态" min-width="160" /><el-table-column prop="Ports" label="端口" min-width="140" show-overflow-tooltip /><el-table-column label="操作" min-width="440"><template #default="{ row }"><el-button v-if="row.State === 'paused'" text :disabled="actionBusy" @click="operate({ kind: 'container', action: 'unpause', target: row.ID }, '恢复容器')">恢复</el-button><el-button v-else-if="row.State === 'running'" text :disabled="actionBusy" @click="operate({ kind: 'container', action: 'pause', target: row.ID }, '暂停容器')">暂停</el-button><el-button v-else text :disabled="actionBusy" @click="operate({ kind: 'container', action: 'start', target: row.ID }, '启动容器')">启动</el-button><el-button v-if="row.State === 'running'" text :disabled="actionBusy" @click="operate({ kind: 'container', action: 'stop', target: row.ID }, '停止容器')">停止</el-button><el-button text :disabled="actionBusy" @click="operate({ kind: 'logs', action: 'tail', target: row.ID }, '容器日志')">查看日志</el-button><el-button text type="primary" :disabled="actionBusy" @click="prepareUpdate([row])">更新镜像并部署</el-button><el-button text type="danger" :disabled="actionBusy || ['running', 'paused', 'restarting'].includes(row.State)" @click="operate({ kind: 'container', action: 'rm', target: row.ID }, '删除容器')">删除</el-button></template></el-table-column></el-table></section>
              <section class="panel"><div class="toolbar"><h3>Docker 镜像列表</h3><div class="pull-input"><el-input v-model="imageToPull" placeholder="完整镜像引用，例如 nginx:latest" /><el-button :disabled="!imageToPull || actionBusy" @click="preparePull(imageToPull)">拉取镜像</el-button></div></div><el-table :data="snapshot.images" empty-text="服务器上暂无镜像"><el-table-column prop="Repository" label="仓库" min-width="220" /><el-table-column prop="Tag" label="标签" min-width="110" /><el-table-column prop="ID" label="镜像 ID" min-width="160" show-overflow-tooltip /><el-table-column prop="Size" label="大小" width="100" /><el-table-column label="操作" min-width="300"><template #default="{ row }"><el-button text :disabled="actionBusy || !imageName(row)" @click="preparePull(imageName(row))">拉取更新</el-button><el-button text type="primary" :disabled="actionBusy || !containersForImage(row).length" @click="prepareUpdate(containersForImage(row))">更新关联容器</el-button><el-button text type="danger" :disabled="actionBusy" @click="operate({ kind: 'image', action: 'rmi', target: imageName(row) || row.ID }, '删除镜像')">删除</el-button></template></el-table-column></el-table></section>
            </template>
            <section v-if="snapshot && serverTab === 'services'" class="panel"><h3>自有服务 · systemd</h3><p class="muted">管理服务器上的 systemd 服务。</p><el-table :data="snapshot.services" empty-text="此服务器没有可用的 systemd 服务"><el-table-column prop="name" label="服务" min-width="220" /><el-table-column prop="active" label="状态" /><el-table-column prop="description" label="说明" min-width="220" /><el-table-column label="操作" width="220"><template #default="{ row }"><el-button v-for="action in ['start', 'stop', 'restart']" :key="action" text :disabled="actionBusy" @click="operate({ kind: 'service', action, target: row.name }, { start: '启动服务', stop: '停止服务', restart: '重启服务' }[action] || action)">{{ { start: '启动', stop: '停止', restart: '重启' }[action] }}</el-button></template></el-table-column></el-table></section>
            <el-empty v-if="!snapshot && !hostError && !loadingHost" description="选择服务器查看资源" />
          </div>
        </template>
      </el-tab-pane>
    </el-tabs>
    <el-dialog v-model="pullDialog" title="拉取镜像到服务器" width="600" :close-on-click-modal="!actionBusy" :show-close="!actionBusy"><el-form label-position="top"><el-form-item label="镜像"><el-input v-model="pullImage" :disabled="actionBusy" /></el-form-item><el-form-item label="仓库账号"><el-select v-model="pullRegistryId" clearable :disabled="actionBusy" placeholder="自动匹配镜像地址对应的全局账号" class="full"><el-option v-for="registry in registries" :key="registry.id" :value="registry.id" :label="`${registry.name} · ${registry.server}`" /></el-select></el-form-item><el-form-item label="目标服务器"><el-select v-model="pullHostId" :disabled="actionBusy" class="full"><el-option v-for="host in hosts" :key="host.id" :value="host.id" :label="`${host.name} · ${host.host}`" /></el-select></el-form-item></el-form><p class="muted">自动使用匹配的全局仓库账号登录。拉取后可在服务器页更新关联容器。</p><template #footer><el-button :disabled="actionBusy" @click="pullDialog = false">取消</el-button><el-button type="primary" :disabled="!pullHostId || !pullImage" :loading="actionBusy" @click="confirmPull">拉取镜像</el-button></template></el-dialog>
    <el-dialog v-model="updateDialog" title="拉取最新镜像并更新容器" width="660" :close-on-click-modal="!actionBusy" :show-close="!actionBusy"><p>服务器：{{ selectedHost?.name }} · {{ selectedHost?.host }}</p><el-form label-position="top"><el-form-item label="镜像仓库账号"><el-select v-model="updateRegistryId" clearable :disabled="actionBusy" placeholder="自动匹配全局仓库账号" class="full"><el-option v-for="registry in registries" :key="registry.id" :value="registry.id" :label="`${registry.name} · ${registry.server}`" /></el-select></el-form-item></el-form><el-checkbox-group v-model="selectedTargets" :disabled="actionBusy"><el-checkbox v-for="container in updateTargets" :key="container.ID" :value="container.ID">{{ container.Names }} · {{ container.Image }}</el-checkbox></el-checkbox-group><el-alert type="warning" :closable="false" title="将按原标签拉取最新镜像，保留端口、环境变量、挂载卷与网络配置后重建容器。更新会短暂中断；失败尝试恢复旧容器。容器可写层中的文件不会迁移，请将数据保存在挂载卷中。" /><p class="muted">有健康检查时等待检查通过；没有健康检查时仅验证进程持续运行。固定镜像摘要、Swarm、固定 IP 等编排容器请通过原配置发布。</p><template #footer><el-button :disabled="actionBusy" @click="updateDialog = false">取消</el-button><el-button type="primary" :disabled="!selectedTargets.length" :loading="actionBusy" @click="updateContainers">拉取并更新部署</el-button></template></el-dialog>
    <el-drawer v-model="logVisible" :title="logTitle" size="min(760px, 90vw)"><el-alert v-if="actionBusy" type="info" title="正在执行，请保持应用打开；完成后显示完整输出。" :closable="false" /><pre class="console">{{ output || '暂无输出' }}</pre><el-button v-if="logTitle === '容器日志'" :disabled="actionBusy" @click="operate({ kind: 'logs', action: 'tail', target: logTarget }, '容器日志')">刷新日志</el-button></el-drawer>
  </div>
</template>

<style scoped>
.resource-page { box-sizing: border-box; min-height: 0; overflow: hidden; }
.resource-tabs { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.resource-tabs :deep(> .el-tabs__header) { flex-shrink: 0; }
.resource-tabs :deep(> .el-tabs__content) { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-bottom: 24px; }
.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
.toolbar > .el-select { width: min(460px, 100%); }
.registry-grid { display: grid; grid-template-columns: minmax(240px, .65fr) minmax(0, 1.7fr); gap: 18px; margin-top: 18px; }
.panel { min-width: 0; border: 1px solid var(--el-border-color); background: var(--el-bg-color); padding: 20px; border-radius: 12px; margin-bottom: 18px; }
h3 { margin: 0 0 16px; font-size: 16px; } .toolbar h3 { margin: 0; margin-right: auto; }
.muted { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; }
.mono { font: 12px/1.6 monospace; overflow-wrap: anywhere; }
.summary { display: flex; gap: 16px; margin: 0 0 18px; }.summary > div { min-width: 100px; display: flex; align-items: baseline; gap: 10px; padding: 16px 20px; border: 1px solid var(--el-border-color); border-radius: 10px; }.summary b { font-size: 24px; }.summary span { color: var(--el-text-color-secondary); font-size: 13px; }
.pull-input { display: flex; gap: 10px; flex: 1; max-width: 560px; }.full { width: 100%; }
.console { white-space: pre-wrap; overflow-wrap: anywhere; background: #101827; color: #d7e4f4; border-radius: 10px; padding: 18px; font: 12px/1.8 monospace; }
:deep(.el-checkbox-group) { display: flex; flex-direction: column; margin-bottom: 18px; }:deep(.el-checkbox) { height: auto; min-height: 36px; white-space: normal; }:deep(.el-checkbox__label) { white-space: normal; overflow-wrap: anywhere; }
@media (max-width: 1050px) { .registry-grid { grid-template-columns: 1fr; } .summary { flex-wrap: wrap; } }
</style>
