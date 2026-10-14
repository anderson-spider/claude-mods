import { expect, test } from 'claude-code/testing'
import { call, drain, inference, LEDGER, spawn, started, step, world } from './host'
import { SPECS } from '../hooks/roles'
import { BASE_REF, EMPTY, STATS_COMMAND, STATS_DESCRIPTION } from '../hooks/register'

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

test('session start registers the four native agents and the stats command, and no tools', async ($, on) => {
  const h = world(on); await started($)
  expect(h.specs.map(s => s.name)).toEqual(['analyst', 'developer', 'reviewer', 'architect'])
  for (const spec of h.specs) expect(spec).toEqual(SPECS[spec.name as keyof typeof SPECS])
  expect(h.commands).toEqual([{ name: STATS_COMMAND, description: STATS_DESCRIPTION }])
  expect(STATS_COMMAND).toBe('spider-team-stats')
})
test('Jev picks the pair for a Spider role, shown in its description, and other agents pass untouched', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  await started($)
  expect(await $.tool.call(call() as never)).toHaveProperty('result', 'native answer')
  expect(received[0]).toMatchObject({ prompt: 'Private task', description: 'Fixture (haiku/medium)', model: 'haiku', effort: 'medium' })
  expect(h.requests).toHaveLength(1)
  const other = call('x', { subagent_type: 'Explore', model: 'fable', effort: 'max' })
  await $.tool.call(other as never); expect(received[1]).toEqual(other); expect(h.requests).toHaveLength(1)
  expect(h.ledger()).toHaveLength(1)
})
test('a model or effort from the lead is overwritten by the Jev pair, or by the role default without a key', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  await $.tool.call(call('architect', { model: 'fable', effort: 'max' }) as never)
  expect(received[0]).toMatchObject({ model: 'opus', effort: 'medium', description: 'Fixture (opus/medium)' })
  await $.tool.call(call('analyst', { model: 'gpt', effort: 'ultra' }) as never)
  expect(received[1]).toMatchObject({ model: 'haiku', effort: 'high' })
  expect(h.requests).toHaveLength(0)
  h.env.JEV_API_KEY = 'test-key'
  // Difficulty 0 and duration 0 is haiku/medium for the analyst, and the developer floor lifts it to haiku/high, whatever the lead asked for.
  await $.tool.call(call('analyst', { model: 'fable', effort: 'max' }) as never)
  expect(received[2]).toMatchObject({ model: 'haiku', effort: 'medium', description: 'Fixture (haiku/medium)' })
  await $.tool.call(call('developer', { model: 'opus' }) as never)
  expect(received[3]).toMatchObject({ model: 'haiku', effort: 'high' })
  expect(h.requests).toHaveLength(2)
})
test('Jev is asked both questions and bang and at-sign words reach it as written', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  h.answers.difficulty = { probabilities: { '3': 1 } }; h.answers.duration = { probabilities: { '2': 1 } }
  await started($)
  const prompt = 'Private task !hard !quick !long !difficulty=0 !duration=3 !bogus=9 @sonnet-high @opus'
  await $.tool.call(call('analyst', { prompt }) as never)
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
  const roles = ['analyst', 'developer', 'reviewer', 'architect'] as const
  for (const role of roles) {
    const answer = await $.tool.call(call(role, { tool_use_id: role }) as never)
    expect(answer).not.toHaveProperty('deny'); expect(answer).toHaveProperty('result', 'native answer')
  }
  expect(answers).toEqual(roles.map(() => 'native answer'))
  expect(received.map(r => [r.subagent_type, r.model, r.effort])).toEqual([['spider-team:analyst', 'haiku', 'high'], ['spider-team:developer', 'sonnet', 'high'], ['spider-team:reviewer', 'opus', 'medium'], ['spider-team:architect', 'opus', 'medium']])
  expect(h.requests).toHaveLength(0)
})
test('empty tasks and a developer without baseRef head are refused before dispatch', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  for (const prompt of ['', ' \n\t ']) expect((await $.tool.call(call('analyst', { prompt }) as never)).deny).toBe(EMPTY)
  h.io.baseRef = 'main'
  expect((await $.tool.call(call('developer') as never)).deny).toBe(BASE_REF)
  expect(received).toHaveLength(0)
  expect(h.written).toHaveLength(0)
  h.io.baseRef = 'head'
  await $.tool.call(call('developer') as never)
  expect(received[0]).toMatchObject({ model: 'sonnet', effort: 'high' }); expect(received[0]).not.toHaveProperty('isolation')
})
test('a routing failure dispatches the role default once, never the lead model and effort, and writes no record', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  Object.defineProperty(h.io, 'root', { get: () => { throw new Error('root unavailable') } })
  for (const role of ['analyst', 'developer', 'reviewer', 'architect'] as const) {
    const e = call(role, { model: 'opus', effort: 'max', tool_use_id: role })
    expect(await $.tool.call(e as never)).toHaveProperty('result', 'native answer')
    const model = role === 'developer' ? 'sonnet' : role === 'analyst' ? 'haiku' : 'opus', effort = role === 'reviewer' || role === 'architect' ? 'medium' : 'high'
    expect(received.at(-1)).toEqual({ ...e, model, effort, description: `Fixture (${model}/${effort})` })
  }
  expect(received).toHaveLength(4)
  expect(h.written).toHaveLength(0)
  expect(h.logs).toContain('spider-team: routing failed; dispatching the role default.')
})
test('a decision line and a foreground outcome line are written, and the host result passes on as it came', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  h.answers.difficulty = { probabilities: { '0': 1 } }; h.answers.duration = { probabilities: { '0': 1 } }
  const answer = finished(`Verdict: CHANGES\n${MARKER}`)
  dispatched(on, answer)
  await started($)
  const result = await $.tool.call(call('reviewer', { tool_use_id: 'toolu_9' }) as never)
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
  await $.tool.call(call('analyst', { tool_use_id: 'toolu_10' }) as never)
  expect(h.ledger()[2]).toMatchObject({ kind: 'decision', source: 'default', jevReason: 'no-key', jevMs: null, levels: null, top: null, dist: null, cell: null, floorApplied: false, model: 'haiku', effort: 'high' })
})
test('a background launch is written when its turn completes, with the verdict from the final text', async ($, on) => {
  const h = world(on)
  const launched = { ref: 'r', text: MARKER, result: { status: 'async_launched', agentId: 'bg-1', description: MARKER, prompt: MARKER, outputFile: `/tmp/${MARKER}` } }
  dispatched(on, launched)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await started($)
  expect(await $.tool.call(call('reviewer', { tool_use_id: 'toolu_bg' }) as never)).toEqual(launched)
  expect(h.ledger().map(l => l.kind)).toEqual(['decision'])
  const done = { turnId: 't1', agentId: 'bg-1', answer: `${MARKER}\nVerdict: BLOCKED`, durationMs: 7000, isAborted: false, reason: 'answer', usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
  // An unrelated agent's turn and the main loop's turn write nothing.
  await $.turn.complete({ ...done, agentId: 'other' } as never)
  await $.turn.complete({ ...done, agentId: undefined } as never)
  expect(h.ledger()).toHaveLength(1)
  expect(await $.turn.complete(done as never)).toEqual({ text: done.answer })
  expect(h.ledger()[1]).toMatchObject({ kind: 'outcome', tool_use_id: 'toolu_bg', role: 'reviewer', mode: 'background', status: 'completed', durationMs: 7000, tokens: { input: 10, output: 5, cacheCreation: 0, cacheRead: 0 }, verdict: 'BLOCKED' })
  // Each agent writes once.
  await $.turn.complete(done as never)
  expect(h.ledger()).toHaveLength(2)
})
test('an aborted background agent is an aborted outcome', async ($, on) => {
  const h = world(on)
  dispatched(on, { result: { status: 'async_launched', agentId: 'bg-2' } })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await started($)
  await $.tool.call(call('developer', { tool_use_id: 'toolu_a' }) as never)
  await $.turn.complete({ turnId: 't', agentId: 'bg-2', answer: '', durationMs: 900, isAborted: true, reason: 'aborted' } as never)
  expect(h.ledger()[1]).toMatchObject({ kind: 'outcome', status: 'aborted', aborted: true, verdict: null, tokens: null })
})
test('no line ever holds the task, a prompt, an answer, a path, a branch or the key', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  // Jev's answers carry extra text beside the probabilities; only the projected numbers reach the line.
  h.answers.difficulty = { probabilities: { '2': 0.6, '3': 0.4 }, reason: MARKER, [MARKER]: 1 }; h.answers.duration = { probabilities: { '1': 1 }, note: `/home/u/private/${MARKER}` }
  dispatched(on, finished(`${MARKER} Verdict: APPROVED`, { prompt: MARKER }))
  await started($)
  await $.tool.call(call('reviewer', { prompt: `Review ${MARKER} at /home/u/private/${MARKER} on branch feature/${MARKER} with test-key`, description: `Fixture ${MARKER}`, name: MARKER }) as never)
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
  expect(await $.tool.call(call('reviewer') as never)).toEqual(answer)
  expect(received[0]).toMatchObject({ model: 'opus', effort: 'medium' })
  expect(h.logs.filter(line => line.endsWith('not recorded'))).toEqual(['spider-team: decision not recorded', 'spider-team: outcome not recorded'])
  h.fsFaults.write = false
  // A ledger that cannot be read is not overwritten either.
  h.files.set(LEDGER, '{"keep":"me"}\n'); h.fsFaults.read = true
  expect(await $.tool.call(call('reviewer') as never)).toEqual(answer)
  expect(h.files.get(LEDGER)).toBe('{"keep":"me"}\n')
  // A host without HOME writes nothing and still dispatches.
  h.fsFaults.read = false; delete h.env.HOME; h.written.length = 0
  expect(await $.tool.call(call('reviewer') as never)).toEqual(answer)
  expect(h.written).toHaveLength(0)
})
test('a refused or failed Agent result writes no outcome and passes on', async ($, on) => {
  const h = world(on)
  const error = { ref: 'r', result: 'boom', isError: true, text: 'boom' }
  dispatched(on, error)
  await started($)
  expect(await $.tool.call(call('analyst') as never)).toEqual(error)
  expect(h.ledger().map(l => [l.kind, l.status ?? null])).toEqual([['decision', null], ['outcome', 'error']])
})
test('the stats command summarizes the local ledger, and says so when there is none or it cannot be read', async ($, on) => {
  const h = world(on); dispatched(on, finished('Verdict: APPROVED')); await started($)
  expect((await $.command.run({ command: STATS_COMMAND } as never)).text).toBe('no routing records yet in ~/.claude/spider-team/routes.jsonl.')
  await $.tool.call(call('reviewer', { tool_use_id: 'toolu_s' }) as never)
  const text = (await $.command.run({ command: STATS_COMMAND, args: 'ignored' } as never)).text!
  expect(text.startsWith('1 decisions, 1 outcomes')).toBe(true); expect(text).toContain('reviewer'); expect(text).toContain('opus/medium'); expect(text).toContain('Default fallbacks: 1 of 1')
  expect(text).not.toContain('/home/u')
  h.fsFaults.read = true
  expect((await $.command.run({ command: STATS_COMMAND } as never)).text).toBe('the routing records could not be read.')
  h.fsFaults.read = false; delete h.env.HOME
  expect((await $.command.run({ command: STATS_COMMAND } as never)).text).toBe('no home directory, so no routing records.')
})
const ANSWER = 'ANSWER-TEXT-91c2'
test('foreground and background outcomes carry the judge of the answer, and the host result passes on as it came', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  const answer = finished(`${ANSWER} done, all checks pass`)
  const results = [answer, { ref: 'r', text: MARKER, result: { status: 'async_launched', agentId: 'bg-j' } }]
  on('tool.call', { tool: 'Agent' }, () => results.shift() as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await started($)
  expect(await $.tool.call(call('developer', { tool_use_id: 'toolu_f' }) as never)).toEqual(answer)
  // Routing, then the judge: three Nouls with the answer as the only state.
  expect(h.requests).toHaveLength(2)
  const judged = JSON.parse(h.requests[1]!.body)
  expect(Object.keys(judged.questions)).toEqual(['finished', 'failingChecks', 'blocked'])
  expect(judged.state).toEqual({ report: { text: `${ANSWER} done, all checks pass` } })
  expect(h.ledger()[1]).toMatchObject({ kind: 'outcome', tool_use_id: 'toolu_f', mode: 'foreground', status: 'completed', judge: { finished: 0.95, failingChecks: 0.02, blocked: 0.01 } })
  // A background run is judged when its turn completes; the turn's result passes on unchanged.
  h.answers.finished = { noul: 0.3 }; h.answers.blocked = { noul: 0.876 }
  await $.tool.call(call('analyst', { tool_use_id: 'toolu_b' }) as never)
  const done = { turnId: 't', agentId: 'bg-j', answer: `${ANSWER} I need a decision`, durationMs: 800, isAborted: false, reason: 'answer' }
  expect(await $.turn.complete(done as never)).toEqual({ text: done.answer })
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
  await $.tool.call(call('developer', { tool_use_id: 'toolu_m' }) as never)
  expect(h.ledger()[1]).toMatchObject({ kind: 'outcome', status: 'completed', judge: null })
  expect(h.logs).toContain('spider-team: judge off (malformed)')
  expect(h.requests).toHaveLength(2)
  // An empty answer, an error and an aborted background run are never sent to the judge.
  await $.tool.call(call('developer', { tool_use_id: 'toolu_e' }) as never)
  await $.tool.call(call('developer', { tool_use_id: 'toolu_x' }) as never)
  await $.tool.call(call('developer', { tool_use_id: 'toolu_a' }) as never)
  await $.turn.complete({ turnId: 't', agentId: 'bg-x', answer: ANSWER, durationMs: 9, isAborted: true, reason: 'aborted' } as never)
  expect(h.requests).toHaveLength(5)
  expect(h.ledger().filter(l => l.kind === 'outcome').map(l => [l.tool_use_id, l.status, l.judge])).toEqual([['toolu_m', 'completed', null], ['toolu_e', 'completed', null], ['toolu_x', 'error', null], ['toolu_a', 'aborted', null]])
  // Without a key there is no judge request and the outcome is written with judge null.
  delete h.env.JEV_API_KEY
  await $.tool.call(call('developer', { tool_use_id: 'toolu_k' }) as never)
  expect(h.requests).toHaveLength(5)
  expect(h.ledger().at(-1)).toMatchObject({ kind: 'outcome', tool_use_id: 'toolu_k', judge: null })
  expect(h.logs).toContain('spider-team: judge off (no-key)')
  for (const text of [...h.written, ...h.files.values(), ...h.logs]) expect(text).not.toContain(ANSWER)
})
