import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fnv1a } from '../hooks/decisions'

const agents = [
  { id: 'a1', type: 'crew:architect' },
  { id: 't1', type: 'crew:tester' },
  { id: 'd1', type: 'crew:developer' },
]

test('session start registers the six specialists with their models', async ($, on) => {
  const registered: { name: string; model?: string; effort?: string | number; tools?: readonly string[] }[] = []

  on('agent.register', (_$, e) => (registered.push(e), { value: { agent: `crew:${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(registered.map(a => [a.name, a.model])).toEqual([
    ['code-reader', 'haiku'],
    ['research', 'haiku'],
    ['designer', 'sonnet'],
    ['developer', 'sonnet'],
    ['tester', 'sonnet'],
    ['architect', 'opus'],
  ])
  expect(registered.find(a => a.name === 'architect')?.tools).not.toContain('Edit')
  expect(registered.find(a => a.name === 'architect')?.tools).toContain('Write')
  expect(registered.find(a => a.name === 'architect')?.effort).toBe('medium')
})

test('a write outside the agent\'s lane is denied, the main loop and other agents pass', async ($, on) => {
  on('agent.list', () => ({ value: agents }) as never)
  on('tool.call', () => ({ result: 'written' }))

  const call = (agentId: string | undefined, file_path: string) => $.tool.call({ tool: 'Write', agentId, file_path } as never)

  expect(await call('a1', 'src/app.ts')).toHaveProperty('deny')
  expect(await call('a1', '.crew/plans/plan.md')).not.toHaveProperty('deny')
  expect(await call('t1', 'src/app.ts')).toHaveProperty('deny')
  expect(await call('t1', 'tests/app.test.ts')).not.toHaveProperty('deny')
  expect(await call('d1', 'src/app.ts')).not.toHaveProperty('deny')
  expect(await call(undefined, 'src/app.ts')).not.toHaveProperty('deny')
})

// --- Jev routing ---

// Key-shaped fixtures are assembled at runtime so no source literal matches a secret scanner.
const KEY = ['key-', 'jev-0123456789abcdef'].join('')
const TOKEN = ['ghp_', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4'].join('')
const HOME = '/home/u'
const ROOT = '/repo'
const ON = { options: { jevKey: KEY } }
const OFF = { options: {} }

const answer = (tier: string, confidence: number, depth: number) =>
  JSON.stringify({
    model: 'jev-1.13.0',
    answers: {
      tier: { choice: tier, confidence, probabilities: { [tier]: confidence } },
      reasoning_depth: { score: depth, confidence: 0.5 },
    },
  })

type Reply = { status: number; ok: boolean; headers: Record<string, string>; text: string }
const ok = (text: string): Reply => ({ status: 200, ok: true, headers: {}, text })

type Seen = {
  fetches: { url: string; headers: Record<string, string>; body: string }[]
  spawned: Record<string, unknown>[]
  steps: (string | number | undefined)[]
  notices: string[]
  logs: string[]
  writes: { path: string; text: string }[]
  /** The lines `$.ui.log` sent to the transcript. */
  transcript: string[]
  settingsReads: number
}

/** The host beneath the plugin: env, settings and files, Jev's endpoint, the spawn and the step the plugin routes. */
function jevWorld(
  on: On,
  opts: {
    env?: Record<string, string>
    project?: Record<string, unknown>
    local?: Record<string, unknown>
    files?: Record<string, string>
    /** The repository's settings cannot be read (the returned `flags` can switch it later). */
    settingsFail?: boolean
    /** The session's directory; the repository root by default. */
    cwd?: string
    reply?: () => Promise<Reply>
    spawn?: (e: Record<string, unknown>) => Promise<{ model: string; agentId: string }>
    agents?: { id: string; type: string; description: string }[]
    /** The decision log's write rejects. */
    writeFail?: boolean
    /** The decision log's write never settles. */
    writeHang?: boolean
    /** The model id the API reports for a step; none by default (no usage). */
    stepModel?: string | (() => string | undefined)
    /** `$.clock.now` answers with this instead of the mock clock's time (the waits stay the mock clock's). */
    now?: () => number
    /** Hooks beneath `$.session.start` and `$.agent.register`, so a test can start the session and register the agents. */
    register?: boolean
  } = {},
) {
  const seen: Seen = { fetches: [], spawned: [], steps: [], notices: [], logs: [], writes: [], transcript: [], settingsReads: 0 }
  const flags = { settingsFail: opts.settingsFail === true, registerFail: false }
  // `mock.clock` registers `clock.now` itself and the engine refuses a second one, so a test's own is registered instead.
  const now = opts.now
  const clock = mock.clock(now ? (((name: string, ...rest: unknown[]) => (name === 'clock.now' ? undefined : (on as (...a: unknown[]) => unknown)(name, ...rest))) as unknown as On) : on)
  if (now) on('clock.now', () => ({ value: now() }))
  mock.env(on, { HOME, ...opts.env })
  on('session.cwd', async () => ({ value: opts.cwd ?? ROOT }))
  on('settings.read', async (_$, e) => {
    seen.settingsReads++
    if (flags.settingsFail) throw new Error('settings unreadable')
    return {
      value: (e.source === 'project' ? opts.project : e.source === 'local' ? opts.local : undefined) ?? {},
    } as never
  })
  on('fs.read', async (_$, e) => {
    const text = opts.files?.[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    if (opts.writeFail) throw new Error('EACCES')
    if (opts.writeHang) return new Promise<never>(() => {})
    seen.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('http.fetch', async (_$, e) => {
    seen.fetches.push({
      url: e.url,
      headers: (e.init?.headers ?? {}) as Record<string, string>,
      body: String(e.init?.body ?? ''),
    })
    return { value: await (opts.reply ?? (async () => ok(answer('opus', 0.9, 3.9))))() }
  })
  if (opts.register) {
    on('agent.register', (_$, e) => {
      if (flags.registerFail && e.name.endsWith('-codex')) throw new Error('refused')
      return { value: { agent: `crew:${e.name}` } }
    })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('ui.status', () => ({ value: undefined }))
  }
  on('agent.list', async () => ({ value: opts.agents ?? [] }) as never)
  on('agent.spawn', async (_$, e) => {
    seen.spawned.push({ ...e })
    return opts.spawn ? opts.spawn({ ...e }) : { model: String(e.model ?? 'default'), agentId: 'a1' }
  })
  on('turn.step', async function* (_$, e) {
    seen.steps.push(e.effort)
    const model = typeof opts.stepModel === 'function' ? opts.stepModel() : opts.stepModel
    const usage = model ? { model } : null
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage } as never
  })
  // Flightdeck reads and writes the panel choice in the store; the jev tests have none to keep.
  on('store.get', async () => ({ value: undefined }))
  on('store.set', async () => ({ value: undefined }))
  on('ui.notice', async (_$, e) => { seen.notices.push(String(e.text)); return { value: undefined } })
  on('ui.log', async (_$, e) => {
    seen.logs.push(e.text)
    if (e.to === 'transcript') seen.transcript.push(e.text)
    return { value: undefined }
  })
  return { seen, clock, flags }
}

const spawnInput = (over: Record<string, unknown> = {}) => ({
  tool_use_id: 'tu1',
  prompt: 'Audit the auth token refresh flow for race conditions.',
  description: 'audit auth',
  subagentType: 'crew:developer',
  provider: { plugin: 'crew', tier: 'user' },
  parentModel: 'opus',
  background: false,
  fork: false,
  ...over,
}) as never

/** `effort: null` is a model without effort: the field is absent. */
const step = async ($: Engine, agentId?: string, effort: string | null = 'medium') => {
  const stream = $.turn.step({
    turnId: 't1', index: 0, model: 'sonnet', messageCount: 1,
    ...(effort === null ? {} : { effort }), ...(agentId ? { agentId } : {}),
  } as never)
  let item = await stream.next()
  while (!item.done) item = await stream.next()
  return item.value
}

const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
const pause = () => new Promise<void>(resolve => timers.setTimeout(resolve, 0))

test('jev sets the model of a crew call and leaves the type, with the key in the header only', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  const result = await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer', model: 'opus' })
  expect(result).toMatchObject({ model: 'opus' })
  expect(seen.fetches.length).toBe(1)
  expect(seen.fetches[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(seen.fetches[0]?.headers.Authorization).toBe(`Bearer ${KEY}`)
  const body = JSON.parse(seen.fetches[0]?.body ?? '{}')
  expect(body.model).toBe('jev-1.13.0')
  expect(body.state.agent).toEqual({ type: 'developer', description: 'audit auth' })
  expect(Object.keys(body.questions)).toEqual(['tier', 'reasoning_depth'])
  expect(seen.notices).toEqual(['crew:developer -> opus · high (jev)'])
  expect(seen.logs.some(line => line.includes('model=opus') && line.includes('jev=jev-1.13.0'))).toBe(true)
  expect(JSON.stringify([seen.notices, seen.logs])).not.toContain(KEY)
})

test('a filled jevKey turns routing on: a crew call is sent and its task shows the choice', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput())

  expect(seen.fetches.length).toBe(1)
  expect(seen.spawned[0]).toMatchObject({ model: 'opus', description: 'audit auth · opus/high' })
})

test('the task shows a kept choice too', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer('sonnet', 0.95, 1.4)) })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]?.description).toBe('audit auth · sonnet/medium')
})

test('a call Jev failed on keeps its description as it came', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok('not json') })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]?.description).toBe('audit auth')
})

// --- Confirmation of what ran ---

test('the first step after the spawn confirms the tag in the transcript and in the decision log', ON, async ($, on) => {
  const { seen } = jevWorld(on, { stepModel: 'claude-opus-5-5', reply: async () => ok(answer('opus', 0.9, 3.9)) })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium')
  await step($, 'a1', 'medium')

  expect(seen.transcript).toEqual(['jev: audit auth: confirmed claude-opus-5-5 · high'])
  expect(seen.writes.length).toBe(2)
  expect(seen.writes[1]?.path).toBe(seen.writes[0]?.path)
  expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  expect(JSON.parse(seen.writes[0]?.text ?? '{}').ran).toBeNull()
})

test('a run that differs from the tag says what ran instead', ON, async ($, on) => {
  const { seen } = jevWorld(on, { stepModel: 'claude-sonnet-5-5', reply: async () => ok(answer('opus', 0.9, 3.9)) })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium')

  expect(seen.transcript).toEqual(['jev: audit auth: ran claude-sonnet-5-5 · high, not opus/high'])
})

test('a step the API did not answer confirms nothing and leaves the check for the next', ON, async ($, on) => {
  let answered: string | undefined
  const { seen } = jevWorld(on, { stepModel: () => answered })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium')
  expect(seen.transcript).toEqual([])

  answered = 'claude-opus-5-5[1m]'
  await step($, 'a1', 'medium')
  expect(seen.transcript).toEqual(['jev: audit auth: confirmed claude-opus-5-5[1m] · high'])
  expect(JSON.parse(seen.writes.at(-1)?.text ?? '{}').ran).toEqual({ model: 'claude-opus-5-5[1m]', effort: 'high' })
})

test('a confirmation write that never settles does not hold the subagent\'s step past the wait', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { stepModel: 'claude-opus-5-5', writeHang: true })
  const spawned = $.agent.spawn(spawnInput())
  while (seen.notices.length === 0) await pause()
  await clock.advance(1_000)
  await spawned

  const stepped = step($, 'a1', 'medium')
  while (seen.transcript.length === 0) await pause()
  await clock.advance(1_000)
  await stepped
  expect(seen.logs.filter(line => line === 'crew jev: decision write slow').length).toBe(2)
})

test('a call Jev failed on and a refused spawn confirm nothing', ON, async ($, on) => {
  let refuse = false
  const { seen } = jevWorld(on, {
    stepModel: 'claude-opus-5-5',
    reply: async () => (refuse ? ok(answer('opus', 0.9, 3.9)) : ok('not json')),
    spawn: async e => (refuse ? ({ deny: 'no' } as never) : { model: String(e.model ?? 'default'), agentId: 'a1' }),
  })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium')
  refuse = true
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
  await step($, 'a1', 'medium')

  expect(seen.transcript).toEqual([])
})

test('steps of other agents and of the main loop confirm nothing', ON, async ($, on) => {
  const { seen } = jevWorld(on, { stepModel: 'claude-opus-5-5' })
  await $.agent.spawn(spawnInput())
  await step($, undefined, 'high')
  await step($, 'other', 'medium')

  expect(seen.transcript).toEqual([])
  expect(seen.writes.length).toBe(1)
})

// --- The lead's section ---

const compose = ($: Engine, tools: string[], traits: string[] = []) =>
  $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools, outputStyle: null, traits } as never)

test('a request that offers the Agent tool gets the lead section last, naming every specialist', ON, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const composed = await compose($, ['Agent', 'Read'])

  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'crew:lead'])
  const lead = composed.sections.at(-1)
  expect(lead?.scope).toBe('session')
  for (const name of ['code-reader', 'research', 'designer', 'developer', 'tester', 'architect']) {
    expect(lead?.text).toContain(`crew:${name}`)
  }
  expect(lead?.text).toContain('Jev sizes')
  expect(lead?.text).toContain('Git and pull requests stay with you')
})

test('a request without the Agent tool (a crew agent) gets no lead section', ON, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const composed = await compose($, ['Read', 'Edit'])

  expect(composed.sections.map(section => section.id)).toEqual(['intro'])
})

test('a teammate and a bare prompt get no lead section', ON, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))

  expect((await compose($, ['Agent'], ['teammate'])).sections.map(section => section.id)).toEqual(['intro'])
  expect((await compose($, ['Agent'], ['bare'])).sections.map(section => section.id)).toEqual(['intro'])
})

test('the lead section reads the same on every request, so the prompt cache holds', ON, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const first = (await compose($, ['Agent'])).sections.at(-1)?.text
  const second = (await compose($, ['Agent'])).sections.at(-1)?.text

  expect(second).toBe(first)
})

test('without a jevKey the lead section does not promise Jev, even with a key in the environment', OFF, async ($, on) => {
  const { seen } = jevWorld(on, { env: { TYPESAFE_API_KEY: KEY, JEV_API_KEY: KEY } })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const text = (await compose($, ['Agent'])).sections.at(-1)?.text ?? ''

  expect(text).toContain('You orchestrate')
  expect(text).not.toContain('Jev')
  expect(seen.fetches).toEqual([])
})

test('a description that already carries a tag is sent without it and tagged once', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput({ description: 'audit auth · sonnet/low' }))

  expect(JSON.parse(seen.fetches[0]?.body ?? '{}').state.agent.description).toBe('audit auth')
  expect(seen.spawned[0]?.description).toBe('audit auth · opus/high')
})

test('the decision log hashes the description as the call gave it, not the tagged one', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput())

  expect(JSON.parse(seen.writes[0]?.text ?? '{}').descriptionHash).toBe(fnv1a('audit auth'))
})

test('an agent the list shows without the tag does not take the routed effort', ON, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const { seen } = jevWorld(on, {
    reply: async () => ok(answer('sonnet', 0.95, 3.9)),
    agents: [{ id: 'a9', type: 'crew:developer', description: 'audit auth' }],
    spawn: async () => { await held; return { model: 'default', agentId: 'a1' } },
  })
  const spawned = $.agent.spawn(spawnInput())
  while (seen.spawned.length === 0) await pause()
  await step($, 'a9', 'medium')
  release()
  await spawned

  expect(seen.steps).toEqual(['medium'])
})

test('a decision that matches the defaults rewrites nothing', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer('sonnet', 0.95, 1.4)) })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.notices).toEqual(['crew:developer -> sonnet · medium (jev)'])
})

test('a call that names a model, a fork, a workflow agent and non-crew types are untouched and never sent', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer('sonnet', 0.95, 0.4)) })
  await $.agent.spawn(spawnInput({ model: 'haiku' }))
  await $.agent.spawn(spawnInput({ fork: true }))
  await $.agent.spawn(spawnInput({ workflow: { runId: 'wf_1', agentIndex: 1 } }))
  for (const subagentType of ['general-purpose', 'Explore', 'other:developer', 'crew:unknown']) {
    await $.agent.spawn(spawnInput({ subagentType }))
  }

  expect(seen.fetches).toEqual([])
  expect(seen.notices).toEqual([])
  expect(seen.spawned.map(s => s.model)).toEqual(['haiku', undefined, undefined, undefined, undefined, undefined, undefined])
  expect(seen.spawned.map(s => s.subagentType)).toEqual(['crew:developer', 'crew:developer', 'crew:developer', 'general-purpose', 'Explore', 'other:developer', 'crew:unknown'])
  // No effort either: the workflow agent's steps run on what they came with.
  await step($, 'a1', 'medium')
  expect(seen.steps).toEqual(['medium'])
})

test('without a jevKey nothing is sent and no settings are read, even with a key in the environment or in the key file', OFF, async ($, on) => {
  const { seen } = jevWorld(on, { env: { TYPESAFE_API_KEY: KEY, JEV_API_KEY: KEY }, files: { [`${HOME}/.jev-router.env`]: `JEV_API_KEY=${KEY}\n` } })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium')

  expect(seen.fetches).toEqual([])
  expect(seen.settingsReads).toBe(0)
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.logs.filter(line => line.includes('routing is off'))).toEqual([])
})

test('an empty or blank jevKey is off silently', { options: { jevKey: '   ' } }, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput())

  expect(seen.fetches).toEqual([])
  expect(seen.logs.filter(line => line.includes('routing is off'))).toEqual([])
})

test('a malformed jevKey is off with one debug line that never shows it', { options: { jevKey: 'two words' } }, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput())
  await $.agent.spawn(spawnInput())

  expect(seen.fetches).toEqual([])
  expect(seen.spawned.map(s => s.model)).toEqual([undefined, undefined])
  expect(seen.logs.filter(line => line.includes('routing is off'))).toEqual(['crew jev: routing is off: the jevKey option is not a valid key'])
  expect(JSON.stringify([seen.logs, seen.notices])).not.toContain('two words')
})

test('the jevKey option is the only source of the key', ON, async ($, on) => {
  const { seen } = jevWorld(on, { env: { TYPESAFE_API_KEY: 'other-key-from-env', JEV_API_KEY: 'another-key-from-env' } })
  await $.agent.spawn(spawnInput())

  expect(seen.fetches[0]?.headers.Authorization).toBe(`Bearer ${KEY}`)
  expect(seen.spawned[0]?.model).toBe('opus')
})

test('a stale jevRouting in the options is ignored: the key alone decides', { options: { jevKey: KEY, jevRouting: false } }, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput())

  expect(seen.fetches[0]?.headers.Authorization).toBe(`Bearer ${KEY}`)
})

test('settings that cannot be read turn routing off completely, and the log says why', ON, async ($, on) => {
  const { seen } = jevWorld(on, { settingsFail: true })
  await $.agent.spawn(spawnInput())

  expect(seen.fetches).toEqual([])
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.logs.some(line => line.includes('routing is off') && line.includes('cannot be read'))).toBe(true)
  expect(JSON.stringify(seen.logs)).not.toContain(KEY)
})

test('a HOME that the repository settings declare keeps routing on but leaves the decision log unwritten', ON, async ($, on) => {
  const { seen } = jevWorld(on, { project: { env: { HOME } } })
  await $.agent.spawn(spawnInput())

  expect(seen.fetches).toHaveLength(1)
  expect(seen.writes).toEqual([])
})

test('a HOME that the repository declares is not used by redaction either', ON, async ($, on) => {
  const { seen } = jevWorld(on, { project: { env: { HOME: '.' } } })
  await $.agent.spawn(spawnInput({ prompt: `Check /Users/maria/work/secret-app/src/a.ts and ${HOME}/work/x.ts` }))

  // The user's key is the option, so the call is sent; the home it would trust is not the repository's.
  const body = seen.fetches[0]?.body ?? ''
  expect(body).not.toContain('/Users/maria')
  expect(body).not.toContain(`${HOME}/work`)
})

test('without a trusted home the username still goes: it is taken from the session directory', ON, async ($, on) => {
  const { seen } = jevWorld(on, { cwd: '/Users/maria/work/app', project: { env: { HOME: '/srv/elsewhere' } } })
  const prompt = 'See -Users-maria-work-app-x and the prompt "maria@Mac % ls", Author: maria, /Users/maria/notes/todo.md'
  await $.agent.spawn(spawnInput({ prompt, description: 'check maria prompt' }))

  const body = seen.fetches[0]?.body ?? ''
  expect(body).toContain('state')
  expect(body).not.toContain('maria')
  // The repository's own HOME is not the stand-in.
  expect(body).not.toContain('/srv/elsewhere')
})

test('a settings read that fails after the key was cached does not cost the redaction its home', ON, async ($, on) => {
  const { seen, flags } = jevWorld(on)
  await $.agent.spawn(spawnInput())
  flags.settingsFail = true
  await $.agent.spawn(spawnInput({ prompt: `Open ${HOME}/work/a.ts, owner u, -home-u-work-x`, description: 'second' }))

  expect(seen.fetches.length).toBe(2)
  const body = seen.fetches[1]?.body ?? ''
  expect(body).not.toContain(`${HOME}/work`)
  expect(body).not.toContain('-home-u-work')
  // Not re-read per spawn: one resolution served both calls.
  expect(seen.logs.filter(line => line.includes('routing is off'))).toEqual([])
})

test('two calls alike, one routed and one that Jev failed on, are told apart by the tag', ON, async ($, on) => {
  let held = true
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let fetched = 0
  let spawned = 0
  const { seen } = jevWorld(on, {
    reply: async () => (fetched++ === 0 ? ok(answer('sonnet', 0.95, 3.9)) : { status: 400, ok: false, headers: {}, text: '{}' }),
    agents: [
      // The host lists each with the description it was spawned with: the routed one carries the tag.
      { id: 'a1', type: 'crew:developer', description: 'fix tests · sonnet/high' },
      { id: 'a2', type: 'crew:developer', description: 'fix tests' },
    ],
    spawn: async () => {
      const agentId = `a${++spawned}`
      while (held) await gate
      return { model: 'default', agentId }
    },
  })

  const both = [
    $.agent.spawn(spawnInput({ description: 'fix tests', tool_use_id: 'tu1' })),
    $.agent.spawn(spawnInput({ description: 'fix tests', tool_use_id: 'tu2' })),
  ]
  while (seen.spawned.length < 2) await pause()
  // Both subagents step before either spawn resolves.
  await step($, 'a1', 'medium')
  await step($, 'a2', 'medium')
  held = false
  release()
  await Promise.all(both)
  await step($, 'a1', 'medium')
  await step($, 'a2', 'medium')

  // The routed one runs on its effort from its first step; the other keeps what the host sends.
  expect(seen.steps).toEqual(['high', 'medium', 'high', 'medium'])
  expect(seen.notices.some(text => text.includes('not applied'))).toBe(false)
})

test('a jevKey that the repository declares is ignored, and the log says why', ON, async ($, on) => {
  const repo = jevWorld(on, {
    project: { pluginConfigs: { 'crew@spider-claude-mods': { options: { jevKey: KEY } } } },
  })
  await $.agent.spawn(spawnInput())

  expect(repo.seen.fetches).toEqual([])
  expect(repo.seen.logs.some(line => line.includes('routing is off') && line.includes('jevKey'))).toBe(true)
})

const declared = (plugin: string) => ({ pluginConfigs: { [plugin]: { options: { jevKey: 'repo-key-123' } } } })

for (const [source, plugin] of [
  ['project', 'crew@inline'], ['project', 'crew@spider-claude-mods'],
  ['local', 'crew@inline'], ['local', 'crew@spider-claude-mods'],
] as const) {
  test(`a jevKey declared by ${source} settings for ${plugin} turns routing off: no fetch, no tag, no Jev wording`, ON, async ($, on) => {
    const { seen } = jevWorld(on, { [source]: declared(plugin) })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
    const result = await $.agent.spawn(spawnInput())
    const lead = (await compose($, ['Agent'])).sections.at(-1)?.text ?? ''

    expect(seen.fetches).toEqual([])
    expect(seen.spawned[0]?.model).toBeUndefined()
    expect(String(seen.spawned[0]?.description)).toBe('audit auth')
    expect(JSON.stringify(result)).not.toContain('sonnet/')
    expect(seen.logs.some(line => line.includes('routing is off') && line.includes('jevKey'))).toBe(true)
    expect(JSON.stringify([seen.logs, seen.notices])).not.toContain(KEY)
    expect(lead).not.toContain('Jev')
  })
}

test('unreadable settings with a valid key: no fetch, no tag, no Jev wording', ON, async ($, on) => {
  const { seen } = jevWorld(on, { settingsFail: true })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  await $.agent.spawn(spawnInput())
  const lead = (await compose($, ['Agent'])).sections.at(-1)?.text ?? ''

  expect(seen.fetches).toEqual([])
  expect(String(seen.spawned[0]?.description)).toBe('audit auth')
  expect(lead).not.toContain('Jev')
})

test('a stale jevRouting: true in the options is ignored: the key alone decides', { options: { jevKey: KEY, jevRouting: true } }, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput())

  expect(seen.fetches[0]?.headers.Authorization).toBe(`Bearer ${KEY}`)
})

for (const [label, bad] of [
  ['a newline', `${KEY}\nextra`],
  ['a tab', `${KEY}\textra`],
  ['over 512 characters', 'k'.repeat(513)],
] as const) {
  test(`a jevKey with ${label} sends nothing and never reaches a log or notice`, { options: { jevKey: bad } }, async ($, on) => {
    const { seen } = jevWorld(on)
    await $.agent.spawn(spawnInput())

    expect(seen.fetches).toEqual([])
    expect(seen.spawned[0]?.model).toBeUndefined()
    expect(seen.logs.filter(line => line.includes('routing is off'))).toEqual(['crew jev: routing is off: the jevKey option is not a valid key'])
    const out = JSON.stringify([seen.logs, seen.transcript, seen.notices])
    expect(out).not.toContain(bad.slice(0, 20))
    expect(out).not.toContain(KEY)
  })
}

test('a blank jevKey leaves the lead section without Jev', { options: { jevKey: '   ' } }, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const text = (await compose($, ['Agent'])).sections.at(-1)?.text ?? ''

  expect(text).toContain('You orchestrate')
  expect(text).not.toContain('Jev')
})

test('an error status, a malformed body and a thrown fetch leave the call untouched', ON, async ($, on) => {
  const replies: (() => Promise<Reply>)[] = [
    async () => ({ status: 401, ok: false, headers: {}, text: `denied for ${KEY}` }),
    async () => ok('<html>'),
    async () => { throw new Error(`connection reset, Bearer ${KEY}`) },
  ]
  let next = 0
  const { seen, clock } = jevWorld(on, { reply: () => replies[next++ % replies.length]!() })

  await $.agent.spawn(spawnInput())
  await $.agent.spawn(spawnInput())
  // A dropped connection is retried once after a short pause, inside the deadline.
  const dropped = $.agent.spawn(spawnInput())
  while (next < 3) await pause()
  await clock.advance(300)
  await dropped

  expect(seen.spawned.map(s => s.model)).toEqual([undefined, undefined, undefined])
  expect(seen.notices).toEqual([])
  expect(JSON.stringify(seen.logs)).not.toContain(KEY)
})

test('a Jev that does not answer in time leaves the call untouched', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { reply: () => new Promise<Reply>(() => {}) })
  const spawned = $.agent.spawn(spawnInput())
  await clock.settle()
  await pause()
  await clock.advance(3_000)
  await spawned

  expect(seen.fetches.length).toBe(1)
  expect(seen.spawned[0]?.model).toBeUndefined()
})

test('the prompt reaches Jev redacted and cut: no token, no home path', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  const prompt = [
    `Fix ${HOME}/work/secret-app/src/a.ts with the token ${TOKEN}`,
    `Authorization: Bearer ${TOKEN}`,
    `${ROOT}/src/b.ts`,
    'x'.repeat(10_000),
  ].join('\n')
  await $.agent.spawn(spawnInput({ prompt, description: `use ${TOKEN}` }))

  const body = seen.fetches[0]?.body ?? ''
  expect(body).not.toContain(TOKEN)
  expect(body).not.toContain(KEY)
  expect(body).not.toContain(`${HOME}/work`)
  expect(body).toContain('src/b.ts')
  const sent = JSON.parse(body).state.task.prompt as string
  expect(sent.length).toBeLessThanOrEqual(4001)
})

test('at most four Jev calls run at once; the fifth spawn goes through unchanged', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { reply: () => new Promise<Reply>(() => {}) })
  const first = Array.from({ length: 4 }, () => $.agent.spawn(spawnInput()))
  await clock.settle()
  await pause()
  expect(seen.fetches.length).toBe(4)

  const fifth = await $.agent.spawn(spawnInput())
  expect(seen.fetches.length).toBe(4)
  expect(fifth).toMatchObject({ model: 'default' })

  await clock.advance(3_000)
  await Promise.all(first)
  expect(seen.spawned.length).toBe(5)
})

test('the effort follows the spawn id on the subagent\'s steps, only when it differs from the default', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer('sonnet', 0.95, 3.9)) })
  await $.agent.spawn(spawnInput())

  await step($, 'a1', 'medium')
  await step($, 'other', 'medium')
  await step($, undefined, 'medium')
  await step($, 'a1', null)

  expect(seen.steps).toEqual(['high', 'medium', 'medium', undefined])
})

test('a step that arrives before the spawn resolves still gets the effort', ON, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const { seen } = jevWorld(on, {
    reply: async () => ok(answer('sonnet', 0.95, 3.9)),
    agents: [{ id: 'a1', type: 'crew:developer', description: 'audit auth · sonnet/high' }],
    spawn: async () => { await held; return { model: 'default', agentId: 'a1' } },
  })

  const spawned = $.agent.spawn(spawnInput())
  while (seen.spawned.length === 0) await pause()
  // The subagent started and stepped; the spawn call has not resolved yet.
  await step($, 'a1', 'medium')
  release()
  await spawned
  await step($, 'a1', 'medium')

  expect(seen.steps).toEqual(['high', 'high'])
})

test('an effort that was not known at the first step is not applied later: the agent keeps the default for its run', ON, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  // The agent is not listed yet when it steps first.
  const { seen } = jevWorld(on, {
    reply: async () => ok(answer('sonnet', 0.95, 3.9)),
    spawn: async () => { await held; return { model: 'default', agentId: 'a1' } },
  })

  const spawned = $.agent.spawn(spawnInput())
  while (seen.spawned.length === 0) await pause()
  await step($, 'a1', 'medium')
  release()
  await spawned
  await step($, 'a1', 'medium')
  await step($, 'a1', 'medium')

  expect(seen.steps).toEqual(['medium', 'medium', 'medium'])
  // The notice and the debug line say what runs, not what Jev asked for.
  expect(seen.notices).toEqual(['crew:developer -> sonnet · medium (jev; effort high not applied)'])
  expect(seen.logs.some(line => line.includes('effort=medium (default)'))).toBe(true)
  expect(seen.logs.some(line => line.includes('effort high not applied (stepped)'))).toBe(true)
})

test('a spawn that the host refuses reaches the caller and leaves no effort behind', ON, async ($, on) => {
  const { seen } = jevWorld(on, {
    reply: async () => ok(answer('sonnet', 0.95, 3.9)),
    spawn: async () => ({ deny: 'spawn refused' }) as never,
    agents: [{ id: 'a1', type: 'crew:developer', description: 'audit auth' }],
  })

  expect(await $.agent.spawn(spawnInput())).toEqual({ deny: 'spawn refused' })
  await step($, 'a1', 'medium')

  expect(seen.fetches.length).toBe(1)
  expect(seen.steps).toEqual(['medium'])
  // Nothing started, so nothing is announced.
  expect(seen.notices).toEqual([])
})

test('a Jev failure leaves the effort of the step as the host sent it, whatever the default is', ON, async ($, on) => {
  const { seen } = jevWorld(on, {
    // A 400 is not retried, so no timer is waited on.
    reply: async () => ({ status: 400, ok: false, headers: {}, text: '{}' }),
    agents: [{ id: 'a1', type: 'crew:developer', description: 'audit auth' }],
  })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high')
  await step($, 'a1', 'xhigh')

  expect(seen.steps).toEqual(['high', 'xhigh'])
  expect(seen.notices).toEqual([])
})

test('the main loop and an agent that was not routed step untouched, and routing off leaves steps alone', OFF, async ($, on) => {
  const { seen } = jevWorld(on, { agents: [{ id: 'a1', type: 'crew:developer', description: 'audit auth' }] })
  await step($, 'a1', 'medium')
  await step($, undefined, 'high')

  expect(seen.steps).toEqual(['medium', 'high'])
})

// --- Decision log ---

const DIR = `${HOME}/.claude/crew/decisions`
const record = (seen: Seen, i = 0) => JSON.parse(seen.writes[i]?.text ?? '{}') as Record<string, unknown>

test('an applied decision is logged once, in a file named by time and agent id', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer('opus', 0.9, 3.9)) })
  await $.agent.spawn(spawnInput())

  expect(seen.writes).toHaveLength(1)
  const path = seen.writes[0]?.path ?? ''
  expect(path.startsWith(`${DIR}/`)).toBe(true)
  expect(path).toMatch(/\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-a1\.json$/)
  expect(record(seen)).toMatchObject({
    v: 1, agent: 'developer', tier: 'opus', confidence: 0.9, depth: 3.9,
    defaultModel: 'sonnet', model: 'opus', defaultEffort: 'medium', effortPlanned: 'high', effortApplied: 'high',
    jevModel: 'jev-1.13.0', applied: { model: true, effort: true }, outcome: null,
  })
  expect(record(seen).descriptionHash).toMatch(/^[0-9a-f]{8}$/)
  expect(typeof record(seen).durationMs).toBe('number')
})

test('a kept decision is logged too, with nothing applied', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer('sonnet', 0.95, 1.4)) })
  await $.agent.spawn(spawnInput())

  expect(record(seen)).toMatchObject({
    tier: 'sonnet', model: 'sonnet', effortPlanned: 'medium', effortApplied: 'medium', applied: { model: false, effort: false },
  })
})

test('an effort that lost the race to the first step is logged as not applied', ON, async ($, on) => {
  const { seen } = jevWorld(on, {
    reply: async () => ok(answer('sonnet', 0.95, 3.9)),
    spawn: async e => {
      // The subagent steps before the spawn resolves, so the planned effort cannot take.
      await step($, 'a1', 'medium')
      return { model: String(e.model ?? 'default'), agentId: 'a1' }
    },
  })
  await $.agent.spawn(spawnInput())

  expect(record(seen)).toMatchObject({ effortPlanned: 'high', effortApplied: 'medium', applied: { effort: false } })
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
    'agent', 'applied', 'bind', 'confidence', 'defaultEffort', 'defaultModel', 'depth', 'descriptionHash', 'durationMs',
    'effortApplied', 'effortPlanned', 'jevModel', 'model', 'outcome', 'ran', 'tier', 'ts', 'v',
  ])
})

test('nothing is written without a trusted home', ON, async ($, on) => {
  const { seen } = jevWorld(on, { env: { HOME: 'relative/home' } })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]?.model).toBe('opus')
  expect(seen.writes).toEqual([])
  expect(seen.logs.some(line => line.includes('decision not logged (no trusted home)'))).toBe(true)
})

test('a write error is logged and does not change the spawn', ON, async ($, on) => {
  const { seen } = jevWorld(on, { writeFail: true })
  const result = await $.agent.spawn(spawnInput())

  expect(result).toMatchObject({ model: 'opus', agentId: 'a1' })
  expect(seen.notices).toEqual(['crew:developer -> opus · high (jev)'])
  expect(seen.logs.some(line => line.includes('decision not logged (write failed)'))).toBe(true)
})

test('calls that are not routed write nothing', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer('sonnet', 0.95, 0.4)) })
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

  expect(result).toMatchObject({ model: 'opus', agentId: 'a1' })
  expect(seen.notices).toEqual(['crew:developer -> opus · high (jev)'])
  expect(seen.logs.filter(line => line.includes('decision write slow'))).toHaveLength(1)
})

test('a write that settles first leaves no slow line and no timer behind', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on)
  await $.agent.spawn(spawnInput())
  await clock.advance(5_000)

  expect(seen.writes).toHaveLength(1)
  expect(seen.logs.some(line => line.includes('decision write slow'))).toBe(false)
})

// --- The entry module's observable order and log lines, pinned ---

/** Wraps `on` so the host calls that matter are recorded in the order they reach the host. */
function traced(on: On, timeline: string[]): On {
  const mark: Record<string, (e: Record<string, unknown>) => string> = {
    'http.fetch': () => 'fetch',
    'agent.spawn': () => 'spawn',
    'fs.write': () => 'write',
    'ui.notice': e => `notice ${String(e.text)}`,
    'ui.log': e => `log ${String(e.text)}`,
  }
  const record = (event: string, hook: (host: unknown, e: Record<string, unknown>) => unknown) =>
    (host: unknown, e: Record<string, unknown>) => {
      timeline.push(mark[event]?.(e) ?? event)
      return hook(host, e)
    }
  return ((event: string, ...rest: unknown[]) => {
    const hook = rest[rest.length - 1]
    if (event in mark && typeof hook === 'function') {
      rest[rest.length - 1] = record(event, hook as (host: unknown, e: Record<string, unknown>) => unknown)
    }
    return (on as unknown as (...args: unknown[]) => unknown)(event, ...rest)
  }) as unknown as On
}

/** The timeline with the measured duration of a debug line made constant. */
const shape = (timeline: string[]) => timeline.map(entry => entry.replace(/ \d+ms$/, ' Nms'))

const rejected = (status: number): Reply => ({ status, ok: false, headers: {}, text: `HTTP ${status}` })
const notRouted = (seen: Seen) => seen.logs.filter(line => line.includes('not routed'))

// The debug line of a call that Jev failed on: the reason, and the status when the failure has one. Nothing else of
// the failure (message, body, key) reaches it, and the call goes on as it came.

test('an error status is logged as its reason and status, and the call goes on untouched', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => rejected(401) })
  const result = await $.agent.spawn(spawnInput())

  expect(notRouted(seen)).toEqual(['crew jev: crew:developer not routed (http 401)'])
  expect(seen.fetches).toHaveLength(1)
  expect(result).toMatchObject({ model: 'default', agentId: 'a1' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.notices).toEqual([])
  expect(seen.writes).toEqual([])
})

test('a status that is retried is logged after its one retry, with the status of the last attempt', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { reply: async () => rejected(503) })
  const spawned = $.agent.spawn(spawnInput())
  while (seen.fetches.length === 0) await pause()
  await clock.advance(300)
  await spawned

  expect(seen.fetches).toHaveLength(2)
  expect(notRouted(seen)).toEqual(['crew jev: crew:developer not routed (http 503)'])
})

test('a malformed body is logged by its reason alone, with no status', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok('<html>') })
  await $.agent.spawn(spawnInput())

  expect(notRouted(seen)).toEqual(['crew jev: crew:developer not routed (malformed)'])
  expect(seen.fetches).toHaveLength(1)
})

test('a deadline that passes is logged as timeout, with no status', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { reply: () => new Promise<Reply>(() => {}) })
  const spawned = $.agent.spawn(spawnInput())
  await clock.settle()
  await pause()
  await clock.advance(3_000)
  await spawned

  expect(notRouted(seen)).toEqual(['crew jev: crew:developer not routed (timeout)'])
})

test('a connection that keeps dropping is logged as network, with no status, after its one retry', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { reply: async () => { throw new Error(`connection reset, Bearer ${KEY}`) } })
  const spawned = $.agent.spawn(spawnInput())
  while (seen.fetches.length === 0) await pause()
  await clock.advance(300)
  await spawned

  expect(seen.fetches).toHaveLength(2)
  expect(notRouted(seen)).toEqual(['crew jev: crew:developer not routed (network)'])
  expect(JSON.stringify(seen.logs)).not.toContain(KEY)
})

test('a fifth concurrent call is logged as busy at once, and the four in flight as timeout later', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { reply: () => new Promise<Reply>(() => {}) })
  const first = Array.from({ length: 4 }, () => $.agent.spawn(spawnInput()))
  await clock.settle()
  await pause()
  await $.agent.spawn(spawnInput())

  expect(notRouted(seen)).toEqual(['crew jev: crew:developer not routed (busy)'])
  expect(seen.fetches).toHaveLength(4)

  await clock.advance(3_000)
  await Promise.all(first)
  expect(notRouted(seen)).toEqual([
    'crew jev: crew:developer not routed (busy)',
    ...Array.from({ length: 4 }, () => 'crew jev: crew:developer not routed (timeout)'),
  ])
})

test('once three calls failed, the fourth is logged as breaker and sends no request', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => rejected(401) })
  for (let i = 0; i < 4; i++) await $.agent.spawn(spawnInput())

  expect(seen.fetches).toHaveLength(3)
  expect(notRouted(seen)).toEqual([
    ...Array.from({ length: 3 }, () => 'crew jev: crew:developer not routed (http 401)'),
    'crew jev: crew:developer not routed (breaker)',
  ])
  expect(seen.spawned.map(s => s.model)).toEqual([undefined, undefined, undefined, undefined])
})

test('the failure line names the agent of the call', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => rejected(401) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:architect' }))

  expect(notRouted(seen)).toEqual(['crew jev: crew:architect not routed (http 401)'])
})

// The order inside the spawn: the effort book's entry before the spawn continues, then the record (with the book's
// answer) and its write, the debug lines and the notice, and last the wait for the write.

test('a routed spawn runs in order: request, spawn, decision write, debug line, notice', ON, async ($, on) => {
  const timeline: string[] = []
  const { seen } = jevWorld(traced(on, timeline), { reply: async () => ok(answer('opus', 0.9, 3.9)) })
  await $.agent.spawn(spawnInput())

  expect(shape(timeline)).toEqual([
    'fetch',
    'spawn',
    'write',
    'log crew jev: crew:developer tier=opus@0.90 depth=3.90 model=opus effort=high jev=jev-1.13.0 Nms',
    'notice crew:developer -> opus · high (jev)',
  ])
  expect(seen.notices).toEqual(['crew:developer -> opus · high (jev)'])
  // Nothing stepped, so the bind that the record carries is the plain one.
  expect(record(seen)).toMatchObject({ bind: 'applied', effortPlanned: 'high', effortApplied: 'high' })
})

test('the effort entry exists before the spawn continues, and its bind is in the record that is written after', ON, async ($, on) => {
  const timeline: string[] = []
  const { seen } = jevWorld(traced(on, timeline), {
    reply: async () => ok(answer('sonnet', 0.95, 3.9)),
    agents: [{ id: 'a1', type: 'crew:developer', description: 'audit auth · sonnet/high' }],
    spawn: async () => {
      // The subagent steps while the spawn is still in flight: only an entry added before it can answer.
      await step($, 'a1', 'medium')
      timeline.push(`step ${seen.steps.at(-1)}`)
      return { model: 'default', agentId: 'a1' }
    },
  })
  await $.agent.spawn(spawnInput())

  expect(shape(timeline)).toEqual([
    'fetch',
    'spawn',
    'step high',
    'write',
    'log crew jev: crew:developer tier=sonnet@0.95 depth=3.90 model=sonnet (default) effort=high jev=jev-1.13.0 Nms',
    'notice crew:developer -> sonnet · high (jev)',
  ])
  expect(record(seen)).toMatchObject({ bind: 'matched', effortPlanned: 'high', effortApplied: 'high' })
})

test('an effort that did not take is announced after the decision write, line by line, and the record says what runs', ON, async ($, on) => {
  const timeline: string[] = []
  const { seen } = jevWorld(traced(on, timeline), {
    reply: async () => ok(answer('sonnet', 0.95, 3.9)),
    spawn: async () => {
      // Not listed, so the first step runs on the default and the entry cannot take.
      await step($, 'a1', 'medium')
      timeline.push(`step ${seen.steps.at(-1)}`)
      return { model: 'default', agentId: 'a1' }
    },
  })
  await $.agent.spawn(spawnInput())

  expect(shape(timeline)).toEqual([
    'fetch',
    'spawn',
    'step medium',
    'write',
    'log crew jev: crew:developer tier=sonnet@0.95 depth=3.90 model=sonnet (default) effort=medium (default) jev=jev-1.13.0 Nms',
    'log crew jev: crew:developer effort high not applied (stepped); it runs on medium',
    'notice crew:developer -> sonnet · medium (jev; effort high not applied)',
  ])
  expect(record(seen)).toMatchObject({ bind: 'stepped', effortPlanned: 'high', effortApplied: 'medium' })
})

test('the result waits for the decision write for one second after the notice, and not longer', ON, async ($, on) => {
  const timeline: string[] = []
  const { clock } = jevWorld(traced(on, timeline), { writeHang: true })
  let resolved = false
  const spawned = $.agent.spawn(spawnInput()).then(result => { resolved = true; return result })
  await clock.settle()
  await pause()

  // The notice is out and the spawn is still held on the write.
  expect(shape(timeline)).toEqual([
    'fetch',
    'spawn',
    'write',
    'log crew jev: crew:developer tier=opus@0.90 depth=3.90 model=opus effort=high jev=jev-1.13.0 Nms',
    'notice crew:developer -> opus · high (jev)',
  ])
  expect(resolved).toBe(false)
  await clock.advance(999)
  expect(resolved).toBe(false)

  await clock.advance(1)
  expect(await spawned).toMatchObject({ model: 'opus', agentId: 'a1' })
  expect(timeline.at(-1)).toBe('log crew jev: decision write slow')
})

test('a call that Jev failed on logs before the spawn and announces and writes nothing', ON, async ($, on) => {
  const timeline: string[] = []
  const { seen } = jevWorld(traced(on, timeline), { reply: async () => rejected(401) })
  await $.agent.spawn(spawnInput())

  expect(timeline).toEqual(['fetch', 'log crew jev: crew:developer not routed (http 401)', 'spawn'])
  expect(seen.writes).toEqual([])
})

test('a refused spawn that was routed logs, announces and writes nothing', ON, async ($, on) => {
  const timeline: string[] = []
  const { seen } = jevWorld(traced(on, timeline), {
    reply: async () => ok(answer('opus', 0.9, 3.9)),
    spawn: async () => ({ deny: 'spawn refused' }) as never,
  })
  await $.agent.spawn(spawnInput())

  expect(timeline).toEqual(['fetch', 'spawn'])
  expect(seen.writes).toEqual([])
})

// The write guard through the host, for both tools: a subagent is held by its type's rule, the main loop never.

for (const tool of ['Write', 'Edit'] as const) {
  const reads = { count: 0 }
  const guardHost = (on: On) => {
    reads.count = 0
    on('agent.list', () => (reads.count++, { value: agents }) as never)
    on('tool.call', () => ({ result: 'written' }))
  }
  const call = ($: Engine, agentId: string | undefined, file_path?: string) =>
    $.tool.call({ tool, ...(agentId ? { agentId } : {}), ...(file_path === undefined ? {} : { file_path }) } as never)

  test(`${tool}: the architect is held to Markdown under .crew, with the reason and the path`, async ($, on) => {
    guardHost(on)

    expect(await call($, 'a1', 'src/app.ts')).toEqual({
      deny: 'the architect writes plan and review documents under .crew/ (.md) only, not src/app.ts; hand the finding to the developer',
    })
    expect(await call($, 'a1', '.crew/plans/plan.md')).toEqual({ result: 'written' })
    expect(await call($, 'a1', '.crew/app.ts')).toHaveProperty('deny')
    // A call without a path is read as an empty path.
    expect(await call($, 'a1')).toEqual({
      deny: 'the architect writes plan and review documents under .crew/ (.md) only, not ; hand the finding to the developer',
    })
  })

  test(`${tool}: the tester is held to test files and reviews, with the reason and the path`, async ($, on) => {
    guardHost(on)

    expect(await call($, 't1', 'src/app.ts')).toEqual({
      deny: 'the tester writes test files and reports under .crew/reviews/ (.md) only, not src/app.ts; hand the failure back with the evidence',
    })
    expect(await call($, 't1', 'tests/app.test.ts')).toEqual({ result: 'written' })
    expect(await call($, 't1', '.crew/reviews/check.md')).toEqual({ result: 'written' })
    expect(await call($, 't1', '.crew/reviews/../plans/a.md')).toEqual({
      deny: 'the tester writes test files and reports under .crew/reviews/ (.md) only, not .crew/reviews/../plans/a.md; hand the failure back with the evidence; a `..` segment is refused',
    })
  })

  test(`${tool}: other agents, ids the list does not name and the main loop pass; the main loop never reads the list`, async ($, on) => {
    guardHost(on)

    expect(await call($, 'd1', 'src/app.ts')).toEqual({ result: 'written' })
    expect(await call($, 'ghost', 'src/app.ts')).toEqual({ result: 'written' })
    expect(reads.count).toBe(2)

    expect(await call($, undefined, 'src/app.ts')).toEqual({ result: 'written' })
    expect(reads.count).toBe(2)
  })

  test(`${tool}: a subagent whose check fails is held with one reason, and the main loop is not`, async ($, on) => {
    on('agent.list', () => ({ deny: 'list unavailable' }) as never)
    on('tool.call', () => ({ result: 'written' }))

    expect(await call($, 'a1', 'src/app.ts')).toEqual({ deny: 'crew could not check this write, so it was not made' })
    expect(await call($, 'd1', '.crew/plans/plan.md')).toEqual({ deny: 'crew could not check this write, so it was not made' })
    expect(await call($, undefined, 'src/app.ts')).toEqual({ result: 'written' })
  })

  test(`${tool}: a failure below a passed write reaches the caller as it came, never as the guard's deny`, async ($, on) => {
    on('agent.list', () => ({ value: agents }) as never)
    on('tool.call', () => { throw new Error('disk full') })

    // The hook below failed, so the host has no answer for the call: the guard does not answer in its place.
    await expect(call($, 'd1', 'src/app.ts')).rejects.toThrow()
    await expect(call($, undefined, 'src/app.ts')).rejects.toThrow()
  })
}

test('the guard answers only Write and Edit: another tool of a subagent passes without reading the list', async ($, on) => {
  let reads = 0
  on('agent.list', () => (reads++, { value: agents }) as never)
  on('tool.call', () => ({ result: 'ran' }))

  expect(await $.tool.call({ tool: 'Bash', agentId: 'a1', command: 'ls' } as never)).toEqual({ result: 'ran' })
  expect(await $.tool.call({ tool: 'Read', agentId: 'a1', file_path: 'src/app.ts' } as never)).toEqual({ result: 'ran' })
  expect(reads).toBe(0)
})

// --- The vendored Flightdeck beside the crew's hooks, through the host ---
// The crew and Flightdeck share a plugin, so the engine skips the rest of a plugin's chain when one of its hooks fails.
// The order of registration (crew session.start, Flightdeck, then the crew's spawn, step and write hooks) and
// Flightdeck's never-throw rule are what these tests hold.

/** Records every write of the card list Flightdeck owns under the crew; the host's own state answers beneath. */
const watchCards = (on: On) => {
  const writes: { plugin: string; key: string; value: unknown }[] = []
  on('state.set', (_$, e, next) => {
    if (e.key === 'agents') writes.push({ plugin: e.plugin, key: e.key, value: e.value })
    return next(e)
  })
  return writes
}

test('one crew spawn is routed by Jev and drawn as a card titled with the original description', ON, async ($, on) => {
  const { seen } = jevWorld(on, { spawn: async e => ({ model: String(e.model ?? 'default'), agentId: 'ag1' }) })
  on('ui.status', () => ({ value: undefined }))
  const writes = watchCards(on)
  const result = await $.agent.spawn(spawnInput())

  expect(seen.fetches.length).toBe(1)
  expect(result).toMatchObject({ model: 'opus', agentId: 'ag1' })
  expect(seen.spawned[0]).toMatchObject({ model: 'opus', description: 'audit auth · opus/high' })
  expect(seen.notices).toEqual(['crew:developer -> opus · high (jev)'])

  // Flightdeck is outer on agent.spawn: it sees the description as the lead wrote it and the model that started.
  const cards = writes.at(-1)?.value as { id: string; type: string; model: string; description: string }[]
  expect(writes.every(w => w.plugin === 'crew')).toBe(true)
  expect(cards.length).toBe(1)
  expect(cards[0]).toMatchObject({ id: 'ag1', type: 'crew:developer', model: 'opus', description: 'audit auth' })
})

test('a Flightdeck session.start that fails (state.set of the usage) still registers the six specialists', async ($, on) => {
  const registered: string[] = []
  let attempts = 0
  on('session.usage', () => ({ value: { context: { percent: 1, tokens: 1, window: 100 }, cost: { usd: 1 }, rateLimits: [] } }) as never)
  on('state.set', (_$, e, next) => { if (e.key === 'usage') { attempts++; throw new Error('state unavailable') } return next(e) })
  on('agent.register', (_$, e) => (registered.push(e.name), { value: { agent: `crew:${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  // The failing call was reached inside Flightdeck's first try, so the agents above are not registered by luck of an earlier return.
  expect(attempts).toBe(1)
  expect(registered).toEqual(['code-reader', 'research', 'designer', 'developer', 'tester', 'architect'])
})

// Flightdeck's spawn and step hooks do their work after `next`, inside their own try/catch. A failure there must leave the
// crew's routing as it came: the routed result, the notice and the effort book (the crew's hooks sit inside Flightdeck).

test('a Flightdeck failure after next in agent.spawn (clock.now) leaves the routed result and the notice', ON, async ($, on) => {
  let reads = 0
  const { seen } = jevWorld(on, {
    spawn: async e => ({ model: String(e.model ?? 'default'), agentId: 'ag1' }),
    now: () => { reads++; throw new Error('clock unavailable') },
  })
  on('ui.status', () => ({ value: undefined }))
  const writes = watchCards(on)

  const result = await $.agent.spawn(spawnInput())

  // The failing call was reached, so the result below is not Flightdeck's work going unnoticed.
  expect(reads).toBeGreaterThan(0)
  expect(writes).toEqual([]) // the card was never drawn: Flightdeck failed before it wrote one
  expect(result).toMatchObject({ model: 'opus', agentId: 'ag1' })
  expect(seen.spawned[0]).toMatchObject({ model: 'opus', description: 'audit auth · opus/high' })
  expect(seen.notices).toEqual(['crew:developer -> opus · high (jev)'])
})

test('a Flightdeck failure in agent.spawn (card write) leaves the routed result, the notice and the effort of the first step', ON, async ($, on) => {
  const { seen } = jevWorld(on, { spawn: async e => ({ model: String(e.model ?? 'default'), agentId: 'ag1' }) })
  let failed = 0
  on('ui.status', () => ({ value: undefined }))
  on('state.set', (_$, e, next) => {
    if (e.key === 'agents') { failed++; throw new Error('state unavailable') }
    return next(e)
  })

  const result = await $.agent.spawn(spawnInput())

  expect(failed).toBeGreaterThan(0)
  expect(result).toMatchObject({ model: 'opus', agentId: 'ag1' })
  expect(seen.spawned[0]).toMatchObject({ model: 'opus', description: 'audit auth · opus/high' })
  expect(seen.notices).toEqual(['crew:developer -> opus · high (jev)'])
  // The effort book was bound by the crew's hook, inside the failing one: the step carries the routed effort.
  await step($, 'ag1', 'medium')
  expect(seen.steps).toEqual(['high'])
})

test('a Flightdeck failure after next in turn.step (clock.now) leaves the crew\'s effort on the step', ON, async ($, on) => {
  let reads = 0
  const { seen } = jevWorld(on, {
    spawn: async e => ({ model: String(e.model ?? 'default'), agentId: 'ag1' }),
    stepModel: 'claude-opus-5-5',
    now: () => { reads++; throw new Error('clock unavailable') },
  })
  on('ui.status', () => ({ value: undefined }))

  await $.agent.spawn(spawnInput())
  const spawnReads = reads
  // No card was drawn (the spawn's clock read failed), so the step takes Flightdeck's loop path, which reads the clock.
  const answer = await step($, 'ag1', 'medium')

  expect(reads).toBeGreaterThan(spawnReads) // Flightdeck's step ran its failing work after the crew's
  expect(seen.steps).toEqual(['high'])
  expect(answer).toMatchObject({ usage: { model: 'claude-opus-5-5' } })
  expect(seen.transcript).toEqual(['jev: audit auth: confirmed claude-opus-5-5 · high'])
})

test('a Flightdeck failure after next in turn.step (card write) leaves the crew\'s effort on the step', ON, async ($, on) => {
  const { seen } = jevWorld(on, { spawn: async e => ({ model: String(e.model ?? 'default'), agentId: 'ag1' }), stepModel: 'claude-opus-5-5' })
  on('ui.status', () => ({ value: undefined }))
  let armed = false
  let failed = 0
  on('state.set', (_$, e, next) => {
    if (armed && e.key === 'agents') { failed++; throw new Error('state unavailable') }
    return next(e)
  })

  await $.agent.spawn(spawnInput()) // the card is drawn: the step takes Flightdeck's card path
  armed = true
  const answer = await step($, 'ag1', 'medium')

  expect(failed).toBeGreaterThan(0)
  expect(seen.steps).toEqual(['high'])
  expect(answer).toMatchObject({ usage: { model: 'claude-opus-5-5' } })
  expect(seen.transcript).toEqual(['jev: audit auth: confirmed claude-opus-5-5 · high'])
})

// A subagent's step has no Flightdeck work before `next`; the main loop's has (its model and effort). The crew's
// rewrite only concerns subagents, so this holds that a failure before `next` does not stop the step reaching the host.
test('a Flightdeck failure before next in the main loop\'s turn.step does not stop the step', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  let failed = 0
  on('ui.status', () => ({ value: undefined }))
  on('state.set', () => { failed++; throw new Error('state unavailable') })

  await step($, undefined, 'medium')

  expect(failed).toBeGreaterThan(0)
  expect(seen.steps).toEqual(['medium'])
})

for (const tool of ['Write', 'Edit'] as const) {
  const failing = (on: On, list: 'agents' | 'unavailable', written: string[] = []) => {
    const clock = { calls: 0 }
    // Flightdeck reads the time after the call settled; the throw is its failure, not the guard's.
    on('clock.now', () => { clock.calls++; throw new Error('clock unavailable') })
    on('ui.status', () => ({ value: undefined }))
    on('agent.list', () => (list === 'agents' ? { value: agents } : { deny: 'list unavailable' }) as never)
    on('tool.call', (_$, e) => (written.push(String((e as { file_path?: unknown }).file_path)), { result: 'written' }))
    return clock
  }
  const call = ($: Engine, agentId: string | undefined, file_path: string) =>
    $.tool.call({ tool, tool_use_id: 'tc1', ...(agentId ? { agentId } : {}), file_path } as never)

  test(`${tool}: with Flightdeck's tool.call failing after the call, the guard's specific denial stands`, async ($, on) => {
    const clock = failing(on, 'agents')

    expect(await call($, 'a1', 'src/app.ts')).toEqual({
      deny: 'the architect writes plan and review documents under .crew/ (.md) only, not src/app.ts; hand the finding to the developer',
    })
    const afterDeny = clock.calls
    expect(afterDeny).toBeGreaterThan(0) // Flightdeck did run its failing step after the guard answered
    // A passed write whose Flightdeck step throws reaches the caller as it came, not as "could not check".
    expect(await call($, 'a1', '.crew/plans/plan.md')).toEqual({ result: 'written' })
    expect(clock.calls).toBeGreaterThan(afterDeny)
  })

  // The check fails inside the guard, so the engine skips the rest of the crew's chain for that call, Flightdeck's step
  // after `next` included (the clock is never read here): a Flightdeck failure cannot be composed with a failed check in
  // one call. What this holds is that, with Flightdeck registered outermost and no pass-through `.catch` on it, the
  // write is held and not made.
  test(`${tool}: with Flightdeck registered, a write that could not be checked is still held, not written`, async ($, on) => {
    const written: string[] = []
    failing(on, 'unavailable', written)

    expect(await call($, 'a1', 'src/app.ts')).toEqual({ deny: 'crew could not check this write, so it was not made' })
    expect(await call($, 'd1', '.crew/plans/plan.md')).toEqual({ deny: 'crew could not check this write, so it was not made' })
    expect(written).toEqual([])
    expect(await call($, undefined, 'src/app.ts')).toEqual({ result: 'written' })
    expect(written).toEqual(['src/app.ts'])
  })
}

// --- /crew:panel: side pane or prompt band, persisted ---

const OTHER_BAND = 'OTHER-BAND'

/** The host beneath the panel: a store in a Map, the pane `flightdeck` opening and closing, and a bottom band. */
function panelWorld(
  on: On,
  o: {
    /** What `$.store` holds at the start. */
    stored?: Record<string, unknown>
    /** The surface places the pane (`$.ui.open` answers `isPlaced`). */
    placed?: boolean
    /** The reason an unplaced open gives. */
    reason?: string
    /** What the band beneath the plugin draws: the engine's own (empty) band, or another plugin's tree. */
    below?: 'engine' | 'other'
    getFail?: boolean
    setFail?: boolean
    panesFail?: boolean
    closeFail?: boolean
  } = {},
) {
  const store = new Map<string, unknown>(Object.entries(o.stored ?? {}))
  const w = {
    store,
    opens: [] as string[],
    closes: [] as { id: string; origin: string }[],
    sets: 0,
    isOpen: false,
    placed: o.placed ?? true,
    below: o.below ?? 'engine',
    registered: [] as string[],
  }
  mock.clock(on)
  on('agent.register', (_$, e) => (w.registered.push(e.name), { value: { agent: `crew:${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('store.get', (_$, e) => {
    if (o.getFail) throw new Error('store.get unavailable')
    return { value: store.get(e.key) }
  })
  on('store.set', (_$, e) => {
    w.sets++
    if (o.setFail) throw new Error('store.set unavailable')
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    w.opens.push(e.id)
    w.isOpen = true
    return { value: w.placed ? { isPlaced: true as const } : { isPlaced: false as const, reason: o.reason ?? 'widen the terminal' } }
  })
  on('ui.close', (_$, e) => {
    if (o.closeFail) throw new Error('ui.close unavailable')
    w.closes.push({ id: e.id, origin: e.origin.kind })
    w.isOpen = false
    return { value: undefined }
  })
  on('ui.panes', () => {
    if (o.panesFail) throw new Error('ui.panes unavailable')
    return { value: w.isOpen ? [{ id: 'flightdeck', title: 'Flightdeck', isShown: true, isFocused: false, isPlaced: w.placed }] : [] }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) =>
    w.below === 'other' ? $.ui.resolve(e).Text({ children: OTHER_BAND }) : ({ type: 'engine', ref: 0 } as never),
  )
  return w
}

const startSession = async ($: Engine) => {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  // The pane opens without being awaited by the session start.
  for (let i = 0; i < 5; i++) await pause()
}

const panel = async ($: Engine, args = '', presentation?: { isFullscreen: boolean; columns: number }) =>
  (await $.command.run({ command: 'crew:panel', args, origin: { kind: 'composer' }, ...(presentation ? { presentation } : {}) } as never)).text

const band = (hasSurvey = false) => ({
  plugin: 'crew',
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 11 },
    view: {},
  } as never,
})

const STORED = (isVisible: boolean, placement: 'side' | 'prompt') => ({ v: 1, isVisible, placement })

test('bare /crew:panel toggles the side pane and saves the pick', async ($, on) => {
  const w = panelWorld(on, { stored: { panel: STORED(false, 'side') } })
  await startSession($)
  expect(w.opens).toEqual([])

  expect(await panel($)).toContain('Panel shown above the prompt')
  expect(w.opens).toEqual(['flightdeck'])
  expect(w.store.get('panel')).toEqual(STORED(true, 'side'))

  expect(await panel($)).toBe('Panel hidden. /crew:panel shows it again.')
  expect(w.closes).toEqual([{ id: 'flightdeck', origin: 'plugin' }])
  expect(w.store.get('panel')).toEqual(STORED(false, 'side'))

  expect(await panel($)).toContain('Panel shown')
  expect(w.opens).toEqual(['flightdeck', 'flightdeck'])
})

test('on and off keep the placement', async ($, on) => {
  const w = panelWorld(on)
  await panel($, 'prompt')
  await panel($, 'off')
  expect(w.store.get('panel')).toEqual(STORED(false, 'prompt'))
  expect(await panel($, 'on')).toContain('Panel shown in the band above the prompt')
  expect(w.store.get('panel')).toEqual(STORED(true, 'prompt'))
  await panel($, 'side')
  await panel($, 'off')
  expect(await panel($, 'ON')).toContain('Panel shown above the prompt')
  expect(w.store.get('panel')).toEqual(STORED(true, 'side'))
})

test('an unplaced pane counts as hidden, so bare /crew:panel shows it; a failing panes call falls back to the pick', async ($, on) => {
  const w = panelWorld(on, { placed: false, reason: 'widen the terminal to 144 columns' })
  expect(await panel($, 'side')).toBe('Panel set to the side, not shown yet: widen the terminal to 144 columns')
  expect(w.store.get('panel')).toEqual(STORED(true, 'side'))
  // Open but undrawn: the toggle shows it again instead of hiding it.
  expect(await panel($)).toContain('not shown yet')
  expect(w.closes).toEqual([])
})

test('bare /crew:panel falls back to the saved pick when the panes call fails', async ($, on) => {
  const w = panelWorld(on, { panesFail: true })
  await panel($, 'side') // saved visible
  expect(await panel($)).toBe('Panel hidden. /crew:panel shows it again.')
  expect(w.store.get('panel')).toEqual(STORED(false, 'side'))
  expect(await panel($)).toContain('Panel shown')
})

test('side then prompt then side: the pane closes for the band and opens again', async ($, on) => {
  const w = panelWorld(on)
  const ui = await $.ui.mount(band())
  expect(await ui.find({ text: /idle/ })).toBeUndefined() // before any pick the band passes

  expect(await panel($, 'side')).toContain('Panel shown above the prompt')
  expect(w.opens).toEqual(['flightdeck'])
  expect(await ui.find({ text: /idle/ })).toBeUndefined() // side mode: no band

  expect(await panel($, 'prompt')).toBe('Panel shown in the band above the prompt. Focus it with ctrl+x tab; collapse it with ctrl+x ctrl+a.')
  expect(w.closes).toEqual([{ id: 'flightdeck', origin: 'plugin' }])
  expect(w.store.get('panel')).toEqual(STORED(true, 'prompt'))
  expect(await ui.find({ text: /idle/ })).toBeDefined() // the band redraws with the summary

  await panel($, 'side')
  expect(w.opens).toEqual(['flightdeck', 'flightdeck'])
  expect(await ui.find({ text: /idle/ })).toBeUndefined()
  await ui.unmount()
})

test('/crew:panel side words its reply by the room the command has', async ($, on) => {
  panelWorld(on)
  expect(await panel($, 'side', { isFullscreen: true, columns: 150 })).toBe(
    'Panel docked beside the transcript. Focus it with ctrl+x tab; 1-6 expand cards, f/s/o open the gate rows.',
  )
  expect(await panel($, 'side', { isFullscreen: false, columns: 80 })).toBe(
    'Panel shown above the prompt (it docks in fullscreen from 110 columns). Focus it with ctrl+x tab.',
  )
  expect(await panel($, 'side', { isFullscreen: true, columns: 100 })).toContain('above the prompt')
})

test('the band draws only in prompt mode, with the panel visible and no survey', async ($, on) => {
  const w = panelWorld(on)
  const drawn = async (hasSurvey = false) => {
    const ui = await $.ui.mount(band(hasSurvey))
    const found = await ui.find({ text: /idle/ })
    await ui.unmount()
    return found !== undefined
  }

  expect(await drawn()).toBe(false) // session.start has not run: null passes
  await panel($, 'prompt')
  expect(await drawn()).toBe(true)
  expect(await drawn(true)).toBe(false) // a survey holds the band
  await panel($, 'off')
  expect(await drawn()).toBe(false)
  await panel($, 'on')
  expect(await drawn()).toBe(true)
  await panel($, 'side')
  expect(await drawn()).toBe(false)
  expect(w.opens.length).toBe(1)
})

test('the band yields to another plugin\'s band whatever the order', async ($, on) => {
  panelWorld(on, { below: 'other' })
  await panel($, 'prompt')
  const ui = await $.ui.mount(band())
  expect(await ui.find({ text: new RegExp(OTHER_BAND) })).toBeDefined()
  expect(await ui.find({ text: /idle/ })).toBeUndefined()
  await ui.unmount()
})

test('the band draws at most three cards and hints at the rest', async ($, on) => {
  panelWorld(on)
  on('agent.spawn', (_$, e) => ({ model: 'sonnet', agentId: `ag-${e.description}` }))
  await panel($, 'prompt')
  for (let i = 1; i <= 5; i++) await $.agent.spawn({ agent: 'crew:developer', description: `job ${i}`, prompt: 'x' } as never)
  const ui = await $.ui.mount(band())
  expect(await ui.find({ text: /\+2 more agents/ })).toBeDefined()
  for (const n of [1, 2, 3]) expect(await ui.find({ text: new RegExp(`job ${n}`) })).toBeDefined()
  for (const n of [4, 5]) expect(await ui.find({ text: new RegExp(`job ${n}`) })).toBeUndefined()
  await ui.unmount()
})

test('placement prompt in the options starts with the band and opens no pane', { options: { placement: 'prompt' } }, async ($, on) => {
  const w = panelWorld(on)
  await startSession($)

  expect(w.opens).toEqual([])
  const ui = await $.ui.mount(band())
  expect(await ui.find({ text: /idle/ })).toBeDefined()
  await ui.unmount()
})

test('the default options open the side pane once at the start', async ($, on) => {
  const w = panelWorld(on)
  await startSession($)

  expect(w.opens).toEqual(['flightdeck'])
  expect(w.store.has('panel')).toBe(false) // only a pick is saved, never the defaults
  const ui = await $.ui.mount(band())
  expect(await ui.find({ text: /idle/ })).toBeUndefined()
  await ui.unmount()
})

test('openOnStart false starts hidden', { options: { openOnStart: false } }, async ($, on) => {
  const w = panelWorld(on)
  await startSession($)
  expect(w.opens).toEqual([])
  expect(await panel($)).toContain('Panel shown') // the first bare command shows it
})

test('a saved pick wins over the options', async ($, on) => {
  const w = panelWorld(on, { stored: { panel: STORED(true, 'prompt') } })
  await startSession($)
  expect(w.opens).toEqual([]) // the options say side and open, the pick says prompt
  const ui = await $.ui.mount(band())
  expect(await ui.find({ text: /idle/ })).toBeDefined()
  await ui.unmount()
})

test('a saved hidden pick opens nothing', async ($, on) => {
  const w = panelWorld(on, { stored: { panel: STORED(false, 'side') } })
  await startSession($)
  expect(w.opens).toEqual([])
})

for (const [name, junk] of [
  ['a wrong version', { v: 2, isVisible: false, placement: 'prompt' }],
  ['a bad placement', { v: 1, isVisible: false, placement: 'floating' }],
  ['a string', 'prompt'],
] as const) {
  test(`${name} in the store falls back to the options`, async ($, on) => {
    const w = panelWorld(on, { stored: { panel: junk } })
    await startSession($)
    expect(w.opens).toEqual(['flightdeck'])
  })
}

test('a store that cannot be read starts on the options, and the six specialists still register', async ($, on) => {
  const w = panelWorld(on, { getFail: true })
  await startSession($)

  expect(w.registered.length).toBe(6)
  expect(w.opens).toEqual(['flightdeck'])
})

test('the plugin\'s own close leaves the pick as it is: off keeps the placement, prompt keeps it visible', async ($, on) => {
  const w = panelWorld(on)
  await panel($, 'prompt')
  await panel($, 'off')
  // Both closes came through the ui.close hook with origin plugin: neither wrote a second pick.
  expect(w.closes.map(c => c.origin)).toEqual(['plugin', 'plugin'])
  expect(w.sets).toBe(2)
  expect(w.store.get('panel')).toEqual(STORED(false, 'prompt'))
})

test('a store that cannot be written still switches the panel for the session, with the same reply', async ($, on) => {
  const w = panelWorld(on, { setFail: true })
  const ui = await $.ui.mount(band())
  expect(await panel($, 'prompt')).toContain('Panel shown in the band')
  expect(w.sets).toBeGreaterThan(0)
  expect(w.store.has('panel')).toBe(false)
  expect(await ui.find({ text: /idle/ })).toBeDefined()
  expect(await panel($, 'off')).toBe('Panel hidden. /crew:panel shows it again.')
  expect(await ui.find({ text: /idle/ })).toBeUndefined()
  await ui.unmount()
})

test('a command that throws answers with text and never reaches the model', async ($, on) => {
  panelWorld(on, { closeFail: true })
  // `off` closes the pane: the failure is caught and answered, not left to fall through.
  expect(await panel($, 'off')).toBe('The panel could not run this command; see the debug log.')
})

test('layout in prompt mode sets the layout and opens no pane', async ($, on) => {
  const w = panelWorld(on)
  await panel($, 'prompt')
  expect(await panel($, 'layout wide')).toBe('Panel layout: wide; it applies to the side pane, the band always shows the summary.')
  expect(w.opens).toEqual([])
  expect(w.store.get('panel')).toEqual(STORED(true, 'prompt'))
})

test('layout in side mode shows the pane', async ($, on) => {
  const w = panelWorld(on, { stored: { panel: STORED(false, 'side') } })
  expect(await panel($, 'layout mini')).toBe('Panel layout: mini.')
  expect(w.opens).toEqual(['flightdeck'])
  expect(w.store.get('panel')).toEqual(STORED(true, 'side'))
})

test('reset and a bad argument leave the panel as it is', async ($, on) => {
  const w = panelWorld(on)
  await panel($, 'prompt')
  const sets = w.sets
  expect(await panel($, 'reset')).toBe('Panel reset.')
  expect(await panel($, 'bogus')).toBe('Usage: /crew:panel [on|off|side|prompt|reset|layout auto|compact|wide|mini]')
  expect(await panel($, 'layout diagonal')).toContain('Usage: /crew:panel')
  expect(w.sets).toBe(sets)
  expect(w.store.get('panel')).toEqual(STORED(true, 'prompt'))
})

// --- The -codex types (nativeCodex) ---

const NATIVE = { options: { nativeCodex: 'developer=gpt-6-astra, architect=gpt-6-sage, tester=gpt-6-astra' } }
const NATIVE_AND_JEV = { options: { ...NATIVE.options, jevKey: KEY } }

type Registered = { name: string; model?: string; effort?: string | number; tools?: readonly string[]; prompt: string; description: string }

/** The host beneath the session start with `ANTHROPIC_BASE_URL` as given (unset when `baseUrl` is undefined). */
function nativeWorld(on: On, baseUrl?: string, o: { envFail?: boolean; twinFail?: boolean } = {}) {
  const w = { registered: [] as Registered[], logs: [] as string[] }
  mock.clock(on)
  // `mock.env` answers every `env.get`; a failing read is the host with no env hook beneath the plugin.
  if (o.envFail) on('env.get', () => { throw new Error('env unavailable') })
  else mock.env(on, { HOME, ...(baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: baseUrl }) })
  on('agent.register', (_$, e) => {
    if (o.twinFail && e.name.endsWith('-codex')) throw new Error('refused')
    return (w.registered.push(e as Registered), { value: { agent: `crew:${e.name}` } })
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.log', (_$, e) => (w.logs.push(e.text), { value: undefined }))
  return w
}

const TWINS = ['developer-codex', 'tester-codex', 'architect-codex']
const BASES = ['code-reader', 'research', 'designer', 'developer', 'tester', 'architect']

for (const url of ['http://127.0.0.1:41237', 'http://127.4.5.6:9', 'http://[::1]:41237', 'http://localhost:41237']) {
  test(`the -codex types register behind the loopback base URL ${url}, each on its model with its base role's tools and effort`, NATIVE, async ($, on) => {
    const w = nativeWorld(on, url)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

    expect(w.registered.map(a => a.name)).toEqual([...BASES, ...TWINS])
    const by = (name: string) => w.registered.find(a => a.name === name)!
    expect(by('developer-codex')).toMatchObject({ model: 'gpt-6-astra', effort: 'medium', tools: by('developer').tools, prompt: by('developer').prompt })
    expect(by('architect-codex')).toMatchObject({ model: 'gpt-6-sage', tools: by('architect').tools, prompt: by('architect').prompt })
    expect(by('tester-codex')).toMatchObject({ model: 'gpt-6-astra', tools: by('tester').tools })
    expect(by('architect-codex').tools).not.toContain('Edit')
    expect(by('developer').model).toBe('sonnet')
    expect(by('developer-codex').description).toContain('gpt-6-astra')
  })
}

for (const url of [undefined, '', 'https://api.anthropic.com', 'https://127.0.0.1:41237', 'http://10.0.0.5:41237', 'http://127.0.0.1.evil.com', 'http://localhost.evil.com', 'localhost:41237']) {
  test(`no -codex type registers with the base URL ${url === undefined ? 'unset' : `"${url}"`}, and one debug line says why`, NATIVE, async ($, on) => {
    const w = nativeWorld(on, url)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

    expect(w.registered.map(a => a.name)).toEqual(BASES)
    expect(w.logs.filter(line => line.includes('nativeCodex types not registered')).length).toBe(1)
  })
}

test('without the nativeCodex option nothing about it is read or logged', async ($, on) => {
  const w = nativeWorld(on, 'http://127.0.0.1:41237')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(w.registered.map(a => a.name)).toEqual(BASES)
  expect(w.logs.filter(line => line.includes('nativeCodex'))).toEqual([])
})

test('an env read that fails registers the six specialists and no -codex type', NATIVE, async ($, on) => {
  const w = nativeWorld(on, 'http://127.0.0.1:41237', { envFail: true })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(w.registered.map(a => a.name)).toEqual(BASES)
})

test('a -codex type whose registration fails leaves the six specialists registered and the session started', NATIVE, async ($, on) => {
  const w = nativeWorld(on, 'http://127.0.0.1:41237', { twinFail: true })
  const started = await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(started).toMatchObject({ cwd: '/proj' })
  expect(w.registered.map(a => a.name)).toEqual(BASES)
})

test('the parser is the Codex engine\'s: an unknown role or a bad id is skipped with one debug line, the rest registers', { options: { nativeCodex: 'developer=gpt-x, bogus=gpt-y, tester=-m, architect' } }, async ($, on) => {
  const w = nativeWorld(on, 'http://127.0.0.1:41237')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(w.registered.map(a => a.name)).toEqual([...BASES, 'developer-codex'])
  const ignored = w.logs.filter(line => line.startsWith('crew: nativeCodex ignored in part'))
  expect(ignored.length).toBe(1)
  expect(ignored[0]).toContain('"bogus": unknown role')
  expect(ignored[0]).toContain('tester: invalid model id')
})

test('the -codex section follows the registration: its own section after the lead, only behind a loopback base URL', NATIVE, async ($, on) => {
  nativeWorld(on, 'http://127.0.0.1:41237')
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  const composed = await compose($, ['Agent', 'Read'])

  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'crew:lead', 'crew:native-codex'])
  const lead = composed.sections[1]
  const twins = composed.sections[2]
  expect(lead?.text).not.toContain('codex')
  expect(twins?.scope).toBe('session')
  for (const name of TWINS) expect(twins?.text).toContain(`crew:${name}`)
  expect(twins?.text).toContain('gpt-6-sage')
  expect(twins?.text).not.toContain('mcp__crew__codex')
  expect((await compose($, ['Agent', 'Read'])).sections[2]?.text).toBe(twins?.text)
})

test('the -codex section compares with mcp__crew__codex only when the Codex engine offers it', { options: { ...NATIVE.options, codex: true } }, async ($, on) => {
  nativeWorld(on, 'http://localhost:41237')
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect((await compose($, ['Agent', 'mcp__crew__codex'])).sections.at(-1)?.text).toContain('mcp__crew__codex is different')
  expect((await compose($, ['Agent'])).sections.at(-1)?.text).not.toContain('mcp__crew__codex')
})

test('no -codex section without a loopback base URL: the request gets the lead section alone', NATIVE, async ($, on) => {
  nativeWorld(on, 'https://api.anthropic.com')
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:lead'])
})

test('no -codex section on a request without the Agent tool, for a teammate or a bare prompt, even behind a loopback URL', NATIVE, async ($, on) => {
  nativeWorld(on, 'http://127.0.0.1:41237')
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect((await compose($, ['Read'])).sections).toEqual([])
  expect((await compose($, ['Agent'], ['teammate'])).sections).toEqual([])
  expect((await compose($, ['Agent'], ['bare'])).sections).toEqual([])
})

test('the -codex section is absent with the option empty, whatever the base URL', async ($, on) => {
  nativeWorld(on, 'http://127.0.0.1:41237')
  on('prompt.compose', () => ({ sections: [] }))

  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:lead'])
})

const LOOPBACK = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:41237' }

/** `jevWorld` with the session started behind the loopback proxy, so the twins are registered and routable. */
async function twinWorld($: Engine, on: On, opts: Parameters<typeof jevWorld>[1] = {}) {
  const world = jevWorld(on, { env: LOOPBACK, register: true, ...opts })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  return world
}

for (const tier of ['haiku', 'sonnet', 'opus']) {
  test(`Jev's tier ${tier} at full confidence never sets a model on a -codex spawn; its depth sizes the effort`, NATIVE_AND_JEV, async ($, on) => {
    const { seen } = await twinWorld($, on, { reply: async () => ok(answer(tier, 1, 3.5)) })
    await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
    await $.agent.spawn(spawnInput({ subagentType: 'crew:architect-codex', tool_use_id: 'tu2' }))

    expect(seen.fetches.length).toBe(2)
    expect(seen.spawned.map(spawned => spawned.subagentType)).toEqual(['crew:developer-codex', 'crew:architect-codex'])
    for (const spawned of seen.spawned) expect(spawned.model).toBeUndefined()
    expect(seen.spawned.map(spawned => spawned.description)).toEqual(['audit auth · gpt-6-astra/high', 'audit auth · gpt-6-sage/high'])
  })
}

test('a -codex spawn is routed for its effort: Jev sees the base role, the step gets high, the tag and notice name the id', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer('opus', 0.9, 3.5)) })
  const result = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium')

  expect(result).toMatchObject({ model: 'default', agentId: 'a1' })
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6-astra/high' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(JSON.parse(seen.fetches[0]?.body ?? '{}').state.agent).toEqual({ type: 'developer', description: 'audit auth' })
  expect(seen.steps).toEqual(['high'])
  expect(seen.notices).toEqual(['crew:developer-codex -> gpt-6-astra · high (jev)'])
  expect(seen.logs.some(line => line.includes('crew:developer-codex') && line.includes('model=gpt-6-astra (default)') && line.includes('effort=high'))).toBe(true)
  expect(JSON.stringify([seen.notices, seen.logs])).not.toContain(KEY)
})

test('a -codex spawn that passes model is refused, so it cannot run on Claude untagged; without model it is routed, and a base role with model is untouched', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer('opus', 0.9, 3.5)) })
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: 'opus' }))
  expect(refused).toMatchObject({ deny: expect.stringContaining('without `model`') })
  expect(seen.spawned).toEqual([])
  expect(seen.fetches).toEqual([])

  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', tool_use_id: 'tu2' }))
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6-astra/high' })

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
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer('opus', 0.9, 2.0)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium')

  expect(seen.spawned[0]).toMatchObject({ description: 'audit auth · gpt-6-astra/medium' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.steps).toEqual(['medium'])
  expect(seen.notices).toEqual(['crew:developer-codex -> gpt-6-astra · medium (jev)'])
})

test('a Jev error leaves a -codex spawn as it came: no tag, no model, no notice, no record, the step untouched', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-astra', reply: async () => ok('not json') })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'low')

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.steps).toEqual(['low'])
  expect(seen.notices).toEqual([])
  expect(seen.writes).toEqual([])
  expect(seen.transcript).toEqual([])
})

test('without a jevKey a -codex spawn is untouched: no request, no tag, no settings read, nothing recorded', NATIVE, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-astra' })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium')

  expect(seen.fetches).toEqual([])
  expect(seen.settingsReads).toBe(0)
  expect(seen.spawned[0]).toMatchObject({ description: 'audit auth' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.steps).toEqual(['medium'])
  expect([seen.notices, seen.writes, seen.transcript]).toEqual([[], [], []])
})

test('a -codex type that is not registered through the option is not routed', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on)
  await $.agent.spawn(spawnInput({ subagentType: 'crew:code-reader-codex' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:mystery-codex', tool_use_id: 'tu2' }))

  expect(seen.fetches).toEqual([])
  expect(seen.spawned.map(spawned => spawned.description)).toEqual(['audit auth', 'audit auth'])
})

test('a tag copied from a -codex task is sent without it and tagged once', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer('opus', 0.9, 3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6-astra/medium' }))

  expect(JSON.parse(seen.fetches[0]?.body ?? '{}').state.agent.description).toBe('audit auth')
  expect(seen.spawned[0]?.description).toBe('audit auth · gpt-6-astra/high')
})

test('the record of a -codex decision holds the id as model and default model, stays v 1, and keeps the effort that took', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer('haiku', 0.9, 3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))

  expect(seen.writes.length).toBe(1)
  const record = JSON.parse(seen.writes[0]?.text ?? '{}')
  expect(record).toMatchObject({
    v: 1, agent: 'developer-codex', defaultModel: 'gpt-6-astra', model: 'gpt-6-astra', defaultEffort: 'medium',
    effortPlanned: 'high', effortApplied: 'high', bind: 'applied', applied: { model: false, effort: true }, ran: null, outcome: null,
  })
  expect(seen.writes[0]?.path).toContain('-a1.json')
  expect(JSON.stringify(record)).not.toContain('audit auth')
})

test('the first step of a routed -codex spawn is confirmed against the id and the effort, in the transcript and the record', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-astra', reply: async () => ok(answer('opus', 0.9, 3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium')
  await step($, 'a1', 'medium')

  expect(seen.transcript).toEqual(['jev: audit auth: confirmed gpt-6-astra · high'])
  expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'gpt-6-astra', effort: 'high' })
})

test('a confirmation accepts the id the proxy reports with an effort suffix', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'GPT-6-Astra-high', reply: async () => ok(answer('opus', 0.9, 3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium')

  expect(seen.transcript).toEqual(['jev: audit auth: confirmed GPT-6-Astra-high · high'])
})

test('a -codex run on another model, or with no effort sent, says what ran instead', NATIVE_AND_JEV, async ($, on) => {
  let model = 'claude-sonnet-5-5'
  const { seen } = await twinWorld($, on, { stepModel: () => model, reply: async () => ok(answer('opus', 0.9, 3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium')
  expect(seen.transcript).toEqual(['jev: audit auth: ran claude-sonnet-5-5 · high, not gpt-6-astra/high'])

  model = 'gpt-6-astra-mini'
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', tool_use_id: 'tu2' }))
  await step($, 'a1', null)
  expect(seen.transcript.at(-1)).toBe('jev: audit auth: ran gpt-6-astra-mini · no effort, not gpt-6-astra/high')
})

test('a Claude role beside a -codex twin is still routed by tier and effort', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on)
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))

  expect(seen.fetches.length).toBe(2)
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6-astra/high' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.spawned[1]).toMatchObject({ subagentType: 'crew:developer', model: 'opus', description: 'audit auth · opus/high' })
})

const codexAgents = [
  { id: 'ar1', type: 'crew:architect-codex' },
  { id: 'te1', type: 'crew:tester-codex' },
  { id: 'de1', type: 'crew:developer-codex' },
  { id: 'xx1', type: 'crew:mystery-codex' },
]

for (const tool of ['Write', 'Edit'] as const) {
  test(`${tool}: each -codex twin is held to its base role's lane, and an unknown crew -codex type is held`, NATIVE, async ($, on) => {
    on('agent.list', () => ({ value: codexAgents }) as never)
    on('tool.call', () => ({ result: 'written' }))
    const call = (agentId: string, file_path: string) => $.tool.call({ tool, agentId, file_path } as never)

    expect(await call('ar1', 'src/app.ts')).toHaveProperty('deny')
    expect(await call('ar1', '.crew/plans/plan.md')).toEqual({ result: 'written' })
    expect(await call('te1', 'src/app.ts')).toHaveProperty('deny')
    expect(await call('te1', 'tests/app.test.ts')).toEqual({ result: 'written' })
    expect(await call('de1', 'src/app.ts')).toEqual({ result: 'written' })
    expect(await call('xx1', 'src/app.ts')).toHaveProperty('deny')
    expect(await call('xx1', '.crew/plans/plan.md')).toHaveProperty('deny')
  })
}

test('architect-codex lands in the ARCHITECT panel as a consult, not as a card; developer-codex is a card', NATIVE, async ($, on) => {
  on('agent.spawn', (_$, e) => ({ model: 'gpt-6-sage', agentId: e.subagentType === 'crew:architect-codex' ? 'ar1' : 'de1' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.status', () => ({ value: undefined }))
  mock.clock(on)
  const writes = watchCards(on)

  await $.turn.start({ text: 'plan it', turnId: 'T1' })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:architect-codex', description: 'review the plan', background: true }))
  const pane = {
    plugin: 'crew', component: 'Pane' as const, requestId: 'flightdeck', surface: 'terminal' as const,
    props: { title: 'Flightdeck', isFocused: true, bodyColumns: 64, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 70 }, view: {} },
  }
  const ui = await $.ui.mount(pane as never)
  expect(await ui.find({ text: /ARCHITECT/ })).toBeDefined()
  await ui.unmount()
  expect(writes.length).toBe(0)

  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', description: 'write the parser', background: true, tool_use_id: 'tu2' }))
  const cards = writes.at(-1)?.value as { id: string; type: string; model: string }[]
  expect(cards.map(card => card.id)).toEqual(['de1'])
  expect(cards[0]).toMatchObject({ type: 'crew:developer-codex', model: 'gpt-6-sage' })
})

// --- Jev on the -codex twins, the gate and the registered set, through the host ---

for (const [depth, effort] of [[2.9, 'medium'], [3.0, 'medium'], [3.5, 'high']] as const) {
  for (const type of ['crew:developer-codex', 'crew:architect-codex']) {
    test(`${type} at tier haiku@1 and depth ${depth} gets no model and runs on ${effort}`, NATIVE_AND_JEV, async ($, on) => {
      const { seen } = await twinWorld($, on, { reply: async () => ok(answer('haiku', 1, depth)) })
      await $.agent.spawn(spawnInput({ subagentType: type }))
      await step($, 'a1', 'medium')

      expect(seen.spawned[0]?.model).toBeUndefined()
      const id = type === 'crew:architect-codex' ? 'gpt-6-sage' : 'gpt-6-astra'
      expect(seen.spawned[0]?.description).toBe(`audit auth · ${id}/${effort}`)
      expect(seen.steps).toEqual([effort])
      expect(seen.notices[0]).toBe(`${type} -> ${id} · ${effort} (jev)`)
    })
  }
}

for (const status of [500, 429, 401]) {
  test(`a Jev ${status} leaves a -codex spawn and its step as they came`, NATIVE_AND_JEV, async ($, on) => {
    const { seen, clock } = await twinWorld($, on, { reply: async () => ({ status, ok: false, headers: {}, text: 'no' }) })
    const spawned = $.agent.spawn(spawnInput({ subagentType: 'crew:architect-codex' }))
    await clock.settle()
    await pause()
    await clock.advance(3_000)
    await spawned
    await step($, 'a1', 'low')

    expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:architect-codex', description: 'audit auth' })
    expect(seen.spawned[0]?.model).toBeUndefined()
    expect(seen.steps).toEqual(['low'])
    expect([seen.notices, seen.writes]).toEqual([[], []])
  })
}

test('crew:architect beside architect-codex still floors at opus and routes effort', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer('haiku', 1, 3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:architect-codex' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:architect', tool_use_id: 'tu2' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer', tool_use_id: 'tu3' }))

  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.spawned[1]?.model).toBeUndefined()
  expect(seen.spawned[1]?.description).toBe('audit auth · opus/high')
  expect(seen.spawned[2]).toMatchObject({ model: 'haiku', description: 'audit auth · haiku/high' })
})

test('an uppercase HTTP scheme on loopback registers the twins and adds their section', NATIVE, async ($, on) => {
  const w = nativeWorld(on, 'HTTP://127.0.0.1:41237')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(w.registered.map(a => a.name)).toEqual([...BASES, ...TWINS])
})

for (const url of ['http://[::ffff:127.0.0.1]:1', 'http://localhost.:1', 'http://127.0.0.1.nip.io', 'http://127.0.0.1@evil.com']) {
  test(`${url} registers no twin and composes no native section`, NATIVE, async ($, on) => {
    const w = nativeWorld(on, url)
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
    expect(w.registered.map(a => a.name)).toEqual(BASES)
    expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:lead'])
  })
}

// The twins Jev may size are the ones this session registered, not the ones the option names.
test('with a non-loopback base URL no twin is registered, so a crew:developer-codex spawn is not sent to Jev', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = jevWorld(on, { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, register: true, reply: async () => ok(answer('opus', 1, 3.5)) })
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
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer('opus', 0.9, 3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', description: 'docs · v2/high' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer', description: 'docs · v2/high', tool_use_id: 'tu2' }))

  expect(JSON.parse(seen.fetches[0]?.body ?? '{}').state.agent.description).toBe('docs · v2/high')
  expect(seen.spawned[0]?.description).toBe('docs · v2/high · gpt-6-astra/high')
  expect(seen.spawned[1]?.description).toBe('docs · v2/high · opus/high')
})

// --- Registration drives routing and the native section ---

test('twins refused by the host compose no native section and are not sent to Jev', NATIVE, async ($, on) => {
  const w = nativeWorld(on, 'http://127.0.0.1:41237', { twinFail: true })
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(w.registered.map(a => a.name)).toEqual(BASES)
  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:lead'])
  expect(w.logs.filter(line => line.includes('nativeCodex crew:') && line.includes('not registered')).length).toBe(TWINS.length)
})

test('before session.start no native section, after it behind loopback the section lists the twins', NATIVE, async ($, on) => {
  nativeWorld(on, 'http://127.0.0.1:41237')
  on('prompt.compose', () => ({ sections: [] }))
  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:lead'])
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  const sections = (await compose($, ['Agent'])).sections
  expect(sections.map(section => section.id)).toEqual(['crew:lead', 'crew:native-codex'])
  for (const name of TWINS) expect(sections[1]?.text).toContain(`crew:${name}`)
  expect(sections[0]?.text.toLowerCase()).not.toContain('codex')
})

test('with twins registered, an unregistered twin and a Claude role: one request each for the Claude role and the twin', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer('haiku', 1, 3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:code-reader-codex', description: 'find · gpt-6-astra/high' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', description: 'fix · gpt-6-astra/medium', tool_use_id: 'tu2' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer', description: 'fix · opus/high', tool_use_id: 'tu3' }))

  expect(seen.fetches.length).toBe(2)
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:code-reader-codex', description: 'find · gpt-6-astra/high' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.spawned[1]?.description).toBe('fix · gpt-6-astra/high')
  expect(seen.spawned[1]?.model).toBeUndefined()
  expect(seen.spawned[2]).toMatchObject({ model: 'haiku', description: 'fix · haiku/high' })
})

// A `model` on a registered twin's spawn is refused before Jev, with routing on or off.

const DENY_TEXT = (type: string) => `crew: ${type} runs on its own Codex model; call it again without \`model\``

test('without a jevKey a -codex spawn that passes model is still refused, reaches no host and draws no card; without model it passes untagged', NATIVE, async ($, on) => {
  const writes = watchCards(on)
  const { seen } = await twinWorld($, on)
  const before = writes.length
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: 'opus' }))
  expect(refused).toMatchObject({ deny: DENY_TEXT('crew:developer-codex') })
  const architect = await $.agent.spawn(spawnInput({ subagentType: 'crew:architect-codex', model: 'sonnet', tool_use_id: 'tu2' }))
  expect(architect).toMatchObject({ deny: DENY_TEXT('crew:architect-codex') })
  expect(seen.spawned).toEqual([])
  expect(seen.fetches).toEqual([])
  expect(seen.notices).toEqual([])
  expect(seen.writes).toEqual([])
  // Flightdeck wraps the crew's hook and draws no card for a refused spawn.
  expect(writes.length).toBe(before)

  // Without model, the twin passes untouched: no Jev, no tag.
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', tool_use_id: 'tu3' }))
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(writes.length).toBeGreaterThan(before)
  // A base role with model, routing off, is untouched.
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer', model: 'opus', tool_use_id: 'tu4' }))
  expect(seen.spawned[1]).toMatchObject({ subagentType: 'crew:developer', model: 'opus', description: 'audit auth' })
  expect(seen.fetches).toEqual([])
})

test('a -codex spawn that passes its own Codex id as model is refused too', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on)
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: 'gpt-6-astra' }))
  expect(refused).toMatchObject({ deny: DENY_TEXT('crew:developer-codex') })
  expect(seen.spawned).toEqual([])
  expect(seen.fetches).toEqual([])
})

test('a -codex spawn with an empty model is not refused: it is routed and tagged as without one', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer('opus', 0.9, 3.5)) })
  const result = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: '' }))
  expect(result).not.toHaveProperty('deny')
  expect(seen.fetches).toHaveLength(1)
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6-astra/high' })
})

test('a -codex spawn with model from inside a subagent is refused like one from the main loop', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on)
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:tester-codex', model: 'haiku', parentAgentId: 'p1' }))
  expect(refused).toMatchObject({ deny: DENY_TEXT('crew:tester-codex') })
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
  await $.agent.spawn(spawnInput({ subagentType: 'crew:code-reader-codex', model: 'opus' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:mystery-codex', model: 'opus', tool_use_id: 'tu2' }))
  expect(seen.spawned.map(s => [s.subagentType, s.model, s.description])).toEqual([
    ['crew:code-reader-codex', 'opus', 'audit auth'],
    ['crew:mystery-codex', 'opus', 'audit auth'],
  ])
  expect(seen.fetches).toEqual([])
})

test('with a non-loopback base URL no twin is registered, yet a crew:developer-codex spawn that passes model is still refused: the option names it', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = jevWorld(on, { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, register: true })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: 'opus' }))
  expect(refused).toMatchObject({ deny: expect.stringContaining('without `model`') })
  expect(seen.spawned).toEqual([])
  expect(seen.fetches).toEqual([])
})

test('without the nativeCodex option a crew:developer-codex spawn that passes model goes on untouched', ON, async ($, on) => {
  const { seen } = await twinWorld($, on)
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: 'opus' }))
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', model: 'opus', description: 'audit auth' })
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
