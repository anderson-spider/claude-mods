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
  } = {},
) {
  const seen: Seen = { fetches: [], spawned: [], steps: [], notices: [], logs: [], writes: [], transcript: [], settingsReads: 0 }
  const flags = { settingsFail: opts.settingsFail === true }
  const clock = mock.clock(on)
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

  test(`${tool}: the tester is held to test files, with the reason and the path`, async ($, on) => {
    guardHost(on)

    expect(await call($, 't1', 'src/app.ts')).toEqual({
      deny: 'the tester writes test files only, not src/app.ts; hand the failure back with the evidence',
    })
    expect(await call($, 't1', 'tests/app.test.ts')).toEqual({ result: 'written' })
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
