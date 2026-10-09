import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { classifyGitAuth, parsePublicKey } from '../electron/services/git-auth.service'

test('SSH authentication recognizes GitHub success despite nonzero exit code', () => {
  const result = classifyGitAuth("Hi demo! You've successfully authenticated, but GitHub does not provide shell access.", false, false)
  assert.equal(result.status, 'success')
  assert.equal(result.message, 'SSH 认证成功')
})

test('repository success is described as read access rather than account or push permission', () => {
  const result = classifyGitAuth('', true, true)
  assert.equal(result.status, 'success')
  assert.match(result.message, /仓库可读取/)
  assert.match(result.message, /不代表可推送/)
})

test('authentication, network, host identity and unsupported responses remain distinct', () => {
  for (const [output, status] of [
    ['Permission denied (publickey).', 'auth-failed'],
    ['fatal: repository not found', 'auth-failed'],
    ['Connection timed out', 'network-failed'],
    ['Could not resolve hostname example.com', 'network-failed'],
    ['Host key verification failed.', 'host-untrusted'],
    ['WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', 'host-untrusted'],
    ['unexpected platform output', 'unknown']
  ]) assert.equal(classifyGitAuth(output, false, false).status, status)
})

test('public key fingerprint ignores comments; private key content is rejected', () => {
  const encoded = Buffer.from('test-public-key').toString('base64')
  const key = parsePublicKey(`ssh-ed25519 ${encoded} demo@example.com`)
  assert.ok(key)
  assert.equal(key.fingerprint, 'SHA256:' + createHash('sha256').update('test-public-key').digest('base64').replace(/=+$/, ''))
  assert.equal(key.comment, 'demo@example.com')
  assert.equal(parsePublicKey(`ssh-ed25519 ${encoded} another-comment`)?.fingerprint, key.fingerprint)
  assert.equal(parsePublicKey('-----BEGIN OPENSSH PRIVATE KEY-----'), null)
})
