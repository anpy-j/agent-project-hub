<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import MarkdownIt from 'markdown-it'
import PageHeader from '../components/PageHeader.vue'
import SkillsAssistant from './SkillsAssistant.vue'
import type { Project } from '../types'
import type { SkillHistory, SkillInstallation, SkillPackage, SkillPreview, SkillScope, SkillSnapshot, SkillTarget, SkillUpdate } from '../types/skills'

const router = useRouter(), route = useRoute()
const md = new MarkdownIt({ html: false, linkify: false, breaks: true })
const data = ref<SkillSnapshot>({ skills: [], installations: [], targets: [] })
const projects = ref<Project[]>([])
const loading = ref(false), busy = ref(false), error = ref('')
const selectedId = ref(''), search = ref(''), targetFilter = ref(''), sourceFilter = ref(''), stateFilter = ref('all')
const tab = ref('overview'), filePath = ref('SKILL.md'), fileText = ref(''), fileLoading = ref(false), raw = ref(false)
const history = ref<SkillHistory[]>([])
const installations = computed(() => data.value.installations.filter(i => i.skillId === selectedId.value))
const targetName = (id: SkillTarget) => data.value.targets.find(t => t.id === id)?.name || id
const sourceName = (kind: string) => ({ local: '本地导入', github: 'GitHub', url: '下载链接', discovered: '本机发现' })[kind] || kind
const statusName = (i: SkillInstallation) => ({ installed: '已安装，目标需刷新', disabled: '已停用', modified: '有本地修改', missing: '文件缺失' })[i.status || 'installed']
const projectName = (id?: string) => projects.value.find(p => p.id === id)?.display_name || projects.value.find(p => p.id === id)?.name || '项目已移除'
const visibleSkills = computed(() => data.value.skills.filter(s => {
  const installs = data.value.installations.filter(i => i.skillId === s.id)
  return (!search.value || `${s.title} ${s.name} ${s.description}`.toLowerCase().includes(search.value.toLowerCase()))
    && (!sourceFilter.value || s.source.kind === sourceFilter.value)
    && (!targetFilter.value || installs.some(i => i.target === targetFilter.value))
    && (stateFilter.value === 'all' || stateFilter.value === 'installed' && installs.length > 0 || stateFilter.value === 'uninstalled' && !installs.length || stateFilter.value === 'modified' && installs.some(i => i.status === 'modified' || i.status === 'missing' || i.hash !== s.hash))
}))
const selected = computed(() => visibleSkills.value.find(s => s.id === selectedId.value))
watch(visibleSkills, skills => {
  if (!skills.some(skill => skill.id === selectedId.value)) selectedId.value = skills[0]?.id || ''
}, { immediate: true })
const html = computed(() => md.render(fileText.value))
function size(bytes: number) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB` }
function message(e: unknown) { return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e) }
async function refresh() {
  if (!window.api.skills) { error.value = '当前进程尚未加载 Skills 接口，请重新启动应用。'; return }
  loading.value = true
  try {
    data.value = await window.api.skills.snapshot(); error.value = ''
  } catch (e) { error.value = message(e) } finally { loading.value = false }
}
async function operation(fn: () => Promise<unknown>, success: string) {
  busy.value = true
  try { await fn(); await refresh(); await loadHistory(); ElMessage.success(success) } catch (e) { ElMessage.error(message(e)) } finally { busy.value = false }
}
async function loadFile() {
  const id = selectedId.value, path = filePath.value
  if (!id) { fileText.value = ''; fileLoading.value = false; return }
  fileLoading.value = true; fileText.value = ''
  try { const text = await window.api.skills.readFile(id, path); if (id === selectedId.value && path === filePath.value) fileText.value = text }
  catch (e) { if (id === selectedId.value && path === filePath.value) fileText.value = message(e) }
  finally { if (id === selectedId.value && path === filePath.value) fileLoading.value = false }
}
async function loadHistory() {
  if (!selectedId.value) { history.value = []; return }
  const id = selectedId.value
  try { const value = await window.api.skills.history(id); if (selectedId.value === id) history.value = value } catch (e) { ElMessage.error(message(e)) }
}
watch(selectedId, () => { filePath.value = 'SKILL.md'; void loadFile(); void loadHistory() })
watch(filePath, loadFile)
function externalLink(e: MouseEvent) {
  const link = (e.target as HTMLElement).closest('a')
  if (!link) return
  e.preventDefault()
  const href = link.getAttribute('href') || ''
  if (/^https?:\/\//i.test(href)) void window.api.system.openExternal(href)
  else {
    const parts = `${filePath.value.split('/').slice(0, -1).join('/')}/${href.split('#')[0]}`.split('/')
    const normalized: string[] = []
    for (const p of parts) { if (p === '..') normalized.pop(); else if (p && p !== '.') normalized.push(p) }
    if (selected.value?.files.some(f => f.path === normalized.join('/'))) { filePath.value = normalized.join('/'); tab.value = 'content' }
    else ElMessage.info('该引用不在技能包内，请查看来源页面。')
  }
}

const importVisible = ref(false), importKind = ref<'github' | 'url' | 'local' | 'scan'>('github'), location = ref(''), refName = ref('')
const chineseDescriptions = ref<Record<string, string>>({}), translating = ref(false), translationNotice = ref('')
const preview = ref<SkillPreview | null>(null), candidates = ref<string[]>([]), parsing = ref(false)
const importTargets = ref<SkillTarget[]>([]), importScope = ref<SkillScope>('global'), importProject = ref(''), replaceExisting = ref(false)
async function describeCandidates() {
  const current = preview.value
  if (!current) return
  translating.value = true; translationNotice.value = ''
  try {
    const result = await window.api.skills.describeCandidates(current.candidates.map(({ id, name, description }) => ({ id, name, description })))
    if (preview.value?.token !== current.token) return
    chineseDescriptions.value = result.descriptions
    translationNotice.value = result.notice
  } catch (e) { if (preview.value?.token === current.token) translationNotice.value = `中文说明生成失败：${message(e)}` }
  finally { if (preview.value?.token === current.token) translating.value = false }
}
function openImport(kind: typeof importKind.value = 'github') { importKind.value = kind; importVisible.value = true }
async function clearPreview() { if (preview.value) await window.api.skills.discard(preview.value.token); preview.value = null; candidates.value = []; chineseDescriptions.value = {}; translationNotice.value = ''; translating.value = false }
async function pickLocal(kind: 'file' | 'folder') {
  try { const path = await window.api.skills.pickLocal(kind); if (path) { location.value = path; await clearPreview() } } catch (e) { ElMessage.error(message(e)) }
}
async function parseImport() {
  parsing.value = true
  try {
    await clearPreview()
    preview.value = importKind.value === 'scan' ? await window.api.skills.scan(importProject.value || undefined) : await window.api.skills.preview({ kind: importKind.value, location: location.value.trim(), ref: refName.value.trim() || undefined })
    candidates.value = preview.value.candidates.map(c => c.id)
    void describeCandidates()
    if (!candidates.value.length) ElMessage.info('未发现技能，可导入本地目录或 GitHub 技能包。')
  } catch (e) { ElMessage.error(message(e)) } finally { parsing.value = false }
}
async function finishImport() {
  if (!preview.value || !candidates.value.length) return
  if (importTargets.value.length && importScope.value === 'project' && !importProject.value) { ElMessage.warning('请选择目标项目'); return }
  busy.value = true
  const failures: string[] = []; let installed = 0
  try {
    const skills = await window.api.skills.import(preview.value.token, [...candidates.value]); preview.value = null
    for (const skill of skills) for (const target of importTargets.value) {
      try { await window.api.skills.install({ skillId: skill.id, target, scope: importScope.value, projectId: importScope.value === 'project' ? importProject.value : undefined, replace: replaceExisting.value }); installed++ }
      catch (e) { failures.push(`${skill.name} → ${targetName(target)}：${message(e)}`) }
    }
    importVisible.value = false; await refresh(); selectedId.value = skills[0]?.id || selectedId.value
    ElMessage.success(`已导入 ${skills.length} 个技能${installed ? `，完成 ${installed} 项安装` : ''}`)
    if (failures.length) await ElMessageBox.alert(failures.join('\n'), '技能已导入，部分安装未完成', { confirmButtonText: '查看安装位置', customClass: 'skills-result-dialog' })
  } catch (e) { ElMessage.error(message(e)) } finally { busy.value = false }
}
watch(importKind, () => { void clearPreview() })
watch([location, refName], () => { void clearPreview() })
watch(importVisible, value => { if (!value) void clearPreview() })

const installVisible = ref(false), installTarget = ref<SkillTarget>('codex'), installScope = ref<SkillScope>('global'), installProject = ref(''), installReplace = ref(false)
const plannedPath = computed(() => {
  if (!selected.value) return ''
  if (installTarget.value === 'hub') return '应用技能库关联，无需重复复制文件'
  const target = data.value.targets.find(t => t.id === installTarget.value)
  const root = installScope.value === 'global' ? target?.globalPath : `${projects.value.find(p => p.id === installProject.value)?.path || '请选择项目'}/${target?.projectFolder}`
  return `${root}/${selected.value.name}`
})
function openInstall(target: SkillTarget) { installTarget.value = target; installReplace.value = false; installVisible.value = true }
async function install() {
  if (!selected.value) return
  busy.value = true
  try {
    await window.api.skills.install({ skillId: selected.value.id, target: installTarget.value, scope: installScope.value, projectId: installScope.value === 'project' ? installProject.value : undefined, replace: installReplace.value })
    installVisible.value = false; await refresh(); await loadHistory(); ElMessage.success(installTarget.value === 'hub' ? '已启用，可在技能助手中选择使用' : '安装完成，目标工具可能需要刷新或重新打开会话')
  } catch (e) { ElMessage.error(message(e)) } finally { busy.value = false }
}
async function uninstall(item: SkillInstallation) {
  try {
    await ElMessageBox.confirm(item.managed ? '移除此安装；技能库仍保留，独占目录会在备份后移除，共享目录仍保留。' : '仅移除外部安装的关联，保留原目录全部文件。', item.managed ? '卸载技能' : '移除关联', { type: 'warning' })
    await operation(() => window.api.skills.uninstall(item.id), '已移除安装关联')
  } catch { /* 用户取消 */ }
}
async function remove() {
  if (!selected.value) return
  try { await ElMessageBox.confirm('删除技能库内的完整文件；有安装关联时需要先移除关联。', '删除库条目', { type: 'warning' }); await operation(() => window.api.skills.remove(selectedId.value), '已删除库条目') } catch { /* 用户取消 */ }
}
async function toggle(item: SkillInstallation) { await operation(() => window.api.skills.setEnabled(item.id, !item.enabled), item.enabled ? '已停用' : '已启用') }
async function restore() { await operation(() => window.api.skills.restore(selectedId.value), '已恢复上一版本'); await loadFile() }
async function explain() {
  if (!selected.value) return
  try {
    const cfg = await window.api.ai.getConfig()
    if (!cfg.model) { ElMessage.info('请先在全局设置 → AI 服务中配置模型'); router.push({ path: '/settings', query: { section: 'ai' } }); return }
    await ElMessageBox.confirm(`将当前 SKILL.md 发送到已配置的 ${cfg.provider} / ${cfg.model} 进行用途解读，不附带其他文件。`, 'AI 解读用途', { confirmButtonText: '开始解读' })
    await operation(() => window.api.skills.explain(selectedId.value), '用途解读完成')
  } catch { /* 用户取消 */ }
}
async function exportSkill() { if (selected.value) await operation(async () => { const path = await window.api.skills.export(selectedId.value); if (path) ElMessage.info(path) }, '导出操作完成') }
async function bundleSkill() {
  const id = selectedId.value
  if (!id) return
  busy.value = true
  try {
    let result = await window.api.skills.bundle(id)
    if (result.status === 'conflict') {
      try {
        await ElMessageBox.confirm(`随包分发目录已有不同内容：\n${result.path}\n将备份原目录，再用当前技能库版本替换。`, '替换随包分发技能', { confirmButtonText: '备份并替换', cancelButtonText: '取消', type: 'warning' })
      } catch { return }
      result = await window.api.skills.bundle(id, true)
    }
    ElMessage.success({ message: `${result.status === 'unchanged' ? '已存在相同版本' : '已加入随包分发'}：${result.path}`, duration: 6000 })
    await loadHistory()
  } catch (e) { ElMessage.error(message(e)) } finally { busy.value = false }
}
const update = ref<SkillUpdate | null>(null), updateVisible = ref(false)
async function checkUpdate() {
  if (!selected.value) return
  busy.value = true
  try {
    if (update.value) await window.api.skills.discard(update.value.token)
    update.value = await window.api.skills.checkUpdate(selectedId.value)
    if (update.value.changed) updateVisible.value = true
    else { await window.api.skills.discard(update.value.token); update.value = null; ElMessage.success('技能内容没有变化') }
  } catch (e) { ElMessage.error(message(e)) } finally { busy.value = false }
}
async function applyUpdate() {
  if (!update.value) return
  const current = update.value
  await operation(async () => { await window.api.skills.applyUpdate(selectedId.value, current.token, current.candidateId); updateVisible.value = false; update.value = null; await loadFile() }, '技能库已更新，请按需更新目标安装副本')
}
watch(updateVisible, value => { if (!value && update.value) { void window.api.skills.discard(update.value.token); update.value = null } })
onMounted(async () => { await refresh(); try { projects.value = await window.api.project.list() } catch (e) { ElMessage.error(message(e)) } })
onBeforeUnmount(() => { if (preview.value) void window.api.skills.discard(preview.value.token); if (update.value) void window.api.skills.discard(update.value.token) })
</script>

<template>
  <div class="page skills-page" v-loading="loading">
    <PageHeader title="Skills 管理">
      <template #actions>
      <el-button size="small" :disabled="busy" @click="openImport('scan')"><el-icon><Search /></el-icon>扫描本机</el-button>
      <el-tooltip content="刷新技能库"><el-button size="small" :disabled="busy" aria-label="刷新技能库" @click="refresh"><el-icon><Refresh /></el-icon></el-button></el-tooltip>
      <el-button size="small" type="primary" :disabled="busy" @click="openImport()"><el-icon><Plus /></el-icon>导入技能</el-button>
      </template>
    </PageHeader>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <div class="skills-toolbar">
      <el-radio-group v-model="stateFilter" size="small" class="state-tabs" aria-label="技能状态"><el-radio-button value="all">全部 {{ data.skills.length }}</el-radio-button><el-radio-button value="installed">已安装</el-radio-button><el-radio-button value="uninstalled">未安装</el-radio-button><el-radio-button value="modified">需处理</el-radio-button></el-radio-group>
      <div class="skills-filters">
        <el-input v-model="search" size="small" placeholder="搜索技能…" clearable aria-label="搜索技能"><template #prefix><el-icon><Search /></el-icon></template></el-input>
        <el-select v-model="targetFilter" size="small" placeholder="全部目标" clearable aria-label="筛选目标"><el-option v-for="t in data.targets" :key="t.id" :label="t.name" :value="t.id" /></el-select>
        <el-select v-model="sourceFilter" size="small" placeholder="全部来源" clearable aria-label="筛选来源"><el-option v-for="s in ['local','github','url','discovered']" :key="s" :label="sourceName(s)" :value="s" /></el-select>
      </div>
    </div>
    <div class="skills-layout">
      <section class="skills-list" aria-label="技能列表">
        <el-empty v-if="!visibleSkills.length" :description="data.skills.length ? '没有匹配的技能' : '导入技能包，或扫描本机已有技能'" :image-size="72"><el-button v-if="!data.skills.length" @click="openImport('local')">导入我的技能</el-button></el-empty>
        <button v-for="skill in visibleSkills" :key="skill.id" type="button" class="skill-row" :class="{ selected: selectedId === skill.id }" :aria-pressed="selectedId === skill.id" @click="selectedId = skill.id">
          <strong :title="skill.title">{{ skill.title }}</strong><span class="skill-slug" :title="skill.name">{{ skill.name }}</span>
        </button>
      </section>
      <section v-if="selected" class="skill-detail" aria-label="技能详情">
        <div class="detail-title"><div><div class="title-with-action"><h2>{{ selected.title }}</h2><el-tooltip :content="data.bundledPath ? `复制完整技能到 ${data.bundledPath}` : '开发环境可直接加入项目；安装版请导出 ZIP 后加入源码项目'"><span><el-button size="small" :disabled="busy || !data.bundledPath" @click="bundleSkill">加入随包分发</el-button></span></el-tooltip></div><span class="skill-slug">{{ selected.name }}</span></div><el-dropdown @command="(c: string) => c === 'export' ? exportSkill() : remove()"><el-button :disabled="busy">更多操作<el-icon><ArrowDown /></el-icon></el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="export">导出完整 ZIP</el-dropdown-item><el-dropdown-item command="remove">删除库条目</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div>
        <el-tabs v-model="tab">
          <el-tab-pane label="概览" name="overview">
            <h3>用途说明</h3><p class="description">{{ selected.description }}</p>
            <el-alert title="库中技能可直接查看和解读。可在下方直接使用当前技能提问；Project Hub AI 启用仅建立关联，不重复复制；随包分发目录用于打包，外部 AI 工具需安装到其识别的目录。" type="info" :closable="false" />
            <dl class="skill-meta"><dt>来源</dt><dd>{{ selected.source.location }}</dd><dt>版本</dt><dd>{{ selected.source.commit?.slice(0,12) || selected.hash.slice(0,12) }}<span v-if="selected.source.ref"> · {{ selected.source.ref }}</span></dd><dt>文件</dt><dd>{{ selected.files.length }} 个文件 · {{ size(selected.files.reduce((n,f) => n + f.bytes, 0)) }}</dd><dt>最近导入</dt><dd>{{ new Date(selected.updatedAt).toLocaleString() }}</dd></dl>
            <el-alert v-for="warning in selected.warnings" :key="warning" :title="warning" type="warning" :closable="false" class="skill-warning" />
            <div class="section-head"><h3>AI 解读</h3><el-button size="small" :loading="busy" @click="explain">{{ selected.analysis ? '查看 / 使用缓存' : '解读用途' }}</el-button></div>
            <div v-if="selected.analysis" class="markdown-content" v-html="md.render(selected.analysis)" @click="externalLink" />
            <p v-else class="secondary">可用已配置模型解释场景、调用方法与依赖。未配置模型也可正常安装和查看。</p>
            <SkillsAssistant :key="`${selected.id}:${selected.hash}`" :skill-id="selected.id" :skill-name="selected.title" :initial-project-id="typeof route.query.projectId === 'string' ? route.query.projectId : ''" />
          </el-tab-pane>
          <el-tab-pane label="内容" name="content">
            <div class="file-controls"><el-select v-model="filePath" filterable aria-label="技能文件"><el-option v-for="f in selected.files" :key="f.path" :label="`${f.path} · ${size(f.bytes)}`" :value="f.path" /></el-select><el-switch v-model="raw" active-text="原文" inactive-text="预览" /></div>
            <div v-loading="fileLoading" class="file-view"><pre v-if="raw || !/\.md$/i.test(filePath)" class="skill-code">{{ fileText }}</pre><div v-else class="markdown-content" v-html="html" @click="externalLink" /></div>
          </el-tab-pane>
          <el-tab-pane label="安装位置" name="targets">
            <el-alert title="各目标独立安装。Codex 与 Antigravity 的项目目录可能共享；文件复制完成后，目标工具可能需要刷新会话。" type="info" :closable="false" />
            <div v-for="target in data.targets" :key="target.id" class="target-block"><div class="section-head"><h3>{{ target.name }}</h3><el-button size="small" :disabled="busy" @click="openInstall(target.id)">{{ target.id === 'hub' ? '启用到助手' : '安装 / 更新副本' }}</el-button></div><p class="secondary">{{ target.hint }}</p>
              <div v-for="item in installations.filter(i => i.target === target.id)" :key="item.id" class="installation"><div><div class="installation-title"><el-tag size="small" :type="item.status === 'modified' || item.status === 'missing' ? 'warning' : 'info'">{{ item.target === 'hub' && item.enabled ? '已启用说明加载' : statusName(item) }}</el-tag><span>{{ item.scope === 'global' ? '全局' : projectName(item.projectId) }}</span><el-tag v-if="!item.managed" size="small" type="info">外部安装 · 只读</el-tag><el-tag v-if="item.hash !== selected.hash" size="small" type="warning">副本版本较旧</el-tag></div><p class="install-path">{{ item.path }}</p></div><div class="installation-actions"><el-button v-if="item.managed" size="small" :disabled="busy" @click="toggle(item)">{{ item.enabled ? '停用' : '启用' }}</el-button><el-button size="small" :disabled="busy" @click="uninstall(item)">{{ item.managed ? '卸载' : '移除关联' }}</el-button></div></div>
              <p v-if="!installations.some(i => i.target === target.id)" class="secondary small">{{ target.id === 'hub' ? '尚未启用到助手；启用只关联技能库，无需复制文件' : '尚未安装到此目标' }}</p>
            </div>
          </el-tab-pane>
          <el-tab-pane label="更新与历史" name="history"><div class="section-head"><h3>版本管理</h3><div><el-button size="small" :loading="busy" @click="checkUpdate">检查来源更新</el-button><el-button size="small" :disabled="busy" @click="restore">恢复上一版本</el-button></div></div><p class="secondary">更新技能库前查看差异并保留上一版本。外部安装副本由你选择重新部署，不会静默覆盖。</p><el-empty v-if="!history.length" description="暂无操作记录" :image-size="56" /><div v-for="entry in history" :key="entry.id" class="history-row"><span>{{ new Date(entry.createdAt).toLocaleString() }}</span><p>{{ entry.message }}</p></div></el-tab-pane>
        </el-tabs>
      </section>
      <el-empty v-else :description="visibleSkills.length ? '选择一个技能查看完整内容和安装位置' : '当前筛选没有技能，请调整筛选条件'" :image-size="90" />
    </div>

    <el-dialog v-model="importVisible" title="导入技能" width="720px" :close-on-click-modal="false" :before-close="(done: () => void) => { if (!busy && !parsing) done() }">
      <el-radio-group v-model="importKind" :disabled="busy || parsing" class="import-sources"><el-radio-button value="github">GitHub</el-radio-button><el-radio-button value="url">下载链接</el-radio-button><el-radio-button value="local">本地文件</el-radio-button><el-radio-button value="scan">已有技能</el-radio-button></el-radio-group>
      <el-form label-position="top">
        <el-form-item v-if="importKind !== 'scan'" :label="importKind === 'local' ? '技能目录、ZIP 或 SKILL.md' : '来源链接'"><el-input v-model="location" :disabled="parsing || busy" :placeholder="importKind === 'github' ? 'https://github.com/owner/repo/tree/main/skills' : importKind === 'url' ? 'https://example.com/skill.zip' : '选择本地路径'" /><div v-if="importKind === 'local'" class="local-actions"><el-button size="small" :disabled="busy || parsing" @click="pickLocal('folder')">选择文件夹</el-button><el-button size="small" :disabled="busy || parsing" @click="pickLocal('file')">选择 ZIP / SKILL.md</el-button></div></el-form-item>
        <el-form-item v-if="importKind === 'github'" label="版本 / ref（可选）"><el-input v-model="refName" :disabled="parsing || busy" placeholder="分支、标签或提交号；不填则从链接识别" /></el-form-item>
        <el-form-item v-if="importKind === 'scan'" label="额外扫描项目（可选）"><el-select v-model="importProject" clearable filterable placeholder="默认扫描工具全局目录"><el-option v-for="p in projects" :key="p.id" :label="p.display_name || p.name" :value="p.id" /></el-select></el-form-item>
      </el-form>
      <el-button :loading="parsing" :disabled="busy || importKind !== 'scan' && !location.trim()" @click="parseImport">{{ importKind === 'scan' ? '扫描并识别' : '解析并预览' }}</el-button>
      <div v-if="preview" class="import-preview"><div class="section-head"><h3>识别到 {{ preview.candidates.length }} 个技能</h3><el-button size="small" @click="candidates = candidates.length === preview!.candidates.length ? [] : preview!.candidates.map(c => c.id)">{{ candidates.length === preview.candidates.length ? '取消全选' : '全选' }}</el-button></div><p v-if="translating" class="secondary small">正在生成中文用途说明，你可以继续选择技能。</p><div v-if="translationNotice" class="translation-notice"><span>{{ translationNotice }}</span><el-button size="small" :loading="translating" @click="describeCandidates">重试中文说明</el-button></div><el-checkbox-group v-model="candidates"><div v-for="candidate in preview.candidates" :key="candidate.id" class="candidate"><el-checkbox :value="candidate.id">{{ candidate.title }} <span class="secondary">{{ candidate.name }}{{ candidate.existingId ? ' · 库中已有相同内容' : '' }}</span></el-checkbox><p class="candidate-description">{{ chineseDescriptions[candidate.id] || (/[\u3400-\u9fff]/.test(candidate.description) ? candidate.description : translating ? '正在生成中文用途说明…' : '暂无中文说明，请展开原文查看用途。') }}</p><div class="candidate-location"><span>位置</span><code>{{ candidate.discovered?.path || candidate.source.location }}</code></div><details v-if="!/[\u3400-\u9fff]/.test(candidate.description)" class="candidate-original"><summary>查看英文原文</summary><p>{{ candidate.description }}</p></details><small>{{ candidate.files.length }} 个文件{{ candidate.discovered ? ' · 外部安装，纳入后只读关联' : '' }}</small><p v-for="w in candidate.warnings" :key="w" class="secondary small">{{ w }}</p></div></el-checkbox-group><el-alert v-if="preview.errors.length" :title="`${preview.errors.length} 项未能识别`" type="warning" :closable="false"><template #default><p v-for="e in preview.errors" :key="e" class="secondary small">{{ e }}</p></template></el-alert></div>
      <div v-if="preview?.candidates.length" class="import-install"><h3>同时安装到（不选则仅加入技能库）</h3><el-checkbox-group v-model="importTargets"><el-checkbox v-for="t in data.targets" :key="t.id" :value="t.id">{{ t.name }}</el-checkbox></el-checkbox-group><div v-if="importTargets.length" class="scope-controls"><el-radio-group v-model="importScope"><el-radio value="global">全局</el-radio><el-radio value="project">指定项目</el-radio></el-radio-group><el-select v-if="importScope === 'project'" v-model="importProject" placeholder="选择项目"><el-option v-for="p in projects" :key="p.id" :label="p.display_name || p.name" :value="p.id" /></el-select><el-checkbox v-model="replaceExisting">备份后替换已有目录</el-checkbox></div></div>
      <template #footer><el-button :disabled="busy || parsing" @click="importVisible = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="!candidates.length || parsing" @click="finishImport">{{ importTargets.length ? '导入并安装' : '加入技能库' }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="installVisible" :title="installTarget === 'hub' ? '启用技能' : '安装技能'" width="580px" :close-on-click-modal="false"><el-form label-position="top"><el-form-item label="目标工具"><el-select v-model="installTarget"><el-option v-for="t in data.targets" :key="t.id" :label="t.name" :value="t.id" /></el-select></el-form-item><el-form-item label="使用范围"><el-radio-group v-model="installScope"><el-radio value="global">全局</el-radio><el-radio value="project">指定项目</el-radio></el-radio-group></el-form-item><el-form-item v-if="installScope === 'project'" label="目标项目"><el-select v-model="installProject" filterable><el-option v-for="p in projects" :key="p.id" :label="p.display_name || p.name" :value="p.id" /></el-select></el-form-item><el-form-item :label="installTarget === 'hub' ? '使用方式' : '实际安装位置'"><div class="skill-code install-preview">{{ plannedPath }}</div></el-form-item><el-checkbox v-if="installTarget !== 'hub'" v-model="installReplace">备份后替换已有目录（更新副本时也需勾选）</el-checkbox></el-form><template #footer><el-button :disabled="busy" @click="installVisible = false">取消</el-button><el-button type="primary" :loading="busy" @click="install">{{ installTarget === 'hub' ? '确认启用' : '确认安装' }}</el-button></template></el-dialog>
    <el-dialog v-model="updateVisible" title="来源更新差异" width="85%" :close-on-click-modal="false"><el-alert title="更新技能库会备份上一版本；目标工具的安装副本不会自动覆盖。" type="info" :closable="false" /><div v-for="change in update?.changes" :key="change.path" class="update-change"><h3>{{ change.path }} · {{ { added: '新增', removed: '删除', changed: '修改' }[change.kind] }}</h3><div class="diff-columns"><div><h4>当前版本</h4><pre class="skill-code">{{ change.before || '（无）' }}</pre></div><div><h4>来源版本</h4><pre class="skill-code">{{ change.after || '（无）' }}</pre></div></div></div><template #footer><el-button :disabled="busy" @click="updateVisible = false">取消</el-button><el-button type="primary" :loading="busy" @click="applyUpdate">备份并更新技能库</el-button></template></el-dialog>
  </div>
</template>

<style scoped>
.title-with-action{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.skills-page,.skills-layout>.skill-detail{box-sizing:border-box}
.skills-page>.skills-toolbar,.skills-page>.el-alert{flex-shrink:0}
.skills-page>.skills-layout{flex:1;min-height:0;align-items:stretch;overflow:hidden;padding-bottom:2px}
.skills-layout>.skills-list,.skills-layout>.skill-detail{min-height:0;max-height:100%;overflow-y:auto;overscroll-behavior:contain}
.skills-layout>.skill-detail{scrollbar-gutter:stable}
.skills-page{min-height:0;padding-bottom:16px}
.skills-page :deep(.page-head){align-items:center;gap:12px;margin-bottom:10px;padding-bottom:10px}
.skills-page :deep(.page-title){font-size:20px}
.skills-page :deep(.head-actions){gap:6px}
.skills-page :deep(.head-actions .el-button + .el-button){margin-left:0}
.skills-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px}
.state-tabs{flex-shrink:0}
.skills-filters{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0;flex:1}
.skills-filters>.el-input{width:clamp(160px,20vw,280px);min-width:140px}
.skills-filters>.el-select{width:120px;flex-shrink:0}
.skills-layout{display:grid;grid-template-columns:minmax(240px,.8fr) minmax(0,1.5fr);gap:14px;align-items:start}
.skills-list{display:flex;flex-direction:column;gap:4px;min-width:0}
.skill-row{box-sizing:border-box;flex-shrink:0;height:54px;padding:7px 12px;text-align:left;background:var(--ph-panel);border:1px solid var(--ph-line);border-radius:6px;font:inherit;color:var(--el-text-color-primary);cursor:pointer;min-width:0}
.skill-row:hover,.skill-row.selected{border-color:var(--el-color-primary)}
.skill-row.selected{background:var(--el-color-primary-light-9)}
.skill-row:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:1px}
.skill-row strong{font-size:13px;line-height:19px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.skill-slug{display:block;margin-top:6px;color:var(--el-text-color-secondary);font:11px var(--ph-font-mono);overflow-wrap:anywhere}
.skill-row .skill-slug{margin-top:2px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.skill-detail{background:var(--ph-panel);border:1px solid var(--ph-line);border-radius:var(--ph-radius-md);padding:20px;min-width:0}.detail-title{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;margin-bottom:18px}.detail-title h2{font-size:18px;margin:0;overflow-wrap:anywhere}.description{line-height:1.9;font-size:13px;white-space:pre-wrap}.skill-meta{display:grid;grid-template-columns:68px minmax(0,1fr);gap:12px;font-size:12px;margin:22px 0}.skill-meta dt,.secondary{color:var(--el-text-color-secondary)}.skill-meta dd{margin:0;overflow-wrap:anywhere;line-height:1.6}.small{font-size:12px}.skill-warning{margin:10px 0}.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}h3{font-size:13px;margin:18px 0 10px}.section-head h3{margin:18px 0}.secondary{line-height:1.7}.file-controls{display:flex;gap:14px;align-items:center;margin:10px 0 18px;flex-wrap:wrap}.file-controls .el-select{flex:1;min-width:160px}.file-view{min-height:180px}.skill-code{font:12px/1.8 var(--ph-font-mono);background:var(--ph-field);border-radius:8px;padding:14px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:560px;overflow:auto;margin:0}.install-preview{width:100%}.target-block{border-bottom:1px solid var(--ph-line);padding:6px 0 16px}.target-block:last-child{border:0}.installation{border:1px solid var(--ph-line);padding:12px;border-radius:8px;margin-top:10px}.installation-title,.installation-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:12px}.install-path{font:11px/1.6 var(--ph-font-mono);color:var(--el-text-color-secondary);overflow-wrap:anywhere}.installation-actions{justify-content:flex-end;margin-top:10px}.history-row{border-bottom:1px solid var(--ph-line);padding:12px 0}.history-row span{font-size:11px;color:var(--el-text-color-secondary)}.history-row p{font-size:12px;line-height:1.7;overflow-wrap:anywhere}.import-sources{margin-bottom:20px}.local-actions{display:flex;gap:8px;margin-top:10px}.import-preview{margin-top:20px}.candidate{border-bottom:1px solid var(--ph-line);padding:12px 0}.candidate p{margin:5px 0;line-height:1.7;font-size:12px}.candidate-description{color:var(--el-text-color-primary)}.candidate-location{display:flex;align-items:baseline;gap:8px;margin:8px 0;font-size:12px;color:var(--el-text-color-secondary)}.candidate-location>span{flex-shrink:0}.candidate-location code{font:11px/1.6 var(--ph-font-mono);overflow-wrap:anywhere;user-select:text}.candidate-original{margin:8px 0;font-size:12px;color:var(--el-text-color-secondary)}.candidate-original summary{cursor:pointer;width:fit-content}.translation-notice{display:flex;align-items:center;gap:10px;margin:10px 0;font-size:12px;color:var(--el-text-color-secondary)}.candidate small{color:var(--el-text-color-secondary)}.candidate :deep(.el-checkbox){max-width:100%;height:auto;align-items:flex-start}.candidate :deep(.el-checkbox__label){white-space:normal;overflow-wrap:anywhere;line-height:1.7}.import-install{border-top:1px solid var(--ph-line);margin-top:20px}.scope-controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:16px}.scope-controls .el-select{width:220px}.diff-columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}.diff-columns>div{min-width:0}.update-change{margin-top:18px}.markdown-content{font-size:13px;line-height:1.9;overflow-wrap:anywhere}.markdown-content :deep(h1){font-size:20px}.markdown-content :deep(h2){font-size:17px}.markdown-content :deep(h3){font-size:14px}.markdown-content :deep(pre){white-space:pre-wrap;overflow-wrap:anywhere;background:var(--ph-field);padding:12px;border-radius:8px;font-size:12px}.markdown-content :deep(code){font-family:var(--ph-font-mono)}.markdown-content :deep(a){color:var(--el-color-primary)}.markdown-content :deep(img){display:none}.markdown-content :deep(table){display:block;overflow:auto;max-width:100%}.markdown-content :deep(th),.markdown-content :deep(td){border-bottom:1px solid var(--ph-line);padding:6px 10px}.markdown-content :deep(blockquote){border-left:3px solid var(--ph-line);padding-left:14px;color:var(--el-text-color-secondary)}
@media(max-width:1100px){.skills-layout{grid-template-columns:minmax(220px,.7fr) minmax(0,1.2fr)}.skill-detail{padding:16px}}@media(max-width:900px){.skills-layout{grid-template-columns:1fr}.skills-toolbar{flex-wrap:wrap}.skills-filters{flex-basis:100%;justify-content:flex-start}.skills-filters>.el-input{flex:1;width:auto}.diff-columns{grid-template-columns:1fr}}
@media(max-width:900px){.skills-page{overflow-y:auto}.skills-page>.skills-layout{display:block;flex:none;overflow:visible}.skills-layout>.skills-list,.skills-layout>.skill-detail{max-height:none;overflow:visible}.skills-layout>.skills-list{margin-bottom:18px}}
</style>
