import { execFile, spawn } from 'child_process'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { openSync, readFileSync, unlinkSync, closeSync } from 'fs'
import type { AiConfig, AiProviderOption, ServiceCandidate } from '../../src/types'
import { aiConfigRepo } from '../db/repositories'

export const AI_PROVIDERS: AiProviderOption[] = [
  {
    value: 'ollama',
    label: 'Ollama（本机）',
    baseUrl: 'http://localhost:11434/v1',
    needKey: false,
    hint: '本机 Ollama，无需 API Key，先执行 ollama serve 启动服务'
  },
  {
    value: 'opencode',
    label: 'OpenCode（本机 CLI）',
    baseUrl: '',
    needKey: false,
    hint: '连接本机 opencode CLI：模型列表来自 opencode models，对话走 opencode run，直接复用 opencode 已配置的模型与鉴权'
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    needKey: true,
    hint: '需要 DeepSeek API Key'
  },
  {
    value: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    needKey: true,
    hint: '需要 OpenAI API Key'
  },
  {
    value: 'moonshot',
    label: 'Moonshot / Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    needKey: true,
    hint: '需要 Moonshot API Key'
  },
  {
    value: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    needKey: false,
    hint: '任意 OpenAI 兼容接口，填写完整 Base URL（含 /v1）'
  }
]

function headers(cfg: AiConfig): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.api_key) h.Authorization = `Bearer ${cfg.api_key}`
  return h
}

// OpenCode 走本机 CLI（复用 opencode 已配置的模型与鉴权），无需常驻服务。
// --pure 跳过项目插件/MCP，避免对话被无关插件拖慢。
// 注意：bun 运行时在 node 管道子进程场景下可能挂起，因此输出重定向到临时文件再读取
function execOpencode(args: string[], readOnly = false): Promise<string> {
  const run = (bin: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const outPath = join(tmpdir(), `ph-opencode-${randomUUID()}.log`)
      let out: number
      try {
        out = openSync(outPath, 'w')
      } catch (e) {
        reject(new Error(`无法创建 opencode 输出文件：${(e as Error).message}`))
        return
      }
      const child = spawn(bin, args, {
        stdio: ['ignore', out, out],
        env: readOnly ? {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            agent: { 'project-hub-skills': { description: '仅解释用户提供的技能文本', mode: 'primary', permission: { '*': 'deny' } } }
          })
        } : process.env
      })
      const timer = setTimeout(() => child.kill('SIGKILL'), 120000)
      child.on('error', (err) => {
        clearTimeout(timer)
        closeSync(out)
        reject(new Error(err.message.slice(0, 300)))
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        closeSync(out)
        let text = ''
        try {
          text = readFileSync(outPath, 'utf-8')
        } catch {
          // ignore
        }
        try {
          unlinkSync(outPath)
        } catch {
          // ignore
        }
        if (signal) {
          reject(new Error('opencode 执行超时（120s）'))
        } else if (code !== 0) {
          reject(new Error(text.trim().slice(0, 300) || `opencode 退出码 ${code}`))
        } else {
          resolve(text)
        }
      })
    })
  return run('opencode').catch((e1: Error) => {
    const fallback = join(homedir(), '.opencode', 'bin', 'opencode')
    return run(fallback).catch(() => {
      throw e1
    })
  })
}

interface ChatMsg {
  role: 'system' | 'user'
  content: string
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, done: () => clearTimeout(timer) }
}

export class AiService {
  providers(): AiProviderOption[] {
    return AI_PROVIDERS
  }

  getConfig(): AiConfig {
    return aiConfigRepo.get()
  }

  saveConfig(data: AiConfig, id = 'default'): AiConfig {
    if (!data.model?.trim()) throw new Error('请填写模型名称')
    const provider = AI_PROVIDERS.find((p) => p.value === data.provider)
    const baseUrl = (data.base_url || provider?.baseUrl || '').trim()
    if (!baseUrl && data.provider !== 'opencode') throw new Error('请填写 Base URL')
    return aiConfigRepo.save({
      provider: data.provider,
      base_url: baseUrl.replace(/\/+$/, ''),
      api_key: (data.api_key || '').trim(),
      model: data.model.trim()
    }, id)
  }

  private effectiveBase(cfg?: AiConfig): string {
    const c = cfg ?? aiConfigRepo.get()
    const provider = AI_PROVIDERS.find((p) => p.value === c.provider)
    return (c.base_url || provider?.baseUrl || '').replace(/\/+$/, '')
  }

  private hasAi(cfg?: AiConfig): boolean {
    const c = cfg ?? aiConfigRepo.get()
    if (c.provider === 'opencode') return !!c.model
    return !!(this.effectiveBase(c) && c.model)
  }

  async listModels(cfg?: AiConfig): Promise<string[]> {
    const c = cfg ?? aiConfigRepo.get()
    if (c.provider === 'opencode') {
      const out = await execOpencode(['models'])
      const ids = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && /^[a-z0-9_.-]+\/[a-z0-9_.-]+/i.test(l))
      if (!ids.length) throw new Error('opencode models 未返回可用模型')
      return ids
    }
    const base = this.effectiveBase(c)
    if (!base) throw new Error('请先填写 Base URL')
    const t = withTimeout(15000)
    try {
      const res = await fetch(`${base}/models`, { headers: headers(c), signal: t.signal })
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id?: string }> }
        const ids = (data.data || []).map((m) => m.id).filter((x): x is string => !!x)
        if (ids.length) return ids.sort()
      }
      // Ollama 兼容回退：原生 /api/tags
      if (base.includes(':11434')) {
        const origin = new URL(base).origin
        const res2 = await fetch(`${origin}/api/tags`, { signal: t.signal })
        if (res2.ok) {
          const data2 = (await res2.json()) as { models?: Array<{ name?: string }> }
          return (data2.models || []).map((m) => m.name).filter((x): x is string => !!x).sort()
        }
      }
      throw new Error(`获取模型列表失败（HTTP ${res.status}）`)
    } catch (e) {
      throw new Error(`获取模型列表失败：${(e as Error).message}`)
    } finally {
      t.done()
    }
  }

  async test(cfg?: AiConfig): Promise<string> {
    const reply = await this.chat([{ role: 'user', content: '回复两个字：正常' }], cfg)
    return reply.slice(0, 100)
  }

  private async chatViaOpencode(messages: ChatMsg[], model: string, readOnly = false): Promise<string> {
    const prompt = messages
      .map((m) => (m.role === 'system' ? `[系统要求]\n${m.content}` : m.content))
      .join('\n\n')
    const raw = await execOpencode(['run', '--pure', '-m', model, ...(readOnly ? ['--agent', 'project-hub-skills'] : []), prompt], readOnly)    // 去掉 CLI 输出中的 ANSI 颜色与装饰行，保留正文
    const text = raw
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split('\n')
      .filter((l) => !l.startsWith('> ') && l.trim() !== '')
      .join('\n')
      .trim()
    if (!text) throw new Error('opencode 未返回内容')
    return text
  }

  async chat(messages: ChatMsg[], cfg?: AiConfig, readOnly = false): Promise<string> {
    const c = cfg ?? aiConfigRepo.get()
    if (!c.model) throw new Error('未配置 AI（请在设置中选择厂商并填写模型）')
    if (c.provider === 'opencode') {
      try {
        return await this.chatViaOpencode(messages, c.model, readOnly)
      } catch (e) {
        throw new Error(`AI 请求失败：${(e as Error).message}`)
      }
    }
    const base = this.effectiveBase(c)
    if (!base) throw new Error('未配置 AI（请在设置中选择厂商并填写模型）')
    const t = withTimeout(60000)
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: headers(c),
        signal: t.signal,
        body: JSON.stringify({ model: c.model, messages, temperature: 0.2, stream: false })
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const content = data.choices?.[0]?.message?.content
      if (!content) throw new Error('AI 返回为空')
      return content
    } catch (e) {
      const msg = (e as Error).message
      throw new Error(msg.includes('aborted') ? 'AI 请求超时' : `AI 请求失败：${msg}`)
    } finally {
      t.done()
    }
  }

  // 把本机发现的事实 + 用户查询交给 AI，返回结构化服务候选
  buildSearchPrompt(query: string, facts: string): ChatMsg[] {
    return [
      {
        role: 'system',
        content:
          '你是本机服务发现助手。根据提供的本机事实（PATH 命令、launchd 服务、运行中进程等）与用户查询，推断用户想管理的服务并给出启动命令。' +
          '严格只输出一个 JSON 数组，不要输出任何解释或代码块标记。数组元素字段：' +
          '{"name":"服务名","command":"完整启动命令","cwd":null,"port":null,"autostart":false,"description":"一句话说明"}。' +
          'command 必须是可直接在 shell 执行的完整命令；若本机事实中没有匹配项，可基于常识给出最可能的安装方式对应的命令，并在 description 注明"未在本机直接发现，建议确认"。最多返回 5 个。'
      },
      {
        role: 'user',
        content: `用户想找的服务：${query}\n\n本机发现的事实：\n${facts || '（无）'}`
      }
    ]
  }

  parseCandidates(text: string, query: string): ServiceCandidate[] {
    const match = text.match(/\[[\s\S]*\]/)
    if (!match) return []
    let arr: unknown
    try {
      arr = JSON.parse(match[0])
    } catch {
      return []
    }
    if (!Array.isArray(arr)) return []
    const out: ServiceCandidate[] = []
    for (const raw of arr.slice(0, 8)) {
      const o = raw as Record<string, unknown>
      const name = typeof o.name === 'string' ? o.name.trim() : ''
      const command = typeof o.command === 'string' ? o.command.trim() : ''
      if (!name || !command) continue
      const nativeId = `agent:${query}:${name}`
      out.push({
        key: `agent:${query}:${name}:${out.length}`,
        name,
        command,
        cwd: typeof o.cwd === 'string' && o.cwd.trim() ? o.cwd.trim() : null,
        port: typeof o.port === 'number' && o.port > 0 ? o.port : null,
        nativeId,
        source: 'agent',
        autostart: o.autostart === true,
        alreadyImported: false,
        description: typeof o.description === 'string' ? o.description : null
      })
    }
    return out
  }

  isConfigured(cfg?: AiConfig): boolean {
    return this.hasAi(cfg)
  }
}

export const aiService = new AiService()
