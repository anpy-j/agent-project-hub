<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { GitAuthSnapshot, GitKey, GitAuthResult } from '../types/git-auth'

const snapshot = ref<GitAuthSnapshot | null>(null)
const loading = ref(false)
const error = ref('')
const selectedKey = ref<GitKey | null>(null)
const publicKeyVisible = ref(false)
const platforms = ref([
  { id: 'github', name: 'GitHub', url: '', testing: false, result: null as GitAuthResult | null },
  { id: 'gitee', name: 'Gitee', url: '', testing: false, result: null as GitAuthResult | null },
  { id: 'huawei', name: '华为云 CodeArts Repo', url: '', testing: false, result: null as GitAuthResult | null },
  { id: 'other', name: '其他 Git 平台', url: '', testing: false, result: null as GitAuthResult | null }
])
const labels: Record<GitAuthResult['status'], string> = {
  success: '检测成功', 'auth-failed': '认证或权限失败', 'network-failed': '网络连接失败',
  'host-untrusted': '主机身份待确认', unknown: '未能确认'
}
async function refresh() {
  loading.value = true
  error.value = ''
  try {
    if (!window.api.gitAuth) throw new Error('请完整重启 Project Hub 以启用仓库认证模块')
    snapshot.value = await window.api.gitAuth.snapshot()
  } catch (e) { error.value = (e as Error).message }
  finally { loading.value = false }
}
async function copyKey(key: GitKey) {
  try { await navigator.clipboard.writeText(key.publicKey); ElMessage.success('公钥已复制') }
  catch { ElMessage.error('复制失败，请在公钥弹窗中手动复制') }
}
async function test(platform: typeof platforms.value[number]) {
  if (platform.testing) return
  if (['huawei', 'other'].includes(platform.id) && !platform.url.trim()) {
    ElMessage.warning('请填写仓库地址'); return
  }
  platform.testing = true
  platform.result = null
  try { platform.result = await window.api.gitAuth.test({ platform: platform.id, url: platform.url.trim() }) }
  catch (e) { ElMessage.error((e as Error).message) }
  finally { platform.testing = false }
}
onMounted(refresh)
</script>

<template>
  <el-card v-loading="loading" class="git-auth-settings">
    <template #header>
      <div class="module-header"><b>Git 与仓库认证</b><el-button size="small" :loading="loading" @click="refresh">刷新本机配置</el-button></div>
    </template>
    <el-alert v-if="error" :title="error" type="warning" :closable="false" show-icon />
    <template v-if="snapshot">
      <div class="environment">
        <span class="pill">{{ snapshot.version }}</span>
        <span>提交用户：{{ snapshot.username || '未设置' }}</span>
        <span>邮箱：{{ snapshot.email || '未设置' }}</span>
        <span>SSH Agent：{{ snapshot.agentStatus }}</span>
      </div>
      <h3>本机 SSH 密钥</h3>
      <p class="hint">展示公钥及私钥文件存在状态，支持查看和复制公钥。已加载表示密钥在本机 SSH Agent 中，平台是否接受需要另行测试。</p>
      <el-table :data="snapshot.keys" empty-text="未发现可读取的 SSH 公钥" style="width: 100%">
        <el-table-column label="密钥文件" min-width="180" show-overflow-tooltip>
          <template #default="{ row }"><div>{{ row.name }}</div><span class="hint">{{ row.path }}</span></template>
        </el-table-column>
        <el-table-column prop="type" label="类型" width="150" />
        <el-table-column prop="fingerprint" label="指纹" min-width="240" show-overflow-tooltip />
        <el-table-column prop="comment" label="备注" min-width="140" show-overflow-tooltip />
        <el-table-column label="本机状态" width="150">
          <template #default="{ row }"><div>{{ row.loaded ? 'Agent 已加载' : 'Agent 未加载' }}</div><span class="hint">{{ row.privateKeyExists ? '私钥文件存在' : '未发现配对私钥' }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="170">
          <template #default="{ row }">
            <el-button link type="primary" @click="selectedKey = row as GitKey; publicKeyVisible = true">查看公钥</el-button>
            <el-button link type="primary" @click="copyKey(row as GitKey)">复制</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="config-row"><span class="hint">HTTPS 凭据管理器：</span>{{ snapshot.helpers.join('、') || '未配置' }}</div>
      <details v-if="snapshot.hosts.length" class="host-config">
        <summary>SSH 主机配置（{{ snapshot.hosts.length }}）</summary>
        <el-table :data="snapshot.hosts">
          <el-table-column prop="alias" label="主机别名" />
          <el-table-column prop="hostname" label="主机地址" />
          <el-table-column prop="identityFile" label="配置的密钥路径" min-width="220" show-overflow-tooltip />
        </el-table>
      </details>
      <p v-for="warning in snapshot.warnings" :key="warning" class="hint">{{ warning }}</p>
      <h3>平台与仓库连接测试</h3>
      <p class="hint">GitHub、Gitee 留空时测试平台 SSH 认证；填写仓库地址时测试读取权限。华为云需填写实际仓库地址。测试使用本机 Git / SSH 认证配置。</p>
      <div v-for="platform in platforms" :key="platform.id" class="platform-row">
        <div class="platform-controls">
          <strong>{{ platform.name }}</strong>
          <el-input v-model="platform.url" :disabled="platform.testing" :placeholder="['github', 'gitee'].includes(platform.id) ? '可选：填写仓库地址，检测仓库读取权限' : '填写 HTTPS 或 SSH 仓库地址'" @input="platform.result = null" />
          <el-button :disabled="!!error" :loading="platform.testing" @click="test(platform)">测试连接</el-button>
        </div>
        <div v-if="platform.result" class="test-result">
          <el-tag :type="platform.result.status === 'success' ? 'success' : 'warning'">{{ labels[platform.result.status] }}</el-tag>
          <span>{{ platform.result.message }}</span>
          <span class="hint">{{ new Date(platform.result.checkedAt).toLocaleString() }}</span>
        </div>
        <div v-else class="hint">{{ platform.testing ? '检测中…' : '未检测' }}</div>
      </div>
    </template>
    <el-dialog v-model="publicKeyVisible" title="SSH 公钥" width="600" append-to-body>
      <template v-if="selectedKey">
        <p class="hint">{{ selectedKey.path }}</p>
        <el-input :model-value="selectedKey.publicKey" type="textarea" :rows="5" readonly />
      </template>
      <template #footer><el-button v-if="selectedKey" type="primary" @click="copyKey(selectedKey)">复制公钥</el-button></template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.module-header, .environment, .test-result { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.module-header { justify-content: space-between; }
.environment { font-size: 13px; }
h3 { margin: 22px 0 8px; font-size: 14px; }
.hint { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.6; }
p.hint { margin: 6px 0 12px; }
.config-row { margin-top: 14px; font-size: 13px; }
.host-config { margin-top: 12px; font-size: 13px; }
summary { cursor: pointer; }
.platform-row { padding: 12px 0; border-top: 1px solid var(--el-border-color-lighter); }
.platform-controls { display: flex; align-items: center; gap: 12px; }
.platform-controls strong { width: 180px; flex-shrink: 0; font-size: 13px; }
.test-result { margin-top: 10px; font-size: 12px; }
@media (max-width: 1000px) { .platform-controls { flex-wrap: wrap; } .platform-controls strong { width: 100%; } .platform-controls .el-input { flex: 1; min-width: 180px; } }
</style>
