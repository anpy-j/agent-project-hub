<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { RagflowInput, RagflowDataset, RagflowDocument } from '../types/ragflow'
const form = ref<RagflowInput>({ baseUrl: '', datasetId: '', apiKey: '' })
const hasApiKey = ref(false)
const busy = ref(false)
const loading = ref(false)
const result = ref('')
const error = ref('')
const datasets = ref<RagflowDataset[]>([])
const documents = ref<RagflowDocument[]>([])
const saved = ref(false)
function input(): RagflowInput { return { ...form.value } }
watch(form, () => { result.value = ''; error.value = ''; documents.value = []; saved.value = false }, { deep: true })
watch(() => form.value.baseUrl, () => { datasets.value = [] })
async function load() {
  loading.value = true
  try {
    const config = await window.api.ragflow.getConfig()
    form.value = { baseUrl: config.baseUrl, datasetId: config.datasetId, apiKey: '' }
    hasApiKey.value = config.hasApiKey
  } catch (e) { error.value = (e as Error).message }
  finally { loading.value = false }
}
async function test() {
  busy.value = true; error.value = ''; result.value = ''
  try {
    const response = await window.api.ragflow.test(input())
    datasets.value = response.datasets
    result.value = response.selected ? `连接正常，已验证知识库：${response.selected.name}` : `连接正常，可访问 ${response.datasets.length} 个知识库，请选择并保存`
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
async function save() {
  busy.value = true; error.value = ''; result.value = ''
  try {
    if (!form.value.datasetId.trim()) throw new Error('请先选择或填写知识库 ID')
    const response = await window.api.ragflow.test(input())
    datasets.value = response.datasets
    const config = await window.api.ragflow.saveConfig(input())
    form.value = { baseUrl: config.baseUrl, datasetId: config.datasetId, apiKey: '' }
    hasApiKey.value = config.hasApiKey
    // Allow the form watcher to finish before displaying the saved state.
    await nextTick()
    saved.value = true
    result.value = `连接已保存，知识库：${response.selected?.name}`
    ElMessage.success('RAGFlow 连接已保存')
    await preview()
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
async function preview() {
  loading.value = true; error.value = ''
  try { documents.value = await window.api.ragflow.documents() }
  catch (e) { error.value = (e as Error).message }
  finally { loading.value = false }
}
async function open() {
  try { await window.api.ragflow.open() } catch (e) { error.value = (e as Error).message }
}
function status(run: string): string {
  const names: Record<string, string> = { '0': '未开始', '1': '解析中', '2': '已取消', '3': '已完成', '4': '失败', '5': '等待解析', UNSTART: '未开始', RUNNING: '解析中', CANCEL: '已取消', DONE: '已完成', FAIL: '失败', SCHEDULE: '等待解析' }
  return names[run] || run || '未知'
}
onMounted(load)
</script>

<template>
  <el-card v-loading="loading">
    <template #header><div class="head"><b>RAGFlow 知识库连接</b><el-tag :type="hasApiKey ? 'success' : 'info'">{{ hasApiKey ? '已保存凭据' : '待配置' }}</el-tag></div></template>
    <p class="tip">连接已有知识库，验证访问权限并查看文档。API Key 使用本机系统安全存储加密保存。</p>
    <el-form label-width="110px" @submit.prevent>
      <el-form-item label="服务地址"><el-input v-model="form.baseUrl" :disabled="busy" placeholder="http://127.0.0.1:14310" /></el-form-item>
      <el-form-item label="API Key"><el-input v-model="form.apiKey" :disabled="busy" type="password" show-password :placeholder="hasApiKey ? '留空使用已保存的密钥；更换地址需要重新填写' : '填写 RAGFlow 生成的 API Key'" /></el-form-item>
      <el-form-item label="知识库 ID"><el-input v-model="form.datasetId" :disabled="busy" placeholder="填写 ID；清空后测试可获取可访问的知识库" /></el-form-item>
      <el-form-item v-if="datasets.length" label="选择知识库"><el-select v-model="form.datasetId" :disabled="busy" filterable style="width: 100%"><el-option v-for="item in datasets" :key="item.id" :value="item.id" :label="item.name" /></el-select></el-form-item>
      <el-form-item><el-button :loading="busy" :disabled="loading" @click="test">测试连接 / 获取知识库</el-button><el-button type="primary" :loading="busy" :disabled="loading" @click="save">验证并保存</el-button><el-button :disabled="busy || !hasApiKey" @click="open">打开已保存的知识库</el-button></el-form-item>
    </el-form>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-alert v-if="result" :title="result" type="success" :closable="false" show-icon />
    <div class="head preview"><b>知识库文档</b><el-button size="small" :disabled="busy || loading || !hasApiKey || !saved" @click="preview">刷新文档</el-button></div>
    <p class="tip">验证并保存后显示最多 20 条文档；解析状态以 RAGFlow 返回结果为准。</p>
    <el-table :data="documents" empty-text="验证并保存连接后查看文档；知识库也可能为空">
      <el-table-column prop="name" label="文档名称" min-width="240" />
      <el-table-column label="解析状态" width="120"><template #default="{ row }">{{ status(String(row.run)) }}</template></el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.tip { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; margin: 0 0 18px; }
.preview { margin-top: 24px; margin-bottom: 12px; }
.el-alert { margin-top: 12px; }
</style>
