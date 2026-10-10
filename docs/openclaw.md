# OpenClaw 工作台

入口：侧边栏「AI → OpenClaw」，路由 `/ai/openclaw`。

## 已实现

- 多实例：本机、服务器 SSH 隧道、远程 WSS 直连。
- 本机快捷接入：读取默认 `~/.openclaw/openclaw.json` 的 Gateway 端口和 Token / 密码，定位常见 CLI 安装路径。尊重 `OPENCLAW_STATE_DIR` 和 Gateway 鉴权环境变量。
- 复用「镜像与服务器」中已保存的 SSH 主机、加密凭据和主机指纹；SSH 模式只连接服务器回环 WS 地址。
- Agent 列表、最近 100 个会话、最近 200 条历史消息、新会话、Markdown、复制、流式回复、停止运行、工具活动。
- 执行审批：展示命令，允许一次或拒绝；连接后补取待审批请求，避免列表和事件竞争导致已解决请求复活。
- 页面切换保留会话及连接状态；实例隔离。网络连接断开后有限退避重连，鉴权和配对失败需要手动处理；消息不自动重发。
- 服务状态、启动、停止、重启和日志。通过 CLI 管理已安装的 OpenClaw 系统服务，SSH 模式在远端执行；操作前核对实际 Gateway 端口。停止或重启需在页面确认。
- 在线通过 Gateway 读日志；离线通过 CLI 查询日志路径后读取最近日志。本机最多 200 KB / 200 行；远端取最近 200 行。

## 使用

本机点击「连接本机」。若采用自定义配置、SecretRef 或 JSON5 配置，使用「编辑连接」填写实际地址和凭据。

服务器先在「镜像与服务器」保存 SSH 主机及指纹，再添加 OpenClaw 实例：选择 SSH 主机、服务器回环地址（通常 `ws://127.0.0.1:18789`）、Gateway 凭据。非交互 SSH 找不到 `openclaw` 时填 CLI 绝对路径。

首次设备配对由 OpenClaw 自身的信任策略决定；若要求手动审批，页面显示设备 ID，需在目标 OpenClaw 管理端批准，再重新连接。不会绕过配对或修改 Gateway 鉴权策略。

## 实现边界

当前协议验证版本为 OpenClaw 2026.9.4，使用 Gateway wire protocol 4 和 v3 设备签名。旧协议版本会明确连接失败。

此版本支持标准 CLI 管理的默认系统服务；Docker、自定义 profile / 配置文件、多端口系统服务需后续加入明确的服务绑定。端口不匹配时禁止服务控制。远程直连仅支持 Gateway 功能和在线日志。

本版本仅支持文本消息，历史分页、附件、模型/渠道配置、Skills、定时任务和升级留待后续扩展。

OpenClaw 对话和运行由目标 Gateway 负责，不使用 Project Hub 全局 AI 配置。会话历史以 Gateway 为准，应用仅在内存中保存显示缓存。

## 存储和生命周期

`userData/openclaw-v1.json` 原子保存实例。Token / 密码以及每个实例独立的 Ed25519 身份私钥使用 Electron safeStorage 加密，凭据不暴露到渲染进程；拒绝 Linux basic_text 后端。移除实例仅移除本地连接配置，不删除 Gateway 服务或会话。

WebSocket 和 SSH 在主进程管理，通过受限制 IPC 接口向页面提供数据；应用退出时关闭连接和隧道。

## 验证

- `npm run typecheck`
- `npm run test:openclaw`：签名、密码鉴权、地址校验、并发请求和断开处理。
- `npm run test:openclaw-ui`：真实 Electron 页面、preload、IPC、模拟 Gateway，覆盖对话、审批、页面切换、日志、多连接、SSH 指纹及隧道、远端服务控制、离线日志和凭据加密。
- 可选本机只读验证：`PROJECT_HUB_OPENCLAW_LIVE=1 node tests/run-electron-openclaw-smoke.cjs`。只读取 Agent、会话历史和日志，不发送模型消息，不控制真实服务。测试使用独立临时应用数据目录。
