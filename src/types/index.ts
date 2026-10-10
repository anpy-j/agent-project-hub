export type ProjectType =
  | 'java-maven'
  | 'java-gradle'
  | 'python'
  | 'flutter'
  | 'vue'
  | 'react'
  | 'node'
  | 'unknown'

export type RuntimeKind = 'jdk' | 'node' | 'python' | 'flutter'

export type TaskType = 'run' | 'build' | 'deploy'
export type TaskStatus = 'running' | 'success' | 'failed' | 'stopped'

export type GitPlatform = 'github' | 'gitee' | 'gitlab' | 'other'
export type ProgressStage = 'planning' | 'developing' | 'testing' | 'released'

export interface Workspace {
  id: string
  name: string
  kind: 'personal' | 'company'
  icon: string | null
  color: string | null
  sort_order: number
  created_at: string
}

export interface ProjectRemote {
  id: string
  project_id: string
  name: string
  url: string
  platform: GitPlatform
  is_default: number
}

export interface GitSummary {
  isGit: boolean
  branch: string | null
  ahead: number
  behind: number
  changes: Array<{ path: string; status: string }>
  lastCommit: { hash: string; message: string; author: string; date: string } | null
}

export interface LogUsage {
  files: number
  bytes: number
}

export interface MaintenanceResult {
  removedTasks: number
  removedFiles: number
  usage: LogUsage
}

export interface ProjectArtifact {
  name: string
  path: string
}

export interface GitCommit {
  hash: string
  message: string
  author: string
  date: string
}

export interface GitBranch {
  name: string
  current: boolean
}

export type TaskTag = 'bug' | 'feature' | 'chore'

export interface TaskItem {
  id: string
  project_id: string
  title: string
  tag: TaskTag
  done: number
  sort_order: number
  group_name: string | null
  created_at: string
}

export interface TaskStat {
  taskId: string
  pid: number | null
  cpu: number
  mem: number
  procs: number
  status: TaskStatus
}

export interface RunSuggestion {
  name: string
  cmd: string
  bin: string
  args: string[]
  custom?: boolean
}

export interface Project {
  id: string
  workspace_id: string
  name: string
  display_name: string | null
  path: string
  type: ProjectType
  framework: string | null
  runtime_id: string | null
  tags: string[] | null
  description: string | null
  progress_percent: number
  progress_stage: ProgressStage
  progress_note: string
  remotes?: ProjectRemote[]
  last_run_at: string | null
  created_at: string
  updated_at: string
}

export interface Runtime {
  id: string
  kind: RuntimeKind
  version: string
  path: string
  is_default: number
  source: string | null
  created_at: string
}

export interface TaskHistory {
  build_target_id?: string | null
  build_snapshot?: string | null
  source_revision?: string | null
  id: string
  project_id: string
  type: TaskType
  status: TaskStatus
  command: string | null
  log_path: string | null
  pid: number | null
  exit_code: number | null
  started_at: string
  ended_at: string | null
}

export interface DetectResult {
  type: ProjectType
  framework: string | null
  suggestedName: string
  isGit: boolean
  branch: string | null
  remotes: Array<{ name: string; url: string; platform: GitPlatform; is_default: number }>
  subProjects?: SubProject[]
}

export interface SubProject {
  path: string
  name: string
  type: ProjectType
  framework: string | null
}

export interface RunCommand {
  bin: string
  args: string[]
  env: Record<string, string | undefined>
  cwd: string
}

export interface LogChunk {
  taskId: string
  stream: 'stdout' | 'stderr'
  data: string
  timestamp: number
}

// ---- 本机服务管理 ----
export type ServiceSource = 'manual' | 'launchd' | 'schtasks' | 'cli' | 'agent'
export type ServiceRunStatus = 'running' | 'stopped' | 'abnormal'

export interface ServiceItem {
  id: string
  name: string
  group_name: string | null
  command: string
  cwd: string | null
  port: number | null
  autostart: number
  source: ServiceSource
  native_id: string | null
  description: string | null
  last_status: ServiceRunStatus | null
  last_started_at: string | null
  created_at: string
  updated_at: string
}

export interface ServiceStatusInfo {
  serviceId: string
  status: ServiceRunStatus
  pid: number | null
  detail: string
}

export interface ServiceCandidate {
  key: string
  name: string
  command: string
  cwd: string | null
  port?: number | null
  nativeId: string
  source: Exclude<ServiceSource, 'manual'>
  autostart: boolean
  alreadyImported: boolean
  description?: string | null
}

export interface AgentSearchResult {
  query: string
  usedAi: boolean
  notice: string
  candidates: ServiceCandidate[]
}

// ---- AI 设置（服务发现 Agent） ----
export type AiProvider = 'ollama' | 'opencode' | 'deepseek' | 'openai' | 'moonshot' | 'custom'

export interface AiConfig {
  provider: AiProvider
  base_url: string
  api_key: string
  model: string
}

export interface AiProviderOption {
  value: AiProvider
  label: string
  baseUrl: string
  needKey: boolean
  hint: string
}

export interface ServiceLogChunk {
  serviceId: string
  runId: string
  stream: 'stdout' | 'stderr'
  data: string
  timestamp: number
}

export interface ServiceAnomaly {
  serviceId: string
  serviceName: string
  exitCode: number | null
  message: string
}

// ---- AI 磁盘管家与系统清理 ----
export interface DiskDriveInfo {
  drive: string
  label?: string
  totalBytes: number
  usedBytes: number
  freeBytes: number
  usedPercent: number
  freeGb: number
  totalGb: number
}

export interface CleanItem {
  id: string
  name: string
  path: string
  sizeBytes: number
  sizeDisplay: string
  reason: string
  safetyNotice?: string
  defaultChecked: boolean
  category: 'cache' | 'log' | 'installer' | 'dev_build' | 'media_temp' | 'media_old' | 'ai_model' | 'other'
}

export interface CleanTier {
  level: 1 | 2 | 3
  title: string
  description: string
  badge: 'safe' | 'warning' | 'archive'
  items: CleanItem[]
}

export interface OptimizationSuggestion {
  title: string
  description: string
  actionHint?: string
}

export interface DiskAnalysisResult {
  summary: string
  analyzedAt: string
  usedAi: boolean
  aiModel?: string
  drives: DiskDriveInfo[]
  tiers: CleanTier[]
  optimizations: OptimizationSuggestion[]
}

export interface CleanExecutionTarget {
  id: string
  path: string
  action: 'delete' | 'trash'
}

export interface CleanExecutionResult {
  freedBytes: number
  freedDisplay: string
  successCount: number
  failedCount: number
  errors: Array<{ path: string; error: string }>
  afterDrives: DiskDriveInfo[]
}


export interface BuildTarget {
  flutterSdk?: string
  flutterVersion?: string
  javaHome?: string
  androidSdk?: string
  id: string
  name: string
  directory: string
  platform: 'any' | 'darwin' | 'win32' | 'linux'
  commands: string[]
  artifactPaths: string[]
  image?: string
}
