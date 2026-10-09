import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { SCHEMA_SQL, SEED_SQL } from './schema'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  const userData = app.getPath('userData')
  const dbDir = join(userData, 'data')
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, 'project-hub.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

const MIGRATIONS: string[] = [
  "ALTER TABLE project ADD COLUMN progress_percent INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE project ADD COLUMN progress_stage TEXT NOT NULL DEFAULT 'planning'",
  "ALTER TABLE project ADD COLUMN progress_note TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE task ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE task ADD COLUMN group_name TEXT",
  "ALTER TABLE project ADD COLUMN display_name TEXT",
  "ALTER TABLE project_config ADD COLUMN auto_restart INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE project_config ADD COLUMN hidden_run_commands TEXT NOT NULL DEFAULT '[]'"
]

function initSchema(database: Database.Database): void {
  database.exec(SCHEMA_SQL)
  database.exec(SEED_SQL)
  for (const sql of MIGRATIONS) {
    try {
      database.exec(sql)
    } catch {
      // 列已存在，忽略
    }
  }
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
