import { expect, test } from 'claude-code/testing'
import { EFFORT_FLOOR, MODEL_FLOORS, SPECIALISTS, nativeCodexSpecs } from '../hooks/agents'
import type { Specialist } from '../hooks/agents'
import { decide, describe, moved, noticeText, route, routable, sizeCodexJob, stateOf, taggedDescription, untagged } from '../hooks/routing'
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

// --- The task's tag ---

const IDS = ['gpt-6-astra', 'gpt-5.3-codex-max', 'vendor:model.v2']

test('the tag takes an alias or a registered model id before the effort, and only at the end', () => {
  for (const [text, bare] of [
    ['audit auth · opus/high', 'audit auth'],
    ['audit auth · sonnet/medium', 'audit auth'],
    ['audit auth · gpt-6-astra/medium', 'audit auth'],
    ['audit auth · gpt-5.3-codex-max/low', 'audit auth'],
    ['audit auth · vendor:model.v2/high', 'audit auth'],
    ['audit auth · opus/high · gpt-6-astra/medium', 'audit auth · opus/high'],
  ] as const) {
    expect(untagged(text, IDS)).toBe(bare)
  }
  for (const text of [
    'audit auth', 'audit auth · opus/extreme', 'audit auth · /high', 'audit auth · gpt 6/high', `audit auth · ${'m'.repeat(65)}/high`,
    'audit auth · opus/high now', 'audit auth opus/high', 'audit auth · a/b/high',
  ]) {
    expect(untagged(text, IDS)).toBe(text)
  }
})

test('a model id that is no alias and not registered is user text: it stays', () => {
  expect(untagged('docs · v2/high')).toBe('docs · v2/high')
  expect(untagged('docs · v2/high', IDS)).toBe('docs · v2/high')
  expect(untagged('x · gpt-6-astra/high')).toBe('x · gpt-6-astra/high')
  expect(untagged('x · gpt-6-astra/high', ['gpt-6-astra'])).toBe('x')
  expect(untagged('x · sonnet/medium')).toBe('x')
  expect(untagged('x · gpt-6-astra/high', ['gpt-6-astr'])).toBe('x · gpt-6-astra/high')
  expect(untagged('x · gpt-6-astra/high', ['astra'])).toBe('x · gpt-6-astra/high')
  // A dot in a registered id is a dot, not a wildcard.
  expect(untagged('x · gpt-5x3-codex-max/high', ['gpt-5.3-codex-max'])).toBe('x · gpt-5x3-codex-max/high')
})

test('a tag the plugin writes is stripped again, for a model alias and for a model id', () => {
  const routed = (model: string, effort: string) => ({ decision: { model, effort }, ms: 1 }) as unknown as Routed
  for (const model of ['haiku', 'sonnet', 'opus', 'gpt-6-astra']) {
    expect(untagged(taggedDescription('audit auth', routed(model, 'high')), ['gpt-6-astra'])).toBe('audit auth')
  }
})

// --- The -codex twins: effort only ---

const twins = nativeCodexSpecs({ developer: 'gpt-6-astra', architect: 'gpt-6-sage', 'code-reader': 'gpt-6-mini' })
const twin = (name: string) => routable({ subagentType: `crew:${name}` }, twins)!

test('a -codex type is routable only when it is a registered twin, as its base role with its own model', () => {
  for (const { name } of SPECIALISTS) {
    expect(routable({ subagentType: `crew:${name}` }, twins)?.name).toBe(name)
    expect(routable({ subagentType: `crew:${name}-codex` })).toBeUndefined()
  }
  expect(twin('developer-codex')).toMatchObject({ name: 'developer-codex', base: 'developer', model: 'gpt-6-astra', effort: 'medium' })
  expect(twin('developer-codex').prompt).toBe(spec('developer').prompt)
  expect(routable({ subagentType: 'crew:tester-codex' }, twins)).toBeUndefined()
  expect(routable({ subagentType: 'crew:foo-codex' }, nativeCodexSpecs({ developer: 'x' }))).toBeUndefined()
  expect(routable({ subagentType: 'other:developer-codex' }, twins)).toBeUndefined()
  expect(routable({ subagentType: 'crew:developer-codex', model: 'opus' }, twins)).toBeUndefined()
  expect(routable({ subagentType: 'crew:developer-codex', fork: true }, twins)).toBeUndefined()
  expect(routable({ subagentType: 'crew:developer-codex', workflow: {} }, twins)).toBeUndefined()
})

test('a -codex twin keeps its model whatever the tier answer, and moves its effort by the Claude roles\' rule', () => {
  for (const tier of ['haiku', 'sonnet', 'opus'] as const) {
    for (const name of ['developer-codex', 'architect-codex', 'code-reader-codex']) {
      const decision = decide(twin(name), answers([tier, 1], 1.4))
      expect(decision.model).toBe(twin(name).model)
      expect(decision.effort).toBe('medium')
    }
  }
  const t = twin('developer-codex')
  expect(decide(t, answers(['opus', 1], 3.5))).toMatchObject({ model: 'gpt-6-astra', effort: 'high', tier: 'opus', tierConfidence: 1, depth: 3.5 })
  expect(decide(t, answers(['haiku', 1], 2.0)).effort).toBe('medium')
  expect(decide(t, answers(undefined, 0.1)).effort).toBe('medium')
  expect(decide(t, answers(undefined, 3.02)).effort).toBe('high')
  expect(decide(t, answers(undefined, 2.99)).effort).toBe('medium')
  expect(decide(t, answers(undefined, 3.005)).effort).toBe('medium')
  expect(decide(t, answers(undefined, undefined))).toEqual({ model: 'gpt-6-astra', effort: 'medium' })
  for (const depth of [0.1, 1.4, 2.5, 2.9, 3.02, 3.5, 3.96, undefined]) {
    for (const base of ['developer', 'architect', 'code-reader']) {
      expect(decide(twin(`${base}-codex`), answers(undefined, depth)).effort).toBe(decide(spec(base), answers(undefined, depth)).effort)
    }
  }
})

test('nothing moves for a twin whose model is no alias, even without a base mark', () => {
  const bare = { ...twin('developer-codex'), base: undefined }
  expect(decide(bare, answers(['opus', 1], 1.4)).model).toBe('gpt-6-astra')
})

test('moved never names a model for a twin; its effort is named like any other', () => {
  const t = twin('developer-codex')
  const routed = (depth: number): Routed => ({ decision: decide(t, answers(['opus', 1], depth)), ms: 1 })
  expect(moved(t, routed(3.5))).toEqual({ model: undefined, effort: 'high' })
  expect(moved(t, routed(1.4))).toEqual({ model: undefined, effort: undefined })
  expect(moved(t, { decision: { model: 'opus', effort: 'medium' }, ms: 1 })).toEqual({ model: undefined, effort: undefined })
})

test('Jev is asked as for the base role, and the tag, notice and line carry the twin\'s model id', () => {
  const t = twin('developer-codex')
  const state = stateOf(t, { prompt: 'p', description: 'audit auth' }, ctx)
  expect(state.agent).toEqual({ type: 'developer', description: 'audit auth' })
  const routed: Routed = { decision: decide(t, answers(['opus', 0.9], 3.5)), ms: 12 }
  expect(taggedDescription('audit auth', routed)).toBe('audit auth · gpt-6-astra/high')
  expect(noticeText(t, routed, undefined)).toBe('crew:developer-codex -> gpt-6-astra · high (jev)')
  expect(describe(t, routed, { effort: 'high' })).toContain('crew:developer-codex')
  expect(describe(t, routed, { effort: 'high' })).toContain('model=gpt-6-astra (default)')
})

// --- Jev decisions for a twin, over the tier, confidence and depth grid ---

const GRID_TWINS = nativeCodexSpecs({ developer: 'gpt-6-astra', architect: 'gpt-6-sage' })
const gridAnswers = (tier: string, confidence: number, depth: number) => ({
  tier: { choice: tier, confidence },
  reasoning_depth: { score: depth },
})

test('on the whole grid, any tier at any confidence leaves a twin\'s model alone and moved() never names one', () => {
  for (const type of ['crew:developer-codex', 'crew:architect-codex']) {
    const spec = routable({ subagentType: type }, GRID_TWINS)!
    expect(spec).toBeDefined()
    for (const tier of ['haiku', 'sonnet', 'opus', 'fable', 'gpt-6']) {
      for (const confidence of [0, 0.49, 0.5, 0.8, 1]) {
        for (const depth of [0, 2.9, 3, 3.5, 4]) {
          const decision = decide(spec, gridAnswers(tier, confidence, depth))
          expect(decision.model).toBe(spec.model)
          const routed: Routed = { decision, ms: 1 }
          expect(moved(spec, routed).model).toBeUndefined()
        }
      }
    }
  }
})

test('on the grid, twin effort follows the base rule: 2.9 medium, 3.0 tie keeps default, 3.5 high; architect-codex not forced to opus', () => {
  for (const type of ['crew:developer-codex', 'crew:architect-codex']) {
    const spec = routable({ subagentType: type }, GRID_TWINS)!
    const base = SPECIALISTS.find(s => `crew:${s.name}-codex` === type)!
    for (const depth of [2.9, 3.0, 3.5, 3.005, 2.995]) {
      expect(decide(spec, gridAnswers('opus', 1, depth)).effort).toBe(decide(base, gridAnswers('opus', 1, depth)).effort)
    }
    expect(decide(spec, gridAnswers('haiku', 1, 2.9)).effort).toBe('medium')
    expect(decide(spec, gridAnswers('haiku', 1, 3.0)).effort).toBe(spec.effort)
    expect(decide(spec, gridAnswers('haiku', 1, 3.5)).effort).toBe('high')
  }
  const architect = routable({ subagentType: 'crew:architect-codex' }, GRID_TWINS)!
  expect(decide(architect, gridAnswers('haiku', 1, 3.5)).model).toBe('gpt-6-sage')
  expect(decide(architect, gridAnswers('opus', 1, 3.5)).model).toBe('gpt-6-sage')
})

test('a twin not in the registered list, an unregistered type, a fork or a given model is not routable', () => {
  expect(routable({ subagentType: 'crew:tester-codex' }, GRID_TWINS)).toBeUndefined()
  expect(routable({ subagentType: 'crew:developer-codex' })).toBeUndefined()
  expect(routable({ subagentType: 'crew:developer-codex', model: 'opus' }, GRID_TWINS)).toBeUndefined()
  expect(routable({ subagentType: 'crew:developer-codex', fork: true }, GRID_TWINS)).toBeUndefined()
  expect(routable({ subagentType: 'acme:developer-codex' }, GRID_TWINS)).toBeUndefined()
})


// --- The tag: only a known model is stripped ---

const tagRouted = (model: string, effort: 'low' | 'medium' | 'high'): Routed => ({ decision: { model, effort }, ms: 1 })

test('strips one trailing tag of an alias or a registered id', () => {
  const ids = ['gpt-6-astra', 'gpt-6.1-codex:mini', 'x', 'y']
  expect(untagged('audit · gpt-6-astra/high', ids)).toBe('audit')
  expect(untagged('audit · opus/medium', ids)).toBe('audit')
  expect(untagged('audit · gpt-6.1-codex:mini/low', ids)).toBe('audit')
  expect(untagged('a · x/high · y/low', ids)).toBe('a · x/high')
  expect(untagged('audit', ids)).toBe('audit')
})

test('descriptions that are not a tag at the end are kept, even with a registered id in them', () => {
  const ids = ['v2', 'x', 'gpt']
  expect(untagged('docs · v2/high-level', ids)).toBe('docs · v2/high-level')
  expect(untagged('migrate · api/v2/high', ids)).toBe('migrate · api/v2/high')
  expect(untagged('a · x/xhigh', ids)).toBe('a · x/xhigh')
  expect(untagged('a ·x/high', ids)).toBe('a ·x/high')
  expect(untagged(`a · ${'m'.repeat(65)}/high`, ids)).toBe(`a · ${'m'.repeat(65)}/high`)
  expect(untagged('a · gpt 6/high', ids)).toBe('a · gpt 6/high')
})

// A description whose own text ends in the tag shape names no known model, so it is not a tag.
test('"docs · v2/high" and "compare · old/low" keep their endings', () => {
  expect(untagged('docs · v2/high')).toBe('docs · v2/high')
  expect(untagged('compare · old/low', ['gpt-6-astra'])).toBe('compare · old/low')
})

test('round trip, tagging then untagging gives the description back, and re-tagging does not double', () => {
  for (const description of ['audit auth', 'docs · v2/high-level', 'a/b · c', 'x · y/high · z']) {
    for (const model of ['opus', 'gpt-6-astra', 'gpt-6.1-codex-max']) {
      const tagged = taggedDescription(description, tagRouted(model, 'high'))
      expect(untagged(tagged, [model])).toBe(description)
      const again = taggedDescription(untagged(tagged, [model]), tagRouted(model, 'medium'))
      expect(again).toBe(`${description} · ${model}/medium`)
    }
  }
})


// --- T8 retest (tester): untagged after the F2 fix ---

test('T8 retest: only alias tags and registered twin ids are stripped; ids are matched literally', () => {
  expect(untagged('docs · v2/high')).toBe('docs · v2/high')
  expect(untagged('docs · v2/high', ['gpt-6-astra'])).toBe('docs · v2/high')
  expect(untagged('audit · opus/high')).toBe('audit')
  expect(untagged('audit · haiku/low', ['gpt-6-astra'])).toBe('audit')
  expect(untagged('audit · gpt-6-astra/high', ['gpt-6-astra'])).toBe('audit')
  // Without the twin registered, its id is not a tag the plugin could have written.
  expect(untagged('audit · gpt-6-astra/high')).toBe('audit · gpt-6-astra/high')
  // The '.' in an id is literal, not a wildcard.
  expect(untagged('audit · gpt-6x1/high', ['gpt-6.1'])).toBe('audit · gpt-6x1/high')
  expect(untagged('audit · gpt-6.1/medium', ['gpt-6.1'])).toBe('audit')
  // A prefix or a suffix of a known name is not that name.
  expect(untagged('audit · xopus/high')).toBe('audit · xopus/high')
  expect(untagged('audit · gpt-6-astra-mini/high', ['gpt-6-astra'])).toBe('audit · gpt-6-astra-mini/high')
  expect(untagged('a · opus/high · sonnet/low')).toBe('a · opus/high')
  for (const description of ['audit', 'docs · v2/high', 'x · y/high · z']) {
    for (const model of ['opus', 'gpt-6.1-codex-max']) {
      const tagged = taggedDescription(description, { decision: { model, effort: 'high' }, ms: 1 })
      expect(untagged(tagged, ['gpt-6.1-codex-max'])).toBe(description)
    }
  }
})
