import { expect, test } from 'claude-code/testing'
import { HOME, KEY, ON, ROOT, TOKEN, answer, jevWorld, ok, pause, record, spawnInput, step } from './host'
import { fnv1a } from '../hooks/decisions'

// --- Confirmation of what ran ---

test('the first step after the spawn confirms the tag in the transcript and in the decision log', ON, async ($, on) => {
  const { seen } = jevWorld(on, { stepModel: 'claude-haiku-5-5', reply: async () => ok(answer(2.1)) })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high')
  await step($, 'a1', 'high')

  expect(seen.transcript).toEqual(['jev: audit auth: confirmed claude-haiku-5-5 · medium'])
  expect(seen.writes.length).toBe(2)
  expect(seen.writes[1]?.path).toBe(seen.writes[0]?.path)
  expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'claude-haiku-5-5', effort: 'medium' })
  expect(JSON.parse(seen.writes[0]?.text ?? '{}').ran).toBeNull()
})

test('a run that differs from the role default says what ran instead', ON, async ($, on) => {
  const { seen } = jevWorld(on, { stepModel: 'claude-opus-5-5', reply: async () => ok(answer(2.1)) })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high')

  expect(seen.transcript).toEqual(['jev: audit auth: ran claude-opus-5-5 · medium, not haiku/medium'])
})

test('a step the API did not answer confirms nothing and leaves the check for the next', ON, async ($, on) => {
  let answered: string | undefined
  const { seen } = jevWorld(on, { stepModel: () => answered })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high')
  expect(seen.transcript).toEqual([])

  answered = 'claude-haiku-5-5[1m]'
  await step($, 'a1', 'high')
  expect(seen.transcript).toEqual(['jev: audit auth: confirmed claude-haiku-5-5[1m] · medium'])
  expect(JSON.parse(seen.writes.at(-1)?.text ?? '{}').ran).toEqual({ model: 'claude-haiku-5-5[1m]', effort: 'medium' })
})

test('a confirmation write that never settles does not hold the subagent\'s step past the wait', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { stepModel: 'claude-haiku-5-5', writeHang: true })
  const spawned = $.agent.spawn(spawnInput())
  while (seen.notices.length === 0) await pause()
  await clock.advance(1_000)
  await spawned

  const stepped = step($, 'a1', 'high')
  while (seen.transcript.length === 0) await pause()
  await clock.advance(1_000)
  await stepped
  expect(seen.logs.filter(line => line === 'crew jev: decision write slow').length).toBe(2)
})

test('a Jev fallback confirms via crew, while a refused spawn adds nothing', ON, async ($, on) => {
  let refuse = false
  const { seen } = jevWorld(on, {
    stepModel: 'claude-haiku-5-5',
    reply: async () => (refuse ? ok(answer(2.1)) : ok('not json')),
    spawn: async e => (refuse ? ({ deny: 'no' } as never) : { model: String(e.model ?? 'default'), agentId: 'a1' }),
  })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high')
  refuse = true
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
  await step($, 'a1', 'high')

  expect(seen.transcript).toEqual(['crew: audit auth: confirmed claude-haiku-5-5 · high'])
})

test('steps of other agents and of the main loop confirm nothing', ON, async ($, on) => {
  const { seen } = jevWorld(on, { stepModel: 'claude-haiku-5-5' })
  await $.agent.spawn(spawnInput())
  await step($, undefined, 'medium')
  await step($, 'other', 'high')

  expect(seen.transcript).toEqual([])
  expect(seen.writes.length).toBe(1)
})

test('the decision log hashes the description as the call gave it, not the tagged one', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput())

  expect(JSON.parse(seen.writes[0]?.text ?? '{}').descriptionHash).toBe(fnv1a('audit auth'))
})

// --- Decision log ---

const DIR = `${HOME}/.claude/crew/decisions`

test('an applied decision is logged once, in a file named by time and agent id', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer(2.1)) })
  await $.agent.spawn(spawnInput())

  expect(seen.writes).toHaveLength(1)
  const path = seen.writes[0]?.path ?? ''
  expect(path.startsWith(`${DIR}/`)).toBe(true)
  expect(path).toMatch(/\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-a1\.json$/)
  expect(record(seen)).toMatchObject({
    v: 4, agent: 'digger', requested: 'crew:digger', provider: 'claude',
    depth: 2.1,
    defaultEffort: 'high', effortPlanned: 'medium', effortApplied: 'medium',
    jevModel: 'jev-1.13.0', applied: { effort: true }, outcome: null,
  })
  expect(record(seen).descriptionHash).toMatch(/^[0-9a-f]{8}$/)
  expect(typeof record(seen).durationMs).toBe('number')
})

test('a kept decision is logged too, with nothing applied', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer(4.6)) })
  await $.agent.spawn(spawnInput())

  expect(record(seen)).toMatchObject({
    effortPlanned: 'high', effortApplied: 'high', applied: { effort: false },
  })
})

test('an effort that lost the race to the first step is logged as not applied', ON, async ($, on) => {
  const { seen } = jevWorld(on, {
    reply: async () => ok(answer(2.1)),
    spawn: async e => {
      // The subagent steps before the spawn resolves, so the planned effort cannot take.
      await step($, 'a1', 'high')
      return { model: String(e.model ?? 'default'), agentId: 'a1' }
    },
  })
  await $.agent.spawn(spawnInput())

  expect(record(seen)).toMatchObject({ effortPlanned: 'medium', effortApplied: null, applied: { effort: false } })
})

test('the record holds no prompt, description, key or path', ON, async ($, on) => {
  const secret = `Use ${TOKEN} and ${KEY} on ${HOME}/.ssh/id_rsa and ${ROOT}/src/secret.ts, mail jane@example.com`
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput({ prompt: secret, description: `fix ${ROOT}/src/hidden.ts` }))

  const text = seen.writes[0]?.text ?? ''
  for (const leaked of [TOKEN, KEY, '.ssh', 'id_rsa', 'secret.ts', 'hidden.ts', 'jane@example.com', 'fix ', 'Use ', ROOT]) {
    expect(text).not.toContain(leaked)
  }
  expect(Object.keys(record(seen)).sort()).toEqual([
    'agent', 'applied', 'bind', 'defaultEffort', 'depth', 'descriptionHash', 'durationMs',
    'effortApplied', 'effortPlanned', 'jevModel', 'outcome', 'provider', 'ran', 'requested', 'ts', 'v',
  ])
})

test('nothing is written without a trusted home', ON, async ($, on) => {
  const { seen } = jevWorld(on, { env: { HOME: 'relative/home' } })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.writes).toEqual([])
  expect(seen.logs.some(line => line.includes('decision not logged (no trusted home)'))).toBe(true)
})

test('a write error is logged and does not change the spawn', ON, async ($, on) => {
  const { seen } = jevWorld(on, { writeFail: true })
  const result = await $.agent.spawn(spawnInput())

  expect(result).toMatchObject({ model: 'default', agentId: 'a1' })
  expect(seen.notices).toEqual(['crew:digger -> haiku · medium (jev)'])
  expect(seen.logs.some(line => line.includes('decision not logged (write failed)'))).toBe(true)
})

test('calls that are not routed write nothing', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer(5.6)) })
  await $.agent.spawn(spawnInput({ model: 'haiku' }))
  await $.agent.spawn(spawnInput({ subagentType: 'Explore' }))

  expect(seen.writes).toEqual([])
})

test('a write that never settles does not hold the spawn: the result returns after the wait, with one debug line', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { writeHang: true })
  const spawned = $.agent.spawn(spawnInput())
  await clock.settle()
  await pause()
  await clock.advance(1_000)
  const result = await spawned

  expect(result).toMatchObject({ model: 'default', agentId: 'a1' })
  expect(seen.notices).toEqual(['crew:digger -> haiku · medium (jev)'])
  expect(seen.logs.filter(line => line.includes('decision write slow'))).toHaveLength(1)
})

test('a write that settles first leaves no slow line and no timer behind', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on)
  await $.agent.spawn(spawnInput())
  await clock.advance(5_000)

  expect(seen.writes).toHaveLength(1)
  expect(seen.logs.some(line => line.includes('decision write slow'))).toBe(false)
})
