import { spawn, execFile, execFileSync } from 'child_process'
import type { ChildProcess } from 'child_process'
import { stopProcessTree, stopProcessTreeSync } from './process-tree'
import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { join, basename } from 'path'
import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'fs'
import type { TaskHistory, LogChunk, TaskStat, ProjectArtifact } from '../../src/types'
import { projectRepo } from '../db/repositories'
import { resolveRunCommand, resolveBuildCommand, findArtifacts } from '../strategies/project-commands'
import { listBuildTargets, projectChild, buildEnvironment } from './build-targets'
import { flutterEnvironment, isFlutter } from './flutter-environment'
import { notify } from './notify.service'
import { getDb } from '../db'

type Sender = (channel: string, payload: unknown) => void

interface SpawnCommand {
  bin: string
  args: string[]
  env: Record<string, string | undefined>
  cwd: string
  display: string
}

interface RunningTask {
  process: ChildProcess
  stopPromise?: Promise<void>
  task: TaskHistory
  logPath: string
  cmd: SpawnCommand
  sender: Sender
  autoRestart: boolean
  attempt: number
  userStopped: boolean
  restartTimer: NodeJS.Timeout | null
}

const MAX_RESTARTS = 5
const RESTART_DELAY_MS = 3000

class RunnerService {
  private running = new Map<string, RunningTask>()
  private checkingBuilds = new Set<string>()

  async start(projectId: string, sender: Sender): Promise<string> {
    const project = projectRepo.get(projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)
    const cmd = resolveRunCommand(project)
    if (isFlutter(cmd.cwd)) {
      const target = listBuildTargets(project).find(t => projectChild(project.path, t.directory) === cmd.cwd && (t.flutterSdk || t.javaHome || t.androidSdk))
      const { report, env } = await flutterEnvironment(cmd.cwd, target, false, true)
      if (report.errors.length) throw new Error(report.errors.join('\n'))
      cmd.env = env; cmd.display = `Flutter ${report.version} · ${report.sdk}\n${cmd.display}`
    }
    return this.spawnTask(projectId, cmd, 'run', sender)
  }

  async startCustom(
    projectId: string,
    input: { bin: string; args: string[]; display?: string },
    sender: Sender,
    metadata: Pick<TaskHistory, 'build_target_id' | 'build_snapshot' | 'source_revision'> = {}
  ): Promise<string> {
    const project = projectRepo.get(projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)
    const display = input.display || [input.bin, ...input.args].join(' ')
    let environment = { ...process.env }
    if (isFlutter(project.path) && /\bflutter\b/.test(display)) {
      const target = listBuildTargets(project).find(t => projectChild(project.path, t.directory) === project.path && (t.flutterSdk || t.javaHome || t.androidSdk))
      const { report, env } = await flutterEnvironment(project.path, target, false, true)
      if (report.errors.length) throw new Error(report.errors.join('\n'))
      environment = env
    }
    return this.spawnTask(
      projectId,
      { bin: input.bin, args: input.args, env: environment, cwd: project.path, display },
      'run',
      sender
    )
  }

  /** 打包 / 构建：与运行走同一条任务链路（task_history.type = 'build'） */
  async startBuild(projectId: string, sender: Sender, targetId?: string): Promise<string> {
    const project = projectRepo.get(projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)
    if (this.checkingBuilds.has(projectId) || [...this.running.values()].some(e => e.task.project_id === projectId && e.task.type === 'build')) throw new Error('该项目已有构建正在进行')
    this.checkingBuilds.add(projectId)
    try {
    const target = targetId ? listBuildTargets(project).find(t => t.id === targetId) : undefined
    if (targetId && !target) throw new Error('构建目标不存在')
    if (target && target.platform !== 'any' && target.platform !== process.platform) throw new Error('请在目标平台的机器上执行此构建')
    const cmd = target ? {
      bin: target.commands.map(c => `(${c})`).join(' && '), args: [],
      cwd: projectChild(project.path, target.directory), env: buildEnvironment(target),
      display: `[${target.name}]${target.flutterSdk ? ` Flutter SDK: ${target.flutterSdk}\n` : ' '} ${target.commands.join(' && ')}`
    } : resolveBuildCommand(project)
    if (isFlutter(cmd.cwd)) {
      const { report, env } = await flutterEnvironment(cmd.cwd, target, /\b(apk|appbundle)\b/.test(cmd.display), true)
      if (report.errors.length) throw new Error('构建前检查未通过：\n' + report.errors.join('\n'))
      cmd.env = env; cmd.display = `Flutter ${report.version} · ${report.source}\nSDK: ${report.sdk}\nGradle Java ${report.javaVersion}: ${report.javaHome || 'Flutter 自动选择'}\nAndroid SDK: ${report.androidSdk || '未指定'}\n${report.warnings.join('\n')}\n${cmd.display}`
    }
    let revision: string | null = null
    try {
      const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cmd.cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: cmd.cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      revision = hash + (dirty ? ' (含未提交修改)' : '')
    } catch { /* 非 Git 项目 */ }
    return await this.spawnTask(projectId, cmd, 'build', sender, {
      build_target_id: target?.id || null,
      build_snapshot: target ? JSON.stringify(target) : null,
      source_revision: revision
    })
    } finally { this.checkingBuilds.delete(projectId) }
  }

  /** 实时探测构建产物目录（不落库，避免产物变化后数据过期） */
  artifacts(projectId: string, targetId?: string): ProjectArtifact[] {
    const project = projectRepo.get(projectId)
    if (!project) return []
    const target = targetId ? listBuildTargets(project).find(t => t.id === targetId) : undefined
    const paths = target ? target.artifactPaths.map(path => projectChild(projectChild(project.path, target.directory), path)).filter(existsSync) : findArtifacts(project)
    return paths.map((dir) => ({
      name: basename(dir) || dir,
      path: dir
    }))
  }

  private isAutoRestartEnabled(projectId: string): boolean {
    try {
      const row = getDb()
        .prepare('SELECT auto_restart FROM project_config WHERE project_id = ?')
        .get(projectId) as { auto_restart: number | null } | undefined
      return !!row?.auto_restart
    } catch {
      return false
    }
  }

  private async spawnTask(
    projectId: string,
    cmd: SpawnCommand,
    type: TaskHistory['type'],
    sender: Sender,
    metadata: Pick<TaskHistory, 'build_target_id' | 'build_snapshot' | 'source_revision'> = {}
  ): Promise<string> {
    if (type === 'run' && [...this.running.values()].some(e => e.task.project_id === projectId && e.task.type === 'run')) {
      throw new Error('该项目仍在运行或停止中，请等待退出后再启动')
    }
    const taskId = randomUUID()
    const logPath = this.ensureLogPath(taskId)

    const task: TaskHistory = {
      build_target_id: null, build_snapshot: null, source_revision: null, ...metadata,
      id: taskId,
      project_id: projectId,
      type,
      status: 'running',
      command: cmd.display,
      log_path: logPath,
      pid: null,
      exit_code: null,
      started_at: new Date().toISOString(),
      ended_at: null
    }

    this.persistTask(task)
    projectRepo.update(projectId, { last_run_at: task.started_at })

    const entry: RunningTask = {
      process: null as unknown as ChildProcess,
      task,
      logPath,
      cmd,
      sender,
      autoRestart: type === 'run' && this.isAutoRestartEnabled(projectId),
      attempt: 0,
      userStopped: false,
      restartTimer: null
    }
    this.running.set(taskId, entry)
    this.launch(entry)
    return taskId
  }

  private launch(entry: RunningTask): void {
    const { cmd, sender } = entry
    const taskId = entry.task.id
    const child = spawn(cmd.bin, cmd.args, {
      cwd: cmd.cwd,
      env: cmd.env,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    entry.process = child
    entry.task = {
      ...entry.task,
      status: 'running',
      pid: child.pid ?? null,
      exit_code: null,
      ended_at: null,
      started_at: new Date().toISOString()
    }
    this.updateRunningRow(entry.task)
    sender('runner:status', entry.task)

    const emit = (stream: 'stdout' | 'stderr', data: string) => {
      const chunk: LogChunk = { taskId, stream, data, timestamp: Date.now() }
      sender('runner:log', chunk)
      appendFileSync(entry.logPath, data)
    }

    child.stdout?.on('data', (d: Buffer) => emit('stdout', d.toString()))
    child.stderr?.on('data', (d: Buffer) => emit('stderr', d.toString()))

    child.on('close', async (code, signal) => {
      let stopFailed = false
      if (entry.stopPromise) {
        try { await entry.stopPromise } catch { stopFailed = true }
      }
      let status: TaskHistory['status'] = 'failed'
      if (stopFailed) status = 'failed'
      else if (entry.userStopped) status = 'stopped'
      else if (code === 0) status = 'success'
      else if (signal === 'SIGTERM' || signal === 'SIGKILL') status = 'stopped'
      const finalTask: TaskHistory = {
        ...entry.task,
        status,
        exit_code: code,
        ended_at: new Date().toISOString()
      }
      entry.task = finalTask
      this.updateTaskStatus(finalTask)
      sender('runner:status', finalTask)

      const shouldRestart =
        status === 'failed' &&
        entry.autoRestart &&
        !entry.userStopped &&
        entry.attempt < MAX_RESTARTS

      const project = projectRepo.get(entry.task.project_id)
      const projectName = project?.display_name || project?.name || '项目'
      if (status === 'success' && entry.task.type === 'build') {
        notify(`构建完成 · ${projectName}`, entry.cmd.display)
      } else if (status === 'failed') {
        notify(
          `${entry.task.type === 'build' ? '构建' : '运行'}失败 · ${projectName}`,
          shouldRestart
            ? `退出码 ${code ?? 'null'}，即将自动重启`
            : `退出码 ${code ?? 'null'}｜${entry.cmd.display}`
        )
      }

      if (shouldRestart) {
        entry.attempt += 1
        const n = entry.attempt
        this.emitLocal(entry, 'stderr', `[自动重启] 进程异常退出（exit code=${code ?? 'null'}），${RESTART_DELAY_MS / 1000} 秒后进行第 ${n}/${MAX_RESTARTS} 次自动重启…\n`)
        entry.restartTimer = setTimeout(() => {
          entry.restartTimer = null
          const cur = this.running.get(taskId)
          if (!cur || cur.userStopped) return
          this.emitLocal(cur, 'stdout', `[自动重启] 正在重启（第 ${n}/${MAX_RESTARTS} 次）\n`)
          this.launch(cur)
        }, RESTART_DELAY_MS)
      } else if (!entry.restartTimer) {
        this.running.delete(taskId)
      }
    })

    child.on('error', (err) => {
      emit('stderr', `[进程错误] ${err.message}\n`)
    })
  }

  async stop(taskId: string): Promise<void> {
    const entry = this.running.get(taskId)
    if (!entry) return
    if (entry.stopPromise) return entry.stopPromise
    entry.userStopped = true
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer)
      entry.restartTimer = null
      this.running.delete(taskId)
      return
    }
    entry.stopPromise = stopProcessTree(entry.process)
    try { await entry.stopPromise }
    catch (error) {
      this.emitLocal(entry, 'stderr', '[停止失败] ' + (error as Error).message + '\n')
      entry.stopPromise = undefined
      throw error
    }
  }

  probeExternal(projectPath: string): Promise<{ running: boolean; processes: Array<{ pid: number; command: string }> }> {
    return new Promise((resolve) => {
      const prefix = projectPath.endsWith('/') ? projectPath : projectPath + '/'
      execFile(
        'lsof',
        ['-w', '-n', '-d', 'cwd', '-F', 'pn'],
        { maxBuffer: 8 * 1024 * 1024, timeout: 20000 },
        (err, stdout) => {
          if (err) return resolve({ running: false, processes: [] })
          const pids = new Set<number>()
          let cur: number | null = null
          for (const line of String(stdout || '').split('\n')) {
            if (line.startsWith('p')) cur = Number(line.slice(1))
            else if (line.startsWith('n') && cur && line.slice(1) === projectPath) pids.add(cur)
          }
          if (!pids.size) return resolve({ running: false, processes: [] })
          execFile('ps', ['-o', 'pid=,command=', '-p', [...pids].join(',')], (e2, out2) => {
            const procs = String(out2 || '')
              .split('\n')
              .filter((l) => l.trim())
              .map((l) => {
                const [pidStr, ...rest] = l.trim().split(/\s+/)
                return { pid: Number(pidStr), command: rest.join(' ') }
              })
              .filter((p) => p.pid && !p.command.includes('lsof'))
            resolve({ running: procs.length > 0, processes: procs })
          })
        }
      )
    })
  }

  listRunning(): TaskHistory[] {
    return Array.from(this.running.values()).map((e) => e.task)
  }

  /** 汇总每个运行中任务的进程资源占用（CPU% / 内存 MB / 进程数） */
  async stats(): Promise<TaskStat[]> {
    const entries = Array.from(this.running.values()).filter(
      (e) => e.task.status === 'running' && e.process?.pid
    )
    if (!entries.length) return []
    const result: TaskStat[] = entries.map((e) => ({
      taskId: e.task.id,
      pid: e.task.pid,
      cpu: 0,
      mem: 0,
      procs: 1,
      status: e.task.status
    }))
    if (process.platform === 'win32') {
      await this.fillStatsWindows(entries, result)
    } else {
      await this.fillStatsUnix(entries, result)
    }
    return result
  }

  private fillStatsUnix(entries: RunningTask[], result: TaskStat[]): Promise<void> {
    return new Promise((resolve) => {
      execFile(
        'ps',
        ['-axo', 'pid=,pgid=,pcpu=,rss='],
        { maxBuffer: 8 * 1024 * 1024, timeout: 8000 },
        (err, stdout) => {
          if (err) return resolve()
          const byPgid = new Map<number, { cpu: number; mem: number; count: number }>()
          for (const line of String(stdout || '').split('\n')) {
            const cols = line.trim().split(/\s+/)
            if (cols.length < 4) continue
            const [pidStr, pgidStr, cpuStr, rssStr] = cols
            const pgid = Number(pgidStr)
            if (!Number(pidStr) || !pgid) continue
            const agg = byPgid.get(pgid) || { cpu: 0, mem: 0, count: 0 }
            agg.cpu += parseFloat(cpuStr) || 0
            agg.mem += (parseFloat(rssStr) || 0) / 1024
            agg.count += 1
            byPgid.set(pgid, agg)
          }
          entries.forEach((e, i) => {
            const pgid = e.process.pid
            const agg = pgid ? byPgid.get(pgid) : undefined
            if (agg) {
              result[i].cpu = Math.round(agg.cpu * 10) / 10
              result[i].mem = Math.round(agg.mem)
              result[i].procs = agg.count
            }
          })
          resolve()
        }
      )
    })
  }

  private async fillStatsWindows(entries: RunningTask[], result: TaskStat[]): Promise<void> {
    for (let i = 0; i < entries.length; i++) {
      const pid = entries[i].process.pid
      if (!pid) continue
      await new Promise<void>((resolve) => {
        execFile(
          'tasklist',
          ['/FO', 'CSV', '/NH', '/FI', `PID eq ${pid}`],
          { timeout: 8000 },
          (err, stdout) => {
            if (!err) {
              const m = String(stdout || '').match(/"([^"]*)"\s*,\s*"?(\d+)/)
              if (m) {
                result[i].mem = Math.round(Number(m[2]) / 1024)
              }
            }
            resolve()
          }
        )
      })
    }
  }

  readLog(taskId: string): string {
    // 运行中的任务直接读内存里登记的路径；已结束的任务从 task_history 回查，
    // 否则历史记录里的「查看日志」永远是空的。
    const logPath =
      this.running.get(taskId)?.logPath ??
      (
        getDb()
          .prepare('SELECT log_path FROM task_history WHERE id = ?')
          .get(taskId) as { log_path: string | null } | undefined
      )?.log_path
    if (logPath && existsSync(logPath)) {
      return readFileSync(logPath, 'utf-8')
    }
    return ''
  }

  cleanupAll(): void {
    for (const [id, entry] of this.running) {
      entry.userStopped = true
      if (entry.restartTimer) clearTimeout(entry.restartTimer)
      try { stopProcessTreeSync(entry.process) }
      catch (error) { console.error('[ProjectHub] 退出时清理失败', error) }
      this.running.delete(id)
    }
  }

  private emitLocal(entry: RunningTask, stream: 'stdout' | 'stderr', data: string): void {
    const chunk: LogChunk = { taskId: entry.task.id, stream, data, timestamp: Date.now() }
    entry.sender('runner:log', chunk)
    appendFileSync(entry.logPath, data)
  }

  private ensureLogPath(taskId: string): string {
    const dir = join(app.getPath('userData'), 'logs', 'tasks')
    mkdirSync(dir, { recursive: true })
    return join(dir, `${taskId}.log`)
  }

  private persistTask(task: TaskHistory): void {
    getDb()
      .prepare(
        `INSERT INTO task_history (id, project_id, type, status, command, log_path, pid, started_at, build_target_id, build_snapshot, source_revision)
         VALUES (@id, @project_id, @type, @status, @command, @log_path, @pid, @started_at, @build_target_id, @build_snapshot, @source_revision)`
      )
      .run(task)
  }

  /** 首次启动 / 自动重启时把运行状态写回 task_history */
  private updateRunningRow(task: TaskHistory): void {
    getDb()
      .prepare(`UPDATE task_history SET status = 'running', pid = ?, started_at = ?, exit_code = NULL, ended_at = NULL WHERE id = ?`)
      .run(task.pid, task.started_at, task.id)
  }

  private updateTaskStatus(task: Partial<TaskHistory> & { id: string }): void {
    getDb()
      .prepare(
        `UPDATE task_history SET status = ?, exit_code = ?, ended_at = ? WHERE id = ?`
      )
      .run(task.status, task.exit_code, task.ended_at, task.id)
  }
}

export const runnerService = new RunnerService()

export function getMainWindowSender(): Sender | null {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length === 0) return null
  const win = wins[0]
  return (channel: string, payload: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
