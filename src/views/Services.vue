<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElNotification, ElMessageBox } from 'element-plus'
import { useServiceStore, type ServiceRow } from '../stores/service'
import type { ServiceItem, ServiceCandidate, ServiceLogChunk, ServiceStatusInfo, ServiceAnomaly, ServiceRunStatus } from '../types'
import ServiceLogPanel from '../components/ServiceLogPanel.vue'

const serviceStore = useServiceStore()
const logPanelRef = ref<InstanceType<typeof ServiceLogPanel> | null>(null)

const groupFilter = ref('all')
const groups = computed(() => {
  const set = new Set<string>()
  serviceStore.services.forEach((s) => set.add(s.group_name || '未分组'))
  return Array.from(set).sort()
})
const filteredRows = computed(() =>
  groupFilter.value === 'all'
    ? serviceStore.services
    : serviceStore.services.filter((s) => (s.group_name || '未分组') === groupFilter.value)
)

const stats = computed(() => {
  const all = serviceStore.services
  return [
    { label: '服务总数', value: String(all.length), icon: 'Odometer', tone: 'primary' },
    { label: '运行中', value: String(all.filter((s) => s.status.status === 'running').length), icon: 'VideoPlay', tone: 'success' },
    { label: '已停止', value: String(all.filter((s) => s.status.status === 'stopped').length), icon: 'SwitchButton', tone: 'info' },
    { label: '异常', value: String(all.filter((s) => s.status.status === 'abnormal').length), icon: 'WarningFilled', tone: 'danger' }
  ]
})

const statusMeta: Record<ServiceRunStatus, { label: string; type: 'success' | 'info' | 'danger' | 'warning' }> = {
  running: { label: '运行中', type: 'success' },
  stopped: { label: '已停止', type: 'info' },
  abnormal: { label: '异常', type: 'danger' }
}

const busy = ref<Record<string, boolean>>({})

// ---- 新增 / 编辑 ----
const editDialogVisible = ref(false)
const editingId = ref<string | null>(null)
const form = ref({
  name: '',
  group_name: '',
  command: '',
  cwd: '',
  port: null as number | null,
  autostart: false,
  description: ''
})

function openAdd() {
  editingId.value = null
  form.value = { name: '', group_name: '', command: '', cwd: '', port: null, autostart: false, description: '' }
  editDialogVisible.value = true
}

function openEdit(s: ServiceItem) {
  editingId.value = s.id
  form.value = {
    name: s.name,
    group_name: s.group_name || '',
    command: s.command,
    cwd: s.cwd || '',
    port: s.port,
    autostart: !!s.autostart,
    description: s.description || ''
  }
  editDialogVisible.value = true
}

async function saveService() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写服务名称')
  if (!form.value.command.trim()) return ElMessage.warning('请填写启动命令')
  const payload = {
    name: form.value.name.trim(),
    group_name: form.value.group_name.trim() || null,
    command: form.value.command.trim(),
    cwd: form.value.cwd.trim() || null,
    port: form.value.port || null,
    autostart: form.value.autostart,
    description: form.value.description.trim() || null
  }
  try {
    if (editingId.value) {
      await window.api.service.update(editingId.value, {
        ...payload,
        autostart: form.value.autostart ? 1 : 0
      } as Partial<ServiceItem>)
      ElMessage.success('已保存')
    } else {
      await window.api.service.add(payload)
      ElMessage.success('服务已添加')
    }
    editDialogVisible.value = false
    await serviceStore.load()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function pickDirectory() {
  const dir = await window.api.system.pickDirectory()
  if (dir) form.value.cwd = dir
}

// ---- 控制 ----
async function startService(s: ServiceItem & { status: ServiceStatusInfo }) {
  busy.value[s.id] = true
  try {
    await window.api.service.start(s.id)
    logPanelRef.value?.attach(s.id, s.name)
    serviceStore.applyStatus({ serviceId: s.id, status: 'running', pid: null, detail: '已启动' })
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    busy.value[s.id] = false
  }
}

async function stopService(s: ServiceItem) {
  busy.value[s.id] = true
  try {
    await window.api.service.stop(s.id)
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    busy.value[s.id] = false
  }
}

async function restartService(s: ServiceItem) {
  busy.value[s.id] = true
  try {
    await window.api.service.restart(s.id)
    ElMessage.success('已重启')
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    busy.value[s.id] = false
  }
}

function showLog(s: ServiceItem) {
  logPanelRef.value?.attach(s.id, s.name)
  logPanelRef.value?.loadHistory()
}

async function removeService(s: ServiceItem) {
  await ElMessageBox.confirm(`确定删除服务「${s.name}」？`, '删除服务', { type: 'warning' })
  await window.api.service.remove(s.id)
  await serviceStore.load()
  ElMessage.success('已删除')
}

async function toggleAutostart(s: ServiceItem & { status: ServiceStatusInfo }) {
  try {
    await window.api.service.update(s.id, { autostart: s.autostart ? 1 : 0 })
    ElMessage.success(s.autostart ? '已开启自启动' : '已关闭自启动')
  } catch (e) {
    s.autostart = s.autostart ? 0 : 1
    ElMessage.error((e as Error).message)
  }
}

// ---- 导入系统服务 ----
const importDialogVisible = ref(false)
const importLoading = ref(false)
const importCandidates = ref<ServiceCandidate[]>([])
const importSelection = ref<string[]>([])
const importFilter = ref('')
const agentQuery = ref('')
const agentSearching = ref(false)
const agentNotice = ref('')

const filteredImportRows = computed(() => {
  const kw = importFilter.value.trim().toLowerCase()
  if (!kw) return importCandidates.value
  return importCandidates.value.filter(
    (c) => c.name.toLowerCase().includes(kw) || c.command.toLowerCase().includes(kw)
  )
})

const sourceLabel: Record<string, string> = {
  launchd: 'launchd',
  schtasks: '任务计划',
  cli: 'CLI',
  agent: 'AI 发现'
}

function sourceTagType(s: string): 'primary' | 'success' | 'warning' | 'info' {
  if (s === 'agent') return 'warning'
  if (s === 'cli') return 'success'
  return 'info'
}

async function openImport() {
  importDialogVisible.value = true
  importLoading.value = true
  importSelection.value = []
  importFilter.value = ''
  agentNotice.value = ''
  try {
    importCandidates.value = await window.api.service.importScan()
  } catch (e) {
    ElMessage.error(`扫描失败: ${(e as Error).message}`)
    importCandidates.value = []
  } finally {
    importLoading.value = false
  }
}

async function runAgentSearch() {
  const q = agentQuery.value.trim()
  if (!q) return ElMessage.warning('请输入服务名，例如 openclaw')
  agentSearching.value = true
  agentNotice.value = ''
  try {
    const res = await window.api.service.agentSearch(q)
    // AI 搜索结果与已扫描列表合并（按 key 去重）
    const existKeys = new Set(importCandidates.value.map((c) => c.key))
    const fresh = res.candidates.filter((c) => !existKeys.has(c.key))
    importCandidates.value = [...fresh, ...importCandidates.value]
    importFilter.value = q
    agentNotice.value = res.usedAi
      ? `AI 搜索完成：识别出 ${res.candidates.length} 个候选（已按「${q}」过滤显示）`
      : res.notice
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    agentSearching.value = false
  }
}

async function doImport() {
  const picked = importCandidates.value.filter((c) => importSelection.value.includes(c.key) && !c.alreadyImported)
  if (!picked.length) return ElMessage.warning('请先选择要导入的服务')
  try {
    // 关键：contextBridge 无法克隆 Vue 响应式代理，必须先转纯对象
    const plain = JSON.parse(JSON.stringify(picked))
    const count = await window.api.service.import(plain)
    ElMessage.success(`已导入 ${count} 个服务`)
    importDialogVisible.value = false
    await serviceStore.load()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function refresh() {
  await serviceStore.load()
}

let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await serviceStore.load()
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') serviceStore.load()
  }, 15000)

  window.api.service.onLog((chunk: ServiceLogChunk) => {
    logPanelRef.value?.append(chunk)
  })
  window.api.service.onStatus((info: ServiceStatusInfo) => {
    serviceStore.applyStatus(info)
  })
  window.api.service.onAnomaly((anomaly: ServiceAnomaly) => {
    ElNotification({
      title: '服务异常',
      message: anomaly.message,
      type: 'error',
      duration: 0
    })
  })
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="services-view">
    <!-- 页头 -->
    <div class="page-head">
      <div>
        <h2>本机服务管理</h2>
        <p class="head-sub">统一管理手动安装的本机服务：CLI 工具、守护进程、AI 服务等</p>
      </div>
      <div class="head-actions">
        <el-button @click="refresh">
          <el-icon><Refresh /></el-icon>刷新状态
        </el-button>
        <el-button @click="openImport">
          <el-icon><MagicStick /></el-icon>导入系统服务
        </el-button>
        <el-button type="primary" @click="openAdd">
          <el-icon><Plus /></el-icon>添加服务
        </el-button>
      </div>
    </div>

    <!-- 指标行 -->
    <div class="stats-row">
      <div v-for="s in stats" :key="s.label" class="stat-card">
        <div class="stat-icon" :class="'tone-' + s.tone">
          <el-icon :size="20"><component :is="s.icon" /></el-icon>
        </div>
        <div class="stat-body">
          <div class="stat-num">{{ s.value }}</div>
          <div class="stat-label">{{ s.label }}</div>
        </div>
      </div>
    </div>

    <!-- 分组过滤 -->
    <div class="filter-bar">
      <el-radio-group v-model="groupFilter" size="small">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button v-for="g in groups" :key="g" :value="g">{{ g }}</el-radio-button>
      </el-radio-group>
    </div>

    <!-- 服务表格 -->
    <el-card class="table-card" shadow="never">
      <el-table
        :data="filteredRows"
        style="width: 100%"
        :header-cell-style="{ background: 'var(--el-fill-color-light)', color: 'var(--el-text-color-secondary)', fontWeight: 600 }"
        empty-text="暂无服务，点击右上角添加或导入"
      >
        <el-table-column label="服务" min-width="260">
          <template #default="{ row }">
            <div class="cell-service">
              <div class="svc-name">
                <span class="svc-title">{{ row.name }}</span>
                <el-tag size="small" effect="plain" type="info">
                  {{ row.source === 'manual' ? '手动' : row.source === 'launchd' ? 'launchd' : '任务计划' }}
                </el-tag>
              </div>
              <div class="svc-command" :title="row.command">{{ row.command }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="分组" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.group_name ? 'primary' : 'info'" effect="plain">
              {{ row.group_name || '未分组' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="端口" width="80">
          <template #default="{ row }">
            <span v-if="row.port" class="mono">{{ row.port }}</span>
            <span v-else class="cell-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="自启动" width="90">
          <template #default="{ row }">
            <el-switch v-model="row.autostart" :disabled="busy[row.id]" @change="toggleAutostart(row as ServiceRow)" />
          </template>
        </el-table-column>
        <el-table-column label="状态" width="170">
          <template #default="{ row }">
            <div class="cell-status">
              <el-tag :type="statusMeta[(row as ServiceRow).status.status].type" size="small" effect="dark">
                {{ statusMeta[(row as ServiceRow).status.status].label }}
              </el-tag>
              <span class="status-detail" :title="(row as ServiceRow).status.detail">{{ (row as ServiceRow).status.detail }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280" align="right">
          <template #default="{ row }">
            <div class="cell-actions">
              <el-button
                v-if="(row as ServiceRow).status.status !== 'running'"
                type="primary"
                size="small"
                :loading="busy[row.id]"
                @click="startService(row as ServiceRow)"
              >启动</el-button>
              <el-button
                v-else
                type="danger"
                size="small"
                :loading="busy[row.id]"
                @click="stopService(row as ServiceRow)"
              >停止</el-button>
              <el-button size="small" :loading="busy[row.id]" @click="restartService(row as ServiceRow)">重启</el-button>
              <el-button size="small" @click="showLog(row as ServiceRow)">
                <el-icon><Document /></el-icon>日志
              </el-button>
              <el-dropdown trigger="click">
                <el-button size="small">
                  <el-icon><MoreFilled /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item @click="openEdit(row as ServiceRow)">编辑</el-dropdown-item>
                    <el-dropdown-item divided @click="removeService(row as ServiceRow)">
                      <span style="color: var(--el-color-danger)">删除服务</span>
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <ServiceLogPanel ref="logPanelRef" />

    <!-- 新增 / 编辑服务 -->
    <el-dialog
      v-model="editDialogVisible"
      :title="editingId ? '编辑服务' : '添加服务'"
      width="560"
    >
      <el-form label-width="90px" label-position="right">
        <el-form-item label="服务名称" required>
          <el-input v-model="form.name" placeholder="例如 openclaw、frps、jupyter" />
        </el-form-item>
        <el-form-item label="分组">
          <el-select
            v-model="form.group_name"
            filterable
            allow-create
            default-first-option
            clearable
            placeholder="选择或输入分组（开发工具 / AI 服务 / CLI 等）"
            style="width: 100%"
          >
            <el-option v-for="g in groups" :key="g" :label="g" :value="g === '未分组' ? '' : g" />
          </el-select>
        </el-form-item>
        <el-form-item label="启动命令" required>
          <div class="cmd-field">
            <el-input
              v-model="form.command"
              type="textarea"
              :rows="2"
              placeholder="完整 shell 命令，例如 openclaw gateway --port 3000"
            />
            <span class="form-tip">注意：交互式界面类命令（如直接运行 openclaw、codex 会进入 TUI）无法后台运行，请填写其守护进程/服务模式子命令</span>
          </div>
        </el-form-item>
        <el-form-item label="工作目录">
          <div class="cwd-row">
            <el-input v-model="form.cwd" placeholder="服务启动时的工作目录（可选）" clearable />
            <el-button @click="pickDirectory">选择</el-button>
          </div>
        </el-form-item>
        <el-form-item label="端口">
          <el-input-number v-model="form.port" :min="1" :max="65535" placeholder="用于状态探测" controls-position="right" style="width: 180px" />
          <span class="form-tip">填写后可通过端口探测运行状态</span>
        </el-form-item>
        <el-form-item label="自启动">
          <el-switch v-model="form.autostart" />
          <span class="form-tip">应用启动时自动拉起该服务</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.description" type="textarea" :rows="2" placeholder="用途说明（可选）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveService">保存</el-button>
      </template>
    </el-dialog>

    <!-- 导入系统服务 -->
    <el-dialog v-model="importDialogVisible" title="导入系统服务" width="720">
      <div class="agent-search-row">
        <el-input
          v-model="agentQuery"
          placeholder="输入服务名让 AI 搜索本机服务，例如 openclaw / codex / antigravity"
          clearable
          @keyup.enter="runAgentSearch"
        >
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-button type="primary" :loading="agentSearching" @click="runAgentSearch">
          <el-icon><MagicStick /></el-icon>AI 搜索
        </el-button>
      </div>
      <el-alert
        v-if="agentNotice"
        :title="agentNotice"
        :type="agentNotice.startsWith('AI 搜索完成') ? 'success' : 'info'"
        show-icon
        :closable="false"
        style="margin-bottom: 10px"
      />
      <div class="import-filter-row">
        <el-input v-model="importFilter" placeholder="过滤当前列表" clearable size="small" style="width: 240px">
          <template #prefix><el-icon><Filter /></el-icon></template>
        </el-input>
        <span class="import-count">共 {{ filteredImportRows.length }} 项</span>
      </div>
      <el-table
        v-loading="importLoading"
        :data="filteredImportRows"
        style="width: 100%"
        max-height="380"
        empty-text="未发现可导入的服务"
        @selection-change="(rows: unknown[]) => (importSelection = (rows as ServiceCandidate[]).map((r) => r.key))"
      >
        <el-table-column type="selection" width="42" :selectable="(row: unknown) => !(row as ServiceCandidate).alreadyImported" />
        <el-table-column label="名称" min-width="160">
          <template #default="{ row }">
            <span class="mono">{{ (row as ServiceCandidate).name }}</span>
            <el-tag v-if="(row as ServiceCandidate).alreadyImported" size="small" type="info" style="margin-left: 6px">已导入</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="命令" min-width="220">
          <template #default="{ row }">
            <span class="svc-command" :title="(row as ServiceCandidate).command">{{ (row as ServiceCandidate).command }}</span>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="90">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="sourceTagType((row as ServiceCandidate).source)">
              {{ sourceLabel[(row as ServiceCandidate).source] || (row as ServiceCandidate).source }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="说明" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ (row as ServiceCandidate).description || '-' }}</template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="importDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="doImport">导入所选</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.services-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 20px 24px;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.page-head h2 {
  margin: 0;
  font-size: 20px;
  color: var(--el-text-color-primary);
}
.head-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}
.stat-card {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  padding: 16px 18px;
  display: flex;
  align-items: center;
  gap: 14px;
  box-shadow: var(--ph-shadow-soft);
}
.stat-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.tone-primary {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
.tone-success {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}
.tone-info {
  background: var(--el-color-info-light-9);
  color: var(--el-color-info);
}
.tone-danger {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}
.stat-num {
  font-size: 26px;
  font-weight: 700;
  color: var(--el-text-color-primary);
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.stat-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.table-card {
  flex: 1;
  overflow: hidden;
  border-radius: 12px;
}
.cell-service {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.svc-name {
  display: flex;
  align-items: center;
  gap: 6px;
}
.svc-title {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.svc-command {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 340px;
}
.cell-status {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.status-detail {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 150px;
}
.cell-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  align-items: center;
}
.cell-muted {
  color: var(--el-text-color-placeholder);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.cwd-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.cmd-field {
  width: 100%;
}
.cmd-field .form-tip {
  display: block;
  margin: 4px 0 0;
  line-height: 1.4;
}
.form-tip {
  margin-left: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.import-hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.agent-search-row {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}
.import-filter-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.import-count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
