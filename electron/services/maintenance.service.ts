import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getDb } from '../db'

/** 每个项目保留的历史任务条数（含 run / build） */
const HISTORY_KEEP_PER_PROJECT = 200
/** 任务日志文件的保留天数 */
const LOG_RETENTION_DAYS = 14

function taskLogDir(): string {
  const dir = join(app.getPath('userData'), 'logs', 'tasks')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 删除超期行，并返回这些行对应的日志路径，便于一并清理 */
function pruneHistory(): string[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, log_path FROM task_history
       WHERE status != 'running'
         AND id NOT IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY project_id ORDER BY started_at DESC
             ) AS rn
             FROM task_history
           ) WHERE rn <= @keep
         )`
    )
    .all({ keep: HISTORY_KEEP_PER_PROJECT }) as Array<{ id: string; log_path: string | null }>
  if (!rows.length) return []
  const del = db.prepare('DELETE FROM task_history WHERE id = ?')
  const tx = db.transaction(() => {
    for (const r of rows) del.run(r.id)
  })
  tx()
  return rows.map((r) => r.log_path).filter((p): p is string => !!p)
}

/** 清理孤儿日志文件与超期日志（仍被 task_history 引用的文件一律不动） */
function pruneLogFiles(): number {
  const dir = taskLogDir()
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  let removed = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    if (!name.endsWith('.log')) continue
    const full = join(dir, name)
    try {
      const st = statSync(full)
      const inDb = getDb()
        .prepare('SELECT 1 FROM task_history WHERE log_path = ? LIMIT 1')
        .get(full)
      if (inDb) continue
      if (st.mtimeMs < cutoff) {
        unlinkSync(full)
        removed += 1
      }
    } catch {
      // 单个文件失败不影响整体
    }
  }
  return removed
}

/**
 * 启动时做一次数据整理。
 * 之前 task_history 与 userData/logs/tasks/*.log 只增不减，长期使用会无限膨胀。
 */
export function runStartupMaintenance(): void {
  try {
    const orphaned = pruneHistory()
    for (const p of orphaned) {
      try {
        if (existsSync(p)) unlinkSync(p)
      } catch {
        // ignore
      }
    }
    pruneLogFiles()
  } catch {
    // 维护失败不能阻断启动
  }
}

/** 手动触发一次整理（设置页），返回清理结果与最新占用 */
export function runMaintenanceNow(): {
  removedTasks: number
  removedFiles: number
  usage: { files: number; bytes: number }
} {
  let removedTasks = 0
  let removedFiles = 0
  try {
    const orphaned = pruneHistory()
    removedTasks = orphaned.length
    for (const p of orphaned) {
      try {
        if (existsSync(p)) unlinkSync(p)
      } catch {
        // ignore
      }
    }
    removedFiles = pruneLogFiles()
  } catch {
    // ignore
  }
  return { removedTasks, removedFiles, usage: logUsage() }
}

/** 供设置页 / 调试使用：当前日志占用情况 */
export function logUsage(): { files: number; bytes: number } {
  const dir = taskLogDir()
  let files = 0
  let bytes = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.log')) continue
      try {
        bytes += statSync(join(dir, name)).size
        files += 1
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return { files, bytes }
}
