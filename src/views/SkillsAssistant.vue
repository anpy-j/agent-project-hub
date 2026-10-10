<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import MarkdownIt from 'markdown-it'
import type { Project } from '../types'

const props = defineProps<{ skillId: string; skillName: string; initialProjectId?: string }>()
const router = useRouter(), md = new MarkdownIt({ html: false, breaks: true })
const projects = ref<Project[]>([]), projectId = ref(props.initialProjectId || '')
const prompt = ref(''), answer = ref(''), loadedSkills = ref<string[]>([])
const busy = ref(false)
async function ask() {
  busy.value = true
  try {
    const cfg = await window.api.ai.getConfig()
    if (!cfg.model) { ElMessage.info('请先在全局设置 → AI 服务中配置模型'); router.push({ path: '/settings', query: { section: 'ai' } }); return }
    const result = await window.api.skills.chat({ prompt: prompt.value, projectId: projectId.value || undefined, skillIds: [props.skillId] })
    answer.value = result.answer; loadedSkills.value = result.skills
  } catch (e) { ElMessage.error((e as Error).message) } finally { busy.value = false }
}
function links(e: MouseEvent) { const link = (e.target as HTMLElement).closest('a'); if (link) { e.preventDefault(); const href = link.getAttribute('href') || ''; if (/^https?:\/\//i.test(href)) void window.api.system.openExternal(href) } }
onMounted(async () => { try { projects.value = await window.api.project.list() } catch (e) { ElMessage.error((e as Error).message) } })
</script>
<template>
  <div class="assistant-page"><div class="assistant-heading"><div><strong>使用此技能</strong><p class="secondary">基于 {{ props.skillName }}，解释流程、生成计划和文本草稿</p></div><div><el-button @click="router.push({ path: '/settings', query: { section: 'ai' } })">全局 AI 设置</el-button></div></div>
    <el-alert title="当前提供说明与草稿，不执行命令、读写项目文件或发布。问题和所选技能正文会发送到全局设置 → AI 服务中配置的模型服务。" type="info" :closable="false" show-icon />
    <el-card class="assistant-config" shadow="never"><el-form label-position="top"><el-form-item label="项目上下文"><el-select v-model="projectId" clearable filterable :disabled="busy" placeholder="不关联项目"><el-option v-for="p in projects" :key="p.id" :label="p.display_name || p.name" :value="p.id" /></el-select></el-form-item><el-form-item label="你希望完成什么"><el-input v-model="prompt" type="textarea" :rows="5" :maxlength="16000" :disabled="busy" placeholder="例如：根据发布技能，为当前项目整理 Windows 安装包发布步骤。" /></el-form-item><el-button type="primary" :loading="busy" :disabled="!prompt.trim()" @click="ask">发送给已配置模型</el-button></el-form></el-card>
    <el-card v-if="answer" class="assistant-result" shadow="never"><template #header><div class="answer-head"><strong>AI 回复</strong><span class="secondary">本次加载：{{ loadedSkills.join('、') || '未选择技能' }}</span></div></template><div class="markdown" v-html="md.render(answer)" @click="links" /></el-card>
  </div>
</template>
<style scoped>
.assistant-page{box-sizing:border-box}.assistant-page>*{flex-shrink:0}
.assistant-heading{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:20px 0}.assistant-page{padding-bottom:24px}.assistant-config,.assistant-result{margin-top:20px}.assistant-config .el-select{width:100%}.secondary{font-size:12px;line-height:1.7;color:var(--el-text-color-secondary)}.answer-head{display:flex;gap:16px;justify-content:space-between;flex-wrap:wrap}.markdown{line-height:1.9;font-size:13px;overflow-wrap:anywhere}.markdown :deep(pre){background:var(--ph-field);padding:14px;border-radius:8px;white-space:pre-wrap}.markdown :deep(img){display:none}.markdown :deep(a){color:var(--el-color-primary)}.markdown :deep(table){display:block;overflow:auto;max-width:100%}
</style>
