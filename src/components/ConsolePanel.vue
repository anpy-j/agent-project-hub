<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount, watch } from 'vue'
import type { Project, LogChunk, TaskHistory, TaskStat } from '../types'

interface ConsoleLine {
  stream: 'stdout' | 'stderr'
  text: string
}

interface ConsoleTask {
  taskId: string
  projectId: string
  projectName: string
  command: string
  status: TaskHistory['status']
  lines: ConsoleLine[]
  stat: TaskStat | null
  restarts: number
  autoScroll: boolean
}

const STORAGE_SPLIT_KEY = 'project-hub.console.split'

const visible = ref(false)
const tasks = ref<ConsoleTask[]>([])
const activeTaskId = ref('')
const splitMode = ref<'1' | '2'>(
  (localStorage.getItem(STORAGE_SPLIT_KEY) as '1' | '2') || '1'
)
let timer: ReturnType<typeof setInterval> | null = null
const paneRefs = new Map<string, HTMLElement>()

const activeTask = computed(() => tasks.value.find((t) => t.taskId === activeTaskId.value) || null)

const paneTasks = computed<ConsoleTask[]>(() => {
  if (!activeTask.value) return []
  if (splitMode.value === '1' || tasks.value.length < 2) return [activeTask.value]
  const other = tasks.value.find((t) => t.taskId !== activeTaskId.value)
  return other ? [activeTask.value, other] : [activeTask.value]
})

watch(visible, (v) => {
  if (v) startStatsLoop()
  else stopStatsLoop()
})

watch(tasks, startStatsLoop, { deep: true })

function startStatsLoop(): void {
  if (timer) return
  pollStats()
  timer = setInterval(pollStats, 3000)
}

function stopStatsLoop(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

async function pollStats(): Promise<void> {
  const hasRunning = tasks.value.some((t) => t.status === 'running')
  if (!hasRunning) return
  try {
    const stats = await window.api.runner.stats()
    for (const s of stats) {
      const entry = tasks.value.find((t) => t.taskId === s.taskId)
      if (entry) entry.stat = s
    }
  } catch {
    // ignore
  }
}

function ensureEntry(taskId: string, projectId = '', projectName = '', command = ''): ConsoleTask {
  let entry = tasks.value.find((t) => t.taskId === taskId)
  if (!entry) {
    entry = {
      taskId,
      projectId,
      projectName: projectName || '任务',
      command,
      status: 'running',
      lines: [],
      stat: null,
      restarts: 0,
      autoScroll: true
    }
    tasks.value.push(entry)
  }
  return entry
}

function attach(taskId: string, project: Project, command = ''): void {
  const entry = ensureEntry(taskId, project.id, project.display_name || project.name, command)
  entry.projectId = project.id
  entry.projectName = project.display_name || project.name
  if (command) entry.command = command
  entry.status = 'running'
  entry.lines = []
  entry.restarts = 0
  activeTaskId.value = taskId
  visible.value = true
  nextTick(scrollActive)
}

function show() {
  visible.value = true
}

function append(chunk: LogChunk): void {
  const entry = tasks.value.find((t) => t.taskId === chunk.taskId)
  if (!entry) return
  if (chunk.data.includes('[自动重启] 正在重启')) entry.restarts += 1
  entry.lines.push({ stream: chunk.stream, text: chunk.data })
  if (entry.lines.length > 5000) entry.lines.splice(0, 1000)
  if (visible.value && entry.autoScroll) nextTick(() => scrollToPane(entry!.taskId))
}

function onStatus(task: TaskHistory): void {
  const entry = tasks.value.find((t) => t.taskId === task.id)
  if (!entry) return
  entry.status = task.status
}

function scrollToPane(taskId: string): void {
  const el = paneRefs.get(taskId)
  if (el) el.scrollTop = el.scrollHeight
}

function scrollActive(): void {
  const t = activeTask.value
  if (t) scrollToPane(t.taskId)
}

function onPaneScroll(task: ConsoleTask, e: Event): void {
  const el = e.target as HTMLElement
  task.autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

function onTabClick(taskId: string): void {
  activeTaskId.value = taskId
  const entry = tasks.value.find((t) => t.taskId === taskId)
  if (entry) {
    entry.autoScroll = true
    nextTick(scrollActive)
  }
}

function closeTab(task: ConsoleTask): void {
  tasks.value = tasks.value.filter((t) => t.taskId !== task.taskId)
  if (activeTaskId.value === task.taskId) {
    activeTaskId.value = tasks.value[0]?.taskId || ''
  }
}

async function stopTask(task: ConsoleTask): Promise<void> {
  try {
    await window.api.runner.stop(task.taskId)
  } catch {
    // ignore
  }
}

function setSplit(mode: '1' | '2'): void {
  splitMode.value = mode
  localStorage.setItem(STORAGE_SPLIT_KEY, mode)
}

const statusLabel: Record<string, string> = {
  running: '运行中',
  success: '已成功退出',
  failed: '异常退出',
  stopped: '已停止'
}
const statusColor: Record<string, string> = {
  running: 'var(--el-color-warning)',
  success: 'var(--el-color-success)',
  failed: 'var(--el-color-danger)',
  stopped: 'var(--el-color-info)'
}

function fmtStat(t: ConsoleTask): string {
  if (t.status !== 'running' || !t.stat) return '-'
  return `CPU ${t.stat.cpu.toFixed(1)}% · 内存 ${t.stat.mem}MB · 进程 ${t.stat.procs}`
}

onBeforeUnmount(stopStatsLoop)

defineExpose({ attach, show, append, onStatus })
</script>

<template>
  <el-drawer
    v-model="visible"
    direction="btt"
    size="46%"
    :with-header="false"
    class="console-drawer"
  >
    <div class="console-shell">
      <div class="console-side">
        <div class="side-title">
          <span>运行控制台</span>
          <div class="side-actions">
            <el-tooltip content="单栏 / 双栏分屏" placement="top">
              <el-button
                size="small"
                text
                @click="setSplit(splitMode === '1' ? '2' : '1')"
              >
                <el-icon><component :is="splitMode === '1' ? 'CopyDocument' : 'Grid'" /></el-icon>
                {{ splitMode === '1' ? '单栏' : '双栏' }}
              </el-button>
            </el-tooltip>
          </div>
        </div>
        <div class="tab-list">
          <div
            v-for="t in tasks"
            :key="t.taskId"
            :class="['tab-item', { active: t.taskId === activeTaskId, running: t.status === 'running' }]"
            @click="onTabClick(t.taskId)"
          >
            <span class="dot" :style="{ background: statusColor[t.status] }" />
            <div class="tab-info">
              <div class="tab-name">
                {{ t.projectName }}
                <span v-if="t.restarts > 0" class="pill is-warn">重启 ×{{ t.restarts }}</span>
              </div>
              <div class="tab-cmd">{{ t.command || '—' }}</div>
            </div>
            <el-button
              v-if="t.status === 'running'"
              size="small"
              text
              type="danger"
              @click.stop="stopTask(t)"
            >
              停止
            </el-button>
            <el-button size="small" text @click.stop="closeTab(t)">
              <el-icon><Close /></el-icon>
            </el-button>
          </div>
          <div v-if="!tasks.length" class="tab-empty">暂无任务，启动项目后这里会显示实时日志</div>
        </div>
      </div>

      <div :class="['console-body', { split: paneTasks.length > 1 }]">
        <div
          v-for="t in paneTasks"
          :key="t.taskId"
          class="console-pane"
        >
          <div :class="['pane-head', { running: t.status === 'running' }]">
            <span class="dot" :style="{ background: statusColor[t.status] }" />
            <b>{{ t.projectName }}</b>
            <span class="pane-status">{{ statusLabel[t.status] }}</span>
            <span class="pane-stat mono">{{ fmtStat(t) }}</span>
          </div>
          <div
            :ref="(el) => { if (el) paneRefs.set(t.taskId, el as HTMLElement) }"
            class="pane-log terminal"
            @scroll="(e: Event) => onPaneScroll(t, e)"
          >
            <div v-for="(line, i) in t.lines" :key="i" :class="line.stream">{{ line.text }}</div>
            <div v-if="!t.lines.length" class="terminal-empty">暂无日志输出</div>
          </div>
        </div>
        <div v-if="!paneTasks.length" class="console-placeholder">
          <el-empty description="从项目列表启动任务后，可在这里查看多任务日志" :image-size="80" />
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.console-shell {
  height: 100%;
  display: flex;
  gap: 12px;
  overflow: hidden;
}
.console-side {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--el-border-color-light);
  padding-right: 12px;
}
.side-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  margin-bottom: 10px;
  color: var(--el-text-color-primary);
}
.tab-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tab-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color var(--ph-dur) var(--ph-ease),
    background-color var(--ph-dur) var(--ph-ease);
}
.tab-item:hover {
  border-color: var(--el-color-primary-light-5);
}
.tab-item.active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.tab-info {
  flex: 1;
  min-width: 0;
}
.tab-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 13px;
  color: var(--el-text-color-primary);
}
.tab-cmd {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab-empty {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  text-align: center;
  margin-top: 24px;
}
.console-body {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 10px;
}
.console-body.split {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.console-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  overflow: hidden;
}
.pane-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--el-border-color-light);
  background: var(--el-fill-color-light);
  font-size: 13px;
  color: var(--el-text-color-primary);
}
.pane-status {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.pane-stat {
  margin-left: auto;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-color-info);
  flex-shrink: 0;
}
.tab-item.running .dot,
.pane-head.running .dot {
  animation: blink 1.2s infinite;
}
@keyframes blink {
  50% { opacity: 0.25; }
}
.pane-log {
  flex: 1;
  border: none;
  border-radius: 0;
  padding: 10px 12px;
}
.console-placeholder {
  color: var(--el-text-color-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 100%;
}
</style>
