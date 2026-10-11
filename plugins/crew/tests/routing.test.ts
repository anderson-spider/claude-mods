import { expect, test } from 'claude-code/testing'
import { EFFORT_FLOOR, MODEL_FLOORS, SPECIALISTS } from '../hooks/agents'
import type { Specialist } from '../hooks/agents'
import { decide, describe, moved, noticeText, route, routable, sizeCodexJob, stateOf } from '../hooks/routing'
import type { CodexSizing, Routed } from '../hooks/routing'
import { PROMPT_CHARS } from '../hooks/questions'
import { JevFailure, createBreaker, createGate, createJev } from '../hooks/jev'
import type { JevIo } from '../hooks/jev'

const spec = (name: string) => SPECIALISTS.find(s => s.name === name) as Specialist
const answers = (tier: [string, number] | undefined, depth: number | undefined) => ({
  ...(tier ? { tier: { choice: tier[0], confidence: tier[1], probabilities: {} } } : {}),
  ...(depth === undefined ? {} : { reasoning_depth: { score: depth, confidence: 0.5 } }),
})
const ctx = { home: '/Users/jane', root: '/Users/jane/app' }

test('the tier follows Jev inside the default +-1 window', () => {
  // developer defaults to sonnet: haiku, sonnet and opus are all one step away.
  expect(decide(spec('developer'), answers(['haiku', 0.97], 1.4)).model).toBe('haiku')
  expect(decide(spec('developer'), answers(['sonnet', 0.98], 1.4)).model).toBe('sonnet')
  expect(decide(spec('developer'), answers(['opus', 0.98], 1.4)).model).toBe('opus')
})

test('a tier two steps from the default is clamped to one step', () => {
  expect(decide(spec('code-reader'), answers(['opus', 0.99], 1.4)).model).toBe('sonnet')
  expect(decide(spec('architect'), answers(['haiku', 0.99], 3.9)).model).toBe('opus')
})

test('the architect is never below opus, and the floor is stated for it only', () => {
  expect(MODEL_FLOORS).toEqual({ architect: 'opus' })
  for (const choice of ['haiku', 'sonnet', 'opus']) {
    const { model } = decide(spec('architect'), answers([choice, 0.99], 0.2))
    expect(model).toBe('opus')
  }
})

test('a tier answer below 0.5 confidence keeps the default model', () => {
  expect(decide(spec('developer'), answers(['opus', 0.49], 1.4)).model).toBe('sonnet')
  expect(decide(spec('developer'), answers(['opus', 0.5], 1.4)).model).toBe('opus')
  expect(decide(spec('code-reader'), answers(['sonnet', 0.2], 0.2)).model).toBe('haiku')
})

test('depth 3.0 is the bound to high; below it is medium, never below the medium floor', () => {
  expect(EFFORT_FLOOR).toBe('medium')
  // Every agent defaults to medium: a depth under 3.0 keeps it, a depth from 3.0 up raises it to high.
  for (const s of SPECIALISTS) {
    expect(decide(s, answers(undefined, 0.1)).effort).toBe('medium')
    expect(decide(s, answers(undefined, 0.74)).effort).toBe('medium')
    expect(decide(s, answers(undefined, 1.43)).effort).toBe('medium')
    expect(decide(s, answers(undefined, 2.5)).effort).toBe('medium')
    expect(decide(s, answers(undefined, 2.9)).effort).toBe('medium')
    expect(decide(s, answers(undefined, 3.02)).effort).toBe('high')
    expect(decide(s, answers(undefined, 3.96)).effort).toBe('high')
  }
})

test('a depth within 0.01 of the bound or no depth keeps the default effort', () => {
  const high = { ...spec('developer'), effort: 'high' as const }
  expect(decide(high, answers(undefined, 3.0)).effort).toBe('high')
  expect(decide(high, answers(undefined, 2.995)).effort).toBe('high')
  expect(decide(high, answers(undefined, 3.005)).effort).toBe('high')
  expect(decide(high, answers(undefined, 2.98)).effort).toBe('medium')
  expect(decide(spec('developer'), answers(undefined, 3.0)).effort).toBe('medium')
  expect(decide(spec('developer'), answers(undefined, 2.995)).effort).toBe('medium')
  expect(decide(spec('developer'), answers(undefined, undefined)).effort).toBe('medium')
  expect(decide(spec('developer'), { reasoning_depth: { score: 'high' } }).effort).toBe('medium')
})

test('the architect (opus, floor) keeps opus at any depth and moves effort only from the bound', () => {
  expect(decide(spec('architect'), answers(['haiku', 0.99], 3.5))).toMatchObject({ model: 'opus', effort: 'high' })
  expect(decide(spec('architect'), answers(['haiku', 0.99], 0.2))).toMatchObject({ model: 'opus', effort: 'medium' })
})

test('a high-default agent drops one step below the bound, never below the medium floor', () => {
  const high = { ...spec('developer'), effort: 'high' as const }
  expect(decide(high, answers(undefined, 3.02)).effort).toBe('high')
  expect(decide(high, answers(undefined, 2.98)).effort).toBe('medium')
  expect(decide(high, answers(undefined, 0.2)).effort).toBe('medium')
})

test('the tier applies at confidence 0.5 and not at 0.49, whatever the depth', () => {
  expect(decide(spec('developer'), answers(['opus', 0.49], 3.5))).toMatchObject({ model: 'sonnet', effort: 'high' })
  expect(decide(spec('developer'), answers(['opus', 0.5], 3.5))).toMatchObject({ model: 'opus', effort: 'high' })
})

test('3.01 and 2.99 are ties in floating point (|d - 3.0| is 0.00999..., under 0.01): they keep the default', () => {
  // Documented as "within 0.01": both edges count as within, so the default stays; 3.011 and 2.989 are outside.
  const high = { ...spec('developer'), effort: 'high' as const }
  expect(decide(spec('developer'), answers(undefined, 3.01)).effort).toBe('medium')
  expect(decide(high, answers(undefined, 2.99)).effort).toBe('high')
  expect(decide(spec('developer'), answers(undefined, 3.011)).effort).toBe('high')
  expect(decide(high, answers(undefined, 2.989)).effort).toBe('medium')
})

test('unusable answers change nothing', () => {
  const none = decide(spec('tester'), {})
  expect(none).toEqual({ model: 'sonnet', effort: 'medium' })
  expect(decide(spec('tester'), answers(['gpt', 0.99], undefined)).model).toBe('sonnet')
  expect(decide(spec('tester'), { tier: { choice: 'opus', confidence: 'high' } }).model).toBe('sonnet')
})

test('only crew agents from the table, not forks, not calls that name a model', () => {
  expect(routable({ subagentType: 'crew:developer' })?.name).toBe('developer')
  expect(routable({ subagentType: 'crew:developer', fork: true })).toBeUndefined()
  expect(routable({ subagentType: 'crew:developer', model: 'opus' })).toBeUndefined()
  expect(routable({ subagentType: 'crew:developer', workflow: { runId: 'wf_1', agentIndex: 1 } })).toBeUndefined()
  expect(routable({ subagentType: 'crew:unknown' })).toBeUndefined()
  for (const type of ['general-purpose', 'Explore', 'fork', 'developer', 'other:developer']) {
    expect(routable({ subagentType: type })).toBeUndefined()
  }
})

test('the state names the role and carries the prompt as its own redacted, capped field', () => {
  const token = ['ghp_', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4'].join('')
  const prompt = `Read /Users/jane/app/src/a.ts and fix it. token ${token}\n${'x'.repeat(PROMPT_CHARS * 2)}`
  const state = stateOf(spec('developer'), { prompt, description: 'fix a.ts' }, ctx)
  expect(state.agent).toEqual({ type: 'developer', description: 'fix a.ts' })
  expect(state.task.prompt).toContain('src/a.ts')
  expect(state.task.prompt).not.toContain(token)
  expect(state.task.prompt).not.toContain('/Users/jane')
  expect(state.task.prompt.length).toBeLessThanOrEqual(PROMPT_CHARS + 1)
})

test('route asks once and decides; its log line holds no prompt', async () => {
  let asked: unknown
  const ask = async (_questions: unknown, state: unknown) => {
    asked = state
    return { answers: answers(['opus', 0.9], 3.9), model: 'jev-1.13.0', ms: 12 }
  }
  const routed = await route(ask, ctx, spec('developer'), { prompt: 'audit the auth migration', description: 'audit' })
  expect(routed.decision).toMatchObject({ model: 'opus', effort: 'high', tier: 'opus', tierConfidence: 0.9, depth: 3.9 })
  expect(JSON.stringify(asked)).toContain('audit the auth migration')
  const line = describe(spec('developer'), routed, { model: 'opus', effort: 'high' })
  expect(line).toContain('crew:developer')
  expect(line).toContain('model=opus')
  expect(line).toContain('jev=jev-1.13.0')
  expect(line).not.toContain('auth migration')
})

const routedAs = (model: 'haiku' | 'sonnet' | 'opus', effort: 'low' | 'medium' | 'high'): Routed => ({
  decision: { model, effort },
  ms: 5,
})

test('moved names only what differs from the agent defaults, and nothing without an answer', () => {
  // developer defaults to sonnet and medium.
  expect(moved(spec('developer'), routedAs('opus', 'high'))).toEqual({ model: 'opus', effort: 'high' })
  expect(moved(spec('developer'), routedAs('sonnet', 'high'))).toEqual({ model: undefined, effort: 'high' })
  expect(moved(spec('developer'), routedAs('haiku', 'medium'))).toEqual({ model: 'haiku', effort: undefined })
  expect(moved(spec('developer'), routedAs('sonnet', 'medium'))).toEqual({ model: undefined, effort: undefined })
  expect(moved(spec('developer'), undefined)).toEqual({ model: undefined, effort: undefined })
})

test('the notice shows the answered effort, or the default with the moved effort named as not applied', () => {
  const routed = routedAs('opus', 'high')
  expect(noticeText(spec('developer'), routed, undefined)).toBe('crew:developer -> opus · high (jev)')
  expect(noticeText(spec('developer'), routed, 'high')).toBe('crew:developer -> opus · medium (jev; effort high not applied)')
})

test('a default effort outside the floor and high still routes to the floor', () => {
  expect(decide({ ...spec('developer'), effort: 'high' }, answers(undefined, 0.1)).effort).toBe('medium')
  expect(decide({ ...spec('developer'), effort: 'low' }, answers(undefined, 0.1)).effort).toBe('medium')
})

test('route hands its signal to ask, so the client sees an Esc; without one ask gets none', async () => {
  const seen: (AbortSignal | undefined)[] = []
  const ask = async (_q: unknown, _s: unknown, signal?: AbortSignal) => {
    seen.push(signal)
    return { answers: answers(undefined, 1.4), ms: 1 }
  }
  const stop = new AbortController()
  await route(ask, ctx, spec('developer'), { prompt: 'p', description: 'd' }, stop.signal)
  await route(ask, ctx, spec('developer'), { prompt: 'p', description: 'd' })
  expect(seen[0]).toBe(stop.signal)
  expect(seen[1]).toBeUndefined()
})

test('route over the real client with an aborted signal fails aborted and sends nothing', async () => {
  const sent: unknown[] = []
  const io: JevIo = {
    fetch: async (_url, init) => { sent.push(init); return { status: 200, text: '{"answers":{}}' } },
    timer: () => () => {},
    now: () => 0,
  }
  const stop = new AbortController()
  stop.abort()
  const ask = createJev(io, ['sk-test-', 'abcdefghijklmnopqrstuvwx'].join(''), { model: 'jev-1.13.0', gate: createGate(), breaker: createBreaker(() => 0) })
  let reason: string | undefined
  try {
    await route(ask, ctx, spec('developer'), { prompt: 'p', description: 'd' }, stop.signal)
  } catch (error) {
    reason = error instanceof JevFailure ? error.reason : String(error)
  }
  expect(reason).toBe('aborted')
  expect(sent).toEqual([])
})

// --- sizeCodexJob: the order of its steps and its abort checks ---

const goodReply = { answers: answers(['opus', 0.9], 3.5), model: 'jev-1.13.0', ms: 5 }

function sizing(over: Partial<CodexSizing> = {}) {
  const calls: string[] = []
  const signals: (AbortSignal | undefined)[] = []
  const deps: CodexSizing = {
    enabled: true,
    key: async () => { calls.push('key'); return 'k' },
    context: async () => { calls.push('context'); return { home: '', root: '' } },
    ask: () => async (_q, _s, signal) => { calls.push('ask'); signals.push(signal); return goodReply },
    log: line => { calls.push(`log ${line}`) },
    ...over,
  }
  return { deps, calls, signals }
}

test('sizeCodexJob: Jev\'s depth gives high, the signal reaches the client, and one debug line names role and job id', async () => {
  const s = sizing()
  const stop = new AbortController()
  expect(await sizeCodexJob(s.deps, 'developer', 'd', 'p', stop.signal, 'cx-1')).toBe('high')
  expect(s.signals).toEqual([stop.signal])
  expect(s.calls.at(-1)).toMatch(/^log crew jev: codex:developer cx-1 depth=3\.50 effort=high jev=jev-1\.13\.0 5ms$/)
})

test('sizeCodexJob: routing off answers the base without asking for the key, the context or Jev', async () => {
  const s = sizing({ enabled: false })
  expect(await sizeCodexJob(s.deps, 'developer', 'd', 'p', new AbortController().signal, 'cx-1')).toBe('medium')
  expect(s.calls).toEqual([])
})

test('sizeCodexJob: no key answers the base and goes no further', async () => {
  const s = sizing({ key: async () => undefined })
  expect(await sizeCodexJob(s.deps, 'developer', 'd', 'p', new AbortController().signal, 'cx-1')).toBe('medium')
  expect(s.calls).toEqual([])
})

test('sizeCodexJob: an abort before anything, during the key and during the redaction context sends no request', async () => {
  const before = new AbortController(); before.abort()
  const a = sizing()
  expect(await sizeCodexJob(a.deps, 'developer', 'd', 'p', before.signal, 'cx-1')).toBe('medium')
  expect(a.calls).toEqual([])

  const duringKey = new AbortController()
  const b = sizing({ key: async () => { duringKey.abort(); return 'k' } })
  expect(await sizeCodexJob(b.deps, 'developer', 'd', 'p', duringKey.signal, 'cx-1')).toBe('medium')
  expect(b.calls).toEqual([])

  const duringContext = new AbortController()
  const c = sizing({ context: async () => { duringContext.abort(); return { home: '', root: '' } } })
  expect(await sizeCodexJob(c.deps, 'developer', 'd', 'p', duringContext.signal, 'cx-1')).toBe('medium')
  expect(c.calls).toEqual(['key'])
})

test('sizeCodexJob: a failure answers the base with one line that carries the reason only', async () => {
  const s = sizing({ ask: () => async () => { throw new JevFailure('busy', 'too many calls in flight') } })
  expect(await sizeCodexJob(s.deps, 'developer', 'secret description', 'secret prompt', new AbortController().signal, 'cx-1')).toBe('medium')
  expect(s.calls.at(-1)).toBe('log crew jev: codex:developer cx-1 not sized (busy)')
  expect(s.calls.join('\n')).not.toContain('secret')
})

test('sizeCodexJob: a throwing log still answers the base', async () => {
  const s = sizing({ ask: () => async () => { throw new Error('x') }, log: () => { throw new Error('log gone') } })
  expect(await sizeCodexJob(s.deps, 'developer', 'd', 'p', new AbortController().signal, 'cx-1')).toBe('medium')
})
