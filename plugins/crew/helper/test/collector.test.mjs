import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createCollector } from '../lib/collector.mjs'

const done = (collector, status = 'completed', error = null) => collector.feed('turn/completed', { turn: { status, error } })

test('the last agent message is the answer; files, commands and declined items are counted without output', () => {
  const c = createCollector()
  c.feed('item/completed', { item: { type: 'agentMessage', text: 'working' } })
  c.feed('item/completed', { item: { type: 'fileChange', status: 'completed', changes: [{ path: '/r/a.ts', kind: { type: 'add' } }] } })
  c.feed('item/completed', { item: { type: 'commandExecution', command: 'ls', status: 'completed', exitCode: 0, aggregatedOutput: 'SECRET' } })
  c.feed('item/completed', { item: { type: 'commandExecution', command: 'rm x', status: 'declined', exitCode: null } })
  c.feed('item/completed', { item: { type: 'fileChange', status: 'declined', changes: [{ path: '/o/b' }] } })
  c.feed('item/completed', { item: { type: 'agentMessage', text: 'final' } })
  assert.equal(c.finished, false)
  done(c)

  const result = c.result()
  assert.equal(c.finished, true)
  assert.equal(result.text, 'final')
  assert.equal(result.turn, 'completed')
  assert.equal(result.declined, 2)
  assert.deepEqual(result.files, [{ status: 'completed', paths: ['/r/a.ts'] }, { status: 'declined', paths: ['/o/b'] }])
  assert.deepEqual(result.commands.map(c => c.command), ['ls', 'rm x'])
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
})

test('a turn that has not ended reads as running, and a failed turn carries its error message', () => {
  const c = createCollector()
  assert.equal(c.result().turn, 'running')
  done(c, 'failed', { message: 'boom' })
  assert.equal(c.result().turn, 'failed')
  assert.equal(c.result().error, 'boom')
})

test('files and commands are capped so a long turn keeps a bounded record', () => {
  const c = createCollector()
  for (let i = 0; i < 300; i++) {
    c.feed('item/completed', { item: { type: 'commandExecution', command: `c${i}`, status: 'completed', exitCode: 0 } })
    c.feed('item/completed', { item: { type: 'fileChange', status: 'completed', changes: [{ path: `/f${i}` }] } })
  }
  assert.equal(c.result().commands.length, 50)
  assert.equal(c.result().files.length, 100)
})

test('what a turn keeps is bounded: the answer, the paths of a change and the length of a command', () => {
  const c = createCollector()
  c.feed('item/completed', { item: { type: 'agentMessage', text: 'x'.repeat(200_000) } })
  c.feed('item/completed', { item: { type: 'fileChange', status: 'completed', changes: Array.from({ length: 500 }, (_, i) => ({ path: `/${'p'.repeat(2000)}${i}` })) } })
  c.feed('item/completed', { item: { type: 'commandExecution', command: 'c'.repeat(5000), status: 'completed', exitCode: 0 } })
  const result = c.result()

  assert.equal(result.text.length, 100_000)
  assert.equal(result.files[0].paths.length, 20)
  assert.equal(result.files[0].paths[0].length, 512)
  assert.equal(result.commands[0].command.length, 512)
})
