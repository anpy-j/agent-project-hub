import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AliyunRegistryClient, validateAliyunRegion } from '../electron/services/aliyun-registry'
const credentials = { accessKeyId: 'fake-test-id', accessKeySecret: 'fake-test-secret' }
const server = 'registry.cn-hangzhou.aliyuncs.com'

test('personal registry binds credential endpoint to region and rejects unrelated hosts', () => {
  validateAliyunRegion('cn-hangzhou', server)
  validateAliyunRegion('cn-hangzhou', 'crpi-abc.cn-hangzhou.personal.cr.aliyuncs.com')
  for (const host of ['registry.cn-beijing.aliyuncs.com', 'evil.example.com', 'registry.cn-hangzhou.aliyuncs.com.evil.example']) assert.throws(() => validateAliyunRegion('cn-hangzhou', host), /不匹配/)
  assert.throws(() => validateAliyunRegion('../bad', server), /地域格式/)
})
test('personal API includes empty namespaces and reads paginated repos and versions', async () => {
  const calls: string[] = []
  const client = new AliyunRegistryClient('cn-hangzhou', server, credentials, async (method, path, query) => {
    assert.equal(method, 'GET'); calls.push(path)
    if (path === '/namespace') return { data: { namespaces: [{ namespace: 'anpengyu' }, { namespace: 'empty' }] } }
    if (path === '/repos') return { data: { repos: [{ repoNamespace: 'anpengyu', repoName: query!.Page === 1 ? 'qianchuan' : 'worker' }], total: 2 } }
    assert.equal(path, '/repos/anpengyu/qianchuan/tags')
    return { data: { tags: [{ tag: '20261015' }], total: 1 } }
  })
  assert.deepEqual(await client.catalog(), { namespaces: ['anpengyu', 'empty'], repositories: ['anpengyu/qianchuan', 'anpengyu/worker'], mode: 'catalog', notice: '已通过阿里云个人版管理 API 读取 cn-hangzhou 的命名空间和镜像仓库。' })
  assert.equal(calls.filter(path => path === '/repos').length, 2)
  assert.deepEqual(await client.tags('anpengyu/qianchuan'), ['20261015'])
  await assert.rejects(client.tags('team/api/nested'), /个人版镜像路径/)
})
test('API rejects malformed bodies, repeated pages, and errors without leaking credentials', async () => {
  const broken = new AliyunRegistryClient('cn-hangzhou', server, credentials, async () => ({ data: {} }))
  await assert.rejects(broken.catalog(), /缺少/)
  const repeated = new AliyunRegistryClient('cn-hangzhou', server, credentials, async (_method, path) => path === '/namespace' ? { data: { namespaces: [] } } : { data: { repos: [{ repoNamespace: 'a', repoName: 'b' }], total: 2 } })
  await assert.rejects(repeated.catalog(), /重复分页/)
  const denied = new AliyunRegistryClient('cn-hangzhou', server, credentials, async () => { throw Object.assign(new Error(credentials.accessKeySecret), {code:'AUTHENTICATION_FAILED',statusCode:401}) })
  await assert.rejects(denied.tags('anpengyu/qianchuan'), (error: Error) => { assert.match(error.message, /cn-hangzhou/); assert.ok(!error.message.includes(credentials.accessKeySecret)); return true })
})
test('personal API lower-case errors explain RAM initialization without exposing the response', async () => {
  const unregistered = new AliyunRegistryClient('cn-hangzhou', server, credentials, async () => {
    throw Object.assign(new Error('request details ' + credentials.accessKeySecret), { statusCode: 400, result: { code: 'USER_NOT_REGISTERED', message: credentials.accessKeySecret } })
  })
  await assert.rejects(unregistered.catalog(), (error: Error) => {
    assert.match(error.message, /USER_NOT_REGISTERED/)
    assert.match(error.message, /RAM 用户尚未完成 ACR 个人版初始化/)
    assert.ok(!error.message.includes(credentials.accessKeySecret))
    return true
  })
})
