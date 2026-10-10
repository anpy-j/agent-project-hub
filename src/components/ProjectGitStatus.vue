<script setup lang="ts">
import { computed } from 'vue'
import type { GitSummary } from '../types'

const props = defineProps<{ summary?: GitSummary; error?: string }>()
const emit = defineEmits<{ click: [] }>()
const indicators = computed(() => {
  const changes = props.summary?.changes || []
  return [
    { label: '未提交', count: changes.filter(change => change.status !== '??').length, tone: 'modified', unit: '个文件' },
    { label: '未跟踪', count: changes.filter(change => change.status === '??').length, tone: 'untracked', unit: '个文件' },
    { label: '未推送', count: props.summary?.ahead || 0, tone: 'unpushed', unit: '条提交' }
  ].filter(indicator => indicator.count)
})
const description = computed(() => {
  if (props.error) return `无法读取 Git 状态：${props.error}`
  if (!props.summary) return '正在读取 Git 状态'
  if (!props.summary.isGit) return '未检测到 Git 仓库'
  const detail = indicators.value.map(indicator => `${indicator.label} ${indicator.count} ${indicator.unit}`).join('；') || '没有未提交、未跟踪或待推送的变更'
  return `${detail}。待推送数量依据本地远程引用。点击进入项目详情。`
})
</script>

<template>
  <el-tooltip :content="description" placement="top" :show-after="250">
    <span class="project-git-status" :aria-label="description" role="button" tabindex="0" @click="emit('click')" @keydown.enter="emit('click')" @keydown.space.prevent="emit('click')">
      <span v-if="error" class="git-neutral git-error">状态不可用</span>
      <span v-else-if="!summary" class="git-neutral">读取中…</span>
      <span v-else-if="!summary.isGit" class="git-neutral">无 Git</span>
      <template v-else-if="indicators.length">
        <span v-for="indicator in indicators" :key="indicator.tone" class="git-indicator" :class="indicator.tone"><i />{{ indicator.label }}<b>{{ indicator.count }}</b></span>
      </template>
      <span v-else class="git-neutral git-clean"><i />无变更</span>
    </span>
  </el-tooltip>
</template>

<style scoped>
.project-git-status { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px; min-width: 0; cursor: pointer; }
.git-indicator { display: inline-flex; align-items: center; gap: 4px; padding: 3px 5px; border-radius: 5px; font-size: 10px; line-height: 16px; white-space: nowrap; }
.git-indicator b { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.git-indicator i, .git-clean i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
.modified { color: var(--el-color-warning); background: var(--el-color-warning-light-9); }
.untracked { color: var(--el-color-info); background: var(--el-fill-color); }
.unpushed { color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.git-neutral { display: inline-flex; align-items: center; gap: 5px; color: var(--el-text-color-placeholder); font-size: 11px; white-space: nowrap; }
.git-clean { color: var(--el-text-color-secondary); }
.git-clean i { color: var(--el-color-success); }
.git-error { color: var(--el-color-warning); }
</style>
