import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAgentResponse, needsAgentApproval } from '../electron/services/agent-protocol'
test('rejects arbitrary execution, malformed arguments, and ambiguous responses', () => {
  for (const raw of ['hello', 'null', '[]', '{"action":{"tool":"shell","args":{"command":"rm -rf /"}}}', '{"action":{"tool":"build","args":{"targetId":12}}}', '{"reply":"ok","action":{"tool":"project_info","args":null}}']) assert.throws(() => parseAgentResponse(raw))
  assert.deepEqual(parseAgentResponse('```json\n{"action":{"tool":"project_info","args":{}}}\n```'), { action: { tool: 'project_info', args: {} } })
})
test('mutating actions always require application confirmation', () => {
  for (const tool of ['build', 'release', 'git_push', 'git_pull', 'upload_file', 'download_file']) assert.equal(needsAgentApproval({ tool, args: {} }), true)
  assert.equal(needsAgentApproval({ tool: 'server_status', args: {} }), false)
})
