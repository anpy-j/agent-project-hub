import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readRegistryCatalog } from '../electron/services/registry-browser'
import { RegistryCatalogUnavailable, RegistryClient } from '../electron/services/registry-client'
import { containerUpdatePlan, containerUpdateOperation, type ContainerInspection } from '../electron/services/container-update'
import { remoteCommand } from '../electron/services/deployment-validation'

const registry = { id: 'r', name: 'test', server: 'registry.example.com', username: 'user', hasPassword: true }
test('registry supports authenticated catalog pagination and tags', async () => {
  const calls: Array<{ url: string; auth: string }> = []
  const request = async (input: any, options: any) => {
    const url = String(input), auth = options.headers.Authorization || ''
    calls.push({ url, auth })
    assert.equal(options.redirect, 'error')
    if (!auth) return new Response('', { status: 401, headers: { 'www-authenticate': 'Basic realm="registry"' } })
    assert.equal(auth, 'Basic ' + Buffer.from('user:password').toString('base64'))
    if (url.includes('tags/list')) return Response.json({ tags: ['latest', 'v1'] })
    if (url.includes('last=')) return Response.json({ repositories: ['team/api', 'team/web'] })
    return Response.json({ repositories: ['team/api'] }, { headers: { link: '</v2/_catalog?n=100&last=team/api>; rel="next"' } })
  }
  const client = new RegistryClient(registry, 'password', request as typeof fetch)
  assert.deepEqual(await client.repositories(), ['team/api', 'team/web'])
  assert.deepEqual(await client.tags('team/api'), ['latest', 'v1'])
  await assert.rejects(async () => client.tags('../bad'), /路径不正确/)
  assert.equal(calls.length, 6)
})
test('registry bearer token and insecure endpoint protection', async () => {
  const calls: string[] = []
  const request = async (input: any, options: any) => {
    const url = String(input); calls.push(url)
    if (url.includes('/token')) return Response.json({ token: 'access-token' })
    if (options.headers.Authorization === 'Bearer access-token') return Response.json({ tags: ['latest'] })
    return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://registry.example.com/token",service="registry",scope="repository:team/api:pull"' } })
  }
  assert.deepEqual(await new RegistryClient(registry, 'password', request as typeof fetch).tags('team/api'), ['latest'])
  assert.ok(calls[1].includes('scope=repository%3Ateam%2Fapi%3Apull'))
  for (const realm of ['http://registry.example.com/token', 'https://user:password@auth.example.com/token', 'https://auth.example.com/token#fragment', 'not-a-url']) {
    let count = 0
    const invalid = async () => { count++; return new Response('', { status: 401, headers: { 'www-authenticate': `Bearer realm="${realm}"` } }) }
    await assert.rejects(new RegistryClient(registry, 'password', invalid as typeof fetch).repositories(), /未发送登录凭据/)
    assert.equal(count, 1)
  }
  const redirect = async () => Response.json({ repositories: [] }, { headers: { link: '<https://evil.example/v2/_catalog>; rel="next"' } })
  await assert.rejects(new RegistryClient(registry, 'password', redirect as typeof fetch).repositories(), /分页地址不可信/)
})
test('Aliyun delegates registry authentication to its separate HTTPS token service', async () => {
  const profile = { ...registry, server: 'registry.cn-hangzhou.aliyuncs.com' }
  const tokenOrigin = 'https://dockerauth.cn-hangzhou.aliyuncs.com'
  const calls: string[] = []
  const request = async (input: any, options: any) => {
    const url = new URL(String(input)); calls.push(url.href)
    assert.equal(options.redirect, 'error')
    if (url.origin === tokenOrigin) {
      assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('user:password').toString('base64'))
      assert.equal(url.searchParams.get('service'), 'registry.aliyuncs.com:cn-hangzhou:26842')
      assert.equal(url.searchParams.get('scope'), 'repository:team/api:pull')
      return Response.json({ access_token: 'aliyun-access-token' })
    }
    assert.equal(url.origin, 'https://' + profile.server)
    if (options.headers.Authorization === 'Bearer aliyun-access-token') return Response.json({ tags: ['latest', 'v2'] })
    assert.equal(options.headers.Authorization, undefined, 'password must go only to the advertised authentication endpoint')
    return new Response('', { status: 401, headers: { 'www-authenticate': `Bearer realm="${tokenOrigin}/auth",service="registry.aliyuncs.com:cn-hangzhou:26842",scope="repository:team/api:pull"` } })
  }
  assert.deepEqual(await new RegistryClient(profile, 'password', request as typeof fetch).tags('team/api'), ['latest', 'v2'])
  assert.equal(calls.length, 3)
})
test('catalog permissions are distinguished from token authentication and tag failures', async () => {
  const forbidden = async () => new Response('', { status: 403 })
  await assert.rejects(new RegistryClient(registry, 'password', forbidden as typeof fetch).repositories(), RegistryCatalogUnavailable)
  await assert.rejects(new RegistryClient(registry, 'password', forbidden as typeof fetch).tags('team/api'), error => {
    assert.ok(!(error instanceof RegistryCatalogUnavailable))
    assert.match((error as Error).message, /标签读取失败/)
    return true
  })
  const failedAuth = async (input: any) => String(input).includes('/token') ? new Response('', { status: 401 }) : new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.example.com/token"' } })
  await assert.rejects(new RegistryClient(registry, 'password', failedAuth as typeof fetch).repositories(), error => {
    assert.ok(!(error instanceof RegistryCatalogUnavailable))
    assert.match((error as Error).message, /仓库身份认证失败/)
    return true
  })
})
test('unsupported catalog uses globally tracked paths after verifying connection', async () => {
  let checked = false
  const client = { repositories: async (): Promise<string[]> => { throw new RegistryCatalogUnavailable('401') }, checkConnection: async () => { checked = true } }
  const result = await readRegistryCatalog(client, ['team/web', 'team/api', 'team/api'])
  assert.equal(checked, true)
  assert.equal(result.mode, 'tracked')
  assert.deepEqual(result.repositories, ['team/api', 'team/web'])
  assert.equal(result.warning, undefined)
  assert.match(result.notice!, /仓库连接正常/)
  await assert.rejects(readRegistryCatalog({ ...client, checkConnection: async () => { throw new Error('凭据错误') } }, []), /凭据错误/)
  await assert.rejects(readRegistryCatalog({ ...client, repositories: async () => { throw new Error('网络故障') } }, []), /网络故障/)
  const supported = await readRegistryCatalog({ repositories: async () => ['actual/repo'], checkConnection: async () => { throw new Error('should not be called') } }, ['saved/repo'])
  assert.equal(supported.mode, 'catalog')
  assert.deepEqual(supported.repositories, ['actual/repo'])
})
const inspection: ContainerInspection = {
  Id: 'a'.repeat(64), Name: '/api', Image: 'sha256:old',
  Config: { Image: 'registry.example.com/team/api:latest', Hostname: 'a'.repeat(12), Env: ['PASSWORD=private-value'], Cmd: ['serve'], Labels: { app: 'api' }, ExposedPorts: { '80/tcp': {} } },
  HostConfig: { AutoRemove: false, Binds: ['/srv/config:/config:ro'], PortBindings: { '80/tcp': [{ HostPort: '8080' }] }, RestartPolicy: { Name: 'unless-stopped' } },
  Mounts: [{ Type: 'volume', Name: 'anonymous-data', Source: '/var/lib/docker/volumes/anonymous-data/_data', Destination: '/data', RW: true }],
  NetworkSettings: { Networks: { app_net: { Aliases: ['api', 'a'.repeat(12)], IPAMConfig: null } } }, State: { Running: true }
}
test('container recreation preserves settings, anonymous volumes and network aliases', () => {
  const before = JSON.stringify(inspection), plan = containerUpdatePlan(inspection)
  assert.deepEqual(plan.payload.HostConfig.PortBindings, inspection.HostConfig.PortBindings)
  assert.deepEqual(plan.payload.Env, inspection.Config.Env)
  assert.deepEqual(plan.payload.HostConfig.Binds, inspection.HostConfig.Binds)
  assert.equal(plan.payload.HostConfig.Mounts[0].Source, 'anonymous-data')
  assert.equal(plan.payload.Hostname, undefined)
  assert.deepEqual(plan.payload.NetworkingConfig.EndpointsConfig.app_net.Aliases, ['api'])
  assert.equal(JSON.stringify(inspection), before)
  const updated = { ...inspection, Config: { ...inspection.Config, Image: 'sha256:new', Labels: { 'project-hub.source-image': plan.image } } }
  assert.equal(containerUpdatePlan(updated).image, plan.image, 'subsequent updates must retain the source tag')
  for (const host of [{ AutoRemove: true }, { NetworkMode: 'container:other' }, { VolumesFrom: ['other'] }]) assert.throws(() => containerUpdatePlan({ ...inspection, HostConfig: host }), /原编排配置/)
  assert.throws(() => containerUpdatePlan({ ...inspection, Config: { Image: 'sha256:fixed' } }), /固定镜像/)
  assert.throws(() => containerUpdatePlan({ ...inspection, NetworkSettings: { Networks: { net: { IPAMConfig: { IPv4Address: '1.2.3.4' } } } } }), /固定 IP/)
  assert.equal(remoteCommand({ kind: 'container', action: 'pause', target: 'api' }), "docker pause 'api'")
  assert.equal(remoteCommand({ kind: 'container', action: 'unpause', target: 'api' }), "docker unpause 'api'")
})

for (const scenario of ['success', 'no-change', 'pull-failure', 'create-failure', 'start-failure', 'health-failure', 'rollback-failure']) {
  test(`container update transaction: ${scenario}`, { skip: process.platform === 'win32' }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'hub-update-'))
    try {
      mkdirSync(join(directory, 'bin'))
      writeFileSync(join(directory, 'state.json'), JSON.stringify({ containers: { api: { id: inspection.Id, image: inspection.Image, running: true, labels: inspection.Config.Labels } }, trace: [] }))
      const fake = `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const statePath = path.join(process.env.TEST_DIR, 'state.json'), state = JSON.parse(fs.readFileSync(statePath)), args = process.argv.slice(2), kind = path.basename(process.argv[1]), scenario = process.env.SCENARIO
state.trace.push(kind + ' ' + args.join(' '))
let code = 0, output = ''
const find = value => Object.entries(state.containers).find(([name,c]) => name === value || c.id === value)
if (kind === 'curl') {
  if (args.includes('POST')) {
    const payload = JSON.parse(fs.readFileSync(0, 'utf8')); state.payload = payload
    if (scenario === 'create-failure') code = 1
    else { state.containers.api = { id:'new-container', image:payload.Image, labels:payload.Labels, running:false }; output = '{}' }
  } else output = '{}'
} else {
  switch(args[0]) {
    case 'login': if (fs.readFileSync(0, 'utf8') !== 'test-registry-secret\\n') code=1; break
    case 'pull': if(scenario==='pull-failure') code=1; break
    case 'image': output = scenario === 'no-change' ? 'sha256:old' : 'sha256:new'; break
    case 'stop': find(args[1])[1].running=false; break
    case 'rename': {const entry=find(args[1]);state.containers[args[2]]=entry[1];delete state.containers[entry[0]];break}
    case 'start': {const entry=find(args[1]); if(entry[1].id==='new-container' && ['start-failure','rollback-failure'].includes(scenario) || entry[1].id!=='new-container' && scenario==='rollback-failure') code=1; else entry[1].running=true;break}
    case 'rm': {const entry=find(args.at(-1));if(entry) delete state.containers[entry[0]];break}
    case 'inspect': {const entry=find(args.at(-1)), format=args[2]; if(!entry) {code=1;break} const c=entry[1]; if(format.includes('update-token')) output=c.labels['project-hub.update-token']||''; else if(format==='{{.Image}}') output=c.image; else if(format.includes('.State.Health')) output=c.running?'true '+(scenario==='health-failure'?'unhealthy':'healthy'):'false none'; else output=String(c.running);break}
    default: code=1
  }
}
fs.writeFileSync(statePath,JSON.stringify(state));process.stdout.write(output+'\\n');process.exit(code)
`
      for (const binary of ['docker', 'curl']) writeFileSync(join(directory, 'bin', binary), fake, { mode: 0o755 })
      const operation = containerUpdateOperation(inspection, { server: registry.server, username: registry.username, password: 'test-registry-secret' })
      assert.ok(!operation.script.includes('private-value'))
      assert.ok(!operation.script.includes('test-registry-secret'))
      writeFileSync(join(directory, 'update.sh'), operation.script)
      const result = spawnSync('/bin/bash', [join(directory, 'update.sh')], { input: operation.input, encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: join(directory, 'bin') + ':' + process.env.PATH, TEST_DIR: directory, SCENARIO: scenario } })
      assert.equal(result.error, undefined)
      const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))
      assert.equal(result.status, ['success', 'no-change'].includes(scenario) ? 0 : 1, result.stdout + result.stderr)
      assert.ok(!state.trace.join('\n').includes('test-registry-secret'))
      assert.ok(!result.stdout.includes('private-value'))
      if (scenario === 'success') {
        assert.equal(state.containers.api.image, 'sha256:new')
        assert.equal(state.containers.api.running, true)
        assert.equal(Object.keys(state.containers).length, 1)
        assert.deepEqual(state.payload.Env, inspection.Config.Env)
        assert.equal(state.payload.HostConfig.Mounts[0].Source, 'anonymous-data')
      } else if (scenario !== 'rollback-failure') {
        assert.equal(state.containers.api.id, inspection.Id)
        assert.equal(state.containers.api.running, true)
      } else assert.match(result.stdout, /ROLLBACK FAILED/)
      if (['no-change','pull-failure'].includes(scenario)) assert.ok(!state.trace.some((command: string) => command.startsWith('docker stop')))
      assert.ok(!state.trace.some((command: string) => command.startsWith('docker rm -v')), 'volumes must never be deleted')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
}
