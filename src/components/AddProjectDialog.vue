<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { DetectResult, Project, ProjectType, SubProject } from '../types'

const props = defineProps<{
  visible: boolean
  workspaceId: string
}>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'added', p: Project): void
}>()

const form = ref({
  path: '',
  name: '',
  type: '' as ProjectType | '',
  framework: '' as string | null,
  description: ''
})
const detecting = ref(false)
const detectResult = ref<DetectResult | null>(null)
const remotes = ref<Array<{ name: string; url: string; platform?: string; is_default: number }>>([])
const newRemote = ref({ name: '', url: '' })
const submitting = ref(false)

watch(
  () => props.visible,
  (v) => {
    if (v) {
      form.value = { path: '', name: '', type: '', framework: '', description: '' }
      detectResult.value = null
      remotes.value = []
      newRemote.value = { name: '', url: '' }
    }
  }
)

async function pickDir() {
  const dir = await window.api.system.pickDirectory()
  if (dir) {
    form.value.path = dir
    await detect()
  }
}

async function detect() {
  if (!form.value.path) return
  detecting.value = true
  try {
    const result = await window.api.project.detect(form.value.path)
    applyDetectResult(result)
  } catch (e) {
    ElMessage.error(`识别失败: ${(e as Error).message}`)
  } finally {
    detecting.value = false
  }
}

function applyDetectResult(result: DetectResult) {
  detectResult.value = result
  form.value.name = result.suggestedName
  form.value.type = result.type
  form.value.framework = result.framework
  if (remotes.value.length === 0 && result.remotes.length) {
    remotes.value = result.remotes.map((r) => ({
      name: r.name,
      url: r.url,
      platform: r.platform,
      is_default: r.is_default
    }))
  }
}

function selectSubProject(sub: SubProject) {
  form.value.path = sub.path
  detectResult.value = detectResult.value
    ? { ...detectResult.value, type: sub.type, framework: sub.framework, suggestedName: sub.name, subProjects: undefined }
    : { type: sub.type, framework: sub.framework, suggestedName: sub.name, isGit: false, branch: null, remotes: [], subProjects: undefined }
  form.value.name = sub.name
  form.value.type = sub.type
  form.value.framework = sub.framework
  ElMessage.info(`已选择子项目: ${sub.name}`)
}

const typeLabel: Record<string, string> = {
  'java-maven': 'Java·Maven',
  'java-gradle': 'Java·Gradle',
  python: 'Python',
  flutter: 'Flutter',
  vue: 'Vue',
  react: 'React',
  node: 'Node',
  unknown: '未知'
}

const typeOptions = [
  { label: 'Java · Maven', value: 'java-maven' },
  { label: 'Java · Gradle', value: 'java-gradle' },
  { label: 'Python', value: 'python' },
  { label: 'Flutter', value: 'flutter' },
  { label: 'Vue', value: 'vue' },
  { label: 'React', value: 'react' },
  { label: 'Node', value: 'node' },
  { label: '未知', value: 'unknown' }
]

const platformLabel: Record<string, string> = {
  github: 'GitHub',
  gitee: 'Gitee',
  gitlab: 'GitLab',
  other: 'Git'
}

function addRemote() {
  const url = newRemote.value.url.trim()
  if (!url) {
    ElMessage.warning('请填写仓库地址')
    return
  }
  remotes.value.push({
    name: newRemote.value.name.trim() || (remotes.value.length === 0 ? 'origin' : `remote-${remotes.value.length}`),
    url: url.trim(),
    platform: undefined,
    is_default: remotes.value.length === 0 ? 1 : 0
  })
  newRemote.value = { name: '', url: '' }
}

function removeRemote(r: { url: string }) {
  remotes.value = remotes.value.filter((x) => x.url !== r.url)
}

async function submit() {
  if (!form.value.path) {
    ElMessage.warning('请选择项目路径')
    return
  }
  if (!form.value.name) {
    ElMessage.warning('请填写项目名称')
    return
  }
  submitting.value = true
  try {
    // Vue 响应式 Proxy 无法被 IPC structured clone，必须深拷贝为纯对象
    const payload = JSON.parse(
      JSON.stringify({
        workspace_id: props.workspaceId,
        name: form.value.name,
        path: form.value.path,
        type: form.value.type || 'unknown',
        framework: form.value.framework || null,
        description: form.value.description || null,
        remotes: remotes.value
      })
    )
    const project = await window.api.project.add(payload)
    emit('added', project)
    emit('update:visible', false)
    ElMessage.success('已添加')
  } catch (e) {
    ElMessage.error(`添加失败: ${(e as Error).message}`)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="添加项目"
    width="560px"
    class="ph-dialog"
    align-center
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:visible', v)"
  >
    <el-form :model="form" label-width="90px">
      <el-form-item label="项目路径" required>
        <div class="path-row">
          <el-input v-model="form.path" placeholder="选择本地项目目录" clearable />
          <el-button @click="pickDir">浏览</el-button>
          <el-button :loading="detecting" @click="detect">识别</el-button>
        </div>
      </el-form-item>
      <el-form-item v-if="detectResult" label="识别结果">
        <div class="detect-chips">
          <span class="chip is-ok">{{ typeLabel[detectResult.type] || detectResult.type }}</span>
          <span v-if="detectResult.framework" class="type-chip">{{ detectResult.framework }}</span>
          <span v-if="detectResult.isGit" class="type-chip">
            git · {{ detectResult.branch || '未知分支' }}
          </span>
        </div>
      </el-form-item>
      <el-form-item label="Git 仓库">
        <div class="remotes-box">
          <div v-if="remotes.length === 0" class="sub-tip">
            未关联远程仓库。选择本地目录点「识别」会自动读取该仓库的 remote；也可在下方手动添加。
          </div>
          <div v-for="(r, i) in remotes" :key="r.url + i" class="remote-item row-card">
            <span class="type-chip">{{ r.name }}<template v-if="r.is_default"> · 默认</template></span>
            <span v-if="r.platform" class="type-chip">{{ platformLabel[r.platform] || r.platform }}</span>
            <span class="remote-url">{{ r.url }}</span>
            <el-button size="small" text type="danger" @click="remotes.splice(i, 1)">移除</el-button>
          </div>
          <div class="remote-add">
            <el-input v-model="newRemote.name" placeholder="名称(origin)" style="width: 110px" />
            <el-input v-model="newRemote.url" placeholder="git@github.com:you/repo.git" />
            <el-button @click="addRemote">添加关联</el-button>
          </div>
        </div>
      </el-form-item>
      <el-form-item
        v-if="detectResult?.subProjects?.length"
        label="子项目"
      >
        <div class="sub-projects">
          <div class="sub-tip">检测到以下子项目，点击可切换为该子项目：</div>
          <div
            v-for="sub in detectResult.subProjects"
            :key="sub.path"
            class="sub-item row-card"
            @click="selectSubProject(sub)"
          >
            <el-icon><FolderOpened /></el-icon>
            <span class="sub-name">{{ sub.name }}</span>
            <span class="type-chip">{{ typeLabel[sub.type] || sub.type }}</span>
            <span v-if="sub.framework" class="type-chip">{{ sub.framework }}</span>
          </div>
        </div>
      </el-form-item>
      <el-form-item label="项目名称" required>
        <el-input v-model="form.name" placeholder="给项目起个名" />
      </el-form-item>
      <el-form-item label="项目类型">
        <el-select v-model="form.type" placeholder="可手动修正">
          <el-option
            v-for="opt in typeOptions"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="描述">
        <el-input v-model="form.description" type="textarea" :rows="2" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">添加</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
:deep(.ph-dialog) {
  border-radius: 14px;
}
:deep(.ph-dialog .el-dialog__header) {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
:deep(.ph-dialog .el-dialog__body) {
  padding-top: 16px;
  max-height: 60vh;
  overflow-y: auto;
}
.path-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.path-row .el-input {
  flex: 1;
}
.detect-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.remotes-box {
  width: 100%;
}
.remote-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  margin-bottom: 6px;
  width: 100%;
}
.remote-url {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.remote-add {
  display: flex;
  gap: 8px;
  width: 100%;
}
.sub-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}
.sub-projects {
  width: 100%;
}
.sub-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  margin-bottom: 6px;
  cursor: pointer;
  width: 100%;
}
.sub-name {
  flex: 1;
  font-weight: 500;
}
</style>
