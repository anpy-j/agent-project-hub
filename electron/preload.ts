import { contextBridge, ipcRenderer } from 'electron'
import type { ProjectHubAPI } from '../src/api/ipc'
import type { LogChunk, TaskHistory, ServiceLogChunk, ServiceStatusInfo, ServiceAnomaly, AiConfig } from '../src/types'

function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const plainArgs = args.map((a) => a === undefined ? undefined : JSON.parse(JSON.stringify(a)))
  return ipcRenderer.invoke(channel, ...plainArgs) as Promise<T>
}


const api: ProjectHubAPI = {
  library: {
    list: filter => invoke('library:list', filter), detail: id => invoke('library:detail', id),
    capture: input => invoke('library:capture', input), importFile: input => invoke('library:importFile', input),
    update: (id, patch) => invoke('library:update', id, patch), archive: (id, archived) => invoke('library:archive', id, archived),
    process: (id, action) => invoke('library:process', id, action), browse: id => invoke('library:browse', id), supply: (id, content) => invoke('library:supply', id, content),
    refreshSync: id => invoke('library:refreshSync', id), source: (id, sourceId) => invoke('library:source', id, sourceId),
    ask: (id, question) => invoke('library:ask', id, question), export: id => invoke('library:export', id),
    onChanged: callback => {
      const handler = (_event: unknown, resource: import('../src/types/library').LibraryResource) => callback(resource)
      ipcRenderer.on('library:changed', handler)
      return () => ipcRenderer.removeListener('library:changed', handler)
    }
  },
  ragflow: {
    getConfig: () => invoke('ragflow:getConfig'),
    saveConfig: input => invoke('ragflow:saveConfig', input),
    test: input => invoke('ragflow:test', input),
    documents: () => invoke('ragflow:documents'),
    open: () => invoke('ragflow:open')
  },
  openclaw: {
    models: (id, selection) => invoke('openclaw:models', id, selection),
    list: () => invoke('openclaw:list'), save: input => invoke('openclaw:save', input),
    remove: id => invoke('openclaw:remove', id), discover: () => invoke('openclaw:discover'),
    connections: () => invoke('openclaw:connections'), connect: id => invoke('openclaw:connect', id),
    disconnect: id => invoke('openclaw:disconnect', id), request: (id, method, params) => invoke('openclaw:request', id, method, params),
    service: (id, action) => invoke('openclaw:service', id, action),
    onEvent: callback => {
      const handler = (_event: unknown, value: import('../src/types/openclaw').OpenClawEvent) => callback(value)
      ipcRenderer.on('openclaw:event', handler)
      return () => ipcRenderer.removeListener('openclaw:event', handler)
    }
  },
  agent: {
    getConfig: () => invoke('agent:getConfig'), saveConfig: config => invoke('agent:saveConfig', config),
    test: config => invoke('agent:test', config), tasks: () => invoke('agent:tasks'),
    start: input => invoke('agent:start', input), confirm: (id, approve) => invoke('agent:confirm', id, approve),
    cancel: id => invoke('agent:cancel', id),
    onTask: callback => {
      const handler = (_e: unknown, task: import('../src/types/agent').AgentTask) => callback(task)
      ipcRenderer.on('agent:task', handler)
      return () => ipcRenderer.removeListener('agent:task', handler)
    }
  },
  skills: {
    snapshot: () => invoke('skills:snapshot'),
    preview: input => invoke('skills:preview', input),
    scan: projectId => invoke('skills:scan', projectId),
    describeCandidates: skills => invoke('skills:describeCandidates', skills),
    import: (token, ids) => invoke('skills:import', token, ids),
    discard: token => invoke('skills:discard', token),
    readFile: (id, path) => invoke('skills:readFile', id, path),
    install: input => invoke('skills:install', input),
    setEnabled: (id, enabled) => invoke('skills:setEnabled', id, enabled),
    uninstall: id => invoke('skills:uninstall', id),
    remove: id => invoke('skills:remove', id),
    history: id => invoke('skills:history', id),
    explain: id => invoke('skills:explain', id),
    checkUpdate: id => invoke('skills:checkUpdate', id),
    applyUpdate: (id, token, candidateId) => invoke('skills:applyUpdate', id, token, candidateId),
    restore: id => invoke('skills:restore', id),
    export: id => invoke('skills:export', id),
    bundle: (id, replace) => invoke('skills:bundle', id, replace),
    pickLocal: kind => invoke('skills:pickLocal', kind),
    context: (projectId, ids) => invoke('skills:context', projectId, ids),
    chat: input => invoke('skills:chat', input)
  },
  deployment: {
    registries: () => invoke('deployment:registries'),
    saveRegistry: (input) => invoke('deployment:saveRegistry', input),
    removeRegistry: (id) => invoke('deployment:removeRegistry', id),
    testRegistry: (id) => invoke('deployment:testRegistry', id),
    hosts: () => invoke('deployment:hosts'),
    saveHost: (input) => invoke('deployment:saveHost', input),
    removeHost: (id) => invoke('deployment:removeHost', id),
    importBridgebox: () => invoke('deployment:importBridgebox'),
    pickPrivateKey: () => invoke('deployment:pickPrivateKey'),
    fingerprint: (host, port) => invoke('deployment:fingerprint', host, port),
    testHost: (id) => invoke('deployment:testHost', id),
    snapshot: (id) => invoke('deployment:snapshot', id),
    remoteAction: (id, action) => invoke('deployment:remoteAction', id, action),
    config: (id) => invoke('deployment:config', id),
    saveConfig: (config) => invoke('deployment:saveConfig', config),
    start: (id, action) => invoke('deployment:start', id, action),
    jobs: () => invoke('deployment:jobs'),
    onJob: (callback) => {
      const handler = (_e: unknown, job: import('../src/types/deployment').ReleaseJob) => callback(job)
      ipcRenderer.on('deployment:job', handler)
      return () => ipcRenderer.removeListener('deployment:job', handler)
    }
  },
  project: {
    list: (workspaceId?: string) => invoke('project:list', workspaceId),
    get: (id: string) => invoke('project:get', id),
    detail: (id: string) => invoke('project:detail', id),
    add: (data) => invoke('project:add', data),
    clone: (data) => invoke('project:clone', data),
    update: (id, data) => invoke('project:update', id, data),
    remove: (id: string) => invoke('project:remove', id),
    syncRemotes: (id: string) => invoke('project:syncRemotes', id),
    detect: (path: string) => invoke('project:detect', path),
    buildTargets: (id: string) => invoke('project:buildTargets', id),
    flutterEnvironment: (id: string, target: import('../src/types').BuildTarget) => invoke('project:flutterEnvironment', id, target),
    saveBuildTargets: (id: string, targets: import('../src/types').BuildTarget[]) => invoke('project:saveBuildTargets', id, targets),
    buildCommand: (id: string) => invoke('project:buildCommand', id),
    runCommands: (id: string) => invoke('project:runCommands', id),
    removeRunCommand: (id: string, cmd: string) => invoke('project:runCommands:remove', id, cmd),
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
    startBuild: (projectId: string, targetId?: string) => invoke('runner:startBuild', projectId, targetId),
    artifacts: (projectId: string, targetId?: string) => invoke('runner:artifacts', projectId, targetId),
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
  gitAuth: {
    snapshot: () => invoke('gitAuth:snapshot'),
    test: (data) => invoke('gitAuth:test', data)
  },
  system: {
    logUsage: () => invoke('system:logUsage'),
    maintenance: () => invoke('system:maintenance'),
    openPath: (path: string) => invoke('system:openPath', path),
    openExternal: (url: string) => invoke('system:openExternal', url),
    pickDirectory: () => invoke('system:pickDirectory') as Promise<string | null>
  },
  diskCleaner: {
    getDrives: () => invoke('diskCleaner:getDrives'),
    analyze: () => invoke('diskCleaner:analyze'),
    clean: (targets) => invoke('diskCleaner:clean', targets)
  }
}


if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore allow direct attach in non-isolated context
  window.api = api
}

export default api
