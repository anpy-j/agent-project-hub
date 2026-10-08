# Project Hub 本地发布与 Bridgebox 集成

在 Project Hub 左侧打开「镜像与服务器」，或从项目详情点击「镜像发布」。本机直接执行 Docker 构建/上传，通过 SSH 让腾讯云拉取、更新 Compose 应用。无需 GitHub Actions、Jenkins、Kubernetes，也没有接入阿里云管理 API。

按“保留阿里云 Docker 镜像仓库登录和上传，不接云端流水线”实现。使用通用 Docker Registry 协议，可填写阿里云或其他兼容仓库的地址。

## 已迁入的 Bridgebox 能力

- 主机列表，SSH 密码/私钥登录、私钥口令及主机指纹验证。
- Linux CPU 使用率、负载、内存、Swap、根分区指标。
- Docker 容器列表、启动、停止、重启、删除及日志。
- Docker 镜像列表、拉取、删除。
- systemd 服务列表、启动、停止、重启。
- 导入 Bridgebox 的主机元数据（凭据重新配置）。

Bridgebox 使用 Flutter，Project Hub 使用 Electron/Vue，因此迁入的是能力与主机配置格式，未嵌入 Flutter 页面，也未删除或修改原 Bridgebox 项目。手机端 Bridgebox 可以继续独立使用。

## 本地准备

1. 安装并启动 Docker Desktop，使用 Linux 容器。根据服务器 CPU 选择 linux/amd64 或 linux/arm64。跨架构构建需要本机 Docker 支持相应模拟环境。
2. 项目内准备 Dockerfile 和 .dockerignore；排除密钥、.env、.git 和其他不应进入镜像的内容。本功能不替代项目测试，也不会自动生成不同技术栈的 Dockerfile。
   Dockerfile 路径相对项目根目录；构建目录留空时使用 Dockerfile 所在目录，或显式填 `.` 使用项目根目录。`COPY` 和 `.dockerignore` 都按构建目录解析。例如 qianchuan-app 应填写 Dockerfile `server/Dockerfile`，构建目录 `server`（也可留空），这样 `COPY requirements.txt` 会读取 server/requirements.txt，不会发送 Flutter app 和根目录打包归档。
3. 在原项目目录运行 `npm install`，然后 `npm run dev`。此次新增 ssh2、@types/ssh2、tsx。若现有 better-sqlite3 出现 Electron ABI 不匹配，再执行项目已有的 `npm run rebuild`。

## 登录仓库

在「仓库账号」添加仓库。复制阿里云控制台 docker login 命令中的服务器地址，不填写 https:// 或命名空间；用户名和密码使用镜像仓库登录凭据，不是云账号访问密钥。

保存后点击「登录测试」。凭据由当前版本 Electron 的 safeStorage 加密保存在应用 userData 的 deployment-v1.json，不保存在项目中，列表接口不会返回密钥。Docker 登录用 `--password-stdin`，本机和部署时远端均使用临时 Docker 配置目录，完成后清理，不覆盖已有 Docker 登录状态。系统加密不可用时拒绝保存密码。

Windows 的加密基于 DPAPI，不防御同一 Windows 用户下已被攻陷的其他进程。不要把加密配置当作可跨机器使用的密码备份。

## 添加或导入服务器

在「服务器 · Bridgebox」添加地址、SSH 端口、用户名，选择密码或本机私钥。获取 SSH 指纹后通过腾讯云控制台或可信终端独立核对；未核验的主机不允许登录，指纹变化时拒绝连接。

Bridgebox 原仓库的存储键是 `bridgebox.hosts.v1`；导入支持 HostProfile JSON 数组，以及含 `bridgebox.hosts.v1` / `flutter.bridgebox.hosts.v1` 的 shared_preferences.json。由你通过文件选择器选择自己的配置文件，不扫描其他用户目录。导入后重新填写密码或私钥、核对指纹；Flutter 安全存储里的凭据不会自动迁移。重复的地址/端口/用户会跳过。

服务器必须是 Linux，SSH 用户有 Docker 权限；systemd 管理需要相应系统权限，功能不会自动 sudo 或提升权限。没有 systemd 的主机仍可管理 Docker。删除容器不强制删除正在运行的容器，需先停止。单独手动拉取私有镜像需要远端已有登录配置；项目部署会自动使用所选仓库的临时登录。

## 第一次服务器部署准备

### SSH 认证失败排查

`All configured authentication methods failed` 表示 SSH 服务器拒绝了当前用户的登录方式或凭据；不是 Docker 权限错误。确认主机里的 SSH 用户名与现有客户端完全一致，密码使用服务器用户登录密码，不是腾讯云控制台账号密码。私钥必须与该用户绑定的公钥匹配，加密私钥还需填写私钥口令。

密码登录兼容普通 password 和单个密码提示的 keyboard-interactive；需要验证码或额外多因素认证时明确提示，不会把保存的密码作为验证码发送。失败提示会列出服务器提供的认证方式，帮助判断是否只能使用私钥。

先在系统终端使用 `ssh -p <端口> <用户名>@<服务器地址>`，或 `ssh -p <端口> -i <私钥文件> <用户名>@<服务器地址>` 验证同一登录信息。若终端也失败，通过腾讯云控制台检查对应用户、绑定密钥和登录策略；不要为排障关闭主机验证或随意放宽 SSH 配置。若终端成功而应用失败，仅提供登录方式和脱敏报错，不要发送密码或私钥。

安装 Docker Engine、Compose v2、bash、flock；Compose 需支持 `up --wait` 和 `config --images`。创建 `/opt/myapp`，放入 compose.yaml 和 runtime.env。项目发布页面的「服务器准备说明」也提供模板。

```yaml
services:
  app:
    image: ${APP_IMAGE:?APP_IMAGE required}
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    env_file:
      - runtime.env
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:8080/health"]
      interval: 10s
      timeout: 3s
      retries: 6
      start_period: 30s
```

示例镜像必须含 wget；应用监听 8080 且提供 /health。实际端口、健康探针和启动宽限期按应用修改。通过 Nginx/Caddy 提供公网 HTTPS；SSH 安全组仅允许你的网络访问，不需要额外管理端口。

应用 image 必须引用 APP_IMAGE；不能写死旧版本。部署仅更新所选应用服务（`--no-deps`），数据库等依赖需要事先启动并独立管理。数据库密码、证书、上传文件和数据卷由服务器保管，不能在容器替换时丢失。工具不会主动覆盖服务器 Compose 文件或 runtime.env。

## 发布操作

新增桌面端接口后，需要完整重启 Project Hub：退出窗口，在开发终端按 Ctrl+C 停止旧的 `npm run dev`，再重新运行。只热更新页面或刷新页面，不能更新旧主进程注册的接口。如果 Electron preload 缺少镜像发布接口，或主进程还没有注册对应处理器，页面会显示明确的重启提示。

1. 选择已登记的本地项目和仓库，填写命名空间/仓库。
2. 点击「新版本」生成时间标签，或填写自己的不可变版本号；不要反复覆盖生产标签。
3. 填写 Dockerfile 相对路径、架构、主机、服务器目录、Compose 文件、项目名和应用服务名，保存。
4. 使用「本地构建」「上传镜像」「服务器部署」分步操作，或点击「构建 → 上传 → 部署」。后者严格按顺序执行，前一步失败不会继续。

日志在各步骤结束后显示，保留最多 100 条发布记录，每条最多 100KB。发布期间禁止关闭窗口或退出；异常断电后旧的执行中记录显示为中断，需查看服务器实际状态后再发布。

同一项目不允许并发发布，同一服务器的发布与控制动作互斥，远端通过 flock 串行修改同一 Compose 项目。SSH 中断或命令超时后，远端是否完成不能由桌面端保证，必须检查实际容器状态。

## 失败与回滚

拉取失败不会替换现有容器。更新后检查容器是否使用预期镜像、是否 healthy；失败时尝试使用更新前容器的镜像 ID 恢复。回滚后再次验证实际镜像，失败明确显示 ROLLBACK FAILED。第一次部署没有旧版本可恢复。旧镜像不要提前清理。

手动回退可选择旧镜像标签，单独执行「服务器部署」。镜像回滚不撤销数据库迁移，必须使用兼容新旧应用的迁移或独立备份恢复。单副本替换有短暂中断，单机也不提供高可用。

## 验证

```text
npm run typecheck
npm run build
npm run test:delivery
npm run test:delivery-ui
```

本地验证包括类型检查、Electron/Vue 构建、15 项自动化测试，以及 Electron 离屏界面/系统加密存储测试。SSH 测试覆盖普通密码、交互式密码、密码错误、仅允许私钥、加密私钥口令、验证码拒绝、主机指纹核验及 stdin 密码传输。部署测试覆盖成功发布、拉取失败、健康失败、缺少健康检查、回滚失败、Compose 镜像配置错误与首次部署失败。部署测试使用模拟 Docker，Windows 下 flock 为测试替身，不证明真实服务器锁行为。界面测试使用虚构主机和仓库，不连接真实基础设施。

尚未执行真实 Docker 镜像构建上传和腾讯云端到端部署，需要你的实际项目 Dockerfile、仓库凭据及服务器 Compose 环境验证。

## 实现依据

- [Docker login 标准输入密码](https://docs.docker.com/reference/cli/docker/login/)
- [Docker Compose 配置解析](https://docs.docker.com/reference/cli/docker/compose/config/)
- [Docker Compose 更新与等待健康](https://docs.docker.com/reference/cli/docker/compose/up/)
- [ssh2 主机核验与执行通道](https://github.com/mscdex/ssh2)

当前项目保持 Electron 31 的 safeStorage 同步 API；升级到 Electron 46 及以上时，需要迁移到对应的异步加密 API。
