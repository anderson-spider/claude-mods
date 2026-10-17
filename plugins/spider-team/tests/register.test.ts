import { expect, test } from 'claude-code/testing'
import { call, drain, inference, LEDGER, listed, settle, spawn, started, step, world } from './host'
import { SPECS } from '../hooks/roles'
import { EMPTY, STATS_COMMAND, STATS_DESCRIPTION } from '../hooks/register'
import { refusal, UNCHECKED } from '../hooks/guard'
import { OFF_TEXT } from '../hooks/key'

const MARKER = 'SECRET-MARKER-7f3a'
function dispatched(on: Parameters<typeof world>[0], answer: unknown = { result: 'native answer' }) {
  const received: Record<string, unknown>[] = []
  on('tool.call', { tool: 'Agent' }, (_$, e) => { received.push(e as never); return answer as never })
  return received
}
const finished = (text: string, patch = {}) => ({
  ref: 'r', text: MARKER, result: {
    agentId: 'a1', status: 'completed', prompt: MARKER, resolvedModel: 'claude-opus-5-5', modelsUsed: ['claude-opus-5-5'], totalToolUseCount: 2, totalDurationMs: 42_000, totalTokens: 1650,
    worktreePath: `/private/${MARKER}`, worktreeBranch: `feature/${MARKER}`,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 500, cache_read_input_tokens: 1000, server_tool_use: null, service_tier: null, cache_creation: null },
    content: [{ type: 'text', text }], ...patch,
  },
})

test('session start registers the three native agents and the stats command, and no tools', async ($, on) => {
  const h = world(on); await started($)
  expect(h.specs.map(s => s.name)).toEqual(['analyst', 'planner', 'reviewer'])
  for (const spec of h.specs) expect(spec).toEqual(SPECS[spec.name as keyof typeof SPECS])
  expect(h.commands).toEqual([{ name: STATS_COMMAND, description: STATS_DESCRIPTION }])
  expect(STATS_COMMAND).toBe('spider-team-stats')
})
test('Jev picks the pair for a Spider role, shown in its description, and other agents pass untouched', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  await started($)
  expect(await settle($.tool.call(call() as never))).toHaveProperty('result', 'native answer')
  expect(received[0]).toMatchObject({ prompt: 'Private task', description: 'Fixture (haiku/medium)', model: 'haiku', effort: 'medium' })
  expect(h.requests).toHaveLength(1)
  const other = call('x', { subagent_type: 'Explore', model: 'fable', effort: 'max' })
  await settle($.tool.call(other as never)); expect(received[1]).toEqual(other); expect(h.requests).toHaveLength(1)
  expect(h.ledger()).toHaveLength(1)
})
test('a model or effort from the lead is overwritten by the Jev pair, or by the role default without a key', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  await settle($.tool.call(call('planner', { model: 'fable', effort: 'max' }) as never))
  expect(received[0]).toMatchObject({ model: 'opus', effort: 'medium', description: 'Fixture (opus/medium, default: no-key)' })
  await settle($.tool.call(call('analyst', { model: 'gpt', effort: 'ultra' }) as never))
  expect(received[1]).toMatchObject({ model: 'haiku', effort: 'high' })
  expect(h.requests).toHaveLength(0)
  h.env.JEV_API_KEY = 'test-key'
  // Difficulty 0 and duration 0 is haiku/medium for the analyst, and the planner floor lifts it to opus/low, whatever the lead asked for.
  await settle($.tool.call(call('analyst', { model: 'fable', effort: 'max' }) as never))
  expect(received[2]).toMatchObject({ model: 'haiku', effort: 'medium', description: 'Fixture (haiku/medium)' })
  await settle($.tool.call(call('planner', { model: 'haiku' }) as never))
  expect(received[3]).toMatchObject({ model: 'opus', effort: 'low' })
  expect(h.requests).toHaveLength(2)
})
test('Jev is asked both questions and bang and at-sign words reach it as written', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  h.answers.difficulty = { probabilities: { '3': 1 } }; h.answers.duration = { probabilities: { '2': 1 } }
  await started($)
  const prompt = 'Private task !hard !quick !long !difficulty=0 !duration=3 !bogus=9 @sonnet-high @opus'
  await settle($.tool.call(call('analyst', { prompt }) as never))
  expect(received[0]).toMatchObject({ prompt, model: 'opus', effort: 'medium' })
  const request = JSON.parse(h.requests[0]!.body)
  expect(Object.keys(request.questions)).toEqual(['difficulty', 'duration'])
  expect(request.state).toBe(prompt)
  expect(h.requests).toHaveLength(1)
})
// Regression: a marketplace install names the provider spider-team@<marketplace>, and an identity check on the
// spawn and the subagent's turns once refused every default spawn. Run that native path under that provider.
test('a default spawn of every role from a marketplace install runs natively with its role default', async ($, on) => {
  const h = world(on), received: Record<string, unknown>[] = [], answers: string[] = []
  on('turn.step', inference)
  on('agent.spawn', async (_$, e) => {
    answers.push((await drain($.turn.step(step(e.tool_use_id, e.model as string, 'medium') as never) as never)).answer)
    return { agentId: e.tool_use_id, model: e.model as string }
  })
  on('tool.call', { tool: 'Agent' }, async (_$, e) => {
    const c = e as unknown as { tool_use_id: string; subagent_type: string; model: string }
    received.push(e as never)
    await $.agent.spawn(spawn(c.tool_use_id, c.subagent_type, c.model) as never)
    return { result: 'native answer' } as never
  })
  await started($)
  const roles = ['analyst', 'planner', 'reviewer'] as const
  for (const role of roles) {
    const answer = await settle($.tool.call(call(role, { tool_use_id: role }) as never))
    expect(answer).not.toHaveProperty('deny'); expect(answer).toHaveProperty('result', 'native answer')
  }
  expect(answers).toEqual(roles.map(() => 'native answer'))
  expect(received.map(r => [r.subagent_type, r.model, r.effort])).toEqual([['spider-team:analyst', 'haiku', 'high'], ['spider-team:planner', 'opus', 'medium'], ['spider-team:reviewer', 'opus', 'medium']])
  expect(h.requests).toHaveLength(0)
})
test('empty tasks are refused before dispatch, and the retired developer and architect pass untouched', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  for (const prompt of ['', ' \n\t ']) expect((await settle($.tool.call(call('analyst', { prompt }) as never))).deny).toBe(EMPTY)
  expect(received).toHaveLength(0)
  expect(h.written).toHaveLength(0)
  for (const role of ['developer', 'architect']) {
    const retired = call(role, { model: 'fable', effort: 'max', prompt: '' })
    await settle($.tool.call(retired as never)); expect(received.at(-1)).toEqual(retired)
  }
  expect(h.written).toHaveLength(0)
})
test('a routing failure dispatches the role default once, never the lead model and effort, and writes no record', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  Object.defineProperty(h.io, 'root', { get: () => { throw new Error('root unavailable') } })
  for (const role of ['analyst', 'planner', 'reviewer'] as const) {
    const e = call(role, { model: 'opus', effort: 'max', tool_use_id: role })
    expect(await settle($.tool.call(e as never))).toHaveProperty('result', 'native answer')
    const model = role === 'analyst' ? 'haiku' : 'opus', effort = role === 'analyst' ? 'high' : 'medium'
    expect(received.at(-1)).toEqual({ ...e, model, effort, description: `Fixture (${model}/${effort})` })
  }
  expect(received).toHaveLength(3)
  expect(h.written).toHaveLength(0)
  expect(h.logs).toContain('spider-team: routing failed; dispatching the role default.')
})
test('a decision line and a foreground outcome line are written, and the host result passes on as it came', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  h.answers.difficulty = { probabilities: { '0': 1 } }; h.answers.duration = { probabilities: { '0': 1 } }
  const answer = finished(`Verdict: CHANGES\n${MARKER}`)
  dispatched(on, answer)
  await started($)
  const result = await settle($.tool.call(call('reviewer', { tool_use_id: 'toolu_9' }) as never))
  expect(result).toEqual(answer)
  const [decision, outcome] = h.ledger() as [Record<string, any>, Record<string, any>]
  expect(decision).toMatchObject({
    v: 1, kind: 'decision', tool_use_id: 'toolu_9', role: 'reviewer', source: 'jev', jevReason: null,
    levels: { difficulty: 0, duration: 0 }, top: { difficulty: 1, duration: 1 },
    dist: { difficulty: { '0': 1, '1': 0, '2': 0, '3': 0, '4': 0 }, duration: { '0': 1, '1': 0, '2': 0, '3': 0 } },
    cell: 'haiku/medium', floorApplied: true, model: 'opus', effort: 'low',
  })
  expect(decision.jevMs).toBeGreaterThanOrEqual(0)
  expect(decision.ts).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/)
  expect(outcome).toMatchObject({
    v: 1, kind: 'outcome', tool_use_id: 'toolu_9', role: 'reviewer', model: 'opus', effort: 'low', mode: 'foreground', resolvedModel: 'claude-opus-5-5', modelsUsed: 1,
    status: 'completed', aborted: false, durationMs: 42_000, tokens: { input: 100, output: 50, cacheCreation: 500, cacheRead: 1000 }, verdict: 'CHANGES',
  })
  expect(outcome.costUsd).toBe(0.0041)
  expect(h.ledger()).toHaveLength(2)
  // A default fallback records its reason and no latency.
  delete h.env.JEV_API_KEY
  await settle($.tool.call(call('analyst', { tool_use_id: 'toolu_10' }) as never))
  expect(h.ledger()[2]).toMatchObject({ kind: 'decision', source: 'default', jevReason: 'no-key', jevMs: null, levels: null, top: null, dist: null, cell: null, floorApplied: false, model: 'haiku', effort: 'high' })
})
test('a background launch is written when its turn completes, with the verdict from the final text', async ($, on) => {
  const h = world(on)
  const launched = { ref: 'r', text: MARKER, result: { status: 'async_launched', agentId: 'bg-1', description: MARKER, prompt: MARKER, outputFile: `/tmp/${MARKER}` } }
  dispatched(on, launched)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await started($)
  expect(await settle($.tool.call(call('reviewer', { tool_use_id: 'toolu_bg' }) as never))).toEqual(launched)
  expect(h.ledger().map(l => l.kind)).toEqual(['decision'])
  const done = { turnId: 't1', agentId: 'bg-1', answer: `${MARKER}\nVerdict: BLOCKED`, durationMs: 7000, isAborted: false, reason: 'answer', usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
  // An unrelated agent's turn and the main loop's turn write nothing.
  await settle($.turn.complete({ ...done, agentId: 'other' } as never))
  await settle($.turn.complete({ ...done, agentId: undefined } as never))
  expect(h.ledger()).toHaveLength(1)
  expect(await settle($.turn.complete(done as never))).toEqual({ text: done.answer })
  expect(h.ledger()[1]).toMatchObject({ kind: 'outcome', tool_use_id: 'toolu_bg', role: 'reviewer', mode: 'background', status: 'completed', durationMs: 7000, tokens: { input: 10, output: 5, cacheCreation: 0, cacheRead: 0 }, verdict: 'BLOCKED' })
  // Each agent writes once.
  await settle($.turn.complete(done as never))
  expect(h.ledger()).toHaveLength(2)
})
test('an aborted background agent is an aborted outcome', async ($, on) => {
  const h = world(on)
  dispatched(on, { result: { status: 'async_launched', agentId: 'bg-2' } })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await started($)
  await settle($.tool.call(call('planner', { tool_use_id: 'toolu_a' }) as never))
  await settle($.turn.complete({ turnId: 't', agentId: 'bg-2', answer: '', durationMs: 900, isAborted: true, reason: 'aborted' } as never))
  expect(h.ledger()[1]).toMatchObject({ kind: 'outcome', status: 'aborted', aborted: true, verdict: null, tokens: null })
})
test('no line ever holds the task, a prompt, an answer, a path, a branch or the key', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  // Jev's answers carry extra text beside the probabilities; only the projected numbers reach the line.
  h.answers.difficulty = { probabilities: { '2': 0.6, '3': 0.4 }, reason: MARKER, [MARKER]: 1 }; h.answers.duration = { probabilities: { '1': 1 }, note: `/home/u/private/${MARKER}` }
  dispatched(on, finished(`${MARKER} Verdict: APPROVED`, { prompt: MARKER }))
  await started($)
  await settle($.tool.call(call('reviewer', { prompt: `Review ${MARKER} at /home/u/private/${MARKER} on branch feature/${MARKER} with test-key`, description: `Fixture ${MARKER}`, name: MARKER }) as never))
  expect(h.written.length).toBeGreaterThan(0)
  for (const text of [...h.written, ...h.files.values()]) {
    expect(text).not.toContain(MARKER); expect(text).not.toContain('/private'); expect(text).not.toContain('/home/u/'); expect(text).not.toContain('test-key'); expect(text).not.toContain('Review')
  }
  expect(h.ledger()[0]).toMatchObject({ source: 'jev', levels: { difficulty: 2, duration: 1 }, dist: { difficulty: { '0': 0, '1': 0, '2': 0.6, '3': 0.4, '4': 0 }, duration: { '0': 0, '1': 1, '2': 0, '3': 0 } } })
  expect(h.ledger()[1]).toMatchObject({ verdict: 'APPROVED' })
})
test('observation survives a failing ledger: the dispatch and its result are unchanged and one debug line names the miss', async ($, on) => {
  const h = world(on), answer = finished('Verdict: APPROVED')
  const received = dispatched(on, answer)
  await started($)
  h.fsFaults.write = true
  expect(await settle($.tool.call(call('reviewer') as never))).toEqual(answer)
  expect(received[0]).toMatchObject({ model: 'opus', effort: 'medium' })
  expect(h.logs.filter(line => line.endsWith('not recorded'))).toEqual(['spider-team: decision not recorded', 'spider-team: outcome not recorded'])
  h.fsFaults.write = false
  // A ledger that cannot be read is not overwritten either.
  h.files.set(LEDGER, '{"keep":"me"}\n'); h.fsFaults.read = true
  expect(await settle($.tool.call(call('reviewer') as never))).toEqual(answer)
  expect(h.files.get(LEDGER)).toBe('{"keep":"me"}\n')
  // A host without HOME writes nothing and still dispatches.
  h.fsFaults.read = false; delete h.env.HOME; h.written.length = 0
  expect(await settle($.tool.call(call('reviewer') as never))).toEqual(answer)
  expect(h.written).toHaveLength(0)
})
test('a refused or failed Agent result writes no outcome and passes on', async ($, on) => {
  const h = world(on)
  const error = { ref: 'r', result: 'boom', isError: true, text: 'boom' }
  dispatched(on, error)
  await started($)
  expect(await settle($.tool.call(call('analyst') as never))).toEqual(error)
  expect(h.ledger().map(l => [l.kind, l.status ?? null])).toEqual([['decision', null], ['outcome', 'error']])
})
test('the stats command summarizes the local ledger, and says so when there is none or it cannot be read', async ($, on) => {
  const h = world(on); dispatched(on, finished('Verdict: APPROVED')); await started($)
  const off = `Jev access in this session: off (no-key). ${OFF_TEXT['no-key']}`
  expect((await $.command.run({ command: STATS_COMMAND } as never)).text).toBe(`${off}\nno routing records yet in ~/.claude/spider-team/routes.jsonl.`)
  await settle($.tool.call(call('reviewer', { tool_use_id: 'toolu_s' }) as never))
  const text = (await $.command.run({ command: STATS_COMMAND, args: 'ignored' } as never)).text!
  expect(text.startsWith(`${off}\n1 decisions, 1 outcomes`)).toBe(true); expect(text).toContain('reviewer'); expect(text).toContain('opus/medium'); expect(text).toContain('Default fallbacks: 1 of 1')
  expect(text).not.toContain('/home/u')
  h.fsFaults.read = true
  expect((await $.command.run({ command: STATS_COMMAND } as never)).text).toBe(`${off}\nthe routing records could not be read.`)
  h.fsFaults.read = false; delete h.env.HOME
  expect((await $.command.run({ command: STATS_COMMAND } as never)).text).toBe(`${off}\nno home directory, so no routing records.`)
})
test('the stats command checks Jev access in this session the way routing does, and never prints the key', async ($, on) => {
  const h = world(on); await started($)
  const first = async () => (await $.command.run({ command: STATS_COMMAND } as never)).text!.split('\n')[0]
  h.env.JEV_API_KEY = 'test-key'
  expect(await first()).toBe('Jev access in this session: ok.')
  h.env.JEV_API_KEY = 'two words'
  expect(await first()).toBe(`Jev access in this session: off (bad-key). ${OFF_TEXT['bad-key']}`)
  h.env.JEV_API_KEY = 'test-key'; h.faults.settings = true
  expect(await first()).toBe(`Jev access in this session: off (unreadable-settings). ${OFF_TEXT['unreadable-settings']}`)
  for (const text of [await first(), ...h.logs]) expect(text).not.toContain('test-key')
})
test('a key problem shows one toast per reason in this load and the reason beside the pair; a Jev failure shows none', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  await settle($.tool.call(call('analyst', { tool_use_id: 't1' }) as never))
  await settle($.tool.call(call('reviewer', { tool_use_id: 't2' }) as never))
  expect(h.toasts).toEqual([`Jev off (no-key): ${OFF_TEXT['no-key']} Spider agents run at their role defaults.`])
  expect(received.map(e => e.description)).toEqual(['Fixture (haiku/high, default: no-key)', 'Fixture (opus/medium, default: no-key)'])
  h.env.JEV_API_KEY = 'two words'
  await settle($.tool.call(call('analyst', { tool_use_id: 't3' }) as never))
  expect(h.toasts).toHaveLength(2); expect(h.toasts[1]).toContain('Jev off (bad-key)')
  h.env.JEV_API_KEY = 'test-key'; h.answers.difficulty = { probabilities: { '9': 1 } }
  await settle($.tool.call(call('analyst', { tool_use_id: 't4' }) as never))
  expect(h.toasts).toHaveLength(2)
  expect(received.at(-1)!.description).toBe('Fixture (haiku/high, default: malformed)')
  h.answers.difficulty = { probabilities: { '0': 1 } }
  await settle($.tool.call(call('analyst', { tool_use_id: 't5' }) as never))
  expect(received.at(-1)!.description).toBe('Fixture (haiku/medium)')
})
const ANSWER = 'ANSWER-TEXT-91c2'
test('foreground and background outcomes carry the judge of the answer, and the host result passes on as it came', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  const answer = finished(`${ANSWER} done, all checks pass`)
  const results = [answer, { ref: 'r', text: MARKER, result: { status: 'async_launched', agentId: 'bg-j' } }]
  on('tool.call', { tool: 'Agent' }, () => results.shift() as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await started($)
  expect(await settle($.tool.call(call('planner', { tool_use_id: 'toolu_f' }) as never))).toEqual(answer)
  // Routing, then the judge: three Nouls with the answer as the only state.
  expect(h.requests).toHaveLength(2)
  const judged = JSON.parse(h.requests[1]!.body)
  expect(Object.keys(judged.questions)).toEqual(['finished', 'failingChecks', 'blocked'])
  expect(judged.state).toEqual({ report: { text: `${ANSWER} done, all checks pass` } })
  expect(h.ledger()[1]).toMatchObject({ kind: 'outcome', tool_use_id: 'toolu_f', mode: 'foreground', status: 'completed', judge: { finished: 0.95, failingChecks: 0.02, blocked: 0.01 } })
  // A background run is judged when its turn completes; the turn's result passes on unchanged.
  h.answers.finished = { noul: 0.3 }; h.answers.blocked = { noul: 0.876 }
  await settle($.tool.call(call('analyst', { tool_use_id: 'toolu_b' }) as never))
  const done = { turnId: 't', agentId: 'bg-j', answer: `${ANSWER} I need a decision`, durationMs: 800, isAborted: false, reason: 'answer' }
  expect(await settle($.turn.complete(done as never))).toEqual({ text: done.answer })
  expect(h.requests).toHaveLength(4)
  expect(JSON.parse(h.requests[3]!.body).state).toEqual({ report: { text: `${ANSWER} I need a decision` } })
  expect(h.ledger()[3]).toMatchObject({ kind: 'outcome', tool_use_id: 'toolu_b', mode: 'background', judge: { finished: 0.3, failingChecks: 0.02, blocked: 0.88 } })
  for (const text of [...h.files.values(), ...h.logs]) expect(text).not.toContain(ANSWER)
})
test('a judge failure still writes the outcome with judge null, unfinished runs are not judged, and no line or log holds the answer', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  const results: unknown[] = [
    finished(`${ANSWER} done`), finished(''), { ref: 'r', result: ANSWER, isError: true, text: ANSWER },
    { result: { status: 'async_launched', agentId: 'bg-x' } }, finished(`${ANSWER} done`),
  ]
  on('tool.call', { tool: 'Agent' }, () => results.shift() as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await started($)
  // Jev answers routing but sends a Noul out of range: the judge is null and the outcome still goes in.
  h.answers.blocked = { noul: 2 }
  await settle($.tool.call(call('planner', { tool_use_id: 'toolu_m' }) as never))
  expect(h.ledger()[1]).toMatchObject({ kind: 'outcome', status: 'completed', judge: null })
  expect(h.logs).toContain('spider-team: judge off (malformed)')
  expect(h.requests).toHaveLength(2)
  // An empty answer, an error and an aborted background run are never sent to the judge.
  await settle($.tool.call(call('planner', { tool_use_id: 'toolu_e' }) as never))
  await settle($.tool.call(call('planner', { tool_use_id: 'toolu_x' }) as never))
  await settle($.tool.call(call('planner', { tool_use_id: 'toolu_a' }) as never))
  await settle($.turn.complete({ turnId: 't', agentId: 'bg-x', answer: ANSWER, durationMs: 9, isAborted: true, reason: 'aborted' } as never))
  expect(h.requests).toHaveLength(5)
  expect(h.ledger().filter(l => l.kind === 'outcome').map(l => [l.tool_use_id, l.status, l.judge])).toEqual([['toolu_m', 'completed', null], ['toolu_e', 'completed', null], ['toolu_x', 'error', null], ['toolu_a', 'aborted', null]])
  // Without a key there is no judge request and the outcome is written with judge null.
  delete h.env.JEV_API_KEY
  await settle($.tool.call(call('planner', { tool_use_id: 'toolu_k' }) as never))
  expect(h.requests).toHaveLength(5)
  expect(h.ledger().at(-1)).toMatchObject({ kind: 'outcome', tool_use_id: 'toolu_k', judge: null })
  expect(h.logs).toContain('spider-team: judge off (no-key)')
  for (const text of [...h.written, ...h.files.values(), ...h.logs]) expect(text).not.toContain(ANSWER)
})
test('a failing judge opens only its own breaker: routing still asks Jev afterwards', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  on('tool.call', { tool: 'Agent' }, () => finished(`${ANSWER} done`) as never)
  await started($)
  const fetch = h.io.jev.fetch
  h.io.jev.fetch = async (url, init) => (init.body.includes('"report"') ? { status: 401, text: '' } : fetch(url, init))
  for (let n = 0; n < 6; n++) await settle($.tool.call(call('planner', { tool_use_id: `toolu_j${n}` }) as never))
  expect(h.logs).toContain('spider-team: judge off (breaker)')
  expect(h.ledger().filter(l => l.kind === 'decision').map(l => l.source)).toEqual(Array(6).fill('jev'))
})
test('by default the judge asks about every completed run', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  on('tool.call', { tool: 'Agent' }, () => finished(`${ANSWER} done`) as never)
  await started($)
  for (let n = 0; n < 4; n++) await settle($.tool.call(call('planner', { tool_use_id: `toolu_s${n}` }) as never))
  // The default judges every run: four routing requests and four judge requests.
  expect(h.requests.filter(r => r.body.includes('"report"'))).toHaveLength(4)
})
test('judgeEvery 2 judges the first run and every second one after it', { options: { judgeEvery: 2 } }, async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  on('tool.call', { tool: 'Agent' }, () => finished(`${ANSWER} done`) as never)
  await started($)
  for (let n = 0; n < 4; n++) await settle($.tool.call(call('planner', { tool_use_id: `toolu_s${n}` }) as never))
  expect(h.requests.filter(r => r.body.includes('"report"'))).toHaveLength(2)
  expect(h.ledger().filter(l => l.kind === 'outcome').map(l => l.judge === null)).toEqual([false, true, false, true])
})
test('judgeEvery 0 sends no judge request and writes every outcome with judge null', { options: { judgeEvery: 0 } }, async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  on('tool.call', { tool: 'Agent' }, () => finished(`${ANSWER} done`) as never)
  await started($)
  for (let n = 0; n < 3; n++) await settle($.tool.call(call('planner', { tool_use_id: `toolu_o${n}` }) as never))
  expect(h.requests).toHaveLength(3)
  expect(h.ledger().filter(l => l.kind === 'outcome').map(l => l.judge)).toEqual([null, null, null])
  expect(h.logs.some(l => l.includes('judge off'))).toBe(false)
})
function bash(on: Parameters<typeof world>[0]) {
  const ran: string[] = []
  on('tool.call', { tool: 'Bash' }, (_$, e) => { ran.push((e as unknown as { command: string }).command); return { result: 'ran' } as never })
  return ran
}
const run = (command: string, agentId?: string) => ({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) })
test('a Spider agent runs only read-only git through Bash; the main loop and other agents pass untouched', async ($, on) => {
  const h = world(on), ran = bash(on); await started($)
  h.agents.roster = [listed('an-1', 'spider-team:analyst'), listed('rv-1', 'spider-team:reviewer'), listed('ex-1', 'Explore')]
  expect(await $.tool.call(run('git log --oneline -5', 'an-1') as never)).toEqual({ result: 'ran' })
  expect(await $.tool.call(run('git diff main...HEAD', 'rv-1') as never)).toEqual({ result: 'ran' })
  expect(await $.tool.call(run('git commit -am x', 'an-1') as never)).toEqual({ deny: refusal('analyst') })
  expect(await $.tool.call(run('git diff --output=/tmp/x', 'rv-1') as never)).toEqual({ deny: refusal('reviewer') })
  expect(await $.tool.call(run('git status && rm -rf .', 'rv-1') as never)).toEqual({ deny: refusal('reviewer') })
  expect(await $.tool.call(run('npm test', 'ex-1') as never)).toEqual({ result: 'ran' })
  expect(await $.tool.call(run('rm -rf build') as never)).toEqual({ result: 'ran' })
  expect(ran).toEqual(['git log --oneline -5', 'git diff main...HEAD', 'npm test', 'rm -rf build'])
  // The list is asked once: every id it named is cached with its role, or null for another agent.
  expect(h.agents.lists).toBe(1)
})
test('an agent the list does not name yet is asked about again, and a list that fails refuses the command', async ($, on) => {
  const h = world(on), ran = bash(on); await started($)
  expect(await $.tool.call(run('git push', 'new-1') as never)).toEqual({ result: 'ran' })
  h.agents.roster = [listed('new-1', 'spider-team:reviewer')]
  expect(await $.tool.call(run('git push', 'new-1') as never)).toEqual({ deny: refusal('reviewer') })
  expect(h.agents.lists).toBe(2)
  h.agents.fail = true
  expect(await $.tool.call(run('git log', 'other-1') as never)).toEqual({ deny: UNCHECKED })
  // A cached Spider agent needs no list, so its read-only git still runs.
  expect(await $.tool.call(run('git log', 'new-1') as never)).toEqual({ result: 'ran' })
  expect(ran).toEqual(['git push', 'git log'])
})
test('a foreground result goes back before the judge answers, and its outcome is written once the judge does', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  on('tool.call', { tool: 'Agent' }, () => finished(`${ANSWER} done`) as never)
  await started($)
  const fetch = h.io.jev.fetch
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  h.io.jev.fetch = async (url, init) => { if (init.body.includes('"report"')) await held; return fetch(url, init) }
  expect(await $.tool.call(call('planner', { tool_use_id: 'toolu_h' }) as never)).toEqual(finished(`${ANSWER} done`))
  expect(h.ledger().map(l => l.kind)).toEqual(['decision'])
  release()
  await settle(Promise.resolve())
  expect(h.ledger()[1]).toMatchObject({ kind: 'outcome', tool_use_id: 'toolu_h', judge: { finished: 0.95, failingChecks: 0.02, blocked: 0.01 } })
})
test('a decision line counts the brief and an outcome line the answer, in characters and never as text', async ($, on) => {
  const h = world(on); dispatched(on, finished(`${ANSWER} done`)); await started($)
  await settle($.tool.call(call('analyst', { prompt: `Brief ${MARKER}` }) as never))
  expect(h.ledger().map(l => l.kind === 'decision' ? l.briefChars : l.answerChars)).toEqual([`Brief ${MARKER}`.length, `${ANSWER} done`.length])
  for (const text of h.files.values()) { expect(text).not.toContain(MARKER); expect(text).not.toContain(ANSWER) }
})
