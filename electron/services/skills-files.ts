import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse } from 'yaml'
import { unzipSync, zipSync } from 'fflate'
import type { SkillFile } from '../../src/types/skills'

export const SKILL_LIMITS = { download: 32 * 1024 * 1024, total: 96 * 1024 * 1024, file: 16 * 1024 * 1024, text: 512 * 1024, count: 3000 }
const ignored = new Set(['.git', 'node_modules', '.DS_Store', '__MACOSX'])
export const OPENAI_YAML_WARNING = 'agents/openai.yaml 无法解析；原文件会完整保留。'
// Some Windows-generated files contain CR CR LF. Normalize only the parsing
// input; the stored resource bytes and content hash remain unchanged.
const yamlText = (text: string) => text.replace(/\r+\n/g, '\n')

export function inside(root: string, path: string): string {
  const absolute = resolve(root, path), rel = relative(resolve(root), absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('路径超出技能目录')
  return absolute
}

export function safeRelative(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.includes('\0')) throw new Error('不允许的文件路径')
  const segments = normalized.split('/').filter(Boolean)
  if (segments.some(p => p === '..' || p === '.' || p.includes(':') || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) throw new Error('不允许的文件路径')
  return segments.join('/')
}

export function manifest(text: string, folderName: string): { name: string; title: string; description: string } {
  const match = yamlText(text).replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) throw new Error('SKILL.md 缺少 YAML 元数据（name、description）')
  const metadata = parse(match[1], { maxAliasCount: 0 })
  const name = metadata?.name ?? folderName
  if (typeof name !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error('技能名称需要为 1–64 位小写字母、数字和短横线')
  if (typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 4096) throw new Error('技能 description 缺失或过长')
  const title = yamlText(text).replace(/^\uFEFF/, '').slice(match[0].length).match(/^#\s+(.+)$/m)?.[1]?.trim() || name
  return { name, title, description: metadata.description.trim() }
}

export function skillFiles(root: string): SkillFile[] {
  if (lstatSync(root).isSymbolicLink()) throw new Error('请导入技能的真实目录，不能安装符号链接')
  const realRoot = realpathSync(root), files: SkillFile[] = []; let total = 0
  function visit(dir: string, depth: number): void {
    if (depth > 20) throw new Error('技能目录层级过深')
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue
      const full = join(dir, entry.name), info = lstatSync(full)
      if (info.isSymbolicLink()) throw new Error(`技能含符号链接，无法复制：${entry.name}`)
      inside(realRoot, realpathSync(full))
      if (info.isDirectory()) visit(full, depth + 1)
      else if (info.isFile()) {
        const path = safeRelative(relative(realRoot, full)); total += info.size
        if (info.size > SKILL_LIMITS.file || total > SKILL_LIMITS.total || files.length >= SKILL_LIMITS.count) throw new Error('技能文件数量或大小超过限制')
        if (/^\.env($|\.)/.test(entry.name) && !/^\.env\.(example|sample|template)$/.test(entry.name) || /^(id_rsa|id_ed25519)$/.test(entry.name)) throw new Error(`技能包含不适合导入的本地配置或私钥：${path}`)
        files.push({ path, bytes: info.size })
      } else throw new Error('技能包含非普通文件')
    }
  }
  visit(realRoot, 0)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export function readSkillText(root: string, path: string): string {
  const full = inside(root, safeRelative(path))
  inside(realpathSync(root), realpathSync(full))
  const info = lstatSync(full)
  if (!info.isFile() || info.isSymbolicLink() || info.size > SKILL_LIMITS.text) throw new Error('仅支持查看 512 KB 以内的文本文件')
  const buffer = readFileSync(full)
  if (buffer.includes(0)) throw new Error('该文件是二进制资源，无法作为文本查看')
  return buffer.toString('utf8')
}

export function skillHash(root: string): string {
  const hash = createHash('sha256')
  for (const file of skillFiles(root)) {
    hash.update(file.path).update('\0').update(String(file.bytes)).update('\0').update(readFileSync(inside(root, file.path)))
  }
  return hash.digest('hex')
}

export function copySkill(source: string, target: string): void {
  const files = skillFiles(source)
  mkdirSync(target, { recursive: true })
  for (const file of files) {
    const from = inside(source, file.path), to = inside(target, file.path)
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, readFileSync(from), { flag: 'wx' })
    if (process.platform !== 'win32') chmodSync(to, statSync(from).mode & 0o777)
  }
}

// Validate central-directory sizes and Unix file types before allocating decompression buffers.
export function extractSkillZip(buffer: Buffer, target: string): void {
  if (buffer.length > SKILL_LIMITS.download) throw new Error('压缩包超过 32 MB')
  let end = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break }
  }
  if (end < 0) throw new Error('不是可识别的 ZIP 压缩包')
  const count = buffer.readUInt16LE(end + 10), offset = buffer.readUInt32LE(end + 16)
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count || (end >= 20 && buffer.readUInt32LE(end - 20) === 0x07064b50) || count > SKILL_LIMITS.count || count === 65535) throw new Error('压缩包文件过多，或不支持 ZIP64 / 分卷格式')
  let cursor = offset, total = 0
  const names = new Set<string>(), expected = new Map<string, number>()
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 目录损坏')
    const size = buffer.readUInt32LE(cursor + 24), length = buffer.readUInt16LE(cursor + 28)
    const extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32)
    if (cursor + 46 + length + extra + comment > end) throw new Error('ZIP 目录损坏')
    const name = buffer.subarray(cursor + 46, cursor + 46 + length).toString('utf8'), path = safeRelative(name)
    const unixType = (buffer.readUInt32LE(cursor + 38) >>> 16) & 0xf000
    if (unixType && unixType !== 0x8000 && unixType !== 0x4000) throw new Error('ZIP 包含符号链接或特殊文件')
    if (buffer.readUInt16LE(cursor + 8) & 1) throw new Error('不支持加密 ZIP')
    total += size
    if (size > SKILL_LIMITS.file || total > SKILL_LIMITS.total) throw new Error('ZIP 解压大小超过限制')
    const key = path.toLowerCase()
    if (names.has(key)) throw new Error('ZIP 含重复或大小写冲突路径')
    names.add(key); expected.set(name, size)
    cursor += 46 + length + extra + comment
  }
  if (cursor !== offset + buffer.readUInt32LE(end + 12)) throw new Error('ZIP 目录大小不一致')
  const data = unzipSync(buffer)
  for (const [name, bytes] of Object.entries(data)) {
    if (bytes.length !== expected.get(name)) throw new Error('ZIP 文件大小校验失败')
    if (name.endsWith('/')) continue
    const full = inside(target, safeRelative(name))
    mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, bytes, { flag: 'wx' })
  }
}

export function zipSkill(root: string, name: string): Buffer {
  const files: Record<string, Uint8Array> = {}
  for (const file of skillFiles(root)) files[`${name}/${file.path}`] = readFileSync(inside(root, file.path))
  return Buffer.from(zipSync(files))
}

export function findSkillRoots(root: string): string[] {
  const results: string[] = []; let visited = 0
  function visit(dir: string, depth: number): void {
    if (++visited > 6000 || depth > 10) return
    if (existsSync(join(dir, 'SKILL.md'))) { results.push(dir); return }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !ignored.has(entry.name) && !entry.isSymbolicLink()) visit(join(dir, entry.name), depth + 1)
    }
  }
  visit(root, 0)
  if (results.length > 300) throw new Error('技能候选超过 300 个，请选择更具体的目录')
  return results
}

export function skillMetadata(root: string) {
  const parsed = manifest(readSkillText(root, 'SKILL.md'), basename(root))
  const files = skillFiles(root), warnings: string[] = []
  if (files.some(f => f.path.startsWith('scripts/'))) warnings.push('包含脚本；安装过程不会运行脚本，使用时需要目标工具提供执行能力。')
  if (parsed.description.length > 1024) warnings.push('description 超过 OpenCode 的 1024 字符限制。')
  if (existsSync(join(root, 'agents', 'openai.yaml'))) {
    try {
      const metadata = parse(yamlText(readSkillText(root, 'agents/openai.yaml')), { maxAliasCount: 0 })
      if (typeof metadata?.interface?.display_name === 'string') parsed.title = metadata.interface.display_name
      if (metadata?.dependencies) warnings.push('声明了工具依赖，安装文件不会自动安装 MCP 或其他外部工具。')
    } catch { warnings.push(OPENAI_YAML_WARNING) }
  }
  return { ...parsed, files, warnings }
}
