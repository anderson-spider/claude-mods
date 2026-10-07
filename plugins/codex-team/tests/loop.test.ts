import { expect, test } from 'claude-code/testing'
import { fixTask, qaFocus } from '../hooks/prompts'
import { HerdrError } from '../hooks/model'
import type { Job, Loop } from '../hooks/model'
import { createBook } from '../hooks/book'
import { cancelLoop, loopStart, runLoop } from '../hooks/loop'
import { loopReport } from '../hooks/presentation'
import { request, pause, loopWith, loopRequest } from './helpers'
import type { Script } from './helpers'

test('loop approves after one dev and QA and notifies only once', async () => {
  const state = loopWith(['dev report', 'A finding above the verdict\nVERDICT: APPROVED'])
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('approved')
  expect(loop.rounds).toEqual([{ dev: 2, qa: 3, verdict: 'approved' }])
  expect(state.events).toEqual(['loop 1 approved'])
  expect(state.prompts[0]).toContain('a.ts')
  expect(state.prompts[1]).toContain(qaFocus('add X'))
  expect(loop.report).toBe('/tmp/codex-team/loop-1.md')
  expect(state.files[loop.report!]).toContain('ct-1-dev')
  expect(state.files[loop.report!]).toContain('/tmp/codex-team/1-qa1.md')
})

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

test('loop sends changes back to dev with the original task and the QA report path', async () => {
  const state = loopWith(['dev', 'fix this\nVERDICT: CHANGES', 'fixed', 'VERDICT: APPROVED'])
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('approved')
  expect(loop.rounds).toEqual([{ dev: 2, qa: 3, verdict: 'changes' }, { dev: 4, qa: 5, verdict: 'approved' }])
  expect(state.prompts[2]).toContain(fixTask('add X', '/tmp/codex-team/1-qa1.md'))
  expect(state.events).toEqual(['loop 1 approved'])
})

test('loop exhausts maxRounds and writes the last QA findings', async () => {
  const state = loopWith(['dev', 'first\nVERDICT: CHANGES', 'dev', 'last actionable finding\nVERDICT: CHANGES'])
  const loop = await loopStart(state.deps, state.book, loopRequest(2))
  await state.finished(loop)
  expect(loop.status).toBe('exhausted')
  expect(state.prompts.length).toBe(4)
  expect(state.files[loop.report!]).toContain('last actionable finding')
  expect(loopReport(loop, state.book)).toContain('2/2')
})

test('loop fails on a missing or invalid QA verdict and names its report path', async () => {
  for (const report of [undefined, '', 'no verdict', 'VERDICT: APPROVED\nextra', 'verdict: approved']) {
    const state = loopWith(['dev', report])
    const loop = await loopStart(state.deps, state.book, loopRequest())
    await state.finished(loop)
    expect(loop.status).toBe('failed')
    expect(loop.error).toContain('QA report has no VERDICT line')
    expect(loop.error).toContain('/tmp/codex-team/1-qa1.md')
    expect(state.prompts.length).toBe(2)
  }
})

test('loop fails naming the dev or QA phase and round when a child fails', async () => {
  for (const failureAt of [0, 3]) {
    const script: Script = { prompt: Array.from({ length: failureAt + 1 }, (_, i) => i === failureAt ? new Error('broken') : 'idle') }
    const state = loopWith(['dev', 'VERDICT: CHANGES', 'dev', 'VERDICT: APPROVED'], script)
    const loop = await loopStart(state.deps, state.book, loopRequest())
    await state.finished(loop)
    expect(loop.status).toBe('failed')
    expect(loop.error).toContain(failureAt === 0 ? 'dev 1' : 'qa 2')
    expect(loop.error).toContain('broken')
    expect(state.prompts.length).toBe(failureAt + 1)
    expect(state.calls.filter(call => call.startsWith('close'))).toEqual(failureAt === 0 ? ['close w1:p2'] : ['close w1:p2', 'close w1:p3'])
  }
})

test('loop reviews a dev with no report and keeps the note', async () => {
  const state = loopWith([undefined, 'VERDICT: APPROVED'])
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('approved')
  expect(loop.error).toContain('dev 1')
  expect(loop.error).toContain('no report')
})

test('a dev whose CHECKS fail skips QA and sends the dev back with its own report', async () => {
  const state = loopWith(['dev\nCHECKS: FAIL — 2 failing', 'dev fixed\nCHECKS: PASS — claude plugin test', 'A finding\nVERDICT: APPROVED'])
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('approved')
  expect(loop.rounds).toEqual([{ dev: 2, checks: 'fail' }, { dev: 3, qa: 4, verdict: 'approved', checks: 'pass' }])
  expect(state.prompts.length).toBe(3)
  expect(state.prompts[1]).toContain(fixTask('add X', '/tmp/codex-team/1-dev1.md', 'checks'))
  expect(state.prompts[2]).toContain(qaFocus('add X'))
  expect(loop.error).toContain('dev 1: CHECKS: FAIL, QA skipped')
  expect(state.files[loop.report!]).toContain('Checks: fail')
  expect(state.files[loop.report!]).toContain('Checks: pass')
  expect(state.events).toEqual(['loop 1 approved'])
})

test('a dev whose CHECKS are not run still runs QA and notes it', async () => {
  const state = loopWith(['dev\nCHECKS: NOT RUN — no tests here', 'VERDICT: APPROVED'])
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('approved')
  expect(loop.rounds).toEqual([{ dev: 2, qa: 3, verdict: 'approved', checks: 'not run' }])
  expect(state.prompts.length).toBe(2)
  expect(loop.error).toContain('dev 1: CHECKS: NOT RUN')
  expect(state.files[loop.report!]).toContain('Checks: not run')
})

test('failed CHECKS on the last round exhaust the loop without starting QA', async () => {
  const state = loopWith(['dev\nCHECKS: FAIL — broken'])
  const loop = await loopStart(state.deps, state.book, loopRequest(1))
  await state.finished(loop)
  expect(loop.status).toBe('exhausted')
  expect(loop.rounds).toEqual([{ dev: 2, checks: 'fail' }])
  expect(state.prompts.length).toBe(1)
  expect(loop.error).toContain('CHECKS: FAIL, QA skipped')
  expect(state.files[loop.report!]).not.toContain('Last QA findings')
})

test('failed CHECKS do not show QA findings from an earlier round', async () => {
  const state = loopWith(['dev', 'stale finding\nVERDICT: CHANGES', 'dev again\nCHECKS: FAIL — broken'])
  const loop = await loopStart(state.deps, state.book, loopRequest(2))
  await state.finished(loop)
  expect(loop.status).toBe('exhausted')
  expect(state.prompts.length).toBe(3)
  expect(state.files[loop.report!]).not.toContain('stale finding')
  expect(state.files[loop.report!]).not.toContain('Last QA findings')
})

test('loop children still notify when blocked without finishing messages', async () => {
  const state = loopWith(['dev', 'VERDICT: APPROVED'], { prompt: ['blocked', 'blocked'], wait: ['idle', 'idle'] })
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(state.events).toEqual(['blocked ct-1-dev', 'blocked ct-1-qa', 'loop 1 approved'])
})

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

test('loop holds one exclusive slot across every dev and QA round', async () => {
  let release = () => {}
  const state = loopWith(['dev', 'VERDICT: CHANGES', 'dev', 'VERDICT: APPROVED', 'other'], {}, { 1: new Promise<void>(done => (release = done)) })
  let slots = 0
  const exclusive = state.book.exclusive
  state.book.exclusive = task => { slots++; return exclusive(task) }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  for (let i = 0; i < 100 && state.prompts.length < 2; i++) await pause(1)
  const other = await state.book.start({ kind: 'execute', task: 'unrelated', files: [] })
  await pause(5)
  expect(other.status).toBe('queued')
  release()
  await state.finished(loop)
  await state.book.done(other.id)
  expect(slots).toBe(1)
  expect(state.prompts[2]).toContain('fix the findings')
  expect(state.prompts[3]).toContain('Acceptance criteria')
  expect(state.prompts[4]).toContain('unrelated')
})

test('runLoop never rejects if the queue or report write fails', async () => {
  for (const phase of ['queue', 'write']) {
    const state = loopWith(['dev', 'VERDICT: APPROVED'])
    if (phase === 'queue') state.book.exclusive = async () => { throw new Error('queue broken') }
    else state.deps.files.write = async () => { throw new Error('write broken') }
    const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(), status: 'developing', rounds: [], startedAt: 0 }
    await runLoop(state.deps, loop, state.book)
    expect(loop.status).toBe('failed')
    expect(loop.error).toContain(`${phase} broken`)
    expect(state.events).toEqual(['loop 1 failed'])
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

test('loop children cannot reuse a previous report when the new job writes none', async () => {
  const state = loopWith([undefined, undefined])
  state.files['/tmp/codex-team/1-dev1.md'] = 'old dev report'
  state.files['/tmp/codex-team/1-qa1.md'] = 'old QA report\nVERDICT: APPROVED'
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('failed')
  expect(loop.error).toContain('dev 1')
  expect(loop.error).toContain('no report')
  expect(loop.error).toContain('QA report has no VERDICT line: /tmp/codex-team/1-qa1.md')
  expect(state.book.get(3)?.report).toBe(undefined)
})

test('loop fails before starting a child if its old report cannot be invalidated', async () => {
  const state = loopWith(['dev', 'VERDICT: APPROVED'])
  const write = state.deps.files.write
  state.deps.files.write = async (path, text) => {
    if (path === '/tmp/codex-team/1-dev1.md') throw new Error('cannot prepare report')
    await write(path, text)
  }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('failed')
  expect(loop.error).toContain('dev 1')
  expect(loop.error).toContain('cannot prepare report')
  expect(state.calls.some(call => call.startsWith('start '))).toBe(false)
  expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
})

test('loop reuses exactly two named panes and agents and keeps all round reports', async () => {
  const state = loopWith(['dev one', 'first finding\nVERDICT: CHANGES', 'dev two', 'VERDICT: APPROVED'])
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('approved')
  expect(state.calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2'])
  expect(state.calls.filter(call => call.startsWith('start'))).toEqual([
    'start ct-1-dev w1:p2 -s workspace-write -a on-request',
    'start ct-1-qa w1:p3 -s read-only -a on-request',
  ])
  expect(state.calls.filter(call => call.startsWith('rename'))).toEqual(['rename w1:p2 loop-1 dev', 'rename w1:p3 loop-1 qa'])
  expect(state.calls.filter(call => call.startsWith('prompt'))).toEqual(['prompt ct-1-dev', 'prompt ct-1-qa', 'prompt ct-1-dev', 'prompt ct-1-qa'])
  expect(state.prompts[2]).toContain(fixTask('add X', '/tmp/codex-team/1-qa1.md'))
  expect(state.prompts[3]).toContain(qaFocus('add X'))
  for (const report of ['1-dev1', '1-qa1', '1-dev2', '1-qa2']) {
    expect(state.files[loop.report!]).toContain(`/tmp/codex-team/${report}.md`)
  }
  expect(state.files['/tmp/codex-team/1-dev1.md']).toBe('dev one')
  for (const id of [2, 3, 4, 5]) expect(state.files[loop.report!]).toContain(`job ct-${id}`)
})

test('loop creates QA only after dev finishes and ignores rename failures', async () => {
  let release = () => {}
  const state = loopWith(['dev', 'VERDICT: APPROVED'], { rename: new Error('cannot rename') }, { 0: new Promise<void>(done => (release = done)) })
  const loop = await loopStart(state.deps, state.book, loopRequest())
  try {
    for (let i = 0; i < 100 && !state.prompts.length; i++) await pause(1)
    expect(state.calls.filter(call => call.startsWith('start')).length).toBe(1)
    expect(state.calls.some(call => call.includes('ct-1-qa'))).toBe(false)
  } finally { release() }
  await state.finished(loop)
  expect(loop.status).toBe('approved')
})

test('every reused phase clears its own report before prompting and never accepts stale QA', async () => {
  const state = loopWith(['dev', 'VERDICT: CHANGES', 'fixed', undefined])
  for (const phase of ['dev', 'qa']) for (const round of [1, 2]) state.files[`/tmp/codex-team/1-${phase}${round}.md`] = 'stale\nVERDICT: APPROVED'
  const prompt = state.deps.herdr.prompt
  state.deps.herdr.prompt = async (...args) => {
    const path = args[1].match(/write your final report as Markdown to (.+) and answer/)![1]!
    expect(state.files[path]).toBe('')
    return prompt(...args)
  }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('failed')
  expect(loop.error).toContain('1-qa2.md')
  expect(state.files['/tmp/codex-team/1-qa1.md']).toBe('VERDICT: CHANGES')
})

test('loop agents are owned by the book and their id survives a reload', async () => {
  const state = loopWith(['dev', 'VERDICT: APPROVED'], { live: ['ct-7-dev', 'ct-7-qa'] })
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  state.deps.herdr.list = async () => state.book.jobs().map(j => ({ name: j.agent, pane: j.pane! }))
  expect(await state.book.orphans()).toEqual([])
  const reloaded = createBook({ ...state.deps, notify: () => {} })
  expect(await reloaded.reserveId()).toBe(2)
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

test('each reused phase gets a new 30 minute deadline with chunked waits', async () => {
  const state = loopWith(['dev', 'VERDICT: CHANGES', 'fixed', 'VERDICT: APPROVED'], {
    prompt: Array.from({ length: 4 }, () => new HerdrError('timeout', 'chunk')),
    wait: ['idle', 'idle', 'idle', 'idle'],
  })
  let now = 0
  state.deps.now = () => now
  const prompt = state.deps.herdr.prompt
  const limits: number[] = []
  state.deps.herdr.prompt = async (...args) => {
    limits.push(args[2])
    now += 20 * 60_000
    return prompt(...args)
  }
  const loop = await loopStart(state.deps, createBook({ ...state.deps, notify: () => {} }), loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('approved')
  expect(limits).toEqual([540_000, 540_000, 540_000, 540_000])
  expect(state.calls.filter(call => call.startsWith('wait')).length).toBe(4)
})

test('a cancelled phase holds the execute slot after its deadline until the agent settles', async () => {
  let releasePrompt = () => {}
  let releaseStop = () => {}
  const promptGate = new Promise<void>(done => (releasePrompt = done))
  const stopGate = new Promise<void>(done => (releaseStop = done))
  const state = loopWith(['dev', 'other'], { prompt: ['blocked'] }, { 0: promptGate })
  let now = 0
  let waitingForStop = false
  state.deps.now = () => now
  state.deps.herdr.wait = async () => { waitingForStop = true; await stopGate; return 'idle' }
  const book = createBook({ ...state.deps, notify: () => {} })
  const loop = await loopStart(state.deps, book, loopRequest())
  try {
    for (let i = 0; i < 100 && !state.prompts.length; i++) await pause(1)
    await cancelLoop(state.deps, book, loop)
    now = 30 * 60_000
    releasePrompt()
    const other = await book.start(request())
    await pause(5)
    expect(other.status).toBe('queued')
    expect(waitingForStop).toBe(true)
    expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
    releaseStop()
    await state.finished(loop)
    expect((await book.done(other.id)).status).toBe('done')
    expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2', 'close w1:p3'])
  } finally { releasePrompt(); releaseStop() }
})

test('a report clear failure in a later round never prompts or restarts its reused agent', async () => {
  const state = loopWith(['dev', 'VERDICT: CHANGES', 'fixed'])
  const write = state.deps.files.write
  state.deps.files.write = async (path, text) => {
    if (path.endsWith('1-dev2.md')) throw new Error('cannot clear round two')
    await write(path, text)
  }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('failed')
  expect(loop.error).toContain('dev 2')
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


test('a loop preserves its status and report when its panes no longer match', async () => {
  for (const [verdict, status] of [['VERDICT: APPROVED', 'approved'], ['VERDICT: CHANGES', 'exhausted'], ['no verdict', 'failed']]) {
    const state = loopWith(['dev', verdict])
    state.deps.herdr.list = async () => [{ name: 'ct-other', pane: 'w1:p2' }, { name: 'ct-1-qa', pane: 'w9:p9' }]
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
