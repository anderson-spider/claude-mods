import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { handler } from '../lib/http.mjs'
import { Threads } from '../lib/threads.mjs'
import { fakeClient, sleep, temp } from './support.mjs'

const CWD = '/tmp/project'
const body = (task, extra = {}) => ({ cwd: CWD, task, sandbox: 'read-only', approval: 'on-request', ...extra })

// A socket server over a Threads on the fake app-server, like the helper's.
const serve = async () => {
  const client = fakeClient()
  await client.start()
  const threads = new Threads({ client })
  threads.attach()
  const socket = join(temp(), 'helper.sock')
  const server = createServer(handler({ threads }))
  await new Promise(resolve => server.listen(socket, resolve))

  const call = (method, path, payload) =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ socketPath: socket, path, method, agent: false }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(text) }))
      })
      req.on('error', reject)
      req.end(payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload))
    })

  return { call, close: () => server.close() }
}

test('start answers with the thread id, and bad bodies are 400 with a reason', async () => {
  const { call, close } = await serve()

  try {
    const started = await call('POST', '/start', body('hello'))
    assert.equal(started.code, 200)
    assert.equal(started.body.status, 'ok')
    assert.equal(started.body.threadId, 'thr_1')

    const bad = {
      'no task': body(undefined),
      'relative cwd': body('hello', { cwd: 'project' }),
      'unknown sandbox': body('hello', { sandbox: 'danger-full-access' }),
      'unknown approval': body('hello', { approval: 'always' }),
      'numeric effort': body('hello', { effort: 3 }),
    }

    for (const [name, payload] of Object.entries(bad)) {
      const reply = await call('POST', '/start', payload)
      assert.equal(reply.code, 400, name)
      assert.equal(reply.body.status, 'error', name)
    }

    assert.equal((await call('POST', '/start', '{not json')).code, 400)
    assert.equal((await call('POST', '/start', '[1, 2]')).code, 400)
  } finally {
    close()
  }
})

test('send refuses a busy thread with 409 unless queue is set, and an unknown thread is 404', async () => {
  const { call, close } = await serve()

  try {
    const { threadId } = (await call('POST', '/start', body('SLOW first'))).body

    assert.equal((await call('POST', '/send', { threadId, text: 'second' })).code, 409)

    const queued = await call('POST', '/send', { threadId, text: 'second', queue: true })
    assert.equal(queued.code, 200)
    assert.equal(queued.body.status, 'queued')

    assert.equal((await call('POST', '/send', { threadId: 'thr_99', text: 'x' })).code, 404)
    assert.equal((await call('POST', '/send', { threadId, text: 'x', queue: 'yes' })).code, 400)
    assert.equal((await call('POST', '/send', { threadId, text: '' })).code, 400)
  } finally {
    close()
  }
})

test('approve, read, interrupt, close and status round-trip over the socket', async () => {
  const { call, close } = await serve()

  try {
    const { threadId } = (await call('POST', '/start', body('ASK socket'))).body

    for (let i = 0; i < 300; i++) {
      const list = (await call('GET', '/status')).body.threads
      if (list[0]?.status === 'needs-you') {
        break
      }

      await sleep(10)
    }

    const status = await call('GET', '/status')
    assert.equal(status.code, 200)
    assert.equal(status.body.threads[0].pendingApproval.method, 'item/commandExecution/requestApproval')

    assert.equal((await call('POST', '/approve', { threadId, decision: 'maybe' })).code, 400)
    assert.equal((await call('POST', '/approve', { threadId, decision: 'decline' })).code, 200)

    const read = await call('POST', '/read', { threadId })
    assert.equal(read.code, 200)
    assert.ok(Array.isArray(read.body.activity))
    assert.equal((await call('POST', '/read', { threadId: 'thr_99' })).code, 404)
    assert.equal((await call('POST', '/read', {})).code, 400)

    // A second thread, held until interrupted, for the interrupt route.
    const held = (await call('POST', '/start', body('HOLD socket'))).body.threadId
    assert.equal((await call('POST', '/interrupt', { threadId: held })).code, 200)
    assert.equal((await call('POST', '/close', { threadId: held })).code, 200)
    assert.equal((await call('POST', '/close', { threadId: held })).code, 404)
    assert.equal((await call('POST', '/close', { threadId })).code, 200)
    assert.deepEqual((await call('GET', '/status')).body.threads, [])
  } finally {
    close()
  }
})

test('unknown routes are 404, a wrong method is 405', async () => {
  const { call, close } = await serve()

  try {
    assert.equal((await call('POST', '/nope', {})).code, 404)
    assert.equal((await call('GET', '/start')).code, 405)
    assert.equal((await call('POST', '/status', {})).code, 405)
  } finally {
    close()
  }
})
