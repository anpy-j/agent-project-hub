<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useWorkspaceStore } from '../stores/workspace'
import { useProjectStore } from '../stores/project'
import type { Project, LogChunk, RunSuggestion, TaskHistory } from '../types'
import ConsolePanel from '../components/ConsolePanel.vue'
import AddProjectDialog from '../components/AddProjectDialog.vue'
import { onHotkey } from '../composables/hotkeys'

const router = useRouter()
const workspaceStore = useWorkspaceStore()
const projectStore = useProjectStore()

const addDialogVisible = ref(false)
const runningTasks = ref<Record<string, string>>({}) // projectId -> taskId
const consolePanelRef = ref<InstanceType<typeof ConsolePanel> | null>(null)

const viewMode = ref<'table' | 'card'>('table')
const keyword = ref('')
const searchInputRef = ref<{ focus: () => void } | null>(null)
const platformFilter = ref('all')
const stageFilter = ref<'all' | 'developing' | 'released'>('all')
const tagFilter = ref<string[]>([])
const groupBy = ref<'none' | 'type' | 'tag'>('none')
const sortBy = ref<'recent' | 'name' | 'progress'>('recent')

const filteredProjects = computed(() =>
  workspaceStore.currentId
    ? projectStore.projects.filter((p) => p.workspace_id === workspaceStore.currentId)
    : projectStore.projects
)

const allTags = computed(() => {
  const set = new Set<string>()
  for (const p of filteredProjects.value) {
    for (const t of p.tags || []) set.add(t)
  }
  return [...set].sort()
})

const baseRows = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  const rows = filteredProjects.value.filter((p) => {
    if (platformFilter.value === 'linked' && !(p.remotes && p.remotes.length)) return false
    if (platformFilter.value === 'local' && p.remotes && p.remotes.length) return false
    if (stageFilter.value === 'developing' && (p.progress_percent || 0) === 0) return false
    if (stageFilter.value === 'released' && p.progress_stage !== 'released') return false
    if (tagFilter.value.length && !tagFilter.value.every((t) => (p.tags || []).includes(t))) return false
    if (!k) return true
    return (
      p.name.toLowerCase().includes(k) ||
      p.path.toLowerCase().includes(k) ||
      (p.tags || []).some((t) => t.toLowerCase().includes(k)) ||
      (p.remotes || []).some((r) => r.url.toLowerCase().includes(k))
    )
  })
  const sorted = [...rows]
  if (sortBy.value === 'name') sorted.sort((a, b) => displayName(a).localeCompare(displayName(b)))
  else if (sortBy.value === 'progress')
    sorted.sort((a, b) => (b.progress_percent || 0) - (a.progress_percent || 0))
  else
    sorted.sort(
      (a, b) =>
        new Date(b.last_run_at || b.updated_at).getTime() -
        new Date(a.last_run_at || a.updated_at).getTime()
    )
  return sorted
})

interface Group {
  key: string
  label: string
  rows: Project[]
}

const visibleGroups = computed<Group[]>(() => {
  if (groupBy.value === 'none') return [{ key: 'all', label: '', rows: baseRows.value }]
  if (groupBy.value === 'type') {
    const map = new Map<string, Project[]>()
    for (const p of baseRows.value) {
      const key = p.type
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(p)
    }
    return [...map.entries()]
      .sort((a, b) => (typeLabel[a[0]] || a[0]).localeCompare(typeLabel[b[0]] || b[0]))
      .map(([key, rows]) => ({ key, label: typeLabel[key] || key, rows }))
  }
  const map = new Map<string, Project[]>()
  for (const p of baseRows.value) {
    const tags = p.tags?.length ? p.tags : ['未打标签']
    for (const tag of tags) {
      if (!map.has(tag)) map.set(tag, [])
      map.get(tag)!.push(p)
    }
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, rows]) => ({ key, label: key, rows }))
})

const activeCount = computed(() => filteredProjects.value.filter((p) => (p.progress_percent || 0) > 0).length)
const linkedCount = computed(() => filteredProjects.value.filter((p) => p.remotes && p.remotes.length).length)
const runningCount = computed(() => Object.keys(runningTasks.value).length)

const stats = computed(() => [
  { label: '项目总数', value: String(filteredProjects.value.length), icon: 'Folder', tone: 'primary' },
  { label: '开发中项目', value: String(activeCount.value), icon: 'TrendCharts', tone: 'success' },
  { label: '已关联远程', value: String(linkedCount.value), icon: 'Link', tone: 'warning' },
  { label: '运行中任务', value: String(runningCount.value), icon: 'VideoPlay', tone: 'info' }
])

onMounted(async () => {
  if (!workspaceStore.list.length) await workspaceStore.load()
  await projectStore.load(workspaceStore.currentId || undefined)
})

watch(
  () => workspaceStore.currentId,
  () => {
    projectStore.load(workspaceStore.currentId || undefined)
  }
)

const typeLabel: Record<string, string> = {
  'java-maven': 'Java · Maven',
  'java-gradle': 'Java · Gradle',
  python: 'Python',
  flutter: 'Flutter',
  vue: 'Vue',
  react: 'React',
  node: 'Node',
  unknown: '未知'
}
const typeColor: Record<string, string> = {
  'java-maven': '#e76f00',
  'java-gradle': '#02303a',
  python: '#3776ab',
  flutter: '#02569b',
  vue: '#42b883',
  react: '#61dafb',
  node: '#5fa04e',
  unknown: '#909399'
}
const stageLabel: Record<string, string> = {
  planning: '规划中',
  developing: '开发中',
  testing: '联调测试',
  released: '已发布'
}

function platformLabel(p: Project): string {
  const r = (p.remotes || [])[0]?.platform
  return r === 'github' ? 'GitHub' : r === 'gitee' ? 'Gitee' : r === 'gitlab' ? 'GitLab' : r ? 'Git' : '仅本地'
}

/** 列表主标题：优先显示中文名称，未设置时用原名称 */
function displayName(p: Project): string {
  return p.display_name || p.name
}

/** 英文项目名：优先取目录名，其次远程仓库名；与展示名相同则不再重复展示 */
function englishName(p: Project): string {
  const segs = p.path.split('/').filter(Boolean)
  let en = segs[segs.length - 1] || ''
  if (!en) {
    const url = (p.remotes || [])[0]?.url || ''
    const m = url.match(/\/([^/]+?)(\.git)?$/)
    if (m) en = m[1]
  }
  const shown = displayName(p)
  if (!en || en.toLowerCase() === shown.toLowerCase()) return ''
  return en
}

function timeAgo(iso: string | null): string {
  if (!iso) return '-'
  const t = iso.includes('T') ? new Date(iso).getTime() : new Date(iso.replace(' ', 'T') + 'Z').getTime()
  if (isNaN(t)) return '-'
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  return d < 30 ? `${d} 天前` : new Date(t).toLocaleDateString()
}

function onRowMenu(cmd: string, row: Project) {
  if (cmd === 'finder') {
    openInFinder(row)
  } else if (cmd === 'remove') {
    removeProject(row)
  }
}

const runDialog = ref(false)
const runTarget = ref<Project | null>(null)
const runCmdList = ref<RunSuggestion[]>([])
const runCmdLoading = ref(false)

async function openRunDialog(p: Project) {
  runTarget.value = p
  runDialog.value = true
  runCmdLoading.value = true
  try {
    runCmdList.value = await window.api.project.runCommands(p.id)
  } catch {
    runCmdList.value = []
  } finally {
    runCmdLoading.value = false
  }
}

async function startWith(c: RunSuggestion) {
  if (!runTarget.value) return
  try {
    const payload = JSON.parse(JSON.stringify({ bin: c.bin, args: c.args, display: c.cmd }))
    const taskId = await window.api.runner.startCustom(runTarget.value.id, payload)
    runningTasks.value[runTarget.value.id] = taskId
    consolePanelRef.value?.attach(taskId, runTarget.value, c.cmd)
    runDialog.value = false
    ElMessage.success(`已启动：${c.cmd}`)
  } catch (e) {
    ElMessage.error(`启动失败: ${(e as Error).message}`)
  }
}

function openAdd() {
  addDialogVisible.value = true
}

async function onAdded() {
  await projectStore.load(workspaceStore.currentId || undefined)
}

async function runProject(project: Project) {
  try {
    const taskId = await window.api.runner.start(project.id)
    runningTasks.value[project.id] = taskId
    consolePanelRef.value?.attach(taskId, project)
  } catch (e) {
    ElMessage.error(`启动失败: ${(e as Error).message}`)
  }
}

async function stopProject(project: Project) {
  const taskId = runningTasks.value[project.id]
  if (!taskId) return
  await window.api.runner.stop(taskId)
}

async function removeProject(project: Project) {
  await ElMessageBox.confirm(`确定删除项目「${project.name}」？`, '删除', {
    type: 'warning'
  })
  await window.api.project.remove(project.id)
  await projectStore.load(workspaceStore.currentId || undefined)
  ElMessage.success('已删除')
}

function openInFinder(project: Project) {
  window.api.system.openPath(project.path)
}

window.api.runner.onStatus((task: TaskHistory) => {
  if (task.status === 'running') {
    runningTasks.value[task.project_id] = task.id
  } else {
    delete runningTasks.value[task.project_id]
    if (task.status === 'failed') {
      ElMessage.error(`任务结束: ${task.status}`)
    }
  }
  consolePanelRef.value?.onStatus(task)
})

window.api.runner.onLog((chunk: LogChunk) => {
  consolePanelRef.value?.append(chunk)
})

onHotkey('focus-search', () => searchInputRef.value?.focus())
onHotkey('new-project', openAdd)
</script>

<template>
  <div class="project-list-view">
    <!-- 页头 -->
    <div class="page-head">
      <div>
        <h2>项目列表</h2>
        <p class="head-sub">
          共 {{ filteredProjects.length }} 个项目
          <el-tag v-if="workspaceStore.currentId" type="info" size="small" effect="plain">
            {{ workspaceStore.list.find((w) => w.id === workspaceStore.currentId)?.name }}
          </el-tag>
        </p>
      </div>
      <div class="head-actions">
        <el-input
          ref="searchInputRef"
          v-model="keyword"
          placeholder="搜索名称 / 路径 / 标签 / 仓库地址"
          clearable
          class="search-input"
        >
          <template #prefix><el-icon><Search /></el-icon></template>
          <template #suffix>
            <el-tooltip content="快捷键 ⌘K" placement="top">
              <span class="kbd-hint">⌘K</span>
            </el-tooltip>
          </template>
        </el-input>
        <el-button @click="consolePanelRef?.show()">
          <el-icon><Monitor /></el-icon>控制台
          <el-badge v-if="runningCount" :value="runningCount" class="console-badge" />
        </el-button>
        <el-button type="primary" @click="openAdd">
          <el-icon><Plus /></el-icon>添加项目
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

    <!-- 工具条 -->
    <div class="filter-bar">
      <el-radio-group v-model="platformFilter" size="small">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="linked">已关联远程</el-radio-button>
        <el-radio-button value="local">仅本地</el-radio-button>
      </el-radio-group>
      <el-radio-group v-model="stageFilter" size="small">
        <el-radio-button value="all">全部阶段</el-radio-button>
        <el-radio-button value="developing">开发中</el-radio-button>
        <el-radio-button value="released">已发布</el-radio-button>
      </el-radio-group>
      <el-select
        v-model="tagFilter"
        multiple
        collapse-tags
        collapse-tags-tooltip
        clearable
        placeholder="按标签筛选"
        size="small"
        style="width: 180px"
      >
        <el-option v-for="t in allTags" :key="t" :label="t" :value="t" />
      </el-select>
      <el-select v-model="groupBy" size="small" style="width: 130px">
        <el-option label="不分组" value="none" />
        <el-option label="按类型分组" value="type" />
        <el-option label="按标签分组" value="tag" />
      </el-select>
      <el-select v-model="sortBy" size="small" style="width: 130px">
        <el-option label="最近活动排序" value="recent" />
        <el-option label="按名称排序" value="name" />
        <el-option label="按进度排序" value="progress" />
      </el-select>
      <span class="flex-1" />
      <el-radio-group v-model="viewMode" size="small">
        <el-tooltip content="表格视图" placement="top">
          <el-radio-button value="table"><el-icon><Menu /></el-icon></el-radio-button>
        </el-tooltip>
        <el-tooltip content="卡片视图" placement="top">
          <el-radio-button value="card"><el-icon><Grid /></el-icon></el-radio-button>
        </el-tooltip>
      </el-radio-group>
    </div>

    <!-- 表格视图（企业级默认） -->
    <div v-if="viewMode === 'table'" class="table-scroll">
      <template v-for="g in visibleGroups" :key="g.key">
        <div v-if="g.label" class="group-head">
          <span class="group-name">{{ g.label }}</span>
          <span class="group-count">{{ g.rows.length }} 个项目</span>
        </div>
        <el-card class="table-card" shadow="never">
          <el-table
            :data="g.rows"
            style="width: 100%"
            :header-cell-style="{ background: 'var(--el-fill-color-light)', color: 'var(--el-text-color-secondary)', fontWeight: 600 }"
            empty-text="暂无项目，点击右上角添加"
            @row-click="(row: unknown) => router.push(`/projects/${(row as Project).id}`)"
          >
            <el-table-column label="项目" min-width="240">
              <template #default="{ row }">
                <div class="cell-project">
                  <div class="proj-name">
                    <span class="proj-title">{{ displayName(row as Project) }}</span>
                    <span v-if="englishName(row as Project)" class="proj-en">({{ englishName(row as Project) }})</span>
                    <el-tag size="small" :style="{ backgroundColor: typeColor[row.type], color: '#fff', border: 'none' }">
                      {{ typeLabel[row.type] }}
                    </el-tag>
                    <el-tag v-if="row.framework" size="small" effect="plain">{{ row.framework }}</el-tag>
                    <el-tag v-for="tag in (row.tags || []).slice(0, 3)" :key="tag" size="small" type="warning" effect="plain">
                      {{ tag }}
                    </el-tag>
                  </div>
                  <div class="proj-path">{{ row.path }}</div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="远程仓库" min-width="180">
              <template #default="{ row }">
                <div v-if="(row as Project).remotes && (row as Project).remotes!.length" class="cell-remote">
                  <el-tag size="small" effect="plain">{{ platformLabel(row as Project) }}</el-tag>
                  <span class="remote-text" :title="(row as Project).remotes![0].url">{{ (row as Project).remotes![0].url }}</span>
                </div>
                <span v-else class="cell-muted">仅本地</span>
              </template>
            </el-table-column>
            <el-table-column label="开发进度" width="180">
              <template #default="{ row }">
                <div class="cell-progress">
                  <el-progress
                    :percentage="row.progress_percent || 0"
                    :stroke-width="6"
                    :show-text="false"
                    class="progress"
                  />
                  <span class="progress-num">{{ row.progress_percent || 0 }}%</span>
                </div>
                <span class="stage-text">{{ stageLabel[row.progress_stage] || '规划中' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <span v-if="runningTasks[row.id]" class="state-chip is-running"><span class="dot" />运行中</span>
                <span v-else-if="!row.remotes?.length" class="state-chip is-muted"><span class="dot" />未关联</span>
                <span v-else class="state-chip is-ok"><span class="dot" />正常</span>
              </template>
            </el-table-column>
            <el-table-column label="最近活动" width="120">
              <template #default="{ row }">
                <span class="cell-time">{{ timeAgo(row.last_run_at || row.updated_at) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="230" align="right">
              <template #default="{ row }">
                <div class="cell-actions" @click.stop>
                  <el-button
                    v-if="!runningTasks[row.id]"
                    type="primary"
                    size="small"
                    @click.stop="openRunDialog(row as Project)"
                  >
                    运行
                  </el-button>
                  <el-button v-else type="danger" size="small" @click.stop="stopProject(row as Project)">
                    停止
                  </el-button>
                  <el-button size="small" @click.stop="router.push(`/projects/${(row as Project).id}`)">详情</el-button>
                  <el-dropdown trigger="click" @command="(cmd: string) => onRowMenu(cmd, row as Project)">
                    <el-button size="small" @click.stop>
                      <el-icon><MoreFilled /></el-icon>
                    </el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item command="finder">打开目录</el-dropdown-item>
                        <el-dropdown-item command="remove" divided>删除项目</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </template>
    </div>

    <!-- 卡片视图 -->
    <div v-else class="card-scroll">
      <template v-for="g in visibleGroups" :key="g.key">
        <div v-if="g.label" class="group-head">
          <span class="group-name">{{ g.label }}</span>
          <span class="group-count">{{ g.rows.length }} 个项目</span>
        </div>
        <div class="project-grid">
          <el-card
            v-for="p in g.rows"
            :key="p.id"
            class="project-card"
            shadow="never"
            :style="{ '--card-accent': typeColor[p.type] || '#909399' }"
            @click="router.push(`/projects/${p.id}`)"
          >
            <div class="card-head">
              <div class="name">
                {{ displayName(p) }}
                <span v-if="englishName(p)" class="proj-en">({{ englishName(p) }})</span>
              </div>
              <el-tag
                size="small"
                :style="{ backgroundColor: typeColor[p.type], color: '#fff', border: 'none' }"
              >
                {{ typeLabel[p.type] }}
              </el-tag>
            </div>
            <div v-if="p.tags?.length" class="card-tags">
              <el-tag v-for="tag in p.tags.slice(0, 3)" :key="tag" size="small" type="warning" effect="plain">{{ tag }}</el-tag>
            </div>
            <div class="path" :title="p.path" @click.stop="openInFinder(p)">
              <el-icon><FolderOpened /></el-icon>
              <span>{{ p.path }}</span>
            </div>
            <div class="card-progress">
              <el-progress
                :percentage="p.progress_percent || 0"
                :stroke-width="6"
                :show-text="false"
                class="progress"
              />
              <span class="progress-num">{{ p.progress_percent || 0 }}%</span>
              <span class="stage-chip">{{ stageLabel[p.progress_stage] || '规划中' }}</span>
            </div>
            <div class="card-foot">
              <span class="cell-time">{{ timeAgo(p.last_run_at || p.updated_at) }}</span>
              <div class="actions">
                <el-button
                  v-if="!runningTasks[p.id]"
                  type="primary"
                  size="small"
                  @click.stop="openRunDialog(p)"
                >
                  <el-icon><VideoPlay /></el-icon>运行
                </el-button>
                <el-button v-else type="danger" size="small" @click.stop="stopProject(p)">
                  <el-icon><VideoPause /></el-icon>停止
                </el-button>
                <el-button size="small" @click.stop="router.push(`/projects/${p.id}`)">详情</el-button>
                <el-dropdown trigger="click" @command="(cmd: string) => onRowMenu(cmd, p)">
                  <el-button size="small" @click.stop>
                    <el-icon><MoreFilled /></el-icon>
                  </el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="finder">打开目录</el-dropdown-item>
                      <el-dropdown-item command="remove" divided>删除项目</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </div>
          </el-card>
          <div class="add-card" @click="openAdd">
            <div class="add-icon"><el-icon :size="22"><Plus /></el-icon></div>
            <span class="add-title">添加项目</span>
            <span class="add-sub">本地路径 + 关联仓库，一键纳管</span>
          </div>
        </div>
      </template>
    </div>

    <ConsolePanel ref="consolePanelRef" />

    <AddProjectDialog
      v-model:visible="addDialogVisible"
      :workspace-id="workspaceStore.currentId"
      @added="onAdded"
    />

    <!-- 运行命令选择 -->
    <el-dialog v-model="runDialog" title="选择运行命令" width="560">
      <div v-loading="runCmdLoading" class="run-cmd-list">
        <div
          v-for="c in runCmdList"
          :key="c.cmd"
          class="run-cmd-row"
          @click="startWith(c)"
        >
          <span class="mono">{{ c.cmd }}</span>
          <el-tag v-if="c.custom" size="small" type="info">自定义</el-tag>
          <el-button size="small" type="primary">启动</el-button>
        </div>
        <el-empty v-if="!runCmdList.length && !runCmdLoading" description="未识别到运行命令" :image-size="60" />
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.project-list-view {
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
  display: flex;
  align-items: center;
  gap: 8px;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.search-input {
  width: 300px;
}
.kbd-hint {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  padding: 0 4px;
}
.console-badge {
  margin-left: 6px;
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
  padding: 18px 20px;
  display: flex;
  align-items: center;
  gap: 14px;
  box-shadow: var(--ph-shadow-soft);
  transition: box-shadow 0.18s ease, transform 0.18s ease;
}
.stat-card:hover {
  box-shadow: var(--ph-shadow-lift, 0 12px 40px rgba(15, 23, 42, 0.08));
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
.tone-warning {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}
.tone-info {
  background: var(--el-color-info-light-9);
  color: var(--el-color-info);
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
.table-scroll,
.card-scroll {
  flex: 1;
  overflow-y: auto;
  padding-bottom: 40px;
}
.group-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 14px 2px 8px;
}
.group-name {
  font-weight: 700;
  font-size: 14px;
  color: var(--el-text-color-primary);
}
.group-count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.table-card {
  overflow: hidden;
  margin-bottom: 8px;
  border-radius: 12px;
}
.table-card :deep(.el-table__row) {
  cursor: pointer;
}
.cell-project {
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: pointer;
}
.proj-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  flex-wrap: wrap;
}
.proj-title {
  white-space: nowrap;
}
.proj-en {
  font-size: 11px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.proj-path {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
}
.cell-remote {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.remote-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 150px;
}
.cell-progress {
  display: flex;
  align-items: center;
  gap: 8px;
}
.progress {
  flex: 1;
}
.progress-num {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  width: 36px;
}
.stage-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.cell-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
.state-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 999px;
  padding: 3px 10px;
  white-space: nowrap;
}
.state-chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.state-chip.is-ok {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}
.state-chip.is-ok .dot { background: var(--el-color-success); }
.state-chip.is-running {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
  font-weight: 600;
}
.state-chip.is-running .dot {
  background: var(--el-color-warning);
  animation: blink 1.2s infinite;
}
.state-chip.is-muted {
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
}
.state-chip.is-muted .dot { background: var(--el-text-color-placeholder); }
@keyframes blink {
  50% { opacity: 0.25; }
}
.text-muted {
  color: var(--el-text-color-secondary);
}
.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  align-content: start;
}
.add-card {
  border: 2px dashed var(--el-border-color);
  border-radius: 12px;
  min-height: 180px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  color: var(--el-text-color-secondary);
  transition: border-color 0.18s ease, color 0.18s ease, background-color 0.18s ease;
}
.add-card:hover {
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.add-card .add-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  margin-bottom: 4px;
}
.add-card .add-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}
.add-card .add-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.project-card {
  display: flex;
  flex-direction: column;
  cursor: pointer;
  border-top: 3px solid var(--card-accent, var(--el-color-primary));
  transition: box-shadow 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
}
.project-card:hover {
  box-shadow: var(--ph-shadow-lift, 0 12px 40px rgba(15, 23, 42, 0.08));
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.card-tags {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.card-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 0 10px;
}
.card-progress .progress {
  flex: 1;
}
.card-progress .progress-num {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  width: 36px;
  font-variant-numeric: tabular-nums;
}
.card-progress .stage-chip {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
  border-radius: 999px;
  padding: 2px 8px;
  white-space: nowrap;
}
.card-foot {
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 10px;
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.card-foot .cell-time {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.name {
  font-weight: 600;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name .proj-en {
  font-size: 11px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.path {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  cursor: pointer;
  margin-bottom: 10px;
  overflow: hidden;
}
.path span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.run-cmd-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}
.run-cmd-row:hover {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.run-cmd-row .mono {
  flex: 1;
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.flex-1 {
  flex: 1;
}
</style>
