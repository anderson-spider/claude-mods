import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RpcClient } from '../lib/rpc.mjs'
import { fakeChild, until } from './fake-server.mjs'

test('a request is answered by the response with its id, and an error response rejects with the method named', async () => {
  const fake = fakeChild({ handlers: { 'a/ok': () => ({ v: 1 }), 'a/bad': () => new Error('nope') } })
  const client = new RpcClient(fake.child)

  assert.deepEqual(await client.request('a/ok', { x: 1 }), { v: 1 })
  await assert.rejects(client.request('a/bad'), /a\/bad: nope/)
  assert.deepEqual(fake.params('a/ok'), [{ x: 1 }])
})

test('lines split across chunks and several messages in one chunk are read whole', async () => {
  const fake = fakeChild()
  const client = new RpcClient(fake.child)
  const seen = []
  client.onNotification((method, params) => seen.push([method, params]))
  const line = `${JSON.stringify({ method: 'n/one', params: { a: 1 } })}\n`
  fake.child.stdout.emit('data', line.slice(0, 7))
  fake.child.stdout.emit('data', `${line.slice(7)}${JSON.stringify({ method: 'n/two' })}\n\nnot json\n`)

  assert.deepEqual(seen, [['n/one', { a: 1 }], ['n/two', undefined]])
})

test('a server request is answered by the served function, and an unserved one gets an error response', async () => {
  const fake = fakeChild()
  const client = new RpcClient(fake.child)
  client.serve(method => (method === 'ask/yes' ? { decision: 'decline' } : undefined))
  fake.emit({ id: 7, method: 'ask/yes', params: {} })
  fake.emit({ id: 8, method: 'ask/other', params: {} })

  assert.deepEqual(fake.replies[0], { id: 7, result: { decision: 'decline' } })
  assert.equal(fake.replies[1].id, 8)
  assert.match(fake.replies[1].error.message, /not served/)
})

test('an exit rejects every pending request, closes the client and calls onExit once', async () => {
  const fake = fakeChild({ handlers: { 'a/hang': () => 'silent' } })
  const client = new RpcClient(fake.child)
  let exits = 0
  client.onExit(() => exits++)
  const pending = client.request('a/hang')
  await until(() => fake.methods().includes('a/hang'))
  fake.exit()
  fake.exit()

  await assert.rejects(pending, /exited/)
  await assert.rejects(client.request('a/more'), /not running/)
  assert.equal(client.closed, true)
  assert.equal(exits, 1)
})

test('close ends stdin, which is how the server is asked to stop', async () => {
  const fake = fakeChild()
  const client = new RpcClient(fake.child)
  client.close()
  await until(() => client.closed)

  assert.equal(fake.ended, true)
})
