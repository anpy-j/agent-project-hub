<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { AiConfig, AiProviderOption } from '../types'
const providers = ref<AiProviderOption[]>([])
const form = ref<AiConfig>({ provider: 'ollama', base_url: 'http://localhost:11434/v1', api_key: '', model: '' })
const models = ref<string[]>([]), busy = ref(''), result = ref(''), saved = ref('')
const provider = computed(() => providers.value.find(p => p.value === form.value.provider))
async function action(name: string, work: () => Promise<void>) {
  busy.value = name
  try { await work() } catch (e) { ElMessage.error((e as Error).message) } finally { busy.value = '' }
}
function changeProvider() { form.value.base_url = provider.value?.baseUrl || ''; form.value.model = ''; models.value = []; result.value = '' }
onMounted(() => action('load', async () => {
  const [list, config] = await Promise.all([window.api.ai.providers(), window.api.agent.getConfig()])
  providers.value = list; form.value = config; saved.value = config.model ? `${config.provider} · ${config.model}` : ''
}))
function save() { return action('save', async () => { const cfg = await window.api.agent.saveConfig({ ...form.value }); form.value = cfg; saved.value = `${cfg.provider} · ${cfg.model}`; ElMessage.success('Agent AI 配置已独立保存') }) }
function test() { return action('test', async () => { result.value = ''; result.value = await window.api.agent.test({ ...form.value }) }) }
function fetchModels() { return action('models', async () => { models.value = await window.api.ai.listModels({ ...form.value }) }) }
function copy() { return action('copy', async () => { form.value = { ...await window.api.ai.getConfig() }; models.value = []; result.value = ''; ElMessage.info('已复制到表单，点击保存后生效') }) }
</script>
<template>
  <el-card id="agent-ai-settings" v-loading="busy === 'load'">
    <template #header><div class="agent-config-head"><strong>Agent AI（独立配置）</strong><el-button :disabled="!!busy" size="small" @click="copy">从通用 AI 复制</el-button></div></template>
    <p class="secondary">用于项目构建、镜像发布、服务器查询与文件传输。与通用 AI 分别保存，任务使用开始时的配置。任务文本、项目配置和执行日志会发送给所选模型服务。</p>
    <el-alert v-if="saved" :title="`当前生效：${saved}`" type="success" :closable="false" />
    <el-form label-width="100px" class="agent-config-form">
      <el-form-item label="厂商"><el-select v-model="form.provider" @change="changeProvider"><el-option v-for="p in providers" :key="p.value" :value="p.value" :label="p.label" /></el-select></el-form-item>
      <el-form-item label="Base URL"><el-input v-model="form.base_url" :disabled="form.provider === 'opencode'" placeholder="https://服务地址/v1" /></el-form-item>
      <el-form-item label="API Key"><el-input v-model="form.api_key" type="password" show-password autocomplete="new-password" /></el-form-item>
      <el-form-item label="模型"><el-select v-model="form.model" filterable allow-create default-first-option placeholder="选择或输入 Agent 模型"><el-option v-for="m in models" :key="m" :value="m" :label="m" /></el-select></el-form-item>
      <el-form-item><span class="secondary">{{ provider?.hint }}</span></el-form-item>
      <el-form-item><el-button :disabled="!!busy" :loading="busy === 'models'" @click="fetchModels">刷新模型</el-button><el-button :disabled="!!busy" :loading="busy === 'test'" @click="test">测试连接与任务格式</el-button><el-button type="primary" :disabled="!!busy" :loading="busy === 'save'" @click="save">保存 Agent 配置</el-button></el-form-item>
      <el-form-item v-if="result" label="测试结果">{{ result }}</el-form-item>
    </el-form>
  </el-card>
</template>
<style scoped>
.agent-config-head { display:flex; align-items:center; justify-content:space-between; gap:12px }
.agent-config-form { margin-top:20px; max-width:660px }
.agent-config-form .el-select { width:100% }
.secondary { color:var(--el-text-color-secondary); font-size:13px; line-height:1.7 }
</style>
