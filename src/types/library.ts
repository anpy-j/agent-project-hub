export type ResourceKind = 'article' | 'github' | 'skill' | 'mcp' | 'tool' | 'document'
export type ReadingState = 'unread' | 'read' | 'practiced'
export type ProcessingState = 'queued' | 'fetching' | 'analyzing' | 'ready' | 'failed'
export type SyncState = 'none' | 'uploading' | 'uploaded' | 'parsing' | 'ready' | 'failed'
export interface LibrarySource {
  id: string; resourceId: string; createdAt: string; title: string; author: string; url: string
  version: string; content: string; raw: string; hash: string; warnings: string[]
}
export interface LibraryAnalysis {
  id: string; sourceId: string; createdAt: string; model: string; template: string
  summary: string; markdown: string; inputTruncated: boolean
}
export interface LibrarySync {
  id: string; sourceId: string; baseUrl: string; datasetId: string; documentId: string
  state: SyncState; progress: number; error: string; updatedAt: string
}
export interface LibraryResource {
  id: string; title: string; kind: ResourceKind; url: string; tags: string[]; reason: string; notes: string
  projectIds: string[]; reading: ReadingState; processing: ProcessingState; error: string
  summary: string; autoAnalyze: boolean; autoSync: boolean; archived: boolean
  createdAt: string; updatedAt: string; sourceId: string; sync: LibrarySync | null
  jobAction?: 'fetch' | 'analyze' | 'sync' | 'capture'
}
export interface LibraryDetail extends LibraryResource {
  source: LibrarySource | null; sources: Omit<LibrarySource, 'raw' | 'content'>[]
  analyses: LibraryAnalysis[]; syncs: LibrarySync[]
}
export interface LibraryCapture {
  title?: string; kind?: ResourceKind; url?: string; content?: string; reason?: string
  tags?: string[]; projectIds?: string[]; autoAnalyze?: boolean; autoSync?: boolean
}
export interface LibraryPatch {
  title?: string; kind?: ResourceKind; tags?: string[]; reason?: string; notes?: string
  projectIds?: string[]; reading?: ReadingState; autoAnalyze?: boolean; autoSync?: boolean
}
export interface LibraryFilter { query?: string; kind?: ResourceKind; reading?: ReadingState; processing?: ProcessingState; projectId?: string; archived?: boolean }
export interface LibraryAPI {
  list(filter?: LibraryFilter): Promise<LibraryResource[]>
  detail(id: string): Promise<LibraryDetail>
  capture(input: LibraryCapture): Promise<{ resource: LibraryResource; duplicate: boolean }>
  importFile(input: LibraryCapture): Promise<{ resource: LibraryResource; duplicate: boolean } | null>
  update(id: string, patch: LibraryPatch): Promise<LibraryResource>
  archive(id: string, archived: boolean): Promise<void>
  process(id: string, action: 'fetch' | 'analyze' | 'sync'): Promise<void>
  browse(id: string): Promise<void>
  supply(id: string, content: string): Promise<void>
  refreshSync(id: string): Promise<void>
  source(id: string, sourceId: string): Promise<LibrarySource>
  ask(id: string, question: string): Promise<string>
  export(id: string): Promise<string | null>
  onChanged(callback: (resource: LibraryResource) => void): () => void
}
