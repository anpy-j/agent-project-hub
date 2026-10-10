import { randomUUID as uuid } from 'crypto'
import { getDb } from '../index'
import { randomUUID } from 'crypto'
import type { Project, ProjectRemote, TaskItem, Workspace, ServiceItem, AiConfig } from '../../../src/types'

function parseTags(tags: string | null): string[] | null {
  if (!tags) return null
  try {
    return JSON.parse(tags) as string[]
  } catch {
    return null
  }
}

export const workspaceRepo = {
  list(): Workspace[] {
    return getDb()
      .prepare('SELECT * FROM workspace ORDER BY sort_order ASC')
      .all() as Workspace[]
  }
}

export const remoteRepo = {
  listByProject(projectId: string): ProjectRemote[] {
    return getDb()
      .prepare('SELECT * FROM project_remote WHERE project_id = ? ORDER BY is_default DESC, name ASC')
      .all(projectId) as ProjectRemote[]
  },
  replaceAll(projectId: string, remotes: Array<Omit<ProjectRemote, 'id' | 'project_id'>>): ProjectRemote[] {
    // 防御：空结果不清空已有关联（避免识别失败导致误删）
    if (!remotes.length) {
      return this.listByProject(projectId)
    }
    const db = getDb()
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM project_remote WHERE project_id = ?').run(projectId)
      const ins = db.prepare(
        'INSERT INTO project_remote (id, project_id, name, url, platform, is_default) VALUES (@id, @project_id, @name, @url, @platform, @is_default)'
      )
      for (const r of remotes) {
        ins.run({ id: randomUUID(), project_id: projectId, name: r.name, url: r.url, platform: r.platform, is_default: r.is_default ? 1 : 0 })
      }
    })
    tx()
    return this.listByProject(projectId)
  },}

function withDefaults(row: Project | undefined): Project | null {
  if (!row) return null
  return {
    ...row,
    display_name: row.display_name ?? null,
    progress_percent: row.progress_percent ?? 0,
    progress_stage: row.progress_stage ?? 'planning',
    progress_note: row.progress_note ?? '',
    remotes: remoteRepo.listByProject(row.id)
  }
}

export const projectRepo = {
  list(workspaceId?: string): Project[] {
    const db = getDb()
    const rows = (
      workspaceId
        ? db.prepare('SELECT * FROM project WHERE workspace_id = ? ORDER BY updated_at DESC').all(workspaceId)
        : db.prepare('SELECT * FROM project ORDER BY updated_at DESC').all()
    ) as Project[]
    return rows.map((r) => ({
      ...r,
      display_name: r.display_name ?? null,
      progress_percent: r.progress_percent ?? 0,
      progress_stage: r.progress_stage ?? 'planning',
      progress_note: r.progress_note ?? '',
      remotes: remoteRepo.listByProject(r.id)
    }))
  },

  get(id: string): Project | null {
    const row = getDb()
      .prepare('SELECT * FROM project WHERE id = ?')
      .get(id) as Project | undefined
    return withDefaults(row)
  },

  insert(data: {
    id: string
    workspace_id: string
    name: string
    path: string
    type: string
    framework: string | null
    description: string | null
    remotes?: Array<{ name: string; url: string; platform: string; is_default: number }>
  }): Project {
    const db = getDb()
    db.prepare(
      `INSERT INTO project (id, workspace_id, name, path, type, framework, description)
       VALUES (@id, @workspace_id, @name, @path, @type, @framework, @description)`
    ).run(data)
    if (data.remotes?.length) {
      remoteRepo.replaceAll(
        data.id,
        data.remotes.map((r) => ({
          name: r.name,
          url: r.url,
          platform: r.platform as ProjectRemote['platform'],
          is_default: r.is_default ?? 0
        }))
      )
    }
    return this.get(data.id) as Project
  },

  update(id: string, data: Partial<Project>): Project {
    const db = getDb()
    const allowed: (keyof Project)[] = [
      'name', 'display_name', 'path', 'type', 'framework', 'runtime_id',
      'tags', 'description', 'last_run_at',
      'progress_percent', 'progress_stage', 'progress_note'
    ]
    const sets: string[] = []
    const values: Record<string, unknown> = { id }
    for (const key of allowed) {
      if (key in data) {
        sets.push(`${key} = @${key}`)
        let v: unknown = data[key]
        if (key === 'tags' && Array.isArray(v)) v = JSON.stringify(v)
        if (key === 'display_name' && typeof v === 'string' && !v.trim()) v = null
        values[key] = v
      }
    }
    sets.push(`updated_at = datetime('now')`)
    db.prepare(`UPDATE project SET ${sets.join(', ')} WHERE id = @id`).run(values)
    return this.get(id) as Project
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM project WHERE id = ?').run(id)
  }
}

export const taskRepo = {
  listByProject(projectId: string): TaskItem[] {
    return getDb()
      .prepare('SELECT * FROM task WHERE project_id = ? ORDER BY sort_order ASC, created_at DESC')
      .all(projectId) as TaskItem[]
  },
  add(projectId: string, title: string, tag: string, groupName?: string | null): TaskItem {
    const db = getDb()
    const minRow = db
      .prepare('SELECT MIN(sort_order) as m FROM task WHERE project_id = ?')
      .get(projectId) as { m: number | null }
    const sortOrder = (minRow?.m ?? 0) - 1
    const id = uuid()
    db.prepare(
      'INSERT INTO task (id, project_id, title, tag, sort_order, group_name) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, projectId, title, tag, sortOrder, groupName?.trim() || null)
    return this.get(id) as TaskItem
  },
  get(id: string): TaskItem | null {
    return (getDb().prepare('SELECT * FROM task WHERE id = ?').get(id) as TaskItem | undefined) ?? null
  },
  toggle(id: string): TaskItem | null {
    getDb().prepare('UPDATE task SET done = 1 - done WHERE id = ?').run(id)
    return this.get(id)
  },
  update(id: string, data: { title?: string; tag?: string; group_name?: string | null }): TaskItem | null {
    const sets: string[] = []
    const values: Record<string, unknown> = { id }
    if (typeof data.title === 'string' && data.title.trim()) {
      sets.push('title = @title')
      values.title = data.title.trim()
    }
    if (typeof data.tag === 'string' && data.tag.trim()) {
      sets.push('tag = @tag')
      values.tag = data.tag.trim()
    }
    if ('group_name' in data) {
      sets.push('group_name = @group_name')
      const g = data.group_name
      values.group_name = typeof g === 'string' && g.trim() ? g.trim() : null
    }
    if (sets.length) {
      getDb().prepare(`UPDATE task SET ${sets.join(', ')} WHERE id = @id`).run(values)
    }
    return this.get(id)
  },
  reorder(orderedIds: string[]): void {
    const db = getDb()
    const tx = db.transaction(() => {
      const upd = db.prepare('UPDATE task SET sort_order = ? WHERE id = ?')
      orderedIds.forEach((id, index) => upd.run(index, id))
    })
    tx()
  },
  remove(id: string): void {
    getDb().prepare('DELETE FROM task WHERE id = ?').run(id)
  }
}

export const serviceRepo = {
  list(): ServiceItem[] {
    return getDb()
      .prepare('SELECT * FROM service ORDER BY group_name ASC, name ASC')
      .all() as ServiceItem[]
  },
  get(id: string): ServiceItem | null {
    const row = getDb()
      .prepare('SELECT * FROM service WHERE id = ?')
      .get(id) as ServiceItem | undefined
    return row ?? null
  },
  findByNativeId(source: string, nativeId: string): ServiceItem | null {
    const row = getDb()
      .prepare('SELECT * FROM service WHERE source = ? AND native_id = ?')
      .get(source, nativeId) as ServiceItem | undefined
    return row ?? null
  },
  insert(data: Omit<ServiceItem, 'created_at' | 'updated_at'>): ServiceItem {
    getDb()
      .prepare(
        `INSERT INTO service (id, name, group_name, command, cwd, port, autostart, source, native_id, description)
         VALUES (@id, @name, @group_name, @command, @cwd, @port, @autostart, @source, @native_id, @description)`
      )
      .run(data)
    return this.get(data.id) as ServiceItem
  },
  update(id: string, data: Partial<ServiceItem>): ServiceItem {
    const allowed: (keyof ServiceItem)[] = [
      'name', 'group_name', 'command', 'cwd', 'port', 'autostart', 'description', 'last_status', 'last_started_at'
    ]
    const sets: string[] = []
    const values: Record<string, unknown> = { id }
    for (const key of allowed) {
      if (key in data) {
        sets.push(`${key} = @${key}`)
        values[key] = data[key]
      }
    }
    if (!sets.length) return this.get(id) as ServiceItem
    sets.push(`updated_at = datetime('now')`)
    getDb().prepare(`UPDATE service SET ${sets.join(', ')} WHERE id = @id`).run(values)
    return this.get(id) as ServiceItem
  },
  remove(id: string): void {
    getDb().prepare('DELETE FROM service WHERE id = ?').run(id)
  }
}

export const aiConfigRepo = {
  get(id = 'default'): AiConfig {
    const row = getDb()
      .prepare("SELECT provider, base_url, api_key, model FROM ai_config WHERE id = ?")
      .get(id) as AiConfig | undefined
    return (
      row ?? { provider: 'ollama', base_url: 'http://localhost:11434/v1', api_key: '', model: '' }
    )
  },
  save(data: AiConfig, id = 'default'): AiConfig {
    getDb()
      .prepare(
        `INSERT INTO ai_config (id, provider, base_url, api_key, model)
         VALUES (@id, @provider, @base_url, @api_key, @model)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           base_url = excluded.base_url,
           api_key = excluded.api_key,
           model = excluded.model,
           updated_at = datetime('now')`
      )
      .run({
        id,
        provider: data.provider,
        base_url: data.base_url ?? '',
        api_key: data.api_key ?? '',
        model: data.model ?? ''
      })
    return this.get(id)
  }
}
