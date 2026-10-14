import { expect, test } from 'claude-code/testing'
import { BLOCKED } from '../hooks/dispatch'
import { REPORT_ERROR } from '../hooks/report'
import { register } from '../hooks/register'
import { call, completed, direct, drain, id, inference, launched, persisted, receiptInput, row, spawn, started, step, world } from './host'

test('full hooks separate same-parent external agents from Spider children before and after spawn with equal concurrent calls', async ($, on) => {
  const h = world(on), inferred: string[] = [], failures: string[] = []
  let background = false, before = false, pair = ['fable', 'medium'], serial = 0
  on('turn.step', async function* (_$, e) { inferred.push(e.agentId!); return yield* inference(undefined, e) })
  const check = async (agentId: string) => {
    const result = await drain($.turn.step(step(agentId, pair[0]!, pair[1]!) as never))
    if (result.answer !== BLOCKED || result.usage !== null) failures.push(agentId)
  }
  on('agent.spawn', async (_$, e) => {
    const agentId = `child-${e.tool_use_id}`, external = `external-${e.tool_use_id}`
    h.agents.push(row(external, 'general-purpose', 'same-parent'), row(agentId, 'spider-team:analyst', 'same-parent'))
    expect((await drain($.turn.step(step(external, 'fable', 'max') as never))).answer).toBe('ok')
    if (before) await check(agentId)
    return { agentId, model: 'haiku' }
  })
  on('tool.call', { tool: 'Agent' }, async (_$, e) => {
    const toolId = (e as { tool_use_id: string }).tool_use_id
    await $.agent.spawn(spawn(toolId, { background, parentAgentId: 'same-parent' }) as never)
    if (!before) await check(`child-${toolId}`)
    return (background ? launched(`child-${toolId}`) : completed(`child-${toolId}`)) as never
  })
  await started($)
  // No call/reservation at all: enforcement still applies.
  h.agents.push(row('external-alone', 'fork', 'same-parent'), row('spider-alone', 'spider-team:analyst', 'same-parent'))
  expect((await drain($.turn.step(step('external-alone', 'fable', 'max') as never))).answer).toBe('ok')
  await check('spider-alone')
  for (background of [false, true]) for (before of [false, true]) for (pair of [['fable', 'medium'], ['haiku', 'max']]) {
    const n = ++serial
    await Promise.all(['a', 'b'].map(suffix => $.tool.call({ ...call(`equal-${n}-${suffix}`), agentId: 'same-parent' } as never)))
  }
  expect(failures).toEqual([])
  expect(inferred.every(agentId => agentId.startsWith('external-'))).toBe(true)
  expect(inferred).toHaveLength(17)
  expect(Object.values(h.state.value!.runs).every(r => !r.finished)).toBe(true)
})

test('cache misses fail closed while verified external and Spider hits survive listing failures and every Spider pair is rechecked', async ($, on) => {
  const h = world(on); on('turn.step', inference); await started($)
  h.faults.list = true
  expect((await drain($.turn.step(step('first') as never))).answer).toBe(BLOCKED)
  h.faults.list = false
  for (const rows of [[], [row('bad'), row('bad')], [row('bad', 'spider-team:unknown')], [{ id: 'bad', type: 'fork' }]]) {
    h.agents.splice(0, h.agents.length, ...(rows as typeof h.agents))
    expect((await drain($.turn.step(step('bad') as never))).answer).toBe(BLOCKED)
    expect(h.identities.value?.entries.some(e => e.id === 'bad') ?? false).toBe(false)
  }
  h.agents.splice(0, h.agents.length, row('external', 'fork'), row('spider'))
  expect((await drain($.turn.step(step('external', 'fable', 'max') as never))).answer).toBe('ok')
  expect((await drain($.turn.step(step('spider', 'opus', 'high') as never))).answer).toBe('ok')
  h.faults.list = true
  expect((await drain($.turn.step(step('external', 'fable', 'max') as never))).answer).toBe('ok')
  for (const patch of [{ model: 'fable' }, { effort: 'max' }, { effort: 'xhigh' }, { effort: undefined }, { effort: 1000 }]) {
    expect((await drain($.turn.step({ ...step('spider'), ...patch } as never))).answer).toBe(BLOCKED)
  }
  // Finished/blocked telemetry is not a lifecycle guard: another safe step still passes.
  expect((await drain($.turn.step(step('spider', 'sonnet', 'low') as never))).answer).toBe('ok')
  expect((await drain($.turn.step(step(undefined, 'fable', 'max') as never))).answer).toBe('ok')
  await started($)
  expect((await drain($.turn.step(step('external', 'fable', 'max') as never))).answer).toBe('ok')
  h.identities.value = undefined
  expect((await drain($.turn.step(step('external') as never))).answer).toBe(BLOCKED)
})

test('identity LRU eviction and incompatible reload are misses and observation eviction never disables the guard', async ($, on) => {
  const h = world(on); on('turn.step', inference); on('turn.complete', (_$, e) => ({ text: e.answer })); await started($)
  for (let n = 0; n < 258; n++) {
    const agentId = `native-${n}`
    h.agents.push(row(agentId))
    expect((await drain($.turn.step(step(agentId) as never))).answer).toBe('ok')
    expect(h.identities.value!.entries.length).toBeLessThanOrEqual(256)
    expect(Object.keys(h.state.value!.observations!).length).toBeLessThanOrEqual(256)
  }
  expect(h.identities.value!.entries.some(e => e.id === 'native-0')).toBe(false)
  expect(h.state.value!.observations!['native-0']).toBeUndefined()
  const count = Object.keys(h.state.value!.observations!).length
  await $.turn.complete({ turnId: 'late', agentId: 'native-0', answer: 'late content', reason: 'answer', isAborted: false, durationMs: 1 } as never)
  expect(h.state.value!.observations!['native-0']).toBeUndefined(); expect(Object.keys(h.state.value!.observations!)).toHaveLength(count)
  h.faults.list = true
  expect((await drain($.turn.step(step('native-0') as never))).answer).toBe(BLOCKED)
  expect((await drain($.turn.step(step('native-257', 'fable', 'max') as never))).answer).toBe(BLOCKED)
  h.identities.value!.version = 0 as never
  expect((await drain($.turn.step(step('native-257') as never))).answer).toBe(BLOCKED)
})

test('bounded call telemetry and compact references expire receipts without deleting files or reviving late callbacks', { timeoutMs: 30000 }, async ($, on) => {
  const h = world(on); on('turn.step', inference); on('turn.complete', (_$, e) => ({ text: e.answer }))
  let denied = true
  on('agent.spawn', async (_$, e) => {
    h.agents.push(row(e.tool_use_id, e.subagentType)); await drain($.turn.step(step(e.tool_use_id) as never))
    return { agentId: e.tool_use_id, model: 'haiku' }
  })
  on('tool.call', { tool: 'Agent' }, async (_$, e) => {
    if (denied) return { deny: 'native refusal' }
    const c = e as { tool_use_id: string; subagent_type: string }
    await $.agent.spawn(spawn(c.tool_use_id, { subagentType: c.subagent_type }) as never)
    return launched(c.tool_use_id) as never
  })
  await started($)
  for (let n = 0; n < 270; n++) {
    await $.tool.call(call(`denied-${n}`) as never)
    expect(Object.keys(h.state.value!.runs)).toHaveLength(0)
  }
  denied = false
  await $.tool.call(call('review', 'reviewer') as never)
  await $.tool.call(call('old-dev', 'developer') as never)
  const saved = await $.tool.call(receiptInput('old-dev', { worktreePath: '/native worktree', worktreeBranch: 'feat/task' }) as never)
  const old = h.state.value!.references!['old-dev']!.report!
  expect(saved.result).toBe(old.receipt)
  await $.turn.complete({ turnId: 'done', agentId: 'old-dev', answer: old.receipt, reason: 'answer', isAborted: false, durationMs: 1 } as never)
  for (let n = 0; n < 270; n++) {
    await $.tool.call(call(`active-${n}`) as never)
    expect(Object.keys(h.state.value!.runs).length + Object.keys(h.state.value!.observations!).length).toBeLessThanOrEqual(256)
    expect(Object.keys(h.state.value!.references!).length).toBeLessThanOrEqual(128)
    expect(Object.keys(h.state.value!.observations!).length).toBeLessThanOrEqual(256)
  }
  expect(h.state.value!.references!['old-dev']).toBeUndefined(); expect(h.files.has(old.path)).toBe(true)
  await $.tool.call(call('new-review', 'reviewer') as never)
  expect((await $.tool.call({ tool: id('diff'), tool_use_id: 'd', agentId: 'new-review', report: old.id } as never)).deny).toBe(BLOCKED)
  expect((await $.tool.call(receiptInput('active-0') as never)).deny).toBe(REPORT_ERROR)
  await $.turn.complete({ turnId: 'late', agentId: 'active-0', answer: 'late', reason: 'answer', isAborted: false, durationMs: 1 } as never)
  expect(h.state.value!.observations!['active-0']).toBeUndefined()
  expect((await drain($.turn.step(step('active-0', 'fable', 'max') as never))).answer).toBe(BLOCKED)
})

test('cancellation before dispatch or during persistence prevents final pending writes', async () => {
  for (const timing of ['preflight', 'reserve', 'write', 'after-write', 'in-flight']) {
    const h = direct(), stop = new AbortController(); register(h.on, {} as never)
    const baseWrite = h.host.fs.write, baseSet = h.host.state.set
    let first = true, dispatched = 0
    if (timing === 'preflight') h.host.settings.read = async () => { stop.abort(); return { worktree: { baseRef: 'head' } } }
    h.host.state.set = async (key, value, options) => {
      const result = await baseSet(key, value, options)
      if (timing === 'reserve' && key.key === 'runtime' && result.isSet) stop.abort()
      return result
    }
    h.host.fs.write = async (path, text) => {
      if (first) {
        first = false
        if (timing === 'write') stop.abort()
        await baseWrite(path, text)
        if (timing === 'after-write') stop.abort()
      } else await baseWrite(path, text)
    }
    const next = Object.assign(async () => { dispatched++; if (timing === 'in-flight') stop.abort(); return launched('cancelled') }, { signal: stop.signal })
    const result = await h.handlers.get('tool.callAgent')!(h.host, call('cancelled'), next)
    expect(dispatched).toBe(timing === 'in-flight' ? 1 : 0)
    if (timing !== 'in-flight') expect(result.deny).toBe(BLOCKED)
    if (timing === 'preflight') { expect(h.state.value).toBeUndefined(); expect(h.writes).toHaveLength(0) }
    else { expect(h.state.value!.runs).toEqual({}); expect(persisted(h, 1).status).toBe('blocked') }
  }
})

test('fresh contradictory identity evidence invalidates cached types without changing cached authorization', async ($, on) => {
  const h = world(on); on('turn.step', inference); await started($)
  h.agents.push(row('external', 'fork'))
  expect((await drain($.turn.step(step('external', 'fable', 'max') as never))).answer).toBe('ok')
  h.agents[0]!.type = 'spider-team:developer'
  h.agents.push(row('new'))
  expect((await drain($.turn.step(step('new') as never))).answer).toBe('ok')
  h.faults.list = true
  expect((await drain($.turn.step(step('external', 'fable', 'max') as never))).answer).toBe(BLOCKED)
  expect((await drain($.turn.step(step('external', 'opus', 'high') as never))).answer).toBe(BLOCKED)
})

test('eviction waits for the current write and late dispatch callbacks cannot restore dropped entries', async () => {
  const h = direct(); register(h.on, {} as never)
  const hook = h.handlers.get('tool.callAgent')!, signal = new AbortController().signal
  let finishFirst!: (value: unknown) => void, finishWrite!: () => void, writeStarted!: () => void
  const native = new Promise(resolve => { finishFirst = resolve })
  const first = hook(h.host, call('old'), Object.assign(() => native, { signal }))
  // Wait until the initial decision has been saved and the native call is pending.
  for (let n = 0; n < 100 && !h.writes.length; n++) await Promise.resolve()
  const baseWrite = h.host.fs.write, startedWrite = new Promise<void>(resolve => { writeStarted = resolve })
  let hold = true
  h.host.fs.write = async (path, text) => {
    if (hold) { hold = false; writeStarted(); await new Promise<void>(resolve => { finishWrite = resolve }) }
    await baseWrite(path, text)
  }
  const second = hook(h.host, call('second'), Object.assign(async () => ({ deny: 'denied' }), { signal }))
  await startedWrite
  const third = hook(h.host, call('third'), Object.assign(async () => ({ deny: 'denied' }), { signal }))
  expect(h.state.value!.runs.old).toBeDefined(); expect(h.state.value!.runs.third).toBeUndefined()
  finishWrite(); await second; await third
  // Drop the incomplete call as retention does. Its pending native callback must not reinsert it.
  delete h.state.value!.runs.old
  const writes = h.writes.length
  finishFirst(launched('late-child')); await first
  expect(h.state.value!.runs.old).toBeUndefined(); expect(h.writes).toHaveLength(writes)
})
