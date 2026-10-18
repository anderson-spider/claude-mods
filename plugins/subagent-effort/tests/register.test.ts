import { expect, test } from 'claude-code/testing'
import { call, LEDGER, settle, started, world } from './host'
import { STATS_COMMAND, STATS_DESCRIPTION } from '../hooks/register'
import { OFF_TEXT } from '../hooks/key'

const MARKER = 'SECRET-MARKER-7f3a'
function dispatched(on: Parameters<typeof world>[0], answer: unknown = { result: 'native answer' }) {
  const received: Record<string, unknown>[] = []
  on('tool.call', { tool: 'Agent' }, (_$, e) => { received.push(e as never); return answer as never })
  return received
}
const finished = (patch = {}) => ({
  ref: 'r', text: MARKER, result: {
    agentId: 'a1', status: 'completed', prompt: MARKER, resolvedModel: 'claude-haiku-5-5', totalDurationMs: 42_000,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 500, cache_read_input_tokens: 1000 },
    content: [{ type: 'text', text: MARKER }], ...patch,
  },
})

test('session start registers the stats command and no agent or tool', async ($, on) => {
  const h = world(on); await started($)
  expect(h.commands).toEqual([{ name: STATS_COMMAND, description: STATS_DESCRIPTION }])
  expect(STATS_COMMAND).toBe('subagent-effort-stats')
})

test('Jev sets the effort of any native agent type, shown in its description, and leaves the model alone', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  h.answers.reasoning = { probabilities: { '2': 1 } }
  await started($)
  expect(await settle($.tool.call(call({ model: 'haiku' }) as never))).toHaveProperty('result', 'native answer')
  expect(received[0]).toEqual({ ...call({ model: 'haiku' }), description: 'Fixture (high)', effort: 'high' })
  // A call without a type is the host's general-purpose agent, routed the same way.
  const { subagent_type: _, ...untyped } = call({ tool_use_id: 'dispatch-2' })
  await settle($.tool.call(untyped as never))
  expect(received[1]).toMatchObject({ effort: 'high' })
  expect(h.requests).toHaveLength(2)
  expect(h.ledger().filter(l => l.kind === 'decision').map(l => l.agentType)).toEqual(['Explore', 'general-purpose'])
})

test('Jev replaces an effort the call came with, shows the one it replaced, and leaves the model alone', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  await started($)
  const asked = call({ effort: 'max', model: 'opus', tool_use_id: 'toolu_max' })
  await settle($.tool.call(asked as never))
  expect(received[0]).toEqual({ ...asked, effort: 'low', description: 'Fixture (low, was max)' })
  // Jev picking the effort the call already had names no replacement.
  await settle($.tool.call(call({ effort: 'low', tool_use_id: 'toolu_low' }) as never))
  expect(received[1]).toMatchObject({ effort: 'low', description: 'Fixture (low)' })
  expect(h.requests).toHaveLength(2)
  expect(h.ledger().map(l => [l.tool_use_id, l.source, l.received, l.effort])).toEqual([['toolu_max', 'jev', 'max', 'low'], ['toolu_low', 'jev', 'low', 'low']])
})

test('when Jev is off or fails, an effort the call came with goes as it came and is recorded as received and applied', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  const asked = call({ effort: 'high', tool_use_id: 'toolu_off' })
  await settle($.tool.call(asked as never)); expect(received[0]).toEqual(asked)
  h.env.JEV_API_KEY = 'test-key'; h.faults.http = 401
  await settle($.tool.call(asked as never)); expect(received[1]).toEqual(asked)
  expect(h.ledger().map(l => [l.source, l.jevReason, l.received, l.effort])).toEqual([['off', 'no-key', 'high', 'high'], ['off', 'http', 'high', 'high']])
})

test('a fork or an empty task passes untouched, unrouted and unrecorded', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  await started($)
  const fork = call({ subagent_type: 'fork', effort: 'max' })
  await settle($.tool.call(fork as never)); expect(received[0]).toEqual(fork)
  const empty = call({ prompt: '  ' })
  await settle($.tool.call(empty as never)); expect(received[1]).toEqual(empty)
  expect(h.requests).toHaveLength(0); expect(h.written).toHaveLength(0)
})

test('when Jev is off the call goes as it came, with one toast per reason in this load', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  await settle($.tool.call(call() as never)); await settle($.tool.call(call() as never))
  expect(received).toEqual([call(), call()])
  expect(h.toasts).toEqual([`Jev off (no-key): ${OFF_TEXT['no-key']} Subagent calls go as they came.`])
  h.env.JEV_API_KEY = 'has space'
  await settle($.tool.call(call() as never))
  expect(h.toasts).toHaveLength(2); expect(h.toasts[1]).toContain('Jev off (bad-key)')
  // A Jev failure is not a configuration problem: no toast.
  h.env.JEV_API_KEY = 'test-key'; h.faults.http = 401
  await settle($.tool.call(call() as never))
  expect(received[3]).toEqual(call()); expect(h.toasts).toHaveLength(2)
  expect(h.ledger().filter(l => l.kind === 'decision').map(l => [l.source, l.effort, l.jevReason])).toEqual([['off', null, 'no-key'], ['off', null, 'no-key'], ['off', null, 'bad-key'], ['off', null, 'http']])
})

test('a routing failure dispatches the call once as it came and writes no record', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  Object.defineProperty(h.io, 'root', { get: () => { throw new Error('root unavailable') } })
  expect(await settle($.tool.call(call() as never))).toHaveProperty('result', 'native answer')
  expect(received).toEqual([call()])
  expect(h.written).toHaveLength(0)
  expect(h.logs).toContain('subagent-effort: routing failed; dispatching the call as it came.')
})

test('a decision line and a foreground outcome line are written, and the host result passes on as it came', async ($, on) => {
  const h = world(on), answer = finished(); h.env.JEV_API_KEY = 'test-key'
  h.answers.reasoning = { probabilities: { '0': 0.8, '1': 0.2 } }
  dispatched(on, answer); await started($)
  expect(await settle($.tool.call(call({ tool_use_id: 'toolu_1' }) as never))).toEqual(answer)
  expect(h.ledger()).toEqual([
    { v: 1, kind: 'decision', calibration: 2, ts: expect.any(String), tool_use_id: 'toolu_1', agentType: 'Explore', briefChars: 12, source: 'jev', received: null, effort: 'low', level: 0, top: 0.8, jevReason: null, jevMs: expect.any(Number), jevTokens: { input: 300, output: 20 }, jevCostUsd: 0.0000126 },
    { v: 1, kind: 'outcome', ts: expect.any(String), tool_use_id: 'toolu_1', agentType: 'Explore', effort: 'low', mode: 'foreground', resolvedModel: 'claude-haiku-5-5', status: 'completed', durationMs: 42_000, tokens: 1650 },
  ])
})

test('an error of a call run in background, flagged true or "true", is written as a background outcome', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  dispatched(on, { ref: 'r', text: 'the agent failed', result: 'the agent failed', isError: true }); await started($)
  await settle($.tool.call(call({ tool_use_id: 'toolu_t', run_in_background: true }) as never))
  await settle($.tool.call(call({ tool_use_id: 'toolu_s', run_in_background: 'true' }) as never))
  await settle($.tool.call(call({ tool_use_id: 'toolu_f' }) as never))
  expect(h.ledger().filter(l => l.kind === 'outcome').map(l => [l.tool_use_id, l.mode, l.status]))
    .toEqual([['toolu_t', 'background', 'error'], ['toolu_s', 'background', 'error'], ['toolu_f', 'foreground', 'error']])
})

test('a background launch is written when its turn completes, once, and other turns write nothing', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  const launched = { ref: 'r', text: MARKER, result: { status: 'async_launched', agentId: 'bg-1', prompt: MARKER } }
  dispatched(on, launched)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await started($)
  expect(await settle($.tool.call(call({ tool_use_id: 'toolu_bg' }) as never))).toEqual(launched)
  expect(h.ledger().map(l => l.kind)).toEqual(['decision'])
  const done = { turnId: 't1', agentId: 'bg-1', answer: MARKER, durationMs: 7000, isAborted: false, reason: 'answer', usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
  await settle($.turn.complete({ ...done, agentId: 'other' } as never))
  await settle($.turn.complete({ ...done, agentId: undefined } as never))
  expect(h.ledger()).toHaveLength(1)
  expect(await settle($.turn.complete(done as never))).toEqual({ text: MARKER })
  expect(h.ledger()[1]).toMatchObject({ kind: 'outcome', tool_use_id: 'toolu_bg', mode: 'background', status: 'completed', durationMs: 7000, tokens: 15, resolvedModel: 'claude-opus-5-5', effort: 'low' })
  await settle($.turn.complete(done as never))
  expect(h.ledger()).toHaveLength(2)
})

test('no line ever holds the task, a prompt, an answer, a path or the key', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  h.answers.reasoning = { probabilities: { '1': 1 }, reason: MARKER, [MARKER]: 1 }
  dispatched(on, finished({ prompt: MARKER, resolvedModel: MARKER + ' /home/u' }))
  await started($)
  await settle($.tool.call(call({ prompt: `Review ${MARKER} at /home/u/private/${MARKER} with test-key`, description: `Fixture ${MARKER}`, subagent_type: `/home/u/${MARKER} x` }) as never))
  expect(h.written.length).toBeGreaterThan(0)
  for (const text of [...h.written, ...h.files.values()]) {
    expect(text).not.toContain(MARKER); expect(text).not.toContain('/home/u'); expect(text).not.toContain('test-key'); expect(text).not.toContain('Review')
  }
  expect(h.ledger()[0]).toMatchObject({ agentType: null, briefChars: expect.any(Number) })
})

test('observation survives a failing ledger: the dispatch and its result are unchanged and one debug line names the miss', async ($, on) => {
  const h = world(on), answer = finished(); h.env.JEV_API_KEY = 'test-key'
  const received = dispatched(on, answer)
  await started($)
  h.fsFaults.write = true
  expect(await settle($.tool.call(call() as never))).toEqual(answer)
  expect(received[0]).toMatchObject({ effort: 'low' })
  expect(h.logs.filter(line => line.endsWith('not recorded'))).toEqual(['subagent-effort: decision not recorded', 'subagent-effort: outcome not recorded'])
  h.fsFaults.write = false
  // A ledger that cannot be read is not overwritten either.
  h.files.set(LEDGER, '{"keep":"me"}\n'); h.fsFaults.read = true
  expect(await settle($.tool.call(call() as never))).toEqual(answer)
  expect(h.files.get(LEDGER)).toBe('{"keep":"me"}\n')
  // A host without HOME writes nothing and still dispatches.
  h.fsFaults.read = false; delete h.env.HOME; h.written.length = 0
  expect(await settle($.tool.call(call() as never))).toEqual(answer)
  expect(h.written).toHaveLength(0)
})

test('the stats command checks Jev access the way routing does, summarizes the records and never prints the key', async ($, on) => {
  const h = world(on); dispatched(on, finished())
  await started($)
  expect((await $.command.run({ command: STATS_COMMAND } as never) as { text: string }).text).toBe(`Jev access in this session: off (no-key). ${OFF_TEXT['no-key']}\nno routing records yet.`)
  h.env.JEV_API_KEY = 'test-key'
  await settle($.tool.call(call() as never))
  const text = (await $.command.run({ command: STATS_COMMAND } as never) as { text: string }).text
  expect(text).toMatch(/^Jev access in this session: ok\.\n1 decisions: Jev 1, Jev off 0\.\nJev calls: 1, median \d+ms, 300 input and 20 output tokens, about \$0\.000013 \(estimated\)\.\nhaiku\/low: 1 runs, median 42s and 2k tokens$/)
  expect(text).not.toContain('test-key')
  h.fsFaults.read = true
  expect((await $.command.run({ command: STATS_COMMAND } as never) as { text: string }).text).toBe('Jev access in this session: ok.\nthe routing records could not be read.')
})
