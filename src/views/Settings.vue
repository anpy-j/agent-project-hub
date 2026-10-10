<script setup lang="ts">
import { nextTick, ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { Runtime, AiConfig, AiProviderOption, AiProvider, LogUsage, MaintenanceResult } from '../types'
import PageHeader from '../components/PageHeader.vue'
import AgentAiSettings from '../components/AgentAiSettings.vue'
import GitAuthSettings from '../components/GitAuthSettings.vue'
import RagflowSettings from '../components/RagflowSettings.vue'

const route = useRoute()
const activeSection = ref('git')
const sections = [
  { id: 'git', title: '仓库认证', description: 'SSH 密钥与连接测试', icon: 'Key' },
  { id: 'ai', title: 'AI 服务', description: '模型与服务连接', icon: 'MagicStick' },
  { id: 'knowledge', title: '知识库', description: 'RAGFlow 连接与文档', icon: 'Collection' },
  { id: 'runtime', title: '运行环境', description: '本机开发工具与版本', icon: 'Cpu' },
  { id: 'maintenance', title: '数据与日志', description: '存储用量与历史清理', icon: 'Document' }
]
watch(() => route.query.section, section => {
  activeSection.value = sections.some(item => item.id === section) ? section as string : 'git'
}, { immediate: true })

watch(() => route.query.ai, async value => {
  if (value === 'agent') { await nextTick(); document.getElementById('agent-ai-settings')?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }
}, { immediate: true })

// ---- 运行时管理 ----
const runtimes = ref<Runtime[]>([])
const logUsage = ref<LogUsage>({ files: 0, bytes: 0 })
const cleaning = ref(false)
const scanning = ref(false)

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function loadLogUsage() {
  try {
    logUsage.value = await window.api.system.logUsage()
  } catch {
    // ignore
  }
}

async function runCleanup() {
  cleaning.value = true
  try {
    const r: MaintenanceResult = await window.api.system.maintenance()
    logUsage.value = r.usage
    ElMessage.success(`已清理 ${r.removedTasks} 条历史、${r.removedFiles} 个日志文件`)
  } catch (e) {
    ElMessage.error(`清理失败: ${(e as Error).message}`)
  } finally {
    cleaning.value = false
  }
}

async function load() {
  runtimes.value = await window.api.runtime.list()
}

async function scan() {
  scanning.value = true
  try {
    const scanned = await window.api.runtime.scan()
    ElMessage.success(`扫描完成，新增 ${scanned.length} 个运行时`)
    await load()
  } finally {
    scanning.value = false
  }
}

const kindLabel: Record<string, string> = {
  jdk: 'JDK',
  node: 'Node.js',
  python: 'Python',
  flutter: 'Flutter'
}

// ---- AI 设置（服务发现 Agent） ----
const providers = ref<AiProviderOption[]>([])
const aiForm = ref<AiConfig>({ provider: 'ollama', base_url: '', api_key: '', model: '' })
const aiLoading = ref(false)
const aiSaving = ref(false)
const aiTesting = ref(false)
const aiTestResult = ref('')
const modelOptions = ref<string[]>([])
const modelsLoading = ref(false)
const aiConfigured = ref(false)
// 保存后回显的当前生效配置
const savedSummary = ref('')

const currentProvider = ref<AiProviderOption | null>(null)

function applyProviderPreset(p: AiProviderOption | null) {
  currentProvider.value = p
  if (p && p.baseUrl) aiForm.value.base_url = p.baseUrl
}

function providerLabelOf(value: string): string {
  return providers.value.find((p) => p.value === value)?.label || value
}

function refreshSaved(cfg: AiConfig) {
  const label = providerLabelOf(cfg.provider)
  const model = cfg.model || '（未选模型）'
  const ok = !!(cfg.model && (cfg.provider === 'opencode' || cfg.base_url))
  aiConfigured.value = ok
  savedSummary.value = ok
    ? `${label} · ${model}` + (cfg.provider === 'opencode' ? '' : ` · ${cfg.base_url}`)
    : ''
}

async function loadAi() {
  aiLoading.value = true
  try {
    providers.value = await window.api.ai.providers()
    const cfg = await window.api.ai.getConfig()
    aiForm.value = { ...cfg }
    applyProviderPreset(providers.value.find((p) => p.value === cfg.provider) || null)
    refreshSaved(cfg)
    // 自动拉取模型列表，让下拉框直接显示可用模型
    if (cfg.provider === 'opencode' || cfg.base_url) {
      fetchModels(true)
    }
  } finally {
    aiLoading.value = false
  }
}

watch(
  () => aiForm.value.provider,
  (val) => {
    const p = providers.value.find((x) => x.value === val)
    if (p) applyProviderPreset(p)
    // 切换厂商后自动刷新模型列表
    if (val === 'opencode') {
      fetchModels(true)
    } else if (aiForm.value.base_url) {
      fetchModels(true)
    }
  }
)

async function saveAi() {
  aiSaving.value = true
  try {
    // 关键：contextBridge 无法克隆响应式代理，先转纯对象
    const saved = await window.api.ai.saveConfig(JSON.parse(JSON.stringify(aiForm.value)))
    aiForm.value = { ...saved }
    refreshSaved(saved)
    ElMessage.success('AI 配置已保存')
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    aiSaving.value = false
  }
}

async function fetchModels(silent = false) {
  modelsLoading.value = true
  try {
    // 用当前表单值（未保存也允许拉取）
    const list = await window.api.ai.listModels(JSON.parse(JSON.stringify(aiForm.value)))
    modelOptions.value = list
    if (!silent) ElMessage.success(`获取到 ${list.length} 个模型`)
  } catch (e) {
    if (!silent) ElMessage.error((e as Error).message)
  } finally {
    modelsLoading.value = false
  }
}

async function testAi() {
  aiTesting.value = true
  aiTestResult.value = ''
  try {
    const reply = await window.api.ai.test(JSON.parse(JSON.stringify(aiForm.value)))
    aiTestResult.value = reply
    ElMessage.success('连接正常')
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    aiTesting.value = false
  }
}

onMounted(() => {
  load()
  loadLogUsage()
  loadAi()
})
</script>

<template>
  <div class="page settings-page">
    <PageHeader title="全局设置" subtitle="管理仓库连接、AI 服务与本机开发环境" />

    <nav class="settings-nav" aria-label="设置分类">
      <button
        v-for="section in sections"
        :key="section.id"
        type="button"
        :class="['section-button', { active: activeSection === section.id }]"
        :aria-pressed="activeSection === section.id"
        @click="activeSection = section.id"
      >
        <el-icon class="section-icon" :size="20"><component :is="section.icon" /></el-icon>
        <span class="section-copy"><span class="section-title">{{ section.title }}</span><span class="section-description">{{ section.description }}</span></span>
      </button>
    </nav>

    <div class="settings-stack">
      <RagflowSettings v-if="activeSection === 'knowledge'" />
      <GitAuthSettings v-show="activeSection === 'git'" />
      <!-- AI 设置 -->
      <el-card v-show="activeSection === 'ai'" v-loading="aiLoading">
        <template #header>
          <div class="card-head">
            <span class="card-title">
              通用 AI 配置
              <span class="pill" :class="{ 'is-primary': aiConfigured }">
                {{ savedSummary ? `已连接：${savedSummary}` : '未配置' }}
              </span>
            </span>
            <span class="card-head-actions">
              <el-button size="small" :loading="modelsLoading" @click="fetchModels()">刷新模型列表</el-button>
              <el-button size="small" :loading="aiTesting" @click="testAi">测试连接</el-button>
              <el-button type="primary" size="small" :loading="aiSaving" @click="saveAi">保存</el-button>
            </span>
          </div>
        </template>
      <el-alert
        v-if="savedSummary"
        :title="`当前生效配置：${savedSummary}`"
        type="success"
        show-icon
        :closable="false"
        style="margin-bottom: 14px"
      />
      <el-form label-width="100px" label-position="right">
        <p class="form-tip">通用 AI 用于磁盘分析、服务发现和技能解读。Agent 使用下方独立配置。</p>
        <el-form-item label="厂商">
          <el-select v-model="aiForm.provider" style="width: 280px">
            <el-option v-for="p in providers" :key="p.value" :label="p.label" :value="p.value" />
          </el-select>
          <span class="form-tip">{{ currentProvider?.hint }}</span>
        </el-form-item>
        <el-form-item label="Base URL">
          <el-input
            v-model="aiForm.base_url"
            :disabled="aiForm.provider === 'opencode'"
            :placeholder="aiForm.provider === 'opencode' ? 'OpenCode 走本机 CLI，无需填写' : 'http://localhost:11434/v1'"
            style="width: 420px"
          />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input
            v-model="aiForm.api_key"
            type="password"
            show-password
            :placeholder="currentProvider?.needKey ? '必填' : '本机模型可留空'"
            style="width: 420px"
          />
        </el-form-item>
        <el-form-item label="模型">
          <el-select
            v-model="aiForm.model"
            filterable
            allow-create
            default-first-option
            placeholder="选择或输入模型名，例如 qwen2.5:7b"
            style="width: 420px"
          >
            <el-option v-for="m in modelOptions" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="aiTestResult" label="测试回复">
          <span class="test-result">{{ aiTestResult }}</span>
        </el-form-item>
      </el-form>
      </el-card>

      <AgentAiSettings v-show="activeSection === 'ai'" />

      <!-- 运行时管理 -->
      <el-card v-show="activeSection === 'runtime'">
        <template #header>
          <div class="card-head">
            <span class="card-title">运行时管理</span>
            <el-button type="primary" size="small" :loading="scanning" @click="scan">
              <el-icon><Refresh /></el-icon>扫描系统
            </el-button>
          </div>
        </template>
        <el-table :data="runtimes">
          <el-table-column prop="kind" label="类型" width="120">
            <template #default="{ row }">{{ kindLabel[row.kind] || row.kind }}</template>
          </el-table-column>
          <el-table-column prop="version" label="版本" width="140" />
          <el-table-column prop="path" label="路径">
            <template #default="{ row }"><span class="mono">{{ row.path }}</span></template>
          </el-table-column>
          <el-table-column prop="source" label="来源" width="100" />
          <el-table-column label="默认" width="80">
            <template #default="{ row }">
              <span v-if="row.is_default" class="chip is-ok"><span class="dot" />默认</span>
              <span v-else class="muted-dim">-</span>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card v-show="activeSection === 'maintenance'">
        <template #header>
          <b>数据与日志</b>
        </template>
        <div class="maint-row">
          <div class="maint-info">
            <div class="maint-line">任务日志：<b>{{ logUsage.files }}</b> 个文件，共 <b>{{ formatBytes(logUsage.bytes) }}</b></div>
            <div class="maint-tip">每个项目保留最近 200 条任务记录，日志文件保留 14 天，启动时自动整理。</div>
          </div>
          <el-button size="small" :loading="cleaning" @click="runCleanup">立即清理</el-button>
        </div>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  box-sizing: border-box;
  min-height: 0;
  padding-bottom: 18px;
}
.settings-nav {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  flex-shrink: 0;
  margin-bottom: 18px;
  padding: 6px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  background: var(--el-bg-color);
}
.section-button {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--el-text-color-secondary);
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}
.section-button:hover { background: var(--el-fill-color-light); }
.section-button.active {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-7);
  color: var(--el-color-primary);
}
.section-button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.section-icon { flex-shrink: 0; }
.section-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.section-title { font-size: 14px; font-weight: 600; }
.section-description { font-size: 12px; color: var(--el-text-color-secondary); }
.settings-stack {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding-bottom: 2px;
}
.settings-stack > :deep(.el-card) {
  flex-shrink: 0;
  border-radius: 12px;
  box-shadow: none;
}
.settings-stack :deep(.el-card__header) {
  padding: 16px 20px;
  background: var(--el-fill-color-extra-light);
}
.settings-stack :deep(.el-card__body) { padding: 20px; }
.settings-stack :deep(.el-form) { max-width: 760px; }
.settings-stack :deep(.el-form-item__content > .el-input),
.settings-stack :deep(.el-form-item__content > .el-select) { max-width: 100%; }
@media (max-width: 1050px) {
  .section-button { padding: 10px; gap: 8px; }
  .section-description { display: none; }
}
@media (max-width: 700px) {
  .settings-nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.card-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.card-head-actions {
  display: flex;
  gap: 8px;
}
.form-tip {
  margin-left: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.maint-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.maint-line {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.maint-tip {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.test-result {
  font-size: 13px;
  color: var(--el-color-success);
}
</style>
