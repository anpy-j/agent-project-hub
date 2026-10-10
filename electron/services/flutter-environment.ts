import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { isAbsolute, resolve, dirname, delimiter, join } from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { getDb } from '../db'
import type { BuildTarget } from '../../src/types'

export interface FlutterReport {
  sdk: string; version: string; source: string; javaHome: string; javaVersion: string; androidSdk: string
  errors: string[]; warnings: string[]
}
function text(file: string) { return existsSync(file) ? readFileSync(file, 'utf8') : '' }
function property(file: string, name: string) {
  return text(file).split(/\r?\n/).find(l => l.startsWith(name + '='))?.slice(name.length + 1).trim().replace(/\\:/g, ':').replace(/\\\\/g, '\\') || ''
}
function sdkRoot(path: string) {
  if (existsSync(path) && statSync(path).isFile()) path = dirname(dirname(realpathSync(path)))
  return resolve(path)
}
function binary(sdk: string) { return join(sdk, 'bin', process.platform === 'win32' ? 'flutter.bat' : 'flutter') }
function table() { getDb().exec('CREATE TABLE IF NOT EXISTS flutter_environments (directory TEXT PRIMARY KEY, configuration TEXT NOT NULL)') }
function cached(directory: string): Partial<FlutterReport> {
  table()
  const row = getDb().prepare('SELECT configuration FROM flutter_environments WHERE directory=?').get(realpathSync(directory)) as { configuration: string } | undefined
  return row ? JSON.parse(row.configuration) : {}
}
function resolveSdk(directory: string, target: Partial<BuildTarget>) {
  if (target.flutterSdk) {
    const sdk = sdkRoot(target.flutterSdk), previous = cached(directory)
    return { sdk, source: '构建目标指定', expected: target.flutterVersion || (previous.sdk === sdk ? previous.version : undefined) }
  }
  let fvmOwner = directory
  while (![join(fvmOwner, '.fvmrc'), join(fvmOwner, '.fvm/fvm_config.json'), join(fvmOwner, '.git')].some(existsSync) && dirname(fvmOwner) !== fvmOwner) fvmOwner = dirname(fvmOwner)
  const fvmFile = [join(fvmOwner, '.fvmrc'), join(fvmOwner, '.fvm/fvm_config.json')].find(existsSync)
  if (fvmFile) {
    const config = JSON.parse(text(fvmFile)); const version = config.flutter || config.flutterSdkVersion
    const candidates = [join(fvmOwner, '.fvm/flutter_sdk'), ...[process.env.FVM_CACHE_PATH, process.env.FVM_HOME, join(homedir(), 'fvm/versions'), join(homedir(), '.fvm/versions')].filter(Boolean).map(p => join(p!, String(version)))]
    const sdk = candidates.find(p => existsSync(binary(p)))
    if (!sdk) throw new Error(`项目指定 Flutter ${version}，但未安装。请先安装对应 FVM 版本，或在构建目标中选择兼容的 SDK。`)
    return { sdk: sdkRoot(sdk), source: `项目 FVM 配置 ${version}` , expected: String(version) }
  }
  const previous = cached(directory)
  if (previous.sdk) return { sdk: previous.sdk, source: '已保存的项目环境', expected: previous.version }
  const local = property(join(directory, 'android/local.properties'), 'flutter.sdk')
  if (local && existsSync(binary(local))) return { sdk: sdkRoot(local), source: '项目 local.properties' }
  const runtime = getDb().prepare("SELECT path FROM runtime WHERE kind='flutter' ORDER BY is_default DESC LIMIT 1").get() as { path: string } | undefined
  if (runtime?.path) return { sdk: sdkRoot(runtime.path), source: '全局 Flutter 设置' }
  for (const folder of (process.env.PATH || '').split(delimiter)) {
    const executable = join(folder, process.platform === 'win32' ? 'flutter.bat' : 'flutter')
    if (existsSync(executable)) return { sdk: sdkRoot(realpathSync(executable)), source: '当前环境首次识别' }
  }
  throw new Error('未找到 Flutter。请在构建目标中选择 Flutter 安装目录，或配置项目 FVM。')
}
function execute(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((ok, fail) => execFile(process.platform === 'win32' ? `"${file}"` : file, args, { env, timeout: 15000, maxBuffer: 1024 * 1024, shell: process.platform === 'win32', windowsHide: true }, (error, stdout) => error ? fail(new Error('无法读取 Flutter 版本，请检查 SDK 安装完整性')) : ok(stdout)))
}
function lower(actual: string, minimum: string) {
  const a = actual.split('.').map(Number), b = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0) }
  return false
}
export async function flutterEnvironment(directory: string, target: Partial<BuildTarget> = {}, android = false, remember = false) {
  const selection = resolveSdk(directory, target), prior = cached(directory)
  if (!existsSync(binary(selection.sdk))) throw new Error(`保存的 Flutter SDK 已不存在：${selection.sdk}。请重新选择 SDK；不会自动改用其他版本。`)
  if (process.platform !== 'win32') {
    try { accessSync(binary(selection.sdk), constants.X_OK) } catch { throw new Error('Flutter SDK 中的 bin/flutter 不可执行，请检查安装权限') }
  }
  let version: string
  try { const metadata = JSON.parse(text(join(selection.sdk, 'bin/cache/flutter.version.json'))); version = metadata.frameworkVersion || metadata.flutterVersion }
  catch { version = JSON.parse(await execute(binary(selection.sdk), ['--version', '--machine'], process.env)).frameworkVersion }
  if (!version) throw new Error('Flutter SDK 版本信息缺失')
  const settings = (() => { try { return JSON.parse(text(join(process.platform === 'win32' ? process.env.APPDATA || homedir() : homedir(), '.flutter_settings')) || text(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'flutter/settings'))) } catch { return {} } })()
  const javaHome = target.javaHome || prior.javaHome || settings['jdk-dir'] || (process.platform === 'darwin' && existsSync('/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java') ? '/Applications/Android Studio.app/Contents/jbr/Contents/Home' : process.env.JAVA_HOME) || ''
  const androidSdk = target.androidSdk || prior.androidSdk || settings['android-sdk'] || property(join(directory, 'android/local.properties'), 'sdk.dir') || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || ''
  const javaVersion = javaHome ? text(join(javaHome, 'release')).match(/JAVA_VERSION="([^"]+)/)?.[1] || '未识别' : '自动选择'
  const report: FlutterReport = { ...selection, version, javaHome, javaVersion, androidSdk, errors: [], warnings: [] }
  if (selection.expected && /^\d+\.\d+/.test(selection.expected) && selection.expected !== version) report.errors.push(`已固定 Flutter ${selection.expected}，当前目录变成了 ${version}。请选择原版本，或明确重新保存构建目标以确认切换。`)
  if (target.javaHome && !isAbsolute(target.javaHome)) report.errors.push('Gradle JDK 需要填写绝对安装目录')
  if (target.androidSdk && !isAbsolute(target.androidSdk)) report.errors.push('Android SDK 需要填写绝对安装目录')
  if (javaHome && !existsSync(join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) report.errors.push('Java 安装目录无效，请重新选择包含 bin/java 的目录')
  if (android) {
    if (target.androidSdk && settings['android-sdk'] && resolve(target.androidSdk) !== resolve(settings['android-sdk'])) report.errors.push('Flutter 全局 android-sdk 配置与本项目选择不一致。请调整 Flutter 全局配置或选择同一 SDK，避免实际工具忽略项目选择。')
    if (!androidSdk || !['platform-tools', 'cmdline-tools', 'tools'].some(p => existsSync(join(androidSdk, p)))) report.errors.push('未找到 Android SDK，请在构建目标中选择 Android SDK 安装目录')
    for (const name of ['build', 'app/build', 'settings']) if (existsSync(join(directory, 'android', name + '.gradle')) && existsSync(join(directory, 'android', name + '.gradle.kts'))) report.errors.push(`android/${name} 同时存在 Groovy 和 Kotlin 文件。请确认有效配置，并将另一份移作备份。`)
    const wrapper = text(join(directory, 'android/gradle/wrapper/gradle-wrapper.properties'))
    const gradle = wrapper.match(/gradle-([\d.]+)-(?:all|bin)\.zip/)?.[1]
    const gradleScripts = text(join(directory, 'android/settings.gradle')) + text(join(directory, 'android/settings.gradle.kts')) + text(join(directory, 'android/build.gradle'))
    const versions = { Gradle: gradle, AGP: gradleScripts.match(/com\.android\.application[\s\S]{0,50}?version\s*[\(]?\s*["']([\d.]+)/)?.[1] || gradleScripts.match(/com\.android\.tools\.build:gradle:([\d.]+)/)?.[1], Kotlin: gradleScripts.match(/org\.jetbrains\.kotlin\.android[\s\S]{0,50}?version\s*[\(]?\s*["']([\d.]+)/)?.[1] }
    const javaMajor = Number(javaVersion.startsWith('1.') ? javaVersion.split('.')[1] : javaVersion.split('.')[0])
    if (javaMajor && versions.AGP && Number(versions.AGP.split('.')[0]) >= 8 && javaMajor < 17) report.errors.push(`Android 插件 ${versions.AGP} 需要 Java 17 或更新版本，所选 Gradle Java 是 ${javaVersion}。`)
    const javaRules = text(join(selection.sdk, 'packages/flutter_tools/lib/src/android/gradle_utils.dart'))
    const compatibility = [...javaRules.matchAll(/JavaGradleCompat\(([\s\S]*?)\)/g)].map(m=>({
      min: m[1].match(/javaMin:\s*'([^']+)'/)?.[1], max: m[1].match(/javaMax:\s*'([^']+)'/)?.[1], gradle: m[1].match(/gradleMin:\s*'([^']+)'/)?.[1]
    })).find(r => r.min && r.max && javaMajor >= Number(r.min.startsWith('1.') ? r.min.split('.')[1] : r.min) && javaMajor < Number(r.max.startsWith('1.') ? r.max.split('.')[1] : r.max))
    if (gradle && compatibility?.gradle && lower(gradle, compatibility.gradle)) report.errors.push(`所选 Java ${javaVersion} 需要 Gradle ${compatibility.gradle} 或更新版本，项目是 ${gradle}。请选择兼容 JDK 或更新 Gradle。`)
    if (gradle && Number(gradle.split('.')[0]) >= 9 && javaMajor && javaMajor < 17) report.errors.push('Gradle 9 需要 Java 17 或更新版本')
    const checker = text(join(selection.sdk, 'packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt'))
    for (const [label, constant] of [['Gradle', 'errorGradleVersion'], ['AGP', 'errorAGPVersion'], ['Kotlin', 'errorKGPVersion']] as const) {
      const match = checker.match(new RegExp(constant + ':?[^=\\n]*=\\s*(?:Version|AndroidPluginVersion)\\((\\d+),\\s*(\\d+),\\s*(\\d+)\\)'))
      if (match && versions[label] && lower(versions[label]!, match.slice(1).join('.'))) report.errors.push(`${label} ${versions[label]} 低于 Flutter ${version} 要求的 ${match.slice(1).join('.')}。可选择兼容的旧 Flutter，或升级项目 Android 配置。`)
      if (!match) report.warnings.push(`当前 SDK 的 ${label} 最低版本规则未识别，构建仍会执行 Flutter 官方检查。`)
      if (!versions[label]) report.warnings.push(`未能静态识别 ${label} 版本，实际构建仍会执行 Flutter 官方检查。`)
    }
    const app = text(join(directory, 'android/app/build.gradle')) + text(join(directory, 'android/app/build.gradle.kts'))
    const ndk = app.match(/ndkVersion\s*=?\s*["']([^"']+)/)?.[1] || (app.includes('flutter.ndkVersion') ? text(join(selection.sdk, 'packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt')).match(/ndkVersion[^=\n]*=\s*"([^"]+)"/)?.[1] : undefined)
    const defaultNdk = text(join(selection.sdk, 'packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt')).match(/ndkVersion[^=\n]*=\s*"([^"]+)"/)?.[1]
    try {
      const plugins = JSON.parse(text(join(directory, '.flutter-plugins-dependencies'))).plugins?.android || []
      for (const plugin of plugins) {
        const script = text(join(plugin.path, 'android/build.gradle')) + text(join(plugin.path, 'android/build.gradle.kts'))
        const required = script.match(/ndkVersion\s*=?\s*["']([\d.]+)/)?.[1] || (script.includes('flutter.ndkVersion') ? defaultNdk : undefined)
        if (ndk && required && lower(ndk, required)) report.errors.push(`${plugin.name} 要求 NDK ${required}，项目是 ${ndk}。请将项目 ndkVersion 调整到兼容版本。`)
      }
    } catch { report.warnings.push('插件依赖清单尚未生成，首次构建可能发现额外的 NDK 要求。') }
    if (ndk && androidSdk && !existsSync(join(androidSdk, 'ndk', ndk, 'source.properties'))) report.warnings.push(`NDK ${ndk} 尚未完整安装，首次构建可能需要下载。`)
  }
  const env = { ...process.env, PATH: join(selection.sdk, 'bin') + delimiter + (javaHome ? join(javaHome, 'bin') + delimiter : '') + (process.env.PATH || ''), FLUTTER_ROOT: selection.sdk, ...(javaHome ? { JAVA_HOME: javaHome, GRADLE_OPTS: (process.env.GRADLE_OPTS || '') + ' -Dorg.gradle.java.home="' + javaHome.replace(/["\\$`]/g, '\\$&') + '"' } : {}), ...(androidSdk ? { ANDROID_HOME: androidSdk, ANDROID_SDK_ROOT: androidSdk } : {}) }
  if (remember && !report.errors.length) getDb().prepare('INSERT INTO flutter_environments VALUES (?,?) ON CONFLICT(directory) DO UPDATE SET configuration=excluded.configuration').run(realpathSync(directory), JSON.stringify(report))
  return { report, env }
}
export function isFlutter(directory: string) { return /sdk:\s*flutter/.test(text(join(directory, 'pubspec.yaml'))) }
