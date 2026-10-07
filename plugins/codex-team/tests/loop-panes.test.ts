import { expect, test } from 'claude-code/testing'
import { HerdrError } from '../hooks/model'
import type { Job, Loop } from '../hooks/model'
import { createBook } from '../hooks/book'
import { cancelLoop, runLoop } from '../hooks/loop'
import { request, pause, loopWith, loopRequest } from './helpers'

test('finished loops close both role panes after writing the report and notifying', async () => {
  for (const [verdict, status] of [['VERDICT: APPROVED', 'approved'], ['VERDICT: CHANGES', 'exhausted'], ['no verdict', 'failed']]) {
    const state = loopWith(['dev', verdict])
    const close = state.deps.herdr.close
    state.deps.herdr.close = async pane => {
      expect(state.files['/tmp/codex-team/loop-1.md']).toContain(`Status: ${status}`)
      expect(state.events).toEqual([`loop 1 ${status}`])
      await close(pane)
    }
    const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(1), status: 'developing', rounds: [], startedAt: 0 }
    await runLoop(state.deps, loop, state.book)
    expect(loop.status).toBe(status)
    expect(state.calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2'])
    expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2', 'close w1:p3'])
  }
})

test('a finished loop clears the last pane so the next job starts below the lead', async () => {
  const state = loopWith(['dev', 'VERDICT: APPROVED', 'next job'])
  const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(1), status: 'developing', rounds: [], startedAt: 0 }
  await runLoop(state.deps, loop, state.book)
  const next = await state.book.start(request('review'))
  await state.book.ended(next.id)
  expect(next.status).toBe('done')
  expect(state.calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2', 'split down'])
})

test('a review opening during the last loop pane close waits and then starts below the lead', async () => {
  let closing = false
  let release = () => {}
  const gate = new Promise<void>(done => (release = done))
  const state = loopWith(['dev', 'VERDICT: APPROVED', 'next review'])
  const close = state.deps.herdr.close
  state.deps.herdr.close = async pane => {
    if (pane === 'w1:p3') { closing = true; await gate }
    await close(pane)
  }
  const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(1), status: 'developing', rounds: [], startedAt: 0 }
  const running = runLoop(state.deps, loop, state.book)
  let next: Job | undefined
  try {
    for (let i = 0; i < 100 && !closing; i++) await pause(1)
    expect(closing).toBe(true)
    next = await state.book.start(request('review'))
    await pause(5)
    expect(state.calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2'])
  } finally {
    release()
    await running
    if (next) await state.book.ended(next.id)
  }
  expect(next!.status).toBe('done')
  expect(state.calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2', 'split down'])
})

test('closing older loop panes preserves a newer review as the row target', async () => {
  let release = () => {}
  // The newer review writes no report, so its pane stays open as the row target.
  const state = loopWith(['dev', 'VERDICT: APPROVED', undefined, 'next review'], {}, { 1: new Promise<void>(done => (release = done)) })
  const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(1), status: 'developing', rounds: [], startedAt: 0 }
  const running = runLoop(state.deps, loop, state.book)
  try {
    for (let i = 0; i < 100 && state.prompts.length < 2; i++) await pause(1)
    expect(state.prompts.length).toBe(2)
    const review = await state.book.start(request('review'))
    await state.book.ended(review.id)
  } finally {
    release()
    await running
  }
  const next = await state.book.start(request('review'))
  await state.book.ended(next.id)
  expect(state.calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2', 'split right w1:p3', 'split right w1:p4'])
  expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2', 'close w1:p3', 'close w1:p5'])
})

test('a failed dev closes only its pane and waits until its agent stops', async () => {
  let release = () => {}
  const gate = new Promise<void>(done => (release = done))
  const state = loopWith(['dev'], { prompt: [new Error('prompt failed')] })
  state.deps.herdr.wait = async (name, _timeout, until) => {
    state.calls.push(`wait ${name} until ${until?.join('|')}`)
    await gate
    return 'idle'
  }
  const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(), status: 'developing', rounds: [], startedAt: 0 }
  const running = runLoop(state.deps, loop, state.book)
  try {
    await state.finished(loop)
    await pause(5)
    expect(loop.status).toBe('failed')
    expect(state.calls).toContain('wait ct-1-dev until idle|done')
    expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
  } finally { release() }
  await running
  expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2'])
  expect(state.prompts.length).toBe(1)
})

test('a startup timeout waits for the role to stop before closing its pane', async () => {
  let release = () => {}
  const gate = new Promise<void>(done => (release = done))
  const state = loopWith([], { start: new HerdrError('agent_not_ready', 'startup is blocked') })
  let now = 0
  let stopping = false
  state.deps.now = () => now
  state.deps.herdr.wait = async (_name, _timeout, until) => {
    if (until?.includes('working')) {
      now = 30 * 60_000
      throw new HerdrError('timeout', 'still starting')
    }
    stopping = true
    await gate
    return 'idle'
  }
  const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(), status: 'developing', rounds: [], startedAt: 0 }
  const book = createBook({ ...state.deps, notify: () => {} })
  const running = runLoop(state.deps, loop, book)
  try {
    await state.finished(loop)
    await pause(5)
    expect(loop.status).toBe('failed')
    expect(stopping).toBe(true)
    expect(state.prompts).toEqual([])
    expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
  } finally { release() }
  await running
  expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2'])
})

test('a close failure preserves every loop outcome and its final notification', async () => {
  for (const [verdict, status] of [['VERDICT: APPROVED', 'approved'], ['VERDICT: CHANGES', 'exhausted'], ['no verdict', 'failed']]) {
    const state = loopWith(['dev', verdict], { close: new Error('cannot close') })
    const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(1), status: 'developing', rounds: [], startedAt: 0 }
    await runLoop(state.deps, loop, state.book)
    expect(loop.status).toBe(status)
    expect(loop.error).not.toContain('cannot close')
    expect(state.events).toEqual([`loop 1 ${status}`])
    expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2', 'close w1:p3'])
  }
})

test('a cancelled loop still notifies and attempts both closes when closing fails', async () => {
  let release = () => {}
  const state = loopWith(['dev', 'VERDICT: APPROVED'], { close: new Error('cannot close') }, { 1: new Promise<void>(done => (release = done)) })
  const close = state.deps.herdr.close
  state.deps.herdr.close = async pane => {
    expect(state.files['/tmp/codex-team/loop-1.md']).toContain('Status: cancelled')
    expect(state.events).toEqual(['loop 1 cancelled'])
    await close(pane)
  }
  const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(), status: 'developing', rounds: [], startedAt: 0 }
  const running = runLoop(state.deps, loop, state.book)
  try {
    for (let i = 0; i < 100 && state.prompts.length < 2; i++) await pause(1)
    expect(state.prompts.length).toBe(2)
    await cancelLoop(state.deps, state.book, loop)
    expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
  } finally { release() }
  await running
  expect(loop.status).toBe('cancelled')
  expect(loop.error).not.toContain('cannot close')
  expect(state.events).toEqual(['loop 1 cancelled'])
  expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2', 'close w1:p3'])
})

test('loop cleanup also runs after a report read or final write exception', async () => {
  for (const phase of ['read', 'write']) {
    const state = loopWith(['dev', 'VERDICT: APPROVED'])
    const read = state.deps.files.read
    let reads = 0
    state.deps.files.read = async path => {
      if (++reads === 3 && phase === 'read') throw new Error('read failed')
      return read(path)
    }
    const write = state.deps.files.write
    state.deps.files.write = async (path, text) => {
      if (path.endsWith('loop-1.md') && phase === 'write') throw new Error('write failed')
      await write(path, text)
    }
    const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(), status: 'developing', rounds: [], startedAt: 0 }
    await runLoop(state.deps, loop, state.book)
    expect(loop.status).toBe('failed')
    expect(loop.error).toContain(`${phase} failed`)
    expect(state.events).toEqual(['loop 1 failed'])
    expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2', 'close w1:p3'])
  }
})

test('a notification failure still closes the loop panes', async () => {
  const state = loopWith(['dev', 'VERDICT: APPROVED'])
  state.deps.notify = () => { state.events.push('notification attempted'); throw new Error('notify failed') }
  const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(), status: 'developing', rounds: [], startedAt: 0 }
  await runLoop(state.deps, loop, state.book)
  expect(loop.status).toBe('approved')
  expect(state.events).toEqual(['notification attempted'])
  expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2', 'close w1:p3'])
})

test('a loop preserves its status and report when its panes no longer match', async () => {
  for (const [verdict, status] of [['VERDICT: APPROVED', 'approved'], ['VERDICT: CHANGES', 'exhausted'], ['no verdict', 'failed']]) {
    const state = loopWith(['dev', verdict])
    const list = state.deps.herdr.list
    // The panes stop matching only after both phases ran: the final closes must then be skipped.
    state.deps.herdr.list = async () => (state.prompts.length < 2 ? list() : [{ name: 'ct-other', pane: 'w1:p2' }, { name: 'ct-1-qa', pane: 'w9:p9' }])
    const loop: Loop = { id: 1, ...loopRequest(1), status: 'developing', rounds: [], startedAt: 0 }
    await runLoop(state.deps, loop, state.book)
    expect(loop.status).toBe(status)
    expect(state.files[loop.report!]).toContain(`Status: ${status}`)
    expect(state.events).toEqual([`loop 1 ${status}`])
    expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
    await state.deps.layout.open(state.deps.herdr)
    expect(state.calls.filter(call => call.startsWith('split')).at(-1)).toBe('split down')
  }
})
