import type {
  Project,
  Workspace,
  Runtime,
  TaskHistory,
  DetectResult,
  GitSummary,
  GitCommit,
  TaskItem,
  GitBranch,
  RunSuggestion,
  LogChunk,
  ProjectType,
  TaskStat,
  ServiceItem,
  ServiceCandidate,
  ServiceLogChunk,
  ServiceStatusInfo,
  ServiceAnomaly,
  AgentSearchResult,
  AiConfig,
  AiProviderOption,
  ProjectArtifact,
  LogUsage,
  MaintenanceResult,
  DiskDriveInfo,
  DiskAnalysisResult,
  CleanExecutionTarget,
  CleanExecutionResult
} from '@/types'

import type { DeploymentAPI } from '../types/deployment'

export interface ProjectHubAPI {
  library: import('../types/library').LibraryAPI
  ragflow: import('../types/ragflow').RagflowAPI
  openclaw: import('../types/openclaw').OpenClawAPI
  agent: import('../types/agent').AgentAPI
  skills: import('../types/skills').SkillsAPI
  gitAuth: {
    snapshot: () => Promise<import('../types/git-auth').GitAuthSnapshot>
    test: (data: { platform: string; url?: string }) => Promise<import('../types/git-auth').GitAuthResult>
  }
  deployment: DeploymentAPI
  project: {
    clone: (data: { url: string; parent: string; directory: string }) => Promise<string>
    list: (workspaceId?: string) => Promise<Project[]>
    get: (id: string) => Promise<Project | null>
    detail: (id: string) => Promise<Project & { git: GitSummary; history: TaskHistory[] }>
    add: (data: {
      workspace_id: string
      name: string
      path: string
      type?: ProjectType
      framework?: string | null
      description?: string | null
      remotes?: Array<{ name: string; url: string; platform?: string; is_default?: number }>
    }) => Promise<Project>
    update: (id: string, data: Partial<Project>) => Promise<Project>
    remove: (id: string) => Promise<void>
    syncRemotes: (id: string) => Promise<Project | null>
    detect: (path: string) => Promise<DetectResult>
    buildTargets: (id: string) => Promise<import('../types').BuildTarget[]>
    flutterEnvironment: (id: string, target: import('../types').BuildTarget) => Promise<{ sdk: string; version: string; source: string; javaHome: string; javaVersion: string; androidSdk: string; errors: string[]; warnings: string[] }>,
    saveBuildTargets: (id: string, targets: import('../types').BuildTarget[]) => Promise<void>
    buildCommand: (id: string) => Promise<string>
    runCommands: (id: string) => Promise<RunSuggestion[]>
    removeRunCommand: (id: string, cmd: string) => Promise<void>
    customCommands: {
      get: (id: string) => Promise<string[]>
      save: (id: string, cmds: string[]) => Promise<string[]>
    },
    tasks: {
      list: (id: string) => Promise<TaskItem[]>
      add: (id: string, title: string, tag: string, group?: string | null) => Promise<TaskItem[]>
      toggle: (taskId: string) => Promise<TaskItem | null>
      update: (taskId: string, data: { title?: string; tag?: string; group_name?: string | null }) => Promise<TaskItem | null>
      reorder: (projectId: string, orderedIds: string[]) => Promise<TaskItem[]>
      remove: (taskId: string) => Promise<boolean>
    },
    getAutoRestart: (id: string) => Promise<boolean>
    setAutoRestart: (id: string, enabled: boolean) => Promise<boolean>
  }
  git: {
    log: (projectId: string, count?: number) => Promise<GitCommit[]>
    init: (projectId: string) => Promise<void>
    linkRemote: (projectId: string, payload: { name?: string; url: string }) => Promise<Project | null>
    commitAll: (projectId: string, message: string) => Promise<string>
    push: (projectId: string, upstream?: boolean) => Promise<string>
    pull: (projectId: string) => Promise<string>
    branches: (projectId: string) => Promise<GitBranch[]>
    checkout: (projectId: string, branch: string, create?: boolean) => Promise<string>
    commit: (projectId: string, message: string, paths?: string[]) => Promise<string>
  }
  workspace: {
    list: () => Promise<Workspace[]>
  }
  runtime: {
    list: () => Promise<Runtime[]>
    scan: () => Promise<Runtime[]>
  }
  runner: {
    start: (projectId: string) => Promise<string>
    startCustom: (projectId: string, cmd: { bin: string; args: string[]; display?: string }) => Promise<string>
    startBuild: (projectId: string, targetId?: string) => Promise<string>
    artifacts: (projectId: string, targetId?: string) => Promise<ProjectArtifact[]>
    probeExternal: (projectId: string) => Promise<{ running: boolean; processes: Array<{ pid: number; command: string }> }>
    stop: (taskId: string) => Promise<void>
    listRunning: () => Promise<TaskHistory[]>
    stats: () => Promise<TaskStat[]>
    onLog: (callback: (chunk: LogChunk) => void) => () => void
    onStatus: (callback: (task: TaskHistory) => void) => () => void
  }
  task: {
    history: (projectId: string, type?: string) => Promise<TaskHistory[]>
    readLog: (taskId: string) => Promise<string>
  }
  service: {
    list: () => Promise<ServiceItem[]>
    add: (data: {
      name: string
      group_name?: string | null
      command: string
      cwd?: string | null
      port?: number | null
      autostart?: boolean
      description?: string | null
    }) => Promise<ServiceItem>
    update: (id: string, data: Partial<ServiceItem>) => Promise<ServiceItem>
    remove: (id: string) => Promise<void>
    start: (id: string) => Promise<string>
    stop: (id: string) => Promise<void>
    restart: (id: string) => Promise<string>
    probe: (id: string) => Promise<ServiceStatusInfo>
    probeAll: () => Promise<Array<ServiceItem & { status: ServiceStatusInfo }>>
    readLog: (id: string) => Promise<string>
    clearLog: (id: string) => Promise<void>
    importScan: () => Promise<ServiceCandidate[]>
    import: (candidates: ServiceCandidate[]) => Promise<number>
    agentSearch: (query: string) => Promise<AgentSearchResult>
    onLog: (callback: (chunk: ServiceLogChunk) => void) => () => void
    onStatus: (callback: (info: ServiceStatusInfo) => void) => () => void
    onAnomaly: (callback: (anomaly: ServiceAnomaly) => void) => () => void
  }
  ai: {
    providers: () => Promise<AiProviderOption[]>
    getConfig: () => Promise<AiConfig>
    saveConfig: (data: AiConfig) => Promise<AiConfig>
    listModels: (cfg?: AiConfig) => Promise<string[]>
    test: (cfg?: AiConfig) => Promise<string>
  }
  system: {
    logUsage: () => Promise<LogUsage>
    maintenance: () => Promise<MaintenanceResult>
    openPath: (path: string) => Promise<void>
    openExternal: (url: string) => Promise<void>
    pickDirectory: () => Promise<string | null>
  }
  diskCleaner: {
    getDrives: () => Promise<DiskDriveInfo[]>
    analyze: () => Promise<DiskAnalysisResult>
    clean: (targets: CleanExecutionTarget[]) => Promise<CleanExecutionResult>
  }
}
