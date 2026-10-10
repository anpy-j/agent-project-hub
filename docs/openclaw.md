# OpenClaw 工作台

入口：侧边栏「AI → OpenClaw」，路由 `/ai/openclaw`。

## HTTP 聊天接口（默认）

适用于以下形式的 OpenAI 兼容接口：

```http
POST https://play.anpy.top/v1/chat/completions
Authorization: Bearer <完整 API Key>
Content-Type: application/json

{"model":"openclaw","messages":[{"role":"user","content":"你好"}]}
```

新增实例默认使用 HTTP 接入，填写名称、完整接口地址或 `/v1` 地址、模型名（默认 `openclaw`）和完整 API Key。API Key 字段可填写纯 Key，也兼容 `Bearer ` 前缀。不需要 WebSocket、设备身份或设备配对。

- 普通 JSON 回复和 SSE 流式回复均支持；流式输出可在连接设置关闭。接口不支持流式输出时不自动改模式重发。
- 消息在 Electron 主进程发送，凭据不进入渲染进程，也无需浏览器跨域配置。
- 会话历史保存到本机 SQLite，每个实例和会话独立。启动后可读取本地历史，不会自动访问远端。
- 每次请求发送当前会话的消息上下文，并使用该实例和会话独立的稳定 `user` 字段。OpenClaw 原生 HTTP 接口可据此保持服务端会话；其他兼容代理可能忽略该字段。
- 支持停止回复、保留已接收的部分内容。响应中途断开、鉴权失败或服务端报错不会自动重发。应用关闭时中断的请求在历史中提示，不自动续发。
- 「接口已配置」仅表示本地配置已保存；收到有效回复后显示「接口已验证」。点击「测试接口」会发送一条“请只回复 OK”的普通请求，不加入对话历史。
- HTTP 接口不提供 Gateway Agent 列表、服务端会话列表或结构化执行审批。页面显示的是本机保存的会话。

服务管理是可选的独立绑定：可以仅聊天，也可以在「编辑连接」中绑定本机 CLI 或已保存的 SSH 主机，并指定受管理服务端口（默认 18789）。绑定管理不改变 HTTP 聊天地址，也不会建立聊天 WebSocket。

## Gateway 接入（可选）

保留本机 Gateway、服务器 SSH 隧道和远程 WSS 三种方式。

- 本机快捷接入读取默认 `~/.openclaw/openclaw.json` 的 Gateway 端口和 Token / 密码，并定位常见 CLI 路径。支持 `OPENCLAW_STATE_DIR` 和鉴权环境变量；JSON5、自定义配置和 SecretRef 可手动填写。
- SSH 复用「镜像与服务器」中保存的主机、凭据和主机指纹，仅转发服务器回环 WS 地址。
- Gateway 提供 Agent 列表、最近 100 个会话、最近 200 条历史、流式对话、停止运行、工具活动和执行审批。
- 默认申请 `operator.read`、`operator.write`、`operator.approvals`。在「编辑连接 → 申请的管理权限」中可勾选配置管理 `operator.admin`、设备配对管理 `operator.pairing`。
- 新增 scope 后，保存并重新连接，可能出现新的服务端设备审批请求。页面展示 `hello.auth.scopes` 中实际授予的范围；不会把申请范围当作已授予范围，也不会自行批准权限。
- 首次配对及权限升级由 OpenClaw 自身信任策略决定。若要求手动批准，页面显示设备 ID，需在目标 OpenClaw 端批准，再重新连接。
- 当前验证版本 OpenClaw 2026.9.4，使用 wire protocol 4 和 v3 设备签名。旧协议版本会明确连接失败。

共享 Token / 密码鉴权的原生 HTTP 接口与设备 WebSocket 的 scopes 规则不同。当前 OpenClaw 官方规则中，原生 HTTP 共享密钥鉴权恢复默认 operator 权限集；反向代理、自定义 API Key 或身份鉴权可能另有规则。页面不假定 HTTP 代理一定授予管理员权限。[官方 operator scopes 文档](https://docs.openclaw.ai/gateway/operator-scopes)

## 服务管理与实现边界

通过已安装的 OpenClaw CLI 管理默认系统服务：状态、启动、停止、重启和日志。本机执行 CLI，服务器通过 SSH 执行。操作前核对实际 Gateway 服务端口与绑定端口，防止操作到其他服务。停止或重启在页面确认。

Gateway 在线日志通过 RPC 读取；离线或 HTTP 管理绑定通过 CLI 查询日志，必要时根据状态返回的日志路径读取最近 200 行。本机文件读取上限 200 KB。

Docker、自定义 profile / 配置文件及多端口系统服务尚未接入。配置管理和配对管理复选框只负责 Gateway 连接权限申请；完整配置编辑器和设备列表页面尚未提供。

本版本支持文本消息、Markdown 和复制。附件、历史分页、模型/渠道配置、Skills、定时任务和升级留待后续。

## 存储与退出

`userData/openclaw-v1.json` 原子保存连接配置，Token / 密码和设备私钥使用 Electron safeStorage 加密，拒绝 Linux basic_text 后端。HTTP 模式不创建设备私钥。

HTTP 历史在 `openclaw_http_sessions` 表中保存；Gateway 历史以服务器为准，仅在内存缓存。移除实例不删除服务端内容或本地已有对话数据。

所有网络操作在主进程通过受限制 IPC 提供，应用退出时关闭连接、隧道和在途 HTTP 请求。

## 验证

- `npm run typecheck`
- `npm run test:openclaw`：设备签名、管理权限签名、密码鉴权、地址校验、请求相关性；HTTP 请求格式、JSON 回复、分片 SSE、UTF-8、服务端错误和停止请求。
- `npm run test:openclaw-ui`：真实 Electron 页面、preload、IPC 与模拟 Gateway/HTTP 服务，覆盖权限勾选及实际 scopes 展示、会话切换、流式对话、审批、SSH、服务控制、本地历史恢复、HTTP 会话隔离、停止、失败不重发和凭据加密。
- 可选本机 Gateway 只读验证：`PROJECT_HUB_OPENCLAW_LIVE=1 node tests/run-electron-openclaw-smoke.cjs`。不使用用户 HTTP API Key，不给真实 Gateway 发模型消息，不控制真实服务。

## 默认模型管理

管理页从目标主机执行 `openclaw models list --json`，显示已配置模型和默认模型；仅允许切换到列表中可用的模型。通过 `openclaw models set <model>` 修改服务端默认模型，并重新读取列表确认结果。不改 HTTP 请求的 `model: openclaw` 对话入口。

支持本机、SSH，以及绑定本机/SSH 的 HTTP 实例，不需要 Gateway 管理权限。HTTP 仅配置聊天接口、远程 Gateway 直连时，需要先配置 CLI 管理连接。读取与切换都会核对目标服务端口，管理操作按实例互斥。模型切换不会重置已有会话的模型覆盖或 Agent 独立配置。

### Gateway 模型管理

WSS/WS Gateway 已连接时，通过受限模型管理 IPC 在主进程调用 `config.get`、`models.list`（configured）和 `config.patch`。需要服务端实际授予 `operator.admin`，无需 SSH。只传回模型名称、引用、可用性和默认模型，不将整份配置传给页面。切换会再次读取配置与模型列表，只提交默认模型 primary 字段，并携带 config.get 的 hash 防止覆盖并发配置修改；保留回退模型和其他配置。Gateway 可能按配置变更安排重连，已固定模型的会话不变。
