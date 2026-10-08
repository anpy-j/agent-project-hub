<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '../components/PageHeader.vue'
import type {
  DiskDriveInfo,
  DiskAnalysisResult,
  CleanItem,
  CleanExecutionTarget,
  CleanExecutionResult
} from '../types'

const drives = ref<DiskDriveInfo[]>([])
const loadingDrives = ref(false)
const analyzing = ref(false)
const cleaning = ref(false)

const analysisResult = ref<DiskAnalysisResult | null>(null)
const selectedItemIds = ref<Set<string>>(new Set())
const cleanMode = ref<'delete' | 'trash'>('trash')

// 汇总勾选状态
const allItems = computed<CleanItem[]>(() => {
  if (!analysisResult.value) return []
  return analysisResult.value.tiers.flatMap((t) => t.items)
})

const selectedItems = computed<CleanItem[]>(() => {
  return allItems.value.filter((i) => selectedItemIds.value.has(i.id))
})

const selectedCount = computed(() => selectedItems.value.length)

const selectedSizeBytes = computed(() => {
  return selectedItems.value.reduce((sum, item) => sum + item.sizeBytes, 0)
})

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

const selectedSizeDisplay = computed(() => formatBytes(selectedSizeBytes.value))

// 获取磁盘分区列表
async function loadDrives() {
  loadingDrives.value = true
  try {
    drives.value = await window.api.diskCleaner.getDrives()
  } catch (err) {
    ElMessage.error(`获取磁盘信息失败: ${(err as Error).message}`)
  } finally {
    loadingDrives.value = false
  }
}

// 运行 AI 全盘分析
async function runAnalysis() {
  analyzing.value = true
  try {
    const res = await window.api.diskCleaner.analyze()
    analysisResult.value = res
    drives.value = res.drives

    // 默认勾选第一梯队推荐项
    const defaultIds = new Set<string>()
    for (const tier of res.tiers) {
      for (const item of tier.items) {
        if (item.defaultChecked) {
          defaultIds.add(item.id)
        }
      }
    }
    selectedItemIds.value = defaultIds

    ElMessage.success(res.usedAi ? 'AI 语义深度体检完成！' : '智能磁盘体检完成（已应用专家知识库）')
  } catch (err) {
    ElMessage.error(`体检失败: ${(err as Error).message}`)
  } finally {
    analyzing.value = false
  }
}

// 梯队全选 / 取消全选
function isTierAllSelected(tierIndex: number): boolean {
  if (!analysisResult.value) return false
  const items = analysisResult.value.tiers[tierIndex].items
  if (!items.length) return false
  return items.every((i) => selectedItemIds.value.has(i.id))
}

function toggleTierSelect(tierIndex: number) {
  if (!analysisResult.value) return
  const items = analysisResult.value.tiers[tierIndex].items
  const allSel = isTierAllSelected(tierIndex)
  const next = new Set(selectedItemIds.value)
  for (const item of items) {
    if (allSel) {
      next.delete(item.id)
    } else {
      next.add(item.id)
    }
  }
  selectedItemIds.value = next
}

function toggleItem(id: string) {
  const next = new Set(selectedItemIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selectedItemIds.value = next
}

// 打开文件夹
async function openFolder(path: string) {
  try {
    await window.api.system.openPath(path)
  } catch (err) {
    ElMessage.error(`无法打开路径: ${(err as Error).message}`)
  }
}

// 确认并执行清理
async function confirmClean() {
  if (selectedItems.value.length === 0) {
    ElMessage.warning('请先勾选需要清理的文件或目录')
    return
  }

  const actionText = cleanMode.value === 'trash' ? '移至系统回收站（可撤销）' : '直接物理永久清除（不可撤销）'
  const message = `确定要清理选中的 ${selectedCount.value} 个项目吗？\n\n预计将释放空间：${selectedSizeDisplay.value}\n清理模式：${actionText}`

  try {
    await ElMessageBox.confirm(message, '安全清理二次确认', {
      confirmButtonText: '确定清理',
      cancelButtonText: '取消',
      type: cleanMode.value === 'trash' ? 'warning' : 'error'
    })
  } catch {
    return
  }

  cleaning.value = true
  try {
    const targets: CleanExecutionTarget[] = selectedItems.value.map((item) => ({
      id: item.id,
      path: item.path,
      action: cleanMode.value
    }))

    const result: CleanExecutionResult = await window.api.diskCleaner.clean(targets)
    drives.value = result.afterDrives

    // 剔除已清理成功的项
    if (analysisResult.value) {
      const failedPaths = new Set(result.errors.map((e) => e.path.toLowerCase()))
      for (const tier of analysisResult.value.tiers) {
        tier.items = tier.items.filter((item) => failedPaths.has(item.path.toLowerCase()))
      }
    }
    selectedItemIds.value = new Set()

    if (result.failedCount === 0) {
      ElMessage.success(`清理成功！已释放 ${result.freedDisplay} 磁盘空间`)
    } else {
      ElMessage.warning(`清理完成：释放 ${result.freedDisplay}，有 ${result.failedCount} 个文件因占用被跳过`)
    }
  } catch (err) {
    ElMessage.error(`清理异常: ${(err as Error).message}`)
  } finally {
    cleaning.value = false
  }
}

onMounted(() => {
  loadDrives()
})
</script>

<template>
  <div class="page page-scroll disk-cleaner-view">
    <PageHeader
      title="AI 磁盘管家"
      subtitle="基于 AI 语义感知的大头文件挖掘、智能分级诊断与安全极速瘦身"
    />

    <!-- 1. 磁盘分区容量卡片 -->
    <div class="drives-grid">
      <el-card v-for="d in drives" :key="d.drive" class="drive-card" shadow="hover">
        <div class="drive-header">
          <div class="drive-title">
            <el-icon class="drive-icon"><Coin /></el-icon>
            <span class="drive-letter">{{ d.drive }} 盘</span>
          </div>
          <el-tag
            :type="d.usedPercent > 90 ? 'danger' : d.usedPercent > 75 ? 'warning' : 'success'"
            size="small"
            effect="dark"
          >
            {{ d.usedPercent > 90 ? '严重告急' : d.usedPercent > 75 ? '空间偏紧' : '容量健康' }}
          </el-tag>
        </div>

        <div class="drive-stat">
          <div class="stat-main">
            <span class="stat-free-num">{{ d.freeGb }}</span>
            <span class="stat-unit">GB 可用</span>
          </div>
          <div class="stat-sub">已用 {{ (d.totalGb - d.freeGb).toFixed(1) }} GB / 共 {{ d.totalGb }} GB</div>
        </div>

        <el-progress
          :percentage="d.usedPercent"
          :status="d.usedPercent > 90 ? 'exception' : d.usedPercent > 75 ? 'warning' : 'success'"
          :stroke-width="10"
          :show-text="false"
        />
      </el-card>
    </div>

    <!-- 2. AI 诊断触发区 -->
    <el-card class="scan-card" shadow="never">
      <div class="scan-wrapper">
        <div class="scan-info">
          <div class="scan-title">
            <span>智能语义体检引擎</span>
            <el-tag v-if="analysisResult?.usedAi" type="success" size="small" effect="plain">
              🤖 深度推理中：{{ analysisResult.aiModel }}
            </el-tag>
            <el-tag v-else type="info" size="small" effect="plain">
              💡 专家启发式规则引擎
            </el-tag>
          </div>
          <p class="scan-desc">
            不同于传统工具的死板扫描，AI 磁盘管家能智能识别剪映临时代理缓存、ASR 转录上传副本、已剪辑款式中间件与群聊大视频。
          </p>
        </div>

        <div class="scan-actions">
          <el-button
            type="primary"
            size="large"
            :loading="analyzing"
            class="glow-button"
            @click="runAnalysis"
          >
            <el-icon><Compass /></el-icon>
            {{ analyzing ? 'AI 正在深入扫描分析...' : '一键 AI 智能体检' }}
          </el-button>
          <el-button size="large" :loading="loadingDrives" @click="loadDrives">
            <el-icon><Refresh /></el-icon>刷新磁盘
          </el-button>
        </div>
      </div>
    </el-card>

    <!-- 3. AI 诊断报告展示 -->
    <div v-if="analysisResult" class="analysis-results">
      <!-- 诊断综述 Banner -->
      <el-alert
        :title="analysisResult.summary"
        type="info"
        :closable="false"
        show-icon
        class="summary-alert"
      >
        <template #default>
          <div class="analysis-meta">
            体检时间：{{ analysisResult.analyzedAt }} · 共发现 {{ allItems.length }} 个高价值优化目标
          </div>
        </template>
      </el-alert>

      <!-- 优化建议（如 Ollama 迁移） -->
      <div v-if="analysisResult.optimizations?.length" class="optimizations-block">
        <el-alert
          v-for="(opt, idx) in analysisResult.optimizations"
          :key="idx"
          :title="opt.title"
          type="warning"
          :description="`${opt.description} 💡 指引: ${opt.actionHint}`"
          show-icon
          :closable="false"
          style="margin-bottom: 12px"
        />
      </div>

      <!-- 分级梯队展示 -->
      <div v-for="(tier, tIdx) in analysisResult.tiers" :key="tier.level" class="tier-card">
        <el-card shadow="never">
          <template #header>
            <div class="tier-header">
              <div class="tier-title-group">
                <el-tag
                  :type="tier.badge === 'safe' ? 'success' : tier.badge === 'warning' ? 'warning' : 'info'"
                  effect="dark"
                  class="tier-badge"
                >
                  {{ tier.badge === 'safe' ? '🟢 安全可删' : tier.badge === 'warning' ? '🟡 建议核对' : '🔴 建议归档' }}
                </el-tag>
                <span class="tier-title">{{ tier.title }}</span>
                <span class="tier-desc">{{ tier.description }}</span>
              </div>

              <div class="tier-actions">
                <el-button
                  v-if="tier.items.length"
                  size="small"
                  text
                  @click="toggleTierSelect(tIdx)"
                >
                  {{ isTierAllSelected(tIdx) ? '取消本组' : '全选本组' }}
                </el-button>
              </div>
            </div>
          </template>

          <!-- 列表项 -->
          <div v-if="tier.items.length" class="items-list">
            <div
              v-for="item in tier.items"
              :key="item.id"
              class="item-row"
              :class="{ 'is-selected': selectedItemIds.has(item.id) }"
              @click="toggleItem(item.id)"
            >
              <div class="item-check" @click.stop>
                <el-checkbox
                  :model-value="selectedItemIds.has(item.id)"
                  @change="toggleItem(item.id)"
                />
              </div>

              <div class="item-main">
                <div class="item-headline">
                  <span class="item-name">{{ item.name }}</span>
                  <el-tag size="small" type="info" class="item-size-tag">{{ item.sizeDisplay }}</el-tag>
                </div>

                <div class="item-path" :title="item.path">
                  <code>{{ item.path }}</code>
                </div>

                <div class="item-ai-reason">
                  <span class="ai-label">AI 语义分析：</span>
                  <span class="ai-text">{{ item.reason }}</span>
                </div>

                <div v-if="item.safetyNotice" class="item-safety-notice">
                  <el-icon><WarningFilled /></el-icon>
                  <span>{{ item.safetyNotice }}</span>
                </div>
              </div>

              <div class="item-actions" @click.stop>
                <el-tooltip content="在文件管理器中定位" placement="top">
                  <el-button size="small" circle @click="openFolder(item.path)">
                    <el-icon><FolderOpened /></el-icon>
                  </el-button>
                </el-tooltip>
              </div>
            </div>
          </div>

          <div v-else class="empty-tier">
            本梯队暂无需要处理的异常膨胀文件。
          </div>
        </el-card>
      </div>
    </div>

    <!-- 4. 吸底清理控制条 -->
    <div v-if="selectedCount > 0" class="floating-action-bar">
      <div class="bar-summary">
        <span class="bar-stat">已勾选 <strong>{{ selectedCount }}</strong> 项</span>
        <span class="bar-divider">|</span>
        <span class="bar-size">预计可释放空间：<strong class="highlight-bytes">{{ selectedSizeDisplay }}</strong></span>
      </div>

      <div class="bar-controls">
        <el-radio-group v-model="cleanMode" size="default">
          <el-radio-button value="trash">移至回收站（推荐可撤销）</el-radio-button>
          <el-radio-button value="delete">彻底抹除</el-radio-button>
        </el-radio-group>

        <el-button
          type="danger"
          size="large"
          :loading="cleaning"
          class="clean-button"
          @click="confirmClean"
        >
          <el-icon><DeleteFilled /></el-icon>
          立即安全清理
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.disk-cleaner-view {
  padding-bottom: 90px;
}

/* 磁盘看板 */
.drives-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.drive-card {
  border-radius: 8px;
  background: var(--bg-card, #1e1e24);
  border: 1px solid var(--border-color, #2b2b36);
}

.drive-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.drive-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 16px;
}

.drive-icon {
  font-size: 20px;
  color: var(--el-color-primary, #409eff);
}

.drive-stat {
  margin-bottom: 12px;
}

.stat-main {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.stat-free-num {
  font-size: 28px;
  font-weight: 700;
  color: var(--el-text-color-primary, #fff);
}

.stat-unit {
  font-size: 14px;
  color: var(--el-text-color-secondary, #909399);
}

.stat-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
  margin-top: 2px;
}

/* 扫描卡片 */
.scan-card {
  border-radius: 8px;
  margin-bottom: 24px;
  background: var(--bg-card, #1e1e24);
  border: 1px solid var(--border-color, #2b2b36);
}

.scan-wrapper {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}

.scan-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 6px;
}

.scan-desc {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary, #909399);
  max-width: 600px;
}

.scan-actions {
  display: flex;
  gap: 12px;
}

.glow-button {
  box-shadow: 0 0 14px rgba(64, 158, 255, 0.35);
}

/* 诊断结果 */
.summary-alert {
  border-radius: 8px;
  margin-bottom: 18px;
}

.analysis-meta {
  font-size: 12px;
  opacity: 0.8;
  margin-top: 4px;
}

.tier-card {
  margin-bottom: 20px;
  border-radius: 8px;
}

.tier-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.tier-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tier-badge {
  font-weight: 600;
}

.tier-title {
  font-size: 15px;
  font-weight: 600;
}

.tier-desc {
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
  margin-left: 8px;
}

/* 列表项 */
.items-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.item-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 12px 14px;
  border-radius: 6px;
  border: 1px solid var(--border-color, #2b2b36);
  background: var(--bg-item, rgba(255, 255, 255, 0.02));
  transition: all 0.2s ease;
  cursor: pointer;
}

.item-row:hover {
  background: var(--bg-hover, rgba(255, 255, 255, 0.04));
  border-color: var(--el-color-primary-light-5, #79bbff);
}

.item-row.is-selected {
  background: rgba(64, 158, 255, 0.07);
  border-color: var(--el-color-primary, #409eff);
}

.item-check {
  margin-top: 2px;
}

.item-main {
  flex: 1;
  min-width: 0;
}

.item-headline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.item-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--el-text-color-primary, #fff);
}

.item-size-tag {
  font-weight: 700;
}

.item-path {
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 6px;
}

.item-path code {
  background: rgba(0, 0, 0, 0.2);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
}

.item-ai-reason {
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-regular, #dcdfe6);
  margin-bottom: 4px;
}

.ai-label {
  color: var(--el-color-primary, #409eff);
  font-weight: 600;
}

.item-safety-notice {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--el-color-warning, #e6a23c);
  margin-top: 4px;
}

.empty-tier {
  text-align: center;
  padding: 24px;
  color: var(--el-text-color-secondary, #909399);
  font-size: 13px;
}

/* 吸底操作栏 */
.floating-action-bar {
  position: fixed;
  bottom: 24px;
  left: 260px;
  right: 24px;
  background: rgba(30, 30, 36, 0.95);
  backdrop-filter: blur(12px);
  border: 1px solid var(--border-color, #3b3b4a);
  border-radius: 12px;
  padding: 14px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  z-index: 1000;
  animation: slideUp 0.25s ease-out;
}

@keyframes slideUp {
  from {
    transform: translateY(30px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.bar-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
}

.bar-divider {
  color: var(--border-color, #3b3b4a);
}

.highlight-bytes {
  font-size: 18px;
  color: var(--el-color-danger, #f56c6c);
}

.bar-controls {
  display: flex;
  align-items: center;
  gap: 16px;
}

.clean-button {
  font-weight: 600;
  box-shadow: 0 0 12px rgba(245, 108, 108, 0.35);
}
</style>
