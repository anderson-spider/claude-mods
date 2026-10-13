import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  GATEWAY, HOME, KEY, ROOT, answer, compose, hudPane, hudCapture, jevWorld, ok, pause, record, spawnInput, step,
  twinWorld,
} from './host'
import type { Seen } from './host'
import type { CrewAgent } from '../types'
import { CODEX_MODELS, CODEX_PREFIX } from '../hooks/native'

// Crew mode, the Codex login and the native twins that nativeWorld registers. Other host concerns: register-*.test.ts.

// --- The fixed -codex types ---

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
  // The HUD's plan read finds no plans directory, and says nothing.
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.exists', () => ({ value: false }))
  return w
}

const BASES = ['planner', 'challenger', 'digger']

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
    expect(by('digger-codex')).toMatchObject({ model: 'cx/gpt-6-luna', effort: 'high', tools: by('digger').tools, prompt: by('digger').prompt })
    expect(by('challenger-codex')).toMatchObject({ model: 'cx/gpt-6-astra', tools: by('challenger').tools, prompt: by('challenger').prompt })
    expect(w.registered.some(agent => agent.name === 'tester' || agent.name === 'tester-codex')).toBe(false)
    expect(by('challenger-codex').tools).toContain('Edit')
    expect(by('digger').model).toBe('haiku')
    expect(by('digger-codex').description).toContain('gpt-6-luna')
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

test('an env read that fails registers the three helpers and no -codex type', async ($, on) => {
  const w = nativeWorld(on, 'https://ai.example.ts.net', { envFail: true })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(w.registered.map(a => a.name)).toEqual(BASES)
})

test('a -codex type whose registration fails leaves the three helpers registered and the session started', async ($, on) => {
  const w = nativeWorld(on, 'https://ai.example.ts.net', { twinFail: true })
  const started = await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(started).toMatchObject({ cwd: '/proj' })
  expect(w.registered.map(a => a.name)).toEqual(BASES)
})

test('one twin registration failure leaves every other twin and the session intact, without leaking exception text', async ($, on) => {
  const w = nativeWorld(on, 'https://ai.example.ts.net', { failName: 'planner-codex' })
  const started = await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(started).toMatchObject({ cwd: '/proj' })
  expect(w.registered.map(a => a.name)).toEqual([...BASES, ...TWINS.filter(name => name !== 'planner-codex')])
  expect(w.logs).toEqual(['crew: Codex twin crew:planner-codex not registered (registration failed)'])
  expect(w.fetches).toEqual([])
})

test('the -codex section follows the registration: its own section after the main section, only behind a gateway base URL', async ($, on) => {
  nativeWorld(on, 'https://ai.example.ts.net')
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  const composed = await compose($, ['Agent', 'Read'])

  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'crew:main', 'crew:native-codex'])
  const lead = composed.sections[1]
  const twins = composed.sections[2]
  expect(lead?.text).not.toMatch(/codex/i)
  expect(twins?.scope).toBe('session')
  for (const name of TWINS) expect(twins?.text).toContain(`crew:${name}`)
  expect(twins?.text).toContain('gpt-6-astra')
  expect((await compose($, ['Agent', 'Read'])).sections[2]?.text).toBe(twins?.text)
})

test('no -codex section without a gateway base URL: the request gets the main section alone', async ($, on) => {
  nativeWorld(on, 'https://api.anthropic.com')
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:main'])
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

  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:main'])
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
    expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:main'])
  })
}

// --- Registration drives routing and the native section ---

test('twins refused by the host compose no native section and are not sent to Jev', async ($, on) => {
  const w = nativeWorld(on, 'https://ai.example.ts.net', { twinFail: true })
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(w.registered.map(a => a.name)).toEqual(BASES)
  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:main'])
  expect(w.logs.filter(line => line.includes('Codex twin crew:') && line.includes('not registered')).length).toBe(TWINS.length)
})

test('before session.start no native section, after it behind a gateway the section lists the twins', async ($, on) => {
  nativeWorld(on, 'https://ai.example.ts.net')
  on('prompt.compose', () => ({ sections: [] }))
  expect((await compose($, ['Agent'])).sections.map(section => section.id)).toEqual(['crew:main'])
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  const sections = (await compose($, ['Agent'])).sections
  expect(sections.map(section => section.id)).toEqual(['crew:main', 'crew:native-codex'])
  for (const name of TWINS) expect(sections[1]?.text).toContain(`crew:${name}`)
  expect(sections[0]?.text).not.toMatch(/codex/i)
})

// --- The crew mode: in codex, a plain specialist call goes to the same role's registered Codex twin ---

const CODEX_MODE = { options: { mode: 'codex' } }

const CODEX_MODE_JEV = { options: { jevKey: KEY, mode: 'codex' } }

const runMode = async ($: Engine, args: string) => (await $.command.run({ command: 'crew-mode', args } as never)).text

test('the mode option defaults to claude: a plain call stays on Claude, untouched, and the status line shows nothing', async ($, on) => {
  const { seen } = await twinWorld($, on)
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:digger', description: 'audit auth' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect([seen.fetches, seen.notices, seen.writes]).toEqual([[], [], []])
  expect(seen.statusLine).toEqual([undefined])
  expect(seen.commands).toEqual(['crew-mode', 'crew-hud'])
})

test('in the codex mode without Jev a plain call becomes its twin on high: tagged, noticed, confirmed, with no request', CODEX_MODE, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-luna' })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high', 'cx/gpt-6-luna-high')

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:digger-codex', model: 'cx/gpt-6-luna-high', description: 'audit auth · gpt-6-luna/high' })
  expect(seen.notices).toEqual(['crew:digger -> Codex (crew mode) · gpt-6-luna · high'])
  expect(seen.transcript).toEqual(['crew: audit auth: confirmed gpt-6-luna · high'])
  expect(seen.logs).toContain('crew mode: crew:digger -> crew:digger-codex')
  expect(seen.fetches).toEqual([])
  expect(seen.statusLine).toEqual(['crew: codex'])
})

test('in the codex mode Jev sizes the twin as its base role while the twin model stays fixed, and the record names the type asked for', CODEX_MODE_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on, { reply: async () => ok(answer(2.1)) })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:digger-codex', model: 'cx/gpt-6-luna-medium', description: 'audit auth · gpt-6-luna/medium' })
  expect(JSON.parse(seen.fetches[0]?.body ?? '{}').state.agent).toEqual({ type: 'digger', description: 'audit auth' })
  expect(seen.notices).toEqual(['crew:digger -> Codex (crew mode) · gpt-6-luna · medium (jev)'])
  expect(record(seen)).toMatchObject({ v: 4, agent: 'digger-codex', requested: 'crew:digger', provider: 'codex', bind: 'suffix', effortApplied: 'medium' })
})

test('in the codex mode every fixed-map role moves to its own twin', CODEX_MODE, async ($, on) => {
  const { seen } = await twinWorld($, on)
  for (const [i, role] of BASES.entries()) await $.agent.spawn(spawnInput({ subagentType: `crew:${role}`, tool_use_id: `tu${i}` }))
  expect(seen.spawned.map(spawned => [spawned.subagentType, spawned.model])).toEqual(
    Object.entries(CODEX_MODELS).map(([role, model]) => [`crew:${role}-codex`, `${CODEX_PREFIX}${model}-high`]),
  )
})

test('in the codex mode calls that may not move are untouched: explicit model, fork, workflow agent, teammate, a twin the main session named, another plugin\'s type', CODEX_MODE, async ($, on) => {
  const { seen } = await twinWorld($, on)
  const calls = [
    { model: 'opus' }, { fork: true }, { workflow: { runId: 'wf_1', agentIndex: 1 } }, { isTeammate: true },
    { subagentType: 'crew:challenger-codex' }, { subagentType: 'acme:digger' },
  ]
  for (const [i, over] of calls.entries()) await $.agent.spawn(spawnInput({ ...over, tool_use_id: `tu${i}` }))
  expect(seen.spawned.map(spawned => spawned.subagentType)).toEqual(['crew:digger', 'crew:digger', 'crew:digger', 'crew:digger', 'crew:challenger-codex', 'acme:digger'])
  expect(seen.spawned.map(spawned => spawned.description)).toEqual(Array(6).fill('audit auth'))
  expect([seen.fetches, seen.notices, seen.writes]).toEqual([[], [], []])
})

test('in the codex mode a role whose twin was refused stays on Claude while the others move', CODEX_MODE, async ($, on) => {
  const { seen } = await twinWorld($, on, { twinFail: name => name === 'digger-codex' })
  await $.agent.spawn(spawnInput())
  await $.agent.spawn(spawnInput({ subagentType: 'crew:challenger', tool_use_id: 'tu2' }))
  expect(seen.spawned.map(spawned => spawned.subagentType)).toEqual(['crew:digger', 'crew:challenger-codex'])
})

test('without registered twins the codex mode moves nothing and reads no mode', CODEX_MODE, async ($, on) => {
  const { seen } = jevWorld(on, { register: true })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:digger', description: 'audit auth' })
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
  expect(seen.spawned.map(spawned => spawned.subagentType)).toEqual(['crew:digger-codex', 'crew:digger'])
  expect(seen.statusLine).toEqual([undefined, 'crew: codex', undefined, 'crew: codex'])
})

test('a codex mode that the repository settings declare, or settings that cannot be read, start the session in claude', CODEX_MODE, async ($, on) => {
  const { seen } = await twinWorld($, on, { project: { pluginConfigs: { crew: { options: { mode: 'codex' } } } } })
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]?.subagentType).toBe('crew:digger')
  expect(seen.statusLine).toEqual([undefined])
  expect(seen.logs).toContain('crew: the session starts in claude: the repository settings declare the mode, or cannot be read')
})

test('settings that cannot be read start a codex-option session in claude too', CODEX_MODE, async ($, on) => {
  const { seen } = await twinWorld($, on, { settingsFail: true })
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]?.subagentType).toBe('crew:digger')
})

test('a fresh activation has no mode before session.start: a plain call stays on Claude', CODEX_MODE, async ($, on) => {
  const { seen } = jevWorld(on, { env: GATEWAY, register: true })
  await $.agent.spawn(spawnInput())
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:digger', description: 'audit auth' })
})

test('a switched call without a key says once that no record was written, not again at its confirmation', CODEX_MODE, async ($, on) => {
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-luna' })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high', 'cx/gpt-6-luna-high')
  expect(seen.logs.filter(line => line.includes('no trusted home'))).toEqual(['crew: decision not logged (no trusted home)'])
  expect(seen.writes).toEqual([])
})

// --- Twins on the Codex login: crew answers their steps itself, with no gateway ---

const LOGIN = { options: { codexLogin: true } }

const LOGIN_NOW = Date.parse('2026-10-12T12:00:00Z')

type LoginOptions = Parameters<typeof jevWorld>[1] & { messages?: () => unknown[] }

/** The session started with a ready helper and the subagent conversation beneath the plugin. */

async function loginWorld($: Engine, on: On, o: LoginOptions = {}) {
  const world = jevWorld(on, {
    register: true,
    files: {},
    helper: async call => ok(JSON.stringify(call.url.endsWith('/status')
      ? { status: 'ok', codex: true, login: true, roles: BASES }
      : call.url.endsWith('/start') ? { status: 'started' }
        : { status: 'ok', turn: 'completed', text: 'auth is at src/auth.ts:12', files: [], commands: [], declined: 0, error: null })),
    agents: [{ id: 'cr1', type: 'crew:planner-codex', description: 'find auth' }],
    now: () => LOGIN_NOW,
    ...o,
  })
  on('session.messages', () => ({ value: o.messages?.() ?? [{ role: 'user', content: [{ type: 'text', text: 'where is auth?' }] }] }) as never)
  on('tool.list', () => ({ value: [{ name: 'Read', description: 'Reads a file.', mcp: false }, { name: 'Grep', description: 'Searches files.', mcp: false }] }) as never)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  return world
}

/** One step through the plugin: what it yielded, and what it returned. */

async function stepThrough($: Engine, agentId: string | undefined, model = 'cx/gpt-6-astra', effort: string | undefined = 'high') {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 1, ...(effort ? { effort } : {}), ...(agentId ? { agentId } : {}) } as never)
  const chunks: unknown[] = []
  let item = await stream.next()
  while (!item.done) {
    chunks.push(item.value)
    item = await stream.next()
  }
  return { chunks, result: item.value }
}

const helperStarts = (seen: Seen) => seen.helper.filter(call => call.url.endsWith('/start')).map(call => JSON.parse(call.body ?? '{}'))

test('with codexLogin and a ready helper every twin registers on its Codex id and is described as on the login', LOGIN, async ($, on) => {
  const { seen } = await loginWorld($, on)
  expect(seen.registered.filter(agent => agent.name.endsWith('-codex'))).toEqual(
    Object.entries(CODEX_MODELS).map(([role, model]) => ({ name: `${role}-codex`, model: `cx/${model}`, description: `crew:${role} on ${model} (OpenAI, on your Codex login): same job.` })),
  )
  expect(seen.fetches).toEqual([])
})

test('a step of the twin on the login is answered by the helper without reaching the API or reading credentials', LOGIN, async ($, on) => {
  const { seen } = await loginWorld($, on)
  const { chunks, result } = await stepThrough($, 'cr1')
  expect(seen.steps).toEqual([])
  expect(seen.fetches).toEqual([])
  expect(seen.reads.some(path => path.endsWith('/.codex/auth.json'))).toBe(false)
  expect(helperStarts(seen)[0]).toMatchObject({ role: 'planner', model: 'gpt-6-astra', effort: 'high', prompt: 'where is auth?' })
  expect(chunks[0]).toEqual({ kind: 'text', index: 0, text: 'auth is at src/auth.ts:12' })
  expect(result).toEqual({ turnId: 't1', index: 0, answer: 'auth is at src/auth.ts:12', toolUses: [], stopReason: 'end_turn', usage: null })
})

test('a final answer of the planner twin is handed back through SubagentHandback when the conversation names it', LOGIN, async ($, on) => {
  const reminder = 'SubagentHandback: when your work is complete, call SubagentHandback({message: <your full report>}).'
  await loginWorld($, on, { messages: () => [{ role: 'user', content: [{ type: 'text', text: `where is auth?\n<system-reminder>${reminder}</system-reminder>` }] }] })
  const { result } = await stepThrough($, 'cr1')

  expect(result).toMatchObject({
    answer: '',
    stopReason: 'tool_use',
    toolUses: [{ name: 'SubagentHandback', input: { message: 'auth is at src/auth.ts:12' } }],
  })
})

test('the spawn\'s effort suffix decides the effort sent to Codex, before the host\'s', LOGIN, async ($, on) => {
  const { seen } = await loginWorld($, on)
  await stepThrough($, 'cr1', 'cx/gpt-6-astra-medium', 'high')
  await stepThrough($, 'cr1', 'cx/gpt-6-astra', 'max')
  expect(helperStarts(seen).map(start => start.effort)).toEqual(['medium', 'high'])
})

test('steps of the main loop, a Claude role, a twin on the gateway and an agent the list cannot name go on to the API', LOGIN, async ($, on) => {
  const { seen } = await loginWorld($, on, {
    env: GATEWAY,
    helper: async () => ok(JSON.stringify({ status: 'ok', codex: false, login: false })),
    agents: [
      { id: 'cr1', type: 'crew:planner-codex', description: 'a' },
      { id: 'c1', type: 'crew:planner', description: 'b' },
      { id: 'd1', type: 'crew:digger-codex', description: 'c' },
    ],
  })
  for (const agentId of [undefined, 'c1', 'd1', 'unknown']) await stepThrough($, agentId, 'sonnet')
  expect(seen.steps).toHaveLength(4)
  expect(seen.fetches).toEqual([])
  // Without a ready helper every twin uses the gateway.
  expect(seen.registered.filter(agent => agent.name.endsWith('-codex')).map(agent => [agent.name, agent.description.includes('Codex login')])).toEqual(
    TWINS.map(name => [name, false]),
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

test('in the codex mode a plain planner call runs on its login twin and its helper step has no usage confirmation', { options: { codexLogin: true, mode: 'codex' } }, async ($, on) => {
  const { seen } = await loginWorld($, on, { agents: [{ id: 'a1', type: 'crew:planner-codex', description: 'audit auth' }] })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:planner' }))
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:planner-codex', model: 'cx/gpt-6-astra-high' })
  await stepThrough($, 'a1', 'cx/gpt-6-astra-high')
  expect(seen.steps).toEqual([])
  expect(seen.transcript).toEqual([])
  expect(helperStarts(seen)[0].effort).toBe('high')
})

test('an explicit twin teammate keeps the same Jev effort-only routing in the codex mode', CODEX_MODE_JEV, async ($, on) => {
  const { seen } = await twinWorld($, on)
  await $.agent.spawn(spawnInput({ subagentType: 'crew:digger-codex', isTeammate: true }))
  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:digger-codex', model: 'cx/gpt-6-luna-medium' })
  expect(seen.fetches).toHaveLength(1)
})

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

test('HUD records the twin a codex-mode switch chose, its sent suffix effort and the observed model', CODEX_MODE_JEV, async ($, on) => {
  const world = await twinWorld($, on, { stepModel: 'gpt-6-luna', reply: async () => ok(answer(2.1)) })
  await $.agent.spawn(spawnInput())
  const pane = await $.ui.mount(hudPane())
  expect(await pane.find({ type: 'Text', text: /·codex/ })).toBeDefined()
  await step($, 'a1', 'high', 'cx/gpt-6-luna-medium')
  expect(await pane.find({ type: 'Text', text: /gpt-6-luna · medium/ })).toBeDefined()
  await pane.unmount()
  expect(record(world.seen, 0)).toMatchObject({ requested: 'crew:digger', effortApplied: 'medium', ran: null })
  expect(record(world.seen, 1)).toMatchObject({ ran: { model: 'gpt-6-luna', effort: 'medium' } })
})

test('HUD observes a step the Codex login answers without changing its result, and never sends it to the API', LOGIN, async ($, on) => {
  const values = hudCapture(on)
  const { seen } = await loginWorld($, on, { spawn: async () => ({ model: 'cx/gpt-6-astra', agentId: 'cr1' }) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:planner-codex' }))
  const { result } = await stepThrough($, 'cr1')
  await pause()
  expect(seen.steps).toEqual([])
  expect(seen.fetches).toEqual([])
  expect(result).toEqual({
    turnId: 't1', index: 0, answer: 'auth is at src/auth.ts:12', toolUses: [], stopReason: 'end_turn',
    usage: null,
  })
  expect(values.agents).toMatchObject([{ type: 'crew:planner-codex', effort: 'high', status: 'running' }])
  expect((values.agents as CrewAgent[])[0]?.observedModel).toBeUndefined()
})

test('HUD never writes the crew mode or the status line', CODEX_MODE, async ($, on) => {
  let tracking = false
  const writes: string[] = []
  on('state.set', (_$, e, next) => (tracking && writes.push(e.key), next(e)))
  on('turn.complete', () => ({ text: 'done' }))
  const { seen } = await twinWorld($, on, { stepModel: 'gpt-6-luna' })
  const statusBefore = [...seen.statusLine]
  tracking = true
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high', 'cx/gpt-6-luna-high')
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await pause()
  expect(writes.length).toBeGreaterThan(0)
  expect(writes).not.toContain('mode')
  expect(seen.statusLine).toEqual(statusBefore)
})
