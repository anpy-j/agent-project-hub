<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import MarkdownIt from 'markdown-it'
import PageHeader from '../components/PageHeader.vue'
import type { Project } from '../types'
import type { LibraryCapture, LibraryDetail, LibraryPatch, LibraryResource, LibrarySource, ResourceKind, ReadingState, ProcessingState } from '../types/library'
const route = useRoute(), router = useRouter()
const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).disable('image')
const kindLabels: Record<ResourceKind, string> = { article: '文章', github: 'GitHub 仓库', skill: 'Skill', mcp: 'MCP', tool: '工具', document: '文档 / 文字' }
const readingLabels: Record<ReadingState, string> = { unread: '待阅读', read: '已读', practiced: '已实践' }
const processLabels = { queued: '等待处理', fetching: '获取原文', analyzing: 'AI 分析中', ready: '已整理', failed: '处理失败' }
const syncLabels = { none: '未入库', uploading: '上传中', uploaded: '已上传', parsing: '解析中', ready: '可检索', failed: '入库失败' }
const items = ref<LibraryResource[]>([]), projects = ref<Project[]>([])
const query = ref(''), kind = ref<ResourceKind | ''>(''), reading = ref<ReadingState | ''>(''), projectId = ref(String(route.query.projectId || '')), archived = ref(false)
const processingFilter = ref<ProcessingState | ''>('')
const loading = ref(false), pageError = ref('')
const captureVisible = ref(false), captureMode = ref<'link' | 'text' | 'file'>('link'), capturing = ref(false)
const capture = ref<LibraryCapture>({})
const captureTags = ref(''), captureKind = ref<ResourceKind | ''>('')
const drawer = ref(false), selected = ref<LibraryDetail | null>(null), selectedId = ref(''), detailLoading = ref(false), tab = ref('analysis')
const editing = ref<LibraryPatch>({}), editTags = ref(''), dirty = ref(false), saving = ref(false), actionBusy = ref('')
const supplemental = ref(''), supplementVisible = ref(false), supplementBusy = ref(false)
const question = ref(''), answer = ref(''), asking = ref(false)
const sourceVersion = ref(''), viewedSource = ref<LibrarySource | null>(null), raw = ref(false)
const visibleSourceWarnings = computed(() => (viewedSource.value?.warnings || []).filter(warning =>
  warning !== '正文从微信公众号文章区域提取，图片未保存。' &&
  warning !== '正文由用户在浏览器中确认并保存。'
))
const analysisId = ref('')
let listVersion = 0, detailVersion = 0, sourceRequest = 0, debounce: ReturnType<typeof setTimeout> | undefined
let unsubscribe: (() => void) | undefined
const currentAnalysis = computed(() => selected.value?.analyses.find(item => item.id === analysisId.value) || selected.value?.analyses[0])
const summaryStats = computed(() => ({ total: items.value.length, unread: items.value.filter(row => row.reading === 'unread').length, ready: items.value.filter(row => row.sync?.state === 'ready').length, processing: items.value.filter(row => ['queued', 'fetching', 'analyzing'].includes(row.processing)).length }))
function date(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
function tags(value: string) { return [...new Set(value.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean))] }
function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) }
function projectName(id: string) { const project = projects.value.find(row => row.id === id); return project?.display_name || project?.name || '项目已移除' }
function processing(resource: LibraryResource) { return ['queued', 'fetching', 'analyzing'].includes(resource.processing) }
async function load() {
  const version = ++listVersion; loading.value = true; pageError.value = ''
  try {
    const rows = await window.api.library.list({ query: query.value, kind: kind.value || undefined, reading: reading.value || undefined, processing: processingFilter.value || undefined, projectId: projectId.value || undefined, archived: archived.value })
    if (version === listVersion) items.value = rows
  } catch (e) { if (version === listVersion) pageError.value = (e as Error).message }
  finally { if (version === listVersion) loading.value = false }
}
function scheduleLoad() { if (debounce) clearTimeout(debounce); debounce = setTimeout(load, 180) }
watch([query, kind, reading, processingFilter, projectId, archived], scheduleLoad)
watch(() => route.query.projectId, value => { projectId.value = String(value || '') })
function newCapture() {
  capture.value = { url: '', title: '', content: '', reason: '', projectIds: projectId.value ? [projectId.value] : [], autoAnalyze: true, autoSync: ragConfigured.value }
  captureTags.value = ''; captureKind.value = ''; captureMode.value = 'link'; captureVisible.value = true
}
const ragConfigured = ref(false)
async function add() {
  capturing.value = true
  try {
    const input = { ...plain(capture.value), kind: captureKind.value || undefined, tags: tags(captureTags.value) }
    if (captureMode.value !== 'link') input.url = ''
    if (captureMode.value === 'link') input.content = ''
    const result = captureMode.value === 'file' ? await window.api.library.importFile(input) : await window.api.library.capture(input)
    if (!result) return
    captureVisible.value = false
    ElMessage[result.duplicate ? 'info' : 'success'](result.duplicate ? '该链接已收藏，已打开已有资料' : '资料已收藏，后台开始处理')
    await load(); await openDetail(result.resource.id)
  } catch (e) { ElMessage.error((e as Error).message) }
  finally { capturing.value = false }
}
function resetEditor(detail: LibraryDetail) {
  editing.value = { title: detail.title, kind: detail.kind, reading: detail.reading, reason: detail.reason, notes: detail.notes, projectIds: [...detail.projectIds], autoAnalyze: detail.autoAnalyze, autoSync: detail.autoSync }
  editTags.value = detail.tags.join('，'); dirty.value = false
}
async function refreshDetail() {
  const id = selectedId.value, version = ++detailVersion
  if (!id) return
  try {
    const detail = await window.api.library.detail(id)
    if (version !== detailVersion || id !== selectedId.value) return
    const oldSourceId = selected.value?.sourceId
    const oldAnalysisId = selected.value?.analyses[0]?.id
    selected.value = detail
    if (!dirty.value) resetEditor(detail)
    if (!analysisId.value || analysisId.value === oldAnalysisId || !detail.analyses.some(row => row.id === analysisId.value)) analysisId.value = detail.analyses[0]?.id || ''
    if (!sourceVersion.value || sourceVersion.value === oldSourceId) { sourceVersion.value = detail.sourceId; viewedSource.value = detail.source }
  } catch (e) { ElMessage.error((e as Error).message) }
}
async function openDetail(id: string) {
  selectedId.value = id; selected.value = null; dirty.value = false; sourceVersion.value = ''; viewedSource.value = null; raw.value = false
  analysisId.value = ''; question.value = ''; answer.value = ''; drawer.value = true; detailLoading.value = true; tab.value = 'analysis'
  try { await refreshDetail() } finally { detailLoading.value = false }
}
async function beforeClose(done: () => void) {
  if (dirty.value) {
    try { await ElMessageBox.confirm('有尚未保存的笔记或资料信息，关闭会放弃这些编辑。', '未保存的修改', { confirmButtonText: '放弃并关闭', cancelButtonText: '继续编辑', type: 'warning' }) } catch { return }
  }
  detailVersion++; sourceRequest++; done()
}
async function chooseSource(id: string) {
  const token = ++sourceRequest, resourceId = selectedId.value
  try { const source = await window.api.library.source(resourceId, id); if (token === sourceRequest && resourceId === selectedId.value) viewedSource.value = source }
  catch (e) { ElMessage.error((e as Error).message) }
}
async function save() {
  if (!selected.value) return
  saving.value = true
  try {
    await window.api.library.update(selected.value.id, { ...plain(editing.value), tags: tags(editTags.value) })
    dirty.value = false; await refreshDetail(); ElMessage.success('笔记与资料信息已保存')
  } catch (e) { ElMessage.error((e as Error).message) }
  finally { saving.value = false }
}
async function run(action: 'fetch' | 'analyze' | 'sync') {
  if (!selected.value) return
  actionBusy.value = action
  try { await window.api.library.process(selected.value.id, action); ElMessage.success('已加入处理队列'); await refreshDetail() }
  catch (e) { ElMessage.error((e as Error).message) }
  finally { actionBusy.value = '' }
}
async function browse() {
  try { if (selected.value) await window.api.library.browse(selected.value.id) }
  catch (e) { ElMessage.error((e as Error).message) }
}
async function refreshSync() {
  if (!selected.value) return
  actionBusy.value = 'refresh'
  try { await window.api.library.refreshSync(selected.value.id); await refreshDetail() }
  catch (e) { ElMessage.error((e as Error).message) }
  finally { actionBusy.value = '' }
}
async function supply() {
  if (!selected.value) return
  supplementBusy.value = true
  try { await window.api.library.supply(selected.value.id, supplemental.value); supplementVisible.value = false; supplemental.value = ''; await refreshDetail(); ElMessage.success('已保存新的原文快照') }
  catch (e) { ElMessage.error((e as Error).message) }
  finally { supplementBusy.value = false }
}
async function archiveResource() {
  if (!selected.value) return
  actionBusy.value = 'archive'
  try { await window.api.library.archive(selected.value.id, !selected.value.archived); await refreshDetail(); await load() }
  catch (e) { ElMessage.error((e as Error).message) }
  finally { actionBusy.value = '' }
}
async function ask() {
  const id = selectedId.value, value = question.value.trim()
  if (!value) return
  asking.value = true; answer.value = ''
  try { const result = await window.api.library.ask(id, value); if (id === selectedId.value) answer.value = result }
  catch (e) { ElMessage.error((e as Error).message) }
  finally { asking.value = false }
}
async function exportResource() {
  try { if (selected.value && await window.api.library.export(selected.value.id)) ElMessage.success('资料已导出') }
  catch (e) { ElMessage.error((e as Error).message) }
}
async function openUrl(url: string) {
  try { if (/^https?:\/\//i.test(url)) await window.api.system.openExternal(url) }
  catch (e) { ElMessage.error((e as Error).message) }
}
function linkClick(event: MouseEvent) {
  const anchor = (event.target as HTMLElement).closest('a')
  if (anchor) { event.preventDefault(); void openUrl(anchor.href) }
}
function saveAnswerToNotes() {
  if (!answer.value) return
  editing.value.notes = `${editing.value.notes || ''}\n\n## 资料问答：${question.value}\n\n${answer.value}`.trim()
  dirty.value = true; tab.value = 'notes'
}
function showSupplement() { supplemental.value = ''; supplementVisible.value = true }
onMounted(async () => {
  unsubscribe = window.api.library.onChanged(resource => { scheduleLoad(); if (drawer.value && selectedId.value === resource.id) void refreshDetail() })
  await load()
  try { projects.value = await window.api.project.list() } catch (e) { ElMessage.error((e as Error).message) }
  try { const config = await window.api.ragflow.getConfig(); ragConfigured.value = config.hasApiKey && !!config.datasetId } catch { /* Local collection is available without RAGFlow. */ }
})
onBeforeUnmount(() => { unsubscribe?.(); if (debounce) clearTimeout(debounce); listVersion++; detailVersion++; sourceRequest++ })
</script>

<template>
  <div class="page library-page">
    <PageHeader title="AI 资料库" subtitle="收藏好内容，整理成能读、能查、能用的知识">
      <template #actions><el-button @click="router.push('/settings?section=knowledge')">知识库连接</el-button><el-button type="primary" @click="newCapture"><el-icon><Plus /></el-icon>收藏资料</el-button></template>
    </PageHeader>
    <div class="library-stats"><span><b>{{ summaryStats.total }}</b> 份资料</span><span><b>{{ summaryStats.unread }}</b> 待阅读</span><span><b>{{ summaryStats.ready }}</b> 已可检索</span><span v-if="summaryStats.processing"><b>{{ summaryStats.processing }}</b> 正在整理</span></div>
    <div class="filters">
      <el-input v-model="query" clearable placeholder="搜索标题、原文、分析、标签和笔记" class="search"><template #prefix><el-icon><Search /></el-icon></template></el-input>
      <el-select v-model="kind" clearable placeholder="全部类型"><el-option v-for="(label, value) in kindLabels" :key="value" :label="label" :value="value" /></el-select>
      <el-select v-model="reading" clearable placeholder="阅读状态"><el-option v-for="(label, value) in readingLabels" :key="value" :label="label" :value="value" /></el-select>
      <el-select v-model="processingFilter" clearable placeholder="处理状态"><el-option v-for="(label, value) in processLabels" :key="value" :label="label" :value="value" /></el-select>
      <el-select v-model="projectId" filterable clearable placeholder="关联项目"><el-option v-for="project in projects" :key="project.id" :value="project.id" :label="project.display_name || project.name" /></el-select>
      <el-checkbox v-model="archived">已归档</el-checkbox>
    </div>
    <el-alert v-if="pageError" :title="pageError" type="error" :closable="false" show-icon />
    <div v-loading="loading" class="library-scroll">
      <el-empty v-if="!items.length && !loading" :description="query || kind || reading || processingFilter || projectId ? '没有符合筛选条件的资料' : archived ? '暂无归档资料' : '把值得留下的文章、仓库或工具收藏到这里'">
        <el-button v-if="!archived" type="primary" @click="newCapture">收藏第一份资料</el-button>
      </el-empty>
      <div class="resource-grid">
        <button v-for="item in items" :key="item.id" class="resource-card" type="button" @click="openDetail(item.id)">
          <div class="card-meta"><span class="kind">{{ kindLabels[item.kind] }}</span><span class="reading">{{ readingLabels[item.reading] }}</span></div>
          <h2>{{ item.title }}</h2>
          <p class="summary">{{ item.summary || (item.processing === 'failed' ? item.error : item.reason || '原文已保存，可在详情中阅读与分析') }}</p>
          <div class="tag-row"><span v-for="tag in item.tags.slice(0, 4)" :key="tag" class="tag">{{ tag }}</span></div>
          <div v-if="item.projectIds.length" class="project-line"><el-icon><Folder /></el-icon>{{ item.projectIds.map(projectName).join('、') }}</div>
          <div class="card-foot"><span :class="{ failed: item.processing === 'failed' }">{{ processLabels[item.processing] }}</span><span v-if="item.sync" :class="{ failed: item.sync.state === 'failed' }">{{ syncLabels[item.sync.state] }}</span><span v-else class="muted">本地收藏</span></div>
        </button>
      </div>
    </div>

    <el-dialog v-model="captureVisible" title="收藏资料" width="680px" :close-on-click-modal="false">
      <el-radio-group v-model="captureMode" :disabled="capturing" class="capture-modes"><el-radio-button value="link">链接</el-radio-button><el-radio-button value="text">粘贴文字</el-radio-button><el-radio-button value="file">导入文件</el-radio-button></el-radio-group>
      <el-form label-position="top" :disabled="capturing">
        <el-form-item v-if="captureMode === 'link'" label="文章、GitHub 仓库或工具链接"><el-input v-model="capture.url" placeholder="https://..." /></el-form-item>
        <el-form-item v-if="captureMode === 'text'" label="原文内容"><el-input v-model="capture.content" type="textarea" :rows="7" placeholder="粘贴文章、使用说明、Skill 或 MCP 文档" /></el-form-item>
        <p v-if="captureMode === 'file'" class="hint">支持 5MB 以内的 Markdown、TXT、HTML、JSON、YAML 文件。点击下方按钮选择文件。</p>
        <div class="form-columns"><el-form-item label="标题（可选）"><el-input v-model="capture.title" placeholder="留空自动提取" maxlength="300" /></el-form-item><el-form-item label="资料类型"><el-select v-model="captureKind"><el-option label="自动识别" value="" /><el-option v-for="(label, value) in kindLabels" :key="value" :label="label" :value="value" /></el-select></el-form-item></div>
        <el-form-item label="为什么收藏它？"><el-input v-model="capture.reason" type="textarea" :rows="2" placeholder="例如：想用它解决直播视频切片，AI 会围绕这个目的整理" maxlength="4000" /></el-form-item>
        <div class="form-columns"><el-form-item label="标签"><el-input v-model="captureTags" placeholder="多个标签用逗号分隔" /></el-form-item><el-form-item label="关联项目"><el-select v-model="capture.projectIds" multiple filterable placeholder="选择项目"><el-option v-for="project in projects" :key="project.id" :value="project.id" :label="project.display_name || project.name" /></el-select></el-form-item></div>
        <div class="capture-options"><el-checkbox v-model="capture.autoAnalyze">自动 AI 分析</el-checkbox><el-checkbox v-model="capture.autoSync">自动同步原文到 RAGFlow</el-checkbox></div>
        <p class="hint">AI 分析使用全局设置中的通用 AI；正文和收藏目的会发送给该服务。原文入库独立于 AI 分析，笔记保存在本机。</p>
      </el-form>
      <template #footer><el-button :disabled="capturing" @click="captureVisible = false">取消</el-button><el-button type="primary" :loading="capturing" @click="add">{{ captureMode === 'file' ? '选择文件并收藏' : '收藏并整理' }}</el-button></template>
    </el-dialog>

    <el-drawer v-model="drawer" size="76%" :before-close="beforeClose" class="library-drawer">
      <template #header><div class="detail-heading"><div><h2 class="detail-title">{{ selected?.title || '资料详情' }}</h2><div v-if="selected" class="detail-meta"><span class="hint">{{ kindLabels[selected.kind] }} · 收藏于 {{ date(selected.createdAt) }}</span><el-tag size="small" :type="selected.processing === 'failed' ? 'danger' : processing(selected) ? 'warning' : 'success'">{{ processLabels[selected.processing] }}</el-tag></div></div>
        <el-dropdown v-if="selected" trigger="click">
          <el-button>资料操作 ▾</el-button>
          <template #dropdown><el-dropdown-menu>
            <el-dropdown-item v-if="selected.url" @click="openUrl(selected.url)">打开来源</el-dropdown-item>
            <el-dropdown-item v-if="selected.url" :disabled="processing(selected) || selected.archived" @click="browse">浏览器获取</el-dropdown-item>
            <el-dropdown-item :disabled="processing(selected) || !!actionBusy || !selected.url || selected.archived" @click="run('fetch')">重新获取</el-dropdown-item>
            <el-dropdown-item :disabled="processing(selected) || selected.archived" @click="showSupplement">补充正文</el-dropdown-item>
            <el-dropdown-item divided :disabled="processing(selected) || !!actionBusy || selected.archived" @click="run('analyze')">重新分析</el-dropdown-item>
            <el-dropdown-item :disabled="processing(selected) || !!actionBusy || selected.archived || !selected.source" @click="run('sync')">同步原文到知识库</el-dropdown-item>
            <el-dropdown-item @click="exportResource">导出</el-dropdown-item>
            <el-dropdown-item divided :disabled="processing(selected) || !!actionBusy" @click="archiveResource">{{ selected.archived ? '恢复资料' : '归档' }}</el-dropdown-item>
          </el-dropdown-menu></template>
        </el-dropdown>
      </div></template>
      <div v-loading="detailLoading" v-if="selected" class="detail">
        <div v-if="selected.sync" class="detail-status"><el-tag v-if="selected.sync" :type="selected.sync.state === 'failed' ? 'danger' : selected.sync.state === 'ready' ? 'success' : 'info'">RAGFlow：{{ syncLabels[selected.sync.state] }}{{ selected.sync.state === 'parsing' ? ` ${Math.round(selected.sync.progress * 100)}%` : '' }}</el-tag><el-button v-if="selected.sync?.documentId" size="small" text :disabled="!!actionBusy" @click="refreshSync">刷新解析状态</el-button></div>
        <el-alert v-if="selected.error" :title="selected.error" type="error" :closable="false" show-icon />
        <el-alert v-if="selected.sync?.error" :title="selected.sync.error" type="warning" :closable="false" show-icon />
        <el-tabs v-model="tab">
          <el-tab-pane label="AI 整理" name="analysis">
            <div v-if="currentAnalysis">
              <div class="version-row"><span class="hint">{{ currentAnalysis.model }} · {{ date(currentAnalysis.createdAt) }}</span><el-select v-model="analysisId" size="small" style="width: 240px"><el-option v-for="entry in selected.analyses" :key="entry.id" :label="date(entry.createdAt)" :value="entry.id" /></el-select></div>
              <el-alert v-if="currentAnalysis.sourceId !== selected.sourceId" title="这份分析基于较早的原文快照，可重新分析最新原文。" type="warning" :closable="false" />
              <el-alert v-if="currentAnalysis.inputTruncated" title="原文超过单次分析长度，本次只分析前 60000 字符；完整原文已保存。" type="info" :closable="false" />
              <div class="markdown" v-html="md.render(currentAnalysis.markdown)" @click="linkClick" />
            </div>
            <el-empty v-else :description="processing(selected) ? '正在整理，处理完成后会自动显示' : '尚未生成 AI 分析，可以先阅读原文或点击重新分析'" />
          </el-tab-pane>
          <el-tab-pane label="原文与来源" name="source">
            <template v-if="viewedSource">
              <el-alert v-for="warning in visibleSourceWarnings" :key="warning" :title="warning" type="info" :closable="false" />
              <pre v-if="raw" class="raw-content">{{ viewedSource.raw }}</pre><div v-else class="markdown" v-html="md.render(viewedSource.content)" @click="linkClick" />
              <details class="source-info"><summary>来源与版本信息</summary>
                <div class="source-actions"><el-select v-if="selected.sources.length" v-model="sourceVersion" placeholder="原文快照" style="width: 240px" @change="chooseSource"><el-option v-for="source in selected.sources" :key="source.id" :value="source.id" :label="date(source.createdAt)" /></el-select><el-checkbox v-model="raw">查看原始内容</el-checkbox></div>
                <div>来源：{{ viewedSource.url || '用户提供的文本 / 文件' }}</div><div>作者：{{ viewedSource.author || '来源未说明' }}</div><div>采集：{{ date(viewedSource.createdAt) }}</div><div>版本：{{ viewedSource.version || '网页快照' }}</div>
              </details>
            </template>
            <el-empty v-else description="未获取到原文，可以重新获取或手动补充正文" />
          </el-tab-pane>
          <el-tab-pane label="我的笔记与项目" name="notes">
            <el-form label-position="top" @input="dirty = true" @change="dirty = true">
              <div class="form-columns"><el-form-item label="标题"><el-input v-model="editing.title" maxlength="300" /></el-form-item><el-form-item label="资料类型"><el-select v-model="editing.kind" @change="dirty = true"><el-option v-for="(label, value) in kindLabels" :key="value" :label="label" :value="value" /></el-select></el-form-item></div>
              <div class="form-columns"><el-form-item label="阅读状态"><el-select v-model="editing.reading" @change="dirty = true"><el-option v-for="(label, value) in readingLabels" :key="value" :label="label" :value="value" /></el-select></el-form-item><el-form-item label="标签"><el-input v-model="editTags" /></el-form-item></div>
              <el-form-item label="收藏目的"><el-input v-model="editing.reason" type="textarea" :rows="2" maxlength="4000" /></el-form-item>
              <el-form-item label="关联项目"><el-select v-model="editing.projectIds" multiple filterable style="width: 100%" @change="dirty = true"><el-option v-for="project in projects" :key="project.id" :value="project.id" :label="project.display_name || project.name" /></el-select></el-form-item>
              <el-form-item label="我的笔记 / 实践经验"><el-input v-model="editing.notes" type="textarea" :rows="10" placeholder="你的理解、使用经验、遇到的问题和解决方法。重新分析不会覆盖这些内容。" maxlength="100000" /></el-form-item>
              <div class="capture-options"><el-checkbox v-model="editing.autoAnalyze" @change="dirty = true">重新获取后自动分析</el-checkbox><el-checkbox v-model="editing.autoSync" @change="dirty = true">处理后自动同步原文</el-checkbox></div>
              <el-button type="primary" :loading="saving" @click="save">保存笔记与信息</el-button><span v-if="dirty" class="unsaved">有未保存的修改</span>
            </el-form>
          </el-tab-pane>
          <el-tab-pane label="针对资料提问" name="ask">
            <p class="hint">根据本份原文和关联项目回答。可问“怎么安装”“核心观点是什么”“适合我的项目吗”。回复可加入笔记草稿后保存。</p>
            <el-input v-model="question" :disabled="asking" type="textarea" :rows="3" placeholder="输入你想了解的问题" maxlength="4000" /><el-button class="ask-button" type="primary" :loading="asking" :disabled="!selected.source || !question.trim()" @click="ask">提问</el-button>
            <el-button v-if="answer" @click="saveAnswerToNotes">加入笔记草稿</el-button>
            <div v-if="answer" class="markdown answer" v-html="md.render(answer)" @click="linkClick" />
          </el-tab-pane>
          <el-tab-pane label="入库记录" name="sync">
            <el-empty v-if="!selected.syncs.length" description="暂无入库记录，点击同步原文到知识库开始" />
            <div v-for="sync in selected.syncs" :key="sync.id" class="sync-record"><b>{{ syncLabels[sync.state] }}</b><span class="hint">{{ date(sync.updatedAt) }}</span><p>服务：{{ sync.baseUrl }}</p><p>知识库：{{ sync.datasetId }}</p><p>文档：{{ sync.documentId || '尚未上传成功' }}</p><p v-if="sync.error" class="failed">{{ sync.error }}</p><span class="hint">{{ sync.sourceId === selected.sourceId ? '当前原文版本' : '历史原文版本' }}</span></div>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-drawer>
    <el-dialog v-model="supplementVisible" title="补充原文" width="680px" :close-on-click-modal="false"><p class="hint">保存为新的原文快照，保留此前内容、分析和个人笔记。</p><el-input v-model="supplemental" type="textarea" :rows="15" placeholder="粘贴完整正文" /><template #footer><el-button :disabled="supplementBusy" @click="supplementVisible = false">取消</el-button><el-button type="primary" :loading="supplementBusy" @click="supply">保存正文并处理</el-button></template></el-dialog>
  </div>
</template>

<style scoped>
.library-page { min-height: 0; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; }
.library-stats { display: flex; gap: 24px; margin: 2px 0 22px; color: var(--el-text-color-secondary); font-size: 13px; }
.library-stats b { color: var(--el-text-color-primary); font-size: 20px; margin-right: 5px; }
.filters { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
.filters .search { flex: 1; min-width: 230px; }
.filters .el-select { width: 150px; }
.library-scroll { flex: 1; min-height: 0; overflow: auto; padding: 2px 2px 24px; }
.resource-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 16px; }
.resource-card { display: flex; flex-direction: column; gap: 12px; padding: 20px; min-height: 240px; border: 1px solid var(--el-border-color-light); border-radius: 14px; background: var(--el-bg-color); text-align: left; color: var(--el-text-color-primary); cursor: pointer; font: inherit; transition: border-color .15s, transform .15s; }
.resource-card:hover { border-color: var(--el-color-primary); transform: translateY(-2px); }
.resource-card:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.card-meta, .card-foot { width: 100%; box-sizing: border-box; display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 12px; }
.kind { color: var(--el-color-primary); font-weight: 600; }
.reading, .muted, .hint { color: var(--el-text-color-secondary); }
.resource-card h2 { font-size: 17px; line-height: 1.5; margin: 0; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
.summary { margin: 0; font-size: 13px; line-height: 1.7; color: var(--el-text-color-secondary); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.tag-row { display: flex; gap: 6px; flex-wrap: wrap; }
.tag { font-size: 11px; padding: 3px 7px; border-radius: 5px; background: var(--el-fill-color); color: var(--el-text-color-secondary); }
.project-line { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--el-text-color-secondary); }
.card-foot { margin-top: auto; padding-top: 12px; border-top: 1px solid var(--el-border-color-lighter); }
.failed { color: var(--el-color-danger); }
.capture-modes { margin-bottom: 20px; }
.form-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.form-columns .el-select { width: 100%; }
.capture-options { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 16px; }
.hint { font-size: 12px; line-height: 1.7; }
.detail-title { font-size: 21px; line-height: 1.5; color: var(--el-text-color-primary); margin: 0 0 6px; overflow-wrap: anywhere; }
.detail-actions, .detail-status, .source-actions, .version-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
.version-row { justify-content: space-between; }
.detail :deep(.el-alert) { margin-bottom: 14px; }
.source-info { padding: 16px; margin: 14px 0; border-radius: 10px; background: var(--el-fill-color-light); font-size: 12px; line-height: 1.9; overflow-wrap: anywhere; }
.markdown, .raw-content { width: 100%; max-width: 720px; box-sizing: border-box; margin: 0 auto; }
.markdown { font-size: 17px; line-height: 1.95; letter-spacing: .02em; overflow-wrap: anywhere; padding: 4px 0 32px; color: var(--el-text-color-primary); }
.markdown :deep(p) { margin: 0 0 1.25em; }
.markdown :deep(li) { margin: .4em 0; }
.markdown :deep(ul), .markdown :deep(ol) { padding-left: 1.6em; margin: 0 0 1.25em; }
.markdown :deep(blockquote) { margin: 1.5em 0; padding: 4px 20px; border-left: 3px solid var(--el-border-color); color: var(--el-text-color-secondary); }
.markdown :deep(blockquote p:last-child) { margin-bottom: 0; }
.markdown :deep(h1), .markdown :deep(h2), .markdown :deep(h3) { line-height: 1.5; margin-bottom: .8em; }
.detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; width: 100%; }
.detail-heading > div { min-width: 0; }
.detail-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.detail-heading .el-dropdown { flex-shrink: 0; }
.library-drawer :deep(.el-drawer__header) { margin-bottom: 0; padding-bottom: 12px; }
.library-drawer :deep(.el-drawer__body) { padding-top: 0; }
.detail-status { margin-bottom: 8px; gap: 8px; }
.source-info { max-width: 720px; box-sizing: border-box; margin: 12px auto 24px; }
.source-info summary { cursor: pointer; }
.source-info .source-actions { margin: 12px 0; }
@media (max-width: 700px) { .markdown { font-size: 16px; } .detail-title { font-size: 18px; } }
.markdown :deep(h1) { font-size: 23px; }
.markdown :deep(h2) { font-size: 19px; border-bottom: 1px solid var(--el-border-color-light); padding-bottom: 8px; margin-top: 24px; }
.markdown :deep(h3) { font-size: 16px; }
.markdown :deep(a) { color: var(--el-color-primary); }
.markdown :deep(pre), .raw-content { padding: 16px; border-radius: 8px; background: var(--el-fill-color-light); overflow: auto; font-size: 12px; }
.raw-content { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.markdown :deep(code) { font-family: monospace; background: var(--el-fill-color-light); }
.markdown :deep(table) { border-collapse: collapse; display: block; overflow-x: auto; }
.markdown :deep(td), .markdown :deep(th) { padding: 8px 12px; border: 1px solid var(--el-border-color); }
.unsaved { font-size: 12px; margin-left: 12px; color: var(--el-color-warning); }
.ask-button { margin: 14px 0; }
.answer { padding: 18px; border: 1px solid var(--el-border-color); border-radius: 12px; }
.sync-record { border: 1px solid var(--el-border-color-light); border-radius: 10px; padding: 16px; margin-bottom: 14px; overflow-wrap: anywhere; font-size: 13px; }
.sync-record > span { margin-left: 12px; }
@media (max-width: 1050px) { .filters .el-select { width: 130px; } .form-columns { grid-template-columns: 1fr; gap: 0; } }
</style>
