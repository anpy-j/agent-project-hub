import { contextBridge, ipcRenderer } from 'electron'
import type { ProjectHubAPI } from '../src/api/ipc'
import type { LogChunk, TaskHistory, ServiceLogChunk, ServiceStatusInfo, ServiceAnomaly, AiConfig } from '../src/types'

function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const plainArgs = args.map((a) => JSON.parse(JSON.stringify(a)))
  return ipcRenderer.invoke(channel, ...plainArgs) as Promise<T>
}


const api: ProjectHubAPI = {
  project: {
    list: (workspaceId?: string) => invoke('project:list', workspaceId),
    get: (id: string) => invoke('project:get', id),
    detail: (id: string) => invoke('project:detail', id),
    add: (data) => invoke('project:add', data),
    update: (id, data) => invoke('project:update', id, data),
    remove: (id: string) => invoke('project:remove', id),
    syncRemotes: (id: string) => invoke('project:syncRemotes', id),
    detect: (path: string) => invoke('project:detect', path),
    buildCommand: (id: string) => invoke('project:buildCommand', id),
    runCommands: (id: string) => invoke('project:runCommands', id),
    tasks: {
      list: (id: string) => invoke('task:list', id),
      add: (id: string, title: string, tag: string, group?: string | null) =>
        invoke('task:add', id, title, tag, group),
      toggle: (id: string) => invoke('task:toggle', id),
      update: (id: string, data: { title?: string; tag?: string; group_name?: string | null }) =>
        invoke('task:update', id, data),
      reorder: (id: string, orderedIds: string[]) => invoke('task:reorder', id, orderedIds),
      remove: (id: string) => invoke('task:remove', id)
    },
    customCommands: {
      get: (id: string) => invoke('project:customCommands:get', id),
      save: (id: string, cmds: string[]) => invoke('project:customCommands:save', id, cmds)
    },
    getAutoRestart: (id: string) => invoke('project:autoRestart:get', id),
    setAutoRestart: (id: string, enabled: boolean) => invoke('project:autoRestart:set', id, enabled)
  },
  git: {
    log: (id: string, count?: number) => invoke('git:log', id, count),
    init: (id: string) => invoke('git:init', id),
    linkRemote: (id: string, payload: { name?: string; url: string }) => invoke('git:linkRemote', id, payload),
    commitAll: (id: string, message: string) => invoke('git:commitAll', id, message),
    push: (id: string, upstream?: boolean) => invoke('git:push', id, upstream),
    pull: (id: string) => invoke('git:pull', id),
    branches: (id: string) => invoke('git:branches', id),
    checkout: (id: string, branch: string, create = false) => invoke('git:checkout', id, branch, create),
    commit: (id: string, message: string, paths?: string[]) => invoke('git:commit', id, message, paths)
  },
  workspace: {
    list: () => invoke('workspace:list')
  },
  runtime: {
    list: () => invoke('runtime:list'),
    scan: () => invoke('runtime:scan')
  },
  runner: {
    start: (projectId: string) => invoke('runner:start', projectId),
    startCustom: (projectId: string, cmd: { bin: string; args: string[]; display?: string }) =>
      invoke('runner:startCustom', projectId, cmd),
    probeExternal: (projectId: string) => ipcRenderer.invoke('runner:probeExternal', projectId),
    startBuild: (projectId: string) => invoke('runner:startBuild', projectId),
    artifacts: (projectId: string) => invoke('runner:artifacts', projectId),
    stop: (taskId: string) => invoke('runner:stop', taskId),
    listRunning: () => invoke('runner:listRunning'),
    stats: () => invoke('runner:stats'),
    onLog: (callback) => {
      const handler = (_e: unknown, chunk: LogChunk) => callback(chunk)
      ipcRenderer.on('runner:log', handler)
      return () => ipcRenderer.removeListener('runner:log', handler)
    },
    onStatus: (callback) => {
      const handler = (_e: unknown, task: TaskHistory) => callback(task)
      ipcRenderer.on('runner:status', handler)
      return () => ipcRenderer.removeListener('runner:status', handler)
    }
  },
  task: {
    history: (projectId: string, type?: string) => invoke('task:history', projectId, type),
    readLog: (taskId: string) => invoke('task:readLog', taskId)
  },
  service: {
    list: () => invoke('service:list'),
    add: (data) => invoke('service:add', data),
    update: (id, data) => invoke('service:update', id, data),
    remove: (id: string) => invoke('service:remove', id),
    start: (id: string) => invoke('service:start', id),
    stop: (id: string) => invoke('service:stop', id),
    restart: (id: string) => invoke('service:restart', id),
    probe: (id: string) => invoke('service:probe', id),
    probeAll: () => invoke('service:probeAll'),
    readLog: (id: string) => invoke('service:readLog', id),
    clearLog: (id: string) => invoke('service:clearLog', id),
    importScan: () => invoke('service:importScan'),
    import: (candidates) => invoke('service:import', candidates),
    agentSearch: (query: string) => invoke('service:agentSearch', query),
    onLog: (callback) => {
      const handler = (_e: unknown, chunk: ServiceLogChunk) => callback(chunk)
      ipcRenderer.on('service:log', handler)
      return () => ipcRenderer.removeListener('service:log', handler)
    },
    onStatus: (callback) => {
      const handler = (_e: unknown, info: ServiceStatusInfo) => callback(info)
      ipcRenderer.on('service:status', handler)
      return () => ipcRenderer.removeListener('service:status', handler)
    },
    onAnomaly: (callback) => {
      const handler = (_e: unknown, anomaly: ServiceAnomaly) => callback(anomaly)
      ipcRenderer.on('service:anomaly', handler)
      return () => ipcRenderer.removeListener('service:anomaly', handler)
    }
  },
  ai: {
    providers: () => invoke('ai:providers'),
    getConfig: () => invoke('ai:getConfig'),
    saveConfig: (data) => invoke('ai:saveConfig', data),
    listModels: (cfg?) => invoke('ai:listModels', cfg),
    test: (cfg?) => invoke('ai:test', cfg)
  },
  system: {
    logUsage: () => invoke('system:logUsage'),
    maintenance: () => invoke('system:maintenance'),
    openPath: (path: string) => invoke('system:openPath', path),
    openExternal: (url: string) => invoke('system:openExternal', url),
    pickDirectory: () => invoke('system:pickDirectory') as Promise<string | null>
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore allow direct attach in non-isolated context
  window.api = api
}

export default api
