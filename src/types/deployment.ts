export interface RegistryProfile {
  id: string
  name: string
  server: string
  username: string
  hasPassword: boolean
}
export interface RegistryInput extends Omit<RegistryProfile, 'hasPassword'> { password?: string }
export interface HostProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authKind: 'password' | 'privateKey'
  fingerprint: string
  hasCredential: boolean
}
export interface HostInput extends Omit<HostProfile, 'hasCredential'> {
  password?: string
  privateKey?: string
  passphrase?: string
}
export interface DeployConfig {
  projectId: string
  registryId: string
  hostId: string
  repository: string
  tag: string
  dockerfile: string
  buildContext?: string
  platform: 'linux/amd64' | 'linux/arm64'
  remoteDir: string
  composeFile: string
  service: string
  composeProject: string
}
export type ReleaseAction = 'build' | 'push' | 'deploy' | 'all'
export interface ReleaseJob {
  id: string
  projectId: string
  hostId: string
  action: ReleaseAction
  image: string
  status: 'running' | 'success' | 'failed' | 'interrupted'
  stage: string
  startedAt: string
  endedAt?: string
  log: string
}
export interface RemoteSnapshot {
  metrics: string
  containers: Array<Record<string, string>>
  images: Array<Record<string, string>>
  services: Array<{ name: string; active: string; sub: string; description: string }>
}
export interface RemoteAction {
  kind: 'container' | 'image' | 'service' | 'logs'
  action: string
  target: string
}
export interface DeploymentAPI {
  registries: () => Promise<RegistryProfile[]>
  saveRegistry: (input: RegistryInput) => Promise<RegistryProfile>
  removeRegistry: (id: string) => Promise<void>
  testRegistry: (id: string) => Promise<string>
  hosts: () => Promise<HostProfile[]>
  saveHost: (input: HostInput) => Promise<HostProfile>
  removeHost: (id: string) => Promise<void>
  importBridgebox: () => Promise<number>
  pickPrivateKey: () => Promise<string | null>
  fingerprint: (host: string, port: number) => Promise<string>
  testHost: (id: string) => Promise<string>
  snapshot: (id: string) => Promise<RemoteSnapshot>
  remoteAction: (id: string, action: RemoteAction) => Promise<string>
  config: (projectId: string) => Promise<DeployConfig | null>
  saveConfig: (config: DeployConfig) => Promise<DeployConfig>
  start: (projectId: string, action: ReleaseAction) => Promise<string>
  jobs: () => Promise<ReleaseJob[]>
  onJob: (callback: (job: ReleaseJob) => void) => () => void
}
