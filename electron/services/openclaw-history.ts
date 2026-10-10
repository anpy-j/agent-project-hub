import { getDb } from '../db'
import type { HttpChatMessage } from './openclaw-http'
export interface HttpSession {
  instanceId: string; key: string; title: string; updatedAt: number; messages: HttpChatMessage[]; lastRunId?: string; pending?: boolean; error?: string
}
function database() {
  const db = getDb()
  db.exec('CREATE TABLE IF NOT EXISTS openclaw_http_sessions (instance_id TEXT NOT NULL, session_key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(instance_id, session_key))')
  return db
}
export const openclawHistory = {
  list(instanceId: string): HttpSession[] {
    return (database().prepare('SELECT body FROM openclaw_http_sessions WHERE instance_id = ?').all(instanceId) as { body: string }[]).map(row => JSON.parse(row.body)).sort((a, b) => b.updatedAt - a.updatedAt)
  },
  get(instanceId: string, key: string): HttpSession | undefined {
    const row = database().prepare('SELECT body FROM openclaw_http_sessions WHERE instance_id = ? AND session_key = ?').get(instanceId, key) as { body: string } | undefined
    return row ? JSON.parse(row.body) : undefined
  },
  save(session: HttpSession): void {
    database().prepare('INSERT INTO openclaw_http_sessions VALUES (?, ?, ?) ON CONFLICT(instance_id, session_key) DO UPDATE SET body = excluded.body').run(session.instanceId, session.key, JSON.stringify(session))
  }
}
