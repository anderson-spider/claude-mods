import { expect, test } from 'claude-code/testing'
import { BASE, call, completed, direct, drain, id, inference, launched, persisted, ports, receiptInput, row, spawn, started, step, usage, world } from './host'
import { BLOCKED } from '../hooks/dispatch'
import { REPORT_ERROR } from '../hooks/report'
import { SPECS } from '../hooks/roles'
import { register } from '../hooks/register'

test('session start registers four native agents and only report and diff tools', async ($, on) => {
  const h = world(on); await started($)
  expect(h.specs.map(s => s.name)).toEqual(['analyst', 'developer', 'reviewer', 'architect'])
  for (const spec of h.specs) expect(spec).toEqual(SPECS[spec.name as keyof typeof SPECS])
  expect(h.tools.map(t => t.name)).toEqual(['report', 'diff'])
  expect(h.tools[0]!.inputSchema).toHaveProperty('required', ['status', 'summary', 'verdict', 'body'])
  expect(h.tools[1]!.inputSchema).toHaveProperty('required', ['report'])
})
test('Agent clamps once preserves frozen input and leaves external calls untouched', async ($, on) => {
  const h = world(on), received: unknown[] = []
  on('tool.call', { tool: 'Agent' }, (_$, e) => { received.push(e); return { ...completed('unlinked'), warnings: ['native warning'] } as never })
  await started($)
  const e = Object.freeze({ ...call(), agentId: 'parent', model: 'opus', effort: 'max' })
  const result = await $.tool.call(e as never)
  expect(received).toHaveLength(1); expect(received[0]).toMatchObject({ tool_use_id: e.tool_use_id, agentId: 'parent', model: 'opus', effort: 'high' })
  expect(e.effort).toBe('max'); expect(result).toHaveProperty('warnings', ['native warning'])
  const log = persisted(h, 1)
  expect(log.observed).toEqual([]); expect(log.handbackChars).toBeNull(); expect(log.status).toBe('partial')
  const other = { ...call('external'), subagent_type: 'fork', model: 'fable', effort: 'max' }
  await $.tool.call(other as never); expect(received[1]).toEqual(other); expect(h.state.value!.counter).toBe(1)
})
test('preflight refuses hidden model effort and native isolation conflicts before next', async ($, on) => {
  const h = world(on); let count = 0
  on('tool.call', { tool: 'Agent' }, () => { count++; return { deny: 'should not run' } })
  await started($)
  for (const key of ['CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_EFFORT_LEVEL']) {
    h.env[key] = 'max'; expect((await $.tool.call(call(key) as never)).deny).toBe(BLOCKED); delete h.env[key]
  }
  for (const patch of [{ model: 'fable' }, { effort: 8000 }, { isolation: 'remote' }, { isolation: 'worktree' }]) expect((await $.tool.call({ ...call(), ...patch } as never)).deny).toBe(BLOCKED)
  h.io.baseRef = 'main'; expect((await $.tool.call(call('dev', 'developer') as never)).deny).toBe(BLOCKED)
  expect(count).toBe(0); expect(h.requests).toHaveLength(0)
})
test('native denial and rejected next preserve results without retry or retained tombstones', async () => {
  const h = direct(); register(h.on, {} as never)
  const hook = h.handlers.get('tool.callAgent')!, error = new Error('native failure')
  let attempts = 0
  const next = Object.assign(async () => { attempts++; throw error }, { signal: new AbortController().signal })
  let caught: unknown
  try { await hook(h.host, call(), next) } catch (e) { caught = e }
  expect(caught).toBe(error); expect(attempts).toBe(1); expect(h.state.value!.runs).toEqual({}); expect(persisted(h, 1).status).toBe('blocked')
  h.faults.write = true
  const denied = await hook(h.host, call('denied'), Object.assign(async () => { attempts++; return { deny: 'native denial' } }, { signal: next.signal }))
  expect(denied.deny).toBe('native denial'); expect(attempts).toBe(2); expect(h.state.value!.runs).toEqual({})
  const spawnHook = h.handlers.get('agent.spawn')!
  try { await spawnHook(h.host, spawn(), next) } catch (e) { expect(e).toBe(error) }
  expect(attempts).toBe(3)
})
test('native rewrite to external passes and a role swap authorizes only the effective native role', async ($, on) => {
  const h = world(on); on('turn.step', inference)
  on('agent.spawn', async (_$, e) => {
    const type = e.description
    h.agents.push(row(e.tool_use_id, type))
    expect((await drain($.turn.step(step(e.tool_use_id, type === 'fork' ? 'fable' : 'opus', type === 'fork' ? 'max' : 'high') as never))).answer).toBe('ok')
    return { agentId: e.tool_use_id, model: 'haiku' }
  })
  on('tool.call', { tool: 'Agent' }, async (_$, e) => {
    const toolId = (e as { tool_use_id: string }).tool_use_id
    await $.agent.spawn(spawn(toolId, { description: (e as { description: string }).description }) as never)
    return launched(toolId) as never
  })
  await started($)
  await $.tool.call({ ...call('external'), description: 'fork' } as never)
  expect((await $.tool.call(receiptInput('external') as never)).deny).toBe(REPORT_ERROR)
  await $.tool.call({ ...call('swapped'), description: 'spider-team:reviewer' } as never)
  expect((await $.tool.call(receiptInput('swapped') as never)).deny).toBe(REPORT_ERROR)
  const saved = await $.tool.call(receiptInput('swapped', { verdict: 'APPROVED' }) as never)
  expect(saved.result).toContain('verdict: APPROVED')
  expect(h.state.value!.references!.swapped!.role).toBe('reviewer')
  expect(h.files.get(h.state.value!.references!.swapped!.report!.path)).toContain('role: reviewer')
  expect(persisted(h, 2).divergence).toBe(true)
})
test('early synchronous reports block until exact spawn linkage and receipt delivery deduplicates usage', async ($, on) => {
  const h = world(on); on('turn.step', inference); on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.spawn', async () => {
    h.agents.push(row('child'))
    await drain($.turn.step(step('child') as never))
    expect((await $.tool.call(receiptInput('child') as never)).deny).toBe(REPORT_ERROR)
    return { agentId: 'child', model: 'haiku' }
  })
  on('tool.call', { tool: 'Agent' }, async () => {
    await $.agent.spawn(spawn() as never)
    const saved = await $.tool.call(receiptInput('child') as never), receipt = saved.result as string
    expect(receipt).toContain('sections:'); expect(receipt).not.toContain('Private report evidence')
    const before = h.writes.length
    expect((await $.tool.call(receiptInput('child') as never)).result).toBe(receipt)
    expect(h.writes.slice(before).filter(p => p.endsWith('.md'))).toHaveLength(0)
    const done = { turnId: 'done', agentId: 'child', answer: receipt, reason: 'answer', isAborted: false, durationMs: 10, usage: { ...usage, model: 'haiku' } }
    await $.turn.complete(done as never); await $.turn.complete(done as never)
    return { ...completed('child', receipt), warnings: ['native warning'] } as never
  })
  await started($); const result = await $.tool.call(call() as never)
  expect(result).toHaveProperty('warnings', ['native warning']); expect(h.state.value!.runs).toEqual({})
  const log = persisted(h, 1)
  expect(log.status).toBe('done'); expect(log.usage.input).toBe(5); expect(log.handbackChars).toBe(log.receiptChars)
  expect(JSON.stringify(log)).not.toContain('Private report evidence')
})
test('developer exact context preserves base checkout and native reconciliation and diff verifies author', async ($, on) => {
  const h = world(on); on('turn.step', inference); on('turn.complete', (_$, e) => ({ text: e.answer }))
  let wrongCheckout = false
  on('agent.spawn', async (_$, e) => {
    h.agents.push(row(e.tool_use_id, e.subagentType)); await drain($.turn.step(step(e.tool_use_id, 'sonnet', 'medium') as never))
    return { agentId: e.tool_use_id, model: 'sonnet' }
  })
  on('tool.call', { tool: 'Agent' }, async (_$, e) => {
    const c = e as { tool_use_id: string; subagent_type: string; isolation?: string }
    if (c.subagent_type === 'spider-team:developer') expect(c.isolation).toBe('worktree')
    await $.agent.spawn(spawn(c.tool_use_id, { subagentType: c.subagent_type, model: 'sonnet' }) as never)
    if (c.subagent_type !== 'spider-team:developer') return launched(c.tool_use_id) as never
    const saved = await $.tool.call(receiptInput(c.tool_use_id, { worktreePath: '/native worktree', worktreeBranch: 'feat/task' }) as never)
    expect(saved.result).toContain(`base: ${BASE}`)
    await $.turn.complete({ agentId: c.tool_use_id, turnId: c.tool_use_id, answer: saved.result as string, reason: 'answer', isAborted: false, durationMs: 1 } as never)
    return completed(c.tool_use_id, saved.result as string, { worktreePath: wrongCheckout ? '/wrong' : '/native worktree', worktreeBranch: 'feat/task' }) as never
  })
  await started($); await $.tool.call(call('dev', 'developer') as never); await $.tool.call(call('review', 'reviewer') as never)
  const report = h.state.value!.references!.dev!.report!.id
  const diff = { tool: id('diff'), tool_use_id: 'diff', agentId: 'review', report }
  expect(JSON.parse((await $.tool.call(diff as never)).result as string).base).toBe(BASE)
  expect((await $.tool.call({ ...diff, agentId: 'dev' } as never)).deny).toBe(BLOCKED)
  expect((await $.tool.call({ ...diff, report: '/arbitrary' } as never)).deny).toBe(BLOCKED)
  wrongCheckout = true; await $.tool.call(call('bad-dev', 'developer') as never)
  expect(persisted(h, 3).status).toBe('blocked')
  expect((await $.tool.call({ ...diff, report: h.state.value!.references!['bad-dev']!.report!.id } as never)).deny).toBe(BLOCKED)
})
test('report and diff refuse unknown ambiguous and expired contexts without fallback', async ($, on) => {
  const h = world(on); on('turn.step', inference)
  let child = 'shared'
  on('agent.spawn', async () => {
    if (!h.agents.some(a => a.id === child)) h.agents.push(row(child))
    await drain($.turn.step(step(child) as never)); return { agentId: child, model: 'haiku' }
  })
  on('tool.call', { tool: 'Agent' }, async (_$, e) => { await $.agent.spawn(spawn((e as { tool_use_id: string }).tool_use_id) as never); return launched(child) as never })
  await started($)
  h.agents.push(row('unlinked'))
  expect((await $.tool.call(receiptInput('unlinked') as never)).deny).toBe(REPORT_ERROR)
  await $.tool.call(call('one') as never); await $.tool.call(call('two') as never)
  expect(h.state.value!.references!.shared!.ambiguous).toBe(true)
  for (const key of [1, 2]) { expect(persisted(h, key).observed).toEqual([]); expect(persisted(h, key).handbackChars).toBeNull() }
  expect((await $.tool.call(receiptInput('shared') as never)).deny).toBe(REPORT_ERROR)
  child = 'retained'; await $.tool.call(call('three') as never)
  const saved = await $.tool.call(receiptInput(child) as never)
  expect(saved.result).toContain('report-id:')
  const path = h.state.value!.references!.retained!.report!.path
  delete h.state.value!.references!.retained
  expect((await $.tool.call(receiptInput(child) as never)).deny).toBe(REPORT_ERROR)
  expect(h.files.has(path)).toBe(true)
  // The still-retained run/report must never be a fallback for an expired reference.
  h.agents.push(row('review', 'spider-team:reviewer'))
  expect((await $.tool.call({ tool: id('diff'), tool_use_id: 'd', agentId: 'review', report: path } as never)).deny).toBe(BLOCKED)
})
test('separate sessions keep identity caches and decision namespaces apart across registration', async () => {
  const shared = ports(), sessions = [direct('session-a', shared), direct('session-b', shared)]
  for (const h of sessions) {
    register(h.on, {} as never)
    const next = Object.assign(async () => ({ deny: 'native denial' }), { signal: new AbortController().signal })
    await h.handlers.get('tool.callAgent')!(h.host, call(), next)
  }
  const paths = [...shared.files.keys()].filter(p => p.endsWith('.json'))
  expect(paths).toHaveLength(2); expect(sessions[0]!.state.value!.namespace).not.toBe(sessions[1]!.state.value!.namespace)
  shared.agents.push(row('same', 'fork'))
  const first = sessions[0]!, second = sessions[1]!
  const next = Object.assign((e: any) => inference(undefined, e), { called: false })
  expect((await drain(first.handlers.get('turn.step')!(first.host, step('same', 'fable', 'max'), next))).answer).toBe('ok')
  register(first.on, {} as never); shared.faults.list = true
  expect((await drain(first.handlers.get('turn.step')!(first.host, step('same', 'fable', 'max'), next))).answer).toBe('ok')
  await expect(drain(second.handlers.get('turn.step')!(second.host, step('same'), next))).rejects.toThrow()
  for (const text of shared.files.values()) for (const secret of ['Private task', 'dispatch-1', '/home/u', 'session-a', 'session-b']) expect(text).not.toContain(secret)
})

test('one call with conflicting exact child links cannot authorize either author', async ($, on) => {
  const h = world(on); on('turn.step', inference)
  let count = 0
  on('agent.spawn', async () => {
    const agentId = `child-${++count}`
    h.agents.push(row(agentId)); await drain($.turn.step(step(agentId) as never))
    return { agentId, model: 'haiku' }
  })
  on('tool.call', { tool: 'Agent' }, async () => {
    await $.agent.spawn(spawn() as never); await $.agent.spawn(spawn() as never)
    return launched('child-2') as never
  })
  await started($); await $.tool.call(call() as never)
  for (const agentId of ['child-1', 'child-2']) expect((await $.tool.call(receiptInput(agentId) as never)).deny).toBe(REPORT_ERROR)
  expect(persisted(h, 1).observed).toEqual([]); expect(persisted(h, 1).handbackChars).toBeNull()
})

test('background completion and duplicate delivery survive hot registration without reading native output', async ($, on) => {
  const h = world(on); on('turn.step', inference); on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.spawn', async () => { h.agents.push(row('background')); await drain($.turn.step(step('background') as never)); return { agentId: 'background', model: 'haiku' } })
  on('tool.call', { tool: 'Agent' }, async () => { await $.agent.spawn(spawn() as never); return launched('background') as never })
  await started($); await $.tool.call(call() as never); await started($)
  h.faults.list = true
  const saved = await $.tool.call(receiptInput('background') as never)
  const done = { agentId: 'background', turnId: 'background-done', answer: saved.result as string, reason: 'answer', isAborted: false, durationMs: 2, usage: { ...usage, model: 'haiku' } }
  await $.turn.complete(done as never); await $.turn.complete(done as never)
  expect(persisted(h, 1).status).toBe('done'); expect(persisted(h, 1).usage.input).toBe(5)
  expect(h.state.value!.runs).toEqual({}); expect(h.reads).not.toContain('/native/output')
})

test('cancellation during assessment prevents native dispatch and state reservation', async () => {
  type CallHook = (host: unknown, event: unknown, next: unknown) => Promise<{ deny?: string }>
  let hook: CallHook | undefined
  register(((event: string, ...args: unknown[]) => {
    if (event === 'tool.call' && (args[0] as { tool?: string }).tool === 'Agent') hook = args[1] as CallHook
    return { catch: () => {} }
  }) as never, {} as never)
  const h = ports(), stop = new AbortController(); let dispatched = 0, reserved = 0
  const host = {
    session: { version: async () => ({ version: '2.1.299' }), root: async () => '/repo' },
    settings: { read: async () => ({}) }, env: { get: async (name: string) => name === 'HOME' ? '/home/u' : name === 'JEV_API_KEY' ? 'test-key' : undefined },
    agent: { list: h.io.list }, clock: { after: () => ({ cancel: () => {} }), now: async () => 0 },
    http: { fetch: async () => { stop.abort(); return { status: 200, headers: {}, text: JSON.stringify({ answers: h.answers }) } } },
    state: { get: async () => ({ version: 0, value: undefined }), set: async () => { reserved++; return { isSet: true } } },
    ui: { log: () => {} },
  }
  const next = Object.assign(async () => { dispatched++; return {} }, { signal: stop.signal })
  expect((await hook!(host, Object.freeze(call()), next)).deny).toBe(BLOCKED)
  expect(dispatched).toBe(0); expect(reserved).toBe(0)
})
