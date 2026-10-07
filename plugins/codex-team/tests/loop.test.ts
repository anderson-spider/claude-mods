import { expect, test } from 'claude-code/testing'
import { fixTask, qaFocus } from '../hooks/prompts'
import type { Loop } from '../hooks/model'
import { createBook } from '../hooks/book'
import { loopStart, runLoop } from '../hooks/loop'
import { loopAgentName } from '../hooks/names'
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

test('a loop fails before the next dev round when its dev pane now runs another terminal', async () => {
  const state = loopWith(['dev report', 'A finding above the verdict\nVERDICT: CHANGES'])
  const list = state.deps.herdr.list
  // Once QA has started, the dev agent's pane runs another terminal (a Herdr restart reused the pane id).
  state.deps.herdr.list = async () => {
    const agents = await list()
    return state.prompts.length < 2 ? agents : agents.map(agent => (agent.name.endsWith('-dev') ? { ...agent, terminal: 'term-moved' } : agent))
  }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('failed')
  expect(state.prompts).toHaveLength(2)
  expect(loop.error).toContain(`dev 2: ${loopAgentName(loop.id, 'dev')} failed: pane`)
  expect(loop.error).toContain('the prompt was not sent.')
})
