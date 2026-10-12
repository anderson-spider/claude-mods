import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fnv1a } from '../hooks/decisions'
import { missingPlan } from '../hooks/register'
import { CODEX_MODELS, CODEX_PREFIX } from '../hooks/native'

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
  /** What the plugin put on the status line, in order. */
  statusLine: (string | undefined)[]
  /** The slash commands the plugin registered. */
  commands: string[]
  /** The agent types the plugin registered, as it registered them. */
  registered: { name: string; model?: string; description: string }[]
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
    /** `$.agent.list()` rejects. */
    listFail?: boolean
  } = {},
) {
  const seen: Seen = { fetches: [], statusLine: [], commands: [], registered: [], spawned: [], steps: [], notices: [], logs: [], writes: [], transcript: [], settingsReads: 0 }
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
  on('fs.stat', (_$, e) => ({ value: hudStat(e.path, opts.files) }) as never)
  on('fs.exists', (_$, e) => ({ value: hudExists(e.path, opts.files) }) as never)
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
    return { value: await (opts.reply ?? (async () => ok(answer(3.9))))() }
  })
  if (opts.register) {
    on('agent.register', (_$, e) => {
      if (e.name.endsWith('-codex') && (flags.registerFail || opts.twinFail?.(e.name))) throw new Error('refused')
      seen.registered.push({ name: e.name, model: e.model, description: e.description })
      return { value: { agent: `crew:${e.name}` } }
    })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('ui.status', (_$, e) => (seen.statusLine.push(e.text), { value: undefined }))
    on('command.register', (_$, e) => (seen.commands.push(e.name), { value: { command: e.name } }))
  }
  on('agent.list', async () => {
    if (opts.listFail) throw new Error('list unavailable')
    return { value: opts.agents ?? [] } as never
  })
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
/** The first plan read runs behind `session.start`: let it and the writes it makes settle. */
const flush = async () => { for (let i = 0; i < 10; i++) await pause() }

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
    v: 4, agent: 'developer', requested: 'crew:developer', provider: 'claude',
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
  expect(record(seen)).toMatchObject({ v: 4, effortPlanned: 'medium', effortApplied: 'medium', jevModel: null })
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
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', (_$, e) => (w.logs.push(e.text), { value: undefined }))
  // The band's plan read finds no plans directory, and says nothing.
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.exists', () => ({ value: false }))
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
      Object.entries(CODEX_MODELS).map(([role, model]) => [`${role}-codex`, `${CODEX_PREFIX}${model}`]),
    )
    expect(w.envReads).toEqual(['ANTHROPIC_BASE_URL'])
    expect(w.fetches).toEqual([])
    const by = (name: string) => w.registered.find(a => a.name === name)!
    expect(by('developer-codex')).toMatchObject({ model: 'cx/gpt-6-sol', effort: 'medium', tools: by('developer').tools, prompt: by('developer').prompt })
    expect(by('architect-codex')).toMatchObject({ model: 'cx/gpt-6-astra', tools: by('architect').tools, prompt: by('architect').prompt })
    expect(w.registered.some(agent => agent.name === 'tester' || agent.name === 'tester-codex')).toBe(false)
    expect(by('architect-codex').tools).not.toContain('Edit')
    expect(by('developer').model).toBe('sonnet')
    expect(by('developer-codex').description).toContain('gpt-6-sol')
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
  expect(lead?.text).not.toMatch(/codex/i)
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
  expect(seen.spawned[0]?.description).toBe('docs · v2/high · gpt-6-sol/high')
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
  expect(sections[0]?.text).not.toMatch(/codex/i)
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

// --- The crew mode: in codex, a plain specialist call goes to the same role's registered Codex twin ---

const CODEX_MODE = { options: { mode: 'codex' } }
const CODEX_MODE_JEV = { options: { jevKey: KEY, mode: 'codex' } }

const runMode = async ($: Engine, args: string) => (await $.command.run({ command: 'crew-mode', args } as never)).text

test('the mode option defaults to claude: a plain call stays on Claude, untouched, and the status line shows nothing', async ($, on) => {
  const { seen } = await twinWorld($, on)
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer', description: 'audit auth' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect([seen.fetches, seen.notices, seen.writes]).toEqual([[], [], []])
  expect(seen.statusLine).toEqual([undefined])
  expect(seen.commands).toEqual(['crew-mode'])
})

test('in the codex mode without Jev a plain call becomes its twin on medium: tagged, noticed, confirmed, with no request', CODEX_MODE, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-sol' })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium', 'cx/gpt-6-sol-medium')

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', model: 'cx/gpt-6-sol-medium', description: 'audit auth · gpt-6-sol/medium' })
  expect(seen.notices).toEqual(['crew:developer -> Codex (crew mode) · gpt-6-sol · medium'])
  expect(seen.transcript).toEqual(['crew: audit auth: confirmed gpt-6-sol · medium'])
  expect(seen.logs).toContain('crew mode: crew:developer -> crew:developer-codex')
  expect(seen.fetches).toEqual([])
  expect(seen.statusLine).toEqual(['crew: codex'])
})

test('in the codex mode Jev sizes the twin as its base role while the twin model stays fixed, and the record names the type asked for', CODEX_MODE_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(3.9)) })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', model: 'cx/gpt-6-sol-high', description: 'audit auth · gpt-6-sol/high' })
  expect(JSON.parse(seen.fetches[0]?.body ?? '{}').state.agent).toEqual({ type: 'developer', description: 'audit auth' })
  expect(seen.notices).toEqual(['crew:developer -> Codex (crew mode) · gpt-6-sol · high (jev)'])
  expect(record(seen)).toMatchObject({ v: 4, agent: 'developer-codex', requested: 'crew:developer', provider: 'codex', bind: 'suffix', effortApplied: 'high' })
})

test('in the codex mode every fixed-map role moves to its own twin', CODEX_MODE, async ($, on) => {
  const { seen } = await twinWorld($, on)
  for (const [i, role] of BASES.entries()) await $.agent.spawn(spawnInput({ subagentType: `crew:${role}`, tool_use_id: `tu${i}` }))
  expect(seen.spawned.map(spawned => [spawned.subagentType, spawned.model])).toEqual(
    Object.entries(CODEX_MODELS).map(([role, model]) => [`crew:${role}-codex`, `${CODEX_PREFIX}${model}-medium`]),
  )
})

test('in the codex mode calls that may not move are untouched: explicit model, fork, workflow agent, teammate, a twin the lead named, another plugin\'s type', CODEX_MODE, async ($, on) => {
  const { seen } = await twinWorld($, on)
  const calls = [
    { model: 'opus' }, { fork: true }, { workflow: { runId: 'wf_1', agentIndex: 1 } }, { isTeammate: true },
    { subagentType: 'crew:architect-codex' }, { subagentType: 'acme:developer' },
  ]
  for (const [i, over] of calls.entries()) await $.agent.spawn(spawnInput({ ...over, tool_use_id: `tu${i}` }))
  expect(seen.spawned.map(spawned => spawned.subagentType)).toEqual(['crew:developer', 'crew:developer', 'crew:developer', 'crew:developer', 'crew:architect-codex', 'acme:developer'])
  expect(seen.spawned.map(spawned => spawned.description)).toEqual(Array(6).fill('audit auth'))
  expect([seen.fetches, seen.notices, seen.writes]).toEqual([[], [], []])
})

test('in the codex mode a role whose twin was refused stays on Claude while the others move', CODEX_MODE, async ($, on) => {
  const { seen } = await twinWorld($, on, { twinFail: name => name === 'developer-codex' })
  await $.agent.spawn(spawnInput())
  await $.agent.spawn(spawnInput({ subagentType: 'crew:architect', tool_use_id: 'tu2' }))
  expect(seen.spawned.map(spawned => spawned.subagentType)).toEqual(['crew:developer', 'crew:architect-codex'])
})

test('without registered twins the codex mode moves nothing and reads no mode', CODEX_MODE, async ($, on) => {
  const { seen } = jevWorld(on, { register: true })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer', description: 'audit auth' })
  expect([seen.fetches, seen.notices]).toEqual([[], []])
  expect(await runMode($, 'codex')).toBe('crew mode: codex for this session, but no Codex twin is registered, so every call stays on Claude. New sessions start in codex (the mode option).')
})

test('/crew-mode switches the running session: no argument toggles, a word sets it, the status line follows, the option stays', async ($, on) => {
  const { seen } = await twinWorld($, on)
  expect(await runMode($, '')).toBe(`crew mode: codex for this session. Plain crew:<role> calls run on their twins (${TWINS.map(twin => `crew:${twin}`).join(', ')}); roles without one stay on Claude. New sessions start in claude (the mode option).`)
  await $.agent.spawn(spawnInput())
  expect(await runMode($, 'claude')).toBe('crew mode: claude for this session. Plain crew:<role> calls run on Claude. New sessions start in claude (the mode option).')
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
  expect(await runMode($, ' CODEX ')).toContain('crew mode: codex for this session.')
  expect(await runMode($, 'gpt')).toBe('crew mode: codex. Usage: /crew-mode [claude|codex]; no argument toggles.')
  expect(seen.spawned.map(spawned => spawned.subagentType)).toEqual(['crew:developer-codex', 'crew:developer'])
  expect(seen.statusLine).toEqual([undefined, 'crew: codex', undefined, 'crew: codex'])
})

test('a codex mode that the repository settings declare, or settings that cannot be read, start the session in claude', CODEX_MODE, async ($, on) => {
  const { seen } = await twinWorld($, on, { project: { pluginConfigs: { crew: { options: { mode: 'codex' } } } } })
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]?.subagentType).toBe('crew:developer')
  expect(seen.statusLine).toEqual([undefined])
  expect(seen.logs).toContain('crew: the session starts in claude: the repository settings declare the mode, or cannot be read')
})

test('settings that cannot be read start a codex-option session in claude too', CODEX_MODE, async ($, on) => {
  const { seen } = await twinWorld($, on, { settingsFail: true })
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]?.subagentType).toBe('crew:developer')
})

test('a fresh activation has no mode before session.start: a plain call stays on Claude', CODEX_MODE, async ($, on) => {
  const { seen } = jevWorld(on, { env: GATEWAY, register: true })
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer', description: 'audit auth' })
})

test('a switched call without a key says once that no record was written, not again at its confirmation', CODEX_MODE, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-sol' })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium', 'cx/gpt-6-sol-medium')
  expect(seen.logs.filter(line => line.includes('no trusted home'))).toEqual(['crew: decision not logged (no trusted home)'])
  expect(seen.writes).toEqual([])
})

// --- Twins on the Codex login: crew answers their steps itself, with no gateway ---

const LOGIN = { options: { codexLogin: true } }
const LOGIN_NOW = Date.parse('2026-10-12T12:00:00Z')
const AUTH_PATH = `${HOME}/.codex/auth.json`

/** base64url of ASCII text, written out: the test environment has no `btoa` or `Buffer`. */
function base64url(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  let bits = 0
  let value = 0
  for (const char of text) {
    value = (value << 8) | char.charCodeAt(0)
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += alphabet[(value >> bits) & 63]
    }
  }
  return bits > 0 ? out + alphabet[(value << (6 - bits)) & 63] : out
}

// Token fixtures are assembled at runtime so no source literal matches a secret scanner.
const accessToken = (exp: number) => `${base64url('{"alg":"none"}')}.${base64url(JSON.stringify({ exp, sub: ['codex', '-user'].join('') }))}.sig`
const ACCESS_TOKEN = accessToken(LOGIN_NOW / 1000 + 3600)
const authFile = (token = ACCESS_TOKEN) => JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, account_id: 'acct-1', refresh_token: 'never-sent' } })

const sse = (...events: Record<string, unknown>[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
const codexDone = (item: Record<string, unknown>) => ({ type: 'response.output_item.done', item })
const codexCompleted = { type: 'response.completed', response: { model: 'gpt-6-luna', usage: { input_tokens: 50, output_tokens: 9, input_tokens_details: { cached_tokens: 10 } } } }
const ANSWER = sse(codexDone({ type: 'message', content: [{ type: 'output_text', text: 'auth is at src/auth.ts:12' }] }), codexCompleted)
const CALL = sse(
  codexDone({ type: 'reasoning', encrypted_content: 'enc-1', summary: [] }),
  codexDone({ type: 'function_call', call_id: 'call_1', name: 'Grep', arguments: '{"pattern":"auth"}' }),
  codexCompleted,
)

type LoginOptions = Parameters<typeof jevWorld>[1] & { messages?: () => unknown[] }

/** The session started with the login file under HOME, the subagent's conversation and the tool list beneath the plugin. */
async function loginWorld($: Engine, on: On, o: LoginOptions = {}) {
  const world = jevWorld(on, {
    register: true,
    files: { [AUTH_PATH]: authFile() },
    reply: async () => ok(ANSWER),
    agents: [{ id: 'cr1', type: 'crew:code-reader-codex', description: 'find auth' }],
    now: () => LOGIN_NOW,
    ...o,
  })
  on('session.messages', () => ({ value: o.messages?.() ?? [{ role: 'user', content: [{ type: 'text', text: 'where is auth?' }] }] }) as never)
  on('tool.list', () => ({ value: [{ name: 'Read', description: 'Reads a file.', mcp: false }, { name: 'Grep', description: 'Searches files.', mcp: false }] }) as never)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  return world
}

/** One step through the plugin: what it yielded, and what it returned. */
async function stepThrough($: Engine, agentId: string | undefined, model = 'cx/gpt-6-luna', effort: string | undefined = 'medium') {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 1, ...(effort ? { effort } : {}), ...(agentId ? { agentId } : {}) } as never)
  const chunks: unknown[] = []
  let item = await stream.next()
  while (!item.done) {
    chunks.push(item.value)
    item = await stream.next()
  }
  return { chunks, result: item.value }
}

const codexBodyOf = (seen: Seen, i = 0) => JSON.parse(seen.fetches[i]?.body ?? '{}')

test('with codexLogin and no gateway only crew:code-reader-codex registers, on its Codex id and described as on the login', LOGIN, async ($, on) => {
  const { seen } = await loginWorld($, on)
  expect(seen.registered.filter(agent => agent.name.endsWith('-codex'))).toEqual([
    { name: 'code-reader-codex', model: 'cx/gpt-6-luna', description: 'crew:code-reader on gpt-6-luna (OpenAI, on your Codex login): same job, tools and write lane.' },
  ])
  expect(seen.fetches).toEqual([])
})

test('a step of the twin on the login is answered by crew: nothing goes to the API, the backend gets the conversation and the token in its header only', LOGIN, async ($, on) => {
  const { seen } = await loginWorld($, on)
  const { chunks, result } = await stepThrough($, 'cr1')

  expect(seen.steps).toEqual([])
  expect(seen.fetches.map(fetch => fetch.url)).toEqual(['https://chatgpt.com/backend-api/codex/responses'])
  expect(seen.fetches[0]?.headers).toMatchObject({ Authorization: `Bearer ${ACCESS_TOKEN}`, 'Chatgpt-Account-Id': 'acct-1', Originator: 'codex-tui' })
  const body = codexBodyOf(seen)
  expect(body).toMatchObject({ model: 'gpt-6-luna', instructions: '', store: false, stream: true, reasoning: { effort: 'medium', summary: 'auto' } })
  expect(body.input[0].role).toBe('developer')
  expect(body.input[0].content[0].text).toContain('Find the requested code.')
  expect(body.input[0].content[0].text).toContain(`Working directory: ${ROOT}. Today's date: 2026-10-12.`)
  expect(body.input[1]).toEqual({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'where is auth?' }] })
  expect(body.tools.map((tool: { name: string; description: string }) => [tool.name, tool.description])).toEqual([['Read', 'Reads a file.'], ['Grep', 'Searches files.'], ['Glob', 'Glob']])
  expect(chunks[0]).toEqual({ kind: 'text', index: 0, text: 'auth is at src/auth.ts:12' })
  expect(result).toEqual({
    turnId: 't1', index: 0, answer: 'auth is at src/auth.ts:12', toolUses: [], stopReason: 'end_turn',
    usage: { model: 'gpt-6-luna', input_tokens: 40, output_tokens: 9, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 },
  })
  expect(JSON.stringify([seen.logs, seen.notices, seen.transcript, body])).not.toContain(ACCESS_TOKEN)
  expect(JSON.stringify(seen.fetches)).not.toContain('never-sent')
})

test('the spawn\'s effort suffix decides the effort sent to Codex, before the host\'s', LOGIN, async ($, on) => {
  const { seen } = await loginWorld($, on)
  await stepThrough($, 'cr1', 'cx/gpt-6-luna-high', 'medium')
  await stepThrough($, 'cr1', 'cx/gpt-6-luna', 'max')
  expect([codexBodyOf(seen, 0).reasoning.effort, codexBodyOf(seen, 1).reasoning.effort]).toEqual(['high', 'medium'])
})

test('a tool call comes back as a tool use, and its reasoning goes back before the call on the next step, in the same backend session', LOGIN, async ($, on) => {
  const replies = [CALL, ANSWER]
  const conversation: unknown[][] = [
    [{ role: 'user', content: [{ type: 'text', text: 'where is auth?' }] }],
    [
      { role: 'user', content: [{ type: 'text', text: 'where is auth?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Grep', input: { pattern: 'auth' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'src/auth.ts' }] },
    ],
  ]
  let turn = 0
  const { seen } = await loginWorld($, on, { reply: async () => ok(replies[turn] ?? ANSWER), messages: () => conversation[turn] ?? [] })
  const first = await stepThrough($, 'cr1')
  expect(first.result).toMatchObject({ toolUses: [{ name: 'Grep', input: { pattern: 'auth' } }], stopReason: 'tool_use' })
  expect(first.chunks.slice(0, 2)).toEqual([{ kind: 'tool', index: 0, id: 'call_1', name: 'Grep' }, { kind: 'input', index: 0, json: '{"pattern":"auth"}' }])
  turn = 1
  await stepThrough($, 'cr1')
  expect(codexBodyOf(seen, 1).input.slice(2)).toEqual([
    { type: 'reasoning', summary: [], content: null, encrypted_content: 'enc-1' },
    { type: 'function_call', call_id: 'call_1', name: 'Grep', arguments: '{"pattern":"auth"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'src/auth.ts' },
  ])
  expect(seen.fetches[1]?.headers.Session_id).toBe(seen.fetches[0]?.headers.Session_id)
  expect(seen.fetches[0]?.headers.Session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

for (const [label, over, reason] of [
  ['no login file', { files: {} }, 'no Codex login file at ~/.codex/auth.json (run `codex login`)'],
  ['an expired login', { files: { [AUTH_PATH]: authFile(accessToken(LOGIN_NOW / 1000 - 5)) } }, 'the Codex login has expired (run `codex` once to refresh it)'],
  ['a login the backend refuses', { reply: async () => ({ status: 401, ok: false, headers: {}, text: '{"error":{"message":"token revoked"}}' }) }, 'the Codex backend refused the login (run `codex login`): token revoked'],
  ['a backend that cannot be reached', { reply: async () => { throw new Error('ECONNRESET') } }, 'the Codex backend could not be reached'],
] as const) {
  test(`${label} answers the step with its reason, and nothing goes to the API`, LOGIN, async ($, on) => {
    const { seen } = await loginWorld($, on, over as LoginOptions)
    const { result } = await stepThrough($, 'cr1')
    expect(result).toMatchObject({ answer: `crew: this Codex twin could not run: ${reason}.`, toolUses: [], stopReason: 'end_turn', usage: null })
    expect(seen.steps).toEqual([])
  })
}

test('steps of the main loop, a Claude role, a twin on the gateway and an agent the list cannot name go on to the API', LOGIN, async ($, on) => {
  const { seen } = await loginWorld($, on, {
    env: GATEWAY,
    agents: [
      { id: 'cr1', type: 'crew:code-reader-codex', description: 'a' },
      { id: 'c1', type: 'crew:code-reader', description: 'b' },
      { id: 'd1', type: 'crew:developer-codex', description: 'c' },
    ],
  })
  for (const agentId of [undefined, 'c1', 'd1', 'unknown']) await stepThrough($, agentId, 'sonnet')
  expect(seen.steps).toHaveLength(4)
  expect(seen.fetches).toEqual([])
  // Behind a gateway the other twins register there, the code-reader twin on the login.
  expect(seen.registered.filter(agent => agent.name.endsWith('-codex')).map(agent => [agent.name, agent.description.includes('Codex login')])).toEqual(
    TWINS.map(name => [name, name === 'code-reader-codex']),
  )
})

test('an agent list that fails sends the step on, where the twin\'s Codex id fails at the API', LOGIN, async ($, on) => {
  const { seen } = await loginWorld($, on, { listFail: true })
  await stepThrough($, 'cr1')
  expect(seen.fetches).toEqual([])
  expect(seen.steps).toHaveLength(1)
})

test('a repository that sets codexLogin, or declares HOME, keeps the twin off the login: without a gateway none registers', LOGIN, async ($, on) => {
  const { seen } = await loginWorld($, on, { project: { pluginConfigs: { crew: { options: { codexLogin: true } } } } })
  expect(seen.registered.some(agent => agent.name.endsWith('-codex'))).toBe(false)
  expect(seen.logs).toContain('crew: codexLogin is off: the repository settings declare codexLogin (set it in user settings)')
})

test('without the option the login is never read and no twin registers without a gateway', async ($, on) => {
  const { seen } = await loginWorld($, on)
  await stepThrough($, 'cr1')
  expect(seen.registered.some(agent => agent.name.endsWith('-codex'))).toBe(false)
  expect([seen.fetches, seen.settingsReads]).toEqual([[], 0])
  expect(seen.steps).toHaveLength(1)
})

test('in the codex mode a plain code-reader call runs on its login twin and its first step is confirmed with the effort sent', { options: { codexLogin: true, mode: 'codex' } }, async ($, on) => {
  const { seen } = await loginWorld($, on, { agents: [{ id: 'a1', type: 'crew:code-reader-codex', description: 'audit auth' }] })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:code-reader' }))
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:code-reader-codex', model: 'cx/gpt-6-luna-medium' })
  await stepThrough($, 'a1', 'cx/gpt-6-luna-medium')
  expect(seen.steps).toEqual([])
  expect(seen.transcript).toEqual(['crew: audit auth: confirmed gpt-6-luna · medium'])
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

test('an explicit twin teammate keeps the same Jev effort-only routing in the codex mode', CODEX_MODE_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on)
  await $.agent.spawn(spawnInput({ subagentType: 'crew:developer-codex', isTeammate: true }))
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:developer-codex', model: 'cx/gpt-6-sol-high' })
  expect(seen.fetches).toHaveLength(1)
})

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

for (const type of ['crew:tester', 'crew:tester-codex', 'crew:tester-extra']) {
  test(`removed type ${type} is not routed, asks no Jev and is not moved by the codex mode`, CODEX_MODE_JEV, async ($, on) => {
    const { seen } = await twinWorld($, on)
    await $.agent.spawn(spawnInput({ subagentType: type }))
    await $.agent.spawn(spawnInput({ subagentType: type, model: 'opus', tool_use_id: 'tu2' }))
    expect(seen.spawned.map(spawned => [spawned.subagentType, spawned.model, spawned.description])).toEqual([
      [type, undefined, 'audit auth'], [type, 'opus', 'audit auth'],
    ])
    expect([seen.fetches, seen.notices, seen.writes]).toEqual([[], [], []])
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

// --- HUD host integration ---
function hudStat(path: string, files?: Record<string, string>) {
  if (path === ROOT || path === `${ROOT}/.crew/plans`) return { kind: 'dir', isLink: false, realPath: path, size: 0, mtimeMs: 0 }
  if (files?.[path] !== undefined) return { kind: 'file', isLink: false, realPath: path, size: 1, mtimeMs: 0 }
  throw new Error('ENOENT')
}
/** What the `hudStat` fake has: the plans directory and the files a test names. */
function hudExists(path: string, files?: Record<string, string>): boolean {
  return path === ROOT || path === `${ROOT}/.crew/plans` || files?.[path] !== undefined
}
function hudCapture(on: On) {
  const values: Record<string, unknown> = {}
  on('state.set', (_$, e, next) => { values[e.key] = e.value; return next(e) })
  return values
}
const hudBand = (surface: 'terminal' | 'desktop' = 'terminal', hasSurvey = false) => ({
  plugin: 'crew', component: 'AbovePrompt', surface,
  props: { hasSurvey, isWorking: false, maxRows: 20, bodyColumns: 60, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}) as never

const hudText = '## Steps\n### Delivery\n- T1 (crew:developer, after: —) private task — state: implementing'

test('HUD observes bypass, routed and twin spawns separately from decision records', ON, async ($, on) => {
  const { seen } = jevWorld(on, { stepModel: 'claude-sonnet-5-5' })
  const values = hudCapture(on)
  await $.agent.spawn(spawnInput({ model: 'sonnet' }))
  await pause()
  expect(values.agents).toMatchObject([{ type: 'crew:developer', model: 'sonnet', status: 'running' }])
  await step($, 'a1', 'medium')
  await pause()
  expect(values.agents).toMatchObject([{ effort: 'medium', observedModel: 'claude-sonnet-5-5' }])
  expect(seen.writes).toHaveLength(0)
})

test('HUD preserves completion before late spawn, then a new step restarts the job', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  jevWorld(on, { spawn: async () => { await held; return { agentId: 'a1', model: 'sonnet' } } })
  const values = hudCapture(on)
  on('turn.complete', () => ({ text: 'completed' }))
  const spawning = $.agent.spawn(spawnInput())
  await pause()
  await $.turn.complete({ agentId: 'a1', answer: 'private', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  release()
  await spawning
  expect(values.agents).toEqual([])
  await step($, 'a1', 'medium')
  expect(values.agents).toMatchObject([{ status: 'running', effort: 'medium' }])
  await $.turn.complete({ agentId: 'a1', answer: 'private', reason: 'aborted', turnId: 't1', durationMs: 1, isAborted: true } as never)
  expect(values.agents).toMatchObject([{ status: 'ended' }])
  await step($, 'a1', 'high')
  expect(values.agents).toMatchObject([{ status: 'running', effort: 'high' }])
})

test('HUD refreshes plans after successful in-scope Write and never for denies, errors or foreign paths', OFF, async ($, on) => {
  const files: Record<string, string> = { '/repo/.crew/plans/live.md': hudText }
  jevWorld(on, { files })
  const values = hudCapture(on)
  on('tool.call', (_$, e) => 'file_path' in e && e.file_path === 'error' ? { result: 'failed', isError: true } : { result: 'written' })
  const write = (file_path: string) => $.tool.call({ tool: 'Write', file_path, content: hudText } as never)
  await write('src/file.ts')
  await write('../other/.crew/plans/out.md')
  expect(values.plans).toBeUndefined()
  expect(await write('.crew/plans/live.md')).toEqual({ result: 'written' })
  expect(values.plans).toMatchObject([{ name: 'live' }])
  await write('error')
  expect(values.plans).toMatchObject([{ name: 'live' }])
})

test('HUD render reads atoms only and yields the band during a survey', OFF, async ($, on) => {
  const { seen } = jevWorld(on)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['idle'] }))
  await $.agent.spawn(spawnInput())
  await pause()
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount(hudBand(surface))
    expect(await band.find({ type: 'Text', text: /Agents/ })).toBeDefined()
    await band.unmount()
  }
  expect(seen.fetches).toEqual([])
  const survey = await $.ui.mount(hudBand('terminal', true))
  expect(await survey.find({ type: 'Text', text: /Agents/ })).toBeUndefined()
  await survey.unmount()
  expect(seen.writes).toEqual([])
})

test('HUD keeps the prompt sections byte-identical after observation and plan refresh', ON, async ($, on) => {
  const { clock } = jevWorld(on, { files: { '/repo/.crew/plans/live.md': hudText }, stepModel: 'claude-sonnet-5-5' })
  on('tool.call', () => ({ result: 'written' }))
  on('turn.complete', () => ({ text: 'done' }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const before = JSON.stringify((await compose($, ['Agent'])).sections)
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium')
  await $.turn.complete({ agentId: 'a1', answer: 'private', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await $.tool.call({ tool: 'Write', file_path: '.crew/plans/live.md', content: hudText } as never)
  await clock.advance(5_000)
  expect(JSON.stringify((await compose($, ['Agent'])).sections)).toBe(before)
})

test('HUD records the twin a codex-mode switch chose, its sent suffix effort and the observed model', CODEX_MODE_JEV, async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['idle'] }))
  const world = await twinWorld($, on, { stepModel: 'gpt-6-sol', reply: async () => ok(answer(3.9)) })
  await $.agent.spawn(spawnInput())
  const band = await $.ui.mount(hudBand())
  expect(await band.find({ type: 'Text', text: /crew:developer-codex/ })).toBeDefined()
  await step($, 'a1', 'medium', 'cx/gpt-6-sol-high')
  expect(await band.find({ type: 'Text', text: /effort high/ })).toBeDefined()
  await band.unmount()
  expect(record(world.seen, 0)).toMatchObject({ requested: 'crew:developer', effortApplied: 'high', ran: null })
  expect(record(world.seen, 1)).toMatchObject({ ran: { model: 'gpt-6-sol', effort: 'high' } })
})

test('HUD reconciles a running listed agent as seen, ends it, and ticks once across repeated hooks', OFF, async ($, on) => {
  let listed = [{ id: 'unseen', type: 'crew:architect', status: 'running', description: 'private' }]
  const clock = mock.clock(on)
  on('agent.list', () => ({ value: listed }) as never)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.list', () => ({ value: [] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('turn.complete', () => ({ text: 'done' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.compose', () => ({ sections: [] }))
  const values = hudCapture(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.prompt.compose({ tools: [], traits: [], model: 'm', promptModel: 'm', surfaces: [], outputStyle: null } as never)
  await clock.advance(1_000)
  expect(values.agents).toMatchObject([{ type: 'crew:architect', seenAt: 1_000, status: 'running' }])
  expect(values.now).toBe(1_000)
  listed = [{ ...listed[0]!, status: 'completed' }]
  await clock.advance(1_000)
  expect(values.agents).toMatchObject([{ status: 'ended' }])
  await $.turn.complete({ agentId: 'unseen', answer: 'private', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await clock.advance(1_000)
  expect(values.agents).toMatchObject([{ status: 'ended' }])
  await $.session.end({ reason: 'exit', sessionId: 'test-session' } as never)
})

test('HUD state write failure never changes spawn result or routed decision records', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  on('state.set', (_$, e, next) => e.key === 'agents' ? { deny: 'state refused' } : next(e))
  const result = await $.agent.spawn(spawnInput())
  expect(result).toMatchObject({ agentId: 'a1', model: 'default' })
  expect(seen.writes).toHaveLength(1)
  expect(record(seen)).toMatchObject({ v: 4, agent: 'developer', ran: null })
})

test('HUD lists several active plans in filename order, hides closed plans and drops a removed file on reread', OFF, async ($, on) => {
  const files: Record<string, string> = {
    '/repo/.crew/plans/z.md': hudText,
    '/repo/.crew/plans/a.md': hudText,
    '/repo/.crew/plans/closed.md': hudText.replace('implementing', 'skipped'),
  }
  let entries = ['z.md', 'closed.md', 'a.md']
  mock.clock(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.stat', (_$, e) => ({ value: hudStat(e.path, files) }) as never)
  on('fs.exists', (_$, e) => ({ value: hudExists(e.path, files) }) as never)
  on('fs.list', () => ({ value: entries.map(name => ({ name, kind: 'file', isLink: false, size: 1, mtimeMs: 1 })) }) as never)
  on('fs.read', (_$, e) => {
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: files[e.path]! }
  })
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'written' }))
  const values = hudCapture(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await flush()
  expect(values.plans).toMatchObject([{ name: 'a' }, { name: 'z' }])
  delete files['/repo/.crew/plans/a.md']
  entries = ['a.md', 'z.md']
  const result = await $.tool.call({ tool: 'Write', file_path: '.crew/plans/z.md', content: hudText } as never)
  expect(result).toEqual({ result: 'written' })
  expect(values.plans).toMatchObject([{ name: 'z' }])
})

for (const tool of ['Write', 'Edit'] as const) {
  test(`HUD ${tool} denied or errored inside plans returns its exact result without refresh`, OFF, async ($, on) => {
    let calls = 0
    mock.clock(on)
    on('session.cwd', () => ({ value: '/repo' }))
    on('fs.list', () => (calls++, { value: [] }))
    on('agent.list', () => ({ value: [{ id: 'architect', type: 'crew:architect' }] }) as never)
    const denied = { deny: 'permission denied' }
    const failed = { result: 'IO failure', isError: true as const }
    on('tool.call', (_$, e) => 'file_path' in e && String(e.file_path).includes('failed') ? failed : denied)
    const invoke = (path: string, agentId?: string) => $.tool.call({ tool, file_path: path, agentId, content: hudText,
      old_string: 'a', new_string: 'b' } as never)
    expect(await invoke('.crew/plans/denied.md', 'architect')).toEqual(denied)
    expect(calls).toBe(0)
    expect(await invoke('.crew/plans/failed.md')).toEqual(failed)
    expect(calls).toBe(0)
  })
}

test('HUD ticker updates running time each second, idle time each thirtieth, plans each fifth, and is singleton without session.start', OFF, async ($, on) => {
  const clock = mock.clock(on)
  let listings = 0
  on('session.cwd', () => ({ value: '/repo' }))
  on('agent.list', () => ({ value: [] }) as never)
  on('fs.stat', (_$, e) => ({ value: hudStat(e.path) }) as never)
  on('fs.exists', (_$, e) => ({ value: hudExists(e.path) }) as never)
  on('fs.list', () => (listings++, { value: [] }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('prompt.compose', () => ({ sections: [] }))
  on('turn.complete', () => ({ text: 'done' }))
  const values = hudCapture(on)
  const prompt = { tools: [], traits: [], model: 'm', promptModel: 'm', surfaces: [], outputStyle: null } as never
  await $.prompt.compose(prompt)
  await $.prompt.compose(prompt)
  await $.agent.spawn(spawnInput())
  await clock.advance(1_000)
  expect(values.now).toBe(1_000)
  expect(listings).toBe(0)
  await clock.advance(4_000)
  expect(values.now).toBe(5_000)
  expect(listings).toBe(1)
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await clock.advance(24_000)
  expect(values.now).toBe(5_000)
  expect(listings).toBe(5)
  await clock.advance(1_000)
  expect(values.now).toBe(30_000)
  expect(listings).toBe(6)
})

test('HUD late step after completion starts a new timed job, and a delayed spawn cannot reopen an ended job', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const clock = mock.clock(on)
  on('agent.spawn', async () => { await held; return { agentId: 'a1', model: 'sonnet' } })
  on('turn.step', async function* (_$, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as never })
  on('turn.complete', () => ({ text: 'done' }))
  const values = hudCapture(on)
  const spawning = $.agent.spawn(spawnInput())
  await pause()
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'error', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await clock.advance(2_000)
  release()
  await spawning
  expect(values.agents).toEqual([])
  await clock.advance(3_000)
  await step($, 'a1', 'medium')
  expect(values.agents).toMatchObject([{ startedAt: 5_000, status: 'running' }])
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'aborted', turnId: 't1', durationMs: 1, isAborted: true } as never)
  await clock.advance(2_000)
  await step($, 'a1', 'high')
  expect(values.agents).toMatchObject([{ startedAt: 7_000, effort: 'high', status: 'running' }])
})

test('HUD answer arriving after completion never reactivates the finished job', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('turn.step', async function* (_$, e) {
    await held
    return { turnId: e.turnId, index: e.index, answer: 'private', toolUses: [], stopReason: null,
      usage: { model: 'claude-sonnet-5-5' } } as never
  })
  on('turn.complete', () => ({ text: 'done' }))
  const values = hudCapture(on)
  await $.agent.spawn(spawnInput())
  const ongoing = step($, 'a1', 'medium')
  await pause()
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'error', turnId: 't1', durationMs: 1, isAborted: false } as never)
  release()
  await ongoing
  expect(values.agents).toMatchObject([{ status: 'ended' }])
})

for (const twin of [false, true]) {
  test(`HUD retains a first step and answer before ${twin ? 'twin' : 'bypass'} spawn resolves`, OFF, async ($, on) => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const { seen } = jevWorld(on, { stepModel: twin ? 'gpt-6-sol' : 'claude-sonnet-5-5',
      spawn: async () => { await held; return { agentId: 'a1', model: twin ? 'cx/gpt-6-sol-high' : 'sonnet' } } })
    const values = hudCapture(on)
    const spawning = $.agent.spawn(spawnInput({ subagentType: twin ? 'crew:developer-codex' : 'crew:developer', model: twin ? undefined : 'sonnet' }))
    await pause()
    await step($, 'a1', 'high', twin ? 'cx/gpt-6-sol-high' : 'sonnet')
    release()
    await spawning
    await pause()
    expect(values.agents).toMatchObject([{ type: twin ? 'crew:developer-codex' : 'crew:developer', effort: 'high',
      observedModel: twin ? 'gpt-6-sol' : 'claude-sonnet-5-5' }])
    expect(seen.fetches).toEqual([])
  })
}

test('HUD ignores an answer from job A after completion and restart of job B', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('turn.step', async function* (_$, e) {
    if (e.model === 'sonnet') await held
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null,
      usage: { model: e.model === 'sonnet' ? 'claude-sonnet-5-5' : 'claude-opus-5-5' } } as never
  })
  on('turn.complete', () => ({ text: 'done' }))
  const values = hudCapture(on)
  await $.agent.spawn(spawnInput())
  const first = step($, 'a1', 'medium', 'sonnet')
  await pause()
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await step($, 'a1', 'high', 'opus')
  await pause()
  release()
  await first
  await pause()
  expect(values.agents).toMatchObject([{ model: 'opus', effort: 'high', observedModel: 'claude-opus-5-5', status: 'running' }])
})

test('HUD checks real destinations for listing, touched names, directory links, cwd aliases and link traversal', OFF, async ($, on) => {
  const files: Record<string, string> = { '/repo/.crew/plans/live.md': hudText, '/repo/.crew/plans/outside.md': hudText }
  let directoryLink = false
  const read: string[] = []
  mock.clock(on)
  on('session.cwd', () => ({ value: '/alias' }))
  on('fs.stat', (_$, e) => {
    const path = e.path as string
    if (path === '/alias') return { value: { kind: 'dir', isLink: true, realPath: '/repo' } } as never
    if (path === '/alias/.crew/plans') return { value: { kind: 'dir', isLink: directoryLink, realPath: '/repo/.crew/plans' } } as never
    if (path === '/alias/.crew/plans/live.md') return { value: { kind: 'file', isLink: false, realPath: '/repo/.crew/plans/live.md' } } as never
    if (path === '/alias/.crew/plans/outside.md') return { value: { kind: 'file', isLink: true, realPath: '/outside/secret.md' } } as never
    if (path.includes('bridge/../')) return { value: { kind: 'file', isLink: false, realPath: '/outside/secret.md' } } as never
    throw new Error('ENOENT')
  })
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.list', () => ({ value: [
    { name: 'outside.md', kind: 'other', isLink: true }, { name: 'live.md', kind: 'file', isLink: false },
  ] }) as never)
  on('fs.read', (_$, e) => { read.push(e.path); return { value: files[e.path.replace('/alias/', '/repo/')]! } })
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'written' }))
  const values = hudCapture(on)
  await $.session.start({ cwd: '/alias', surface: 'terminal', isInteractive: true } as never)
  await flush()
  expect(values.plans).toMatchObject([{ name: 'live' }])
  const edit = (file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' } as never)
  await edit('.crew/plans/outside.md')
  await edit('/alias/.crew/plans/bridge/../outside.md')
  expect(read).toEqual(['/alias/.crew/plans/live.md'])
  directoryLink = true
  await edit('.crew/plans/live.md')
  expect(read).toEqual(['/alias/.crew/plans/live.md'])
})

test('HUD publishes loading for a pending first read, unknown on read failure, and clears a proven removal', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  let present = true
  let fail = true
  let listings = 0
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('agent.list', () => ({ value: [] }) as never)
  // A removed plan rejects its stat without a usable code: only `exists` says it is gone.
  const files = (): Record<string, string> => present ? { [`${ROOT}/.crew/plans/live.md`]: hudText } : {}
  on('fs.stat', (_$, e) => ({ value: hudStat(e.path, files()) }) as never)
  on('fs.exists', (_$, e) => ({ value: e.path === `${ROOT}/.crew/plans/live.md` ? present : hudExists(e.path) }) as never)
  on('fs.list', () => (listings++, { value: present ? [{ name: 'live.md', kind: 'file', isLink: false }] : [] }) as never)
  on('fs.read', async () => { await held; if (fail) throw new Error('private error'); return { value: hudText } })
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'written' }))
  const values = hudCapture(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  for (let i = 0; i < 10 && !values.plans; i++) await pause()
  expect(values.plans).toEqual([{ state: 'loading' }])
  release()
  await flush()
  expect(values.plans).toEqual([{ state: 'unknown' }])
  fail = false
  await $.tool.call({ tool: 'Write', file_path: '.crew/plans/live.md', content: hudText } as never)
  expect(values.plans).toMatchObject([{ name: 'live' }])
  present = false
  await $.tool.call({ tool: 'Write', file_path: '.crew/plans/live.md', content: hudText } as never)
  // The periodic snapshot detects the disappearance without a new write.
  await clock.advance(5_000)
  await pause()
  expect({ listings, plans: values.plans }).toEqual({ listings: 3, plans: [] })
})

test('HUD initializes a nonzero clock at session start and again after session restart', OFF, async ($, on) => {
  let time = 1_800_000_000_000
  const clock = mock.clock(((name: string, ...rest: unknown[]) => (name === 'clock.now'
    ? undefined : (on as (...a: unknown[]) => unknown)(name, ...rest))) as On)
  on('clock.now', () => ({ value: time }))
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.stat', (_$, e) => ({ value: hudStat(e.path) }) as never)
  on('fs.exists', (_$, e) => ({ value: hudExists(e.path) }) as never)
  on('fs.list', () => ({ value: [] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  const values = hudCapture(on)
  const start = async () => { await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never); await flush() }
  await start()
  expect(values.now).toBe(time)
  await $.session.end({ reason: 'exit', sessionId: 'test-session' } as never)
  time += 3_600_000
  await start()
  expect(values.now).toBe(time)
  await clock.settle()
})

test('HUD held agent state and clock never delay routing bind, decision or confirmation', ON, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const { seen } = jevWorld(on, { stepModel: 'claude-sonnet-5-5' })
  on('state.set', (_$, e, next) => e.key === 'agents' ? held.then(() => next(e)) : next(e))
  const result = await $.agent.spawn(spawnInput())
  expect(result).toMatchObject({ agentId: 'a1' })
  expect(record(seen)).toMatchObject({ bind: 'applied' })
  await step($, 'a1', 'medium')
  expect(seen.transcript).toHaveLength(1)
  expect(record(seen, 1)).toMatchObject({ ran: { model: 'claude-sonnet-5-5' } })
  release()
})

test('HUD held clock does not delay the spawn decision or API confirmation', ON, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const { seen } = jevWorld(on, { stepModel: 'claude-sonnet-5-5', now: () => 1_800_000_000_000 })
  // Replace the registered mock only for subsequent HUD calls with a held clock result.
  on('state.set', (_$, e, next) => e.key === 'now' ? held.then(() => next(e)) : next(e))
  await $.agent.spawn(spawnInput())
  expect(record(seen)).toMatchObject({ bind: 'applied' })
  await step($, 'a1', 'medium')
  expect(seen.transcript).toHaveLength(1)
  release()
})

test('HUD old spawn cannot replace a restarted job with the same ID', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  let count = 0
  mock.clock(on)
  on('agent.spawn', async () => { if (++count === 1) await held; return { agentId: 'a1', model: count === 1 ? 'sonnet' : 'opus' } })
  on('turn.complete', () => ({ text: 'done' }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as never
  })
  const values = hudCapture(on)
  const old = $.agent.spawn(spawnInput())
  await pause()
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2', subagentType: 'crew:architect' }))
  await step($, 'a1', 'high', 'opus')
  release()
  await old
  await pause()
  expect(values.agents).toMatchObject([{ type: 'crew:architect', model: 'opus', effort: 'high', status: 'running' }])
})

const fsFailure = (code: string, message: string) => Object.assign(new Error(message), { code })

test('HUD treats a plans directory that does not exist as no plan, silently, on start and after removal; other failures are unknown', OFF, async ($, on) => {
  let state: 'missing' | 'ok' | 'denied' = 'missing'
  const logs: string[] = []
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('agent.list', () => ({ value: [] }) as never)
  on('ui.log', (_$, e) => (logs.push(e.text), { value: undefined }))
  // The host rejects a missing path, and a hook sees that rejection without its `code`: only `exists` says it is absent.
  on('fs.exists', (_$, e) => ({ value: e.path === `${ROOT}/.crew/plans` ? state !== 'missing' : hudExists(e.path, { [`${ROOT}/.crew/plans/live.md`]: hudText }) }) as never)
  on('fs.stat', (_$, e) => {
    if (e.path === `${ROOT}/.crew/plans`) {
      if (state === 'missing') throw fsFailure('ENOENT', `ENOENT: no such file or directory, stat '${e.path}'`)
      if (state === 'denied') throw fsFailure('EACCES', `EACCES: permission denied, stat '${e.path}'`)
    }
    return { value: hudStat(e.path, { [`${ROOT}/.crew/plans/live.md`]: hudText }) } as never
  })
  on('fs.list', () => ({ value: [{ name: 'live.md', kind: 'file', isLink: false }] }) as never)
  on('fs.read', () => ({ value: hudText }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('tool.call', () => ({ result: 'written' }))
  const values = hudCapture(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await flush()
  expect(values.plans ?? []).toEqual([])
  state = 'ok'
  await $.tool.call({ tool: 'Write', file_path: '.crew/plans/live.md', content: hudText } as never)
  expect(values.plans).toMatchObject([{ name: 'live' }])
  state = 'missing'
  await clock.advance(5_000)
  expect(values.plans).toEqual([])
  state = 'denied'
  await clock.advance(5_000)
  expect(values.plans).toEqual([{ state: 'unknown' }])
  state = 'missing'
  await clock.advance(5_000)
  expect(values.plans).toEqual([])
  expect(logs.filter(line => line.startsWith('crew HUD:'))).toEqual(['crew HUD: plan refresh failed'])
})

test('HUD recovers unchanged plan bytes after directory and context failures', OFF, async ($, on) => {
  let fail = ''
  mock.clock(on)
  on('session.cwd', () => { if (fail === 'context') throw new Error('context failure'); return { value: ROOT } })
  on('fs.stat', (_$, e) => {
    if (fail === 'directory' && e.path === `${ROOT}/.crew/plans`) throw fsFailure('EACCES', 'not readable')
    return { value: hudStat(e.path, { [`${ROOT}/.crew/plans/live.md`]: hudText }) } as never
  })
  on('fs.exists', (_$, e) => ({ value: hudExists(e.path, { [`${ROOT}/.crew/plans/live.md`]: hudText }) }) as never)
  on('fs.list', () => ({ value: [{ name: 'live.md', kind: 'file', isLink: false }] }) as never)
  on('fs.read', () => ({ value: hudText }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('tool.call', () => ({ result: 'written' }))
  const values = hudCapture(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await flush()
  const refresh = () => $.tool.call({ tool: 'Write', file_path: '.crew/plans/live.md', content: hudText } as never)
  for (const failure of ['directory', 'context']) {
    fail = failure
    // A second session.start refreshes without going through the Write observer's path validation.
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
    await flush()
    expect(values.plans).toEqual([{ state: 'unknown' }])
    fail = ''
    await refresh()
    expect(values.plans).toMatchObject([{ name: 'live' }])
  }
})

test('HUD proves a plan gone by its code or by exists, never by ENOENT appearing in a message or filename', OFF, async ($, on) => {
  expect(missingPlan(fsFailure('ENOENT', 'missing'))).toBe(true)
  expect(missingPlan(fsFailure('ENOTDIR', 'not a directory'))).toBe(true)
  expect(missingPlan(fsFailure('EACCES', 'permission denied for ENOENT.md'))).toBe(false)
  expect(missingPlan(new Error('ENOENT: filename contains ENOENT.md'))).toBe(false)
  let failure: string | undefined
  mock.clock(on)
  on('session.cwd', () => ({ value: ROOT }))
  const file = `${ROOT}/.crew/plans/ENOENT.md`
  on('fs.stat', (_$, e) => {
    if (failure && e.path === file) throw fsFailure(failure, `${failure}: cannot stat '${e.path}'`)
    return { value: hudStat(e.path, { [file]: hudText }) } as never
  })
  on('fs.exists', (_$, e) => ({ value: e.path === file ? failure !== 'ENOENT' && failure !== 'ENOTDIR' : hudExists(e.path) }) as never)
  on('fs.list', () => ({ value: [{ name: 'ENOENT.md', kind: 'file', isLink: false }] }) as never)
  on('fs.read', () => ({ value: hudText }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  const values = hudCapture(on)
  const refresh = async () => { await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never); await flush() }
  await refresh()
  expect(values.plans).toMatchObject([{ name: 'ENOENT' }])
  for (const code of ['EACCES', 'EHOSTREFUSED']) {
    failure = code
    await refresh()
    expect(values.plans).toEqual([{ state: 'unknown' }])
  }
  for (const code of ['ENOENT', 'ENOTDIR']) {
    failure = code
    await refresh()
    expect(values.plans).toEqual([])
  }
})

test('HUD bounds queued observations and drops them at completion and session end', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const clock = mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null,
      usage: { model: 'claude-sonnet-5-5' } } as never
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  let calls = 0
  const values: unknown[] = []
  on('state.set', (_$, e, next) => e.key === 'agents' ? (calls++, held.then(() => {
    values.push(e.value)
    return next(e)
  })) : next(e))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['idle'] }))
  await $.agent.spawn(spawnInput())
  for (let i = 0; i < 40; i++) await step($, 'a1', 'medium')
  expect(calls).toBe(1)
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await $.session.end({ reason: 'exit', sessionId: 'test-session' } as never)
  release()
  await pause()
  expect(calls).toBeLessThan(4)
  expect(values.length).toBeLessThan(4)
  await clock.settle()
})

/**
 * An ended agent whose job observed `claude-sonnet-5-5`, then the hook's own state wiped as a reload wipes it
 * (session end resets it; the atom stays). `hold` delays agents writes from the call it names on; `gate` holds
 * the API answer of the steps after the first.
 */
async function endedThenReset($: Engine, on: On, hold?: { from: number; until: Promise<void> }, gate?: Promise<void>) {
  const values: Record<string, unknown> = {}
  let writes = 0
  on('state.set', (_$, e, next) => {
    values[e.key] = e.value
    return hold && e.key === 'agents' && writes++ >= hold.from ? hold.until.then(() => next(e)) : next(e)
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  let steps = 0
  const world = jevWorld(on, { stepModel: () => (steps++ === 0 ? 'claude-sonnet-5-5' : 'claude-opus-5-5'),
    stepWait: async () => { if (steps > 0) await gate } })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'low', 'sonnet')
  await pause()
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await pause()
  expect(values.agents).toMatchObject([{ model: 'sonnet', effort: 'low', observedModel: 'claude-sonnet-5-5', status: 'ended' }])
  await $.session.end({ reason: 'exit', sessionId: 'test-session' } as never)
  return { values, ...world }
}

test('HUD restarts a persisted ended agent on its first step after a reload: new model and effort, no old observation, new clock', OFF, async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const { values, clock } = await endedThenReset($, on, undefined, gate)
  const first = (values.agents as { startedAt: number }[])[0]!.startedAt
  await clock.advance(100_000)
  const stepping = step($, 'a1', 'high', 'opus')
  await pause()
  const [record] = values.agents as Record<string, unknown>[]
  expect(record).toMatchObject({ id: 'a1', type: 'crew:developer', model: 'opus', effort: 'high', status: 'running' })
  expect(record).not.toHaveProperty('observedModel')
  expect(record?.startedAt).toBeGreaterThanOrEqual(first + 100_000)
  release()
  await stepping
  await pause()
  expect(values.agents).toMatchObject([{ model: 'opus', observedModel: 'claude-opus-5-5' }])
})

test('HUD keeps the restart when two steps of the new job coalesce behind a held write, with no model from the old job', OFF, async ($, on) => {
  let release: () => void = () => {}
  const until = new Promise<void>(resolve => { release = resolve })
  // The writes of the first job (spawn, step, answer, complete) pass; the new job's first write is held.
  const { values, clock } = await endedThenReset($, on, { from: 4, until })
  const first = (values.agents as { startedAt: number }[])[0]!.startedAt
  await clock.advance(100_000)
  await step($, 'a1', 'high', 'opus')
  await step($, 'a1', 'high', 'opus')
  release()
  await pause()
  await pause()
  const [record] = values.agents as Record<string, unknown>[]
  expect(record).toMatchObject({ model: 'opus', effort: 'high', status: 'running' })
  expect(record).not.toHaveProperty('observedModel', 'claude-sonnet-5-5')
  expect(record?.startedAt).toBeGreaterThanOrEqual(first + 100_000)
})

test('HUD observes a step the Codex login answers without changing its result, and never sends it to the API', LOGIN, async ($, on) => {
  const values = hudCapture(on)
  const { seen } = await loginWorld($, on, { spawn: async () => ({ model: 'cx/gpt-6-luna', agentId: 'cr1' }) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:code-reader-codex' }))
  const { result } = await stepThrough($, 'cr1')
  await pause()
  expect(seen.steps).toEqual([])
  expect(seen.fetches.map(fetch => fetch.url)).toEqual(['https://chatgpt.com/backend-api/codex/responses'])
  expect(result).toEqual({
    turnId: 't1', index: 0, answer: 'auth is at src/auth.ts:12', toolUses: [], stopReason: 'end_turn',
    usage: { model: 'gpt-6-luna', input_tokens: 40, output_tokens: 9, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 },
  })
  expect(values.agents).toMatchObject([{ type: 'crew:code-reader-codex', effort: 'medium', observedModel: 'gpt-6-luna', status: 'running' }])
})

test('HUD never writes the crew mode or the status line', CODEX_MODE, async ($, on) => {
  let tracking = false
  const writes: string[] = []
  on('state.set', (_$, e, next) => (tracking && writes.push(e.key), next(e)))
  on('turn.complete', () => ({ text: 'done' }))
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-sol' })
  const statusBefore = [...seen.statusLine]
  tracking = true
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium', 'cx/gpt-6-sol-medium')
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await pause()
  expect(writes.length).toBeGreaterThan(0)
  expect(writes).not.toContain('mode')
  expect(seen.statusLine).toEqual(statusBefore)
})
