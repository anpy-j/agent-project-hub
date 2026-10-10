export type OpenClawTransport = 'http' | 'local' | 'ssh' | 'direct'
export interface OpenClawInstance {
  id: string; name: string; transport: OpenClawTransport; url: string; hostId: string; cliPath: string; authMode?: 'token' | 'password'; hasToken: boolean; model?: string; stream?: boolean; management?: 'none' | 'local' | 'ssh'; managementPort?: number; adminAccess?: boolean; pairingAccess?: boolean
}
export interface OpenClawInput extends Omit<OpenClawInstance, 'hasToken'> { token?: string; clearToken?: boolean }
export interface OpenClawConnection {
  instanceId: string; status: 'disconnected' | 'connecting' | 'connected' | 'error'; error: string; version?: string; deviceId?: string; methods?: string[]; scopes?: string[]; verified?: boolean
}
export interface OpenClawEvent { instanceId: string; event: string; payload: any }
export interface OpenClawAPI {
  list(): Promise<OpenClawInstance[]>
  save(input: OpenClawInput): Promise<OpenClawInstance>
  remove(id: string): Promise<void>
  discover(): Promise<OpenClawInstance>
  connections(): Promise<OpenClawConnection[]>
  connect(id: string): Promise<OpenClawConnection>
  disconnect(id: string): Promise<void>
  request(id: string, method: string, params?: Record<string, unknown>): Promise<any>
  service(id: string, action: 'status' | 'start' | 'stop' | 'restart' | 'logs'): Promise<string>
  onEvent(callback: (event: OpenClawEvent) => void): () => void
}
