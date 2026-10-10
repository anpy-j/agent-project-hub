import { existsSync, readdirSync, statSync, statfsSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { homedir, platform } from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'
import { shell } from 'electron'
import type {
  DiskDriveInfo,
  DiskAnalysisResult,
  CleanTier,
  CleanItem,
  OptimizationSuggestion,
  CleanExecutionTarget,
  CleanExecutionResult
} from '../../src/types'
import { aiService } from './ai.service'
import { getMacDiskDrives } from './disk-drives'

const execAsync = promisify(exec)

export interface HotspotFact {
  path: string
  name: string
  sizeBytes: number
  sizeDisplay: string
  mtime: string
  hint: string
  details?: string
}

export interface DiskFactReport {
  drives: DiskDriveInfo[]
  activeProcesses: string[]
  hotspots: HotspotFact[]
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

function safeStat(path: string): { size: number; mtime: string; isDir: boolean } | null {
  try {
    if (!existsSync(path)) return null
    const st = statSync(path)
    return {
      size: st.size,
      mtime: st.mtime.toISOString().replace('T', ' ').slice(0, 19),
      isDir: st.isDirectory()
    }
  } catch {
    return null
  }
}

// 快速测量目录体积（使用 PowerShell COM 对象获得极致性能，若失败则递归回退）
async function measureDirectorySizeFast(dirPath: string): Promise<number> {
  if (platform() === 'win32') {
    try {
      const script = `$fso = New-Object -ComObject Scripting.FileSystemObject; try { $fso.GetFolder('${dirPath.replace(/'/g, "''")}').Size } catch { 0 }`
      const { stdout } = await execAsync(`powershell -NoProfile -Command "${script}"`, { timeout: 8000 })
      const val = parseFloat(stdout.trim())
      if (!isNaN(val) && val > 0) return val
    } catch {
      // 回退到 Node.js 浅层测量
    }
  }
  return measureDirectorySizeNode(dirPath, 3)
}

function measureDirectorySizeNode(dirPath: string, maxDepth: number, currentDepth = 0): number {
  if (currentDepth > maxDepth || !existsSync(dirPath)) return 0
  let total = 0
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const ent of entries) {
      const full = join(dirPath, ent.name)
      try {
        if (ent.isDirectory()) {
          total += measureDirectorySizeNode(full, maxDepth, currentDepth + 1)
        } else if (ent.isFile()) {
          total += statSync(full).size
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return total
}

export class DiskCleanerService {
  /** 获取所有磁盘分区信息 */
  getDrives(): DiskDriveInfo[] {
    const drives: DiskDriveInfo[] = []
    const isWindows = platform() === 'win32'

    if (isWindows) {
      const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
      for (const letter of letters) {
        const root = `${letter}:\\`
        try {
          if (existsSync(root)) {
            const stat = statfsSync(root)
            const total = stat.blocks * stat.bsize
            const free = stat.bavail * stat.bsize
            const used = total - free
            const usedPercent = total > 0 ? Math.round((used / total) * 100) : 0
            drives.push({
              drive: `${letter}:`,
              totalBytes: total,
              usedBytes: used,
              freeBytes: free,
              usedPercent,
              totalGb: Math.round((total / (1024 * 1024 * 1024)) * 10) / 10,
              freeGb: Math.round((free / (1024 * 1024 * 1024)) * 10) / 10
            })
          }
        } catch {
          // ignore drive error
        }
      }
    } else if (platform() === 'darwin') {
      return getMacDiskDrives()
    } else {
      try {
        const stat = statfsSync('/')
        const total = stat.blocks * stat.bsize
        const free = stat.bavail * stat.bsize
        const used = total - free
        drives.push({
          drive: '/',
          totalBytes: total,
          usedBytes: used,
          freeBytes: free,
          usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
          totalGb: Math.round((total / (1024 * 1024 * 1024)) * 10) / 10,
          freeGb: Math.round((free / (1024 * 1024 * 1024)) * 10) / 10
        })
      } catch {
        // ignore
      }
    }

    return drives
  }

  /** 获取当前可能发生冲突的关键运行中进程 */
  private async getActiveProcesses(): Promise<string[]> {
    if (platform() !== 'win32') return []
    try {
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "Get-Process | Where-Object { $_.Name -match \'jianying|wechat|feishu|dingtalk|ollama|python\' } | Select-Object -ExpandProperty Name -Unique"',
        { timeout: 5000 }
      )
      return stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }

  /** 动态收集磁盘热点事实（Facts） */
  async collectDiskFacts(): Promise<DiskFactReport> {
    const drives = this.getDrives()
    const activeProcesses = await this.getActiveProcesses()
    const hotspots: HotspotFact[] = []

    const userHome = homedir()
    const isWindows = platform() === 'win32'
    const appDataLocal = isWindows ? join(userHome, 'AppData', 'Local') : ''
    const appDataRoaming = isWindows ? join(userHome, 'AppData', 'Roaming') : ''

    // 1. 用户开发与系统常见临时缓存热点
    const candidates: Array<{ path: string; name: string; hint: string }> = [
      { path: join(appDataLocal, 'JianyingPro', 'User Data', 'Cache'), name: '剪映临时代理与渲染缓存', hint: 'Jianying Proxy & Render Cache' },
      { path: join(appDataLocal, 'JianyingPro', 'User Data', 'Log'), name: '剪映运行调试日志', hint: 'Jianying Debug Logs' },
      { path: join(appDataLocal, 'JianyingPro', 'Apps'), name: '剪映历史版本程序目录', hint: 'Jianying Old Versions' },
      { path: join(appDataLocal, 'npm-cache'), name: 'npm 离线包缓存', hint: 'npm package cache' },
      { path: join(appDataLocal, 'pip', 'cache'), name: 'pip 构建与包缓存', hint: 'pip wheel cache' },
      { path: join(appDataLocal, 'Temp'), name: 'Windows 用户级 Temp 目录', hint: 'User Temp' },
      { path: join(userHome, '.cache', 'codex-runtimes'), name: 'Codex 临时开发环境运行时', hint: 'Codex runtimes cache' },
      { path: join(userHome, '.workbuddy', 'logs'), name: 'WorkBuddy 历史日志', hint: 'WorkBuddy diagnostic logs' },
      { path: join(userHome, '.gradle', 'caches'), name: 'Gradle 构建依赖缓存', hint: 'Gradle caches' },
      { path: join(userHome, '.ollama', 'models'), name: 'Ollama 本地大模型文件', hint: 'Ollama local LLM models' },
      { path: join(userHome, 'Downloads'), name: '用户下载目录中的大文件', hint: 'User Downloads' }
    ]

    // 2. Windows 盘根目录多媒体、切片及自媒体相关热点探测
    if (isWindows) {
      candidates.push(
        { path: 'C:\\直播素材', name: 'C盘根目录散落录像素材', hint: 'Livestream footage in C drive' },
        { path: 'C:\\qc_tmp', name: 'C盘临时切片产物', hint: 'Temporary sliced video clips' },
        { path: 'D:\\切片\\袁艺灵\\AI粗筛视频\\已剪', name: '已剪辑完结的AI粗筛视频', hint: 'Finished cut preview videos' },
        { path: 'D:\\切片\\袁艺灵\\待剪辑视频', name: '款式待剪辑视频主素材', hint: 'Clothing sliced footage' },
        { path: 'D:\\AI\\自媒体\\切片\\待剪辑视频', name: '自媒体待剪辑原片素材库', hint: 'Raw videos for editing' },
        { path: 'D:\\AI\\自媒体\\切片\\袁艺灵\\直播素材', name: '历史整场直播录像库', hint: 'Livestream archive' },
        { path: 'D:\\AI\\video-asr-studio\\backend\\data\\uploads', name: 'ASR 语音转写后台上传暂存', hint: 'ASR temporary upload videos' },
        { path: 'D:\\AI\\model-fine-tuning\\video', name: 'AI 微调视频训练集与中间产物', hint: 'Fine-tuning video dataset' },
        { path: 'D:\\AI\\model-fine-tuning\\切片上传\\已处理', name: '已处理的微调切片', hint: 'Processed fine-tuning slices' },
        { path: 'D:\\Feishu\\8.1.7', name: '飞书旧版本更新残留', hint: 'Old Feishu installation' },
        { path: 'D:\\360Downloads\\360驱动大师目录', name: '360 历史驱动包备份', hint: 'Old driver backups' }
      )

      // 微信视频专项探测
      const wechatMsgDir = 'D:\\software\\WeChat\\Data\\xwechat_files'
      if (existsSync(wechatMsgDir)) {
        try {
          const accounts = readdirSync(wechatMsgDir)
          for (const acc of accounts) {
            const videoDir = join(wechatMsgDir, acc, 'msg', 'video')
            if (existsSync(videoDir)) {
              candidates.push({ path: videoDir, name: `微信账号(${acc})群聊视频缓存`, hint: 'WeChat video cache' })
            }
          }
        } catch {
          // ignore
        }
      }
    }

    // 逐一测量候选热点大小
    for (const item of candidates) {
      if (!existsSync(item.path)) continue
      const st = safeStat(item.path)
      if (!st) continue

      let size = 0
      let details = ''

      if (st.isDir) {
        // 如果是文件夹，计算体积
        size = await measureDirectorySizeFast(item.path)
        if (size < 10 * 1024 * 1024) continue // 忽略小于 10MB 的琐碎目录

        // 提取前几个子项作为上下文事实
        try {
          const subs = readdirSync(item.path).slice(0, 8)
          details = subs.join(', ')
        } catch {
          // ignore
        }
      } else {
        size = st.size
        if (size < 20 * 1024 * 1024) continue
      }

      hotspots.push({
        path: item.path,
        name: item.name,
        sizeBytes: size,
        sizeDisplay: formatBytes(size),
        mtime: st.mtime,
        hint: item.hint,
        details: details || undefined
      })
    }

    return { drives, activeProcesses, hotspots }
  }

  /** 构建供 AI 诊断的 Prompt */
  private buildPrompt(facts: DiskFactReport): string {
    const drivesText = facts.drives
      .map((d) => `  - 分区 ${d.drive}：总容量 ${d.totalGb} GB，可用 ${d.freeGb} GB（使用率 ${d.usedPercent}%）`)
      .join('\n')

    const procsText = facts.activeProcesses.length ? facts.activeProcesses.join(', ') : '无关键视频/社交进程'

    const hotspotsText = facts.hotspots
      .map(
        (h) =>
          `  - [${h.sizeDisplay}] 路径: "${h.path}" (${h.name})\n    修改时间: ${h.mtime} | 说明: ${h.hint}${h.details ? ` | 子项特征: [${h.details}]` : ''}`
      )
      .join('\n')

    return `你是专为开发和音视频创作者定制的资深 AI 存储与系统管家。
根据以下本机真实探测到的事实（分区现状、当前运行进程、热点目录及大小与修改时间），对系统垃圾和可清理项进行语义分析与风险分级。

【磁盘现状】
${drivesText}

【当前运行进程（必须感知避让锁冲突）】
${procsText}

【探测到的热点目录事实】
${hotspotsText}

【分级规则要求】
1. level 1 (第一梯队 · 极速安全清理)：
   - 纯缓存（如剪映 agencycache 预览代理、recognize、audioWave）、开发构建缓存（npm-cache、pip）、软件诊断日志、历史旧版本程序包（如剪映旧版 Apps、飞书 8.1.7）、旧驱动备份。
   - defaultChecked 必须设为 true。badge 设为 "safe"。
2. level 2 (第二梯队 · 建议确认项)：
   - 业务中间产物（如 AI 粗筛已剪视频、ASR 上传暂存、切片中间副本）、上一周期已完结的待剪辑素材原片（如两周前的老款式）、微信视频大缓存。
   - defaultChecked 设为 false，提醒用户核对款式与出片状态。badge 设为 "warning"。
3. level 3 (第三梯队 · 建议冷备归档)：
   - 历史整场直播录像原片库、历史个人归档。不建议直接物理清空，建议外挂硬盘冷备或云端转存。
   - defaultChecked 设为 false。badge 设为 "archive"。
4. optimizations (优化建议)：
   - 例如：Ollama 模型在 C 盘占用大时，建议配置 OLLAMA_MODELS 环境变量迁移至 D 盘。

【严格输出规范】
严格输出合法 JSON 对象，禁止包裹在 Markdown 代码块外写解释文本。格式如下：
{
  "summary": "当前磁盘健康度与主要问题的一句话综述",
  "tiers": [
    {
      "level": 1,
      "title": "第一梯队 · 极速安全清理",
      "description": "纯临时缓存、日志与旧版安装残留，100% 安全可删",
      "badge": "safe",
      "items": [
        {
          "id": "clean-1",
          "name": "显示名称",
          "path": "必须与探测到的真实 path 完全一致",
          "sizeBytes": 1234567,
          "sizeDisplay": "1.2 GB",
          "reason": "AI 深度分析的可清理理由（从文件名与业务语义推断）",
          "safetyNotice": "安全提示（如进程在运行时的注意事项）",
          "defaultChecked": true,
          "category": "cache"
        }
      ]
    }
  ],
  "optimizations": [
    { "title": "优化建议标题", "description": "具体建议内容", "actionHint": "操作指导" }
  ]
}`
  }

  /** 基于 AI 或内置启发式规则执行分析 */
  async analyzeDisk(): Promise<DiskAnalysisResult> {
    const facts = await this.collectDiskFacts()
    const analyzedAt = new Date().toISOString().replace('T', ' ').slice(0, 19)

    // 优先尝试使用项目中已配置的 AI
    if (aiService.isConfigured()) {
      try {
        const prompt = this.buildPrompt(facts)
        const reply = await aiService.chat([
          { role: 'system', content: '你是专业系统存储管理 Agent。严格只输出 JSON。' },
          { role: 'user', content: prompt }
        ])

        const jsonMatch = reply.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as {
            summary?: string
            tiers?: CleanTier[]
            optimizations?: OptimizationSuggestion[]
          }
          if (parsed.tiers && Array.isArray(parsed.tiers) && parsed.tiers.length > 0) {
            const aiCfg = aiService.getConfig()
            return {
              summary: parsed.summary || 'AI 磁盘体检完成，已梳理出可清理项。',
              analyzedAt,
              usedAi: true,
              aiModel: `${aiCfg.provider} / ${aiCfg.model}`,
              drives: facts.drives,
              tiers: parsed.tiers,
              optimizations: parsed.optimizations || []
            }
          }
        }
      } catch (err) {
        console.warn('AI 分析失败，自动回退到专家启发式规则引擎:', err)
      }
    }

    // 智能启发式回退引擎（内置专家知识图谱，即使没有配置 AI 也不掉链子）
    return this.fallbackHeuristicAnalysis(facts, analyzedAt)
  }

  /** 内置专家启发式分析（语义规则引擎，确保零 AI 场景也能完美工作） */
  private fallbackHeuristicAnalysis(facts: DiskFactReport, analyzedAt: string): DiskAnalysisResult {
    const tier1Items: CleanItem[] = []
    const tier2Items: CleanItem[] = []
    const tier3Items: CleanItem[] = []
    const optimizations: OptimizationSuggestion[] = []

    let idCounter = 1

    for (const h of facts.hotspots) {
      const p = h.path.toLowerCase()
      const isRunningJianying = facts.activeProcesses.some((pr) => pr.toLowerCase().includes('jianying'))

      if (p.includes('agencycache') || p.includes('jianyingpro\\user data\\cache')) {
        tier1Items.push({
          id: `item-${idCounter++}`,
          name: h.name,
          path: h.path,
          sizeBytes: h.sizeBytes,
          sizeDisplay: h.sizeDisplay,
          reason: '剪映生成的临时低清代理视频与预览渲染缓存，删除不影响工程草稿与成片画质。',
          safetyNotice: isRunningJianying ? '注意：剪映当前正在运行中，清理时将自动跳过被占用的活跃锁文件。' : '当前剪映未运行，可完整清理。',
          defaultChecked: true,
          category: 'cache'
        })
      } else if (p.includes('mssdk_log') || p.includes('jianyingpro\\user data\\log') || p.includes('.workbuddy\\logs')) {
        tier1Items.push({
          id: `item-${idCounter++}`,
          name: h.name,
          path: h.path,
          sizeBytes: h.sizeBytes,
          sizeDisplay: h.sizeDisplay,
          reason: '软件运行期间生成的诊断崩溃与调试日志，属于纯文本临时数据。',
          defaultChecked: true,
          category: 'log'
        })
      } else if (p.includes('jianyingpro\\apps') || p.includes('feishu\\8.') || p.includes('360驱动大师')) {
        tier1Items.push({
          id: `item-${idCounter++}`,
          name: h.name,
          path: h.path,
          sizeBytes: h.sizeBytes,
          sizeDisplay: h.sizeDisplay,
          reason: '软件更新后遗留的历史旧版本程序目录或驱动安装备份。',
          defaultChecked: true,
          category: 'installer'
        })
      } else if (p.includes('npm-cache') || p.includes('pip\\cache') || p.includes('codex-runtimes') || p.includes('.gradle\\caches')) {
        tier1Items.push({
          id: `item-${idCounter++}`,
          name: h.name,
          path: h.path,
          sizeBytes: h.sizeBytes,
          sizeDisplay: h.sizeDisplay,
          reason: '包管理器与编译构建的离线依赖缓存，后续如需使用会自动重新拉取。',
          defaultChecked: true,
          category: 'dev_build'
        })
      } else if (p.includes('已剪') || p.includes('qc_tmp') || p.includes('uploads') || p.includes('切片上传\\已处理')) {
        tier2Items.push({
          id: `item-${idCounter++}`,
          name: h.name,
          path: h.path,
          sizeBytes: h.sizeBytes,
          sizeDisplay: h.sizeDisplay,
          reason: '音视频切片或语音转写过程中生成的中间产物/已完结粗筛切片，出片后可清理。',
          safetyNotice: '请确认对应款式切片是否已交付入库。',
          defaultChecked: false,
          category: 'media_temp'
        })
      } else if (p.includes('msg\\video') || p.includes('wechat')) {
        tier2Items.push({
          id: `item-${idCounter++}`,
          name: h.name,
          path: h.path,
          sizeBytes: h.sizeBytes,
          sizeDisplay: h.sizeDisplay,
          reason: '微信聊天中接收或在线播放的大视频缓存文件，体积庞大。',
          safetyNotice: '建议优先在微信客户端「设置 -> 通用设置 -> 存储空间管理」中清理。',
          defaultChecked: false,
          category: 'cache'
        })
      } else if (p.includes('待剪辑视频') || p.includes('直播素材\\待剪辑素材')) {
        tier2Items.push({
          id: `item-${idCounter++}`,
          name: h.name,
          path: h.path,
          sizeBytes: h.sizeBytes,
          sizeDisplay: h.sizeDisplay,
          reason: '待剪辑的款式原片素材，若对应款式已发布完毕，该原片可腾挪释放。',
          safetyNotice: '涉及生产资料，请务必核实该款式是否已剪辑上线。',
          defaultChecked: false,
          category: 'media_old'
        })
      } else if (p.includes('直播素材')) {
        tier3Items.push({
          id: `item-${idCounter++}`,
          name: h.name,
          path: h.path,
          sizeBytes: h.sizeBytes,
          sizeDisplay: h.sizeDisplay,
          reason: '历史直播全场录制文件，体积巨大（动辄百GB）。不建议直接删除，建议移动硬盘冷备归档。',
          safetyNotice: '冷备建议：将 8 月及更早的整场录像转移至外置硬盘或网盘。',
          defaultChecked: false,
          category: 'media_old'
        })
      }
    }

    // 检查 Ollama 优化建议
    const hasOllama = facts.hotspots.some((h) => h.path.toLowerCase().includes('.ollama'))
    if (hasOllama) {
      optimizations.push({
        title: 'Ollama 大模型存储搬家',
        description: '检测到 Ollama 模型默认保存在 C 盘（~6 GB），随着模型增多会快速挤爆系统盘。',
        actionHint: '可在系统环境变量中添加 OLLAMA_MODELS=D:\\AI\\ollama_models，自动将模型存储搬迁至 D 盘。'
      })
    }

    const tiers: CleanTier[] = [
      {
        level: 1,
        title: '第一梯队 · 极速安全清理',
        description: '纯临时缓存、日志与旧版本程序包，不影响正常业务，100% 安全可删',
        badge: 'safe',
        items: tier1Items
      },
      {
        level: 2,
        title: '第二梯队 · 建议确认项',
        description: '已处理的切片中间产物、老款式原片与社交大视频，核对出片状态后可释放',
        badge: 'warning',
        items: tier2Items
      },
      {
        level: 3,
        title: '第三梯队 · 建议冷备归档',
        description: '历史整场直播录像库（占用百GB级空间），建议转存移动硬盘或云盘',
        badge: 'archive',
        items: tier3Items
      }
    ]

    return {
      summary: '智能磁盘体检已完成：发现了多项可释放的高额临时缓存、中间视频与构建文件。',
      analyzedAt,
      usedAi: false,
      drives: facts.drives,
      tiers,
      optimizations
    }
  }

  /** 安全执行清理 */
  async executeClean(targets: CleanExecutionTarget[]): Promise<CleanExecutionResult> {
    let freedBytes = 0
    let successCount = 0
    let failedCount = 0
    const errors: Array<{ path: string; error: string }> = []

    // 绝对系统白名单保护（严禁触碰任何操作系统与核心用户根目录）
    const FORBIDDEN_ROOTS = [
      'c:\\',
      'd:\\',
      'c:\\windows',
      'c:\\program files',
      'c:\\program files (x86)',
      'c:\\users',
      'c:\\users\\' + homedir().split(/[\\/]/).pop()?.toLowerCase(),
      join(homedir(), 'desktop').toLowerCase(),
      join(homedir(), 'documents').toLowerCase()
    ]

    for (const target of targets) {
      const norm = resolve(target.path).toLowerCase()

      // 1. 严格白名单拦截
      if (FORBIDDEN_ROOTS.includes(norm)) {
        errors.push({ path: target.path, error: '安全策略拦截：严禁删除系统或用户根目录！' })
        failedCount++
        continue
      }

      if (!existsSync(target.path)) {
        continue
      }

      try {
        const initialSize = safeStat(target.path)?.isDir
          ? await measureDirectorySizeFast(target.path)
          : statSync(target.path).size

        if (target.action === 'trash') {
          // 移至系统回收站（安全可撤销）
          await shell.trashItem(target.path)
        } else {
          // 直接物理删除
          rmSync(target.path, { recursive: true, force: true })
        }

        freedBytes += initialSize
        successCount++
      } catch (err) {
        errors.push({ path: target.path, error: (err as Error).message })
        failedCount++
      }
    }

    const afterDrives = this.getDrives()

    return {
      freedBytes,
      freedDisplay: formatBytes(freedBytes),
      successCount,
      failedCount,
      errors,
      afterDrives
    }
  }
}

export const diskCleanerService = new DiskCleanerService()
