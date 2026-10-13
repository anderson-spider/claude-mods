import { expect, test } from 'claude-code/testing'
import { dispatch, NOT_IN_HERDR } from '../hooks/team'
import type { TeamIo } from '../hooks/team'
import { agents, fail, fakeRun, ok, text } from './fake-run'
import type { Rule } from './fake-run'
import { createBreaker, createGate, JEV_DEADLINE_MS, JEV_URL, SLOT_HOLD_MS } from '../hooks/jev'
import type { JevInit } from '../hooks/jev'
import { JEV_MODEL } from '../hooks/effort'
import { SPECS } from '../hooks/roles'

const ENV: Record<string, string> = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1', HOME: '/home/u' }

function io(rules: Rule[], env: Record<string, string | undefined> = ENV) {
  const { run, calls } = fakeRun([[['mkdir'], text('')], ...rules])
  const writes: { path: string; text: string }[] = []
  const logs: string[] = []
  let clock = 1_000
  const team: TeamIo = {
    run,
    env: async () => ({ HERDR_ENV: env.HERDR_ENV, HERDR_WORKSPACE_ID: env.HERDR_WORKSPACE_ID, HOME: env.HOME, JEV_API_KEY: env.JEV_API_KEY }),
    settings: async () => undefined,
    jev: { fetch: async () => { throw new Error('unexpected fetch') }, timer: () => () => {}, now: () => clock },
    breaker: createBreaker(() => clock),
    gate: createGate(),
    root: async () => '/repo',
    now: async () => (clock += 5),
    write: async (path, body) => { writes.push({ path, text: body }) },
    log: line => { logs.push(line) },
  }
  return { team, calls, writes, logs }
}

const freshTeam: Rule[] = [agents([]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'w1:p7' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]]

test('outside Herdr the tool says it cannot be used and runs nothing, writes nothing', async () => {
  for (const env of [{ ...ENV, HERDR_ENV: undefined }, { ...ENV, HERDR_ENV: '0' }]) {
    const world = io(freshTeam, env)
    expect(await dispatch(world.team, { role: 'analyst', task: 't', slug: 'a' })).toEqual({ ok: false, text: NOT_IN_HERDR })
    expect(world.calls).toEqual([])
    expect(world.writes).toEqual([])
  }
})

test('an analyst task starts the analyst in the reports directory, read-only on the repository, with its default effort', async () => {
  const world = io(freshTeam)
  const answer = await dispatch(world.team, { role: 'analyst', task: 'Find X', slug: 'find-x' })

  expect(answer.ok).toBe(true)
  expect(answer.text).toContain('delivery: confirmed')
  expect(answer.text).toContain('report: /home/u/.claude/codex-team/reports/repo/find-x-analyst.md')
  const start = world.calls.find(call => call[2] === 'start')!
  expect(start.slice(0, 4)).toEqual(['herdr', 'agent', 'start', 'analyst'])
  expect(start).toContain('gpt-6-luna')
  expect(start).toContain('model_reasoning_effort="medium"')
  expect(start).toContain('service_tier="priority"')
  expect(start).toContain('sandbox_workspace_write.writable_roots=[]')
  const tab = world.calls.find(call => call[2] === 'create')!
  expect(tab).toContain('/home/u/.claude/codex-team/reports')
  const prompt = world.calls.find(call => call[2] === 'prompt')![4]
  expect(prompt).toContain('Repository: /repo.')
  expect(prompt).toContain('Find X')
  expect(prompt).toContain('/home/u/.claude/codex-team/reports/repo/find-x-analyst.md')
})

test('the developer works in its worktree and may write only there and in the reports, never in the git directory', async () => {
  const world = io([
    [['git', '-C', '/wt/feat', 'rev-parse', '--show-toplevel'], text('/wt/feat\n')],
    ...freshTeam,
  ])
  const answer = await dispatch(world.team, { role: 'developer', task: 'Build', slug: 'feat', cwd: '/wt/feat', effort: 'xhigh' })

  expect(answer.text).toContain('agent: dev-feat')
  expect(answer.text).toContain('effort xhigh (pinned)')
  const start = world.calls.find(call => call[2] === 'start')!
  expect(start).toContain('sandbox_workspace_write.writable_roots=["/home/u/.claude/codex-team/reports"]')
  expect(world.calls.some(call => call.includes('--git-common-dir'))).toBe(false)
  expect(start).toContain('gpt-6.1-sol')
})

test('the developer is refused without a worktree of its own', async () => {
  const cases: [unknown, Rule[], string][] = [
    [undefined, [], 'the developer needs `cwd`'],
    ['relative/dir', [], 'the developer needs `cwd`'],
    ['/wt/x', [[['git'], fail('not_git')]], 'not a git working tree'],
    ['/repo', [[['git', '-C', '/repo', 'rev-parse', '--show-toplevel'], text('/repo\n')]], 'the repository itself'],
  ]
  for (const [cwd, rules, message] of cases) {
    const world = io(rules)
    const answer = await dispatch(world.team, { role: 'developer', task: 't', slug: 's', cwd })
    expect(answer.ok).toBe(false)
    expect(answer.text).toContain(message)
    expect(world.calls.some(call => call[0] === 'herdr')).toBe(false)
  }
})

test('bad input is refused before Herdr is asked anything', async () => {
  for (const [call, message] of [
    [{ role: 'qa', task: 't', slug: 's' }, 'role must be one of'],
    [{ role: 'analyst', task: '  ', slug: 's' }, 'task is empty'],
    [{ role: 'analyst', task: 't', slug: 'Bad Slug' }, 'slug must be'],
    [{ role: 'analyst', task: 't', slug: 'x'.repeat(29) }, 'slug must be'],
    [{ role: 'analyst', task: 't', slug: 's', effort: 'max' }, 'effort must be one of'],
  ] as const) {
    const world = io(freshTeam)
    expect((await dispatch(world.team, call)).text).toContain(message)
    expect(world.calls).toEqual([])
  }
})

test('the decision is logged as unknown before the prompt and with the outcome after, never with the task text', async () => {
  const world = io(freshTeam)
  await dispatch(world.team, { role: 'architect', task: 'Secret plan for /Users/me/x', slug: 'plan' })

  expect(world.writes).toHaveLength(2)
  const [before, after] = world.writes.map(write => JSON.parse(write.text))
  expect(world.writes[0]?.path).toMatch(/^\/home\/u\/\.claude\/codex-team\/decisions\/.+-architect\.json$/)
  expect(before.promptStatus).toBe('unknown')
  expect(before.effortApplied).toBe(true)
  expect(after.effortApplied).toBe(true)
  expect(after).toMatchObject({ v: 2, role: 'architect', agent: 'architect', model: 'gpt-6.1-sol', effort: 'high', source: 'default', jevReason: 'no-key', expected: null, started: true, promptStatus: 'confirmed', reason: null })
  for (const write of world.writes) {
    expect(write.text).not.toContain('Secret')
    expect(write.text).not.toContain('/Users/me')
  }
})

test('a delivery that may have reached the agent says not to resend; one that did not says to fix and retry', async () => {
  const unknown = io([agents([{ name: 'analyst', pane_id: 'p', agent_status: 'idle' }]), [['herdr', 'agent', 'prompt'], fail('agent_prompt_stalled')]])
  const said = await dispatch(unknown.team, { role: 'analyst', task: 't', slug: 's' })
  expect(said.text).toContain('delivery: unknown (agent_prompt_stalled)')
  expect(said.text).toContain('do not send it again')

  const busy = io([agents([{ name: 'analyst', pane_id: 'p', agent_status: 'working' }])])
  const refused = await dispatch(busy.team, { role: 'analyst', task: 't', slug: 's' })
  expect(refused).toEqual({ ok: false, text: expect.stringContaining('delivery: not_sent (agent busy)') })
})

test('a failed log write is one debug line and does not change the answer', async () => {
  const world = io(freshTeam)
  world.team.write = async () => { throw new Error('disk full') }
  expect((await dispatch(world.team, { role: 'analyst', task: 't', slug: 's' })).text).toContain('delivery: confirmed')
  expect(world.logs).toContain('codex-team: decision not logged (write failed)')
})

const KEY = ['test-', 'private', '-credential'].join('')
const TASK = 'Investigate confidential component and its invariants'
const assessedBody = (difficulty: Record<string, number>, duration: Record<string, number>, scope: Record<string, number>) => JSON.stringify({
  model: 'untrusted-server-model',
  answers: { difficulty: { probabilities: difficulty }, duration: { probabilities: duration }, scope: { probabilities: scope } },
})
const POINT = assessedBody({ '0': 1 }, { '0': 1 }, { '0': 1 })

function assessedWorld(over: { key?: string; status?: number; body?: string; throws?: boolean; never?: boolean } = {}) {
  const world = io([[['git'], text('/wt/task\n')], ...freshTeam], { ...ENV, JEV_API_KEY: 'key' in over ? over.key : KEY })
  const requests: { url: string; init: JevInit }[] = []
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
  world.team.jev = {
    now: () => 0,
    fetch: async (url, init) => {
      requests.push({ url, init })
      if (over.never) return new Promise(() => {})
      if (over.throws) throw new Error(`${KEY} ${TASK}`)
      return { status: over.status ?? 200, text: over.body ?? POINT }
    },
    timer: (ms, fn) => {
      const timer = { ms, fn, cancelled: false }
      timers.push(timer)
      if (ms !== JEV_DEADLINE_MS && ms !== SLOT_HOLD_MS) void Promise.resolve().then(() => { if (!timer.cancelled) fn() })
      return () => { timer.cancelled = true }
    },
  }
  return { ...world, requests, timers }
}

const call = (role: 'developer' | 'analyst' | 'architect' = 'analyst') => ({ role, task: TASK, slug: 'assess', cwd: '/wt/task' })
function privateOutputs(world: ReturnType<typeof assessedWorld>, answer: { text: string }) {
  const output = JSON.stringify([world.writes.map(w => w.text), world.logs, answer.text])
  expect(output).not.toContain(KEY)
  expect(output).not.toContain(TASK)
}

test('Jev effort choices reach each role start flag, answer and v2 records', async () => {
  for (const role of ['developer', 'architect', 'analyst'] as const) {
    const cases = role === 'analyst'
      ? [[0, 0, 0, 'low'], [0, 1, 0, 'medium'], [4, 3, 3, 'high']] as const
      : [[0, 0, 0, 'medium'], [3, 1, 2, 'high'], [4, 3, 3, 'xhigh']] as const
    for (const [difficulty, duration, scope, effort] of cases) {
      const world = assessedWorld({ body: assessedBody({ [difficulty]: 1 }, { [duration]: 1 }, { [scope]: 1 }) })
      const answer = await dispatch(world.team, call(role))
      expect(answer.ok).toBe(true)
      expect(answer.text).toContain(`effort ${effort} (jev)`)
      expect(world.calls.find(c => c[2] === 'start')).toContain(`model_reasoning_effort="${effort}"`)
      expect(world.calls.find(c => c[2] === 'start')).toContain('service_tier="priority"')
      for (const write of world.writes) expect(JSON.parse(write.text)).toMatchObject({ v: 2, source: 'jev', effort, jevModel: JEV_MODEL, expected: { difficulty, duration, scope }, jevReason: null })
      expect(world.requests).toHaveLength(1)
      privateOutputs(world, answer)
    }
  }
})

test('effortApplied and the role line distinguish newly started and reused agents for every effort source', async () => {
  for (const source of ['default', 'pinned', 'jev'] as const) {
    for (const reused of [false, true]) {
      const world = assessedWorld({ ...(source === 'default' ? { key: undefined } : {}) })
      const reuseRunner = fakeRun([
        [['mkdir'], text('')],
        agents([{ name: 'analyst', pane_id: 'w1:p1', agent_status: 'idle' }]),
        [['herdr', 'agent', 'prompt'], ok({})],
      ])
      if (reused) world.team.run = reuseRunner.run
      const effort = source === 'default' ? 'medium' : source === 'pinned' ? 'high' : 'low'
      const answer = await dispatch(world.team, { ...call(), ...(source === 'pinned' ? { effort: 'high' } : {}) })
      expect(answer.ok).toBe(true)
      expect(answer.text.split('\n')[1]).toBe(`role: analyst, model gpt-6-luna, effort ${effort} (${source})${reused ? ', not applied: reused agent keeps its start effort' : ''}`)
      expect(world.writes).toHaveLength(2)
      for (const write of world.writes) expect(JSON.parse(write.text)).toMatchObject({ effortApplied: !reused, started: !reused, effort, source })
      const calls = reused ? reuseRunner.calls : world.calls
      expect(calls.some(c => c[2] === 'start')).toBe(!reused)
      expect(calls.some(c => c[2] === 'restart' || c[2] === 'send-keys')).toBe(false)
    }
  }
})

test('an agent that failed to start never records its chosen effort as applied', async () => {
  const world = io([agents([]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'p' } })], [['herdr', 'agent', 'start'], fail('agent_not_ready')]])
  const answer = await dispatch(world.team, { ...call(), effort: 'high' })
  expect(answer.ok).toBe(false)
  expect(world.writes).toHaveLength(1)
  expect(JSON.parse(world.writes[0]!.text)).toMatchObject({ effortApplied: false, started: false, promptStatus: 'not_sent' })
  expect(answer.text).not.toContain('reused agent keeps its start effort')
})

test('working and blocked live agents disclose unapplied effort even when dispatch is refused', async () => {
  for (const [status, reason] of [['working', 'agent busy'], ['blocked', 'agent blocked']] as const) {
    const world = io([agents([{ name: 'analyst', pane_id: 'p', agent_status: status }])])
    const answer = await dispatch(world.team, { ...call(), effort: 'high' })
    expect(answer.ok).toBe(false)
    expect(answer.text).toContain('effort high (pinned), not applied: reused agent keeps its start effort')
    expect(answer.text).toContain(`delivery: not_sent (${reason})`)
    expect(JSON.parse(world.writes[0]!.text)).toMatchObject({ effortApplied: false, started: false })
    expect(world.calls.filter(c => c[0] === 'herdr')).toEqual([['herdr', 'agent', 'list']])
  }
})

test('pinned effort skips Jev and repository settings entirely', async () => {
  const world = assessedWorld()
  let settings = 0
  world.team.settings = async () => { settings++; throw new Error('unreadable') }
  const answer = await dispatch(world.team, { ...call(), effort: 'xhigh' })
  expect(answer.text).toContain('effort xhigh (pinned)')
  expect(settings).toBe(0)
  expect(world.requests).toEqual([])
  expect(world.logs).toEqual([])
  expect(JSON.parse(world.writes[1]!.text)).toMatchObject({ expected: null, jevReason: null, source: 'pinned' })
  privateOutputs(world, answer)
})

test('every Jev failure falls back to the role default with only a fixed reason', async () => {
  for (const role of ['developer', 'architect', 'analyst'] as const) {
    for (const reason of ['no-key', 'bad-key', 'repo-declared-key', 'unreadable-settings', 'http', 'network', 'timeout', 'malformed', 'breaker', 'busy'] as const) {
      const world = assessedWorld({
        ...(reason === 'no-key' ? { key: undefined } : reason === 'bad-key' ? { key: 'a b' } : {}),
        ...(reason === 'http' ? { status: 503, body: `${KEY} ${TASK}` } : {}),
        ...(reason === 'network' ? { throws: true } : {}),
        ...(reason === 'timeout' ? { never: true } : {}),
        ...(reason === 'malformed' ? { body: JSON.stringify({ answers: { difficulty: { probabilities: { [KEY]: TASK } } } }) } : {}),
      })
      if (reason === 'repo-declared-key') world.team.settings = async () => ({ env: { JEV_API_KEY: KEY } })
      if (reason === 'unreadable-settings') world.team.settings = async () => { throw new Error(`${KEY} ${TASK}`) }
      if (reason === 'breaker') { world.team.breaker = createBreaker(() => 0, { failures: 1 }); world.team.breaker.failure() }
      if (reason === 'busy') { world.team.gate = createGate(1); world.team.gate.acquire() }
      const pending = dispatch(world.team, call(role))
      if (reason === 'timeout') {
        for (let tick = 0; tick < 40; tick++) await Promise.resolve()
        expect(world.requests).toHaveLength(1)
        world.timers.find(t => t.ms === JEV_DEADLINE_MS)!.fn()
      }
      const answer = await pending
      const effort = role === 'analyst' ? 'medium' : 'high'
      expect(answer.text).toContain(`effort ${effort} (default)`)
      expect(world.logs).toEqual([`codex-team: Jev off (${reason}); using role default`])
      expect(JSON.parse(world.writes[1]!.text)).toMatchObject({ v: 2, source: 'default', effort, expected: null, jevReason: reason })
      if (['no-key', 'bad-key', 'repo-declared-key', 'unreadable-settings', 'breaker', 'busy'].includes(reason)) expect(world.requests).toEqual([])
      privateOutputs(world, answer)
    }
  }
})

test('project and local key declarations both refuse Jev without any request', async () => {
  for (const source of ['project', 'local'] as const) {
    const world = assessedWorld()
    world.team.settings = async read => read === source ? { env: { JEV_API_KEY: '' } } : undefined
    const answer = await dispatch(world.team, call())
    expect(world.requests).toEqual([])
    expect(JSON.parse(world.writes[1]!.text).jevReason).toBe('repo-declared-key')
    privateOutputs(world, answer)
  }
})

test('the request contains only redacted cut task text and the key only in Authorization', async () => {
  const world = assessedWorld({ body: assessedBody({ '1': 0.75, '2': 0.25 }, { '1': 1 }, { '2': 1 }) })
  const task = `Read /repo/src/x.ts and /Users/person/private.txt; email person@example.com; token=${KEY}; ${KEY} ` + 'x'.repeat(5000)
  const answer = await dispatch(world.team, { ...call(), task })
  const request = world.requests[0]!
  expect(request.url).toBe(JEV_URL)
  expect(request.init.headers.Authorization).toBe(`Bearer ${KEY}`)
  expect(request.init.body).not.toContain(KEY)
  const body = JSON.parse(request.init.body)
  expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state'])
  expect(body.model).toBe(JEV_MODEL)
  expect(body.state.length).toBe(4000)
  expect(body.state).toContain('src/x.ts')
  expect(body.state).toContain('<path>')
  expect(body.state).toContain('<email>')
  expect(body.state).not.toContain('/repo')
  expect(body.state).not.toContain('/Users/person')
  expect(body.state).not.toContain('person@example.com')
  expect(body.state).not.toContain(KEY)
  expect(JSON.parse(world.writes[1]!.text).expected).toEqual({ difficulty: 1.3, duration: 1, scope: 2 })
  privateOutputs(world, answer)
  expect(JSON.stringify([world.writes, world.logs, answer])).not.toContain(task)
})

test('fake HTTP receives no long or truncated secret value and no flag-attached or UNC absolute path', async () => {
  const secret = 'Z'.repeat(2100)
  for (const value of [`"${secret}"`, `'${secret}'`, secret, `"${secret}`, `'${secret}`, 'Z'.repeat(6000), `"${'Z'.repeat(6000)}`]) {
    const world = assessedWorld()
    const task = String.raw`Inspect -I/opt/confidential/include --prefix=/srv/x and \\server\share\dir. ` + `access_token=${value}`
    const answer = await dispatch(world.team, { ...call(), task })
    expect(answer.ok).toBe(true)
    expect(world.requests).toHaveLength(1)
    const body = world.requests[0]!.init.body
    expect(body).not.toContain('Z')
    for (const leak of ['/opt/confidential', '/srv/x', 'server', 'share', secret]) expect(body).not.toContain(leak)
    expect(JSON.parse(body).state).toContain('[redacted]')
    expect(JSON.parse(body).state).toContain('-I<path> --prefix=<path>')
    expect(JSON.parse(body).state.length).toBeLessThan(4001)
  }
  for (const task of [
    'gcc "-I/opt/confidential/private folder/include" -o out',
    String.raw`copy "\\server\share\Bob's confidential dir\file.txt" dest`,
    JSON.stringify(JSON.stringify(JSON.stringify({ access_token: secret }))),
  ]) {
    const world = assessedWorld()
    await dispatch(world.team, { ...call(), task })
    const state = JSON.parse(world.requests[0]!.init.body).state
    for (const leak of ['Z', 'confidential', 'folder', 'server', 'share', 'file.txt', 'Bob']) expect(state).not.toContain(leak)
  }
})

test('fake HTTP preserves relative flag paths and quoted escapes while masking absolute and truncated UNC paths', async () => {
  const keep = String.raw`Compile -Isrc/include -Llib/local -isystemvendor/include --prefix=build/output; new RegExp("\\d+"); "\\n"`
  const world = assessedWorld()
  const answer = await dispatch(world.team, { ...call(), task: keep + String.raw` -I/opt/private/include --prefix=/srv/private "\\server\share\unfinished` })
  expect(answer.ok).toBe(true)
  const state = JSON.parse(world.requests[0]!.init.body).state
  expect(state).toContain(keep)
  expect(state).toContain('-I<path> --prefix=<path> "<path>')
  expect(state).not.toContain('/opt/private')
  expect(state).not.toContain('server')
})

test('astra dispatch caps pinned, Jev and default efforts in start flags, answers and decision records', async () => {
  // Exercise a future Astra spec without changing the shipped roles; restore the fixture even when an assertion fails.
  const spec = SPECS.developer
  const original = { model: spec.model, effort: spec.effort }
  try {
    Object.assign(spec, { model: 'gpt-6-astra', effort: 'xhigh' })
    for (const source of ['pinned', 'jev', 'default'] as const) {
      const world = assessedWorld({ ...(source === 'default' ? { key: undefined } : {}), body: assessedBody({ '4': 1 }, { '3': 1 }, { '3': 1 }) })
      const answer = await dispatch(world.team, { ...call('developer'), ...(source === 'pinned' ? { effort: 'xhigh' } : {}) })
      expect(answer.ok).toBe(true)
      expect(answer.text).toContain(`effort high (${source}), capped at high: gpt-6-astra never runs above high`)
      const start = world.calls.find(c => c[2] === 'start')!
      expect(start).toContain('model_reasoning_effort="high"')
      expect(start.some(arg => arg.includes('service_tier'))).toBe(false)
      for (const write of world.writes) expect(JSON.parse(write.text)).toMatchObject({ model: 'gpt-6-astra', effort: 'high', effortApplied: true, source })
    }
  } finally {
    Object.assign(spec, original)
  }
})
