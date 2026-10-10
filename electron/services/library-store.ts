import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { LibraryAnalysis, LibraryDetail, LibraryFilter, LibraryResource, LibrarySource, LibrarySync } from '../../src/types/library'
import { contentHash, type ExtractedSource } from './library-source'
export class LibraryStore {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS library_resource (id TEXT PRIMARY KEY, url TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS library_resource_url ON library_resource(url) WHERE url <> '';
      CREATE TABLE IF NOT EXISTS library_source (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES library_resource(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS library_source_resource ON library_source(resource_id);
      CREATE TABLE IF NOT EXISTS library_analysis (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES library_resource(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS library_sync (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES library_resource(id), data TEXT NOT NULL);
    `)
  }
  private parse<T>(row: unknown): T | null { return row ? JSON.parse((row as { data: string }).data) : null }
  get(id: string): LibraryResource {
    const resource = this.parse<LibraryResource>(this.db.prepare('SELECT data FROM library_resource WHERE id = ?').get(id))
    if (!resource) throw new Error('资料不存在')
    return resource
  }
  duplicate(url: string): LibraryResource | null {
    return url ? this.parse<LibraryResource>(this.db.prepare('SELECT data FROM library_resource WHERE url = ?').get(url)) : null
  }
  create(resource: LibraryResource): LibraryResource {
    this.db.prepare('INSERT INTO library_resource (id,url,data) VALUES (?,?,?)').run(resource.id, resource.url, JSON.stringify(resource))
    return resource
  }
  patch(id: string, fields: Partial<LibraryResource>): LibraryResource {
    const resource = { ...this.get(id), ...fields, id, updatedAt: new Date().toISOString() }
    this.db.prepare('UPDATE library_resource SET data = ? WHERE id = ?').run(JSON.stringify(resource), id)
    return resource
  }
  list(filter: LibraryFilter = {}): LibraryResource[] {
    const clauses = ["json_extract(r.data,'$.archived') = ?"], args: (string | number)[] = [filter.archived ? 1 : 0]
    for (const key of ['kind', 'reading', 'processing'] as const) if (filter[key]) { clauses.push(`json_extract(r.data,'$.${key}') = ?`); args.push(filter[key]!) }
    if (filter.projectId) { clauses.push("EXISTS (SELECT 1 FROM json_each(json_extract(r.data,'$.projectIds')) WHERE value = ?)"); args.push(filter.projectId) }
    for (const term of (filter.query || '').trim().split(/\s+/).filter(Boolean).slice(0, 12)) {
      clauses.push(`(instr(lower(r.data), lower(?)) > 0 OR EXISTS (SELECT 1 FROM library_source s WHERE s.resource_id=r.id AND instr(lower(json_extract(s.data,'$.content')),lower(?)) > 0) OR EXISTS (SELECT 1 FROM library_analysis a WHERE a.resource_id=r.id AND instr(lower(a.data),lower(?)) > 0))`)
      args.push(term, term, term)
    }
    return this.db.prepare(`SELECT r.data FROM library_resource r WHERE ${clauses.join(' AND ')} ORDER BY json_extract(r.data,'$.createdAt') DESC`).all(...args).map(row => this.parse<LibraryResource>(row)!)
  }
  source(resourceId: string, sourceId: string): LibrarySource {
    const result = this.parse<LibrarySource>(this.db.prepare('SELECT data FROM library_source WHERE id=? AND resource_id=?').get(sourceId, resourceId))
    if (!result) throw new Error('原文快照不存在')
    return result
  }
  addSource(id: string, extracted: ExtractedSource): LibrarySource {
    const resource = this.get(id), hash = contentHash(extracted.content)
    if (resource.sourceId) {
      const current = this.source(id, resource.sourceId)
      if (current.hash === hash && current.version === extracted.version) return current
    }
    const source: LibrarySource = { ...extracted, id: randomUUID(), resourceId: id, hash, createdAt: new Date().toISOString() }
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO library_source (id,resource_id,data) VALUES (?,?,?)').run(source.id, id, JSON.stringify(source))
      this.patch(id, { sourceId: source.id, sync: null })
    })()
    return source
  }
  addAnalysis(id: string, analysis: LibraryAnalysis): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO library_analysis (id,resource_id,data) VALUES (?,?,?)').run(analysis.id, id, JSON.stringify(analysis))
      this.patch(id, { summary: analysis.summary })
    })()
  }
  saveSync(id: string, sync: LibrarySync): LibraryResource {
    let resource!: LibraryResource
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO library_sync (id,resource_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(sync.id, id, JSON.stringify(sync))
      resource = this.patch(id, { sync })
    })()
    return resource
  }
  detail(id: string): LibraryDetail {
    const resource = this.get(id)
    const rows = <T>(table: string) => this.db.prepare(`SELECT data FROM ${table} WHERE resource_id=? ORDER BY rowid DESC`).all(id).map(row => this.parse<T>(row)!)
    return {
      ...resource, source: resource.sourceId ? this.source(id, resource.sourceId) : null,
      sources: rows<LibrarySource>('library_source').map(({ content: _content, raw: _raw, ...source }) => source),
      analyses: rows<LibraryAnalysis>('library_analysis'), syncs: rows<LibrarySync>('library_sync')
    }
  }
  recover(): LibraryResource[] {
    const active = this.db.prepare("SELECT data FROM library_resource WHERE json_extract(data,'$.processing') IN ('fetching','analyzing')").all()
    for (const row of active) { const resource = this.parse<LibraryResource>(row)!; this.patch(resource.id, { processing: 'failed', jobAction: undefined, error: '应用退出中断了处理，可重试；已保存的原文和分析仍保留' }) }
    // Uploads without a returned document ID have uncertain remote outcomes; do not silently re-upload.
    for (const row of this.db.prepare("SELECT data FROM library_resource WHERE json_extract(data,'$.sync.state') = 'uploading'").all()) {
      const resource = this.parse<LibraryResource>(row)!
      this.patch(resource.id, { jobAction: undefined })
      this.saveSync(resource.id, { ...resource.sync!, state: 'failed', error: '上传被中断，请先检查 RAGFlow 文档；重试会按文件名查找已有上传', updatedAt: new Date().toISOString() })
    }
    return this.list().filter(resource => resource.processing === 'queued' || resource.jobAction === 'sync')
  }
}
