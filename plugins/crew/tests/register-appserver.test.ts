import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { GATEWAY, ROOT, jevWorld, ok } from './host'
import type { Replies } from './host'

// The developer and architect twins run on the crew Codex helper: registration needs the helper ready, and a step is one turn.

const LOGIN = { options: { codexLogin: true } }

const STATUS = { status: 'ok', version: '0.1.0', pid: 1, jobs: 0, threads: 0, codex: true, login: true }
const DONE = { status: 'ok', turn: 'completed', text: 'implemented it', files: [{ status: 'completed', paths: [`${ROOT}/a.ts`] }], commands: [], declined: 0, error: null }

const json = (value: unknown) => ok(JSON.stringify(value))

type HelperOptions = { status?: unknown; start?: unknown; poll?: unknown | unknown[]; down?: boolean; env?: Record<string, string> }

/** The helper's switch: a test sets `down` after the session started, as when the helper stops later. */
const helperState = { down: false }

/** The session started on the login with the helper behind its socket, and the conversation of one developer twin. */
async function helperWorld($: Engine, on: On, o: HelperOptions = {}, agent = { id: 'd1', type: 'crew:developer-codex', description: 'build it' }) {
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
  on('session.messages', () => ({ value: [{ role: 'user', content: [{ type: 'text', text: 'add the flag' }] }] }) as never)
  on('tool.list', () => ({ value: [] }) as never)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  return { ...world, runs }
}

async function stepThrough($: Engine, agentId: string, model = 'cx/gpt-6-sol', effort: string | undefined = 'medium') {
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

test('with the helper ready, developer-codex and architect-codex register on the login beside the code-reader twin, with no gateway', LOGIN, async ($, on) => {
  const { seen } = await helperWorld($, on)

  expect(names(seen)).toEqual(['code-reader-codex', 'developer-codex', 'architect-codex'])
  expect(seen.registered.filter(agent => agent.name === 'developer-codex')[0]).toMatchObject({
    model: 'cx/gpt-6-sol',
    description: 'crew:developer on gpt-6-sol (OpenAI, on your Codex login): same job, tools and write lane.',
  })
  expect(seen.helper.map(call => call.url)).toEqual(['http://crew-codex/status'])
  expect(seen.fetches).toEqual([])
})

test('without the helper only the code-reader twin registers, and one debug line says why', LOGIN, async ($, on) => {
  const { seen } = await helperWorld($, on, { down: true })

  expect(names(seen)).toEqual(['code-reader-codex'])
  expect(seen.logs.filter(line => line.includes('not on the Codex login'))).toEqual([
    'crew: the developer and architect twins are not on the Codex login: the crew Codex helper is not running (run plugins/crew/helper/install.sh)',
  ])
})

for (const [label, status] of [['no codex binary', { ...STATUS, codex: false }], ['no Codex login', { ...STATUS, login: false }]] as const) {
  test(`a helper with ${label} does not take the twins`, LOGIN, async ($, on) => {
    const { seen } = await helperWorld($, on, { status })

    expect(names(seen)).toEqual(['code-reader-codex'])
    expect(seen.logs.some(line => line.includes('not on the Codex login'))).toBe(true)
  })
}

test('behind a gateway an unready helper leaves developer and architect on the gateway', LOGIN, async ($, on) => {
  const { seen } = await helperWorld($, on, { down: true, env: GATEWAY })

  expect(names(seen)).toEqual(['code-reader-codex', 'research-codex', 'designer-codex', 'developer-codex', 'architect-codex'])
  expect(seen.registered.filter(agent => agent.name === 'developer-codex')[0]?.description).toContain('through the session')
})

test('the option off asks the helper nothing', { options: {} }, async ($, on) => {
  const { seen } = await helperWorld($, on)

  expect(seen.helper).toEqual([])
  expect(names(seen)).toEqual([])
})

test('a step of the developer twin is one turn on the helper: the request, the polls, the text; nothing goes to the API or the backend', LOGIN, async ($, on) => {
  const { seen, runs } = await helperWorld($, on, { poll: [{ status: 'running', seconds: 1 }, DONE] })
  const { chunks, result } = await stepThrough($, 'd1', 'cx/gpt-6-sol-high', 'medium')

  const start = JSON.parse(seen.helper.find(call => call.url.endsWith('/start'))?.body ?? '{}')
  expect(start).toMatchObject({ caller: 'd1', role: 'developer', repo: ROOT, model: 'gpt-6-sol', effort: 'high', prompt: 'add the flag' })
  expect(start.instructions).toContain('Implement the spec')
  expect(start.instructions).toContain(`Repository: ${ROOT}.`)
  expect(JSON.stringify(seen.helper.map(call => call.headers))).not.toContain('Authorization')
  expect(seen.steps).toEqual([])
  expect(seen.fetches).toEqual([])
  expect(runs.filter(argv => argv[0] === 'sleep')).toHaveLength(1)
  const text = `implemented it\n\n(crew: files changed: ${ROOT}/a.ts)`
  expect(chunks[0]).toEqual({ kind: 'text', index: 0, text })
  expect(result).toEqual({ turnId: 't1', index: 0, answer: text, toolUses: [], stopReason: 'end_turn', usage: null })
})

test('the architect twin runs as architect, and its instructions place it in .crew', LOGIN, async ($, on) => {
  const { seen } = await helperWorld($, on, {}, { id: 'r1', type: 'crew:architect-codex', description: 'audit' })
  await stepThrough($, 'r1', 'cx/gpt-6-astra')
  const start = JSON.parse(seen.helper.find(call => call.url.endsWith('/start'))?.body ?? '{}')

  expect(start).toMatchObject({ caller: 'r1', role: 'architect', model: 'gpt-6-astra' })
  expect(start.instructions).toContain(`${ROOT}/.crew`)
})

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
