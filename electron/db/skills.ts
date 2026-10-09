import { getDb } from './index'
import type { SkillsStore } from '../services/skills-store'
import type { SkillHistory, SkillInstallation, SkillPackage } from '../../src/types/skills'

export function createSkillsStore(): SkillsStore {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_package (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS skill_installation (id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skill_package(id), payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS skill_installation_package ON skill_installation(skill_id);
    CREATE TABLE IF NOT EXISTS skill_history (id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS skill_history_package ON skill_history(skill_id, created_at);
  `)
  function rows<T>(table: string): T[] {
    return (db.prepare(`SELECT payload FROM ${table}`).all() as Array<{ payload: string }>).map(r => JSON.parse(r.payload))
  }
  return {
    packages: () => rows<SkillPackage>('skill_package'),
    savePackage: value => { db.prepare('INSERT INTO skill_package (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(value.id, JSON.stringify(value)) },
    removePackage: id => { db.prepare('DELETE FROM skill_package WHERE id=?').run(id) },
    installations: () => rows<SkillInstallation>('skill_installation'),
    saveInstallation: value => { db.prepare('INSERT INTO skill_installation (id, skill_id, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET skill_id=excluded.skill_id, payload=excluded.payload').run(value.id, value.skillId, JSON.stringify(value)) },
    removeInstallation: id => { db.prepare('DELETE FROM skill_installation WHERE id=?').run(id) },
    history: skillId => (db.prepare('SELECT payload FROM skill_history WHERE skill_id=? ORDER BY created_at DESC, rowid DESC LIMIT 100').all(skillId) as Array<{ payload: string }>).map(r => JSON.parse(r.payload)) as SkillHistory[],
    log: value => { db.prepare('INSERT INTO skill_history (id, skill_id, payload, created_at) VALUES (?, ?, ?, ?)').run(value.id, value.skillId, JSON.stringify(value), value.createdAt) }
  }
}
