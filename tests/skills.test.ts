import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync } from 'fflate'
import { SkillsManager } from '../electron/services/skills.service'
import { MemorySkillsStore } from '../electron/services/skills-store'
import { extractSkillZip, manifest, safeRelative, skillHash, skillMetadata, OPENAI_YAML_WARNING } from '../electron/services/skills-files'
import { publicAddress } from '../electron/services/skills-source'
import { seedBundledSkills } from '../electron/services/skills-bundled'
import type { SkillTargetInfo } from '../src/types/skills'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'project-hub-skills-'))
  const home = join(root, 'home'), project = join(root, 'project'), library = join(root, 'library')
  mkdirSync(home); mkdirSync(project)
  const store = new MemorySkillsStore()
  const targets: SkillTargetInfo[] = [
    { id: 'codex', name: 'Codex', globalPath: join(home, 'codex'), projectFolder: '.agents/skills', hint: '' },
    { id: 'opencode', name: 'OpenCode', globalPath: join(home, 'opencode'), projectFolder: '.opencode/skills', hint: '' },
    { id: 'antigravity', name: 'Antigravity', globalPath: join(home, 'antigravity'), projectFolder: '.agents/skills', hint: '' },
    { id: 'hub', name: 'Hub', globalPath: library, projectFolder: '', hint: '' }
  ]
  const manager = new SkillsManager({ root: library, home, targets, store, bundledRoot: join(project, 'resources', 'bundled-skills'), project: id => id === 'demo' ? { path: project } : null })
  const source = join(root, 'sample-skill'); mkdirSync(join(source, 'references'), { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), '---\nname: sample-skill\ndescription: |\n  帮助发布应用\n  支持多个步骤\n---\n# 发布工具\n\n读取 references/guide.md。\n')
  writeFileSync(join(source, 'references/guide.md'), '# 发布指南\n第一版')
  async function imported() {
    const preview = await manager.preview({ kind: 'local', location: source })
    return (await manager.import(preview.token, preview.candidates.map(c => c.id)))[0]
  }
  function cleanup() {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(root.startsWith(join(tmpdir(), 'project-hub-skills-')))
    rmSync(root, { recursive: true, force: true })
  }
  return { root, home, source, library, project, manager, store, imported, cleanup }
}

test('bundled skills seed complete independent copies without overwriting or resurrecting user skills', async () => {
  const f = fixture()
  try {
    await seedBundledSkills(f.manager, f.source)
    const first = f.manager.snapshot().skills[0]
    assert.equal(f.manager.readFile(first.id, 'references/guide.md'), '# 发布指南\n第一版')
    assert.equal(f.manager.snapshot().installations.length, 0)
    writeFileSync(join(f.source, 'references/guide.md'), 'new bundled version')
    await seedBundledSkills(f.manager, f.source)
    assert.equal(f.manager.snapshot().skills.length, 1)
    assert.equal(f.manager.readFile(first.id, 'references/guide.md'), '# 发布指南\n第一版')
    await f.manager.remove(first.id)
    await seedBundledSkills(f.manager, f.source)
    assert.equal(f.manager.snapshot().skills.length, 0)
    assert.ok(existsSync(join(f.source, 'SKILL.md')))
  } finally { f.cleanup() }
})

test('bundled seed preserves existing user versions and accepts newly added skill names', async () => {
  const f = fixture()
  try {
    const first = await f.imported()
    writeFileSync(join(f.source, 'references/guide.md'), 'bundled version')
    await seedBundledSkills(f.manager, f.source)
    assert.equal(f.manager.snapshot().skills.length, 1)
    assert.equal(f.manager.readFile(first.id, 'references/guide.md'), '# 发布指南\n第一版')
    const extra = join(f.root, 'second-skill'); mkdirSync(extra)
    writeFileSync(join(extra, 'SKILL.md'), '---\nname: second-skill\ndescription: 第二个内置技能\n---\n# 第二个技能')
    await seedBundledSkills(f.manager, extra)
    assert.equal(f.manager.snapshot().skills.length, 2)
  } finally { f.cleanup() }
})

test('bundle button backend copies complete files, deduplicates and backs up explicit replacements', async () => {
  const f = fixture()
  try {
    const skill = await f.imported()
    const first = await f.manager.bundle(skill.id)
    assert.equal(first.status, 'copied')
    assert.equal(readFileSync(join(first.path, 'references/guide.md'), 'utf8'), '# 发布指南\n第一版')
    assert.equal((await f.manager.bundle(skill.id)).status, 'unchanged')
    writeFileSync(join(first.path, 'references/guide.md'), 'user version')
    assert.equal((await f.manager.bundle(skill.id)).status, 'conflict')
    assert.equal(readFileSync(join(first.path, 'references/guide.md'), 'utf8'), 'user version')
    assert.equal((await f.manager.bundle(skill.id, true)).status, 'copied')
    const backup = f.manager.history(skill.id).find(event => event.action === 'bundle-backup')!
    assert.ok(backup)
    assert.equal(readFileSync(join(backup.message.split('：')[1], 'references/guide.md'), 'utf8'), 'user version')
    const noProject = new SkillsManager({ root: f.library, store: f.store, project: () => null })
    await assert.rejects(noProject.bundle(skill.id), /开发环境/)
  } finally { f.cleanup() }
})

test('manifest handles multiline YAML and rejects malformed names / aliases', () => {
  const value = manifest('---\nname: demo\ndescription: >\n  Builds apps\n  and publishes them.\n---\n# Demo\n', 'demo')
  assert.equal(value.description, 'Builds apps and publishes them.')
  assert.throws(() => manifest('---\nname: ../outside\ndescription: bad\n---\n', 'x'))
  assert.throws(() => manifest('---\nname: demo\ndescription: &d text\nmetadata: *d\n---\n', 'demo'))
})

test('Windows YAML line endings parse without changing files; old cached warnings are refreshed', async () => {
  const f = fixture()
  try {
    mkdirSync(join(f.source, 'agents'))
    const yaml = 'interface:\r\r\n  display_name: "发布助手"\r\r\n  short_description: "发布技能"\r\r\n'
    writeFileSync(join(f.source, 'agents/openai.yaml'), yaml)
    const metadata = skillMetadata(f.source)
    assert.equal(metadata.title, '发布助手')
    assert.ok(!metadata.warnings.includes(OPENAI_YAML_WARNING))
    assert.equal(manifest('---\r\r\nname: demo\r\r\ndescription: Demo\r\r\n---\r\r\n# Demo Title', 'demo').title, 'Demo Title')
    const skill = await f.imported()
    f.store.savePackage({ ...skill, title: '旧名称', warnings: [OPENAI_YAML_WARNING, '保留其他提示'] })
    const refreshed = f.manager.snapshot().skills[0]
    assert.equal(refreshed.title, '发布助手')
    assert.deepEqual(refreshed.warnings, ['保留其他提示'])
    assert.equal(refreshed.hash, skill.hash)
    assert.equal(f.manager.readFile(skill.id, 'agents/openai.yaml'), yaml)
    assert.equal(refreshed.updatedAt, skill.updatedAt)
    writeFileSync(join(f.source, 'agents/openai.yaml'), 'interface: [invalid')
    assert.ok(skillMetadata(f.source).warnings.includes(OPENAI_YAML_WARNING))
  } finally { f.cleanup() }
})

test('imports complete packages, deduplicates content and preserves original files', async () => {
  const f = fixture()
  try {
    const skill = await f.imported()
    assert.equal(f.manager.readFile(skill.id, 'references/guide.md'), '# 发布指南\n第一版')
    assert.equal(skill.files.length, 2)
    const same = await f.imported()
    assert.equal(same.id, skill.id)
    assert.equal(f.manager.snapshot().skills.length, 1)
    assert.ok(existsSync(join(f.source, 'SKILL.md')))
    assert.throws(() => f.manager.readFile(skill.id, '../../source'), /路径/)
    assert.throws(() => f.manager.readFile('unknown', 'SKILL.md'), /不存在/)
  } finally { f.cleanup() }
})

test('installs to all four targets; Hub context respects project and enable state', async () => {
  const f = fixture()
  try {
    const skill = await f.imported()
    for (const target of ['codex', 'opencode', 'antigravity'] as const) {
      const install = await f.manager.install({ skillId: skill.id, target, scope: 'global' })
      assert.equal(readFileSync(join(install.path, 'references/guide.md'), 'utf8'), '# 发布指南\n第一版')
      assert.equal(skillHash(install.path), skill.hash)
    }
    const hub = await f.manager.install({ skillId: skill.id, target: 'hub', scope: 'project', projectId: 'demo' })
    assert.equal(f.manager.context().length, 0)
    assert.equal(f.manager.context('demo')[0].name, 'sample-skill')
    assert.throws(() => f.manager.context(undefined, [skill.id]), /未在/)
    await f.manager.setEnabled(hub.id, false)
    assert.equal(f.manager.context('demo').length, 0)
    await f.manager.setEnabled(hub.id, true)
    assert.equal(f.manager.context('demo').length, 1)
    await assert.rejects(f.manager.install({ skillId: skill.id, target: 'codex', scope: 'project', projectId: 'missing' }), /有效项目/)
    await assert.rejects(f.manager.remove(skill.id), /关联/)
  } finally { f.cleanup() }
})

test('disable and uninstall protect local edits; backups preserve installed content', async () => {
  const f = fixture()
  try {
    const skill = await f.imported(), installed = await f.manager.install({ skillId: skill.id, target: 'codex', scope: 'global' })
    await f.manager.setEnabled(installed.id, false)
    assert.equal(existsSync(installed.path), false)
    assert.equal(f.manager.snapshot().installations[0].status, 'disabled')
    await f.manager.setEnabled(installed.id, true)
    writeFileSync(join(installed.path, 'local-notes.md'), '用户自己的修改')
    await assert.rejects(f.manager.uninstall(installed.id), /本地修改/)
    await assert.rejects(f.manager.setEnabled(installed.id, false), /本地修改/)
    assert.equal(f.manager.snapshot().installations[0].status, 'modified')
    await f.manager.install({ skillId: skill.id, target: 'codex', scope: 'global', replace: true })
    assert.equal(existsSync(join(installed.path, 'local-notes.md')), false)
    const backup = f.manager.history(skill.id).find(h => h.message.startsWith('原目录备份：'))!.message.slice('原目录备份：'.length)
    assert.equal(readFileSync(join(backup, 'local-notes.md'), 'utf8'), '用户自己的修改')
    await f.manager.uninstall(installed.id)
    assert.equal(existsSync(installed.path), false)
    assert.equal(f.manager.snapshot().skills.length, 1)
  } finally { f.cleanup() }
})

test('shared project directory is preserved until the last association is removed', async () => {
  const f = fixture()
  try {
    const skill = await f.imported()
    const codex = await f.manager.install({ skillId: skill.id, target: 'codex', scope: 'project', projectId: 'demo' })
    const antigravity = await f.manager.install({ skillId: skill.id, target: 'antigravity', scope: 'project', projectId: 'demo', replace: true })
    assert.equal(codex.path, antigravity.path)
    await assert.rejects(f.manager.setEnabled(codex.id, false), /共享/)
    await f.manager.uninstall(codex.id)
    assert.ok(existsSync(antigravity.path))
    await f.manager.uninstall(antigravity.id)
    assert.equal(existsSync(codex.path), false)
  } finally { f.cleanup() }
})

test('scan associates external installs read-only and never deletes their files', async () => {
  const f = fixture()
  try {
    const installed = join(f.home, 'codex', 'sample-skill'); mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'SKILL.md'), readFileSync(join(f.source, 'SKILL.md')))
    const scan = await f.manager.scan()
    assert.equal(scan.candidates.length, 1)
    const [skill] = await f.manager.import(scan.token, scan.candidates.map(c => c.id))
    const association = f.manager.snapshot().installations[0]
    assert.equal(association.managed, false)
    await assert.rejects(f.manager.setEnabled(association.id, false), /外部/)
    await f.manager.uninstall(association.id)
    assert.ok(existsSync(join(installed, 'SKILL.md')))
    await f.manager.remove(skill.id)
    assert.equal(f.manager.snapshot().skills.length, 0)
  } finally { f.cleanup() }
})

test('updates show differences, preserve previous revision, invalidate analysis and leave external copies unchanged', async () => {
  const f = fixture()
  try {
    const skill = await f.imported()
    const codex = await f.manager.install({ skillId: skill.id, target: 'codex', scope: 'global' })
    await f.manager.install({ skillId: skill.id, target: 'hub', scope: 'global' })
    f.manager.saveAnalysis(skill.id, '旧版解读')
    writeFileSync(join(f.source, 'references/guide.md'), '# 发布指南\n第二版')
    const update = await f.manager.checkUpdate(skill.id)
    assert.ok(update.changed)
    assert.equal(update.changes[0].path, 'references/guide.md')
    const next = await f.manager.applyUpdate(skill.id, update.token, update.candidateId)
    assert.equal(next.analysis, undefined)
    assert.equal(f.manager.readFile(skill.id, 'references/guide.md'), '# 发布指南\n第二版')
    assert.equal(readFileSync(join(codex.path, 'references/guide.md'), 'utf8'), '# 发布指南\n第一版')
    assert.equal(f.manager.snapshot().installations.find(i => i.target === 'hub')!.hash, next.hash)
    await assert.rejects(f.manager.applyUpdate(skill.id, update.token, update.candidateId), /预览/)
    await f.manager.restore(skill.id)
    assert.equal(f.manager.readFile(skill.id, 'references/guide.md'), '# 发布指南\n第一版')
  } finally { f.cleanup() }
})

test('ZIP round-trip includes references and rejects traversal, symlinks and huge declared sizes', async () => {
  const f = fixture()
  try {
    const skill = await f.imported(), destination = join(f.root, 'exported')
    extractSkillZip(f.manager.export(skill.id), destination)
    assert.ok(existsSync(join(destination, 'sample-skill', 'references', 'guide.md')))
    const bad = Buffer.from(zipSync({ '../escape.txt': new Uint8Array([1]) }))
    assert.throws(() => extractSkillZip(bad, join(f.root, 'bad')), /文件路径/)
    const huge = Buffer.from(zipSync({ 'SKILL.md': new Uint8Array([1]) }))
    const header = huge.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); huge.writeUInt32LE(0xfffffffe, header + 24)
    assert.throws(() => extractSkillZip(huge, join(f.root, 'huge')), /大小/)
    const symlink = Buffer.from(zipSync({ 'link': new Uint8Array([1]) }))
    const central = symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); symlink.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38)
    assert.throws(() => extractSkillZip(symlink, join(f.root, 'link')), /符号链接/)
    for (const path of ['C:/escape', '/etc/passwd', '..\\escape', 'folder/CON.txt', 'file:stream']) assert.throws(() => safeRelative(path))
  } finally { f.cleanup() }
})

test('installation refuses symlink destinations instead of writing through them', async t => {
  const f = fixture()
  try {
    const skill = await f.imported(), outside = join(f.root, 'outside'); mkdirSync(outside)
    try { symlinkSync(outside, join(f.home, 'codex'), process.platform === 'win32' ? 'junction' : 'dir') } catch { t.skip('host does not permit directory links'); return }
    await assert.rejects(f.manager.install({ skillId: skill.id, target: 'codex', scope: 'global' }), /符号链接/)
    assert.equal(existsSync(join(outside, 'sample-skill')), false)
  } finally { f.cleanup() }
})

test('download address policy excludes localhost, private and mapped IPv6 addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.1.2', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1']) assert.equal(publicAddress(ip), false, ip)
  assert.ok(publicAddress('8.8.8.8'))
  assert.ok(publicAddress('2606:4700:4700::1111'))
})
