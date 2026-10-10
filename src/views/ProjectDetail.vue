<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Edit as EditIcon, RefreshRight, Search, VideoPlay, VideoPause, Share, CircleCheck, Upload, Download } from '@element-plus/icons-vue'
import type { BuildTarget, GitBranch, GitCommit, GitSummary, LogChunk, Project, ProjectArtifact, RunSuggestion, TaskHistory, TaskItem } from '../types'

const route = useRoute()
const router = useRouter()
const projectId = String(route.params.id || '')

const project = ref<Project | null>(null)
const git = ref<GitSummary | null>(null)
const history = ref<TaskHistory[]>([])
const commits = ref<GitCommit[]>([])
const loading = ref(true)
const saving = ref(false)
const savingBasic = ref(false)
const busy = ref('')
// 暂时隐藏开发进度模块，保留实现以便恢复。
const showProgressModule = ref(false)

const progress = ref<{ percent: number; stage: Project['progress_stage']; note: string }>({
  percent: 0,
  stage: 'developing',
  note: ''
})
const editForm = ref({ name: '', description: '' })
const displayNameInput = ref('')
const savingName = ref(false)
const linkForm = ref({ name: 'origin', url: '' })

const branches = ref<GitBranch[]>([])
const selectedBranch = ref('')
const newBranch = ref('')
const branchDialogVisible = ref(false)

const runCommands = ref<RunSuggestion[]>([])
const customCmd = ref('')
const runTask = ref<TaskHistory | null>(null)
const runLogs = ref<string[]>([])
const runLogsText = computed(() => runLogs.value.join(''))
const logBoxRef = ref<HTMLElement | null>(null)
const runTaskId = ref('')
const external = ref<{ running: boolean; processes: Array<{ pid: number; command: string }> }>({
  running: false,
  processes: []
})

const buildTargets = ref<BuildTarget[]>([])
const selectedBuildTargetId = ref('')
const selectedBuildTarget = computed(() => buildTargets.value.find(t => t.id === selectedBuildTargetId.value))
const buildCommand = computed(() => selectedBuildTarget.value?.commands.join(' && ') || '')
const buildEditorVisible = ref(false)
const buildEditor = ref({ id: '', name: '', directory: '.', platform: 'any' as BuildTarget['platform'], commands: '', artifacts: '', image: '', flutterSdk: '', javaHome: '', androidSdk: '' })
const savingBuildTarget = ref(false)
function editBuildTarget(target?: BuildTarget) {
  buildEditor.value = target ? { id: target.id, name: target.name, directory: target.directory, platform: target.platform, commands: target.commands.join('\n'), artifacts: target.artifactPaths.join('\n'), image: target.image || '', flutterSdk: target.flutterSdk || '', javaHome: target.javaHome || '', androidSdk: target.androidSdk || '' } : { id: '', name: '', directory: '.', platform: 'any', commands: '', artifacts: '', image: '', flutterSdk: '', javaHome: '', androidSdk: '' }
  buildEditorVisible.value = true
}
function applyBuildTemplate(template: string) {
  const presets: Record<string, { name: string; platform: BuildTarget['platform']; commands: string; artifacts: string; image?: string }> = {
    electronWin: { name: 'Windows 安装包', platform: 'win32', commands: 'npm run build\nnpx electron-builder --win --publish never', artifacts: 'dist' },
    electronMac: { name: 'macOS 安装包', platform: 'darwin', commands: 'npm run build\nnpx electron-builder --mac --publish never', artifacts: 'dist' },
    flutterWin: { name: 'Flutter Windows', platform: 'win32', commands: 'flutter build windows --release', artifacts: 'build/windows' },
    flutterMac: { name: 'Flutter macOS', platform: 'darwin', commands: 'flutter build macos --release', artifacts: 'build/macos/Build/Products/Release' },
    apk: { name: 'Android APK', platform: 'any', commands: 'flutter build apk --release', artifacts: 'build/app/outputs/flutter-apk' },
    aab: { name: 'Android App Bundle', platform: 'any', commands: 'flutter build appbundle --release', artifacts: 'build/app/outputs/bundle/release' },
    ipa: { name: 'iOS IPA', platform: 'darwin', commands: 'flutter build ipa --release', artifacts: 'build/ios/ipa' },
    docker: { name: 'Docker 构建', platform: 'any', commands: 'docker build --platform linux/amd64 -f Dockerfile -t registry.example.com/team/service:latest .', artifacts: '', image: 'registry.example.com/team/service:latest' },
    dockerPush: { name: 'Docker 构建并上传', platform: 'any', commands: 'docker build --platform linux/amd64 -f Dockerfile -t registry.example.com/team/service:latest .\ndocker push registry.example.com/team/service:latest', artifacts: '', image: 'registry.example.com/team/service:latest' }
  }
  Object.assign(buildEditor.value, presets[template])
}
const flutterCheck = ref<Awaited<ReturnType<typeof window.api.project.flutterEnvironment>> | null>(null)
const checkingFlutter = ref(false)
async function checkFlutterEnvironment() {
  if (!selectedBuildTarget.value) return
  checkingFlutter.value = true; flutterCheck.value = null
  try { flutterCheck.value = await window.api.project.flutterEnvironment(projectId, JSON.parse(JSON.stringify(selectedBuildTarget.value))) }
  catch(e) { ElMessage.error((e as Error).message) }
  finally { checkingFlutter.value = false }
}
async function pickBuildDirectory(field: 'javaHome' | 'androidSdk') {
  const directory = await window.api.system.pickDirectory()
  if (directory) buildEditor.value[field] = directory
}
async function pickFlutterSdk() {
  const directory = await window.api.system.pickDirectory()
  if (directory) buildEditor.value.flutterSdk = directory
}
async function saveBuildTarget() {
  savingBuildTarget.value = true
  try {
    const form = buildEditor.value
    const target: BuildTarget = { id: form.id || crypto.randomUUID(), name: form.name.trim(), directory: form.directory.trim() || '.', platform: form.platform, commands: form.commands.split('\n').map(c => c.trim()).filter(Boolean), artifactPaths: form.artifacts.split('\n').map(c => c.trim()).filter(Boolean), image: form.image.trim() || undefined, flutterSdk: form.flutterSdk.trim() || undefined, javaHome: form.javaHome.trim() || undefined, androidSdk: form.androidSdk.trim() || undefined }
    if (target.flutterSdk && target.commands.some(c => /\bflutter\b/.test(c))) {
      const report = await window.api.project.flutterEnvironment(projectId, JSON.parse(JSON.stringify(target)))
      target.flutterVersion = report.version
    }
    const targets = [...buildTargets.value.filter(t => t.id !== target.id), target]
    await window.api.project.saveBuildTargets(projectId, JSON.parse(JSON.stringify(targets)))
    selectedBuildTargetId.value = target.id
    buildEditorVisible.value = false
    await loadBuildInfo()
    ElMessage.success('构建目标已保存')
  } catch (e) { ElMessage.error((e as Error).message) }
  finally { savingBuildTarget.value = false }
}
async function removeBuildTarget() {
  if (!selectedBuildTarget.value) return
  try {
    await ElMessageBox.confirm(`删除构建目标“${selectedBuildTarget.value.name}”？`, '删除目标', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
    await window.api.project.saveBuildTargets(projectId, JSON.parse(JSON.stringify(buildTargets.value.filter(t => t.id !== selectedBuildTargetId.value))))
    await loadBuildInfo()
  } catch (e) { if (e instanceof Error) ElMessage.error(e.message) }
}
const buildTask = ref<TaskHistory | null>(null)
const buildTaskId = ref('')
const buildLogs = ref<string[]>([])
const buildLogsText = computed(() => buildLogs.value.join(''))
const buildLogBoxRef = ref<HTMLElement | null>(null)
const artifacts = ref<ProjectArtifact[]>([])

const tasks = ref<TaskItem[]>([])
const newTaskTitle = ref('')
const newTaskTag = ref<'feature' | 'bug' | 'chore'>('feature')
const newTaskGroup = ref('')

const taskGroups = computed(() => {
  const map = new Map<string, TaskItem[]>()
  for (const t of tasks.value) {
    const key = t.group_name || ''
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(t)
  }
  return [...map.entries()].map(([key, list]) => ({
    key,
    label: key || '未分组',
    active: list.filter((t) => !t.done),
    done: list.filter((t) => t.done)
  }))
})

const existingGroups = computed(() =>
  [...new Set(tasks.value.map((t) => t.group_name || '').filter(Boolean))].sort()
)

const editTaskVisible = ref(false)
const editTaskForm = ref<{ id: string; title: string; tag: 'feature' | 'bug' | 'chore'; group_name: string }>({
  id: '',
  title: '',
  tag: 'feature',
  group_name: ''
})

const autoRestart = ref(false)

function openEditTask(t: TaskItem) {
  editTaskForm.value = {
    id: t.id,
    title: t.title,
    tag: t.tag,
    group_name: t.group_name || ''
  }
  editTaskVisible.value = true
}

async function saveEditTask() {
  const f = editTaskForm.value
  if (!f.title.trim()) {
    ElMessage.warning('请填写任务标题')
    return
  }
  try {
    await window.api.project.tasks.update(f.id, {
      title: f.title,
      tag: f.tag,
      group_name: f.group_name || null
    })
    editTaskVisible.value = false
    await loadTasks()
    ElMessage.success('任务已更新')
  } catch (e) {
    ElMessage.error(String((e as Error).message || e))
  }
}

async function moveTask(t: TaskItem, dir: -1 | 1) {
  const siblings = tasks.value.filter(
    (x) => (x.group_name || '') === (t.group_name || '') && !!x.done === !!t.done
  )
  const idx = siblings.findIndex((x) => x.id === t.id)
  const swapWith = siblings[idx + dir]
  if (!swapWith) return
  const ordered = tasks.value.map((x) => x.id)
  const i = ordered.indexOf(t.id)
  const j = ordered.indexOf(swapWith.id)
  ;[ordered[i], ordered[j]] = [ordered[j], ordered[i]]
  try {
    tasks.value = await window.api.project.tasks.reorder(projectId, ordered)
  } catch (e) {
    ElMessage.error(String((e as Error).message || e))
  }
}

async function loadAutoRestart() {
  try {
    autoRestart.value = await window.api.project.getAutoRestart(projectId)
  } catch {
    autoRestart.value = false
  }
}

async function toggleAutoRestart(enabled: boolean | string | number) {
  try {
    autoRestart.value = await window.api.project.setAutoRestart(projectId, !!enabled)
    ElMessage.success(autoRestart.value ? '已开启崩溃自动重启（对新启动任务生效）' : '已关闭崩溃自动重启')
  } catch (e) {
    ElMessage.error(String((e as Error).message || e))
  }
}

const selectedChanges = ref<Set<string>>(new Set())
const commitMessage = ref('')
const changeGroups = computed(() => {
  const changes = git.value?.changes || []
  const conflicts = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
  return [
    {
      key: 'staged', title: '已暂存', empty: '暂无已暂存变更',
      files: changes.filter(f => !!f.indexStatus && f.indexStatus !== '?' && !conflicts.has(f.status))
        .map(f => ({ ...f, displayStatus: f.indexStatus }))
    },
    {
      key: 'unstaged', title: '未暂存', empty: '暂无未暂存变更',
      files: changes.filter(f => !!f.worktreeStatus || conflicts.has(f.status))
        .map(f => ({ ...f, displayStatus: conflicts.has(f.status) ? '冲突' : f.status === '??' ? '未跟踪' : f.worktreeStatus }))
    }
  ]
})

async function load() {
  loading.value = true
  try {
    let detail = await window.api.project.detail(projectId)
    if (!detail.remotes?.length) {
      try {
        await window.api.project.syncRemotes(projectId)
        detail = await window.api.project.detail(projectId)
      } catch {
        // 忽略
      }
    }
    project.value = detail
    git.value = detail.git
    const changedPaths = new Set(detail.git.changes.map((change) => change.path))
    selectedChanges.value = new Set([...selectedChanges.value].filter((path) => changedPaths.has(path)))
    history.value = detail.history || []
    progress.value = {
      percent: detail.progress_percent || 0,
      stage: (detail.progress_stage || 'planning') as Project['progress_stage'],
      note: detail.progress_note || ''
    }
    editForm.value = { name: detail.name, description: detail.description || '' }
    displayNameInput.value = detail.display_name || ''
  } catch (e) {
    ElMessage.error(`加载失败: ${(e as Error).message}`)
  } finally {
    loading.value = false
  }
}

async function loadCommits() {
  try {
    commits.value = await window.api.git.log(projectId, 20)
  } catch {
    commits.value = []
  }
}

const gitRefreshing = ref(false)
const gitWatchError = ref('')
let gitRefreshPending = false
let gitRefreshPromise: Promise<void> | undefined
let disposed = false
let stopGitEvents: (() => void) | undefined
let gitWatchToken = ''

function refreshGit(): Promise<void> {
  gitRefreshPending = true
  if (gitRefreshPromise) return gitRefreshPromise
  gitRefreshing.value = true
  gitRefreshPromise = (async () => {
    while (gitRefreshPending && !disposed) {
      gitRefreshPending = false
      try {
        const [summary, log, branchList] = await Promise.all([
          window.api.git.summary(projectId), window.api.git.log(projectId, 20), window.api.git.branches(projectId)
        ])
        if (disposed) return
        git.value = summary
        commits.value = log
        branches.value = branchList
        selectedBranch.value = branchList.find(b => b.current)?.name || ''
        const changedPaths = new Set(summary.changes.map(change => change.path))
        selectedChanges.value = new Set([...selectedChanges.value].filter(path => changedPaths.has(path)))
      } catch (error) {
        if (!disposed) ElMessage.error(`刷新 Git 状态失败: ${(error as Error).message}`)
      }
    }
  })().finally(() => { gitRefreshPromise = undefined; gitRefreshing.value = false })
  return gitRefreshPromise
}

function onGitFocus() { void refreshGit() }
function onGitVisible() { if (document.visibilityState === 'visible') void refreshGit() }
function startGitWatching() {
  gitWatchToken = crypto.randomUUID()
  stopGitEvents = window.api.git.onChanged(event => {
    if (event.id !== projectId || event.token !== gitWatchToken || disposed) return
    if (event.error) gitWatchError.value = '文件监听已停止，切回窗口或点击刷新可更新状态'
    void refreshGit()
  })
  window.addEventListener('focus', onGitFocus)
  document.addEventListener('visibilitychange', onGitVisible)
  void window.api.git.watch(projectId, gitWatchToken).catch(() => {
    if (!disposed) gitWatchError.value = '文件监听不可用，切回窗口或点击刷新可更新状态'
  })
}

onUnmounted(() => {
  disposed = true
  stopGitEvents?.()
  window.removeEventListener('focus', onGitFocus)
  document.removeEventListener('visibilitychange', onGitVisible)
  if (gitWatchToken) void window.api.git.unwatch(gitWatchToken).catch(() => {})
})

async function loadTasks() {
  try {
    tasks.value = await window.api.project.tasks.list(projectId)
  } catch {
    tasks.value = []
  }
}

async function loadBranches() {
  try {
    branches.value = await window.api.git.branches(projectId)
    selectedBranch.value = branches.value.find((b) => b.current)?.name || ''
  } catch {
    branches.value = []
  }
}

async function switchBranch(name: string) {
  const current = branches.value.find(b => b.current)?.name || ''
  if (busy.value || !name || name === current) { selectedBranch.value = current; return }
  busy.value = 'checkout'
  try {
    const msg = await window.api.git.checkout(projectId, name)
    ElMessage.success(msg)
  } catch (e) {
    ElMessage.error(`切换失败: ${(e as Error).message}`)
  } finally {
    await refreshGit()
    busy.value = ''
  }
}

async function createBranch() {
  if (busy.value) return
  const name = newBranch.value.trim()
  if (!name) {
    ElMessage.warning('请填写分支名')
    return
  }
  busy.value = 'checkout'
  try {
    const msg = await window.api.git.checkout(projectId, name, true)
    ElMessage.success(msg)
    newBranch.value = ''
    branchDialogVisible.value = false
  } catch (e) {
    ElMessage.error(`创建失败: ${(e as Error).message}`)
  } finally {
    await refreshGit()
    busy.value = ''
  }
}

/* ---------- Git 提交 ---------- */
function toggleChange(path: string) {
  const set = new Set(selectedChanges.value)
  if (set.has(path)) set.delete(path)
  else set.add(path)
  selectedChanges.value = set
}

async function doCommit(alsoPush = false, selectedOnly = false) {
  if (busy.value) return
  const message = commitMessage.value.trim()
  if (!message) {
    ElMessage.warning('请填写提交说明')
    return
  }
  if (selectedOnly && !selectedChanges.value.size) return
  const paths = selectedOnly ? [...selectedChanges.value] : undefined
  busy.value = alsoPush ? 'commit-push' : 'commit'
  try {
    const msg = await window.api.git.commit(projectId, message, paths)
    ElMessage.success(msg)
    commitMessage.value = ''
    selectedChanges.value = new Set()
    if (alsoPush) {
      const pushMsg = await window.api.git.push(projectId, git.value?.upstream === null)
      ElMessage.success(pushMsg)
    }
  } catch (e) {
    ElMessage.error(`提交失败: ${(e as Error).message}`)
  } finally {
    // 提交可能已经成功，即使后续推送失败也必须重新读取工作区。
    await refreshGit()
    busy.value = ''
  }
}

async function doPull() {
  busy.value = 'pull'
  try {
    ElMessage.success(await window.api.git.pull(projectId))
  } catch (e) {
    ElMessage.error(`拉取失败: ${(e as Error).message}`)
  } finally {
    await refreshGit()
    busy.value = ''
  }
}

async function doPush() {
  busy.value = 'push'
  try {
    ElMessage.success(await window.api.git.push(projectId, git.value?.upstream === null))
  } catch (e) {
    ElMessage.error(`推送失败: ${(e as Error).message}`)
  } finally {
    await refreshGit()
    busy.value = ''
  }
}

async function recognize() {
  busy.value = 'sync'
  try {
    await window.api.project.syncRemotes(projectId)
    await load()
    await loadCommits()
    await loadBranches()
    ElMessage.success(
      git.value?.isGit ? '已识别到本地 git 仓库' : '该目录仍无 git 仓库，可在下方手动关联远程仓库'
    )
  } catch (e) {
    ElMessage.error(String((e as Error).message || e))
  } finally {
    busy.value = ''
  }
}

async function linkOnly() {
  if (!linkForm.value.url.trim()) {
    ElMessage.warning('请填写远程仓库地址')
    return
  }
  busy.value = 'link'
  try {
    await window.api.git.linkRemote(projectId, { name: linkForm.value.name, url: linkForm.value.url })
    ElMessage.success('已关联远程仓库')
    linkForm.value.url = ''
    await load()
    await loadCommits()
    await loadBranches()
  } catch (e) {
    ElMessage.error(`关联失败: ${(e as Error).message}`)
  } finally {
    busy.value = ''
  }
}

async function linkAndUpload() {
  if (!linkForm.value.url.trim()) {
    ElMessage.warning('请填写远程仓库地址')
    return
  }
  busy.value = 'upload'
  try {
    await window.api.git.linkRemote(projectId, { name: linkForm.value.name || 'origin', url: linkForm.value.url.trim() })
    ElMessage.success('已关联远程仓库')
    await window.api.git.commitAll(projectId, 'Initial commit by ProjectHub')
    const msg = await window.api.git.push(projectId, true)
    ElMessage.success(msg)
    await load()
    await loadCommits()
    await loadBranches()
  } catch (e) {
    ElMessage.error(`上传失败: ${(e as Error).message}`)
  } finally {
    busy.value = ''
  }
}

async function syncRemotes() {
  try {
    await window.api.project.syncRemotes(projectId)
    ElMessage.success('已从本地仓库读取 remote')
    load()
  } catch (e) {
    ElMessage.error(`同步失败: ${(e as Error).message}`)
  }
}

/* ---------- 运行方式 ---------- */
async function loadRunCommands() {
  try {
    runCommands.value = await window.api.project.runCommands(projectId)
  } catch {
    runCommands.value = []
  }
}

async function loadRunState() {
  try {
    const list = await window.api.runner.listRunning()
    runTask.value = list.find((t) => t.project_id === projectId) || null
    if (runTask.value) runTaskId.value = runTask.value.id
  } catch {
    runTask.value = null
  }
  try {
    external.value = await window.api.runner.probeExternal(projectId)
  } catch {
    external.value = { running: false, processes: [] }
  }
}

async function runCommand(c: RunSuggestion) {
  if (runTask.value?.status === 'running') {
    ElMessage.warning('已有任务在运行，请先停止')
    return
  }
  try {
    const payload = JSON.parse(JSON.stringify({ bin: c.bin, args: c.args, display: c.cmd })) as {
      bin: string
      args: string[]
      display?: string
    }
    const taskId = await window.api.runner.startCustom(projectId, payload)
    runTaskId.value = taskId
    runLogs.value = [`$ ${c.cmd}`, '']
    runTask.value = {
      id: taskId,
      project_id: projectId,
      type: 'run',
      status: 'running',
      command: c.cmd,
      log_path: null,
      pid: null,
      exit_code: null,
      started_at: new Date().toISOString(),
      ended_at: null
    }
  } catch (e) {
    ElMessage.error(`启动失败: ${(e as Error).message}`)
  }
}

async function stopRun() {
  if (!runTask.value) return
  await window.api.runner.stop(runTask.value.id)
}

function appendRunLog(chunk: LogChunk) {
  if (chunk.taskId !== runTaskId.value) return
  runLogs.value.push(chunk.data)
  if (runLogs.value.length > 300) runLogs.value.splice(0, 100)
  nextTick(() => {
    if (logBoxRef.value) logBoxRef.value.scrollTop = logBoxRef.value.scrollHeight
  })
}

function onRunStatus(task: TaskHistory) {
  if (task.project_id !== projectId) return
  if (task.id === runTaskId.value || runTask.value?.id === task.id) {
    runTask.value = task.status === 'running' ? task : null
    ElMessage.info(`任务结束：${task.status}`)
  }
  history.value = [task, ...history.value.filter((t) => t.id !== task.id)].slice(0, 20)
}

function askAgentBuild() {
  window.dispatchEvent(new CustomEvent('project-hub:agent-context', { detail: { projectId, open: true, prompt: selectedBuildTarget.value ? `构建目标“${selectedBuildTarget.value.name}”（标识 ${selectedBuildTarget.value.id}），完成后列出产物。` : '查看构建目标并构建当前项目，列出产物。' } }))
}
/* ---------- 打包 / 构建 ---------- */
async function loadBuildInfo() {
  try {
    buildTargets.value = await window.api.project.buildTargets(projectId)
    if (!buildTargets.value.some(t => t.id === selectedBuildTargetId.value)) selectedBuildTargetId.value = buildTargets.value[0]?.id || ''
    await loadTargetArtifacts()
  } catch (e) { ElMessage.error(`加载构建配置失败：${(e as Error).message}`) }
}
async function loadTargetArtifacts() {
  artifacts.value = []
  if (selectedBuildTargetId.value) {
    try { artifacts.value = await window.api.runner.artifacts(projectId, selectedBuildTargetId.value) }
    catch (e) { ElMessage.error(`加载产物失败：${(e as Error).message}`) }
  }
}

async function stopBuild() {
  try { await window.api.runner.stop(buildTaskId.value) }
  catch (e) { ElMessage.error((e as Error).message) }
}

async function startBuild() {
  if (buildTask.value?.status === 'running') {
    ElMessage.warning('构建正在进行中')
    return
  }
  try {
    const taskId = await window.api.runner.startBuild(projectId, selectedBuildTargetId.value)
    buildTaskId.value = taskId
    buildLogs.value = [`$ ${buildCommand.value}`, '']
    buildTask.value = {
      id: taskId,
      project_id: projectId,
      type: 'build',
      status: 'running',
      command: buildCommand.value,
      log_path: null,
      pid: null,
      exit_code: null,
      started_at: new Date().toISOString(),
      ended_at: null
    }
    nextTick(() => {
      if (buildLogBoxRef.value) buildLogBoxRef.value.scrollTop = buildLogBoxRef.value.scrollHeight
    })
  } catch (e) {
    ElMessage.error(`构建启动失败: ${(e as Error).message}`)
  }
}

function appendBuildLog(chunk: LogChunk) {
  if (chunk.taskId !== buildTaskId.value) return
  buildLogs.value.push(chunk.data)
  if (buildLogs.value.length > 2000) buildLogs.value.splice(0, 500)
  nextTick(() => {
    if (buildLogBoxRef.value) buildLogBoxRef.value.scrollTop = buildLogBoxRef.value.scrollHeight
  })
}

function onBuildStatus(task: TaskHistory) {
  if (task.id !== buildTaskId.value) return
  buildTask.value = task.status === 'running' ? task : null
  if (task.status === 'success') {
    ElMessage.success('构建完成')
    loadBuildInfo()
  } else if (task.status === 'failed') {
    ElMessage.error(`构建失败（退出码 ${task.exit_code ?? '-'}）`)
  }
}

function openArtifact(path: string) {
  window.api.system.openPath(path).catch(() => ElMessage.error('打开失败'))
}

async function addCustomCommand() {
  const cmd = customCmd.value.trim()
  if (!cmd) {
    ElMessage.warning('请填写命令')
    return
  }
  try {
    const cur = runCommands.value.filter((c) => c.custom).map((c) => c.cmd)
    if (runCommands.value.some((c) => c.cmd === cmd)) {
      ElMessage.warning('该命令已存在')
      return
    }
    await window.api.project.customCommands.save(projectId, [...cur, cmd])
    customCmd.value = ''
    runCommands.value = await window.api.project.runCommands(projectId)
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error(`保存失败: ${(e as Error).message}`)
  }
}

async function removeRunCommand(cmd: string) {
  try {
    await window.api.project.removeRunCommand(projectId, cmd)
    runCommands.value = await window.api.project.runCommands(projectId)
    ElMessage.success('已移除')
  } catch (e) {
    ElMessage.error(String((e as Error).message || e))
  }
}

async function addTask() {
  const title = newTaskTitle.value.trim()
  if (!title) {
    ElMessage.warning('请填写任务标题')
    return
  }
  try {
    tasks.value = await window.api.project.tasks.add(projectId, title, newTaskTag.value, newTaskGroup.value || null)
    newTaskTitle.value = ''
    await refreshProgressAndNotify()
  } catch (e) {
    ElMessage.error(`添加失败: ${(e as Error).message}`)
  }
}

async function refreshProgressAndNotify() {
  const prevStage = project.value?.progress_stage
  const detail = await window.api.project.detail(projectId)
  project.value = detail
  progress.value.percent = detail.progress_percent || 0
  progress.value.stage = (detail.progress_stage || 'planning') as Project['progress_stage']
  if (prevStage && detail.progress_stage && detail.progress_stage !== prevStage) {
    ElMessage.info(`阶段已自动联动：${stageLabel[detail.progress_stage] || detail.progress_stage}`)
  }
}

async function toggleTask(t: TaskItem) {
  try {
    await window.api.project.tasks.toggle(t.id)
    await loadTasks()
    await refreshProgressAndNotify()
  } catch (e) {
    ElMessage.error(String((e as Error).message || e))
  }
}

async function removeTask(t: TaskItem) {
  try {
    await window.api.project.tasks.remove(t.id)
    tasks.value = tasks.value.filter((x) => x.id !== t.id)
    await refreshProgressAndNotify()
  } catch (e) {
    ElMessage.error(String((e as Error).message || e))
  }
}

/* ---------- 基本信息 ---------- */
async function saveBasic() {
  if (!project.value) return
  savingBasic.value = true
  try {
    await window.api.project.update(project.value.id, {
      name: editForm.value.name.trim() || project.value.name,
      description: editForm.value.description
    })
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error(`保存失败: ${(e as Error).message}`)
  } finally {
    savingBasic.value = false
  }
}

const nameEditing = ref(false)

async function saveDisplayName() {
  if (!project.value) return
  savingName.value = true
  try {
    const v = displayNameInput.value.trim()
    await window.api.project.update(project.value.id, { display_name: v || null })
    project.value.display_name = v || null
    ElMessage.success('名称已保存，列表默认显示该名称')
  } catch (e) {
    ElMessage.error(`保存失败: ${(e as Error).message}`)
  } finally {
    savingName.value = false
  }
}

/* 展示名与英文括号名（与项目列表一致） */
function displayNameOf(p: Project): string {
  return p.display_name || p.name
}

function englishNameOf(p: Project): string {
  const segs = p.path.split('/').filter(Boolean)
  let en = segs[segs.length - 1] || ''
  if (!en) {
    const url = (p.remotes || [])[0]?.url || ''
    const m = url.match(/\/([^/]+?)(\.git)?$/)
    if (m) en = m[1]
  }
  const shown = displayNameOf(p)
  if (!en || en.toLowerCase() === shown.toLowerCase()) return ''
  return en
}

async function saveName() {
  if (!project.value) return
  const name = editForm.value.name.trim()
  nameEditing.value = false
  if (!name || name === project.value.name) return
  try {
    await window.api.project.update(project.value.id, { name })
    ElMessage.success('已重命名')
    load()
  } catch (e) {
    ElMessage.error(String((e as Error).message || e))
  }
}

/* ---------- 开发进度 ---------- */
async function saveProgress() {
  if (!project.value) return
  saving.value = true
  try {
    await window.api.project.update(project.value.id, {
      progress_stage: progress.value.stage,
      progress_note: progress.value.note
    })
    ElMessage.success('阶段与备注已保存')
  } catch (e) {
    ElMessage.error(`保存失败: ${(e as Error).message}`)
  } finally {
    saving.value = false
  }
}

async function commitAndPush() {
  await doCommit(true)
}

/* ---------- 其他 ---------- */
function toWebUrl(url: string): string {
  const m = url.match(/^git@([^:]+):(.+?)(\.git)?$/)
  if (m) return `https://${m[1]}/${m[2]}`
  return url.replace(/\.git$/, '')
}

async function openRepo(url: string) {
  try {
    await window.api.system.openExternal(toWebUrl(url))
  } catch {
    ElMessage.error('打开失败')
  }
}

async function viewLog(taskId: string) {
  const log = await window.api.task.readLog(taskId)
  ElMessageBox.alert(
    `<pre style="max-height:420px;overflow:auto;margin:0;font-size:12px">${log
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')}</pre>`,
    '运行日志',
    { dangerouslyUseHTMLString: true, confirmButtonText: '关闭' }
  ).catch(() => undefined)
}

function openFolder() {
  if (project.value) window.api.system.openPath(project.value.path)
}

function fmtTime(iso: string): string {
  if (!iso) return '-'
  return iso.replace('T', ' ').slice(0, 16)
}

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
const stageLabel: Record<string, string> = {
  planning: '规划中',
  developing: '开发中',
  testing: '联调测试',
  released: '已发布'
}
const platformLabel: Record<string, string> = {
  github: 'GitHub',
  gitee: 'Gitee',
  gitlab: 'GitLab',
  other: 'Git'
}
const statusType: Record<string, string> = {
  running: 'is-running',
  success: 'is-ok',
  failed: 'is-danger',
  stopped: ''
}

onMounted(async () => {
  startGitWatching()
  void load().then(() => refreshGit())
  loadCommits()
  loadBranches()
  loadRunCommands()
  loadRunState()
  loadTasks()
  loadAutoRestart()
  await loadBuildInfo()
  try {
    const list = await window.api.runner.listRunning()
    const building = list.find((t) => t.project_id === projectId && t.type === 'build')
    if (building) {
      buildTask.value = building
      buildTaskId.value = building.id
      if (building.build_target_id && buildTargets.value.some(t => t.id === building.build_target_id)) {
        selectedBuildTargetId.value = building.build_target_id
        await loadTargetArtifacts()
      }
      buildLogs.value = [await window.api.task.readLog(building.id)]
    }
  } catch {
    // ignore
  }
  window.api.runner.onLog(appendRunLog)
  window.api.runner.onLog(appendBuildLog)
  window.api.runner.onStatus(onRunStatus)
  window.api.runner.onStatus(onBuildStatus)
})
</script>

<template>
  <div v-loading="loading" class="page page-scroll">
    <div class="crumb-bar">
      <button class="crumb-back" type="button" @click="router.push('/projects')">
        <el-icon :size="14"><ArrowLeft /></el-icon><span>项目列表</span>
      </button>
      <el-icon class="crumb-sep" :size="12"><ArrowRight /></el-icon>
      <span class="crumb-current">{{ project ? displayNameOf(project) : '项目详情' }}</span>
    </div>

    <template v-if="project">
      <el-card class="head-card">
        <div class="head-line">
          <template v-if="nameEditing">
            <el-input v-model="editForm.name" size="default" style="width: 240px" @keyup.enter="saveName" @blur="saveName" />
          </template>
          <template v-else>
            <h2 class="name" title="点击修改原名称（英文）" @click="nameEditing = true">
              {{ displayNameOf(project) }}<span v-if="englishNameOf(project)" class="name-en">({{ englishNameOf(project) }})</span><el-icon class="edit-icon"><Edit /></el-icon>
            </h2>
          </template>
          <span class="type-chip">{{ typeLabel[project.type] || project.type }}</span>
          <span v-if="project.framework" class="type-chip">{{ project.framework }}</span>
          <span v-for="tag in (project.tags || []).slice(0, 3)" :key="tag" class="pill">{{ tag }}</span>
          <span v-if="runTask?.status === 'running'" class="chip is-running"><span class="dot" />运行中</span>
          <span v-else-if="external.running" class="chip is-info"><span class="dot" />外部进程</span>
          <span class="head-spacer" />
          <el-button size="small" type="primary" plain @click="router.push({ path: '/delivery', query: { project: projectId } })"><el-icon><UploadFilled /></el-icon>镜像发布</el-button>
          <el-button size="small" plain @click="router.push({ path: '/ai/library', query: { projectId } })"><el-icon><Reading /></el-icon>项目资料</el-button>
          <el-button size="small" plain @click="router.push({ path: '/ai/skills', query: { projectId } })"><el-icon><MagicStick /></el-icon>Skills 管理</el-button>
          <el-button size="small" @click="openFolder()"><el-icon><FolderOpened /></el-icon>目录</el-button>
          <el-button size="small" @click="recognize" :loading="busy === 'sync'"><el-icon><Search /></el-icon>识别</el-button>
        </div>
        <div class="meta-line">
          <span class="path mono" :title="project.path" @click="openFolder()">{{ project.path }}</span>
          <template v-if="git?.isGit">
            <span class="sep">·</span>
            <span class="mono">⑂ {{ git.branch }}</span>
            <span v-if="git.ahead > 0" class="chip is-danger"><span class="dot" />↑ {{ git.ahead }}</span>
            <span v-if="git.behind > 0" class="chip is-running"><span class="dot" />↓ {{ git.behind }}</span>
            <span v-if="git.lastCommit" class="mono dim">{{ git.lastCommit.hash }} {{ git.lastCommit.message }}</span>
          </template>
          <span v-else class="type-chip">未检测到 git 仓库</span>
        </div>

        <div class="edit-grid">
          <label class="field">
            <span class="field-label">显示名称</span>
            <span class="field-row">
              <el-input
                v-model="displayNameInput"
                size="small"
                placeholder="中文名称（列表默认显示）"
                clearable
                @keyup.enter="saveDisplayName"
              >
                <template #prefix><el-icon><EditPen /></el-icon></template>
              </el-input>
              <el-button size="small" type="primary" plain :loading="savingName" @click="saveDisplayName">保存</el-button>
            </span>
          </label>
          <label class="field">
            <span class="field-label">项目描述</span>
            <span class="field-row">
              <el-input
                v-model="editForm.description"
                size="small"
                placeholder="一句话说明这个项目做什么"
                @keyup.enter="saveBasic"
              >
                <template #prefix><el-icon><EditPen /></el-icon></template>
              </el-input>
              <el-button size="small" type="primary" plain :loading="savingBasic" @click="saveBasic">保存</el-button>
            </span>
          </label>
        </div>
      </el-card>

      <div class="grid">
        <div class="col col-l">
          <el-card v-if="showProgressModule" class="block">
            <template #header>
              <div class="head-row">
                <b>开发进度</b>
                <span class="task-summary">
                  {{ tasks.length ? `${tasks.filter((t) => t.done).length}/${tasks.length} 已完成` : '暂无任务' }}
                </span>
              </div>
            </template>
            <div class="progress-top">
              <span class="progress-num">{{ progress.percent }}%</span>
              <el-progress :percentage="progress.percent" :stroke-width="10" :show-text="false" style="flex: 1" />
            </div>
            <el-radio-group v-model="progress.stage" class="stage">
              <el-radio-button value="planning">规划中</el-radio-button>
              <el-radio-button value="developing">开发中</el-radio-button>
              <el-radio-button value="testing">联调测试</el-radio-button>
              <el-radio-button value="released">已发布</el-radio-button>
            </el-radio-group>
            <el-input v-model="progress.note" type="textarea" :rows="2" placeholder="当前进展备注…" />
            <el-button type="primary" :loading="saving" style="margin-top: 12px" @click="saveProgress">
              保存阶段与备注
            </el-button>

            <el-divider>任务列表（驱动进度）</el-divider>
            <div class="task-add">
              <el-input v-model="newTaskTitle" size="small" placeholder="新任务标题" @keyup.enter="addTask" />
              <el-select v-model="newTaskTag" size="small" style="width: 92px">
                <el-option label="功能" value="feature" />
                <el-option label="缺陷" value="bug" />
                <el-option label="杂项" value="chore" />
              </el-select>
              <el-select
                v-model="newTaskGroup"
                size="small"
                style="width: 110px"
                placeholder="分组"
                clearable
                filterable
                allow-create
                default-first-option
              >
                <el-option v-for="g in existingGroups" :key="g" :label="g" :value="g" />
              </el-select>
              <el-button size="small" type="primary" @click="addTask">添加</el-button>
            </div>
            <div class="task-groups">
              <div v-for="g in taskGroups" :key="g.key" class="task-group">
                <div class="task-group-head">
                  <span>{{ g.label }}</span>
                  <span class="task-group-count">{{ g.active.length + g.done.length }} 项</span>
                </div>
                <div class="task-list">
                  <div v-for="t in [...g.active, ...g.done]" :key="t.id" class="task-row">
                    <el-checkbox :model-value="!!t.done" @change="toggleTask(t)" />
                    <span class="task-title" :class="{ done: t.done }">{{ t.title }}</span>
                    <span class="pill" :class="{ 'is-danger': t.tag === 'bug', 'is-primary': t.tag === 'feature' }">
                      {{ t.tag }}
                    </span>
                    <span class="task-ops">
                      <el-button size="small" text :disabled="!!t.done" @click="moveTask(t, -1)">
                        <el-icon><ArrowUp /></el-icon>
                      </el-button>
                      <el-button size="small" text :disabled="!!t.done" @click="moveTask(t, 1)">
                        <el-icon><ArrowDown /></el-icon>
                      </el-button>
                      <el-button size="small" text type="primary" @click="openEditTask(t)">
                        <el-icon><EditPen /></el-icon>
                      </el-button>
                      <el-button size="small" text type="danger" @click="removeTask(t)">删除</el-button>
                    </span>
                  </div>
                </div>
              </div>
              <el-empty v-if="!tasks.length" description="暂无任务，进度按任务完成比例自动计算" :image-size="50" />
            </div>
          </el-card>

          <el-card class="block git-workspace" v-if="git?.isGit">
            <template #header><b>Git 工作区</b></template>
            <div class="git-toolbar">
              <div class="git-branch-control">
                <el-icon class="git-branch-icon"><Share /></el-icon>
                <el-select v-model="selectedBranch" class="git-branch-select" filterable :disabled="!!busy || !branches.length" :placeholder="git.branch || '切换分支'" aria-label="切换分支" @change="switchBranch">
                  <el-option v-for="b in branches" :key="b.name" :label="b.name" :value="b.name">
                    <span>{{ b.name }}</span><span v-if="b.current" class="git-current-branch">当前</span>
                  </el-option>
                </el-select>
              </div>
              <el-button size="small" text :disabled="!!busy" @click="branchDialogVisible = true">新建分支</el-button>
              <el-tooltip content="刷新 Git 状态" placement="top">
                <el-button class="git-refresh" size="small" text :icon="RefreshRight" :loading="gitRefreshing" :disabled="!!busy" aria-label="刷新 Git 状态" @click="refreshGit" />
              </el-tooltip>
            </div>
            <el-alert v-if="gitWatchError" :title="gitWatchError" type="warning" :closable="false" class="git-watch-alert" />
            <el-tabs class="git-tabs">
              <el-tab-pane label="变更与提交">
                <div class="git-panel git-files-panel">
                  <div class="git-panel-head"><b>文件变更</b><span class="git-meta">{{ git.changes.length }} 个文件</span></div>
                  <div v-if="!git.changes.length" class="git-status-strip">
                    <span v-for="group in changeGroups" :key="group.key"><i :class="group.key" />{{ group.title }}<b>{{ group.files.length }}</b></span>
                  </div>
                  <div v-if="git.changes.length" class="git-change-groups">
                    <div v-for="group in changeGroups" :key="group.key" class="change-group" :class="'changes-' + group.key">
                      <div class="git-group-head"><span><i :class="group.key" />{{ group.title }}</span><span class="git-count">{{ group.files.length }}</span></div>
                      <div v-if="group.files.length" class="changes-list">
                        <label v-for="f in group.files" :key="f.path" class="change-row" :class="{ 'is-selected': selectedChanges.has(f.path) }">
                          <el-checkbox :model-value="selectedChanges.has(f.path)" @change="toggleChange(f.path)" />
                          <span class="git-file-status" :class="{ 'is-conflict': f.displayStatus === '冲突' }">{{ f.displayStatus }}</span>
                          <span class="git-file-path" :title="f.path">{{ f.path }}</span>
                        </label>
                      </div>
                      <div v-else class="git-group-empty">{{ group.empty }}</div>
                    </div>
                  </div>
                  <div v-else class="git-clean-state">
                    <el-icon><CircleCheck /></el-icon>
                    <div><b>工作区干净</b><span>保存代码后，变更会自动显示在这里</span></div>
                  </div>
                  <div v-if="changeGroups[0].files.some(f => f.worktreeStatus)" class="git-note">暂存后继续修改的文件会同时出现在两组中。</div>
                </div>
                <div class="git-commit-editor">
                  <label class="git-editor-label" for="git-commit-message">提交说明<span v-if="selectedChanges.size">已选择 {{ selectedChanges.size }} 个文件</span></label>
                  <el-input id="git-commit-message" v-model="commitMessage" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" resize="none" placeholder="提交说明，如 feat: 新增 xx 功能" />
                  <div class="git-commit-actions">
                  <el-button
                    size="small" type="primary" :loading="busy === 'commit'"
                    :disabled="!!busy || !commitMessage.trim() || !git.changes.length"
                    @click="doCommit(false)"
                  >提交全部</el-button>
                  <el-button
                    v-if="selectedChanges.size"
                    size="small"
                    :disabled="!!busy || !commitMessage.trim()"
                    @click="doCommit(false, true)"
                  >提交所选 {{ selectedChanges.size }} 个</el-button>
                  <el-button
                    size="small" type="primary" plain :loading="busy === 'commit-push'"
                    :disabled="!!busy || !commitMessage.trim() || !git.changes.length"
                    @click="commitAndPush"
                  >提交并推送</el-button>
                  </div>
                </div>
                <div class="git-panel git-push-panel">
                  <div class="git-panel-head">
                    <b>待推送提交 <span class="git-count" :class="{ 'has-pending': git.ahead }">{{ git.ahead }}</span></b>
                    <div class="git-sync-actions">
                      <el-button size="small" text :icon="Download" :disabled="!!busy" :loading="busy === 'pull'" @click="doPull">拉取</el-button>
                      <el-button size="small" text :icon="Upload" :disabled="!!busy" :loading="busy === 'push'" @click="doPush">推送</el-button>
                    </div>
                  </div>
                  <div v-if="git.pendingCommits?.length" class="commit-list">
                    <div v-for="c in git.pendingCommits" :key="c.hash" class="git-pending-row">
                      <span class="git-commit-dot" />
                      <div class="git-pending-content"><b :title="c.message">{{ c.message }}</b><span>{{ c.author }} · {{ fmtTime(c.date) }}</span></div>
                      <span class="mono git-short-hash">{{ c.hash }}</span>
                    </div>
                  </div>
                  <div v-else class="git-synced-state"><el-icon><CircleCheck /></el-icon><span>没有待推送提交</span></div>
                  <div v-if="git.ahead > (git.pendingCommits?.length || 0)" class="git-note">最近 {{ git.pendingCommits?.length || 0 }} 条 / 共 {{ git.ahead }} 条待推送</div>
                  <div v-if="git.behind" class="git-note">落后上游 {{ git.behind }} 条提交，可拉取更新</div>
                  <div class="git-tracking">
                    <span v-if="git.upstream" class="mono" :title="git.upstream"><el-icon><Share /></el-icon>{{ git.upstream }}</span>
                    <span v-else>未设置上游分支</span>
                    <el-tooltip :content="git.upstream ? '根据本地远程引用判断；拉取或 fetch 后更新远端状态。' : '未设置上游，按本地已知的远程引用识别待推送提交。首次推送会建立 origin 跟踪。'" placement="top"><span class="git-reference-hint">本地同步状态</span></el-tooltip>
                  </div>
                </div>
              </el-tab-pane>
              <el-tab-pane label="远程仓库">
                <div class="sub-title">远程仓库</div>
                <el-empty v-if="!project.remotes?.length" description="未关联远程仓库" :image-size="50" />
                <div v-for="r in project.remotes" :key="r.id" class="remote-row">
                  <span class="mono remote-name">{{ r.name }}</span>
                  <span v-if="r.is_default" class="chip is-ok"><span class="dot" />默认</span>
                  <span class="type-chip">{{ platformLabel[r.platform] || r.platform }}</span>
                  <span class="remote-url" :title="r.url">{{ r.url }}</span>
                  <el-button size="small" text type="primary" @click="openRepo(r.url)">网页</el-button>
                </div>
                <div class="btn-row" style="margin-bottom: 8px">
                  <el-button size="small" :icon="RefreshRight" @click="syncRemotes">从本地读取</el-button>
                  <el-button size="small" type="primary" plain :loading="busy === 'pull'" @click="doPull">拉取</el-button>
                  <el-button size="small" type="primary" :loading="busy === 'push'" @click="doPush">推送</el-button>
                </div>
                <el-divider>手动添加远程仓库</el-divider>
                <el-input v-model="linkForm.url" placeholder="git@github.com:you/repo.git 或 https://...">
                  <template #prepend>地址</template>
                </el-input>
                <el-input v-model="linkForm.name" placeholder="remote 名称（默认 origin）" class="link-name" />
                <div class="btn-row">
                  <el-button :loading="busy === 'link'" @click="linkOnly">仅关联</el-button>
                  <el-button type="primary" :loading="busy === 'upload'" @click="linkAndUpload">添加并首次上传</el-button>
                </div>
              </el-tab-pane>
            </el-tabs>
            <el-dialog v-model="branchDialogVisible" title="创建分支" width="380px" :close-on-click-modal="busy !== 'checkout'" :close-on-press-escape="busy !== 'checkout'" :show-close="busy !== 'checkout'">
              <div class="git-dialog-note">从当前分支 {{ git.branch }} 创建并切换到新分支。</div>
              <el-input v-model="newBranch" placeholder="分支名称，如 feature/login" :disabled="!!busy" @keyup.enter="createBranch" />
              <template #footer><el-button :disabled="!!busy" @click="branchDialogVisible = false">取消</el-button><el-button type="primary" :loading="busy === 'checkout'" :disabled="!!busy || !newBranch.trim()" @click="createBranch">创建并切换</el-button></template>
            </el-dialog>
          </el-card>

          <el-card class="block" v-if="!git?.isGit">
            <template #header><b>Git 仓库关联</b></template>
            <el-alert type="warning" :closable="false" show-icon class="tip-alert">
              <template #title>未检测到本地 git 仓库。可点顶部「识别」刷新，或在下方手动关联远程仓库。</template>
            </el-alert>
            <template v-if="project.remotes?.length">
              <div class="tip-line" style="padding: 6px 0">已登记的仓库关联（本地 git 初始化后自动生效）：</div>
              <div v-for="r in project.remotes" :key="r.id" class="remote-row">
                <span class="mono remote-name">{{ r.name }}</span>
                <span class="type-chip">{{ platformLabel[r.platform] || r.platform }}</span>
                <span class="remote-url" :title="r.url">{{ r.url }}</span>
                <el-button size="small" text type="primary" @click="openRepo(r.url)">打开网页</el-button>
              </div>
            </template>
            <el-divider>手动关联远程仓库</el-divider>
            <el-input v-model="linkForm.url" placeholder="git@github.com:you/repo.git 或 https://github.com/you/repo.git">
              <template #prepend>地址</template>
            </el-input>
            <el-input v-model="linkForm.name" placeholder="remote 名称（默认 origin）" class="link-name" />
            <div class="btn-row">
              <el-button :loading="busy === 'link'" @click="linkOnly">仅关联</el-button>
              <el-button type="primary" :loading="busy === 'upload'" @click="linkAndUpload">关联并首次上传</el-button>
            </div>
            <div class="tip-line">「首次上传」会自动：git init → 添加 remote → 提交全部文件 → push -u origin</div>
          </el-card>

          <el-card class="block">
            <template #header>
              <div class="head-row">
                <b>提交记录</b>
                <el-button size="small" text @click="loadCommits"><el-icon><Refresh /></el-icon>刷新</el-button>
              </div>
            </template>
            <div v-if="commits.length" class="commit-list">
              <div v-for="c in commits" :key="c.hash" class="commit-row">
                <span class="mono hash">{{ c.hash.slice(0, 7) }}</span>
                <span class="commit-msg" :title="c.message">{{ c.message }}</span>
                <span class="time">{{ fmtTime(c.date) }}</span>
              </div>
            </div>
            <el-empty v-else description="暂无提交记录" :image-size="60" />
          </el-card>
        </div>

        <div class="col col-r">
          <el-card class="block">
            <template #header>
              <div class="head-row">
                <b>运行方式</b>
                <span v-if="runTask?.status === 'running'" class="run-state">
                  <span class="dot" />运行中
                  <el-button size="small" type="danger" plain @click="stopRun">停止</el-button>
                </span>
              </div>
            </template>
            <div class="cmd-list">
              <div v-for="c in runCommands" :key="c.cmd" class="cmd-row">
                <span class="cmd-text mono">{{ c.cmd }}</span>
                <span v-if="c.custom" class="type-chip">自定义</span>
                <el-button size="small" text type="danger" @click="removeRunCommand(c.cmd)">删除</el-button>
                <el-button size="small" type="primary" :disabled="runTask?.status === 'running'" @click="runCommand(c)">
                  <el-icon><VideoPlay /></el-icon>运行
                </el-button>
              </div>
              <el-empty v-if="!runCommands.length" description="未识别到运行方式" :image-size="50" />
            </div>
            <div class="custom-add">
              <el-input v-model="customCmd" size="small" placeholder="添加命令，如 ./run.sh" @keyup.enter="addCustomCommand" />
              <el-button size="small" type="primary" plain @click="addCustomCommand">添加</el-button>
            </div>
            <div class="restart-row">
              <div class="restart-info">
                <b>崩溃自动重启</b>
                <div class="tip-line">进程异常退出时自动重启，最多连续 5 次，对之后启动的任务生效</div>
              </div>
              <el-switch :model-value="autoRestart" @change="toggleAutoRestart" />
            </div>
            <div v-if="runLogs.length" ref="logBoxRef" class="terminal log-box compact">
              <pre>{{ runLogsText }}</pre>
            </div>
          </el-card>

          <el-card class="block">
            <template #header><b>打包与产物</b></template>
            <div class="build-row" style="margin-bottom: 10px">
              <el-select v-model="selectedBuildTargetId" placeholder="选择构建目标" :disabled="buildTask?.status === 'running'" @change="flutterCheck = null; loadTargetArtifacts()">
                <el-option v-for="t in buildTargets" :key="t.id" :value="t.id" :label="`${t.name} · ${t.directory}`" />
              </el-select>
              <el-button size="small" :disabled="buildTask?.status === 'running'" @click="editBuildTarget()">新增目标</el-button>
              <el-button size="small" :disabled="!selectedBuildTarget || buildTask?.status === 'running'" @click="editBuildTarget(selectedBuildTarget)">编辑</el-button>
              <el-button size="small" text type="danger" :disabled="!selectedBuildTarget || buildTask?.status === 'running'" @click="removeBuildTarget">删除</el-button>
            </div>
            <div v-if="selectedBuildTarget" class="tip-line">工作目录：{{ selectedBuildTarget.directory }} · 执行平台：{{ { any: '不限', darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[selectedBuildTarget.platform] }}</div>
            <el-button v-if="selectedBuildTarget?.commands.some(c => c.includes('flutter'))" size="small" :loading="checkingFlutter" @click="checkFlutterEnvironment">检查 Flutter 构建环境</el-button>
            <div v-if="flutterCheck" class="tip-line">
              <div>Flutter {{ flutterCheck.version }} · {{ flutterCheck.source }} · {{ flutterCheck.sdk }}</div>
              <div>Gradle Java {{ flutterCheck.javaVersion }}：{{ flutterCheck.javaHome || 'Flutter 自动选择' }} · Android SDK：{{ flutterCheck.androidSdk || '未指定' }}</div>
              <div v-if="!flutterCheck.errors.length">静态检查通过；首次成功检查的环境会在运行或构建时保存。</div>
              <div v-for="item in flutterCheck.errors" :key="item" style="color: var(--el-color-danger)">{{ item }}</div>
              <div v-for="item in flutterCheck.warnings" :key="item">提示：{{ item }}</div>
              <el-button v-if="flutterCheck.errors.length" size="small" @click="editBuildTarget(selectedBuildTarget)">选择兼容 SDK / 修改环境</el-button>
            </div>
            <div v-if="selectedBuildTarget?.flutterSdk" class="tip-line">Flutter SDK：{{ selectedBuildTarget.flutterSdk }} {{ selectedBuildTarget.flutterVersion ? '· 固定版本 ' + selectedBuildTarget.flutterVersion : '' }}</div>
            <div class="build-row">
              <el-button size="small" @click="askAgentBuild">交给 Agent</el-button>
              <span class="cmd-text mono">{{ buildCommand || '未识别到构建命令' }}</span>
              <el-button
                size="small"
                type="primary"
                :loading="buildTask?.status === 'running'"
                :disabled="!buildCommand"
                @click="startBuild"
              >
                <el-icon><Box /></el-icon>打包
              </el-button>
              <el-button v-if="buildTask?.status === 'running'" size="small" type="danger" plain @click="stopBuild">停止构建</el-button>
              <el-button size="small" text @click="loadBuildInfo">刷新产物</el-button>
            </div>
            <div v-if="buildLogs.length" ref="buildLogBoxRef" class="terminal log-box compact">
              <pre>{{ buildLogsText }}</pre>
            </div>
            <div v-if="artifacts.length" class="artifact-list">
              <div v-for="a in artifacts" :key="a.path" class="artifact-row">
                <el-icon class="artifact-icon"><FolderOpened /></el-icon>
                <div class="artifact-meta">
                  <span class="artifact-name mono" :title="a.name">{{ a.name }}</span>
                  <span class="artifact-path mono" :title="a.path">{{ a.path }}</span>
                </div>
                <el-button size="small" text type="primary" @click="openArtifact(a.path)">打开产物</el-button>
              </div>
            </div>
            <div v-else class="tip-line">配置的产物路径尚不存在。目录列表可能包含以前构建的文件。</div>
            <div v-if="selectedBuildTarget?.image" class="tip-line">镜像引用：{{ selectedBuildTarget.image }}（是否生成或上传请查看构建日志）</div>
            <el-dialog v-model="buildEditorVisible" title="构建目标" width="650px">
              <el-form label-width="100px">
                <el-form-item label="填入模板">
                  <el-select placeholder="选择后可自由修改" @change="applyBuildTemplate">
                    <el-option v-for="option in [{ value: 'electronWin', label: 'Electron Windows' }, { value: 'electronMac', label: 'Electron macOS' }, { value: 'flutterWin', label: 'Flutter Windows' }, { value: 'flutterMac', label: 'Flutter macOS' }, { value: 'apk', label: 'Android APK' }, { value: 'aab', label: 'Android App Bundle' }, { value: 'ipa', label: 'iOS IPA' }, { value: 'docker', label: 'Docker 构建' }, { value: 'dockerPush', label: 'Docker 构建并上传' }]" :key="option.value" :value="option.value" :label="option.label" />
                  </el-select>
                </el-form-item>
                <el-form-item label="目标名称"><el-input v-model="buildEditor.name" placeholder="例如：后台服务 A / Docker" /></el-form-item>
                <el-form-item label="子项目目录"><el-input v-model="buildEditor.directory" placeholder="相对项目根目录，例如 services/api" /></el-form-item>
                <el-form-item label="执行平台"><el-select v-model="buildEditor.platform"><el-option label="不限" value="any" /><el-option label="macOS" value="darwin" /><el-option label="Windows" value="win32" /><el-option label="Linux" value="linux" /></el-select></el-form-item>
                <el-form-item label="Flutter SDK">
                  <el-input v-model="buildEditor.flutterSdk" placeholder="可选：Flutter 安装目录，留空使用终端环境" clearable>
                    <template #append><el-button @click="pickFlutterSdk">选择目录</el-button></template>
                  </el-input>
                  <div class="tip-line">请选择包含 bin/flutter 的 Flutter 安装目录；保存时绑定该 SDK 当前版本。项目位置填写在“子项目目录”，例如 family-flutter。</div>
                </el-form-item>
                <el-form-item label="Gradle JDK"><el-input v-model="buildEditor.javaHome" placeholder="可选：Java 安装目录，留空自动识别" clearable><template #append><el-button @click="pickBuildDirectory('javaHome')">选择目录</el-button></template></el-input></el-form-item>
                <el-form-item label="Android SDK"><el-input v-model="buildEditor.androidSdk" placeholder="可选：Android SDK 安装目录，留空读取项目配置" clearable><template #append><el-button @click="pickBuildDirectory('androidSdk')">选择目录</el-button></template></el-input></el-form-item>
                <el-form-item label="构建步骤"><el-input v-model="buildEditor.commands" type="textarea" :rows="5" placeholder="每行一个步骤，依次执行；失败即停止" /></el-form-item>
                <el-form-item label="产物路径"><el-input v-model="buildEditor.artifacts" type="textarea" :rows="2" placeholder="每行一个文件或目录，相对子项目目录；Docker 可留空" /></el-form-item>
                <el-form-item label="镜像引用"><el-input v-model="buildEditor.image" placeholder="可选：仓库地址/镜像名:标签，与命令中保持一致" /></el-form-item>
              </el-form>
              <el-alert title="所有步骤在本机执行。Docker 上传使用本机已登录的仓库凭据，请修改模板中的镜像地址；需要签名的桌面或手机包须先配置对应工具和证书。" type="info" :closable="false" />
              <template #footer><el-button @click="buildEditorVisible = false">取消</el-button><el-button type="primary" :loading="savingBuildTarget" @click="saveBuildTarget">保存</el-button></template>
            </el-dialog>
          </el-card>

          <el-card class="block">
            <template #header><b>最近运行记录</b></template>
            <el-table v-if="history.length" :data="history" size="small" max-height="240">
              <el-table-column prop="type" label="类型" width="70" />
              <el-table-column label="状态" width="90">
                <template #default="{ row }">
                  <span class="chip" :class="statusType[row.status] || ''"><span class="dot" />{{ row.status }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="command" label="命令" show-overflow-tooltip />
              <el-table-column prop="source_revision" label="源码版本" width="150" show-overflow-tooltip />
              <el-table-column label="日志" width="70">
                <template #default="{ row }">
                  <el-button size="small" text type="primary" @click="viewLog(row.id)">查看</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-empty v-else description="暂无运行记录" :image-size="60" />
          </el-card>
        </div>
      </div>
    </template>
    <!-- 任务编辑弹窗 -->
    <el-dialog v-model="editTaskVisible" title="编辑任务" width="420">
      <el-form label-width="64px">
        <el-form-item label="标题">
          <el-input v-model="editTaskForm.title" @keyup.enter="saveEditTask" />
        </el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="editTaskForm.tag">
            <el-radio-button value="feature">功能</el-radio-button>
            <el-radio-button value="bug">缺陷</el-radio-button>
            <el-radio-button value="chore">杂项</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="分组">
          <el-select
            v-model="editTaskForm.group_name"
            clearable
            filterable
            allow-create
            default-first-option
            placeholder="不分组"
            style="width: 100%"
          >
            <el-option v-for="g in existingGroups" :key="g" :label="g" :value="g" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editTaskVisible = false">取消</el-button>
        <el-button type="primary" @click="saveEditTask">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.crumb-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; font-size: 13px; }
.crumb-back { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border: none; border-radius: 7px; background: transparent; color: var(--el-text-color-secondary); font-family: inherit; font-size: 13px; cursor: pointer; transition: background-color var(--ph-dur) var(--ph-ease), color var(--ph-dur) var(--ph-ease); }
.crumb-back:hover { color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.crumb-sep { color: var(--el-text-color-placeholder); }
.crumb-current { color: var(--el-text-color-primary); font-weight: 600; }
.head-card { margin-bottom: 16px; border-radius: var(--ph-radius-md); }
.head-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.head-spacer { flex: 1; }
.name { margin: 0; display: inline-flex; align-items: center; gap: 4px; cursor: text; font-size: 21px; font-weight: 700; letter-spacing: -0.022em; line-height: 1.25; color: var(--el-text-color-primary); }
.name-en { font-size: 13px; font-weight: 400; color: var(--el-text-color-secondary); }
.edit-icon { font-size: 12px; color: var(--el-text-color-secondary); margin-left: 6px; }
.meta-line { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--el-text-color-secondary); flex-wrap: wrap; }
.sep { color: var(--el-border-color); }
.path { cursor: pointer; color: var(--el-text-color-secondary); }
.path:hover { color: var(--el-color-primary); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.edit-grid { display: grid; grid-template-columns: minmax(0, 320px) minmax(0, 1fr); gap: 12px; margin-top: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.field-label { font-size: 12px; font-weight: 600; color: var(--el-text-color-secondary); }
.field-row { display: flex; gap: 8px; align-items: center; }
.field-row .el-input { flex: 1; }
.hash { color: var(--el-color-primary); font-weight: 600; font-size: 12px; background: var(--el-fill-color); border-radius: 4px; padding: 1px 6px; flex-shrink: 0; }
.commit-list { display: flex; flex-direction: column; max-height: 300px; overflow-y: auto; }
.git-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; padding: 9px 10px; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); border-radius: 10px; }
.git-branch-control { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.git-branch-icon { color: var(--el-color-primary); font-size: 17px; flex-shrink: 0; }
.git-branch-select { width: 100%; min-width: 0; max-width: 230px; }
.git-branch-select :deep(.el-select__wrapper) { background: transparent; box-shadow: none; padding-left: 0; }
.git-branch-select :deep(.el-select__selected-item) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; font-weight: 600; }
.git-toolbar .el-button { margin-left: 0; flex-shrink: 0; }
.git-current-branch { float: right; margin-left: 20px; font-size: 11px; color: var(--el-color-primary); }
.git-tabs :deep(.el-tabs__header) { margin-bottom: 16px; }
.git-tabs :deep(.el-tabs__item) { font-size: 13px; }
.git-panel { border: 1px solid var(--el-border-color-lighter); border-radius: 10px; overflow: hidden; }
.git-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; }
.git-panel-head > b { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
.git-meta { font-size: 11px; color: var(--el-text-color-secondary); }
.git-status-strip { display: flex; gap: 20px; padding: 0 14px 12px; border-bottom: 1px solid var(--el-border-color-lighter); }
.git-status-strip > span { display: flex; align-items: center; gap: 7px; color: var(--el-text-color-secondary); font-size: 12px; }
.git-status-strip b { color: var(--el-text-color-regular); font-weight: 500; }
.git-status-strip i, .git-group-head i { width: 6px; height: 6px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
i.staged { background: var(--el-color-success); }
i.unstaged { background: var(--el-color-warning); }
.git-clean-state { display: flex; align-items: center; gap: 12px; padding: 22px 16px; }
.git-clean-state > .el-icon { font-size: 24px; color: var(--el-color-success); }
.git-clean-state > div { display: flex; flex-direction: column; gap: 5px; }
.git-clean-state b { font-size: 13px; font-weight: 500; }
.git-clean-state span { font-size: 11px; color: var(--el-text-color-secondary); }
.git-change-groups { border-top: 1px solid var(--el-border-color-lighter); }
.change-group + .change-group { border-top: 1px solid var(--el-border-color-lighter); }
.git-group-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: var(--el-fill-color-lighter); font-size: 12px; }
.git-group-head > span:first-child { display: flex; align-items: center; gap: 7px; }
.git-count { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; padding: 1px 6px; border-radius: 5px; font-size: 11px; font-weight: 500; color: var(--el-text-color-secondary); background: var(--el-fill-color); }
.git-count.has-pending { color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.git-group-empty { padding: 10px 14px; font-size: 11px; color: var(--el-text-color-placeholder); }
.git-workspace .changes-list { gap: 0; margin: 0; max-height: 210px; }
.git-workspace .change-row { border: none; border-radius: 0; padding: 3px 14px; gap: 9px; }
.git-workspace .change-row:hover, .git-workspace .change-row.is-selected { background: var(--el-fill-color-light); }
.git-file-status { flex-shrink: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 600; color: var(--el-color-warning); min-width: 14px; }
.changes-staged .git-file-status { color: var(--el-color-success); }
.git-file-status.is-conflict { color: var(--el-color-danger); }
.git-file-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--el-text-color-regular); }
.git-commit-editor { margin: 17px 0; }
.git-editor-label { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 12px; color: var(--el-text-color-regular); }
.git-editor-label > span { color: var(--el-color-primary); font-size: 11px; }
.git-commit-editor :deep(.el-textarea__inner) { padding: 10px 12px; border-radius: 8px; font-size: 12px; line-height: 1.7; background: var(--el-fill-color-lighter); }
.git-commit-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.git-commit-actions .el-button, .git-sync-actions .el-button { margin-left: 0; }
.git-workspace .el-button.is-disabled { opacity: 0.45; }
.git-sync-actions { display: flex; gap: 2px; flex-shrink: 0; }
.git-push-panel .git-panel-head { padding: 9px 14px; }
.git-synced-state { display: flex; align-items: center; gap: 7px; padding: 5px 14px 16px; font-size: 12px; color: var(--el-text-color-secondary); }
.git-synced-state .el-icon { color: var(--el-color-success); }
.git-pending-row { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-top: 1px solid var(--el-border-color-lighter); }
.git-commit-dot { width: 7px; height: 7px; border: 2px solid var(--el-color-primary); border-radius: 50%; flex-shrink: 0; }
.git-pending-content { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.git-pending-content b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; }
.git-pending-content > span, .git-short-hash { font-size: 11px; color: var(--el-text-color-secondary); }
.git-short-hash { flex-shrink: 0; }
.git-tracking { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 14px; background: var(--el-fill-color-lighter); border-top: 1px solid var(--el-border-color-lighter); font-size: 11px; color: var(--el-text-color-secondary); }
.git-tracking > span:first-child { display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.git-reference-hint { flex-shrink: 0; cursor: help; color: var(--el-text-color-placeholder); }
.git-note { padding: 9px 14px; font-size: 11px; line-height: 1.6; color: var(--el-text-color-secondary); }
.git-watch-alert { margin-bottom: 12px; }
.git-dialog-note { margin-bottom: 14px; font-size: 12px; color: var(--el-text-color-secondary); }
.commit-row { display: flex; align-items: center; gap: 10px; padding: 8px 2px; border-bottom: 1px solid var(--el-border-color-lighter); font-size: 13px; }
.commit-row:last-child { border-bottom: none; }
.commit-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--el-text-color-regular); }
.dim { color: var(--el-text-color-secondary); }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.block { margin-bottom: 16px; }
.head-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.progress-top { display: flex; align-items: center; gap: 16px; padding: 0 4px; }
.progress-num { font-size: 24px; font-weight: 700; color: var(--el-color-primary); width: 64px; }
.stage { margin: 14px 0; }
.remote-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid var(--el-border-color-light); border-radius: 8px; margin-bottom: 8px; transition: border-color 0.15s ease; }
.remote-row:hover { border-color: var(--el-color-primary-light-5); }
.remote-url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--el-text-color-secondary); }
.link-name { margin-top: 10px; }
.tip-line { font-size: 12px; color: var(--el-text-color-secondary); }
.tip-alert { margin-bottom: 12px; }
.btn-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.changes-list { max-height: 180px; overflow-y: auto; margin-bottom: 10px; display: flex; flex-direction: column; gap: 6px; }
.change-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--el-border-color-light); border-radius: 8px; cursor: pointer; transition: border-color 0.15s ease; }
.change-row:hover { border-color: var(--el-color-primary-light-5); }
.sub-title { font-weight: 600; margin: 10px 0 8px; color: var(--el-text-color-primary); }
.cmd-list { display: flex; flex-direction: column; gap: 8px; }
.cmd-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--el-border-color-light); border-radius: 8px; transition: border-color 0.15s ease, background-color 0.15s ease; }
.cmd-row:hover { border-color: var(--el-color-primary-light-5); background: var(--el-color-primary-light-9); }
.cmd-text { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 12px; color: var(--el-text-color-regular); }
.custom-add { display: flex; gap: 8px; margin-top: 10px; }
.run-state { display: inline-flex; align-items: center; gap: 6px; color: var(--el-color-warning); font-size: 12px; }
.run-state .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--el-color-warning); animation: blink 1.2s infinite; }
@keyframes blink { 50% { opacity: 0.2; } }
.log-box { max-height: 140px; margin-top: 10px; }
.log-box pre { margin: 0; font-family: inherit; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
.time { font-size: 12px; color: var(--el-text-color-secondary); }
.task-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.task-groups { margin-top: 4px; }
.task-group { margin-bottom: 10px; }
.task-group-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; font-weight: 600; color: var(--el-text-color-secondary); padding: 4px 2px; }
.task-group-count { font-weight: 400; }
.task-row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 1px solid var(--el-border-color-light); border-radius: 8px; transition: border-color 0.15s ease; }
.task-row:hover { border-color: var(--el-color-primary-light-5); }
.task-row.done-row { opacity: 0.75; }
.task-ops { display: flex; align-items: center; gap: 0; flex-shrink: 0; }
.task-ops .el-button + .el-button { margin-left: 0; }
.task-title { flex: 1; color: var(--el-text-color-regular); }
.task-title.done { color: var(--el-text-color-secondary); text-decoration: line-through; }
.task-summary { font-size: 12px; color: var(--el-text-color-secondary); }
.build-row { display: flex; align-items: center; gap: 10px; }
.build-row .cmd-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.artifact-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.artifact-row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 1px solid var(--el-border-color-light); border-radius: 8px; }
.artifact-icon { flex-shrink: 0; color: var(--el-text-color-secondary); }
.artifact-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.artifact-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 600; color: var(--el-text-color-primary); }
.artifact-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--el-text-color-secondary); }
.restart-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; padding: 12px 14px; border: 1px solid var(--el-border-color-light); border-radius: 10px; background: var(--el-fill-color-lighter); }
.restart-info b { font-size: 13px; color: var(--el-text-color-primary); }
@media (max-width: 1100px) {
  .grid { grid-template-columns: minmax(0, 1fr); }
  .edit-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
