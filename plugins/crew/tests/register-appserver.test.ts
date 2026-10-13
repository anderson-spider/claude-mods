import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { GATEWAY, ROOT, jevWorld, ok } from './host'
import type { Replies } from './host'

// The digger twin runs on the crew Codex helper: registration needs the helper ready, and a step is one turn.

const LOGIN = { options: { codexLogin: true } }

const STATUS = { status: 'ok', version: '0.7.0', pid: 1, jobs: 0, threads: 0, codex: true, login: true, roles: ['challenger', 'digger', 'planner'] }
/** A helper from before the planner and challenger lanes: its status has no `roles`. */
const { roles: _roles, ...OLD_STATUS } = STATUS
const DONE = { status: 'ok', turn: 'completed', text: 'the flag is parsed at a.ts:3', files: [], commands: [{ command: 'git log -3', status: 'completed', exitCode: 0 }], declined: 0, error: null }

const json = (value: unknown) => ok(JSON.stringify(value))

type HelperOptions = { messages?: () => unknown[]; handback?: boolean; status?: unknown; start?: unknown; poll?: unknown | unknown[]; down?: boolean; env?: Record<string, string> }

/** The helper's switch: a test sets `down` after the session started, as when the helper stops later. */
const helperState = { down: false }

/** The session started on the login with the helper behind its socket, and the conversation of one digger twin. */
async function helperWorld($: Engine, on: On, o: HelperOptions = {}, agent = { id: 'd1', type: 'crew:digger-codex', description: 'find it' }) {
  const polls = Array.isArray(o.poll) ? [...o.poll] : [o.poll ?? DONE]
  const runs: string[][] = []
  helperState.down = o.down === true
  const helper: Replies = async call => {
    if (helperState.down) throw new Error('connect ENOENT')
    const route = call.url.replace('http://crew-codex', '')
    if (route === '/status') return json(o.status ?? STATUS)
    if (route === '/start') return json(o.start ?? { status: 'started' })
    if (route === '/poll') return json(polls.length > 1 ? polls.shift() : polls[0])
    return json({ status: 'ok', interrupted: true })
  }
  const world = jevWorld(on, { register: true, files: {}, env: o.env, agents: [agent], helper })
  on('process.run', (_$, e) => (runs.push([...e.argv]), { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('session.messages', () => ({ value: o.messages?.() ?? [{ role: 'user', content: [{ type: 'text', text: 'where is the flag parsed' }] }] }) as never)
  on('tool.list', () => ({ value: o.handback ? [{ name: 'SubagentHandback', description: 'Hand back.', mcp: false }] : [] }) as never)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  return { ...world, runs }
}

async function stepThrough($: Engine, agentId: string, model = 'cx/gpt-6-luna', effort: string | undefined = 'high') {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 1, ...(effort ? { effort } : {}), agentId } as never)
  const chunks: unknown[] = []
  let item = await stream.next()
  while (!item.done) {
    chunks.push(item.value)
    item = await stream.next()
  }
  return { chunks, result: item.value }
}

const names = (seen: { registered: { name: string }[] }) => seen.registered.filter(agent => agent.name.endsWith('-codex')).map(agent => agent.name)

test('with the helper ready, digger-codex registers on the login beside the planner and challenger twins, with no gateway', LOGIN, async ($, on) => {
  const { seen } = await helperWorld($, on)

  expect(names(seen)).toEqual(['planner-codex', 'challenger-codex', 'digger-codex'])
  expect(seen.registered.filter(agent => agent.name === 'digger-codex')[0]).toMatchObject({
    model: 'cx/gpt-6-luna',
    description: 'crew:digger on gpt-6-luna (OpenAI, on your Codex login): same job.',
  })
  expect(seen.helper.map(call => call.url)).toEqual(['http://crew-codex/status'])
  expect(seen.fetches).toEqual([])
})

test('without the helper no twin registers on the login, and one debug line says why', LOGIN, async ($, on) => {
  const { seen } = await helperWorld($, on, { down: true })

  expect(names(seen)).toEqual([])
  expect(seen.logs.filter(line => line.includes('not on the helper'))).toEqual([
    'crew: the helper twins are not on the helper: the crew Codex helper is not running (run plugins/crew/helper/install.sh)',
  ])
})

test('a running helper from before the planner and challenger lanes serves only the digger', LOGIN, async ($, on) => {
  const { seen } = await helperWorld($, on, { status: { ...OLD_STATUS, version: '0.5.1' } })
  expect(names(seen)).toEqual(['digger-codex'])
  expect(seen.logs.filter(line => line.includes('no lane for every twin'))).toHaveLength(1)
  expect(seen.helper.some(call => call.url.endsWith('/start'))).toBe(false)
  expect(seen.fetches).toEqual([])
})

for (const [label, status] of [['no codex binary', { ...STATUS, codex: false }], ['no Codex login', { ...STATUS, login: false }]] as const) {
  test(`a helper with ${label} does not take the twins`, LOGIN, async ($, on) => {
    const { seen } = await helperWorld($, on, { status })

    expect(names(seen)).toEqual([])
    expect(seen.logs.some(line => line.includes('not on the helper'))).toBe(true)
  })
}

test('behind a gateway an unready helper leaves every twin on the gateway', LOGIN, async ($, on) => {
  const { seen } = await helperWorld($, on, { down: true, env: GATEWAY })

  expect(names(seen)).toEqual(['planner-codex', 'challenger-codex', 'digger-codex'])
  for (const agent of seen.registered.filter(agent => agent.name.endsWith('-codex'))) expect(agent.description).toContain('through the session')
})

test('the option off asks the helper nothing', { options: {} }, async ($, on) => {
  const { seen } = await helperWorld($, on)

  expect(seen.helper).toEqual([])
  expect(names(seen)).toEqual([])
})

test('a step of the digger twin is one turn on the helper: the request, the polls, the text; nothing goes to the API or the backend', LOGIN, async ($, on) => {
  const { seen, runs } = await helperWorld($, on, { poll: [{ status: 'running', seconds: 1 }, DONE] })
  const { chunks, result } = await stepThrough($, 'd1', 'cx/gpt-6-luna-medium', 'high')

  const start = JSON.parse(seen.helper.find(call => call.url.endsWith('/start'))?.body ?? '{}')
  expect(start).toMatchObject({ caller: 'd1', role: 'digger', repo: ROOT, model: 'gpt-6-luna', effort: 'medium', prompt: 'where is the flag parsed' })
  expect(start.instructions).toContain('Investigate the question')
  expect(start.instructions).toContain(`Repository: ${ROOT}.`)
  expect(start.instructions).toContain('The sandbox lets you write in the repository and the temporary directories, and commands have the network')
  expect(JSON.stringify(seen.helper.map(call => call.headers))).not.toContain('Authorization')
  expect(seen.steps).toEqual([])
  expect(seen.fetches).toEqual([])
  expect(runs.filter(argv => argv[0] === 'sleep')).toHaveLength(1)
  const text = 'the flag is parsed at a.ts:3'
  expect(chunks[0]).toEqual({ kind: 'text', index: 0, text })
  expect(result).toEqual({ turnId: 't1', index: 0, answer: text, toolUses: [], stopReason: 'end_turn', usage: null })
})

for (const role of ['planner', 'challenger'] as const) {
  test(`with the helper ready the ${role} twin runs on it: one turn per step, the same caller and thread for a follow-up, nothing to the API or the backend`, LOGIN, async ($, on) => {
    const { seen } = await helperWorld($, on, {}, { id: 'r1', type: `crew:${role}-codex`, description: 'think' })
    const first = await stepThrough($, 'r1', 'cx/gpt-6-astra-high', 'high')
    await stepThrough($, 'r1', 'cx/gpt-6-astra-high', 'high')

    const starts = seen.helper.filter(call => call.url.endsWith('/start')).map(call => JSON.parse(call.body ?? '{}'))
    expect(starts).toHaveLength(2)
    expect(starts[0]).toMatchObject({ caller: 'r1', role, repo: ROOT, model: 'gpt-6-astra', effort: 'high', prompt: 'where is the flag parsed' })
    expect(starts[1]).toMatchObject({ caller: 'r1', role })
    expect(starts[0].instructions).toContain(`Repository: ${ROOT}.`)
    expect(starts[0].instructions).toContain('The sandbox lets you write in the repository')
    expect(JSON.stringify(seen.helper.map(call => call.headers))).not.toContain('Authorization')
    expect(first.result).toMatchObject({ answer: 'the flag is parsed at a.ts:3', toolUses: [], usage: null })
    expect(seen.steps).toEqual([])
    expect(seen.fetches).toEqual([])
  })
}

test('a helper that fails the turn answers the step with the reason, never a throw', LOGIN, async ($, on) => {
  const { seen } = await helperWorld($, on, { poll: { ...DONE, turn: 'failed', error: 'boom' } })
  const { result } = await stepThrough($, 'd1')

  expect(result).toMatchObject({ answer: 'crew: this Codex twin could not run: the Codex turn failed: boom.', toolUses: [], usage: null })
  expect(seen.steps).toEqual([])
})

test('a helper that stops after registration answers the step with a reason, and the request never reaches the API', LOGIN, async ($, on) => {
  const { seen } = await helperWorld($, on)
  helperState.down = true
  const { result } = await stepThrough($, 'd1')

  expect(result).toMatchObject({ answer: expect.stringContaining('install.sh'), toolUses: [], usage: null })
  expect(seen.steps).toEqual([])
  expect(seen.fetches).toEqual([])
})

test('where the host runs the agent as a subagent the answer goes through SubagentHandback, not as plain text', LOGIN, async ($, on) => {
  const { seen } = await helperWorld($, on, { handback: true })
  const { chunks, result } = await stepThrough($, 'd1')
  const message = 'the flag is parsed at a.ts:3'

  expect(chunks).toEqual([
    { kind: 'tool', index: 0, id: 'crew_handback_t1_0', name: 'SubagentHandback' },
    { kind: 'input', index: 0, json: JSON.stringify({ message }) },
    { kind: 'stop', stopReason: 'tool_use', usage: null },
  ])
  expect(result).toEqual({ turnId: 't1', index: 0, answer: '', toolUses: [{ name: 'SubagentHandback', input: { message } }], stopReason: 'tool_use', usage: null })
  expect(seen.steps).toEqual([])
})

test('a failure is handed back the same way, so the main session reads why', LOGIN, async ($, on) => {
  await helperWorld($, on, { handback: true })
  helperState.down = true
  const { result } = await stepThrough($, 'd1')

  expect(result).toMatchObject({ stopReason: 'tool_use', toolUses: [{ name: 'SubagentHandback', input: { message: expect.stringContaining('could not run') } }] })
})

test('a step the host asks for after the answer was handed back does not run the task again', LOGIN, async ($, on) => {
  const { seen } = await helperWorld($, on, {
    handback: true,
    messages: () => [
      { role: 'user', content: [{ type: 'text', text: 'add the flag' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'crew_handback_t1_0', name: 'SubagentHandback', input: { message: 'done' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'crew_handback_t1_0', content: 'refused' }] },
    ],
  })
  const { result } = await stepThrough($, 'd1')

  expect(result).toMatchObject({ answer: 'done', toolUses: [], stopReason: 'end_turn' })
  expect(seen.helper.filter(call => call.url.endsWith('/start'))).toEqual([])
})

test('a follow-up merged into the handback result\'s message is a new request and runs', LOGIN, async ($, on) => {
  const { seen } = await helperWorld($, on, {
    handback: true,
    messages: () => [
      { role: 'user', content: [{ type: 'text', text: 'add the flag' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'crew_handback_t1_0', name: 'SubagentHandback', input: { message: 'done' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'crew_handback_t1_0', content: 'Report delivered.' }, { type: 'text', text: 'which file did you change?' }] },
    ],
  })
  await stepThrough($, 'd1')

  expect(JSON.parse(seen.helper.find(call => call.url.endsWith('/start'))?.body ?? '{}').prompt).toBe('which file did you change?')
})
