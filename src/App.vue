<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useWorkspaceStore } from './stores/workspace'
import { emitHotkey } from './composables/hotkeys'

const route = useRoute()
const router = useRouter()
const workspaceStore = useWorkspaceStore()
workspaceStore.load()

const navItems = [
  { path: '/projects', label: '项目', icon: 'Folder' },
  { path: '/services', label: '服务管理', icon: 'Odometer' },
  { path: '/settings', label: '设置', icon: 'Setting' }
]

function isActive(path: string): boolean {
  if (path === '/projects') return route.path === '/projects' || route.path.startsWith('/projects/')
  return route.path === path
}

/* ---------- 深色模式（默认深色，与侧边栏同色系） ---------- */
const THEME_KEY = 'project-hub.theme'
const isDark = ref(localStorage.getItem(THEME_KEY) !== 'light')

function applyTheme(dark: boolean): void {
  isDark.value = dark
  document.documentElement.classList.toggle('dark', dark)
  localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light')
}

function toggleTheme(): void {
  applyTheme(!isDark.value)
}

applyTheme(isDark.value)

/* ---------- 全局快捷键 ---------- */
const helpVisible = ref(false)

const shortcuts = [
  { keys: '⌘/Ctrl + K', desc: '聚焦项目搜索' },
  { keys: '⌘/Ctrl + N', desc: '添加项目' },
  { keys: '⌘/Ctrl + 1', desc: '前往项目列表' },
  { keys: '⌘/Ctrl + ,', desc: '前往设置' },
  { keys: '?', desc: '显示快捷键帮助' },
  { keys: 'Esc', desc: '关闭弹窗 / 抽屉' }
]

function isEditableTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

function onKeyDown(e: KeyboardEvent): void {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    emitHotkey('focus-search')
    return
  }
  if (mod && e.key.toLowerCase() === 'n') {
    e.preventDefault()
    emitHotkey('new-project')
    return
  }
  if (mod && e.key === '1') {
    e.preventDefault()
    router.push('/projects')
    return
  }
  if (mod && e.key === ',') {
    e.preventDefault()
    router.push('/settings')
    return
  }
  if (e.key === '?' && !isEditableTarget(e)) {
    e.preventDefault()
    helpVisible.value = true
  }
}

onMounted(() => window.addEventListener('keydown', onKeyDown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <div class="app-shell">
    <aside class="app-side">
      <div class="brand">
        <span class="brand-icon"><el-icon :size="18"><Cpu /></el-icon></span>
        <span class="brand-name">Project Hub</span>
      </div>
      <nav class="side-nav">
        <div
          v-for="item in navItems"
          :key="item.path"
          :class="['nav-item', { active: isActive(item.path) }]"
          role="link"
          :tabindex="0"
          @click="router.push(item.path)"
          @keydown.enter="router.push(item.path)"
        >
          <el-icon :size="16"><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </div>
      </nav>
      <div class="side-foot">
        <el-select
          v-if="workspaceStore.list.length"
          v-model="workspaceStore.currentId"
          placeholder="选择工作区"
          size="default"
          popper-class="side-select-popper"
          class="ws-select"
          @change="workspaceStore.persist"
        >
          <template #prefix><el-icon><Collection /></el-icon></template>
          <el-option
            v-for="ws in workspaceStore.list"
            :key="ws.id"
            :label="ws.name"
            :value="ws.id"
          />
        </el-select>
        <div class="foot-row">
          <el-tooltip content="深色 / 浅色模式" placement="top">
            <button class="foot-btn" type="button" @click="toggleTheme">
              <el-icon :size="16"><component :is="isDark ? 'Sunny' : 'Moon'" /></el-icon>
            </button>
          </el-tooltip>
          <el-tooltip content="快捷键帮助（?）" placement="top">
            <el-button text class="foot-btn" @click="helpVisible = true">
              <el-icon :size="16"><QuestionFilled /></el-icon>
            </el-button>
          </el-tooltip>
        </div>
      </div>
    </aside>
    <el-main class="app-main">
      <router-view v-slot="{ Component }">
        <transition name="page-fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </el-main>

    <el-dialog v-model="helpVisible" title="键盘快捷键" width="420">
      <div class="shortcut-list">
        <div v-for="s in shortcuts" :key="s.keys" class="shortcut-row">
          <span class="kbd">{{ s.keys }}</span>
          <span class="desc">{{ s.desc }}</span>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
}
.app-side {
  width: 216px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--ph-ink);
  padding: 18px 12px 14px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px 16px;
}
.brand-icon {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--el-color-primary) 22%, transparent);
  color: #93c5fd;
}
.brand-name {
  color: #fff;
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.01em;
}
nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 8px;
  font-size: 13.5px;
  color: #94a3b8;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background-color 0.15s ease, color 0.15s ease;
  user-select: none;
}
.nav-item:hover {
  color: #e2e8f0;
  background: rgba(255, 255, 255, 0.06);
}
.nav-item.active {
  background: color-mix(in srgb, var(--el-color-primary) 24%, transparent);
  color: #fff;
  box-shadow: inset 3px 0 0 var(--el-color-primary);
  font-weight: 600;
}
.side-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 4px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.ws-select {
  width: 100%;
}
.ws-select :deep(.el-select__wrapper) {
  background: rgba(255, 255, 255, 0.06);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12) inset;
  color: #e2e8f0;
}
.ws-select :deep(.el-select__placeholder),
.ws-select :deep(.el-select__selected-item) {
  color: #e2e8f0;
}
.ws-select :deep(.el-select__caret) {
  color: #94a3b8;
}
.foot-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.foot-btn,
.foot-row .el-button {
  color: #94a3b8;
}
.foot-row .el-button:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.08);
}
.app-main {
  flex: 1;
  min-width: 0;
  padding: 0;
  background: var(--ph-canvas);
  overflow: hidden;
}
.shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.shortcut-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.shortcut-row .kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: var(--el-fill-color);
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  padding: 3px 8px;
  color: var(--el-text-color-regular);
  white-space: nowrap;
}
.shortcut-row .desc {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
</style>

<style>
/* 侧边栏内下拉面板保持深色观感 */
.side-select-popper.el-popper {
  background: #1e293b;
  border: 1px solid rgba(255, 255, 255, 0.12) !important;
}
.side-select-popper .el-select-dropdown__item {
  color: #cbd5e1;
}
.side-select-popper .el-select-dropdown__item.is-hovering {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}
.side-select-popper .el-select-dropdown__item.is-selected {
  color: #60a5fa;
  font-weight: 600;
}
.side-select-popper .el-popper__arrow::before {
  background: #1e293b;
  border-color: rgba(255, 255, 255, 0.12) !important;
}

/* 页面切换微动效（150ms，可访问性降级见 theme.css） */
.page-fade-enter-active,
.page-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.page-fade-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.page-fade-leave-to {
  opacity: 0;
}
</style>
