# Electron 安装包构建

## electron-vite 项目

识别 package.json 的 main、scripts.build 和 electron.vite.config。典型的 `electron-vite build` 输出 out/main、out/preload、out/renderer，只生成应用运行文件，还需要 electron-builder 生成安装包。

下面是可适配的配置形态，不能直接覆盖已有配置。应用标识和品牌名从项目推断；已有 appId 必须保留，避免影响用户数据和升级行为。

```yaml
appId: com.example.projecthub
productName: Project Hub
directories:
  output: release
files:
  - out/**/*
  - package.json
win:
  target:
    - target: nsis
      arch:
        - x64
  artifactName: '${productName}-Setup-${version}-${arch}.${ext}'
```

不要把源码构建目录 out 与安装包目录 release 混用。electron-builder 会按规则处理生产依赖；检查实际包中依赖是否齐全，并查看 extraResources、asarUnpack 和构建钩子是否额外带入文件。使用 Windows 安全文件名。

已有配置优先复用；缺失时可补配置及脚本，例如：

```json
{
  "scripts": {
    "dist:win": "npm run build && electron-builder --win nsis --x64 --publish never"
  }
}
```

## 原生依赖与启动

better-sqlite3 等原生依赖需要针对 Electron 版本、目标平台和架构编译。优先复用项目重建流程或 electron-builder 的依赖重建能力；不要复制其他系统或普通 Node.js ABI 的 node_modules 到安装包。

若原生重建失败，根据真实日志处理编译工具链或兼容性。保持锁文件及版本约束，避免通过升级整个框架绕过问题。

在可用主机上验证打包应用启动及关键本地功能，使用临时用户数据目录防止污染真实数据。若不能验证安装过程，交付时区别打包应用启动验证和安装验证。

## 平台与自动更新

Windows 通常使用 NSIS；macOS 通常使用 DMG，Linux 按用户环境选择 AppImage 或 deb。多平台任务优先用对应系统的构建主机，尤其涉及原生模块和签名时。不将未验证的跨平台产物标记为已测试。

未签名包如触发系统提示，按实际状态说明；不要指导用户关闭系统防护。沿用用户提供的签名配置，不将证书或密码写入仓库。

只有项目已经实现或用户要求实现自动更新时，才发布匹配的更新元数据与 blockmap，并检查版本、文件名和下载地址对应本次安装包。仅上传安装包不会自动赋予应用更新能力。

## 当前 Project Hub 的适配线索

若当前项目仍保持本次技能创建时的结构：package.json 的 main 指向 out/main/index.js，使用 electron-vite，已经安装 electron-builder，并包含 better-sqlite3 和 electron-rebuild。先检查当前配置是否已有打包脚本；缺失时可补 Windows NSIS 配置。以上只是识别线索，以实际文件为准，不硬编码项目路径、版本号、仓库或账户。

## 用户明确要求 GitHub Actions 时

构建阶段用 `--publish never`，先完成目标系统构建和验证，再上传显式产物集合。发布任务设置必要的 contents 写权限，用平台提供的 secret，不将 token 写入 YAML 正文。

标签触发或手动触发按用户要求选择；标签版本与 package.json 版本保持一致。同一版本的多平台产物汇总到同一个 Release，避免各构建任务相互覆盖附件、正文或发布状态。采用当前官方支持的 Actions 版本，并确认仓库权限与来源。
