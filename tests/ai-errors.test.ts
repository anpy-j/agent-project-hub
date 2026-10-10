import test from 'node:test'
import assert from 'node:assert/strict'
import { aiRequestError } from '../electron/services/ai-errors'

test('Ollama connection refusal explains startup and model directory checks', () => {
  const error = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const result = aiRequestError(error, `http://${host}:11434/v1`, false)
    assert.match(result, /本机 Ollama/)
    assert.match(result, /OLLAMA_MODELS/)
  }
  assert.doesNotMatch(aiRequestError(error, 'http://remote.example:11434/v1', false), /本机 Ollama/)
})

test('distinguishes timeouts, DNS failures, HTTP errors and invalid URLs', () => {
  assert.match(aiRequestError(new Error('fetch failed'), 'http://localhost:11434/v1', true), /超时/)
  assert.match(aiRequestError({ cause: { code: 'ENOTFOUND' } }, 'https://ai.example/v1', false), /无法解析服务域名/)
  assert.equal(aiRequestError(new Error('HTTP 401'), 'https://ai.example/v1', false), 'HTTP 401')
  assert.match(aiRequestError(new Error('bad URL'), 'invalid', false), /Base URL 无效/)
})

test('network errors display only the host, excluding URL credentials and query secrets', () => {
  const result = aiRequestError(new Error('fetch failed'), 'https://user:secret@ai.example/v1?key=hidden', false)
  assert.match(result, /ai.example/)
  assert.doesNotMatch(result, /secret|hidden|user/)
})
