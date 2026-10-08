import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

import { AppServerClient } from '../lib/app-server-client.mjs'
import { FAKE, fakeClient, waitFor } from './support.mjs'

test('handshake: initialize answers, and initialized arrives before any other request', async () => {
  const client = fakeClient()
  const init = await client.start()

  assert.equal(init.userAgent, 'fake-codex/0.0')
  assert.equal((await client.request('fake/probe')).initialized, true)
})

test('the spawn function is injected, so the command and args are the caller choice', async () => {
  const calls = []
  const client = new AppServerClient({
    command: 'codex',
    args: ['app-server'],
    spawn: (command, args, options) => {
      calls.push([command, args])

      return spawn(process.execPath, [FAKE], options)
    },
  })

  try {
    await client.start()
    assert.deepEqual(calls, [['codex', ['app-server']]])
  } finally {
    client.close()
  }
})

test('notifications reach the handlers in the order the server sent them', async () => {
  const client = fakeClient()
  const seen = []
  client.onNotification(method => seen.push(method))
  await client.start()

  const { thread } = await client.request('thread/start', { cwd: '/tmp' })
  await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'hi' }] })
  await waitFor(() => seen.includes('turn/completed'))

  assert.ok(seen.indexOf('turn/started') < seen.indexOf('turn/completed'))
})

test('a server request is answered with respond, and the turn it held goes on', async () => {
  const client = fakeClient()
  const asked = []
  const replies = []
  client.onServerRequest(request => asked.push(request))
  client.onNotification((method, params) => {
    if (method === 'fake/reply') {
      replies.push(params)
    }
  })
  await client.start()
  const { thread } = await client.request('thread/start', { cwd: '/tmp' })
  await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'ASK please' }] })

  const request = await waitFor(() => asked[0])
  assert.equal(request.method, 'item/commandExecution/requestApproval')
  assert.equal(request.params.command, 'rm -rf build')
  client.respond(request.id, { decision: 'accept' })

  await waitFor(() => replies.length === 1)
  assert.deepEqual(replies[0].result, { decision: 'accept' })
})

test('a server request is answered with respondError, as a JSON-RPC error', async () => {
  const client = fakeClient()
  const replies = []
  client.onServerRequest(request => client.respondError(request.id, -32000, 'not today'))
  client.onNotification((method, params) => {
    if (method === 'fake/reply') {
      replies.push(params)
    }
  })
  await client.start()
  const { thread } = await client.request('thread/start', { cwd: '/tmp' })
  await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'ASK no' }] })

  await waitFor(() => replies.length === 1)
  assert.deepEqual(replies[0].error, { code: -32000, message: 'not today' })
})

test('a server request with no handler is refused with method-not-found, so nothing hangs', async () => {
  const client = fakeClient()
  const replies = []
  client.onNotification((method, params) => {
    if (method === 'fake/reply') {
      replies.push(params)
    }
  })
  await client.start()
  const { thread } = await client.request('thread/start', { cwd: '/tmp' })
  await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'ASK unhandled' }] })

  await waitFor(() => replies.length === 1)
  assert.equal(replies[0].error.code, -32601)
})

test('a request times out, and a child that exits fails what is still waiting', async () => {
  const client = fakeClient()
  const exits = []
  client.onExit(reason => exits.push(reason))
  await client.start()

  await assert.rejects(client.request('fake/silent', {}, 50), /fake\/silent timed out after 50 ms/)
  await assert.rejects(client.request('fake/exit'), /codex app-server exited/)

  assert.equal(client.isAlive, false)
  assert.equal(exits.length, 1)
  assert.match(exits[0], /codex app-server exited/)
  await assert.rejects(client.request('fake/probe'), /codex app-server exited/)
})

test('a command that cannot start rejects start with a clear message', async () => {
  const client = new AppServerClient({ command: '/nonexistent/codex' })

  await assert.rejects(client.start(), /could not start codex app-server/)
})

test('close fails the requests still waiting and refuses new ones', async () => {
  const client = fakeClient()
  await client.start()
  const waiting = client.request('fake/silent')
  client.close()

  await assert.rejects(waiting, /closed by the helper/)
  await assert.rejects(client.request('fake/probe'), /closed by the helper/)
})
