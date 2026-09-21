import { Notification, BrowserWindow } from 'electron'

/**
 * 系统级通知。
 * 仅在窗口不可见 / 未聚焦时发送——前台时页内已有 ElMessage/ElNotification 提示，
 * 避免同一事件弹两次。
 */
export function notify(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return
    const wins = BrowserWindow.getAllWindows()
    const foreground = wins.some((w) => !w.isDestroyed() && w.isFocused())
    if (foreground) return
    new Notification({ title, body, silent: false }).show()
  } catch {
    // 通知失败不影响主流程
  }
}
