import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fnv1a } from '../hooks/decisions'
import type { Quota } from '../hooks/quota'
import { CODEX_MODELS } from '../hooks/native'

const agents = [
  { id: 'a1', type: 'crew:architect' },
  { id: 't1', type: 'crew:tester' },
  { id: 'd1', type: 'crew:developer' },
]

test('session start registers the five specialists with their models', async ($, on) => {
  const registered: { name: string; model?: string; effort?: string | number; tools?: readonly string[] }[] = []

  on('agent.register', (_$, e) => (registered.push(e), { value: { agent: `crew:${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(registered.map(a => [a.name, a.model])).toEqual([
    ['code-reader', 'haiku'],
    ['research', 'haiku'],
    ['designer', 'sonnet'],
    ['developer', 'sonnet'],
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
  expect(await call('t1', 'tests/app.test.ts')).toHaveProperty('deny')
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

const answer = (depth: number) =>
  JSON.stringify({
    model: 'jev-1.13.0',
    answers: {
      reasoning_depth: { score: depth, confidence: 0.5 },
    },
  })

type Reply = { status: number; ok: boolean; headers: Record<string, string>; text: string }
const ok = (text: string): Reply => ({ status: 200, ok: true, headers: {}, text })

type Seen = {
  fetches: { url: string; headers: Record<string, string>; body: string }[]
  /** The remote's usage api-calls (they are not counted among Jev's `fetches`). */
  statuses: { url: string; headers: Record<string, string>; body: string }[]
  /** The remote's credential-list requests. */
  credentials: { url: string; headers: Record<string, string> }[]
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
    /** Holds the API answer so a step may finish after its spawn. */
    stepWait?: () => Promise<void>
    /** `$.clock.now` answers with this instead of the mock clock's time (the waits stay the mock clock's). */
    now?: () => number
    /** Hooks beneath `$.session.start` and `$.agent.register`, so a test can start the session and register the agents. */
    register?: boolean
    twinFail?: (name: string) => boolean
    /** The remote's usage api-call answers here instead of as Jev. */
    status?: () => Promise<Reply>
    /** The remote's credential list; one active Codex account by default. */
    credentials?: () => Promise<Reply>
    /** `$.session.usage()` reports these limits (read each time, so a test can change them). */
    rateLimits?: () => { kind: string; percentUsed: number; resetsAt?: string }[]
  } = {},
) {
  const seen: Seen = { fetches: [], statuses: [], credentials: [], spawned: [], steps: [], notices: [], logs: [], writes: [], transcript: [], settingsReads: 0 }
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
  if (opts.rateLimits) {
    const limits = opts.rateLimits
    on('session.usage', () => ({ value: { startedAt: 0, context: { percent: 1, tokens: 1, window: 100 }, rateLimits: limits() } }) as never)
  }
  on('http.fetch', async (_$, e) => {
    if (opts.status && e.url.endsWith('/v8/management/credentials')) {
      seen.credentials.push({ url: e.url, headers: (e.init?.headers ?? {}) as Record<string, string> })
      return { value: await (opts.credentials ?? (async () => ok(JSON.stringify({ files: [{ type: 'codex', status: 'active', auth_index: 'acct-1' }] }))))() }
    }
    if (opts.status && e.url.endsWith('/v8/management/requests/api-call')) {
      seen.statuses.push({ url: e.url, headers: (e.init?.headers ?? {}) as Record<string, string>, body: String(e.init?.body ?? '') })
      return { value: await opts.status() }
    }
    seen.fetches.push({
      url: e.url,
      headers: (e.init?.headers ?? {}) as Record<string, string>,
      body: String(e.init?.body ?? ''),
    })
    return { value: await (opts.reply ?? (async () => ok(answer(3.9))))() }
  })
  if (opts.register) {
    on('agent.register', (_$, e) => {
      if (e.name.endsWith('-codex') && (flags.registerFail || opts.twinFail?.(e.name))) throw new Error('refused')
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
    await opts.stepWait?.()
    const model = typeof opts.stepModel === 'function' ? opts.stepModel() : opts.stepModel
    const usage = model ? { model } : null
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage } as never
  })
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
const step = async ($: Engine, agentId?: string, effort: string | null = 'medium', model: string | null = 'sonnet') => {
  const stream = $.turn.step({
    turnId: 't1', index: 0, ...(model === null ? {} : { model }), messageCount: 1,
    ...(effort === null ? {} : { effort }), ...(agentId ? { agentId } : {}),
  } as never)
  let item = await stream.next()
  while (!item.done) item = await stream.next()
  return item.value
}

const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
const pause = () => new Promise<void>(resolve => timers.setTimeout(resolve, 0))

test('Jev sets only effort and never rewrites a Claude model or type, with the key in the header only', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.fetches.length).toBe(1)
  expect(seen.fetches[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(seen.fetches[0]?.headers.Authorization).toBe(`Bearer ${KEY}`)
  const body = JSON.parse(seen.fetches[0]?.body ?? '{}')
  expect(body.model).toBe('jev-1.13.0')
  expect(body.state.agent).toEqual({ type: 'developer', description: 'audit auth' })
  expect(Object.keys(body.questions)).toEqual(['reasoning_depth'])
  expect(seen.notices).toEqual(['crew:developer -> sonnet · high (jev)'])
  expect(seen.logs.some(line => line.includes('model=sonnet (default)') && line.includes('jev=jev-1.13.0'))).toBe(true)
  expect(JSON.stringify([seen.notices, seen.logs])).not.toContain(KEY)
})

test('a filled jevKey turns routing on: a crew call is sent and its task shows the choice', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput())

  expect(seen.fetches.length).toBe(1)
  expect(seen.spawned[0]).toMatchObject({ description: 'audit auth · sonnet/high' })
})

test('the task shows a kept choice too', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer(1.4)) })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]?.description).toBe('audit auth · sonnet/medium')
})

test('a call Jev failed on shows its fixed model and medium fallback', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok('not json') })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]?.description).toBe('audit auth · sonnet/medium')
})

// --- Confirmation of what ran ---

test('the first step after the spawn confirms the tag in the transcript and in the decision log', ON, async ($, on) => {
  const { seen } = jevWorld(on, { stepModel: 'claude-sonnet-5-5', reply: async () => ok(answer(3.9)) })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium')
  await step($, 'a1', 'medium')

  expect(seen.transcript).toEqual(['jev: audit auth: confirmed claude-sonnet-5-5 · high'])
  expect(seen.writes.length).toBe(2)
  expect(seen.writes[1]?.path).toBe(seen.writes[0]?.path)
  expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' })
  expect(JSON.parse(seen.writes[0]?.text ?? '{}').ran).toBeNull()
})

test('a run that differs from the role default says what ran instead', ON, async ($, on) => {
  const { seen } = jevWorld(on, { stepModel: 'claude-opus-5-5', reply: async () => ok(answer(3.9)) })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium')

  expect(seen.transcript).toEqual(['jev: audit auth: ran claude-opus-5-5 · high, not sonnet/high'])
})

test('a step the API did not answer confirms nothing and leaves the check for the next', ON, async ($, on) => {
  let answered: string | undefined
  const { seen } = jevWorld(on, { stepModel: () => answered })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium')
  expect(seen.transcript).toEqual([])

  answered = 'claude-sonnet-5-5[1m]'
  await step($, 'a1', 'medium')
  expect(seen.transcript).toEqual(['jev: audit auth: confirmed claude-sonnet-5-5[1m] · high'])
  expect(JSON.parse(seen.writes.at(-1)?.text ?? '{}').ran).toEqual({ model: 'claude-sonnet-5-5[1m]', effort: 'high' })
})

test('a confirmation write that never settles does not hold the subagent\'s step past the wait', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { stepModel: 'claude-sonnet-5-5', writeHang: true })
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

test('a Jev fallback confirms via crew, while a refused spawn adds nothing', ON, async ($, on) => {
  let refuse = false
  const { seen } = jevWorld(on, {
    stepModel: 'claude-sonnet-5-5',
    reply: async () => (refuse ? ok(answer(3.9)) : ok('not json')),
    spawn: async e => (refuse ? ({ deny: 'no' } as never) : { model: String(e.model ?? 'default'), agentId: 'a1' }),
  })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium')
  refuse = true
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
  await step($, 'a1', 'medium')

  expect(seen.transcript).toEqual(['crew: audit auth: confirmed claude-sonnet-5-5 · medium'])
})

test('steps of other agents and of the main loop confirm nothing', ON, async ($, on) => {
  const { seen } = jevWorld(on, { stepModel: 'claude-sonnet-5-5' })
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
  for (const name of ['code-reader', 'research', 'designer', 'developer', 'architect']) {
    expect(lead?.text).toContain(`crew:${name}`)
  }
  expect(lead?.text).toContain('Jev sizes')
  expect(lead?.text).toContain('Git and pull requests stay with you')
  expect(lead?.text).toContain('For a plan step, start its description with the step id')
  expect(lead?.text).toContain('launch every independent piece with ready inputs in one message')
  expect(lead?.text).toContain('launch newly unblocked or independent work without being asked or waiting for unrelated agents')
  expect(lead?.text).toContain('End each update with one line saying what runs, what waits and on what')
  expect(lead?.text).toContain('done only after crew:architect independently audits it')
  expect(lead?.text).toContain("developer's own commands and output are its report, not acceptance")
  expect(lead?.text).toContain('Send failures to the same developer via SendMessage')
  expect(lead?.text).toContain('after the fix, the architect reaudits before the step closes')
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
  expect(seen.spawned[0]?.description).toBe('audit auth · sonnet/high')
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
    reply: async () => ok(answer(3.9)),
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
  const { seen } = jevWorld(on, { reply: async () => ok(answer(1.4)) })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.notices).toEqual(['crew:developer -> sonnet · medium (jev)'])
})

test('a call that names a model, a fork, a workflow agent and non-crew types are untouched and never sent', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer(0.4)) })
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
  expect(seen.spawned[0]?.model).toBeUndefined()
})

test('settings that cannot be read disable Jev requests and use medium, and the log says why', ON, async ($, on) => {
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
    reply: async () => (fetched++ === 0 ? ok(answer(3.9)) : { status: 400, ok: false, headers: {}, text: '{}' }),
    agents: [
      // The host lists each with the description it was spawned with: the routed one carries the tag.
      { id: 'a1', type: 'crew:developer', description: 'fix tests · sonnet/high' },
      { id: 'a2', type: 'crew:developer', description: 'fix tests · sonnet/medium' },
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

  // Both run on their tagged effort from the first step: high answer and medium fallback.
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
  test(`a jevKey declared by ${source} settings for ${plugin} turns routing off: no fetch, medium fallback, no Jev wording`, ON, async ($, on) => {
    const { seen } = jevWorld(on, { [source]: declared(plugin) })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
    const result = await $.agent.spawn(spawnInput())
    const lead = (await compose($, ['Agent'])).sections.at(-1)?.text ?? ''

    expect(seen.fetches).toEqual([])
    expect(seen.spawned[0]?.model).toBeUndefined()
    expect(String(seen.spawned[0]?.description)).toBe('audit auth · sonnet/medium')
    expect(seen.spawned[0]?.model).toBeUndefined()
    expect(seen.logs.some(line => line.includes('routing is off') && line.includes('jevKey'))).toBe(true)
    expect(JSON.stringify([seen.logs, seen.notices])).not.toContain(KEY)
    expect(lead).not.toContain('Jev')
  })
}

test('unreadable settings with a valid key: no fetch, medium fallback, no Jev wording', ON, async ($, on) => {
  const { seen } = jevWorld(on, { settingsFail: true })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  await $.agent.spawn(spawnInput())
  const lead = (await compose($, ['Agent'])).sections.at(-1)?.text ?? ''

  expect(seen.fetches).toEqual([])
  expect(String(seen.spawned[0]?.description)).toBe('audit auth · sonnet/medium')
  expect(lead).not.toContain('Jev')
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

test('an error status, a malformed body and a thrown fetch keep the model fixed and request medium', ON, async ($, on) => {
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
  expect(seen.notices).toEqual(Array.from({ length: 3 }, () => 'crew:developer -> sonnet · medium'))
  expect(JSON.stringify(seen.logs)).not.toContain(KEY)
  await step($, 'a1', 'xhigh')
  expect(seen.steps).toEqual(['medium'])
})

test('a Jev that does not answer in time leaves the model fixed and requests medium', ON, async ($, on) => {
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

test('at most four Jev calls run at once; the fifth spawn uses medium without another request', ON, async ($, on) => {
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
  const { seen } = jevWorld(on, { reply: async () => ok(answer(3.9)) })
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
    reply: async () => ok(answer(3.9)),
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
    reply: async () => ok(answer(3.9)),
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
  expect(seen.notices).toEqual(['crew:developer -> sonnet · effort unknown (jev; effort high not applied)'])
  expect(seen.logs.some(line => line.includes('effort=unknown'))).toBe(true)
  expect(seen.logs.some(line => line.includes('effort high not applied (stepped)'))).toBe(true)
})

test('a spawn that the host refuses reaches the caller and leaves no effort behind', ON, async ($, on) => {
  const { seen } = jevWorld(on, {
    reply: async () => ok(answer(3.9)),
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

test('a Jev failure pins Claude effort to medium, even when the host sends high or xhigh', ON, async ($, on) => {
  const { seen } = jevWorld(on, {
    // A 400 is not retried, so no timer is waited on.
    reply: async () => ({ status: 400, ok: false, headers: {}, text: '{}' }),
    agents: [{ id: 'a1', type: 'crew:developer', description: 'audit auth' }],
  })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high')
  await step($, 'a1', 'xhigh')

  expect(seen.steps).toEqual(['medium', 'medium'])
  expect(seen.notices).toEqual(['crew:developer -> sonnet · medium'])
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
  const { seen } = jevWorld(on, { reply: async () => ok(answer(3.9)) })
  await $.agent.spawn(spawnInput())

  expect(seen.writes).toHaveLength(1)
  const path = seen.writes[0]?.path ?? ''
  expect(path.startsWith(`${DIR}/`)).toBe(true)
  expect(path).toMatch(/\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-a1\.json$/)
  expect(record(seen)).toMatchObject({
    v: 3, agent: 'developer', requested: 'crew:developer', provider: 'claude', reason: null, quota: { claude: null, codex: null },
    depth: 3.9,
    defaultEffort: 'medium', effortPlanned: 'high', effortApplied: 'high',
    jevModel: 'jev-1.13.0', applied: { effort: true }, outcome: null,
  })
  expect(record(seen).descriptionHash).toMatch(/^[0-9a-f]{8}$/)
  expect(typeof record(seen).durationMs).toBe('number')
})

test('a kept decision is logged too, with nothing applied', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer(1.4)) })
  await $.agent.spawn(spawnInput())

  expect(record(seen)).toMatchObject({
    effortPlanned: 'medium', effortApplied: 'medium', applied: { effort: false },
  })
})

test('an effort that lost the race to the first step is logged as not applied', ON, async ($, on) => {
  const { seen } = jevWorld(on, {
    reply: async () => ok(answer(3.9)),
    spawn: async e => {
      // The subagent steps before the spawn resolves, so the planned effort cannot take.
      await step($, 'a1', 'medium')
      return { model: String(e.model ?? 'default'), agentId: 'a1' }
    },
  })
  await $.agent.spawn(spawnInput())

  expect(record(seen)).toMatchObject({ effortPlanned: 'high', effortApplied: null, applied: { effort: false } })
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
    'effortApplied', 'effortPlanned', 'jevModel', 'outcome', 'provider', 'quota', 'ran', 'reason', 'requested', 'ts', 'v',
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
  expect(seen.notices).toEqual(['crew:developer -> sonnet · high (jev)'])
  expect(seen.logs.some(line => line.includes('decision not logged (write failed)'))).toBe(true)
})

test('calls that are not routed write nothing', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer(0.4)) })
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
  expect(seen.notices).toEqual(['crew:developer -> sonnet · high (jev)'])
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
// the failure (message, body, key) reaches it; the caller requests medium.

test('an error status is logged as its reason and status, and Claude requests medium', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => rejected(401) })
  const result = await $.agent.spawn(spawnInput())

  expect(notRouted(seen)).toEqual(['crew jev: crew:developer not routed (http 401)'])
  expect(seen.fetches).toHaveLength(1)
  expect(result).toMatchObject({ model: 'default', agentId: 'a1' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.notices).toEqual(['crew:developer -> sonnet · medium'])
  expect(record(seen)).toMatchObject({ v: 3, effortPlanned: 'medium', effortApplied: 'medium', jevModel: null })
  await step($, 'a1', 'high')
  expect(seen.steps).toEqual(['medium'])
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
  await step($, 'a1', 'xhigh')
  expect(seen.steps).toEqual(['medium'])
})

test('a deadline that passes is logged as timeout, with no status', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { reply: () => new Promise<Reply>(() => {}) })
  const spawned = $.agent.spawn(spawnInput())
  await clock.settle()
  await pause()
  await clock.advance(3_000)
  await spawned

  expect(notRouted(seen)).toEqual(['crew jev: crew:developer not routed (timeout)'])
  await step($, 'a1', 'xhigh')
  expect(seen.steps).toEqual(['medium'])
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
  await step($, 'a1', 'xhigh')
  expect(seen.steps).toEqual(['medium'])
})

test('a fifth concurrent call is logged as busy at once, and the four in flight as timeout later', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { reply: () => new Promise<Reply>(() => {}) })
  const first = Array.from({ length: 4 }, () => $.agent.spawn(spawnInput()))
  await clock.settle()
  await pause()
  await $.agent.spawn(spawnInput())

  await step($, 'a1', 'high')
  expect(seen.steps).toEqual(['medium'])
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
  await step($, 'a1', 'xhigh')
  expect(seen.steps).toEqual(['medium'])
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
  const { seen } = jevWorld(traced(on, timeline), { reply: async () => ok(answer(3.9)) })
  await $.agent.spawn(spawnInput())

  expect(shape(timeline)).toEqual([
    'fetch',
    'spawn',
    'write',
    'log crew jev: crew:developer depth=3.90 model=sonnet (default) effort=high jev=jev-1.13.0 Nms',
    'notice crew:developer -> sonnet · high (jev)',
  ])
  expect(seen.notices).toEqual(['crew:developer -> sonnet · high (jev)'])
  // Nothing stepped, so the bind that the record carries is the plain one.
  expect(record(seen)).toMatchObject({ bind: 'applied', effortPlanned: 'high', effortApplied: 'high' })
})

test('the effort entry exists before the spawn continues, and its bind is in the record that is written after', ON, async ($, on) => {
  const timeline: string[] = []
  const { seen } = jevWorld(traced(on, timeline), {
    reply: async () => ok(answer(3.9)),
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
    'log crew jev: crew:developer depth=3.90 model=sonnet (default) effort=high jev=jev-1.13.0 Nms',
    'notice crew:developer -> sonnet · high (jev)',
  ])
  expect(record(seen)).toMatchObject({ bind: 'matched', effortPlanned: 'high', effortApplied: 'high' })
})

test('an effort that did not take is announced after the decision write, line by line, and the record says what runs', ON, async ($, on) => {
  const timeline: string[] = []
  const { seen } = jevWorld(traced(on, timeline), {
    reply: async () => ok(answer(3.9)),
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
    'log crew jev: crew:developer depth=3.90 model=sonnet (default) effort=unknown jev=jev-1.13.0 Nms',
    'log crew jev: crew:developer effort high not applied (stepped); its effort is unknown',
    'notice crew:developer -> sonnet · effort unknown (jev; effort high not applied)',
  ])
  expect(record(seen)).toMatchObject({ bind: 'stepped', effortPlanned: 'high', effortApplied: null })
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
    'log crew jev: crew:developer depth=3.90 model=sonnet (default) effort=high jev=jev-1.13.0 Nms',
    'notice crew:developer -> sonnet · high (jev)',
  ])
  expect(resolved).toBe(false)
  await clock.advance(999)
  expect(resolved).toBe(false)

  await clock.advance(1)
  expect(await spawned).toMatchObject({ model: 'default', agentId: 'a1' })
  expect(timeline.at(-1)).toBe('log crew jev: decision write slow')
})

test('a call that Jev failed on logs before the spawn and records and announces medium', ON, async ($, on) => {
  const timeline: string[] = []
  const { seen } = jevWorld(traced(on, timeline), { reply: async () => rejected(401) })
  await $.agent.spawn(spawnInput())

  expect(timeline).toEqual(['fetch', 'log crew jev: crew:developer not routed (http 401)', 'spawn', 'write', 'notice crew:developer -> sonnet · medium'])
  expect(record(seen)).toMatchObject({ effortPlanned: 'medium', jevModel: null })
})

test('a refused spawn that was routed logs, announces and writes nothing', ON, async ($, on) => {
  const timeline: string[] = []
  const { seen } = jevWorld(traced(on, timeline), {
    reply: async () => ok(answer(3.9)),
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

  test(`${tool}: a removed role has no lane, even for former test and review paths`, async ($, on) => {
    guardHost(on)
    for (const path of ['src/app.ts', 'tests/app.test.ts', '.crew/reviews/check.md', '.crew/reviews/../plans/a.md']) {
      expect(await call($, 't1', path)).toEqual({
        deny: `crew:tester is not a crew agent with a known lane, so its write to ${path} was not made`,
      })
    }
  })

  test(`${tool}: other agents, ids the list does not name and the main loop pass; the main loop never reads the list`, async ($, on) => {
    guardHost(on)

    expect(await call($, 'd1', 'src/app.ts')).toEqual({ result: 'written' })
    expect(await call($, 'ghost', 'src/app.ts')).toEqual({ result: 'written' })
    expect(reads.count).toBe(2)

    expect(await call($, undefined, 'src/app.ts')).toEqual({ result: 'written' })
    expect(reads.count).toBe(2)
  })

  for (const failure of ['denied', 'throwing'] as const) {
    test(`${tool}: a ${failure} agent-list check holds subagent writes, while the main loop still passes`, async ($, on) => {
      const written: string[] = []
      on('agent.list', () => {
        if (failure === 'throwing') throw new Error('list unavailable')
        return { deny: 'list unavailable' } as never
      })
      on('tool.call', (_$, e) => (written.push(String((e as { file_path?: unknown }).file_path)), { result: 'written' }))

      expect(await call($, 'a1', 'src/app.ts')).toEqual({ deny: 'crew could not check this write, so it was not made' })
      expect(await call($, 'd1', '.crew/plans/plan.md')).toEqual({ deny: 'crew could not check this write, so it was not made' })
      expect(written).toEqual([])
      expect(await call($, undefined, 'src/app.ts')).toEqual({ result: 'written' })
      expect(written).toEqual(['src/app.ts'])
    })
  }

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

// --- The fixed -codex types ---

const NATIVE_AND_JEV = ON

type Registered = { name: string; model?: string; effort?: string | number; tools?: readonly string[]; prompt: string; description: string }

/** The host beneath the session start with `ANTHROPIC_BASE_URL` as given (unset when `baseUrl` is undefined). */
function nativeWorld(on: On, baseUrl?: string, o: { envFail?: boolean; twinFail?: boolean; failName?: string } = {}) {
  const w = { registered: [] as Registered[], logs: [] as string[], envReads: [] as string[], fetches: [] as string[] }
  mock.clock(on)
  on('env.get', (_$, e) => {
    w.envReads.push(e.name)
    if (o.envFail) throw new Error('env unavailable')
    return { value: e.name === 'ANTHROPIC_BASE_URL' ? baseUrl : e.name === 'HOME' ? HOME : undefined }
  })
  on('http.fetch', (_$, e) => (w.fetches.push(e.url), { value: ok('{}') }))
  on('agent.register', (_$, e) => {
    if ((o.twinFail && e.name.endsWith('-codex')) || e.name === o.failName) throw new Error('secret-token sensitive exception')
    return (w.registered.push(e as Registered), { value: { agent: `crew:${e.name}` } })
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', (_$, e) => (w.logs.push(e.text), { value: undefined }))
  return w
}

const BASES = ['code-reader', 'research', 'designer', 'developer', 'architect']
const TWINS = BASES.map(role => `${role}-codex`)

for (const url of ['https://ai.example.ts.net', 'http://127.0.0.1:41237', 'http://10.0.0.5:41237', 'https://gateway.example.com/v1', 'HTTPS://AI.EXAMPLE.TS.NET']) {
  test(`the -codex types register behind the gateway base URL ${url}, each on its model with its base role's tools and effort`, async ($, on) => {
    const w = nativeWorld(on, url)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

    expect(w.registered.map(a => a.name)).toEqual([...BASES, ...TWINS])
    expect(w.registered.slice(BASES.length).map(a => [a.name, a.model])).toEqual(
      Object.entries(CODEX_MODELS).map(([role, model]) => [`${role}-codex`, model]),
    )
    expect(w.envReads).toEqual(['ANTHROPIC_BASE_URL'])
    expect(w.fetches).toEqual([])
    const by = (name: string) => w.registered.find(a => a.name === name)!
    expect(by('developer-codex')).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium', tools: by('developer').tools, prompt: by('developer').prompt })
    expect(by('architect-codex')).toMatchObject({ model: 'gpt-6-astra', tools: by('architect').tools, prompt: by('architect').prompt })
    expect(w.registered.some(agent => agent.name === 'tester' || agent.name === 'tester-codex')).toBe(false)
    expect(by('architect-codex').tools).not.toContain('Edit')
    expect(by('developer').model).toBe('sonnet')
    expect(by('developer-codex').description).toContain('gpt-6.1-sol')
  })
}

for (const url of [undefined, '', 'https://api.anthropic.com', 'https://API.ANTHROPIC.COM/', 'ftp://gw.example:9', 'localhost:41237', 'not a url']) {
  test(`no -codex type registers with the base URL ${url === undefined ? 'unset' : `"${url}"`}, and one debug line says why`, async ($, on) => {
    const w = nativeWorld(on, url)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

    expect(w.registered.map(a => a.name)).toEqual(BASES)
    expect(w.logs.filter(line => line.includes('Codex twins not registered')).length).toBe(1)
  })
}

test('an env read that fails registers the five specialists and no -codex type', async ($, on) => {
  const w = nativeWorld(on, 'https://ai.example.ts.net', { envFail: true })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(w.registered.map(a => a.name)).toEqual(BASES)
})

test('a -codex type whose registration fails leaves the five specialists registered and the session started', async ($, on) => {
  const w = nativeWorld(on, 'https://ai.example.ts.net', { twinFail: true })
  const started = await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(started).toMatchObject({ cwd: '/proj' })
  expect(w.registered.map(a => a.name)).toEqual(BASES)
})

test('one twin registration failure leaves every other twin and the session intact, without leaking exception text', async ($, on) => {
  const w = nativeWorld(on, 'https://ai.example.ts.net', { failName: 'designer-codex' })
  const started = await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(started).toMatchObject({ cwd: '/proj' })
  expect(w.registered.map(a => a.name)).toEqual([...BASES, ...TWINS.filter(name => name !== 'designer-codex')])
  expect(w.logs).toEqual(['crew: Codex twin crew:designer-codex not registered (registration failed)'])
  expect(w.fetches).toEqual([])
})

test('the -codex section follows the registration: its own section after the lead, only behind a gateway base URL', async ($, on) => {
  nativeWorld(on, 'https://ai.example.ts.net')
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  const composed = await compose($, ['Agent', 'Read'])

  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'crew:lead', 'crew:native-codex'])
  const lead = composed.sections[1]
  const twins = composed.sections[2]
  expect(lead?.text).not.toContain('With quota routing on')
  expect(twins?.scope).toBe('session')
  for (const name of TWINS) expect(twins?.text).toContain(`crew:${name}`)
  expect(twins?.text).toContain('gpt-6-astra')
  expect((await compose($, ['Agent', 'Read'])).sections[2]?.text).toBe(twins?.text)
})

test('no -codex section without a gateway base URL: the request gets the lead section alone', async ($, on) => {
  nativeWorld(on, 'https://api.anthropic.com')
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:lead'])
})

test('no -codex section on a request without the Agent tool, for a teammate or a bare prompt, even behind a gateway URL', async ($, on) => {
  nativeWorld(on, 'https://ai.example.ts.net')
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect((await compose($, ['Read'])).sections).toEqual([])
  expect((await compose($, ['Agent'], ['teammate'])).sections).toEqual([])
  expect((await compose($, ['Agent'], ['bare'])).sections).toEqual([])
})

test('a fresh activation has no -codex section before session.start', async ($, on) => {
  nativeWorld(on, 'https://ai.example.ts.net')
  on('prompt.compose', () => ({ sections: [] }))

  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:lead'])
})

const GATEWAY = { ANTHROPIC_BASE_URL: 'https://ai.example.ts.net' }

/** `jevWorld` with the session started behind a gateway, so the twins are registered and routable. */
async function twinWorld($: Engine, on: On, opts: Parameters<typeof jevWorld>[1] = {}) {
  const world = jevWorld(on, { env: GATEWAY, register: true, ...opts })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  return world
}

test('Jev sizes twin effort without changing either fixed model family', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:architect-codex', tool_use_id: 'tu2' }))

  expect(seen.fetches.length).toBe(2)
  expect(seen.spawned.map(spawned => spawned.subagentType)).toEqual(['crew:developer-codex', 'crew:architect-codex'])
  expect(seen.spawned.map(spawned => spawned.model)).toEqual(['gpt-6.1-sol(high)', 'gpt-6-astra(high)'])
  expect(seen.spawned.map(spawned => spawned.description)).toEqual(['audit auth · gpt-6.1-sol/high', 'audit auth · gpt-6-astra/high'])
})

test('a -codex spawn is routed for its effort: Jev sees the base role, the spawn suffix gets high, the tag and notice name the id', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  const result = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium')

  expect(result).toMatchObject({ model: 'gpt-6.1-sol(high)', agentId: 'a1' })
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6.1-sol/high' })
  expect(seen.spawned[0]?.model).toBe('gpt-6.1-sol(high)')
  expect(JSON.parse(seen.fetches[0]?.body ?? '{}').state.agent).toEqual({ type: 'developer', description: 'audit auth' })
  expect(seen.steps).toEqual(['medium'])
  expect(seen.notices).toEqual(['crew:developer-codex -> gpt-6.1-sol · high (jev)'])
  expect(seen.logs.some(line => line.includes('crew:developer-codex') && line.includes('model=gpt-6.1-sol (default)') && line.includes('effort=high'))).toBe(true)
  expect(JSON.stringify([seen.notices, seen.logs])).not.toContain(KEY)
})

test('a -codex spawn that passes model is refused, so it cannot run on Claude untagged; without model it is routed, and a base role with model is untouched', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: 'opus' }))
  expect(refused).toMatchObject({ deny: expect.stringContaining('without `model`') })
  expect(seen.spawned).toEqual([])
  expect(seen.fetches).toEqual([])

  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', tool_use_id: 'tu2' }))
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6.1-sol/high' })

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

  expect(seen.spawned[0]).toMatchObject({ description: 'audit auth · gpt-6.1-sol/medium' })
  expect(seen.spawned[0]?.model).toBe('gpt-6.1-sol(medium)')
  expect(seen.steps).toEqual(['medium'])
  expect(seen.notices).toEqual(['crew:developer-codex -> gpt-6.1-sol · medium (jev)'])
})

test('a Jev error pins an explicit twin to medium with a suffix, while leaving the host step effort untouched', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6.1-sol', reply: async () => ok('not json') })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'low', 'gpt-6.1-sol(medium)')

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6.1-sol/medium' })
  expect(seen.spawned[0]?.model).toBe('gpt-6.1-sol(medium)')
  expect(seen.steps).toEqual(['low'])
  expect(seen.notices).toEqual(['crew:developer-codex -> gpt-6.1-sol · medium'])
  expect(record(seen)).toMatchObject({ bind: 'suffix', effortApplied: 'medium', applied: { effort: false }, jevModel: null })
  expect(seen.transcript).toEqual(['crew: audit auth: confirmed gpt-6.1-sol · medium'])
})

test('without a jevKey a -codex spawn is untouched: no request, no tag, no settings read, nothing recorded', async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6.1-sol' })
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
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6.1-sol/medium' }))

  expect(JSON.parse(seen.fetches[0]?.body ?? '{}').state.agent.description).toBe('audit auth')
  expect(seen.spawned[0]?.description).toBe('audit auth · gpt-6.1-sol/high')
})

test('the record of a -codex decision keeps effort-only v3 fields and the effort that took', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))

  expect(seen.writes.length).toBe(1)
  const record = JSON.parse(seen.writes[0]?.text ?? '{}')
  expect(record).toMatchObject({
    v: 3, agent: 'developer-codex', requested: 'crew:developer-codex', provider: 'codex', reason: null, defaultEffort: 'medium',
    effortPlanned: 'high', effortApplied: 'high', bind: 'suffix', applied: { effort: true }, ran: null, outcome: null,
  })
  expect(seen.writes[0]?.path).toContain('-a1.json')
  expect(JSON.stringify(record)).not.toContain('audit auth')
})

test('the first step of a routed -codex spawn is confirmed against the id and the effort, in the transcript and the record', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6.1-sol', reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium', 'gpt-6.1-sol(high)')
  await step($, 'a1', 'medium', 'gpt-6.1-sol(high)')

  expect(seen.transcript).toEqual(['jev: audit auth: confirmed gpt-6.1-sol · high'])
  expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'gpt-6.1-sol', effort: 'high' })
})

test('a confirmation accepts the id the proxy reports with an effort suffix', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'GPT-6.1-Sol-high', reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium', 'gpt-6.1-sol(high)')

  expect(seen.transcript).toEqual(['jev: audit auth: confirmed GPT-6.1-Sol-high · high'])
})

test('a -codex run on another model detects the mismatch and distinguishes unobserved effort', NATIVE_AND_JEV, async ($, on) => {
  let model = 'claude-sonnet-5-5'
  const { seen } = await twinWorld($, on, { stepModel: () => model, reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await step($, 'a1', 'medium', 'gpt-6.1-sol(high)')
  expect(seen.transcript).toEqual(['jev: audit auth: ran claude-sonnet-5-5 · high, not gpt-6.1-sol/high'])

  model = 'gpt-6.1-sol-mini'
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', tool_use_id: 'tu2' }))
  await step($, 'a1', null, 'gpt-6.1-sol')
  expect(seen.transcript.at(-1)).toBe('jev: audit auth: ran model gpt-6.1-sol-mini, not gpt-6.1-sol; suffix high requested, effort unobserved')
})

test('a Claude role beside a -codex twin is routed only for effort', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on)
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))

  expect(seen.fetches.length).toBe(2)
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6.1-sol/high' })
  expect(seen.spawned[0]?.model).toBe('gpt-6.1-sol(high)')
  expect(seen.spawned[1]).toMatchObject({ subagentType: 'crew:developer', description: 'audit auth · sonnet/high' })
})

const codexAgents = [
  { id: 'ar1', type: 'crew:architect-codex' },
  { id: 'de1', type: 'crew:developer-codex' },
  { id: 'xx1', type: 'crew:mystery-codex' },
]

for (const tool of ['Write', 'Edit'] as const) {
  test(`${tool}: each -codex twin is held to its base role's lane, and an unknown crew -codex type is held`, async ($, on) => {
    on('agent.list', () => ({ value: codexAgents }) as never)
    on('tool.call', () => ({ result: 'written' }))
    const call = (agentId: string, file_path: string) => $.tool.call({ tool, agentId, file_path } as never)

    expect(await call('ar1', 'src/app.ts')).toHaveProperty('deny')
    expect(await call('ar1', '.crew/plans/plan.md')).toEqual({ result: 'written' })
    expect(await call('de1', 'src/app.ts')).toEqual({ result: 'written' })
    expect(await call('xx1', 'src/app.ts')).toHaveProperty('deny')
    expect(await call('xx1', '.crew/plans/plan.md')).toHaveProperty('deny')
  })
}

// --- Jev on the -codex twins, the gate and the registered set, through the host ---

for (const [depth, effort] of [[2.9, 'medium'], [3.0, 'medium'], [3.5, 'high']] as const) {
  for (const type of ['crew:developer-codex', 'crew:architect-codex']) {
    test(`${type} at depth ${depth} pins its fixed model to ${effort} with a suffix`, NATIVE_AND_JEV, async ($, on) => {
      const { seen } = await twinWorld($, on, { reply: async () => ok(answer(depth)) })
      await $.agent.spawn(spawnInput({ subagentType: type }))
      await step($, 'a1', 'medium')

      const id = type === 'crew:architect-codex' ? 'gpt-6-astra' : 'gpt-6.1-sol'
      expect(seen.spawned[0]?.model).toBe(`${id}(${effort})`)
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
    expect(seen.spawned[0]?.model).toBe('gpt-6-astra(medium)')
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

  expect(seen.spawned[0]?.model).toBe('gpt-6-astra(high)')
  expect(seen.spawned[1]?.model).toBeUndefined()
  expect(seen.spawned[1]?.description).toBe('audit auth · opus/high')
  expect(seen.spawned[2]).toMatchObject({ description: 'audit auth · sonnet/high' })
})

test('an uppercase scheme on a gateway registers the twins and adds their section', async ($, on) => {
  const w = nativeWorld(on, 'HTTPS://AI.EXAMPLE.TS.NET')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(w.registered.map(a => a.name)).toEqual([...BASES, ...TWINS])
})

for (const url of ['ws://ai.example.ts.net', 'file:///gateway', 'https://api.anthropic.com:443']) {
  test(`${url} registers no twin and composes no native section`, async ($, on) => {
    const w = nativeWorld(on, url)
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
    expect(w.registered.map(a => a.name)).toEqual(BASES)
    expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:lead'])
  })
}

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
  expect(seen.spawned[0]?.description).toBe('docs · v2/high · gpt-6.1-sol/high')
  expect(seen.spawned[1]?.description).toBe('docs · v2/high · sonnet/high')
})

// --- Registration drives routing and the native section ---

test('twins refused by the host compose no native section and are not sent to Jev', async ($, on) => {
  const w = nativeWorld(on, 'https://ai.example.ts.net', { twinFail: true })
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(w.registered.map(a => a.name)).toEqual(BASES)
  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:lead'])
  expect(w.logs.filter(line => line.includes('Codex twin crew:') && line.includes('not registered')).length).toBe(TWINS.length)
})

test('before session.start no native section, after it behind a gateway the section lists the twins', async ($, on) => {
  nativeWorld(on, 'https://ai.example.ts.net')
  on('prompt.compose', () => ({ sections: [] }))
  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:lead'])
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  const sections = (await compose($, ['Agent'])).sections
  expect(sections.map(section => section.id)).toEqual(['crew:lead', 'crew:native-codex'])
  for (const name of TWINS) expect(sections[1]?.text).toContain(`crew:${name}`)
  expect(sections[0]?.text).not.toContain('With quota routing on')
})

test('with twins registered, an unregistered twin and a Claude role: one request each for the Claude role and the twin', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:unknown-codex', description: 'find · gpt-6.1-sol/high' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', description: 'fix · gpt-6.1-sol/medium', tool_use_id: 'tu2' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer', description: 'fix · opus/high', tool_use_id: 'tu3' }))

  expect(seen.fetches.length).toBe(2)
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:unknown-codex', description: 'find · gpt-6.1-sol/high' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.spawned[1]?.description).toBe('fix · gpt-6.1-sol/high')
  expect(seen.spawned[1]?.model).toBe('gpt-6.1-sol(high)')
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
  const refused = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: 'gpt-6.1-sol' }))
  expect(refused).toMatchObject({ deny: DENY_TEXT('crew:developer-codex') })
  expect(seen.spawned).toEqual([])
  expect(seen.fetches).toEqual([])
})

test('a -codex spawn with an empty model is not refused: it is routed and tagged as without one', NATIVE_AND_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.5)) })
  const result = await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', model: '' }))
  expect(result).not.toHaveProperty('deny')
  expect(seen.fetches).toHaveLength(1)
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6.1-sol/high' })
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

// --- Quota routing: a specialist call goes to the same role's Codex twin when Codex has more 7-day headroom ---

const MGMT_KEY = ['mgmt-', 'remotesecret0123456789'].join('')
const REMOTE = 'https://cliproxy.example.ts.net'
const QUOTA_ENV = GATEWAY
const Q_NOW = Date.parse('2026-10-12T12:00:00Z')
const QUOTA_OPTIONS = { codexRemote: REMOTE, codexManagementKey: MGMT_KEY }
const QUOTA_JEV = { options: { jevKey: KEY, ...QUOTA_OPTIONS } }
const QUOTA_ONLY = { options: QUOTA_OPTIONS }

const claudeLimits = (five: number, seven: number) => [
  { kind: 'five_hour', percentUsed: five, resetsAt: '2026-10-12T15:00:00.000Z' },
  { kind: 'seven_day', percentUsed: seven, resetsAt: '2026-10-17T00:00:00.000Z' },
]
/** The remote's api-call answer: OpenAI's usage with a Codex 7-day window (and a 5-hour one when given). */
const codexStatus = (seven: number, five?: number): Reply => ok(JSON.stringify({
  status_code: 200,
  body: JSON.stringify({
    rate_limit: {
      ...(five === undefined ? {} : { primary_window: { used_percent: five, limit_window_seconds: 300 * 60, reset_at: Date.parse('2026-10-12T15:00:00Z') / 1000 } }),
      secondary_window: { used_percent: seven, limit_window_seconds: 10080 * 60, reset_at: Date.parse('2026-10-17T00:00:00Z') / 1000 },
    },
  }),
}))

/**
 * The session started behind a gateway with the twins registered, Claude at the given [5h, 7d] and Codex's status as given.
 * Every hook a test needs beneath the plugin is registered here, before the first `$` call. Startup sends no request;
 * the first eligible spawn reads quota.
 */
async function quotaWorld(
  $: Engine,
  on: On,
  o: {
    claude?: [number, number] | null
    status?: () => Promise<Reply>
    world?: Parameters<typeof jevWorld>[1]
    /** The atom cannot be written. */
    quotaWriteFails?: boolean
  } = {},
) {
  const time = { now: Q_NOW }
  const limits = { value: o.claude === null ? [] : claudeLimits(...(o.claude ?? [20, 71])) }
  const atom: { last?: Quota } = {}
  const stateKeys: string[] = []
  const world = jevWorld(on, {
    env: QUOTA_ENV, register: true, now: () => time.now, rateLimits: () => limits.value,
    status: o.status ?? (async () => codexStatus(38)), reply: async () => ok(answer(3.9)), ...o.world,
  })
  // The last value written to the atom: the test engine has no `$.state`.
  on('state.set', (_$, e, next) => {
    stateKeys.push(e.key)
    if (e.key !== 'quota') return next(e)
    if (o.quotaWriteFails) return { deny: 'state unavailable' }
    atom.last = e.value as Quota
    return next(e)
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('prompt.compose', () => ({ sections: [] }))
  on('tool.call', () => ({ result: 'written' }))
  const started = $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await started
  return { ...world, time, limits, atom, stateKeys, started }
}

test('a fresh activation behind a gateway waits for session.start before quota routing or showing twins (reload gap)', QUOTA_ONLY, async ($, on) => {
  const { seen } = jevWorld(on, {
    env: QUOTA_ENV, register: true, now: () => Q_NOW,
    status: async () => codexStatus(38), rateLimits: () => claudeLimits(20, 71),
  })
  on('prompt.compose', () => ({ sections: [] }))
  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:lead'])
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer', description: 'audit auth' })
  expect(seen.statuses).toEqual([])
  expect(seen.fetches).toEqual([])
  expect(seen.settingsReads).toBe(0)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  expect(seen.statuses).toEqual([])
  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:lead', 'crew:native-codex'])
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
  expect(seen.spawned[1]?.subagentType).toBe('crew:developer-codex')
  expect(seen.statuses).toHaveLength(1)
  expect(seen.settingsReads).toBe(2)
})

test('a later session.start clears registered twins even while quota has a fresh cached Codex reading', QUOTA_ONLY, async ($, on) => {
  const { seen, flags } = await quotaWorld($, on)
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]?.subagentType).toBe('crew:developer-codex')
  expect(seen.statuses).toHaveLength(1)

  flags.registerFail = true
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
  expect(seen.spawned[1]).toMatchObject({ subagentType: 'crew:developer', description: 'audit auth' })
  expect(seen.statuses).toHaveLength(1)
  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:lead'])
  // The remote's options were checked once against the repository's settings (project and local).
  expect(seen.settingsReads).toBe(2)
})

test('no registered twins: Jev routes as before, Codex is never asked and the record is v 2 with no readings', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on, { world: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } })
  await $.agent.spawn(spawnInput())

  expect(seen.statuses).toEqual([])
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer', description: 'audit auth · sonnet/high' })
  expect(seen.notices).toEqual(['crew:developer -> sonnet · high (jev)'])
  expect(record(seen)).toMatchObject({ v: 3, agent: 'developer', requested: 'crew:developer', provider: 'claude', reason: null, quota: { claude: null, codex: null } })
})

test('with every twin registration refused, quota is not fetched for a Claude call', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on, { world: { twinFail: () => true } })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:code-reader' }))

  expect(seen.statuses).toEqual([])
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:code-reader' })
})

test('automatic keyless quota routing can switch every fixed-map role while keeping its model family', QUOTA_ONLY, async ($, on) => {
  const { seen } = await quotaWorld($, on)
  for (const [role, model] of Object.entries(CODEX_MODELS)) {
    await $.agent.spawn(spawnInput({ subagentType: `crew:${role}`, tool_use_id: `tu-${role}` }))
    expect(seen.spawned.at(-1)).toMatchObject({ subagentType: `crew:${role}-codex`, description: `audit auth · ${model}/medium` })
    expect(seen.spawned.at(-1)?.model).toBe(`${model}(medium)`)
  }
  expect(seen.statuses).toHaveLength(1)
  expect(seen.fetches).toEqual([])
  expect(seen.settingsReads).toBe(2)
  expect(seen.writes).toEqual([])
})

test('Codex favored: the call becomes the twin, a fixed-model effort suffix is sent, the tag and notice name the provider, the id and the reason', QUOTA_JEV, async ($, on) => {
  const { seen, atom } = await quotaWorld($, on)
  const result = await $.agent.spawn(spawnInput())

  expect(result).toMatchObject({ agentId: 'a1' })
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6.1-sol/high' })
  expect(seen.spawned[0]?.model).toBe('gpt-6.1-sol(high)')
  // Jev is asked about the base role either way.
  expect(JSON.parse(seen.fetches[0]?.body ?? '{}').state.agent).toEqual({ type: 'developer', description: 'audit auth' })
  expect(seen.notices).toEqual(['crew:developer -> Codex (7d 38% used vs Claude 7d 71%) · gpt-6.1-sol · high (jev)'])
  expect(seen.logs).toContain('crew quota: crew:developer -> crew:developer-codex (7d 38% used vs Claude 7d 71%)')
  // The atom shows the same decision the router acted on.
  expect(atom.last?.decision).toEqual({ provider: 'codex', reason: '7d 38% used vs Claude 7d 71%' })
})

test('Codex favored: the record names the type asked for, the provider and both readings, with percentages and times only', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on)
  await $.agent.spawn(spawnInput())

  expect(seen.writes).toHaveLength(1)
  const rec = record(seen)
  expect(rec).toMatchObject({
    v: 3, agent: 'developer-codex', requested: 'crew:developer', provider: 'codex', reason: '7d 38% used vs Claude 7d 71%',
    effortPlanned: 'high', effortApplied: 'high', bind: 'suffix',
    quota: {
      claude: { fiveHour: { percentUsed: 20, resetsAt: '2026-10-12T15:00:00.000Z' }, sevenDay: { percentUsed: 71, resetsAt: '2026-10-17T00:00:00.000Z' } },
      codex: { sevenDay: { percentUsed: 38, resetsAt: '2026-10-17T00:00:00.000Z' } },
    },
  })
})

test('Codex favored: Jev sizes effort while the twin model stays fixed', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on, { world: { reply: async () => ok(answer(3.5)) } })
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6.1-sol/high' })
  expect(seen.spawned[0]?.model).toBe('gpt-6.1-sol(high)')
})

test('Codex favored: the twin\'s first step, sent before the spawn resolves, already has the suffix without an effort-book bind', QUOTA_JEV, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const { seen } = await quotaWorld($, on, {
    world: {
      // The host lists the agent as it started: the twin's type and the tagged description.
      agents: [{ id: 'a1', type: 'crew:developer-codex', description: 'audit auth · gpt-6.1-sol/high' }],
      spawn: async () => { await held; return { model: 'default', agentId: 'a1' } },
    },
  })
  const spawned = $.agent.spawn(spawnInput())
  while (seen.spawned.length === 0) await pause()
  await step($, 'a1', 'medium')
  release()
  await spawned
  await step($, 'a1', 'medium')

  expect(seen.steps).toEqual(['medium', 'medium'])
  expect(seen.spawned[0]?.model).toBe('gpt-6.1-sol(high)')
  expect(record(seen)).toMatchObject({ bind: 'suffix', effortApplied: 'high' })
})

test('Codex favored: the first step is confirmed against the twin\'s id and effort', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on, { world: { stepModel: 'gpt-6.1-sol' } })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium', 'gpt-6.1-sol(high)')

  expect(seen.transcript).toEqual(['jev: audit auth: confirmed gpt-6.1-sol · high'])
  expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'gpt-6.1-sol', effort: 'high' })
})

test('Codex favored: a twin step without effort stays absent, and later steps need no effort rewrite', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on)
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]?.subagentType).toBe('crew:developer-codex')

  await step($, 'a1', null)
  await step($, 'a1', 'medium')

  expect(seen.steps).toEqual([undefined, 'medium'])
  expect(seen.spawned[0]?.model).toBe('gpt-6.1-sol(high)')
})

test('Codex favored: a role switched to its twin keeps the twin\'s write lane', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on, { world: { agents: [{ id: 'a1', type: 'crew:architect-codex', description: 'audit auth · gpt-6-astra/high' }] } })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:architect' }))
  const write = (file_path: string) => $.tool.call({ tool: 'Write', agentId: 'a1', file_path } as never)

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:architect-codex' })
  expect(await write('src/app.ts')).toHaveProperty('deny')
  expect(await write('.crew/reviews/check.md')).not.toHaveProperty('deny')
})

test('Claude favored: Codex is read and the call goes on as without the feature, notice included', QUOTA_JEV, async ($, on) => {
  const { seen, atom } = await quotaWorld($, on, { claude: [20, 40], status: async () => codexStatus(38) })
  await $.agent.spawn(spawnInput())

  expect(seen.statuses).toHaveLength(1)
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer', description: 'audit auth · sonnet/high' })
  expect(seen.notices).toEqual(['crew:developer -> sonnet · high (jev)'])
  expect(record(seen)).toMatchObject({ agent: 'developer', requested: 'crew:developer', provider: 'claude', reason: '7d 40% used vs Codex 7d 38%' })
  expect(atom.last?.decision.provider).toBe('claude')
})

const UNCERTAIN: [string, () => Promise<Reply>][] = [
  ['no limits yet', async () => ok(JSON.stringify({ status_code: 200, body: JSON.stringify({ rate_limit: {} }) }))],
  ['an envelope without a body', async () => ok(JSON.stringify({ status_code: 200 }))],
  ['a usage call OpenAI refused', async () => ok(JSON.stringify({ status_code: 401, body: '{}' }))],
  ['an error status', async () => rejected(500)],
  ['a body that is no JSON', async () => ok('not json')],
  ['a fetch that throws', async () => { throw new Error('ECONNREFUSED') }],
  ['a 5-hour window at the veto and a low 7-day', async () => codexStatus(5, 95)],
]
for (const [label, status] of UNCERTAIN) {
  test(`Codex unknown, down or stale (${label}): the call stays on Claude, as Jev sized it`, QUOTA_JEV, async ($, on) => {
    const { seen } = await quotaWorld($, on, { status })
    await $.agent.spawn(spawnInput())

    expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer', description: 'audit auth · sonnet/high' })
    expect(seen.notices).toEqual(['crew:developer -> sonnet · high (jev)'])
    expect(record(seen)).toMatchObject({ provider: 'claude', requested: 'crew:developer' })
  })
}

test('no Claude plan limits (API billing): the call stays on Claude', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on, { claude: null })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer' })
})

test('a remote that never answers fails open at the deadline: the spawn goes on, on Claude, and the read under way is not repeated', QUOTA_JEV, async ($, on) => {
  let asked = 0
  const world = await quotaWorld($, on, { status: () => { asked++; return new Promise<Reply>(() => {}) } })
  const { atom } = world
  expect(asked).toBe(0)
  const spawned = $.agent.spawn(spawnInput())
  // The first eligible spawn waits only until the deadline.
  await world.clock.settle()
  await pause()
  await world.clock.advance(1_500)
  await spawned
  expect(asked).toBe(1)
  expect(atom.last?.codexState).toBe('unknown')
  expect(world.seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer' })

  // The read is still under way: the next spawn waits for it again, but asks nothing new.
  const again = $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
  await world.clock.settle()
  await pause()
  await world.clock.advance(1_500)
  await again
  expect(asked).toBe(1)
  expect(world.seen.spawned[1]).toMatchObject({ subagentType: 'crew:developer' })
})

test('a read that answers after its deadline is applied by the next spawn, without asking again', QUOTA_JEV, async ($, on) => {
  let release: (reply: Reply) => void = () => {}
  let asked = 0
  const world = await quotaWorld($, on, { status: () => { asked++; return new Promise<Reply>(resolve => { release = resolve }) } })
  const spawned = $.agent.spawn(spawnInput())
  await world.clock.settle()
  await pause()
  await world.clock.advance(1_500)
  await spawned
  expect(world.seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer' })

  release(codexStatus(38))
  await pause()
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
  expect(world.seen.spawned[1]).toMatchObject({ subagentType: 'crew:developer-codex' })
  expect(asked).toBe(1)
  expect(world.atom.last?.codexState).toBe('ok')
})

test('a read that fails after its deadline is dropped, so the next spawn reads again', QUOTA_JEV, async ($, on) => {
  let release: (reply: Reply) => void = () => {}
  let asked = 0
  const world = await quotaWorld($, on, { status: () => { asked++; return asked === 1 ? new Promise<Reply>(resolve => { release = resolve }) : Promise.resolve(codexStatus(38)) } })
  const spawned = $.agent.spawn(spawnInput())
  await world.clock.settle()
  await pause()
  await world.clock.advance(1_500)
  await spawned

  release({ status: 500, ok: false, headers: {}, text: '' })
  await pause()
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
  expect(asked).toBe(2)
  expect(world.seen.spawned[1]).toMatchObject({ subagentType: 'crew:developer-codex' })
})

test('a good reading is cached for five minutes and read again after them', QUOTA_JEV, async ($, on) => {
  const world = await quotaWorld($, on)
  await $.agent.spawn(spawnInput())
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
  expect(world.seen.statuses).toHaveLength(1)

  world.time.now += 61_000
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu3' }))
  expect(world.seen.statuses).toHaveLength(1)

  world.time.now += 5 * 60_000
  world.limits.value = claudeLimits(20, 40)
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu4' }))
  expect(world.seen.statuses).toHaveLength(2)
  expect(world.seen.credentials).toHaveLength(2)
})

test('startup asks the remote nothing; the first eligible spawn reads Codex and sends the management key to the remote only', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on)
  expect([seen.credentials, seen.statuses]).toEqual([[], []])
  await $.agent.spawn(spawnInput())
  const bearer = { Authorization: `Bearer ${MGMT_KEY}`, Accept: 'application/json' }
  expect(seen.credentials).toEqual([{ url: `${REMOTE}/v8/management/credentials`, headers: bearer }])
  expect(seen.statuses).toHaveLength(1)
  expect(seen.statuses[0]?.url).toBe(`${REMOTE}/v8/management/requests/api-call`)
  expect(seen.statuses[0]?.headers).toEqual({ ...bearer, 'Content-Type': 'application/json' })
  expect(JSON.parse(seen.statuses[0]?.body ?? '{}')).toEqual({
    auth_index: 'acct-1', method: 'GET', url: 'https://chatgpt.com/backend-api/wham/usage', header: { Authorization: 'Bearer $TOKEN$' },
  })
  await $.agent.spawn(spawnInput())
  expect(seen.statuses).toHaveLength(1)
  // Jev's request carries the Jev key and never the management key.
  expect(JSON.stringify(seen.fetches)).not.toContain(MGMT_KEY)
})

test('the management key reaches no notice, log, record, transcript or atom', QUOTA_JEV, async ($, on) => {
  const { seen, atom } = await quotaWorld($, on, { world: { stepModel: 'gpt-6.1-sol' } })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium')
  const sayings = JSON.stringify([seen.notices, seen.logs, seen.writes, seen.transcript, seen.spawned, atom.last])

  expect(sayings).not.toContain(MGMT_KEY)
  expect(sayings).not.toContain(REMOTE)
  expect(sayings).not.toContain(KEY)
})

test('calls that may not move are untouched and ask Codex nothing more: explicit model, fork, workflow agent, teammate, a twin the lead named, another plugin\'s type', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on)
  const before = seen.statuses.length
  await $.agent.spawn(spawnInput({ model: 'haiku', tool_use_id: 'a' }))
  await $.agent.spawn(spawnInput({ fork: true, tool_use_id: 'b' }))
  await $.agent.spawn(spawnInput({ workflow: { runId: 'wf_1', agentIndex: 1 }, tool_use_id: 'c' }))
  await $.agent.spawn(spawnInput({ isTeammate: true, tool_use_id: 'd' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', tool_use_id: 'e' }))
  await $.agent.spawn(spawnInput({ subagentType: 'acme:developer', tool_use_id: 'f' }))

  expect(seen.statuses).toHaveLength(before)
  expect(seen.spawned.map(spawned => spawned.subagentType)).toEqual([
    'crew:developer', 'crew:developer', 'crew:developer', 'crew:developer', 'crew:developer-codex', 'acme:developer',
  ])
  expect(seen.spawned[0]).toMatchObject({ model: 'haiku', description: 'audit auth' })
  expect(seen.spawned[3]?.description).toContain('audit auth')
})

test('a role without a registered twin is untouched, though Codex favors the others', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on, { world: { twinFail: name => name === 'designer-codex' } })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:designer' }))
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer', tool_use_id: 'tu2' }))

  expect(seen.spawned.map(spawned => spawned.subagentType)).toEqual(['crew:designer', 'crew:developer-codex'])
})

test('twins that were not registered (the base URL is Anthropic\'s API) leave every call on Claude and Codex unasked', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on, { world: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } })
  await $.agent.spawn(spawnInput())

  expect(seen.statuses).toEqual([])
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer' })
})

test('without the remote options quota routing is off: Codex is never asked, the call is sized by Jev alone and the sections name no quota routing', ON, async ($, on) => {
  const { seen, atom } = await quotaWorld($, on)
  await $.agent.spawn(spawnInput())

  expect(seen.statuses).toEqual([])
  expect(seen.credentials).toEqual([])
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer', description: 'audit auth · sonnet/high' })
  expect(seen.logs.filter(line => line.startsWith('crew quota'))).toEqual([])
  expect(atom.last?.codexState ?? 'off').toBe('off')
  const sections = (await compose($, ['Agent'])).sections
  expect(sections.map(section => section.id)).toEqual(['crew:lead', 'crew:native-codex'])
  for (const section of sections) expect(section.text).not.toContain('quota routing on')
})

for (const source of ['project', 'local'] as const) {
  test(`a codexRemote the ${source} settings declare keeps the key home: Codex is not asked`, QUOTA_JEV, async ($, on) => {
    const declared = { pluginConfigs: { crew: { options: { codexRemote: 'https://attacker.example' } } } }
    const { seen, atom } = await quotaWorld($, on, { world: { [source]: declared } })
    await $.agent.spawn(spawnInput())

    expect(seen.credentials).toEqual([])
    expect(seen.statuses).toEqual([])
    expect(seen.logs).toContain('crew quota: Codex not asked (the repository settings declare codexRemote or codexManagementKey (set them in user settings))')
    expect(atom.last?.codexState).toBe('unknown')
  })
}

test('a remote with no single active Codex account is not asked for usage: unknown, so Claude', QUOTA_JEV, async ($, on) => {
  const two = async () => ok(JSON.stringify({ files: [{ type: 'codex', status: 'active', auth_index: 'a' }, { type: 'codex', status: 'active', auth_index: 'b' }] }))
  const { seen, atom } = await quotaWorld($, on, { world: { credentials: two } })
  await $.agent.spawn(spawnInput())

  expect(seen.credentials).toHaveLength(1)
  expect(seen.statuses).toEqual([])
  expect(seen.logs).toContain('crew quota: Codex not asked (the remote has no single active Codex account)')
  expect(atom.last?.codexState).toBe('unknown')
})

test('a quota read that fails (the atom cannot be written) never blocks the spawn: it stays on Claude', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on, { quotaWriteFails: true })
  const result = await $.agent.spawn(spawnInput())

  expect(result).toMatchObject({ agentId: 'a1' })
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer', description: 'audit auth · sonnet/high' })
  expect(seen.logs).toContain('crew quota: not read, the call stays on Claude')
})

test('a session.usage that fails, or reports nothing, keeps the last Claude reading and still decides', QUOTA_JEV, async ($, on) => {
  const world = await quotaWorld($, on)
  const { atom } = world
  await $.agent.spawn(spawnInput())
  expect(atom.last?.claude?.sevenDay?.percentUsed).toBe(71)

  world.limits.value = []
  world.time.now += 61_000
  const result = await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
  const quota = atom.last
  expect(result).toMatchObject({ agentId: 'a1' })
  expect(quota?.claude?.sevenDay?.percentUsed).toBe(71)
  expect(quota?.claudeAt).toBe(Q_NOW)
  expect(world.seen.spawned[1]).toMatchObject({ subagentType: 'crew:developer-codex' })
})

test('session.measure keeps the last non-empty Claude reading and stamps when it was taken; an empty one changes nothing', QUOTA_JEV, async ($, on) => {
  const world = await quotaWorld($, on, { claude: null })
  const { atom } = world
  const measure = (rateLimits: unknown[]) => $.session.measure({ context: { window: 100 }, rateLimits, changed: ['rateLimits'] } as never)

  expect(atom.last).toBeUndefined()
  await $.agent.spawn(spawnInput())
  expect(atom.last?.claude).toBeNull()
  world.time.now = Q_NOW + 5_000
  await measure(claudeLimits(30, 60))
  expect(atom.last).toMatchObject({ claude: { fiveHour: { percentUsed: 30 }, sevenDay: { percentUsed: 60 } }, claudeAt: Q_NOW + 5_000 })

  world.time.now = Q_NOW + 9_000
  await measure([])
  expect(atom.last).toMatchObject({ claude: { sevenDay: { percentUsed: 60 } }, claudeAt: Q_NOW + 5_000 })
  // The decision follows the readings: Codex at 38 against Claude at 60 is 22 points apart.
  expect(atom.last?.decision.provider).toBe('codex')
})

test('with no registered twins session.measure still keeps the Claude reading, and Codex stays off', QUOTA_JEV, async ($, on) => {
  const world = await quotaWorld($, on, { claude: null, world: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } })
  const { atom } = world
  world.time.now = Q_NOW
  await $.session.measure({ context: { window: 100 }, rateLimits: claudeLimits(30, 60), changed: ['rateLimits'] } as never)

  expect(atom.last).toMatchObject({ claude: { sevenDay: { percentUsed: 60 } }, codex: null, codexState: 'off', decision: { provider: 'claude', reason: 'routing off or no Codex twin' } })
  expect(world.seen.statuses).toEqual([])
})

test('without a jevKey the switch still happens: tagged with the default effort, noticed, confirmed, with no Jev request and no record', QUOTA_ONLY, async ($, on) => {
  const { seen } = await quotaWorld($, on, { world: { stepModel: 'gpt-6.1-sol' } })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium', 'gpt-6.1-sol(medium)')

  expect(seen.fetches).toEqual([])
  // Only the remote's trust check reads settings: no Jev key is resolved.
  expect(seen.settingsReads).toBe(2)
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6.1-sol/medium' })
  expect(seen.spawned[0]?.model).toBe('gpt-6.1-sol(medium)')
  expect(seen.notices).toEqual(['crew:developer -> Codex (7d 38% used vs Claude 7d 71%) · gpt-6.1-sol · medium'])
  expect(seen.transcript).toEqual(['quota: audit auth: confirmed gpt-6.1-sol · medium'])
  expect(seen.writes).toEqual([])
})

test('without a jevKey and with Claude favored (or Codex unknown) a call is untouched: no tag, no notice, no request', QUOTA_ONLY, async ($, on) => {
  const { seen } = await quotaWorld($, on, { claude: [20, 40] })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer', description: 'audit auth' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.notices).toEqual([])
  expect(seen.fetches).toEqual([])
  expect(seen.settingsReads).toBe(2)
})

test('a switched call that Jev could not size is still switched, on the twin\'s defaults, and recorded', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on, { world: { reply: async () => rejected(401) } })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6.1-sol/medium' })
  expect(seen.spawned[0]?.model).toBe('gpt-6.1-sol(medium)')
  expect(seen.notices).toEqual(['crew:developer -> Codex (7d 38% used vs Claude 7d 71%) · gpt-6.1-sol · medium'])
  expect(record(seen)).toMatchObject({ provider: 'codex', requested: 'crew:developer', durationMs: 0, jevModel: null })
})

test('a description tag copied from a task is stripped before the switch and the call is tagged once for the twin', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on)
  await $.agent.spawn(spawnInput({ description: 'audit auth · opus/medium' }))

  expect(JSON.parse(seen.fetches[0]?.body ?? '{}').state.agent.description).toBe('audit auth')
  expect(seen.spawned[0]?.description).toBe('audit auth · gpt-6.1-sol/high')
})

test('a twin the lead named is never moved, even with Claude favored, and still gets its own Jev effort', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on, { claude: [10, 10], world: { reply: async () => ok(answer(3.5)) } })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', description: 'audit auth · gpt-6.1-sol/high' })
  expect(seen.notices).toEqual(['crew:developer-codex -> gpt-6.1-sol · high (jev)'])
  expect(record(seen)).toMatchObject({ requested: 'crew:developer-codex', provider: 'codex' })
})

test('a refused spawn of a switched call announces and records nothing, and leaves no effort behind', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on, { world: { spawn: async () => ({ deny: 'no' }) as never } })
  const result = await $.agent.spawn(spawnInput())

  expect(result).toMatchObject({ deny: 'no' })
  expect(seen.notices).toEqual([])
  expect(seen.writes).toEqual([])
})

test('the lead and twin sections name automatic quota routing whenever twins and the remote options are set', QUOTA_JEV, async ($, on) => {
  await quotaWorld($, on)
  const composed = await compose($, ['Agent'])
  expect(composed.sections.map(section => section.id)).toEqual(['crew:lead', 'crew:native-codex'])
  expect(composed.sections[0]?.text).toContain('With quota routing on')
  expect(composed.sections[1]?.text).toContain('more weekly headroom than Claude')
})

test('the lead section stays free of Codex when quota routing is on but no twin registered', QUOTA_JEV, async ($, on) => {
  await quotaWorld($, on, { world: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } })
  const composed = await compose($, ['Agent'])

  expect(composed.sections.map(section => section.id)).toEqual(['crew:lead'])
  expect(composed.sections[0]?.text.toLowerCase()).not.toContain('codex')
  expect(composed.sections[0]?.text).not.toContain('quota routing')
})

test('startup, routing, confirmation and measurement use only quota state and no presentation or persistent-choice APIs', QUOTA_JEV, async ($, on) => {
  const unexpected: string[] = []
  on('store.get', () => (unexpected.push('store.get'), { value: undefined }))
  on('store.set', () => (unexpected.push('store.set'), { value: undefined }))
  on('ui.open', () => (unexpected.push('ui.open'), { value: { isPlaced: false } }) as never)
  on('ui.close', () => (unexpected.push('ui.close'), { value: undefined }))
  const world = await quotaWorld($, on, { world: { stepModel: 'gpt-6.1-sol' } })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium', 'gpt-6.1-sol(high)')
  world.time.now = Q_NOW + 5_000
  await $.session.measure({ context: { window: 100 }, rateLimits: claudeLimits(30, 60), changed: ['rateLimits'] } as never)

  expect(unexpected).toEqual([])
  expect(world.stateKeys.length).toBeGreaterThan(0)
  expect([...new Set(world.stateKeys)]).toEqual(['quota'])
  expect(world.atom.last).toMatchObject({ claude: { sevenDay: { percentUsed: 60 } }, claudeAt: Q_NOW + 5_000 })
  expect(world.seen.spawned[0]?.subagentType).toBe('crew:developer-codex')
  expect(world.seen.transcript).toEqual(['jev: audit auth: confirmed gpt-6.1-sol · high'])
})

test('a call that could move to its twin and stays on Claude says why in one debug line; a switch and a role without a twin do not', QUOTA_JEV, async ($, on) => {
  const { seen, limits } = await quotaWorld($, on, { claude: [20, 40], world: { twinFail: name => name === 'designer-codex' } })
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer' })
  expect(seen.logs.filter(line => line.startsWith('crew quota:'))).toEqual(['crew quota: crew:developer stays on Claude (7d 40% used vs Codex 7d 38%)'])

  await $.agent.spawn(spawnInput({ subagentType: 'crew:designer', tool_use_id: 'tu2' }))
  limits.value = claudeLimits(20, 71)
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu3' }))
  expect(seen.spawned[2]).toMatchObject({ subagentType: 'crew:developer-codex' })
  expect(seen.logs.filter(line => line.startsWith('crew quota:'))).toEqual([
    'crew quota: crew:developer stays on Claude (7d 40% used vs Codex 7d 38%)',
    'crew quota: crew:developer -> crew:developer-codex (7d 38% used vs Claude 7d 71%)',
  ])
})

test('a switched call without a key says once that no record was written, not again at its confirmation', QUOTA_ONLY, async ($, on) => {
  const { seen } = await quotaWorld($, on, { world: { stepModel: 'gpt-6.1-sol' } })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium', 'gpt-6.1-sol(medium)')

  expect(seen.transcript).toEqual(['quota: audit auth: confirmed gpt-6.1-sol · medium'])
  // Jev is off: the line names quota routing, which decided the call.
  expect(seen.logs.filter(line => line.includes('no trusted home'))).toEqual(['crew quota: decision not logged (no trusted home)'])
  expect(seen.writes).toEqual([])
})

for (const model of ['gpt-6.1-sol(medium)', 'gpt-6.1-sol(high)']) {
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
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6.1-sol:high' })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
  // An API-reported suffix alone cannot establish outgoing effort.
  await step($, 'a1', null, 'gpt-6.1-sol')
  expect(seen.transcript).toEqual(['jev: audit auth: confirmed model gpt-6.1-sol:high; suffix high requested, effort unobserved'])
  expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'gpt-6.1-sol:high', effort: null })
  expect(record(seen)).toMatchObject({ bind: 'suffix', effortApplied: 'high', applied: { effort: true } })
})

for (const effort of ['medium', 'high']) {
  test(`a visible outgoing twin model without a suffix records the observed step effort ${effort}`, NATIVE_AND_JEV, async ($, on) => {
    const { seen } = await twinWorld($, on, { stepModel: 'gpt-6.1-sol' })
    await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
    await step($, 'a1', effort, 'gpt-6.1-sol')
    expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'gpt-6.1-sol', effort })
    expect(seen.transcript[0]).toBe(effort === 'high'
      ? 'jev: audit auth: confirmed gpt-6.1-sol · high'
      : 'jev: audit auth: ran gpt-6.1-sol · medium, not gpt-6.1-sol/high')
  })
}

for (const untrusted of [{ jevKey: 'bad key' }, { jevKey: KEY, repositoryKey: true }]) {
  test(`an explicit twin with ${untrusted.repositoryKey ? 'a repository-declared' : 'an invalid'} key gets the medium fallback`, { options: { jevKey: untrusted.jevKey } }, async ($, on) => {
    const { seen } = await twinWorld($, on, untrusted.repositoryKey ? { project: { pluginConfigs: { crew: { options: { jevKey: 'repo-key' } } } } } : {})
    await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
    expect(seen.spawned[0]).toMatchObject({ description: 'audit auth · gpt-6.1-sol/medium', subagentType: 'crew:developer-codex' })
    expect(seen.spawned[0]?.model).toBe('gpt-6.1-sol(medium)')
    expect(seen.fetches).toEqual([])
    expect(seen.notices).toEqual(['crew:developer-codex -> gpt-6.1-sol · medium'])
  })
}

test('an explicit twin teammate keeps the same Jev effort-only routing, without a quota switch', QUOTA_JEV, async ($, on) => {
  const { seen } = await quotaWorld($, on)
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', isTeammate: true }))
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', model: 'gpt-6.1-sol(high)' })
  expect(seen.statuses).toEqual([])
  expect(seen.fetches).toHaveLength(1)
})

for (const effort of ['medium', 'high']) {
  test(`an observed outgoing twin suffix ${effort} takes precedence over the opposite host effort`, NATIVE_AND_JEV, async ($, on) => {
    const { seen } = await twinWorld($, on, { stepModel: 'gpt-6.1-sol-20261012' })
    await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
    await step($, 'a1', effort === 'high' ? 'medium' : 'high', `gpt-6.1-sol(${effort})`)
    expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'gpt-6.1-sol-20261012', effort })
    expect(seen.transcript[0]).toBe(effort === 'high'
      ? 'jev: audit auth: confirmed gpt-6.1-sol-20261012 · high'
      : 'jev: audit auth: ran gpt-6.1-sol-20261012 · medium, not gpt-6.1-sol/high')
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
      spawn: async () => { await heldSpawn; return { model: 'gpt-6.1-sol(high)', agentId: 'a1' } },
      stepModel: 'gpt-6.1-sol',
      stepWait: async () => { if (overlap) await heldStep },
    })
    const spawning = $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' }))
    while (seen.spawned.length === 0) await pause()
    const first = step($, 'a1', 'medium', 'gpt-6.1-sol(high)')
    if (!overlap) await first
    releaseSpawn()
    await spawning
    releaseStep()
    await first
    await step($, 'a1', 'medium', 'gpt-6.1-sol(high)')
    expect(seen.spawned[0]?.model).toBe('gpt-6.1-sol(high)')
    expect(record(seen)).toMatchObject({ bind: 'suffix', effortApplied: 'high', applied: { effort: true } })
    expect(seen.transcript).toEqual(['jev: audit auth: confirmed gpt-6.1-sol · high'])
    expect(JSON.parse(seen.writes[1]?.text ?? '{}').ran).toEqual({ model: 'gpt-6.1-sol', effort: 'high' })
  })
}

for (const throws of [false, true]) {
  test(`an explicit twin spawn that ${throws ? 'throws' : 'is refused'} records no suffix success`, NATIVE_AND_JEV, async ($, on) => {
    const { seen } = await twinWorld($, on, { spawn: async () => {
      if (throws) throw new Error('spawn failed')
      return { deny: 'no' } as never
    } })
    try { await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex' })) } catch { /* The host refused the spawn. */ }
    expect(seen.spawned[0]?.model).toBe('gpt-6.1-sol(high)')
    expect([seen.notices, seen.writes, seen.transcript]).toEqual([[], [], []])
  })
}

for (const type of ['crew:tester', 'crew:tester-codex', 'crew:tester-extra']) {
  test(`removed type ${type} is not routed and asks neither Jev nor quota`, QUOTA_JEV, async ($, on) => {
    const { seen } = await quotaWorld($, on)
    await $.agent.spawn(spawnInput({ subagentType: type }))
    await $.agent.spawn(spawnInput({ subagentType: type, model: 'opus', tool_use_id: 'tu2' }))
    expect(seen.spawned.map(spawned => [spawned.subagentType, spawned.model, spawned.description])).toEqual([
      [type, undefined, 'audit auth'], [type, 'opus', 'audit auth'],
    ])
    expect([seen.statuses, seen.fetches, seen.notices, seen.writes]).toEqual([[], [], [], []])
  })
  for (const tool of ['Write', 'Edit'] as const) {
    test(`${tool}: removed type ${type} is held on source, tests and reviews, without screening Bash`, async ($, on) => {
      on('agent.list', () => ({ value: [{ id: 'old', type }] }) as never)
      on('tool.call', () => ({ result: 'ran' }))
      for (const file_path of ['src/app.ts', 'tests/app.test.ts', '.crew/reviews/check.md']) {
        expect(await $.tool.call({ tool, agentId: 'old', file_path } as never)).toHaveProperty('deny')
      }
      expect(await $.tool.call({ tool: 'Bash', agentId: 'old', command: 'ls' } as never)).toEqual({ result: 'ran' })
    })
  }
}

for (const config of ['invalid-key', 'repository-key', 'settings-failure'] as const) {
  test(`Jev config failure ${config} explicitly pins Claude effort to medium`, { options: { jevKey: config === 'invalid-key' ? 'bad key' : KEY } }, async ($, on) => {
    const { seen } = jevWorld(on, {
      ...(config === 'repository-key' ? { project: declared('crew@inline') } : {}),
      settingsFail: config === 'settings-failure',
      stepModel: 'claude-sonnet-5-5',
    })
    await $.agent.spawn(spawnInput())
    await step($, 'a1', 'xhigh')
    expect(seen.fetches).toEqual([])
    expect(seen.spawned[0]?.model).toBeUndefined()
    expect(seen.steps).toEqual(['medium'])
    expect(seen.transcript).toEqual(['crew: audit auth: confirmed claude-sonnet-5-5 · medium'])
  })
}

test('a failed Jev spawn cannot change effort after the agent has already stepped', ON, async ($, on) => {
  const { seen } = jevWorld(on, {
    reply: async () => rejected(401),
    spawn: async () => {
      await step($, 'a1', 'high')
      return { model: 'default', agentId: 'a1' }
    },
  })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'xhigh')
  expect(seen.steps).toEqual(['high', 'xhigh'])
  expect(record(seen)).toMatchObject({ bind: 'stepped', effortPlanned: 'medium', effortApplied: null })
  expect(seen.notices).toEqual(['crew:developer -> sonnet · effort unknown (crew; effort medium not applied)'])
})

for (const [role, model] of [['code-reader', 'haiku'], ['research', 'haiku'], ['designer', 'sonnet'], ['developer', 'sonnet'], ['architect', 'opus']] as const) {
  test(`Jev never supplies a model for Claude role ${role}`, ON, async ($, on) => {
    const { seen } = jevWorld(on)
    await $.agent.spawn(spawnInput({ subagentType: `crew:${role}` }))
    expect(seen.spawned[0]?.subagentType).toBe(`crew:${role}`)
    expect(seen.spawned[0]?.model).toBeUndefined()
    expect(seen.spawned[0]?.description).toBe(`audit auth · ${model}/high`)
  })
}

for (const reverse of [false, true]) {
  test(`concurrent medium answer and fallback do not exchange apply policies (${reverse ? 'reverse' : 'forward'} first steps)`, ON, async ($, on) => {
    let fetched = 0
    let spawned = 0
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const { seen } = jevWorld(on, {
      reply: async () => fetched++ === 0 ? ok(answer(1.4)) : rejected(401),
      agents: [
        { id: 'a1', type: 'crew:developer', description: 'audit auth · sonnet/medium' },
        { id: 'a2', type: 'crew:developer', description: 'audit auth · sonnet/medium' },
      ],
      spawn: async () => { const agentId = `a${++spawned}`; await held; return { model: 'default', agentId } },
    })
    const first = $.agent.spawn(spawnInput())
    while (seen.spawned.length < 1) await pause()
    const second = $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
    while (seen.spawned.length < 2) await pause()
    const order = reverse ? ['a2', 'a1'] : ['a1', 'a2']
    for (const id of order) await step($, id, 'xhigh')
    release()
    await Promise.all([first, second])
    for (const id of order) await step($, id, 'xhigh')
    // The host gives no safe identity between pending calls with identical tags and different apply policies.
    // Both remain unchanged, rather than assigning one call's fallback to the other; no late bind may repair it.
    expect(seen.steps).toEqual(['xhigh', 'xhigh', 'xhigh', 'xhigh'])
    expect(record(seen, 1)).toMatchObject({ bind: 'stepped', effortPlanned: 'medium', effortApplied: null })
    expect(seen.notices[1]).toBe('crew:developer -> sonnet · effort unknown (crew; effort medium not applied)')
  })
}

test('a resumed high agent reports its fixed effort when the medium fallback cannot apply', ON, async ($, on) => {
  let failing = false
  const { seen } = jevWorld(on, {
    reply: async () => failing ? rejected(401) : ok(answer(3.9)),
    stepModel: 'claude-sonnet-5-5',
  })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium')
  failing = true
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
  await step($, 'a1', 'medium')
  expect(seen.steps).toEqual(['high', 'high'])
  expect(seen.notices[1]).toBe('crew:developer -> sonnet · high (crew; effort medium not applied)')
  expect(record(seen, 2)).toMatchObject({ bind: 'known', effortPlanned: 'medium', effortApplied: 'high', applied: { effort: true }, ran: null })
  expect(record(seen, 3)).toMatchObject({ effortPlanned: 'medium', effortApplied: 'high', ran: { effort: 'high' } })
})
