import { expect, test } from 'claude-code/testing'
import { HerdrError } from '../hooks/model'
import { createBook } from '../hooks/book'
import { cancelLoop, loopStart } from '../hooks/loop'
import { request, pause, loopWith, loopRequest } from './helpers'

test('cancelling a loop during dev or QA cancels the active child and starts nothing more', async () => {
  for (const phase of [0, 1]) {
    let release = () => {}
    const gate = new Promise<void>(done => (release = done))
    const state = loopWith(['dev', 'VERDICT: CHANGES'], {}, { [phase]: gate })
    const loop = await loopStart(state.deps, state.book, loopRequest())
    for (let i = 0; i < 100 && state.prompts.length <= phase; i++) await pause(1)
    expect(loop.status).toBe(phase === 0 ? 'developing' : 'reviewing')
    expect(await cancelLoop(state.deps, state.book, loop)).toContain('cancelled')
    expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
    release()
    await state.finished(loop)
    expect(loop.status).toBe('cancelled')
    expect(state.calls).toContain(`keys ct-1-${phase === 0 ? 'dev' : 'qa'} esc`)
    expect(state.prompts.length).toBe(phase + 1)
    expect(state.events).toEqual(['loop 1 cancelled'])
    expect(state.calls.filter(call => call.startsWith('close'))).toEqual(phase === 0 ? ['close w1:p2'] : ['close w1:p2', 'close w1:p3'])
  }
})

test('cancelling the dev keeps another execute queued until its pending prompt settles', async () => {
  for (const parent of [false, true]) {
    let release = () => {}
    const gate = new Promise<void>(done => (release = done))
    const state = loopWith(['dev', 'other'], {}, { 0: gate })
    const loop = await loopStart(state.deps, state.book, loopRequest())
    for (let i = 0; i < 100 && !state.prompts.length; i++) await pause(1)
    expect(state.prompts.length).toBe(1)
    const dev = loop.rounds[0]!.dev
    if (parent) await cancelLoop(state.deps, state.book, loop)
    else await state.book.cancel(dev)
    expect((await state.book.done(dev)).status).toBe('cancelled')
    const other = await state.book.start({ kind: 'execute', task: 'unrelated', files: [] })
    try {
      await pause(5)
      expect(other.status).toBe('queued')
      expect(state.prompts.length).toBe(1)
    } finally {
      release()
    }
    await state.finished(loop)
    expect((await state.book.done(other.id)).status).toBe('done')
    expect(loop.status).toBe('cancelled')
    expect(state.prompts.length).toBe(2)
    expect(state.prompts[1]).toContain('unrelated')
  }
})

test('a failed Esc can be retried without releasing the dev slot before its prompt settles', async () => {
  let release = () => {}
  const gate = new Promise<void>(done => (release = done))
  const state = loopWith(['dev', 'other'], {}, { 0: gate })
  const sendKeys = state.deps.herdr.sendKeys
  let attempts = 0
  state.deps.herdr.sendKeys = async (...args) => {
    attempts++
    if (attempts === 1) throw new Error('transport failed')
    await sendKeys(...args)
  }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  for (let i = 0; i < 100 && !state.prompts.length; i++) await pause(1)
  expect(state.prompts.length).toBe(1)
  const dev = loop.rounds[0]!.dev
  let ended = false
  void state.book.ended(dev).then(() => { ended = true })
  try {
    expect(await state.book.cancel(dev)).toContain('transport failed')
    expect((await state.book.done(dev)).status).toBe('cancelled')
    expect(await state.book.cancel(dev)).toContain('Sent Esc')
    expect(attempts).toBe(2)
    expect((await state.book.done(dev)).status).toBe('cancelled')
    const other = await state.book.start({ kind: 'execute', task: 'unrelated', files: [] })
    await pause(5)
    expect(ended).toBe(false)
    expect(other.status).toBe('queued')
    expect(state.prompts.length).toBe(1)
    release()
    await state.book.ended(dev)
    await state.finished(loop)
    expect((await state.book.done(other.id)).status).toBe('done')
    expect(loop.status).toBe('cancelled')
    expect(state.prompts.length).toBe(2)
    expect(state.prompts[1]).toContain('unrelated')
    expect(await state.book.cancel(dev)).toContain('nothing to cancel')
    expect(attempts).toBe(2)
  } finally {
    release()
  }
})

test('a loop cancelled while its child starts never sends that child a task afterwards', async () => {
  for (const phase of [0, 1]) {
    for (const notReady of [false, true]) {
      for (const missing of [false, true]) {
        let release = () => {}
        let releaseStop = () => {}
        let starting = false
        let stopping = false
        const gate = new Promise<void>(done => (release = done))
        const stopGate = new Promise<void>(done => (releaseStop = done))
        const state = loopWith(['dev', 'VERDICT: APPROVED'])
        const wait = state.deps.herdr.wait
        state.deps.herdr.wait = async (...args) => { stopping = true; await stopGate; return wait(...args) }
        const start = state.deps.herdr.start
        state.deps.herdr.start = async (...args) => {
          if (args[0] !== `ct-1-${phase === 0 ? 'dev' : 'qa'}`) return start(...args)
          starting = true
          await gate
          if (notReady) throw new HerdrError('agent_not_ready', 'agent is still starting')
          await start(...args)
        }
        if (missing) state.deps.herdr.sendKeys = async () => { throw new HerdrError('agent_not_found', 'agent is still starting') }
        const loop = await loopStart(state.deps, state.book, loopRequest())
        for (let i = 0; i < 100 && !starting; i++) await pause(1)
        expect(starting).toBe(true)
        await cancelLoop(state.deps, state.book, loop)
        const child = phase === 0 ? loop.rounds[0]!.dev : loop.rounds[0]!.qa!
        const other = await state.book.start({ kind: 'execute', task: 'unrelated', files: [] })
        expect(other.status).toBe('queued')
        release()
        if (notReady) {
          for (let i = 0; i < 100 && !stopping; i++) await pause(1)
          expect(stopping).toBe(true)
          expect(other.status).toBe('queued')
          expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
        }
        releaseStop()
        await state.book.ended(child)
        await state.finished(loop)
        expect((await state.book.done(other.id)).status).toBe('done')
        expect(loop.status).toBe('cancelled')
        expect(state.calls.filter(call => call.startsWith(`wait ct-1-${phase === 0 ? 'dev' : 'qa'}`))).toEqual(notReady ? [`wait ct-1-${phase === 0 ? 'dev' : 'qa'} until idle|done`] : [])
        expect(state.calls.some(call => call.startsWith(`prompt ct-1-${phase === 0 ? 'dev' : 'qa'}`))).toBe(false)
        expect(state.prompts.length).toBe(phase + 1)
        expect(state.prompts[phase]).toContain('unrelated')
      }
    }
  }
})

test('a cancelled loop retries failed Esc while the reused phase still holds the slot', async () => {
  let release = () => {}
  const state = loopWith(['dev', 'VERDICT: CHANGES', 'fixed'], {}, { 2: new Promise<void>(done => (release = done)) })
  const sendKeys = state.deps.herdr.sendKeys
  let attempts = 0
  state.deps.herdr.sendKeys = async (...args) => {
    if (++attempts === 1) throw new Error('transport failed')
    await sendKeys(...args)
  }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  try {
    for (let i = 0; i < 100 && state.prompts.length < 3; i++) await pause(1)
    expect(await cancelLoop(state.deps, state.book, loop)).toContain('transport failed')
    expect(await cancelLoop(state.deps, state.book, loop)).toContain('Sent Esc to ct-1-dev')
    const other = await state.book.start(request())
    await pause(5)
    expect(other.status).toBe('queued')
    release()
    await state.finished(loop)
    await state.book.ended(other.id)
    expect(state.calls.filter(call => call.startsWith('start ct-1-dev')).length).toBe(1)
    expect(attempts).toBe(2)
    expect(loop.status).toBe('cancelled')
  } finally { release() }
})

test('cancelling while a reused phase clears its report sends no new prompt', async () => {
  let release = () => {}
  let clearing = false
  const gate = new Promise<void>(done => (release = done))
  const state = loopWith(['dev', 'VERDICT: CHANGES', 'fixed'])
  const write = state.deps.files.write
  state.deps.files.write = async (path, text) => {
    if (path.endsWith('1-dev2.md')) { clearing = true; await gate }
    await write(path, text)
  }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  try {
    for (let i = 0; i < 100 && !clearing; i++) await pause(1)
    expect(clearing).toBe(true)
    await cancelLoop(state.deps, state.book, loop)
  } finally { release() }
  await state.finished(loop)
  expect(loop.status).toBe('cancelled')
  expect(state.prompts.length).toBe(2)
  expect(state.calls.filter(call => call.startsWith('start')).length).toBe(2)
})

test('a cancelled loop keeps waiting through stop timeouts and permits Esc retries', async () => {
  let releasePrompt = () => {}
  let releaseStop = () => {}
  const state = loopWith(['dev', 'other'], { prompt: ['blocked'] }, { 0: new Promise<void>(done => (releasePrompt = done)) })
  const stopGate = new Promise<void>(done => (releaseStop = done))
  let now = 0
  let waits = 0
  state.deps.now = () => now
  state.deps.herdr.wait = async () => {
    if (++waits === 1) throw new HerdrError('timeout', 'not stopped yet')
    await stopGate
    return 'done'
  }
  const book = createBook({ ...state.deps, notify: () => {} })
  const loop = await loopStart(state.deps, book, loopRequest())
  try {
    for (let i = 0; i < 100 && !state.prompts.length; i++) await pause(1)
    await cancelLoop(state.deps, book, loop)
    now = 30 * 60_000
    releasePrompt()
    const other = await book.start(request())
    for (let i = 0; i < 100 && waits < 2; i++) await pause(1)
    expect(waits).toBe(2)
    expect(other.status).toBe('queued')
    expect(await cancelLoop(state.deps, book, loop)).toContain('Sent Esc')
    expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
    releaseStop()
    await state.finished(loop)
    await book.ended(other.id)
    expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2', 'close w1:p3'])
  } finally { releasePrompt(); releaseStop() }
})
