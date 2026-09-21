<script setup lang="ts">
import { ref, nextTick } from 'vue'
import type { ServiceLogChunk } from '../types'

const visible = ref(false)
const logs = ref<{ stream: 'stdout' | 'stderr'; text: string; ts: number }[]>([])
const serviceId = ref<string>('')
const serviceName = ref<string>('')
const logBodyRef = ref<HTMLElement | null>(null)

function attach(id: string, name: string) {
  serviceId.value = id
  serviceName.value = name
  logs.value = []
  visible.value = true
  nextTick(scrollToBottom)
}

function show() {
  visible.value = true
}

function append(chunk: ServiceLogChunk) {
  if (!visible.value || chunk.serviceId !== serviceId.value) return
  logs.value.push({ stream: chunk.stream, text: chunk.data, ts: chunk.timestamp })
  if (logs.value.length > 5000) logs.value.splice(0, 1000)
  nextTick(scrollToBottom)
}

async function loadHistory() {
  if (!serviceId.value) return
  const text = await window.api.service.readLog(serviceId.value)
  logs.value = [{ stream: 'stdout', text, ts: Date.now() }]
  nextTick(scrollToBottom)
}

async function clearHistory() {
  if (!serviceId.value) return
  await window.api.service.clearLog(serviceId.value)
  logs.value = []
}

function scrollToBottom() {
  if (logBodyRef.value) logBodyRef.value.scrollTop = logBodyRef.value.scrollHeight
}

defineExpose({ attach, show, append, loadHistory })
</script>

<template>
  <el-drawer
    v-model="visible"
    :title="serviceName ? `服务日志 - ${serviceName}` : '服务日志'"
    direction="btt"
    size="45%"
  >
    <div class="log-toolbar">
      <el-button size="small" @click="loadHistory">加载历史日志</el-button>
      <el-button size="small" @click="logs = []">清空显示</el-button>
      <el-button size="small" text type="danger" @click="clearHistory">删除日志文件</el-button>
      <span class="log-count muted">{{ logs.length }} 行</span>
    </div>
    <div ref="logBodyRef" class="log-body terminal">
      <div
        v-for="(line, i) in logs"
        :key="i"
        :class="line.stream"
      >{{ line.text }}</div>
      <div v-if="!logs.length" class="terminal-empty">暂无日志输出</div>
    </div>
  </el-drawer>
</template>

<style scoped>
.log-toolbar {
  margin-bottom: 8px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.log-count {
  margin-left: auto;
  font-size: 12px;
}
.log-body {
  height: calc(100% - 44px);
}
</style>
