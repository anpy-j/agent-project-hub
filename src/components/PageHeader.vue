<script setup lang="ts">
defineProps<{
  title: string
  subtitle?: string
}>()
</script>

<template>
  <header class="page-head">
    <div class="head-left">
      <h1 class="page-title">{{ title }}</h1>
      <p v-if="subtitle || $slots.meta" class="page-sub">
        <span v-if="subtitle">{{ subtitle }}</span>
        <slot name="meta" />
      </p>
    </div>
    <div class="head-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.head-left {
  min-width: 0;
}
</style>
