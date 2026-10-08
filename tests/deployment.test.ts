import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Server, utils } from 'ssh2'
import { connectHost, discoverFingerprint, sshExec } from '../electron/services/deployment-ssh'
import { deployScript } from '../electron/services/deployment-script'
import { prepareDockerBuild } from '../electron/services/deployment-build'
import { dockerfilePath, remoteCommand, validateConfig, validateRegistry } from '../electron/services/deployment-validation'
import type { DeployConfig, HostProfile } from '../src/types/deployment'

const config: DeployConfig = { projectId: 'p', registryId: 'r', hostId: 'h', repository: 'personal/myapp', tag: 'v1', dockerfile: 'Dockerfile', platform: 'linux/amd64', remoteDir: '/opt/myapp', composeFile: 'compose.yaml', service: 'app', composeProject: 'myapp' }
test('nested Dockerfile uses backend build context and permits explicit project root', async () => {
  const root = mkdtempSync(join(process.cwd(), 'delivery-build-test-'))
  try {
    mkdirSync(join(root, 'server'))
    writeFileSync(join(root, 'server', 'Dockerfile'), 'FROM scratch\nCOPY requirements.txt /requirements.txt\n')
    writeFileSync(join(root, 'server', 'requirements.txt'), 'fastapi\n')
    writeFileSync(join(root, 'server', '.dockerignore'), '*.log\n')
    const build = await prepareDockerBuild(root, { ...config, dockerfile: 'server/Dockerfile' }, 'example/app:v1')
    assert.equal(build.context, join(root, 'server'))
    assert.equal(readFileSync(join(build.context, 'requirements.txt'), 'utf8'), 'fastapi\n')
    assert.equal(build.args.at(-1), build.context)
    const explicit = await prepareDockerBuild(root, { ...config, dockerfile: 'server/Dockerfile', buildContext: '.' }, 'example/app:v1')
    assert.equal(explicit.context, root)
    await assert.rejects(prepareDockerBuild(root, { ...config, dockerfile: 'server/Dockerfile', buildContext: '../' }, 'example/app:v1'), /项目内/)
    await assert.rejects(prepareDockerBuild(root, { ...config, dockerfile: 'server/Dockerfile', buildContext: 'missing' }, 'example/app:v1'), /找不到构建目录/)
    await assert.rejects(prepareDockerBuild(root, { ...config, dockerfile: 'missing/Dockerfile' }, 'example/app:v1'), /找不到 Dockerfile/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('reject command injection and paths escaping project/deploy directories', () => {
  for (const target of ['app; touch /tmp/pwn', '$(id)', '-f', 'app\nreboot']) assert.throws(() => remoteCommand({ kind: 'container', action: 'rm', target }))
  assert.throws(() => remoteCommand({ kind: 'service', action: 'restart', target: 'nginx.service;reboot' }))
  assert.throws(() => remoteCommand({ kind: 'image', action: 'pull', target: 'image && id' }))
  assert.throws(() => validateConfig({ ...config, remoteDir: '/opt/../etc' }))
  assert.throws(() => validateConfig({ ...config, composeFile: '../compose.yaml' }))
  assert.throws(() => validateConfig({ ...config, tag: 'tag;id' }))
  assert.throws(() => dockerfilePath(process.cwd(), '../Dockerfile'))
  assert.throws(() => validateRegistry({ id: '', name: 'a', server: 'https://registry.example.com/path', username: 'u' }))
  assert.equal(remoteCommand({ kind: 'container', action: 'rm', target: 'app-1' }), "docker rm 'app-1'")
})

test('SSH pins host identity and transfers login password over stdin', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  let authCount = 0, received = ''
  const server = new Server({ hostKeys: [key as string] }, client => {
    client.on('error', () => {})
    client.on('authentication', ctx => {
      authCount++
      if (ctx.method === 'password' && ctx.username === 'deploy' && ctx.password === 'ssh-secret') ctx.accept(); else ctx.reject()
    })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('exec', (acceptStream, _reject, info) => {
        assert.equal(info.command, 'docker login registry.example.com --password-stdin')
        const stream = acceptStream()
        stream.on('data', data => { received += data.toString() })
        stream.on('end', () => { stream.write('Login Succeeded\n'); stream.exit(0); stream.end() })
      })
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const profile: HostProfile = { id: 'h', name: 'test', host: '127.0.0.1', port: address.port, username: 'deploy', authKind: 'password', fingerprint: '', hasCredential: true }
  try {
    const fingerprint = await discoverFingerprint(profile.host, profile.port)
    assert.match(fingerprint, /^SHA256:/)
    assert.equal(authCount, 0, 'fingerprint discovery must not authenticate')
    await assert.rejects(connectHost({ ...profile, fingerprint: 'SHA256:' + 'A'.repeat(43) }, { password: 'ssh-secret' }), /指纹不匹配/)
    assert.equal(authCount, 0, 'changed host must be rejected before authentication')
    const client = await connectHost({ ...profile, fingerprint }, { password: 'ssh-secret' })
    try {
      const result = await sshExec(client, 'docker login registry.example.com --password-stdin', { input: 'registry-secret\n' })
      assert.match(result, /Login Succeeded/)
      assert.equal(received, 'registry-secret\n')
    } finally { client.end() }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

for (const scenario of ['keyboard-password', 'wrong-password', 'key-only-with-password', 'otp-challenge', 'encrypted-private-key']) {
  test(`SSH authentication: ${scenario}`, async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const plain = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
    const encrypted = pair.privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'key-passphrase' }) as string
    const parsed = utils.parseKey(plain)
    assert.ok(!(parsed instanceof Error))
    let responses: string[] = []
    const server = new Server({ hostKeys: [plain] }, client => {
      client.on('error', () => {})
      client.on('authentication', ctx => {
        if (scenario === 'encrypted-private-key') {
          if (ctx.method === 'publickey' && ctx.key.data.equals(parsed.getPublicSSH())
            && (!ctx.signature || parsed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)) ctx.accept()
          else ctx.reject(['publickey'])
        } else if (scenario === 'key-only-with-password') ctx.reject(['publickey'])
        else if (scenario === 'wrong-password') ctx.reject(['password'])
        else if (ctx.method === 'keyboard-interactive') {
          const prompts = scenario === 'otp-challenge' ? [{ prompt: 'Verification code: ', echo: false }] : [{ prompt: 'Password: ', echo: false }]
          ctx.prompt(prompts, answers => {
            responses = answers
            if (scenario === 'keyboard-password' && answers[0] === 'ssh-secret') ctx.accept()
            else ctx.reject(['keyboard-interactive'])
          })
        } else ctx.reject(['keyboard-interactive'])
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const profile: HostProfile = { id: 'h', name: 'test', host: '127.0.0.1', port: (server.address() as { port: number }).port, username: 'deploy', authKind: scenario === 'encrypted-private-key' ? 'privateKey' : 'password', fingerprint: '', hasCredential: true }
    try {
      profile.fingerprint = await discoverFingerprint(profile.host, profile.port)
      if (scenario === 'encrypted-private-key') {
        await assert.rejects(connectHost(profile, { privateKey: encrypted, passphrase: 'incorrect' }), /私钥无法解析/)
        const client = await connectHost(profile, { privateKey: encrypted, passphrase: 'key-passphrase' })
        client.end()
      } else if (scenario === 'keyboard-password') {
        const client = await connectHost(profile, { password: 'ssh-secret' })
        assert.deepEqual(responses, ['ssh-secret']); client.end()
      } else {
        const pattern = scenario === 'wrong-password' ? /用户名和服务器登录密码/ : scenario === 'otp-challenge' ? /额外交互认证/ : /未提供密码认证/
        await assert.rejects(connectHost(profile, { password: 'wrong-secret' }), error => {
          assert.match((error as Error).message, pattern)
          assert.ok(!(error as Error).message.includes('wrong-secret'))
          return true
        })
        if (scenario === 'otp-challenge') assert.deepEqual(responses, [], 'do not send stored password as a verification code')
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
}

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
function unixPath(path: string): string {
  return process.platform === 'win32' ? '/' + path[0].toLowerCase() + path.slice(2).replace(/\\/g, '/') : path
}
for (const scenario of ['success', 'pull-failure', 'health-failure', 'missing-health', 'rollback-failure', 'wrong-compose-image', 'first-deploy-failure']) {
  test(`deployment shell: ${scenario}`, { skip: !existsSync(bash) }, () => {
    const dir = mkdtempSync(join(process.cwd(), 'delivery-test-'))
    try {
      mkdirSync(join(dir, 'bin'))
      // Git Bash lacks util-linux flock; production Linux uses the real command.
      writeFileSync(join(dir, 'bin', 'flock'), '#!/usr/bin/env bash\nexit 0\n')
      writeFileSync(join(dir, 'compose.yaml'), 'services: {}\n')
      writeFileSync(join(dir, 'bin', 'docker'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TRACE"
case "$*" in
  'info'|'compose version'|'compose -p myapp -f compose.yaml config --quiet') exit 0 ;;
  login*) cat > "$PASSWORD_FILE"; exit 0 ;;
  'compose -p myapp -f compose.yaml config --images app') if [ "$SCENARIO" = wrong-compose-image ]; then echo wrong-image; else echo "$APP_IMAGE"; fi ;;
  'compose -p myapp -f compose.yaml ps -a -q app') if [ "$SCENARIO" != first-deploy-failure ]; then echo old-container; fi ;;
  "inspect --format {{.Image}} old-container") echo sha256:old ;;
  pull*) if [ "$SCENARIO" = pull-failure ]; then exit 1; fi ;;
  'image inspect --format {{.Id}} registry.example.com/personal/myapp:v1') echo sha256:new ;;
  'compose -p myapp -f compose.yaml up'* )
    if [ "$APP_IMAGE" = sha256:old ]; then
      echo rollback >> "$TRACE"
      if [ "$SCENARIO" = rollback-failure ]; then exit 1; fi
    elif [ "$SCENARIO" = health-failure ] || [ "$SCENARIO" = rollback-failure ] || [ "$SCENARIO" = first-deploy-failure ]; then exit 1; fi ;;
  'compose -p myapp -f compose.yaml ps -q app') echo new-container ;;
  "inspect --format {{.Image}} new-container") if [ "$APP_IMAGE" = sha256:old ]; then echo sha256:old; else echo sha256:new; fi ;;
  'inspect --format {{if .State.Health}}'* ) if [ "$SCENARIO" = missing-health ]; then echo missing; else echo healthy; fi ;;
  *) echo "Unexpected command: $*" >&2; exit 2 ;;
esac
`)
      const script = deployScript({ ...config, remoteDir: unixPath(dir) }, 'registry.example.com', 'user', 'registry.example.com/personal/myapp:v1')
      writeFileSync(join(dir, 'deploy.sh'), script)
      writeFileSync(join(dir, 'run.sh'), `#!/usr/bin/env bash\nexport PATH=${JSON.stringify(unixPath(join(dir, 'bin')))}:$PATH\nchmod +x ${JSON.stringify(unixPath(join(dir, 'bin', 'docker')))} ${JSON.stringify(unixPath(join(dir, 'bin', 'flock')))}\nexec bash ${JSON.stringify(unixPath(join(dir, 'deploy.sh')))}\n`)
      const trace = join(dir, 'trace'), password = join(dir, 'password')
      const result = spawnSync(bash, ['--noprofile', '--norc', unixPath(join(dir, 'run.sh'))], { input: 'registry-secret\n', encoding: 'utf8', env: { ...process.env, SCENARIO: scenario, TRACE: unixPath(trace), PASSWORD_FILE: unixPath(password) }, timeout: 20000 })
      assert.equal(result.error, undefined)
      assert.equal(result.status, scenario === 'success' ? 0 : 1, result.stdout + result.stderr)
      assert.equal(readFileSync(password, 'utf8'), 'registry-secret\n')
      const commands = readFileSync(trace, 'utf8')
      assert.ok(!commands.includes('registry-secret'), 'registry password must not appear in command arguments')
      if (scenario === 'pull-failure') assert.ok(!commands.includes(' up '), 'pull failure must leave current container untouched')
      if (['health-failure', 'missing-health', 'rollback-failure'].includes(scenario)) assert.match(commands, /rollback/)
      if (scenario === 'rollback-failure') assert.match(result.stdout, /ROLLBACK FAILED/)
      if (scenario === 'wrong-compose-image') assert.ok(!commands.includes(' up '), 'wrong compose image must be rejected before updating containers')
      if (scenario === 'first-deploy-failure') assert.match(result.stdout, /no previous version/)
      assert.equal(existsSync(join(dir, '.project-hub-myapp-current')), scenario === 'success')
    } finally {
      assert.ok(dir.startsWith(process.cwd()))
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
