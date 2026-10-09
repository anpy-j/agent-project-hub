export interface GitKey {
  path: string
  name: string
  type: string
  fingerprint: string
  comment: string
  publicKey: string
  privateKeyExists: boolean
  loaded: boolean
}
export interface GitAuthSnapshot {
  version: string
  username: string
  email: string
  helpers: string[]
  keys: GitKey[]
  agentStatus: string
  hosts: { alias: string; hostname: string; identityFile: string }[]
  warnings: string[]
}
export interface GitAuthResult {
  status: 'success' | 'auth-failed' | 'network-failed' | 'host-untrusted' | 'unknown'
  message: string
  checkedAt: string
}
