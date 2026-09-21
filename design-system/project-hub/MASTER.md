# Project Hub — Design System (MASTER)

> 由 ui-ux-pro-max 方法论生成，目标方向取自 `design/ui-v2/*.html` 原型。
> 技术栈：Electron + Vue 3 + Element Plus（桌面端开发工具，密度中高、动效克制）。

## 1. 定位
- 产品类型：Developer Tool / 内部效率工具（桌面端 Electron）
- 关键场景：长会话、键盘操作优先、信息密度较高、浅色为主 + 深色模式一等公民

## 2. 风格
- 关键词：clean minimal、modern dashboard、quiet confidence
- 布局：深色侧边栏 + 浅色画布；卡片白底 12px 圆角；分区靠留白与 1px 线，不靠重投影
- 动效：150–200ms 的 hover/状态过渡，仅微交互（运动传达状态，不做装饰动画）

## 3. 颜色 tokens（唯一来源，组件内禁止裸写 hex）
| Token | 值 | 用途 |
|---|---|---|
| primary | #2563EB | 主操作、选中态、链接 |
| success | #10B981 | 正常/已同步 |
| warning | #F59E0B | 运行中/待同步 |
| danger | #EF4444 | 删除/异常/领先提交 |
| info | #3B82F6 | 中性信息 |
| canvas | #F8FAFC | 页面背景（dark: #0B1220） |
| ink | #0F172A | 侧边栏背景 |
| line | #E2E8F0 | 边框（dark 走 el token） |
| muted | #64748B | 次级文字 |

语义一律通过 `--el-color-*` token 消费；`--el-fill-color-blank` → canvas。

### 双主题
- **默认深色**（与侧边栏同一 slate 色系）：页面 #0B1220，面板 #16213A，hover 面 #1B2840，
  边框 #2B3A55，文字 #E2E8F0 / #CBD5E1 / #94A3B8
- 浅色：canvas #F8FAFC，卡片 #FFFFFF，边框 #E2E8F0
- 侧边栏恒为 ink #0F172A；两种模式下侧边栏与页面共享同一主色与状态色

## 4. 字体
- UI：-apple-system / PingFang SC 栈，正文 13–14px，行高 1.5，页头标题 20–22px/700
- 代码/路径/命令：ui-monospace（SF Mono / Menlo）
- 层级只用 字号+字重+muted 色，不引入额外字族

## 5. 组件规则
- 卡片：radius 12px，border 1px line，shadow `0 8px 30px rgba(0,0,0,.04)`，hover 提升为 lift
- 按钮：radius 8px；主按钮 primary，危险操作不放工具条主位
- 表格：表头 fill-color-light、600 字重、12px；行 hover 可点
- 状态：一律 彩点+文字（success/warn/danger/info），禁止仅靠颜色区分
- 侧边栏：ink 底、slate-400 文字，激活项 = primary/20 底 + 左侧 3px primary 内边线
- 指标卡：图标 48px 圆角 12 容器 + 数值 24–28px/700 + 12px muted 标签

## 6. 反模式（禁止）
- 组件内裸写 hex 色、shadow/圆角各自为政
- emoji 当图标；灰色对灰色低对比文字（对比度 < 4.5:1）
- hover-only 交互（必须同时可点击/可达）
- 宽度/高度动画、>300ms 过渡、无 reduced-motion 降级

## 7. 布局
- 侧边栏固定 216px；主内容 padding 20–24px
- 页头模式：左「标题 + 副说明」右「搜索 + 次按钮 + 主按钮」，全局统一
- 断点：<1280px 指标卡 2 列；<960px 工具条换行
