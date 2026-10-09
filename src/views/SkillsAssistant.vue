<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import MarkdownIt from 'markdown-it'
import PageHeader from '../components/PageHeader.vue'
import type { Project } from '../types'
import type { SkillContext } from '../types/skills'

const route = useRoute(), router = useRouter(), md = new MarkdownIt({ html: false, breaks: true })
const projects = ref<Project[]>([]), projectId = ref(typeof route.query.projectId === 'string' ? route.query.projectId : '')
const available = ref<SkillContext[]>([]), selectedIds = ref<string[]>([]), prompt = ref(''), answer = ref(''), loadedSkills = ref<string[]>([])
const busy = ref(false), loading = ref(false)
let request = 0
async function load() {
  const revision = ++request; loading.value = true
  try { const skills = await window.api.skills.context(projectId.value || undefined); if (revision === request) { available.value = skills; selectedIds.value = selectedIds.value.filter(id => skills.some(s => s.skillId === id)) } }
  catch (e) { ElMessage.error((e as Error).message) } finally { if (revision === request) loading.value = false }
}
async function ask() {
  busy.value = true
  try {
    const cfg = await window.api.ai.getConfig()
    if (!cfg.model) { ElMessage.info('请先在全局设置 → AI 服务中配置模型'); router.push({ path: '/settings', query: { section: 'ai' } }); return }
    const result = await window.api.skills.chat({ prompt: prompt.value, projectId: projectId.value || undefined, skillIds: [...selectedIds.value] })
    answer.value = result.answer; loadedSkills.value = result.skills
  } catch (e) { ElMessage.error((e as Error).message) } finally { busy.value = false }
}
function links(e: MouseEvent) { const link = (e.target as HTMLElement).closest('a'); if (link) { e.preventDefault(); const href = link.getAttribute('href') || ''; if (/^https?:\/\//i.test(href)) void window.api.system.openExternal(href) } }
watch(projectId, load)
onMounted(async () => { try { projects.value = await window.api.project.list(); await load() } catch (e) { ElMessage.error((e as Error).message) } })
</script>
<template>
  <div class="page is-scroll assistant-page"><PageHeader title="AI 技能助手" subtitle="结合已启用的技能，解释流程、生成计划和文本草稿"><template #actions><el-button @click="router.push('/ai/skills')">管理技能</el-button><el-button @click="router.push({ path: '/settings', query: { section: 'ai' } })">全局 AI 设置</el-button></template></PageHeader>
    <el-alert title="当前提供说明与草稿，不执行命令、读写项目文件或发布。问题和所选技能正文会发送到全局设置 → AI 服务中配置的模型服务。" type="info" :closable="false" show-icon />
    <el-card class="assistant-config" shadow="never" v-loading="loading"><el-form label-position="top"><el-form-item label="项目上下文"><el-select v-model="projectId" clearable filterable :disabled="busy" placeholder="全局技能，无项目上下文"><el-option v-for="p in projects" :key="p.id" :label="p.display_name || p.name" :value="p.id" /></el-select></el-form-item><el-form-item label="本次使用的技能（最多 6 个）"><el-select v-model="selectedIds" multiple filterable :multiple-limit="6" :disabled="busy" placeholder="先在管理器中启用到 Project Hub AI"><el-option v-for="s in available" :key="s.skillId" :label="`${s.name} · ${s.description.slice(0,55)}`" :value="s.skillId" /></el-select></el-form-item><p v-if="!available.length" class="secondary">当前范围尚未启用技能。进入 Skills 管理 → 安装位置 → Project Hub AI，选择全局或此项目启用，无需复制技能文件。</p><el-form-item label="你希望完成什么"><el-input v-model="prompt" type="textarea" :rows="5" :maxlength="16000" :disabled="busy" placeholder="例如：根据发布技能，为当前项目整理 Windows 安装包发布步骤。" /></el-form-item><el-button type="primary" :loading="busy" :disabled="!prompt.trim() || loading" @click="ask">发送给已配置模型</el-button></el-form></el-card>
    <el-card v-if="answer" class="assistant-result" shadow="never"><template #header><div class="answer-head"><strong>AI 回复</strong><span class="secondary">本次加载：{{ loadedSkills.join('、') || '未选择技能' }}</span></div></template><div class="markdown" v-html="md.render(answer)" @click="links" /></el-card>
  </div>
</template>
<style scoped>
.assistant-page{box-sizing:border-box}.assistant-page>*{flex-shrink:0}
.assistant-page{padding-bottom:24px}.assistant-config,.assistant-result{margin-top:20px}.assistant-config .el-select{width:100%}.secondary{font-size:12px;line-height:1.7;color:var(--el-text-color-secondary)}.answer-head{display:flex;gap:16px;justify-content:space-between;flex-wrap:wrap}.markdown{line-height:1.9;font-size:13px;overflow-wrap:anywhere}.markdown :deep(pre){background:var(--ph-field);padding:14px;border-radius:8px;white-space:pre-wrap}.markdown :deep(img){display:none}.markdown :deep(a){color:var(--el-color-primary)}.markdown :deep(table){display:block;overflow:auto;max-width:100%}
</style>
