import { Client, utils } from 'ssh2'
import type { AuthenticationType } from 'ssh2'
import { createHash } from 'crypto'
import type { HostProfile } from '../../src/types/deployment'
import { validateEndpoint } from './deployment-validation'

export function keyFingerprint(key: Buffer): string { return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '') }
export function discoverFingerprint(host: string, port: number): Promise<string> {
  validateEndpoint(host, port)
  return new Promise((resolve, reject) => {
    const client = new Client()
    let observed = ''
    client.on('error', error => { client.destroy(); observed ? resolve(observed) : reject(error) })
    client.on('close', () => { if (observed) resolve(observed); else reject(new Error('未取得 SSH 主机指纹')) })
    client.connect({ host, port, username: 'fingerprint-probe', readyTimeout: 15000, hostVerifier: (key: Buffer) => { observed = keyFingerprint(key); return false } })
  })
}
export function connectHost(host: HostProfile, secret: { password?: string; privateKey?: string; passphrase?: string }): Promise<Client> {
  if (!host.fingerprint) throw new Error('请先核对并保存 SSH 主机 SHA256 指纹')
  return new Promise((resolve, reject) => {
    const client = new Client()
    let verified = true, ready = false, unsupportedChallenge = false, partialAuth = false
    let offered: AuthenticationType[] = []
    const attempts: AuthenticationType[] = host.authKind === 'password' ? ['none', 'password', 'keyboard-interactive'] : ['none', 'publickey']
    if (host.authKind === 'password' && !secret.password) { reject(new Error('未保存 SSH 密码，请编辑主机并重新填写')); return }
    if (host.authKind === 'privateKey') {
      if (!secret.privateKey) { reject(new Error('未保存 SSH 私钥，请编辑主机并重新导入')); return }
      if (utils.parseKey(secret.privateKey, secret.passphrase) instanceof Error) {
        reject(new Error('SSH 私钥无法解析：请导入正确的私钥文件；加密私钥需填写正确的私钥口令')); return
      }
    }
    client.on('error', error => {
      client.destroy()
      if (!verified) { reject(new Error('SSH 主机指纹不匹配，连接已拒绝')); return }
      if (unsupportedChallenge || partialAuth) { reject(new Error('服务器要求额外交互认证（如验证码或多因素认证），当前保存的凭据无法完成；请用系统 SSH 客户端确认登录要求')); return }
      if (error.message.includes('All configured authentication methods failed')) {
        const methods = offered.length ? `服务器允许：${offered.join('、')}。` : ''
        const advice = host.authKind === 'password'
          ? offered.length && !offered.includes('password') && !offered.includes('keyboard-interactive')
            ? '服务器未提供密码认证，请切换私钥登录并确认公钥已绑定到该用户。'
            : '请核对 SSH 用户名和服务器登录密码（不是腾讯云账号密码），并确认该用户允许密码登录。'
          : '请核对 SSH 用户名、所选私钥及对应公钥是否已绑定到该用户的 authorized_keys。'
        reject(new Error(`SSH 身份验证失败。${methods}${advice}先在系统终端用相同用户和凭据测试登录。`)); return
      }
      reject(error)
    })
    client.on('close', () => { if (!ready) reject(new Error('SSH 登录完成前连接关闭，请检查服务器认证策略')) })
    client.on('ready', () => { ready = true; resolve(client) })
    client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
      // Answer only an explicit hidden password prompt, never reuse a password as an OTP.
      if (prompts.length === 0) { finish([]); return }
      if (host.authKind === 'password' && prompts.length === 1 && !prompts[0].echo
        && /password|密码|口令/i.test(prompts[0].prompt)
        && !/otp|verification|token|code|验证码|动态|one.time|authenticator/i.test(prompts[0].prompt)) {
        finish([secret.password!])
      } else { unsupportedChallenge = true; finish([]) }
    })
    client.connect({ host: host.host, port: host.port, username: host.username, readyTimeout: 15000, keepaliveInterval: 10000,
      ...(host.authKind === 'password' ? { password: secret.password } : { privateKey: secret.privateKey, passphrase: secret.passphrase }),
      tryKeyboard: host.authKind === 'password',
      authHandler: (methods: AuthenticationType[] | null, partial: boolean | null) => {
        if (methods) offered = methods.filter(method => ['password', 'publickey', 'keyboard-interactive', 'hostbased', 'gssapi-with-mic'].includes(method))
        partialAuth = !!partial
        if (partial) return false
        let method: AuthenticationType | undefined
        while ((method = attempts.shift())) if (!methods?.length || method === 'none' || methods.includes(method)) return method
        return false
      },
      hostVerifier: (key: Buffer) => { verified = keyFingerprint(key) === host.fingerprint; return verified }
    })
  })
}
export function sshExec(client: Client, command: string, options: { input?: string; timeout?: number; log?: (text: string) => void } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '', settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer); client.removeListener('error', fail); client.removeListener('close', closed)
      error ? reject(error) : resolve(output)
    }
    const fail = (error: Error) => finish(error)
    const closed = () => finish(new Error('SSH 连接中断；请检查服务器实际状态'))
    const timer = setTimeout(() => { finish(new Error('远端命令超时；请检查服务器实际状态')); client.destroy() }, options.timeout || 45000)
    client.on('error', fail); client.on('close', closed)
    client.exec(command, (error, stream) => {
      if (error) { finish(error); return }
      const append = (data: Buffer) => {
        const text = data.toString('utf8'); output = (output + text).slice(-512000); options.log?.(text)
      }
      stream.on('data', append); stream.stderr.on('data', append)
      stream.on('error', fail)
      stream.on('close', (code: number | undefined) => finish(code === 0 ? undefined : new Error(`远端命令退出码 ${code ?? 'unknown'}\n${output.slice(-4000)}`)))
      stream.end(options.input || '')
    })
  })
}
