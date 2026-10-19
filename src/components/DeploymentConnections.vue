<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { HostInput, HostProfile, RegistryInput, RegistryProfile } from '../types/deployment'
const api = window.api.deployment
const bridgeReady = ref(!!api && typeof api.registries === 'function')
const busy = ref(''), tab = ref('registries')
const registries = ref<RegistryProfile[]>([]), hosts = ref<HostProfile[]>([])
const registryDialog = ref(false), hostDialog = ref(false)
const registryError = ref('')
const repositoryPaths = ref('')
const aliyunEnabled = ref(false), aliyunRegion = ref('cn-hangzhou'), accessKeyId = ref(''), accessKeySecret = ref('')
function clearManagementKeys(): void { accessKeyId.value = ''; accessKeySecret.value = '' }
const registryForm = ref<RegistryInput>({ id: '', name: '', server: '', username: '', password: '' })
const hostForm = ref<HostInput>({ id: '', name: '', host: '', port: 22, username: '', authKind: 'privateKey', fingerprint: '', privateKey: '', passphrase: '', password: '' })
async function execute(name: string, fn: () => Promise<void>): Promise<void> {
  if (!bridgeReady.value) return
  if (busy.value) return
  busy.value = name
  try { await fn() } catch (error) {
    if (String(error).includes('No handler registered') && String(error).includes('deployment:')) {
      bridgeReady.value = false
      return
    }
    if (error !== 'cancel' && error !== 'close') {
      const message = String(error instanceof Error ? error.message : error)
      if (name === '保存仓库') registryError.value = message
      ElMessage.error(message)
    }
  } finally { busy.value = '' }
}
async function loadProfiles(): Promise<void> {
  [registries.value, hosts.value] = await Promise.all([api.registries(), api.hosts()])
}
onMounted(() => execute('加载连接', async () => { await loadProfiles() }))
function editRegistry(id?: string): void {
  registryError.value = ''
  const profile = registries.value.find(r => r.id === id)
  registryForm.value = profile ? { id: profile.id, name: profile.name, server: profile.server, username: profile.username, password: '' } : { id: '', name: '', server: '', username: '', password: '' }
  aliyunEnabled.value = !!profile?.aliyun
  aliyunRegion.value = profile?.aliyun?.regionId || profile?.server.match(/(?:registry(?:-vpc)?\.|crpi-[a-z0-9]+\.)([a-z0-9-]+)\./)?.[1] || 'cn-hangzhou'
  clearManagementKeys()
  repositoryPaths.value = (profile?.repositories || []).join('\n')
  registryDialog.value = true
}
function editHost(id?: string): void {
  const profile = hosts.value.find(h => h.id === id)
  hostForm.value = profile ? { id: profile.id, name: profile.name, host: profile.host, port: profile.port, username: profile.username, authKind: profile.authKind, fingerprint: profile.fingerprint, password: '', privateKey: '', passphrase: '' } : { id: '', name: '', host: '', port: 22, username: '', authKind: 'privateKey', fingerprint: '', password: '', privateKey: '', passphrase: '' }
  hostDialog.value = true
}
async function saveRegistry(verify = false): Promise<void> {
  registryError.value = ''
  await execute('保存仓库', async () => {
    const input: RegistryInput = { ...registryForm.value, repositories: repositoryPaths.value.split('\n').map(value => value.trim()).filter(Boolean),
      aliyun: aliyunEnabled.value ? { regionId: aliyunRegion.value.trim(), accessKeyId: accessKeyId.value.trim(), accessKeySecret: accessKeySecret.value.trim() } : null }
    const saved = await api.saveRegistry(input)
    registryForm.value.id = saved.id
    registryForm.value.password = ''; clearManagementKeys()
    await loadProfiles()
    if (verify) {
      const catalog = await api.registryCatalog(saved.id)
      if (catalog.mode === 'tracked') throw new Error(catalog.notice || '当前连接尚不能自动读取目录')
      ElMessage.success(`目录验证成功：${catalog.namespaces?.length ?? 0} 个命名空间、${catalog.repositories.length} 个镜像仓库`)
    } else ElMessage.success('仓库凭据已加密保存')
    registryDialog.value = false
  })
}
async function saveHost(): Promise<void> {
  await execute('保存主机', async () => { await api.saveHost({ ...hostForm.value }); hostDialog.value = false; hostForm.value.password = ''; hostForm.value.privateKey = ''; hostForm.value.passphrase = ''; await loadProfiles(); ElMessage.success('主机已保存') })
}
async function checkFingerprint(): Promise<void> {
  await execute('获取指纹', async () => {
    const fingerprint = await api.fingerprint(hostForm.value.host, hostForm.value.port)
    await ElMessageBox.confirm(`收到主机指纹：\n${fingerprint}\n请通过腾讯云控制台或可信终端独立核对。确认与真实服务器一致后才保存。`, '核对 SSH 主机身份', { confirmButtonText: '已独立核对，一致', cancelButtonText: '暂不信任' })
    hostForm.value.fingerprint = fingerprint
  })
}
async function removeProfile(kind: 'host' | 'registry', id: string): Promise<void> {
  await execute('删除配置', async () => { await ElMessageBox.confirm('删除配置及其加密凭据？不会删除服务器或仓库。', '删除配置'); kind === 'host' ? await api.removeHost(id) : await api.removeRegistry(id); await loadProfiles() })
}
</script>
<template>
  <el-card class="connection-settings">
    <template #header><b>仓库与服务器连接</b></template>
    <p class="muted">连接在所有项目中通用，可添加多个镜像仓库和服务器。项目发布时选择对应连接，无需重复填写账号或密码。</p>
    <el-alert v-if="!bridgeReady" type="warning" title="需要完整重启 Project Hub 后管理连接" :closable="false" />
    <el-tabs v-else v-model="tab">
      <el-tab-pane label="仓库账号" name="registries">
        <div class="toolbar"><p class="muted">填写阿里云控制台提供的 Docker 仓库登录地址，支持其他兼容 Docker 的仓库。</p><el-button type="primary" @click="editRegistry()">添加仓库</el-button></div>
        <el-table :data="registries" empty-text="还没有镜像仓库账号"><el-table-column prop="name" label="名称" /><el-table-column prop="server" label="仓库地址" /><el-table-column prop="username" label="用户名" /><el-table-column label="操作" width="250"><template #default="{ row }"><el-button text :disabled="!!busy" @click="execute('登录测试', async () => { ElMessage.success(await api.testRegistry(row.id)) })">登录测试</el-button><el-button text @click="editRegistry(row.id)">编辑</el-button><el-button text type="danger" @click="removeProfile('registry', row.id)">删除</el-button></template></el-table-column></el-table>
      </el-tab-pane>
      <el-tab-pane label="服务器连接" name="hosts">
        <div class="toolbar"><p class="muted">通过 SSH 管理 Linux 主机，无需安装服务器 Agent。</p><div><el-button :disabled="!!busy" @click="execute('导入主机', async () => { const n = await api.importBridgebox(); await loadProfiles(); ElMessage.success(`导入 ${n} 台主机，请重新填写凭据并核对指纹`) })">导入 Bridgebox</el-button><el-button type="primary" @click="editHost()">添加服务器</el-button></div></div>
        <el-table :data="hosts" empty-text="添加腾讯云服务器或导入 Bridgebox 主机"><el-table-column prop="name" label="名称" /><el-table-column prop="host" label="地址" /><el-table-column prop="username" label="用户" /><el-table-column label="身份核验"><template #default="{ row }"><el-tag :type="row.fingerprint && row.hasCredential ? 'success' : 'warning'">{{ row.fingerprint && row.hasCredential ? '已配置' : '待补凭据/指纹' }}</el-tag></template></el-table-column><el-table-column label="操作" width="240"><template #default="{ row }"><el-button text :disabled="!!busy" @click="execute('连接测试', async () => { await api.testHost(row.id); ElMessage.success('SSH / Docker 连接成功') })">测试</el-button><el-button text @click="editHost(row.id)">编辑</el-button><el-button text type="danger" @click="removeProfile('host', row.id)">删除</el-button></template></el-table-column></el-table>
      </el-tab-pane>
    </el-tabs>
    <el-dialog v-model="registryDialog" title="镜像仓库登录" width="560" @closed="registryForm.password = ''; clearManagementKeys()"><el-form label-position="top"><el-form-item label="名称"><el-input v-model="registryForm.name" placeholder="阿里云个人仓库" /></el-form-item><el-form-item label="Docker 仓库地址（不含协议和路径）"><el-input v-model="registryForm.server" placeholder="复制控制台 docker login 的服务器地址" /></el-form-item><el-form-item label="登录用户名"><el-input v-model="registryForm.username" /></el-form-item><el-form-item label="仓库密码（编辑时留空保留）"><el-input v-model="registryForm.password" type="password" show-password autocomplete="new-password" /></el-form-item><el-divider>目录自动读取</el-divider><el-form-item label="查询方式"><el-switch v-model="aliyunEnabled" active-text="阿里云个人版管理 API" inactive-text="Docker 通用目录" /></el-form-item>
      <template v-if="aliyunEnabled">
        <p class="muted">管理 API 用于读取命名空间、镜像仓库和版本，不影响上方 Docker 推拉账号。已创建的 project-hub-registry-reader 仅需 cr:ListNamespace、cr:ListRepository、cr:ListRepositoryTag 三项权限。</p>
        <el-form-item label="实例地域" required><el-input v-model="aliyunRegion" placeholder="例如 cn-hangzhou（华东1 杭州）" /><p class="muted">必须与仓库地址和个人版实例所在地域一致。当前支持阿里云个人版，企业版请保留 Docker 通用连接。</p></el-form-item>
        <el-form-item label="AccessKey ID（编辑时留空保留）"><el-input v-model="accessKeyId" type="password" show-password autocomplete="off" placeholder="填写专用 RAM 用户的 AccessKey ID" /></el-form-item>
        <el-form-item label="AccessKey Secret（编辑时留空保留）"><el-input v-model="accessKeySecret" type="password" show-password autocomplete="new-password" placeholder="与 AccessKey ID 一起填写" /><p class="muted">凭据仅加密保存在本机；保存后不回显。关闭此开关并保存会移除本机管理 API 凭据，不会删除阿里云身份或密钥。</p></el-form-item>
      </template>
      <el-form-item label="镜像路径（可选，每行一个）"><el-input v-model="repositoryPaths" type="textarea" :rows="4" placeholder="team/api&#10;team/web" /><p class="muted">不支持自动目录的云仓库可在此添加路径。镜像页查询成功的路径也会自动保存，供所有项目共用。</p></el-form-item></el-form><p class="muted">使用系统加密存储，不写入项目代码；Docker 登录密码通过标准输入传递。</p><el-alert v-if="registryError" :title="registryError" type="error" :closable="false" show-icon /><template #footer><el-button @click="registryDialog = false">取消</el-button><el-button type="primary" :loading="busy === '保存仓库'" @click="saveRegistry(false)">保存</el-button><el-button v-if="aliyunEnabled" type="primary" :loading="busy === '保存仓库'" @click="saveRegistry(true)">保存并验证目录</el-button></template></el-dialog>
    <el-dialog v-model="hostDialog" title="SSH 主机" width="620" @closed="hostForm.password = ''; hostForm.privateKey = ''; hostForm.passphrase = ''"><el-form label-position="top"><el-form-item label="名称"><el-input v-model="hostForm.name" /></el-form-item><div class="two-columns"><el-form-item label="地址"><el-input v-model="hostForm.host" /></el-form-item><el-form-item label="SSH 端口"><el-input-number v-model="hostForm.port" :min="1" :max="65535" /></el-form-item></div><el-form-item label="SSH 用户"><el-input v-model="hostForm.username" /></el-form-item><el-form-item label="登录方式"><el-radio-group v-model="hostForm.authKind"><el-radio-button value="privateKey">私钥</el-radio-button><el-radio-button value="password">密码</el-radio-button></el-radio-group></el-form-item><el-form-item v-if="hostForm.authKind === 'password'" label="密码（编辑时留空保留）"><el-input v-model="hostForm.password" type="password" show-password autocomplete="new-password" /></el-form-item><template v-else><el-form-item label="SSH 私钥（编辑时不导入则保留）"><el-button :disabled="!!busy" @click="execute('选择私钥', async () => { const key = await api.pickPrivateKey(); if (key) hostForm.privateKey = key })">{{ hostForm.privateKey ? '已选择私钥，重新选择' : '从本机选择私钥文件' }}</el-button></el-form-item><el-form-item label="私钥口令（随新私钥一起保存）"><el-input v-model="hostForm.passphrase" type="password" show-password /></el-form-item></template><el-form-item label="已核对的主机 SHA256 指纹"><el-input v-model="hostForm.fingerprint" placeholder="SHA256:..."><template #append><el-button :disabled="!!busy" @click="checkFingerprint">获取并核对</el-button></template></el-input></el-form-item></el-form><p class="muted">更换服务器地址后需重新核对指纹及输入凭据。Bridgebox 导入不迁移密码/私钥。</p><template #footer><el-button @click="hostDialog = false">取消</el-button><el-button type="primary" :loading="busy === '保存主机'" @click="saveHost">保存</el-button></template></el-dialog>
  </el-card>
</template>
<style scoped>
.connection-settings { min-width: 0; }
h3 { margin: 18px 0 16px; font-size: 15px; }
.toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.two-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.muted { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; }
.console, .metrics { white-space: pre-wrap; overflow-wrap: anywhere; background: #101827; color: #d7e4f4; border-radius: 10px; padding: 16px; font: 12px/1.7 Consolas, monospace; max-height: 440px; overflow: auto; }
.host-picker { justify-content: flex-start; margin-top: 24px; }
@media (max-width: 700px) { .two-columns { grid-template-columns: 1fr; } }
</style>
