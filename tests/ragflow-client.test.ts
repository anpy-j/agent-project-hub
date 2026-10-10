import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { RagflowClient, normalizeRagflowUrl, validateDatasetId } from '../electron/services/ragflow-client'
test('normalizes local dataset links and rejects unsafe addresses and IDs', () => {
  assert.equal(normalizeRagflowUrl('http://127.0.0.1:14310/dataset/files/abc'), 'http://127.0.0.1:14310')
  for (const url of ['file:///tmp/test', 'http://user:secret@localhost', 'http://localhost?key=x', 'http://localhost/api/v1']) assert.throws(() => normalizeRagflowUrl(url))
  assert.throws(() => validateDatasetId('../other'))
})
test('authenticates, paginates legacy/new datasets, reads docs and handles business errors', async () => {
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(req.url!)
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== 'Bearer fixture-key') { res.end(JSON.stringify({ code: 401 })); return }
    if (req.url!.startsWith('/api/v1/datasets/ds/documents')) { res.end(JSON.stringify({ code: 0, data: { docs: [{ id: 'doc', name: '文章.md', run: '3', progress: 1 }] } })); return }
    const first = req.url!.includes('page=1&')
    res.end(JSON.stringify({ code: 0, data: first ? Array.from({ length: 100 }, (_, i) => ({ id: `ds${i}`, name: `库${i}` })) : { datasets: [{ id: 'ds', name: '目标库' }] } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    const client = new RagflowClient(url, 'fixture-key')
    const rows = await client.datasets()
    assert.equal(rows.length, 101)
    assert.equal(rows[100].name, '目标库')
    assert.equal((await client.documents('ds'))[0].name, '文章.md')
    assert(paths.some(path => path.includes('page=2&')))
    await assert.rejects(new RagflowClient(url, 'bad').datasets(), /认证失败/)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
test('does not forward API keys through redirects or accept HTML as API data', async () => {
  let targetReached = false
  const server = createServer((req, res) => {
    if (req.headers.authorization === 'Bearer html') { res.end('<html>login</html>'); return }
    if (req.url === '/target') { targetReached = true; res.end('{}'); return }
    res.writeHead(302, { Location: '/target' }); res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    await assert.rejects(new RagflowClient(url, 'key').datasets(), /无法连接/)
    assert.equal(targetReached, false)
    await assert.rejects(new RagflowClient(url, 'html').datasets(), /有效的 API 数据/)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
