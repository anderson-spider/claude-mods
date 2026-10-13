import { expect, test } from 'claude-code/testing'
import { KEY, ON, ROOT, answer, jevWorld, ok, pause, record, spawnInput, step, twinWorld } from './host'
import { CODEX_PREFIX } from '../hooks/native'

// --- The fixed -codex types ---

const NATIVE_AND_JEV = ON

test('Jev sizes twin effort without changing either fixed model family', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:architect-codex', tool_use_id: 'tu2' }))

  expect(seen.fetches.length).toBe(2)
  expect(seen.spawned.map(spawned => spawned.subagentType)).toEqual(['crew:developer-codex', 'crew:architect-codex'])
  expect(seen.spawned.map(spawned => spawned.model)).toEqual(['cx/gpt-6-sol-high', 'cx/gpt-6-astra-high'])
  expect(seen.spawned.map(spawned => spawned.description)).toEqual(['audit auth · gpt-6-sol/high', 'audit auth · gpt-6-astra/high'])
})

test('a -codex spawn is routed for its effort: Jev sees the base role, the spawn suffix gets high, the tag and notice name the id', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  const result = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium')

  expect(result).toMatchObject({ model: 'cx/gpt-6-sol-high', agentId: 'a1' })
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6-sol/high' })
  expect(seen.spawned[0]?.model).toBe('cx/gpt-6-sol-high')
  expect(JSON.parse(seen.fetches[0]?.body ?? '{}').state.agent).toEqual({ type: 'developer', description: 'audit auth' })
  expect(seen.steps).toEqual(['medium'])
  expect(seen.notices).toEqual(['crew:developer-codex -> gpt-6-sol · high (jev)'])
  expect(seen.logs.some(line => line.includes('crew:developer-codex') && line.includes('model=gpt-6-sol (default)') && line.includes('effort=high'))).toBe(true)
  expect(JSON.stringify([seen.notices, seen.logs])).not.toContain(KEY)
})

test('a -codex spawn that passes model is refused, so it cannot run on Claude untagged; without model it is routed, and a base role with model is untouched', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: 'opus' }))
  expect(refused).toMatchObject({ deny: expect.stringContaining('without `model`') })
  expect(seen.spawned).toEqual([])
  expect(seen.fetches).toEqual([])

  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', tool_use_id: 'tu2' }))
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6-sol/high' })

  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer', model: 'opus', tool_use_id: 'tu3' }))
  expect(seen.spawned[1]).toMatchObject({ subagentType: 'crew:developer', model: 'opus', description: 'audit auth' })
})

test('a -codex spawn that passes model stays refused after a later session.start registered no twin', NATIVE_AND_JEV, async ($, on) => {
  const { seen, flags } = await twinWorld($, on)
  flags.registerFail = true
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: 'sonnet' }))

  expect(refused).toMatchObject({ deny: expect.stringContaining('without `model`') })
  expect(seen.spawned).toEqual([])
  // Not registered now, so the spawn is not routed (the host rejects an unknown type anyway).
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', tool_use_id: 'tu2' }))
  expect(seen.fetches).toEqual([])
})

test('a -codex spawn at depth 2.0 keeps medium: tagged, announced, nothing moved', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(2.0)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium')

  expect(seen.spawned[0]).toMatchObject({ description: 'audit auth · gpt-6-sol/medium' })
  expect(seen.spawned[0]?.model).toBe('cx/gpt-6-sol-medium')
  expect(seen.steps).toEqual(['medium'])
  expect(seen.notices).toEqual(['crew:developer-codex -> gpt-6-sol · medium (jev)'])
})

test('a Jev error pins an explicit twin to medium with a suffix, while leaving the host step effort untouched', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-sol', reply: async () => ok('not json') })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'low', 'cx/gpt-6-sol-medium')

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6-sol/medium' })
  expect(seen.spawned[0]?.model).toBe('cx/gpt-6-sol-medium')
  expect(seen.steps).toEqual(['low'])
  expect(seen.notices).toEqual(['crew:developer-codex -> gpt-6-sol · medium'])
  expect(record(seen)).toMatchObject({ bind: 'suffix', effortApplied: 'medium', applied: { effort: false }, jevModel: null })
  expect(seen.transcript).toEqual(['crew: audit auth: confirmed gpt-6-sol · medium'])
})

test('without a jevKey a -codex spawn is untouched: no request, no tag, no settings read, nothing recorded', async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-sol' })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium')

  expect(seen.fetches).toEqual([])
  expect(seen.settingsReads).toBe(0)
  expect(seen.spawned[0]).toMatchObject({ description: 'audit auth' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.steps).toEqual(['medium'])
  expect([seen.notices, seen.writes, seen.transcript]).toEqual([[], [], []])
})

test('a -codex type outside the fixed map is not routed', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on)
  await $.agent.spawn(spawnInput({ subagentType: 'crew:unknown-codex' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:mystery-codex', tool_use_id: 'tu2' }))

  expect(seen.fetches).toEqual([])
  expect(seen.spawned.map(spawned => spawned.description)).toEqual(['audit auth', 'audit auth'])
})

test('a tag copied from a -codex task is sent without it and tagged once', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6-sol/medium' }))

  expect(JSON.parse(seen.fetches[0]?.body ?? '{}').state.agent.description).toBe('audit auth')
  expect(seen.spawned[0]?.description).toBe('audit auth · gpt-6-sol/high')
})

test('the record of a -codex decision keeps effort-only v4 fields and the effort that took', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))

  expect(seen.writes.length).toBe(1)
  const record = JSON.parse(seen.writes[0]?.text ?? '{}')
  expect(record).toMatchObject({
    v: 4, agent: 'developer-codex', requested: 'crew:developer-codex', provider: 'codex', defaultEffort: 'medium',
    effortPlanned: 'high', effortApplied: 'high', bind: 'suffix', applied: { effort: true }, ran: null, outcome: null,
  })
  expect(seen.writes[0]?.path).toContain('-a1.json')
  expect(JSON.stringify(record)).not.toContain('audit auth')
})

test('the first step of a routed -codex spawn is confirmed against the id and the effort, in the transcript and the record', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-sol', reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium', 'cx/gpt-6-sol-high')
  await step($, 'a1', 'medium', 'cx/gpt-6-sol-high')

  expect(seen.transcript).toEqual(['jev: audit auth: confirmed gpt-6-sol · high'])
  expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'gpt-6-sol', effort: 'high' })
})

test('a confirmation accepts the id the proxy reports with an effort suffix', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'GPT-6-Sol-high', reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium', 'cx/gpt-6-sol-high')

  expect(seen.transcript).toEqual(['jev: audit auth: confirmed GPT-6-Sol-high · high'])
})

test('a -codex run on another model detects the mismatch and distinguishes unobserved effort', NATIVE_AND_JEV, async ($, on) => {
  let model = 'claude-sonnet-5-5'
  const { seen } = await twinWorld($, on, { stepModel: () => model, reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium', 'cx/gpt-6-sol-high')
  expect(seen.transcript).toEqual(['jev: audit auth: ran claude-sonnet-5-5 · high, not gpt-6-sol/high'])

  model = 'gpt-6-sol-mini'
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', tool_use_id: 'tu2' }))
  await step($, 'a1', null, 'gpt-6-sol')
  expect(seen.transcript.at(-1)).toBe('jev: audit auth: ran model gpt-6-sol-mini, not gpt-6-sol; suffix high requested, effort unobserved')
})

test('a Claude role beside a -codex twin is routed only for effort', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on)
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))

  expect(seen.fetches.length).toBe(2)
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6-sol/high' })
  expect(seen.spawned[0]?.model).toBe('cx/gpt-6-sol-high')
  expect(seen.spawned[1]).toMatchObject({ subagentType: 'crew:developer', description: 'audit auth · sonnet/high' })
})

// --- Jev on the -codex twins, the gate and the registered set, through the host ---

for (const [depth, effort] of [[2.9, 'medium'], [3.0, 'medium'], [3.5, 'high']] as const) {
  for (const type of ['crew:developer-codex', 'crew:architect-codex']) {
    test(`${type} at depth ${depth} pins its fixed model to ${effort} with a suffix`, NATIVE_AND_JEV, async ($, on) => {
      const { seen } = await twinWorld($, on, { reply: async () => ok(answer(depth)) })
      await $.agent.spawn(spawnInput({ subagentType: type }))
      await step($, 'a1', 'medium')

      const id = type === 'crew:architect-codex' ? 'gpt-6-astra' : 'gpt-6-sol'
      expect(seen.spawned[0]?.model).toBe(`${CODEX_PREFIX}${id}-${effort}`)
      expect(seen.spawned[0]?.description).toBe(`audit auth · ${id}/${effort}`)
      expect(seen.steps).toEqual(['medium'])
      expect(seen.notices[0]).toBe(`${type} -> ${id} · ${effort} (jev)`)
    })
  }
}

for (const status of [500, 429, 401]) {
  test(`a Jev ${status} pins a -codex spawn to medium without a late step bind`, NATIVE_AND_JEV, async ($, on) => {
    const { seen, clock } = await twinWorld($, on, { reply: async () => ({ status, ok: false, headers: {}, text: 'no' }) })
    const spawned = $.agent.spawn(spawnInput({ subagentType: 'crew:architect-codex' }))
    await clock.settle()
    await pause()
    await clock.advance(3_000)
    await spawned
    await step($, 'a1', 'low')

    expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:architect-codex', description: 'audit auth · gpt-6-astra/medium' })
    expect(seen.spawned[0]?.model).toBe('cx/gpt-6-astra-medium')
    expect(seen.steps).toEqual(['low'])
    expect(seen.notices).toEqual(['crew:architect-codex -> gpt-6-astra · medium'])
    expect(record(seen)).toMatchObject({ bind: 'suffix', effortApplied: 'medium', jevModel: null })
  })
}

test('crew:architect beside architect-codex keeps its default model and routes effort', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:architect-codex' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:architect', tool_use_id: 'tu2' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer', tool_use_id: 'tu3' }))

  expect(seen.spawned[0]?.model).toBe('cx/gpt-6-astra-high')
  expect(seen.spawned[1]?.model).toBeUndefined()
  expect(seen.spawned[1]?.description).toBe('audit auth · opus/high')
  expect(seen.spawned[2]).toMatchObject({ description: 'audit auth · sonnet/high' })
})

// The twins Jev may size are the ones this session registered, not the fixed definitions.
test('with Anthropic\'s API as base URL no twin is registered, so a crew:developer-codex spawn is not sent to Jev', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = jevWorld(on, { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, register: true, reply: async () => ok(answer(3.5)) })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))

  expect(seen.fetches).toEqual([])
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.notices).toEqual([])
})

test('with the base URL unset, or before any session start, a -codex spawn is not sent to Jev either', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = jevWorld(on, { register: true })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', tool_use_id: 'tu2' }))

  expect(seen.fetches).toEqual([])
})

test('a description that ends like a tag of an unknown model keeps its ending when a -codex spawn is tagged', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', description: 'docs · v2/high' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer', description: 'docs · v2/high', tool_use_id: 'tu2' }))

  expect(JSON.parse(seen.fetches[0]?.body ?? '{}').state.agent.description).toBe('docs · v2/high')
  expect(seen.spawned[0]?.description).toBe('docs · v2/high · gpt-6-sol/high')
  expect(seen.spawned[1]?.description).toBe('docs · v2/high · sonnet/high')
})

test('with twins registered, an unregistered twin and a Claude role: one request each for the Claude role and the twin', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:unknown-codex', description: 'find · gpt-6-sol/high' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', description: 'fix · gpt-6-sol/medium', tool_use_id: 'tu2' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer', description: 'fix · opus/high', tool_use_id: 'tu3' }))

  expect(seen.fetches.length).toBe(2)
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:unknown-codex', description: 'find · gpt-6-sol/high' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.spawned[1]?.description).toBe('fix · gpt-6-sol/high')
  expect(seen.spawned[1]?.model).toBe('cx/gpt-6-sol-high')
  expect(seen.spawned[2]).toMatchObject({ description: 'fix · sonnet/high' })
})

// A `model` on a registered twin's spawn is refused before Jev, with routing on or off.

const DENY_TEXT = (type: string) => `crew: ${type} runs on its own Codex model; call it again without \`model\``

test('without a jevKey a -codex spawn that passes model is still refused and reaches no host; without model it passes untagged', async ($, on) => {
  const { seen } = await twinWorld($, on)
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: 'opus' }))
  expect(refused).toMatchObject({ deny: DENY_TEXT('crew:developer-codex') })
  const architect = await $.agent.spawn(spawnInput({ subagentType: 'crew:architect-codex', model: 'sonnet', tool_use_id: 'tu2' }))
  expect(architect).toMatchObject({ deny: DENY_TEXT('crew:architect-codex') })
  expect(seen.spawned).toEqual([])
  expect(seen.fetches).toEqual([])
  expect(seen.notices).toEqual([])
  expect(seen.writes).toEqual([])

  // Without model, the twin passes untouched: no Jev, no tag.
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', tool_use_id: 'tu3' }))
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  // A base role with model, routing off, is untouched.
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer', model: 'opus', tool_use_id: 'tu4' }))
  expect(seen.spawned[1]).toMatchObject({ subagentType: 'crew:developer', model: 'opus', description: 'audit auth' })
  expect(seen.fetches).toEqual([])
})

test('a -codex spawn that passes its own Codex id as model is refused too', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on)
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: 'gpt-6-sol' }))
  expect(refused).toMatchObject({ deny: DENY_TEXT('crew:developer-codex') })
  expect(seen.spawned).toEqual([])
  expect(seen.fetches).toEqual([])
})

test('a -codex spawn with an empty model is not refused: it is routed and tagged as without one', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  const result = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: '' }))
  expect(result).not.toHaveProperty('deny')
  expect(seen.fetches).toHaveLength(1)
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6-sol/high' })
})

test('a -codex spawn with model from inside a subagent is refused like one from the main loop', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on)
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:designer-codex', model: 'haiku', parentAgentId: 'p1' }))
  expect(refused).toMatchObject({ deny: DENY_TEXT('crew:designer-codex') })
  expect(seen.spawned).toEqual([])
  expect(seen.fetches).toEqual([])
})

test('a fork flag on a -codex spawn with model does not lift the refusal, and a real fork with model goes on untouched', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on)
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: 'opus', fork: true }))
  expect(refused).toMatchObject({ deny: DENY_TEXT('crew:developer-codex') })
  expect(seen.spawned).toEqual([])
  // A real fork (type `fork`) with model is not a twin and goes on untouched.
  await $.agent.spawn(spawnInput({ subagentType: 'fork', model: 'opus', fork: true, tool_use_id: 'tu2' }))
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'fork', model: 'opus', description: 'audit auth' })
  expect(seen.fetches).toEqual([])
})

test('an unregistered crew:*-codex type that passes model goes on untouched and is not sent to Jev', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on)
  await $.agent.spawn(spawnInput({ subagentType: 'crew:unknown-codex', model: 'opus' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:mystery-codex', model: 'opus', tool_use_id: 'tu2' }))
  expect(seen.spawned.map(s => [s.subagentType, s.model, s.description])).toEqual([
    ['crew:unknown-codex', 'opus', 'audit auth'],
    ['crew:mystery-codex', 'opus', 'audit auth'],
  ])
  expect(seen.fetches).toEqual([])
})

test('with Anthropic\'s API as base URL no twin is registered, yet a crew:developer-codex spawn that passes model is still refused: the fixed map defines it', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = jevWorld(on, { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, register: true })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: 'opus' }))
  expect(refused).toMatchObject({ deny: expect.stringContaining('without `model`') })
  expect(seen.spawned).toEqual([])
  expect(seen.fetches).toEqual([])
})

test('a workflow agent on a -codex type with model is refused (a hook can only refuse that spawn); without model it passes untagged', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on)
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: 'opus', workflow: { runId: 'wf_1', agentIndex: 1 } }))
  expect(refused).toMatchObject({ deny: DENY_TEXT('crew:developer-codex') })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', workflow: { runId: 'wf_1', agentIndex: 2 }, tool_use_id: 'tu2' }))
  expect(seen.spawned.map(s => [s.subagentType, s.model, s.description])).toEqual([['crew:developer-codex', undefined, 'audit auth']])
  expect(seen.fetches).toEqual([])
})

for (const model of ['cx/gpt-6-sol-medium', 'cx/gpt-6-sol-high']) {
  test(`a caller-supplied twin suffix ${model} is refused before the internal rewrite`, NATIVE_AND_JEV, async ($, on) => {
    const { seen } = await twinWorld($, on)
    expect(await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model }))).toMatchObject({ deny: DENY_TEXT('crew:developer-codex') })
    expect([seen.spawned, seen.fetches, seen.notices, seen.writes]).toEqual([[], [], [], []])
  })
}

for (const excluded of [{ fork: true }, { workflow: { runId: 'wf_1', agentIndex: 1 } }]) {
  test(`an explicit twin excluded by ${Object.keys(excluded)[0]} gets no suffix`, NATIVE_AND_JEV, async ($, on) => {
    const { seen } = await twinWorld($, on)
    await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', ...excluded }))
    expect(seen.spawned[0]).toMatchObject({ description: 'audit auth', subagentType: 'crew:developer-codex' })
    expect(seen.spawned[0]?.model).toBeUndefined()
    expect([seen.fetches, seen.notices, seen.writes]).toEqual([[], [], []])
  })
}

test('a twin outgoing model without effort evidence confirms only the model', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-sol:high' })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  // An API-reported suffix alone cannot establish outgoing effort.
  await step($, 'a1', null, 'gpt-6-sol')
  expect(seen.transcript).toEqual(['jev: audit auth: confirmed model gpt-6-sol:high; suffix high requested, effort unobserved'])
  expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'gpt-6-sol:high', effort: null })
  expect(record(seen)).toMatchObject({ bind: 'suffix', effortApplied: 'high', applied: { effort: true } })
})

for (const effort of ['medium', 'high']) {
  test(`a visible outgoing twin model without a suffix records the observed step effort ${effort}`, NATIVE_AND_JEV, async ($, on) => {
    const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-sol' })
    await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
    await step($, 'a1', effort, 'gpt-6-sol')
    expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'gpt-6-sol', effort })
    expect(seen.transcript[0]).toBe(effort === 'high'
      ? 'jev: audit auth: confirmed gpt-6-sol · high'
      : 'jev: audit auth: ran gpt-6-sol · medium, not gpt-6-sol/high')
  })
}

for (const untrusted of [{ jevKey: 'bad key' }, { jevKey: KEY, repositoryKey: true }]) {
  test(`an explicit twin with ${untrusted.repositoryKey ? 'a repository-declared' : 'an invalid'} key gets the medium fallback`, { options: { jevKey: untrusted.jevKey } }, async ($, on) => {
    const { seen } = await twinWorld($, on, untrusted.repositoryKey ? { project: { pluginConfigs: { crew: { options: { jevKey: 'repo-key' } } } } } : {})
    await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
    expect(seen.spawned[0]).toMatchObject({ description: 'audit auth · gpt-6-sol/medium', subagentType: 'crew:developer-codex' })
    expect(seen.spawned[0]?.model).toBe('cx/gpt-6-sol-medium')
    expect(seen.fetches).toEqual([])
    expect(seen.notices).toEqual(['crew:developer-codex -> gpt-6-sol · medium'])
  })
}

for (const effort of ['medium', 'high']) {
  test(`an observed outgoing twin suffix ${effort} takes precedence over the opposite host effort`, NATIVE_AND_JEV, async ($, on) => {
    const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-sol-20261012' })
    await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
    await step($, 'a1', effort === 'high' ? 'medium' : 'high', `gpt-6-sol(${effort})`)
    expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'gpt-6-sol-20261012', effort })
    expect(seen.transcript[0]).toBe(effort === 'high'
      ? 'jev: audit auth: confirmed gpt-6-sol-20261012 · high'
      : 'jev: audit auth: ran gpt-6-sol-20261012 · medium, not gpt-6-sol/high')
  })
}

for (const overlap of [false, true]) {
  test(`an explicit twin first-step/spawn race (overlap ${overlap}) keeps the suffix and confirms from outgoing evidence`, NATIVE_AND_JEV, async ($, on) => {
    let releaseSpawn: () => void = () => {}
    const heldSpawn = new Promise<void>(resolve => { releaseSpawn = resolve })
    let releaseStep: () => void = () => {}
    const heldStep = new Promise<void>(resolve => { releaseStep = resolve })
    const { seen } = await twinWorld($, on, {
      // No listed id: the first step cannot possibly bind an effort-book entry.
      spawn: async () => { await heldSpawn; return { model: 'cx/gpt-6-sol-high', agentId: 'a1' } },
      stepModel: 'gpt-6-sol',
      stepWait: async () => { if (overlap) await heldStep },
    })
    const spawning = $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
    while (seen.spawned.length === 0) await pause()
    const first = step($, 'a1', 'medium', 'cx/gpt-6-sol-high')
    if (!overlap) await first
    releaseSpawn()
    await spawning
    releaseStep()
    await first
    await step($, 'a1', 'medium', 'cx/gpt-6-sol-high')
    expect(seen.spawned[0]?.model).toBe('cx/gpt-6-sol-high')
    expect(record(seen)).toMatchObject({ bind: 'suffix', effortApplied: 'high', applied: { effort: true } })
    expect(seen.transcript).toEqual(['jev: audit auth: confirmed gpt-6-sol · high'])
    expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'gpt-6-sol', effort: 'high' })
  })
}

for (const throws of [false, true]) {
  test(`an explicit twin spawn that ${throws ? 'throws' : 'is refused'} records no suffix success`, NATIVE_AND_JEV, async ($, on) => {
    const { seen } = await twinWorld($, on, { spawn: async () => {
      if (throws) throw new Error('spawn failed')
      return { deny: 'no' } as never
    } })
    try { await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' })) } catch { /* The host refused the spawn. */ }
    expect(seen.spawned[0]?.model).toBe('cx/gpt-6-sol-high')
    expect([seen.notices, seen.writes, seen.transcript]).toEqual([[], [], []])
  })
}
