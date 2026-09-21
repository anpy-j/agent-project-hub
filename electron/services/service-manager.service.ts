import { spawn, execFile } from 'child_process'
import type { ChildProcess } from 'child_process'
import { app } from 'electron'
import { homedir, tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { mkdirSync, appendFileSync, existsSync, statSync, openSync, readSync, closeSync, writeFileSync, readdirSync } from 'fs'
import type { ServiceItem, ServiceStatusInfo, ServiceCandidate, ServiceLogChunk, ServiceAnomaly, AgentSearchResult } from '../../src/types'
import { serviceRepo } from '../db/repositories'
import { getMainWindowSender } from './runner.service'
import { aiService } from './ai.service'
import { notify } from './notify.service'

interface RunningService {
  process: ChildProcess
  runId: string
  service: ServiceItem
  logPath: string
  startedAt: string
}

const LOG_TAIL_BYTES = 256 * 1024

class ServiceManagerService {
  private running = new Map<string, RunningService>()
  private stopping = new Set<string>()
  private exitWaiters = new Map<string, Array<() => void>>()
  private recentOutput = new Map<string, string>()

  list(): ServiceItem[] {
    return serviceRepo.list()
  }

  add(data: {
    name: string
    group_name?: string | null
    command: string
    cwd?: string | null
    port?: number | null
    autostart?: boolean
    description?: string | null
    source?: ServiceItem['source']
    native_id?: string | null
  }): ServiceItem {
    if (!data.name?.trim()) throw new Error('请填写服务名称')
    if (!data.command?.trim()) throw new Error('请填写启动命令')
    return serviceRepo.insert({
      id: randomUUID(),
      name: data.name.trim(),
      group_name: data.group_name?.trim() || null,
      command: data.command.trim(),
      cwd: data.cwd?.trim() || null,
      port: data.port ?? null,
      autostart: data.autostart ? 1 : 0,
      source: data.source ?? 'manual',
      native_id: data.native_id ?? null,
      description: data.description?.trim() || null,
      last_status: null,
      last_started_at: null
    })
  }

  update(id: string, data: Partial<ServiceItem>): ServiceItem {
    const svc = serviceRepo.get(id)
    if (!svc) throw new Error(`服务不存在: ${id}`)
    if (this.running.has(id)) throw new Error('服务运行中，请先停止后再修改')
    return serviceRepo.update(id, data)
  }

  remove(id: string): void {
    if (this.running.has(id)) {
      this.stop(id)
    }
    serviceRepo.remove(id)
  }

  async start(serviceId: string): Promise<string> {
    const svc = serviceRepo.get(serviceId)
    if (!svc) throw new Error(`服务不存在: ${serviceId}`)
    if (this.running.has(serviceId)) throw new Error(`服务已在运行: ${svc.name}`)

    const runId = randomUUID()
    const logPath = this.ensureLogPath(serviceId)
    const cwd = svc.cwd && existsSync(svc.cwd) ? svc.cwd : app.getPath('home')

    const child = spawn(svc.command, {
      cwd,
      env: { ...process.env },
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const startedAt = new Date().toISOString()
    this.running.set(serviceId, { process: child, runId, service: svc, logPath, startedAt })
    this.stopping.delete(serviceId)
    serviceRepo.update(serviceId, { last_status: 'running', last_started_at: startedAt })

    appendFileSync(
      logPath,
      `\n[ProjectHub] 启动服务「${svc.name}」 · ${startedAt} · ${svc.command}\n`
    )

    const emit = (stream: 'stdout' | 'stderr', data: string) => {
      const chunk: ServiceLogChunk = { serviceId, runId, stream, data, timestamp: Date.now() }
      this.send('service:log', chunk)
      appendFileSync(logPath, data)
      // 记录最近输出用于异常归因（上限 8KB）
      const buf = (this.recentOutput.get(serviceId) || '') + data
      this.recentOutput.set(serviceId, buf.length > 8192 ? buf.slice(-8192) : buf)
    }

    child.stdout?.on('data', (d: Buffer) => emit('stdout', d.toString()))
    child.stderr?.on('data', (d: Buffer) => emit('stderr', d.toString()))

    child.on('error', (err) => {
      emit('stderr', `[进程错误] ${err.message}\n`)
    })

    child.on('exit', (code, signal) => {
      const entry = this.running.get(serviceId)
      this.running.delete(serviceId)
      const userStopped = this.stopping.has(serviceId)
      this.stopping.delete(serviceId)

      const status: ServiceStatusInfo['status'] =
        userStopped || signal === 'SIGTERM' || signal === 'SIGKILL' || code === 0 ? 'stopped' : 'abnormal'
      serviceRepo.update(serviceId, { last_status: status })
      this.send('service:status', {
        serviceId,
        status,
        pid: null,
        detail: `退出码 ${code ?? '-'}${signal ? `（信号 ${signal}）` : ''}`
      })

      if (status === 'abnormal') {
        const name = entry?.service.name ?? svc.name
        const hint = this.diagnoseExit(this.recentOutput.get(serviceId) || '')
        this.recentOutput.delete(serviceId)
        const anomaly: ServiceAnomaly = {
          serviceId,
          serviceName: name,
          exitCode: code,
          message: `服务「${name}」异常退出（退出码 ${code ?? '-'}）${hint ? `。${hint}` : ''}`
        }
        this.send('service:anomaly', anomaly)
        notify(`服务异常 · ${name}`, anomaly.message)
      } else {
        this.recentOutput.delete(serviceId)
      }

      this.resolveExitWaiters(serviceId)
    })

    this.send('service:status', { serviceId, status: 'running', pid: child.pid ?? null, detail: '已启动' })
    return runId
  }

  async stop(serviceId: string): Promise<void> {
    const entry = this.running.get(serviceId)
    if (!entry) return
    this.stopping.add(serviceId)
    const pid = entry.process.pid
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && pid) {
          process.kill(-pid, signal) // 负 PID = 杀整个进程组（shell + 子进程）
        } else {
          entry.process.kill(signal)
        }
      } catch {
        try {
          entry.process.kill(signal)
        } catch {
          // ignore
        }
      }
    }
    killGroup('SIGTERM')
    // 3 秒后仍在运行则强杀
    setTimeout(() => {
      if (this.running.has(serviceId)) killGroup('SIGKILL')
    }, 3000)
  }

  async restart(serviceId: string): Promise<string> {
    if (this.running.has(serviceId)) {
      await this.stop(serviceId)
      await this.waitExit(serviceId, 5000)
    }
    return this.start(serviceId)
  }

  async probe(serviceId: string): Promise<ServiceStatusInfo> {
    const svc = serviceRepo.get(serviceId)
    if (!svc) return { serviceId, status: 'stopped', pid: null, detail: '服务不存在' }
    const entry = this.running.get(serviceId)
    if (entry) {
      return { serviceId, status: 'running', pid: entry.process.pid ?? null, detail: '由 ProjectHub 托管' }
    }
    if (svc.port) {
      const listening = await this.probePort(svc.port)
      return listening
        ? { serviceId, status: 'running', pid: null, detail: `端口 ${svc.port} 监听中（外部进程）` }
        : { serviceId, status: svc.last_status === 'abnormal' ? 'abnormal' : 'stopped', pid: null, detail: `端口 ${svc.port} 未监听` }
    }
    return {
      serviceId,
      status: svc.last_status === 'abnormal' ? 'abnormal' : 'stopped',
      pid: null,
      detail: '未配置端口，无法探测外部进程'
    }
  }

  async probeAll(): Promise<Array<ServiceItem & { status: ServiceStatusInfo }>> {
    const items = serviceRepo.list()
    return Promise.all(items.map(async (s) => ({ ...s, status: await this.probe(s.id) })))
  }

  readLog(serviceId: string): string {
    const logPath = join(app.getPath('userData'), 'logs', 'services', `${serviceId}.log`)
    if (!existsSync(logPath)) return ''
    const size = statSync(logPath).size
    const start = Math.max(0, size - LOG_TAIL_BYTES)
    const length = size - start
    const buf = Buffer.alloc(length)
    const fd = openSync(logPath, 'r')
    try {
      readSync(fd, buf, 0, length, start)
    } finally {
      closeSync(fd)
    }
    return (start > 0 ? '…（仅显示末尾 256KB）\n' : '') + buf.toString('utf-8')
  }

  clearLog(serviceId: string): void {
    const logPath = join(app.getPath('userData'), 'logs', 'services', `${serviceId}.log`)
    if (existsSync(logPath)) writeFileSync(logPath, '')
  }

  // 自启动：autostart=1 的服务随应用启动拉起
  async autostart(): Promise<void> {
    const items = serviceRepo.list().filter((s) => s.autostart)
    for (const svc of items) {
      try {
        if (svc.port && (await this.probePort(svc.port))) {
          serviceRepo.update(svc.id, { last_status: 'running' })
          continue // 端口已在监听视为外部已启动，避免重复拉起
        }
        await this.start(svc.id)
      } catch (err) {
        serviceRepo.update(svc.id, { last_status: 'abnormal' })
        const anomaly: ServiceAnomaly = {
          serviceId: svc.id,
          serviceName: svc.name,
          exitCode: null,
          message: `服务「${svc.name}」自启动失败：${(err as Error).message}`
        }
        this.send('service:anomaly', anomaly)
      }
    }
  }

  listRunning(): Array<{ serviceId: string; runId: string; pid: number | null }> {
    return Array.from(this.running.entries()).map(([serviceId, e]) => ({
      serviceId,
      runId: e.runId,
      pid: e.process.pid ?? null
    }))
  }

  cleanupAll(): void {
    for (const [id, entry] of this.running) {
      try {
        if (process.platform !== 'win32' && entry.process.pid) {
          process.kill(-entry.process.pid, 'SIGKILL')
        } else {
          entry.process.kill('SIGKILL')
        }
      } catch {
        // ignore
      }
      this.running.delete(id)
    }
  }

  // ---- 系统服务导入（launchd / 任务计划 / PATH CLI） ----
  async importScan(): Promise<ServiceCandidate[]> {
    let base: ServiceCandidate[] = []
    if (process.platform === 'darwin') {
      base = await this.scanLaunchAgents()
    } else if (process.platform === 'win32') {
      base = await this.scanScheduledTasks()
    }
    const cli = await this.scanPathBins()
    return [...base, ...cli]
  }

  importSelected(candidates: ServiceCandidate[]): number {
    let count = 0
    for (const c of candidates) {
      if (serviceRepo.findByNativeId(c.source, c.nativeId)) continue
      this.add({
        name: c.name,
        group_name: c.source === 'cli' ? 'CLI' : c.source === 'agent' ? 'AI 发现' : '系统导入',
        command: c.command,
        cwd: c.cwd,
        port: c.port ?? null,
        autostart: c.autostart,
        description: c.description ?? (c.source === 'cli' ? `PATH 命令：${c.nativeId}` : c.source === 'agent' ? `AI Agent 发现：${c.nativeId}` : undefined),
        source: c.source,
        native_id: c.nativeId
      })
      count++
    }
    return count
  }

  // 扫描 PATH 中的可执行命令（codex、antigravity 等 CLI 工具）
  async scanPathBins(): Promise<ServiceCandidate[]> {
    const home = app.getPath('home')
    const dirSet = new Set<string>()
    for (const d of (process.env.PATH || '').split(':')) {
      if (d && !d.startsWith(tmpdir()) && !d.includes('/snap/')) dirSet.add(d)
    }
    dirSet.add(join(home, '.local', 'bin'))
    dirSet.add(join(home, 'Library', 'pnpm'))
    const pnpmBin = await new Promise<string>((resolve) => {
      execFile('pnpm', ['bin', '-g'], { timeout: 5000 }, (err, stdout) => resolve(err ? '' : String(stdout || '').trim()))
    })
    if (pnpmBin) dirSet.add(pnpmBin)

    const seen = new Set<string>()
    const out: ServiceCandidate[] = []
    for (const dir of dirSet) {
      let files: string[] = []
      try {
        if (!statSync(dir).isDirectory()) continue
        files = readdirSync(dir)
      } catch {
        continue
      }
      for (const f of files) {
        if (f.startsWith('.') || f.includes(' ') || out.length >= 400) continue
        const full = join(dir, f)
        try {
          const st = statSync(full)
          if (!st.isFile() || !(st.mode & 0o111)) continue
        } catch {
          continue
        }
        if (seen.has(f)) continue
        seen.add(f)
        const nativeId = `cli:${f}`
        out.push({
          key: `cli:${full}`,
          name: f,
          command: f,
          cwd: null,
          port: null,
          nativeId,
          source: 'cli',
          autostart: false,
          alreadyImported: !!serviceRepo.findByNativeId('cli', nativeId),
          description: `PATH 命令（${dir}）`
        })
      }
    }
    return out
  }

  // AI Agent 搜索：先做本机确定性发现，再交给 AI 提炼为可导入的服务定义
  async agentSearch(query: string): Promise<AgentSearchResult> {
    const q = (query || '').trim()
    if (!q) throw new Error('请输入要搜索的服务名')
    const { facts, candidates } = await this.discover(q)

    if (!aiService.isConfigured()) {
      return {
        query: q,
        usedAi: false,
        notice: '未配置 AI（设置 → AI 设置），以下为本机直接发现的结果',
        candidates
      }
    }
    let aiCandidates: ServiceCandidate[] = []
    let notice = ''
    try {
      const reply = await aiService.chat(aiService.buildSearchPrompt(q, facts))
      aiCandidates = aiService.parseCandidates(reply, q)
      if (!aiCandidates.length) notice = 'AI 未返回可用的服务定义，以下为本机直接发现的结果'
    } catch (e) {
      notice = `AI 调用失败（${(e as Error).message}），以下为本机直接发现的结果`
    }

    // 合并去重：AI 结果在前，确定性结果在后（按 name+command 去重）
    const merged: ServiceCandidate[] = []
    const seen = new Set<string>()
    for (const c of [...aiCandidates, ...candidates]) {
      const sig = `${c.name}|${c.command}`
      if (seen.has(sig)) continue
      seen.add(sig)
      merged.push(c)
    }
    return { query: q, usedAi: aiCandidates.length > 0, notice, candidates: merged }
  }

  // 本机确定性发现：PATH 命令、launchd、运行中进程
  private async discover(query: string): Promise<{ facts: string; candidates: ServiceCandidate[] }> {
    const facts: string[] = []
    const candidates: ServiceCandidate[] = []

    // 1. which 查找可执行文件
    const binPath = await new Promise<string>((resolve) => {
      execFile('which', [query], { timeout: 5000 }, (err, stdout) => resolve(err ? '' : String(stdout || '').trim()))
    })
    if (binPath) {
      facts.push(`命令 ${query} 位于 ${binPath}`)
      const nativeId = `cli:${query}`
      candidates.push({
        key: `discover:which:${query}`,
        name: query,
        command: query,
        cwd: null,
        port: null,
        nativeId,
        source: 'cli',
        autostart: false,
        alreadyImported: !!serviceRepo.findByNativeId('cli', nativeId),
        description: `本机命令（${binPath}）`
      })
    }

    // 2. launchd / CLI 扫描中匹配
    try {
      const [agents, clis] = await Promise.all([this.scanLaunchAgents(), this.scanPathBins()])
      const kw = query.toLowerCase()
      for (const c of [...agents, ...clis]) {
        if (c.name.toLowerCase().includes(kw) || c.command.toLowerCase().includes(kw)) {
          candidates.push({ ...c, key: `discover:${c.key}` })
        }
      }
    } catch {
      // ignore
    }

    // 3. 运行中的进程
    const psOut = await new Promise<string>((resolve) => {
      execFile('ps', ['-axo', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024, timeout: 10000 }, (err, stdout) =>
        resolve(err ? '' : String(stdout || ''))
      )
    })
    const kw = query.toLowerCase()
    const procLines = psOut
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l.toLowerCase().includes(kw) && !l.includes('grep') && !/ProjectHub|Electron/.test(l))
      .slice(0, 3)
    for (const line of procLines) {
      const m = line.match(/^(\d+)\s+(.*)$/)
      if (!m) continue
      facts.push(`发现运行中的进程：pid=${m[1]} ${m[2].slice(0, 200)}`)
    }
    if (!procLines.length) facts.push(`未发现名称包含 ${query} 的运行中进程`)

    return { facts: facts.join('\n'), candidates }
  }

  private async scanLaunchAgents(): Promise<ServiceCandidate[]> {
    const home = app.getPath('home')
    const dirs = [join(home, 'Library', 'LaunchAgents'), '/Library/LaunchAgents']
    const candidates: ServiceCandidate[] = []
    for (const dir of dirs) {
      let files: string[] = []
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.plist'))
      } catch {
        continue
      }
      for (const file of files) {
        const full = join(dir, file)
        try {
          const json = await new Promise<Record<string, unknown>>((resolve, reject) => {
            execFile('plutil', ['-convert', 'json', '-o', '-', full], (err, stdout) =>
              err ? reject(err) : resolve(JSON.parse(String(stdout || '{}')))
            )
          })
          const label = String(json.Label || file.replace(/\.plist$/, ''))
          if (label.startsWith('com.apple.')) continue // 跳过 Apple 系统代理
          const argv = Array.isArray(json.ProgramArguments)
            ? (json.ProgramArguments as unknown[]).map(String)
            : typeof json.Program === 'string'
              ? [json.Program]
              : null
          if (!argv || argv.length === 0) continue
          const command = argv.map(quoteIfNeeded).join(' ')
          const cwd = typeof json.WorkingDirectory === 'string' ? json.WorkingDirectory : null
          const autostart = json.RunAtLoad === true || json.KeepAlive === true
          candidates.push({
            key: `launchd:${full}`,
            name: label,
            command,
            cwd,
            nativeId: label,
            source: 'launchd',
            autostart,
            alreadyImported: !!serviceRepo.findByNativeId('launchd', label)
          })
        } catch {
          // 单个 plist 解析失败不影响其余
        }
      }
    }
    return candidates
  }

  private async scanScheduledTasks(): Promise<ServiceCandidate[]> {
    const raw = await new Promise<string>((resolve) => {
      execFile('schtasks', ['/query', '/fo', 'csv', '/v', '/nh'], { maxBuffer: 16 * 1024 * 1024, timeout: 30000 }, (err, stdout) =>
        resolve(err ? '' : String(stdout || ''))
      )
    })
    const candidates: ServiceCandidate[] = []
    for (const row of parseCsvLines(raw)) {
      // 标准列：0=HostName 1=TaskName 3=Status 8=Task To Run（本地化系统可能偏移，尽力而为）
      const taskName = (row[1] || '').trim()
      const status = (row[3] || '').trim()
      const taskToRun = (row[8] || '').trim()
      if (!taskName || !taskToRun) continue
      if (/\\microsoft\\/i.test(taskName)) continue // 跳过 Windows 系统任务
      if (!/ready|running|已就绪|正在运行/i.test(status)) continue
      candidates.push({
        key: `schtasks:${taskName}`,
        name: taskName.split('\\').pop() || taskName,
        command: taskToRun,
        cwd: null,
        nativeId: taskName,
        source: 'schtasks',
        autostart: true,
        alreadyImported: !!serviceRepo.findByNativeId('schtasks', taskName)
      })
    }
    return candidates
  }

  // 根据退出前的输出给出可操作的异常提示
  private diagnoseExit(output: string): string {
    if (/interactive TTY|requires? a TTY|needs? a TTY|需要交互式/i.test(output)) {
      return '该命令以交互式界面（TUI）启动，无法在后台运行。请编辑服务，把命令改成对应的守护进程/服务模式子命令（例如 openclaw gateway）'
    }
    if (/EADDRINUSE|address already in use|端口已被占用/i.test(output)) {
      return '端口已被占用：可能该服务已由系统（launchd/任务计划）或其他进程启动，可在服务列表查看端口探测状态，或更换端口'
    }
    if (/command not found|命令未找到|ENOENT/i.test(output)) {
      return '命令未找到：请确认命令已安装且在 PATH 中，或使用绝对路径'
    }
    return ''
  }

  // ---- 内部工具 ----
  private send(channel: string, payload: unknown): void {
    getMainWindowSender()?.(channel, payload)
  }

  private ensureLogPath(serviceId: string): string {
    const dir = join(app.getPath('userData'), 'logs', 'services')
    mkdirSync(dir, { recursive: true })
    return join(dir, `${serviceId}.log`)
  }

  private resolveExitWaiters(serviceId: string): void {
    const list = this.exitWaiters.get(serviceId) || []
    this.exitWaiters.delete(serviceId)
    list.forEach((fn) => fn())
  }

  private waitExit(serviceId: string, timeoutMs: number): Promise<void> {
    if (!this.running.has(serviceId)) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      const list = this.exitWaiters.get(serviceId) || []
      list.push(done)
      this.exitWaiters.set(serviceId, list)
    })
  }

  probePort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        execFile('netstat', ['-ano', '-p', 'tcp'], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
          if (err) return resolve(false)
          const hit = String(stdout || '')
            .split('\n')
            .some((line) => line.includes(`:${port} `) && /LISTENING/i.test(line))
          resolve(hit)
        })
      } else {
        execFile('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], { timeout: 15000 }, (err, stdout) => {
          if (err && !String(stdout || '').trim()) return resolve(false)
          const lines = String(stdout || '').trim().split('\n').filter((l) => l && !l.startsWith('COMMAND'))
          resolve(lines.length > 0)
        })
      }
    })
  }
}

function quoteIfNeeded(part: string): string {
  if (!part) return '""'
  return /[\s"'$&*(){}[\];<>?|\\]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part
}

function parseCsvLines(text: string): string[][] {
  const rows: string[][] = []
  let cur: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      cur.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      cur.push(field)
      field = ''
      if (cur.some((c) => c.trim())) rows.push(cur)
      cur = []
    } else {
      field += ch
    }
  }
  cur.push(field)
  if (cur.some((c) => c.trim())) rows.push(cur)
  return rows
}

export const serviceManager = new ServiceManagerService()
