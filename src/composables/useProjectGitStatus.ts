import { onActivated, onDeactivated, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { GitSummary, Project } from '../types'

export function useProjectGitStatus(projects: Readonly<Ref<Project[]>>) {
  const summaries = ref<Record<string, GitSummary | undefined>>({})
  const errors = ref<Record<string, string>>({})
  type Subscription = { id: string; path: string; token: string; dirty: boolean; running: boolean }
  const subscriptions = new Map<string, Subscription>()
  let active = false
  let running = 0
  let unsubscribe: (() => void) | undefined

  function drain() {
    if (!active) return
    for (const subscription of subscriptions.values()) {
      if (running >= 4) break
      if (!subscription.dirty || subscription.running) continue
      subscription.dirty = false
      subscription.running = true
      running++
      void window.api.git.summary(subscription.id).then(summary => {
        if (subscriptions.get(subscription.id) !== subscription) return
        summaries.value[subscription.id] = summary
        delete errors.value[subscription.id]
      }).catch(error => {
        if (subscriptions.get(subscription.id) === subscription) errors.value[subscription.id] = String(error?.message || error)
      }).finally(() => { running--; subscription.running = false; drain() })
    }
  }

  function refresh(id?: string) {
    if (!active) return
    for (const subscription of subscriptions.values()) {
      if (!id || subscription.id === id) subscription.dirty = true
    }
    drain()
  }

  function reconcile() {
    if (!active) return
    const wanted = new Map(projects.value.map(project => [project.id, project]))
    for (const [id, subscription] of subscriptions) {
      if (wanted.get(id)?.path === subscription.path) continue
      subscriptions.delete(id)
      delete summaries.value[id]
      delete errors.value[id]
      void window.api.git.unwatch(subscription.token).catch(() => {})
    }
    for (const project of wanted.values()) {
      if (subscriptions.has(project.id)) continue
      const subscription = { id: project.id, path: project.path, token: crypto.randomUUID(), dirty: false, running: false }
      subscriptions.set(project.id, subscription)
      void window.api.git.watch(project.id, subscription.token).catch(() => {
        // 监听不可用的目录仍可在进入列表或切回窗口时读取状态。
      }).finally(() => {
        if (subscriptions.get(project.id) === subscription) refresh(project.id)
      })
    }
  }

  function onVisible() { if (document.visibilityState === 'visible') refresh() }
  function start() {
    if (active) return
    active = true
    unsubscribe = window.api.git.onChanged(event => {
      if (subscriptions.get(event.id)?.token === event.token) refresh(event.id)
    })
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    reconcile()
  }
  function onFocus() { refresh() }
  function stop() {
    active = false
    unsubscribe?.()
    unsubscribe = undefined
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onVisible)
    for (const subscription of subscriptions.values()) void window.api.git.unwatch(subscription.token).catch(() => {})
    subscriptions.clear()
  }
  watch(() => projects.value.map(project => `${project.id}:${project.path}`).join('\n'), reconcile)
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onUnmounted(stop)
  return { summaries, errors }
}
