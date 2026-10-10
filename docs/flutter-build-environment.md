# Flutter 运行与打包环境

项目详情的构建目标支持指定 Flutter SDK、Gradle JDK 和 Android SDK。这些路径都是本机安装目录，Flutter SDK 与子项目目录是两个不同字段。

## SDK 选择顺序

1. 构建目标指定的 Flutter SDK。
2. 项目或仓库上层的 FVM 配置。
3. 已保存的子项目环境。
4. 子项目 `android/local.properties` 的 `flutter.sdk`。
5. 项目管家全局配置中的 Flutter。
6. 当前进程环境中的 Flutter。

FVM 指定的版本未安装、保存的 SDK 被删除或版本发生变化时，会停止执行并提示修复，不会自动切换到另一套 SDK。FVM 的数字版本会校验实际 SDK 版本；渠道名称仍由 FVM 管理。

首次运行或构建通过静态环境检查后，会将环境保存到项目管家的本机数据库，以子项目实际目录区分。仅点击“检查 Flutter 构建环境”不会保存环境。静态检查通过不等于实际构建成功。

保存明确指定 SDK 的构建目标时，会记录该目录当前的 Flutter 版本。需要切换版本时，选择对应 SDK 并重新保存目标。此操作确认使用新版本，但不会自动升级项目的 Android 配置。

## 检查与执行

在项目详情选择 Flutter 构建目标，点击“检查 Flutter 构建环境”，可查看 SDK 来源、版本、Gradle Java 和 Android SDK，以及具体错误和警告。

运行入口和构建入口共用环境解析。执行时将 Flutter 安装目录放到命令搜索路径前方；指定 JDK 时通过 Gradle 参数约束其 Java 安装目录。构建记录会显示实际选择的环境。Android SDK 如与 Flutter 全局设置冲突，会要求先统一配置。

Android APK / AppBundle 构建前会检查：

- SDK 安装路径，以及已保存 Flutter 版本是否变化。
- 同一位置是否同时存在 `.gradle` 和 `.gradle.kts` 文件。
- Gradle、Android Gradle Plugin、Kotlin 是否低于所选 Flutter SDK 的最低要求。
- 可识别的 Java / Gradle 兼容要求、插件 NDK 版本要求。
- Android SDK 是否存在，以及所选 NDK 是否有安装信息。

规则从所选 Flutter SDK 中读取。动态脚本或未识别的规则会显示警告，实际构建继续使用 Flutter 官方校验。依赖下载、项目代码、签名、平台工具完整性等仍可能在实际构建阶段报错。

## 处理兼容性错误

优先选择与该项目兼容的 Flutter SDK。如果要使用新版 Flutter，则应升级该项目的 Gradle、Android Gradle Plugin、Kotlin 等配置，再重新检查。重复的 Gradle 文件需确认当前有效文件，并将另一份移作备份。

统一环境处理解决项目管家与终端选择不同 SDK、环境变动无法追踪的问题；不同项目仍然可以使用不同版本。不会批量改写项目文件，也不会跳过 Flutter 的兼容性检查。

## 验证

`npm run typecheck` 检查主进程与界面类型。

`npm run test:build-targets` 使用隔离数据库和测试 SDK 验证环境选择、保存、版本变化、FVM、Android 兼容检查、实际界面及运行/构建入口；不会修改真实项目的 Flutter 配置。
