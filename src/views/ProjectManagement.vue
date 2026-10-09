<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()
const activeModule = computed({
  get: () => route.name === 'services' ? 'services' : 'projects',
  set: (module: string) => {
    router.push(module === 'services' ? '/projects/services' : '/projects')
  }
})
</script>

<template>
  <div class="page project-management-page">
    <el-tabs v-model="activeModule" class="module-tabs">
      <el-tab-pane name="projects">
        <template #label>
          <span class="module-label"><el-icon><Folder /></el-icon>项目模块</span>
        </template>
      </el-tab-pane>
      <el-tab-pane name="services">
        <template #label>
          <span class="module-label"><el-icon><Odometer /></el-icon>服务模块</span>
        </template>
      </el-tab-pane>
    </el-tabs>
    <router-view v-slot="{ Component }">
      <KeepAlive>
        <component :is="Component" class="management-module" />
      </KeepAlive>
    </router-view>
  </div>
</template>

<style scoped>
.project-management-page {
  box-sizing: border-box;
  min-height: 0;
  overflow: hidden;
}
.module-tabs {
  flex-shrink: 0;
}
.module-tabs :deep(.el-tabs__header) {
  margin-bottom: 12px;
}
.module-tabs :deep(.el-tabs__content) {
  display: none;
}
.module-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.management-module {
  flex: 1;
  min-height: 0;
  height: auto;
  padding: 0;
  overflow: auto;
}
</style>
