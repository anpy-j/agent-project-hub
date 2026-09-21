<script setup lang="ts">
type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'info'

defineProps<{
  items: { label: string; value: string | number; icon: string; tone: Tone }[]
}>()
</script>

<template>
  <div class="stat-grid">
    <div v-for="s in items" :key="s.label" class="stat-card">
      <div class="stat-icon" :class="'tone-' + s.tone">
        <el-icon :size="18"><component :is="s.icon" /></el-icon>
      </div>
      <div class="stat-body">
        <div class="stat-num">{{ s.value }}</div>
        <div class="stat-label">{{ s.label }}</div>
      </div>
    </div>
  </div>
</template>
