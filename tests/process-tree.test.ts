import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import { stopProcessTree, stopProcessTreeSync } from '../electron/services/process-tree'

const win = process.platform === 'win32'
async function fixture() {
  const file = join(process.cwd(), 'tests/process-tree-fixture.cjs')
  const child = spawn(`"${process.execPath}" "${file}" parent`, {
    shell: true, detached: !win, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  const info = await new Promise<{pid: number; port: number}>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('fixture startup timeout')), 10000)
    let output = ''
    child.stdout!.on('data', chunk => {
      output += chunk.toString()
      if (output.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(output.trim())) }
    })
    child.once('error', error => {clearTimeout(timeout); reject(error)})
  })
  return {child, info}
}

function connection(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({host:'127.0.0.1',port})
    socket.setTimeout(1000)
    const done = (alive: boolean) => { socket.destroy(); resolve(alive) }
    socket.once('connect',()=>done(true))
    socket.once('error',()=>done(false))
    socket.once('timeout',()=>done(false))
  })
}

test('stop closes shell -> parent -> TCP child tree and leaves unrelated server alive', async () => {
  const unrelated = createServer(socket=>socket.end())
  await new Promise<void>(resolve=>unrelated.listen(0,'127.0.0.1',resolve))
  const unrelatedPort = (unrelated.address() as {port:number}).port
  const {child, info} = await fixture()
  try {
    assert.equal(await connection(info.port),true)
    await stopProcessTree(child)
    assert.equal(await connection(info.port),false)
    assert.equal(await connection(unrelatedPort),true)
    assert.throws(()=>process.kill(info.pid,0))
    const second = await fixture()
    try { await stopProcessTree(second.child); assert.equal(await connection(second.info.port),false) }
    finally { if(second.child.exitCode===null && second.child.signalCode===null) stopProcessTreeSync(second.child) }
  } finally {
    if(child.exitCode===null && child.signalCode===null) stopProcessTreeSync(child)
    await new Promise<void>(resolve=>unrelated.close(()=>resolve()))
  }
})

test('application shutdown also kills descendants synchronously', async () => {
  const {child,info}=await fixture()
  stopProcessTreeSync(child)
  assert.equal(await connection(info.port),false)
  assert.throws(()=>process.kill(info.pid,0))
})

test('invalid PID and Hub own PID are rejected', async () => {
  for(const pid of [0,-1,NaN,process.pid]) {
    const child = new ChildProcess()
    Object.defineProperty(child,'pid',{value:pid})
    await assert.rejects(stopProcessTree(child),/无效/)
    assert.throws(()=>stopProcessTreeSync(child),/无效/)
  }
})

test('Windows taskkill failure is reported instead of falling back to killing parent only', {skip:!win}, async () => {
  const child = new ChildProcess()
  Object.defineProperty(child,'pid',{value:2147483647})
  await assert.rejects(stopProcessTree(child),/停止进程树失败/)
})
