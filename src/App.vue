<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useWorkspaceStore } from './stores/workspace'
import { emitHotkey } from './composables/hotkeys'

const route = useRoute()
const router = useRouter()
const workspaceStore = useWorkspaceStore()
workspaceStore.load()

const isMac = navigator.userAgent.includes('Mac')

const navGroups = [
  {
    label: '工作台',
    items: [
      { path: '/projects', label: '项目总览', icon: 'Folder' },
      { path: '/services', label: '本机服务', icon: 'Odometer' }
    ]
  },
  {
    label: '系统',
    items: [{ path: '/settings', label: '全局设置', icon: 'Setting' }]
  }
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
    <!-- 自绘标题栏（macOS 交通灯留位） -->
    <header class="app-titlebar" :class="{ 'is-mac': isMac }">
      <span class="tb-title">Project Hub</span>
      <span class="tb-sub">本地项目管家</span>
    </header>

    <div class="app-body">
      <aside class="app-side">
        <div class="brand">
          <span class="brand-icon"><el-icon :size="17"><Cpu /></el-icon></span>
          <span class="brand-text">
            <span class="brand-name">Project Hub</span>
            <span class="brand-sub">Developer Workspace</span>
          </span>
        </div>

        <nav class="side-nav">
          <template v-for="g in navGroups" :key="g.label">
            <div class="nav-label">{{ g.label }}</div>
            <button
              v-for="item in g.items"
              :key="item.path"
              type="button"
              :class="['nav-item', { active: isActive(item.path) }]"
              @click="router.push(item.path)"
            >
              <el-icon :size="16"><component :is="item.icon" /></el-icon>
              <span>{{ item.label }}</span>
            </button>
          </template>
        </nav>

        <div class="side-foot">
          <div class="side-card">
            <span class="side-card-label">当前工作区</span>
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
            <span v-else class="side-empty">暂无工作区</span>
          </div>

          <div class="foot-row">
            <el-tooltip content="深色 / 浅色模式" placement="top">
              <button class="foot-btn" type="button" @click="toggleTheme">
                <el-icon :size="15"><component :is="isDark ? 'Sunny' : 'Moon'" /></el-icon>
                <span>{{ isDark ? '浅色' : '深色' }}</span>
              </button>
            </el-tooltip>
            <el-tooltip content="快捷键帮助（?）" placement="top">
              <button class="foot-btn" type="button" @click="helpVisible = true">
                <el-icon :size="15"><QuestionFilled /></el-icon>
                <span>帮助</span>
              </button>
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
    </div>

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
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--ph-canvas);
}

/* ---------- 自绘标题栏 ---------- */
.app-titlebar {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--ph-ink);
  -webkit-app-region: drag;
  user-select: none;
  position: relative;
}
.app-titlebar.is-mac {
  padding-left: 78px;
}
.tb-title {
  font-size: 12px;
  font-weight: 600;
  color: #cbd5e1;
  letter-spacing: 0.01em;
}
.tb-sub {
  font-size: 11px;
  color: #5c6780;
}
.tb-sub::before {
  content: '— ';
}

.app-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

/* ---------- 侧边栏 ---------- */
.app-side {
  width: var(--ph-side-w, 232px);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--ph-ink);
  padding: 14px 12px 14px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px 18px;
}
.brand-icon {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(140deg, var(--ph-accent), var(--ph-primary-strong));
  color: #fff;
  flex-shrink: 0;
  box-shadow: 0 4px 12px rgba(79, 70, 229, 0.35);
}
.brand-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.brand-name {
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  line-height: 1.2;
  letter-spacing: 0.01em;
}
.brand-sub {
  color: #5c6780;
  font-size: 10.5px;
  line-height: 1.5;
  letter-spacing: 0.04em;
}

.side-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #4c5670;
  padding: 12px 12px 6px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  border-radius: 9px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  color: var(--ph-side-fg);
  background: transparent;
  cursor: pointer;
  transition: background-color var(--ph-dur) var(--ph-ease), color var(--ph-dur) var(--ph-ease);
  user-select: none;
}
.nav-item:hover {
  color: var(--ph-side-fg-strong);
  background: var(--ph-side-hover);
}
.nav-item:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--el-color-primary) 55%, transparent);
  outline-offset: 1px;
}
.nav-item.active {
  background: var(--ph-side-active);
  color: #fff;
  box-shadow: inset 3px 0 0 var(--ph-accent);
}

.side-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--ph-side-line);
}
.side-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--ph-side-line);
}
.side-card-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #4c5670;
}
.side-empty {
  font-size: 12px;
  color: #5c6780;
}
.ws-select {
  width: 100%;
}
.ws-select :deep(.el-select__wrapper) {
  background: rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
  color: #e2e8f0;
  border-radius: 8px;
  min-height: 30px;
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
  gap: 6px;
}
.foot-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: #8b93a7;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--ph-dur) var(--ph-ease), color var(--ph-dur) var(--ph-ease);
}
.foot-btn:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.08);
}

/* ---------- 主内容区 ---------- */
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
  min-width: 96px;
  text-align: center;
}
.shortcut-row .desc {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
</style>

<style>
/* 侧边栏内下拉面板保持深色观感 */
.side-select-popper.el-popper {
  background: #1a2132;
  border: 1px solid rgba(255, 255, 255, 0.1) !important;
}
.side-select-popper .el-select-dropdown__item {
  color: #cbd5e1;
}
.side-select-popper .el-select-dropdown__item.is-hovering {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}
.side-select-popper .el-select-dropdown__item.is-selected {
  color: #818cf8;
  font-weight: 600;
  background: rgba(99, 102, 241, 0.16);
}
.side-select-popper .el-popper__arrow::before {
  background: #1a2132;
  border-color: rgba(255, 255, 255, 0.1) !important;
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
