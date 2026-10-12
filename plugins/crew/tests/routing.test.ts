import { expect, test } from 'claude-code/testing'
import { EFFORT_FLOOR, SPECIALISTS, nativeCodexSpecs } from '../hooks/agents'
import type { Specialist } from '../hooks/agents'
import { decide, defaultsOf, describe, moved, noticeText, retarget, route, routable, stateOf, taggedDescription, twinFor, untagged } from '../hooks/routing'
import type { Routed } from '../hooks/routing'
import { PROMPT_CHARS } from '../hooks/questions'

const spec = (name: string) => SPECIALISTS.find(s => s.name === name) as Specialist
const answers = (depth: number | undefined) => ({
  ...(depth === undefined ? {} : { reasoning_depth: { score: depth, confidence: 0.5 } }),
})
const ctx = { home: '/Users/jane', root: '/Users/jane/app' }

test('depth 3.0 is the bound to high; below it is medium, never below the medium floor', () => {
  expect(EFFORT_FLOOR).toBe('medium')
  // Every agent defaults to medium: a depth under 3.0 keeps it, a depth from 3.0 up raises it to high.
  for (const s of SPECIALISTS) {
    expect(decide(s, answers(0.1)).effort).toBe('medium')
    expect(decide(s, answers(0.74)).effort).toBe('medium')
    expect(decide(s, answers(1.43)).effort).toBe('medium')
    expect(decide(s, answers(2.5)).effort).toBe('medium')
    expect(decide(s, answers(2.9)).effort).toBe('medium')
    expect(decide(s, answers(3.02)).effort).toBe('high')
    expect(decide(s, answers(3.96)).effort).toBe('high')
  }
})

test('a depth within 0.01 of the bound or no depth keeps the default effort', () => {
  const high = { ...spec('developer'), effort: 'high' as const }
  expect(decide(high, answers(3.0)).effort).toBe('high')
  expect(decide(high, answers(2.995)).effort).toBe('high')
  expect(decide(high, answers(3.005)).effort).toBe('high')
  expect(decide(high, answers(2.98)).effort).toBe('medium')
  expect(decide(spec('developer'), answers(3.0)).effort).toBe('medium')
  expect(decide(spec('developer'), answers(2.995)).effort).toBe('medium')
  expect(decide(spec('developer'), answers(undefined)).effort).toBe('medium')
  expect(decide(spec('developer'), { reasoning_depth: { score: 'high' } }).effort).toBe('medium')
})

test('a high-default agent drops one step below the bound, never below the medium floor', () => {
  const high = { ...spec('developer'), effort: 'high' as const }
  expect(decide(high, answers(3.02)).effort).toBe('high')
  expect(decide(high, answers(2.98)).effort).toBe('medium')
  expect(decide(high, answers(0.2)).effort).toBe('medium')
})

test('3.01 and 2.99 are ties in floating point (|d - 3.0| is 0.00999..., under 0.01): they keep the default', () => {
  // Documented as "within 0.01": both edges count as within, so the default stays; 3.011 and 2.989 are outside.
  const high = { ...spec('developer'), effort: 'high' as const }
  expect(decide(spec('developer'), answers(3.01)).effort).toBe('medium')
  expect(decide(high, answers(2.99)).effort).toBe('high')
  expect(decide(spec('developer'), answers(3.011)).effort).toBe('high')
  expect(decide(high, answers(2.989)).effort).toBe('medium')
})

test('unusable answers change nothing', () => {
  const none = decide(spec('developer'), {})
  expect(none).toEqual({ effort: 'medium' })
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
    return { answers: answers(3.9), model: 'jev-1.13.0', ms: 12 }
  }
  const routed = await route(ask, ctx, spec('developer'), { prompt: 'audit the auth migration', description: 'audit' })
  expect(routed.decision).toMatchObject({ effort: 'high', depth: 3.9 })
  expect(JSON.stringify(asked)).toContain('audit the auth migration')
  const line = describe(spec('developer'), routed, { effort: 'high' })
  expect(line).toContain('crew:developer')
  expect(line).toContain('model=sonnet (default)')
  expect(line).toContain('jev=jev-1.13.0')
  expect(line).not.toContain('auth migration')
})

const routedAs = (effort: 'low' | 'medium' | 'high'): Routed => ({
  decision: { effort },
  ms: 5,
})

test('moved names only what differs from the agent defaults, and nothing without an answer', () => {
  // developer defaults to sonnet and medium.
  expect(moved(spec('developer'), routedAs('high'))).toEqual({ effort: 'high' })
  expect(moved(spec('developer'), routedAs('medium'))).toEqual({ effort: undefined })
  expect(moved(spec('developer'), undefined)).toEqual({ effort: undefined })
})

test('the notice shows the answered effort, or the default with the moved effort named as not applied', () => {
  const routed = routedAs('high')
  expect(noticeText(spec('developer'), routed, undefined)).toBe('crew:developer -> sonnet · high (jev)')
  expect(noticeText(spec('developer'), routed, 'high')).toBe('crew:developer -> sonnet · medium (jev; effort high not applied)')
})

test('a default effort outside the floor and high still routes to the floor', () => {
  expect(decide({ ...spec('developer'), effort: 'high' }, answers(0.1)).effort).toBe('medium')
  expect(decide({ ...spec('developer'), effort: 'low' }, answers(0.1)).effort).toBe('medium')
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
  const routed = (effort: 'medium' | 'high'): Routed => ({ decision: { effort }, ms: 1 })
  for (const model of ['haiku', 'sonnet', 'opus', 'gpt-6-astra']) {
    expect(untagged(taggedDescription('audit auth', routed('high'), model), ['gpt-6-astra'])).toBe('audit auth')
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
  expect(twin('developer-codex')).toMatchObject({ name: 'developer-codex', base: 'developer', effort: 'medium' })
  expect(twin('developer-codex').prompt).toBe(spec('developer').prompt)
  expect(routable({ subagentType: 'crew:tester-codex' }, twins)).toBeUndefined()
  expect(routable({ subagentType: 'crew:foo-codex' }, nativeCodexSpecs({ developer: 'x' }))).toBeUndefined()
  expect(routable({ subagentType: 'other:developer-codex' }, twins)).toBeUndefined()
  expect(routable({ subagentType: 'crew:developer-codex', model: 'opus' }, twins)).toBeUndefined()
  expect(routable({ subagentType: 'crew:developer-codex', fork: true }, twins)).toBeUndefined()
  expect(routable({ subagentType: 'crew:developer-codex', workflow: {} }, twins)).toBeUndefined()
})

test('a -codex twin follows the same effort rule as Claude roles', () => {
  const t = twin('developer-codex')
  expect(decide(t, answers(3.5))).toMatchObject({ effort: 'high', depth: 3.5 })
  expect(decide(t, answers(2.0)).effort).toBe('medium')
  expect(decide(t, answers(0.1)).effort).toBe('medium')
  expect(decide(t, answers(3.02)).effort).toBe('high')
  expect(decide(t, answers(2.99)).effort).toBe('medium')
  expect(decide(t, answers(3.005)).effort).toBe('medium')
  expect(decide(t, answers(undefined))).toEqual({ effort: 'medium' })
  for (const depth of [0.1, 1.4, 2.5, 2.9, 3.02, 3.5, 3.96, undefined]) {
    for (const base of ['developer', 'architect', 'code-reader']) {
      expect(decide(twin(`${base}-codex`), answers(depth)).effort).toBe(decide(spec(base), answers(depth)).effort)
    }
  }
})

test('moved names only effort for a twin, like for any other role', () => {
  const t = twin('developer-codex')
  const routed = (depth: number): Routed => ({ decision: decide(t, answers(depth)), ms: 1 })
  expect(moved(t, routed(3.5))).toEqual({ effort: 'high' })
  expect(moved(t, routed(1.4))).toEqual({ effort: undefined })
  expect(moved(t, { decision: { effort: 'medium' }, ms: 1 })).toEqual({ effort: undefined })
})

test('Jev is asked as for the base role, and the tag, notice and line carry the twin\'s model id', () => {
  const t = twin('developer-codex')
  const state = stateOf(t, { prompt: 'p', description: 'audit auth' }, ctx)
  expect(state.agent).toEqual({ type: 'developer', description: 'audit auth' })
  const routed: Routed = { decision: decide(t, answers(3.5)), ms: 12 }
  expect(taggedDescription('audit auth', routed, 'gpt-6-astra')).toBe('audit auth · gpt-6-astra/high')
  expect(noticeText(t, routed, undefined)).toBe('crew:developer-codex -> gpt-6-astra · high (jev)')
  expect(describe(t, routed, { effort: 'high' })).toContain('crew:developer-codex')
  expect(describe(t, routed, { effort: 'high' })).toContain('model=gpt-6-astra (default)')
})

// --- Jev decisions for a twin over the depth grid ---

const GRID_TWINS = nativeCodexSpecs({ developer: 'gpt-6-astra', architect: 'gpt-6-sage' })

test('on the grid, twin effort follows the base rule: 2.9 medium, 3.0 tie keeps default, 3.5 high', () => {
  for (const type of ['crew:developer-codex', 'crew:architect-codex']) {
    const spec = routable({ subagentType: type }, GRID_TWINS)!
    const base = SPECIALISTS.find(s => `crew:${s.name}-codex` === type)!
    for (const depth of [2.9, 3.0, 3.5, 3.005, 2.995]) {
      expect(decide(spec, answers(depth)).effort).toBe(decide(base, answers(depth)).effort)
    }
    expect(decide(spec, answers(2.9)).effort).toBe('medium')
    expect(decide(spec, answers(3.0)).effort).toBe(spec.effort)
    expect(decide(spec, answers(3.5)).effort).toBe('high')
  }
})

test('a twin not in the registered list, an unregistered type, a fork or a given model is not routable', () => {
  expect(routable({ subagentType: 'crew:tester-codex' }, GRID_TWINS)).toBeUndefined()
  expect(routable({ subagentType: 'crew:developer-codex' })).toBeUndefined()
  expect(routable({ subagentType: 'crew:developer-codex', model: 'opus' }, GRID_TWINS)).toBeUndefined()
  expect(routable({ subagentType: 'crew:developer-codex', fork: true }, GRID_TWINS)).toBeUndefined()
  expect(routable({ subagentType: 'acme:developer-codex' }, GRID_TWINS)).toBeUndefined()
})

// --- The tag: only a known model is stripped ---

const tagRouted = (effort: 'low' | 'medium' | 'high'): Routed => ({ decision: { effort }, ms: 1 })

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
      const tagged = taggedDescription(description, tagRouted('high'), model)
      expect(untagged(tagged, [model])).toBe(description)
      const again = taggedDescription(untagged(tagged, [model]), tagRouted('medium'), model)
      expect(again).toBe(`${description} · ${model}/medium`)
    }
  }
})

// --- untagged with registered twin ids ---

test('only alias tags and registered twin ids are stripped; ids are matched literally', () => {
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
      const tagged = taggedDescription(description, { decision: { effort: 'high' }, ms: 1 }, model)
      expect(untagged(tagged, ['gpt-6.1-codex-max'])).toBe(description)
    }
  }
})

// --- Quota routing: the twin a call may move to ---

const QUOTA_TWINS = nativeCodexSpecs({ developer: 'gpt-6-astra', architect: 'gpt-6-sage' })

test('twinFor names the role\'s registered twin as a target with its base, for a plain specialist call', () => {
  const target = twinFor({ subagentType: 'crew:developer' }, QUOTA_TWINS)
  expect(target).toMatchObject({ name: 'developer-codex', base: 'developer', effort: 'medium' })
  expect(twinFor({ subagentType: 'crew:architect' }, QUOTA_TWINS)).toMatchObject({ name: 'architect-codex', base: 'architect' })
})

test('twinFor is undefined where the call must stay as it is', () => {
  // A role with no registered twin, and no twins at all.
  expect(twinFor({ subagentType: 'crew:tester' }, QUOTA_TWINS)).toBeUndefined()
  expect(twinFor({ subagentType: 'crew:developer' }, [])).toBeUndefined()
  // An explicit model, a fork, a workflow agent and a teammate.
  expect(twinFor({ subagentType: 'crew:developer', model: 'opus' }, QUOTA_TWINS)).toBeUndefined()
  expect(twinFor({ subagentType: 'crew:developer', fork: true }, QUOTA_TWINS)).toBeUndefined()
  expect(twinFor({ subagentType: 'crew:developer', workflow: { runId: 'wf_1', agentIndex: 1 } }, QUOTA_TWINS)).toBeUndefined()
  expect(twinFor({ subagentType: 'crew:developer', isTeammate: true }, QUOTA_TWINS)).toBeUndefined()
  // Another plugin's type, an unknown crew type, and a twin the lead named (an explicit choice is never moved).
  expect(twinFor({ subagentType: 'acme:developer' }, QUOTA_TWINS)).toBeUndefined()
  expect(twinFor({ subagentType: 'crew:mystery' }, QUOTA_TWINS)).toBeUndefined()
  expect(twinFor({ subagentType: 'crew:developer-codex' }, QUOTA_TWINS)).toBeUndefined()
})

test('Jev\'s answers retargeted to a twin keep the effort answer and never name a model', async () => {
  const twin = twinFor({ subagentType: 'crew:developer' }, QUOTA_TWINS)!
  const ask = async () => ({ answers: answers(3.9), model: 'jev-1.13.0', ms: 7 })
  const onClaude = await route(ask, ctx, spec('developer'), { prompt: 'p', description: 'd' })
  expect(onClaude.decision).toEqual({ effort: 'high', depth: 3.9 })

  const onTwin = retarget(onClaude, twin)
  expect(onTwin.decision).toMatchObject({ effort: 'high', depth: 3.9 })
  expect(onTwin).toMatchObject({ jevModel: 'jev-1.13.0', ms: 7 })
  expect(moved(twin, onTwin)).toEqual({ effort: 'high' })
  // The first answer is not changed by the second reading of it.
})

test('retarget without stored answers reads them as empty: the twin\'s defaults', () => {
  const twin = twinFor({ subagentType: 'crew:developer' }, QUOTA_TWINS)!
  expect(retarget({ decision: { effort: 'high' }, ms: 1 }, twin).decision).toEqual({ effort: 'medium' })
})

test('defaultsOf is an explicit medium effort fallback and tags with the fixed twin model', () => {
  const twin = twinFor({ subagentType: 'crew:developer' }, QUOTA_TWINS)!
  const routed = defaultsOf(twin)
  expect(routed).toEqual({ decision: { effort: 'medium' }, ms: 0 })
  expect(moved(twin, routed)).toEqual({ effort: undefined })
  expect(taggedDescription('audit auth', routed, 'gpt-6-astra')).toBe('audit auth · gpt-6-astra/medium')
})

test('the notice of a switched call names the provider and the reason, with Jev\'s effort marked or the default plain', () => {
  const twin = twinFor({ subagentType: 'crew:developer' }, QUOTA_TWINS)!
  const via = { requested: 'crew:developer', reason: '7d 38% used vs Claude 7d 71%' }
  const jev = retarget({ decision: { effort: 'high' }, ms: 1, answers: answers(3.9) }, twin)
  expect(noticeText(twin, jev, undefined, via)).toBe('crew:developer -> Codex (7d 38% used vs Claude 7d 71%) · gpt-6-astra · high (jev)')
  expect(noticeText(twin, jev, 'high', via)).toBe('crew:developer -> Codex (7d 38% used vs Claude 7d 71%) · gpt-6-astra · medium (jev; effort high not applied)')
  expect(noticeText(twin, defaultsOf(twin), undefined, via, false)).toBe('crew:developer -> Codex (7d 38% used vs Claude 7d 71%) · gpt-6-astra · medium')
})

test('a call that was not switched keeps the notice it always had', () => {
  expect(noticeText(spec('developer'), routedAs('high'), undefined, undefined, true)).toBe('crew:developer -> sonnet · high (jev)')
})

test('decide returns effort and depth only, even if an unsolicited tier answer is present', () => {
  for (const target of [...SPECIALISTS, ...twins]) {
    expect(decide(target, { reasoning_depth: { score: 3.5 }, tier: { choice: 'opus', confidence: 1 } })).toEqual({ effort: 'high', depth: 3.5 })
  }
})

test('the fallback is medium even for a high-default role', () => {
  expect(defaultsOf({ ...spec('developer'), effort: 'high' }).decision).toEqual({ effort: 'medium' })
})

test('a rejected medium fallback shows known high or explicitly unknown effort, never an applied medium', () => {
  const target = spec('developer')
  const routed = defaultsOf(target)
  expect(noticeText(target, routed, 'medium', undefined, false, 'high')).toBe('crew:developer -> sonnet · high (crew; effort medium not applied)')
  expect(noticeText(target, routed, 'medium', undefined, false, null)).toBe('crew:developer -> sonnet · effort unknown (crew; effort medium not applied)')
})
