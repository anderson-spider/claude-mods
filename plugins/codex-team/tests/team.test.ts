import { effectiveName } from '../hooks/names'
import { expect, test } from 'claude-code/testing'
import { dispatch, finish, NOT_IN_HERDR } from '../hooks/team'
import type { TeamIo } from '../hooks/team'
import { agents, fail, fakeRun, ok, text } from './fake-run'
import type { Rule } from './fake-run'
import { createBreaker, createGate, JEV_DEADLINE_MS, JEV_URL, SLOT_HOLD_MS } from '../hooks/jev'
import type { JevInit } from '../hooks/jev'
import { JEV_MODEL, PROFILES } from '../hooks/effort'
import { SPECS } from '../hooks/roles'
import { ASTRA_REFUSAL } from '../hooks/model-policy'
import type { Role } from '../hooks/roles'
import { fnv1a } from '../hooks/decisions'
import { lifecycle, UUID } from './lifecycle'

const ENV: Record<string, string> = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1', HERDR_PANE_ID: 'lead', HOME: '/home/u' }

function io(rules: Rule[], env: Record<string, string | undefined> = ENV) {
  const { run, calls } = fakeRun([[['mkdir'], text('')], ...rules])
  const writes: { path: string; text: string }[] = []
  const logs: string[] = []
  const tasks = new Map<string, unknown>()
  let clock = 1_000
  const team: TeamIo = {
    run,
    store: { get: async key => tasks.get(key), set: async (key, value) => { tasks.set(key, value) }, delete: async key => { tasks.delete(key) } },
    env: async () => ({ HERDR_ENV: env.HERDR_ENV, HERDR_WORKSPACE_ID: env.HERDR_WORKSPACE_ID, HERDR_PANE_ID: env.HERDR_PANE_ID, HOME: env.HOME, JEV_API_KEY: env.JEV_API_KEY }),
    sleep: async () => {},
    settings: async () => undefined,
    jev: { fetch: async () => { throw new Error('unexpected fetch') }, timer: () => () => {}, now: () => clock },
    breaker: createBreaker(() => clock),
    gate: createGate(),
    root: async () => '/repo',
    now: async () => (clock += 5),
    write: async (path, body) => { writes.push({ path, text: body }) },
    log: line => { logs.push(line) },
  }
  return { team, calls, writes, logs, tasks }
}

const freshTeam: Rule[] = [agents([]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'w1:p7' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]]

test('disallowed Astra model profile and inherited effort pins refuse before any mutation or Jev', async () => {
  for (const role of ['developer', 'analyst', 'architect', 'reviewer'] as const) {
    for (const fields of [{ model: 'gpt-6-astra' }, { task: 'Task @astra-high' }]) {
      for (const allowAstra of [false, undefined, 'true', true]) {
        const w = io([])
        w.team.allowAstra = allowAstra
        // A repository declaration refuses even an effective true option.
        w.team.settings = async () => ({ pluginConfigs: { 'codex-team@inline': { options: { allowAstra: true } } } })
        expect(await dispatch(w.team, { role, slug: 'refuse', task: 'Task', ...fields })).toEqual({ ok: false, text: ASTRA_REFUSAL })
        expect(w.calls).toEqual([])
        expect(w.writes).toEqual([])
        expect(w.tasks.size).toBe(0)
      }
    }
  }
  const spec = SPECS.developer, original = { model: spec.model, effort: spec.effort }
  try {
    spec.model = 'future-ASTRA-model'
    const w = io([])
    expect(await dispatch(w.team, { role: 'developer', slug: 'refuse', task: 'Task', effort: 'high' })).toEqual({ ok: false, text: ASTRA_REFUSAL })
    expect(w.calls).toEqual([])
  } finally { Object.assign(spec, original) }
})

test('lazy Astra refusal becomes not_sent with no pane prompt context or applied flags', async () => {
  const spec = SPECS.developer, original = { model: spec.model, effort: spec.effort }
  try {
    Object.assign(spec, { model: 'future-ASTRA-model', effort: 'xhigh' })
    // Default can inherit a future Astra spec; permission changes may also revoke an accepted model pin.
    for (const pin of [false, true]) {
      const w = io([[['git'], text('/wt/task\n')], agents([])])
      let reads = 0
      w.team.allowAstra = pin
      w.team.settings = async () => {
        if (++reads > 2) throw new Error('configuration became unreadable')
        return {}
      }
      expect(await dispatch(w.team, { role: 'developer', slug: 'refuse', task: 'Task', cwd: '/wt/task', ...(pin ? { model: 'gpt-6-astra' } : {}) })).toEqual({ ok: false, text: ASTRA_REFUSAL })
      expect(w.calls.filter(c => c[0] === 'herdr')).toEqual([['herdr', 'agent', 'list']])
      expect(w.tasks.size).toBe(0)
      expect(w.writes).toHaveLength(1)
      expect(JSON.parse(w.writes[0]!.text)).toMatchObject({ v: 3, started: false, modelApplied: false, effortApplied: false, promptStatus: 'not_sent', reason: ASTRA_REFUSAL })
    }
  } finally { Object.assign(spec, original) }
})

function settledAgent(name: string, status: string, archiveExit = 0, workspace = 'w1') {
  const uuid = '12345678-1234-1234-1234-123456789abc'
  const agent = { name: effectiveName(name, workspace)!, cwd: '/wt/task', agent: 'codex', workspace_id: workspace, pane_id: 'old', agent_status: status, agent_session: { kind: 'id', source: 'herdr:codex', value: uuid } }
  let closed = false
  const w = io([
    [['git'], text('/wt/task\n')],
    [['herdr', 'agent', 'list'], () => ok({ agents: closed ? [] : [agent] })],
    [['herdr', 'agent', 'get'], ok({ agent })], [['herdr', 'pane', 'close'], () => { closed = true; return ok({}) }],
    [['codex', 'archive'], { exitCode: archiveExit, stdout: 'private task content', stderr: 'private reason' }],
    [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: `${workspace}:p7` } })], ...freshTeam.slice(2),
  ], { ...ENV, HERDR_WORKSPACE_ID: workspace })
  return { ...w, uuid }
}

test('shared idle or done analyst and architect are finished before a fresh start with this dispatch effort', async () => {
  for (const role of ['analyst', 'architect'] as const) {
    for (const status of ['idle', 'done']) {
      const w = settledAgent(role, status)
      w.team.now = async () => 1_000
      const answer = await dispatch(w.team, { role, task: 'private new task', slug: 'fresh', effort: 'low' })
      expect(answer.text).toContain(`agent: ${role} (pane w1:p7), started now`)
      expect(answer.text).not.toContain('not applied')
      const commands = w.calls.filter(call => call[0] !== 'mkdir').map(call => call.slice(0, 3).join(' '))
      expect(commands).toEqual(['herdr agent list', 'herdr agent get', 'herdr agent list', 'herdr pane close', 'herdr agent list', 'codex archive ' + w.uuid, 'herdr agent list', 'herdr tab create', 'herdr agent start', 'herdr pane rename', 'herdr agent prompt'])
      expect(w.calls.find(call => call[2] === 'start')).toContain('model_reasoning_effort="low"')
      const tab = w.calls.find(call => call[2] === 'create')!
      expect(tab[tab.indexOf('--label') + 1]).toBe('codex - fresh')
      expect(tab).toContain('--no-focus')
      expect(w.writes.map(write => JSON.parse(write.text))).toMatchObject([
        { action: 'finish', agent: role, uuid: w.uuid, closed: true, archived: true },
        { selection: { effort: 'low' }, effortApplied: true, modelApplied: true, started: true }, { selection: { effort: 'low' }, effortApplied: true, modelApplied: true, started: true },
      ])
      expect(JSON.stringify(w.writes)).not.toContain('private')
      expect(w.writes[0]!.path).toMatch(/\.finish\.json$/)
      expect(new Set(w.writes.map(write => write.path)).size).toBe(2)
    }
  }
})

test('a shared finish failure refuses dispatch without starting or prompting a replacement', async () => {
  const w = settledAgent('analyst', 'idle', 9)
  const answer = await dispatch(w.team, { role: 'analyst', slug: 'fresh', task: 'private task', effort: 'high' })
  expect(answer.text).toContain('delivery: not_sent (agent finish failed (archive exit 9))')
  expect(w.calls.some(call => call[2] === 'start' || call[2] === 'prompt')).toBe(false)
  expect(JSON.parse(w.writes[0]!.text)).toMatchObject({ action: 'finish', closed: true, archived: false, reason: 'archive exit 9' })
  expect(JSON.stringify([w.writes, answer])).not.toContain('private')
})

test('shared working or blocked analyst and architect keep their task fallbacks', async () => {
  for (const status of ['working', 'blocked']) {
    const w = io([agents([{ name: effectiveName('analyst', 'w1')!, pane_id: 'home', agent_status: status }]), ...freshTeam.slice(1)])
    const answer = await dispatch(w.team, { role: 'analyst', slug: 'busy', task: 'Inspect', effort: 'low' })
    expect(answer.text).toContain('agent: analyst-busy')
    expect(w.calls.find(call => call[2] === 'create')).toContain('codex - busy')
    expect(w.calls.some(call => call[2] === 'get' || call[2] === 'close' || call[0] === 'codex')).toBe(false)
    const architect = io([agents([{ name: effectiveName('architect', 'w1')!, pane_id: 'home', agent_status: status }]), ...freshTeam.slice(1)])
    expect((await dispatch(architect.team, { role: 'architect', slug: 'busy', task: 'Design', effort: 'high' })).text).toContain('agent: architect-busy')
    expect(architect.calls.some(call => call[2] === 'get' || call[2] === 'close' || call[0] === 'codex')).toBe(false)
  }
})

test('finish shares the dispatch queue and logs closed and archived without task text', async () => {
  const w = settledAgent('analyst', 'idle')
  // Explicit finish starts at get, so its first list is the ownership check and its second confirms exit.
  const originalRun = w.team.run
  let closed = false
  w.team.run = async (argv, init) => {
    if (argv[2] === 'close') closed = true
    if (argv[2] === 'list' && closed) { w.calls.push([...argv]); return ok({ agents: [] }) }
    return originalRun(argv, init)
  }
  const [finished, dispatched] = await Promise.all([
    finish(w.team, { agent: 'analyst' }),
    dispatch(w.team, { role: 'architect', slug: 'next', task: 'private task', effort: 'high' }),
  ])
  expect(finished.text).toContain('closed: pane old')
  expect(finished.text).toContain('archived: yes')
  expect(dispatched.ok).toBe(true)
  const archive = w.calls.findIndex(call => call[0] === 'codex')
  expect(w.calls.findIndex(call => call[0] === 'mkdir')).toBeGreaterThan(archive)
  expect(JSON.parse(w.writes[0]!.text)).toMatchObject({ action: 'finish', agent: 'analyst', uuid: w.uuid, closed: true, archived: true })
  expect(JSON.stringify(w.writes)).not.toContain('private')
  const outside = io([], { HERDR_ENV: '0' })
  expect(await finish(outside.team, { agent: 'analyst' })).toEqual({ ok: false, text: NOT_IN_HERDR })
  expect(outside.calls).toEqual([])
  expect(outside.writes).toEqual([])
  const invalid = io([])
  expect((await finish(invalid.team, { agent: 'private arbitrary task text' })).ok).toBe(false)
  expect(invalid.calls).toEqual([])
  expect(invalid.writes).toEqual([])
})

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
  expect(answer.text).toContain('report: /home/u/.claude/codex-team/reports/repo/1r/find-x-analyst.md')
  const start = world.calls.find(call => call[2] === 'start')!
  expect(start.slice(0, 4)).toEqual(['herdr', 'agent', 'start', effectiveName('analyst', 'w1')!])
  expect(start).toContain('gpt-6-luna')
  expect(start).toContain('model_reasoning_effort="medium"')
  expect(start.some(arg => arg.startsWith('service_tier='))).toBe(false)
  expect(start).toContain('sandbox_workspace_write.writable_roots=[]')
  const tab = world.calls.find(call => call[2] === 'create')!
  expect(tab).toContain('/home/u/.claude/codex-team/reports')
  const prompt = world.calls.find(call => call[2] === 'prompt')![4]
  expect(prompt).toContain('Repository: /repo.')
  expect(prompt).toContain('Find X')
  expect(prompt).toContain('/home/u/.claude/codex-team/reports/repo/1r/find-x-analyst.md')
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
    [{ role: 'analyst', task: 't', slug: 'x'.repeat(23) }, 'slug must be'],
    [{ role: 'analyst', task: 't', slug: 's', effort: 'max' }, 'invalid profile or pins'],
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
  expect(world.writes[0]?.path).toMatch(/^\/home\/u\/\.claude\/codex-team\/decisions\/.+-a1r\.json$/)
  expect(before.promptStatus).toBe('unknown')
  expect(before.effortApplied).toBe(true)
  expect(after.effortApplied).toBe(true)
  expect(after).toMatchObject({ v: 3, role: 'architect', agent: 'architect', selection: { model: 'gpt-6.1-sol', effort: 'high', source: 'default' }, jevReason: 'no-key', expected: null, started: true, promptStatus: 'confirmed', reason: null })
  for (const write of world.writes) {
    expect(write.text).not.toContain('Secret')
    expect(write.text).not.toContain('/Users/me')
  }
})

test('a delivery that may have reached the agent says not to resend; one that did not says to fix and retry', async () => {
  const unknown = io([agents([]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'p' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], fail('agent_prompt_stalled')]])
  const said = await dispatch(unknown.team, { role: 'analyst', task: 't', slug: 's' })
  expect(said.text).toContain('delivery: unknown (agent_prompt_stalled)')
  expect(said.text).toContain('do not send it again')

  const busy = io([agents([{ name: effectiveName('analyst', 'w1')!, pane_id: 'p', agent_status: 'working' }, { name: effectiveName('analyst-s', 'w1')!, pane_id: 'q', agent_status: 'working' }])])
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

const call = (role: Role = 'analyst') => ({ role, task: TASK, slug: 'assess', cwd: '/wt/task' })
function readyCall(world: { tasks: Map<string, unknown> }, role: Role = 'analyst') {
  if (role === 'reviewer') world.tasks.set('developer:w1:/repo:assess', { cwd: '/wt/task', task: TASK })
  return call(role)
}
function privateOutputs(world: ReturnType<typeof assessedWorld>, answer: { text: string }) {
  const output = JSON.stringify([world.writes.map(w => w.text), world.logs, answer.text])
  expect(output).not.toContain(KEY)
  expect(output).not.toContain(TASK)
}

test('Jev profile choices reach every role start flag answer and v3 record', async () => {
  for (const role of ['developer', 'architect', 'analyst', 'reviewer'] as const) {
    for (const [difficulty, duration, scope, model, effort] of [[0, 0, 0, 'gpt-6-luna', 'low'], [3, 1, 2, 'gpt-6.1-sol', 'high'], [4, 3, 3, 'gpt-6.1-sol', 'xhigh']] as const) {
      const world = assessedWorld({ body: assessedBody({ [difficulty]: 1 }, { [duration]: 1 }, { [scope]: 1 }) })
      const answer = await dispatch(world.team, readyCall(world, role))
      expect(answer.ok).toBe(true)
      expect(answer.text).toContain(`model ${model}, effort ${effort} (jev), applied at start`)
      const start = world.calls.find(c => c[2] === 'start')!
      expect(start).toContain(model)
      expect(start).toContain(`model_reasoning_effort="${effort}"`)
      expect(start.some(arg => arg.startsWith('service_tier='))).toBe(false)
      for (const write of world.writes) expect(JSON.parse(write.text)).toMatchObject({ v: 3, selection: { model, source: 'jev', effort }, jevModel: JEV_MODEL, jevAsked: true, modelApplied: true, effortApplied: true, expected: { difficulty, duration, scope }, jevReason: null })
      expect(world.requests).toHaveLength(1)
      privateOutputs(world, answer)
    }
  }
})

test('developer reviewer and task analyst followups retire prior sessions and apply fresh startup pins', async () => {
  for (const role of ['developer', 'reviewer', 'analyst'] as const) {
    const name = role === 'developer' ? 'dev-assess' : role === 'reviewer' ? 'architect-assess' : 'analyst-assess'
    const w = settledAgent(name, 'done')
    w.tasks.set('developer:w1:/repo:assess', { cwd: '/wt/task', task: 'Original task' })
    const run = w.team.run
    w.team.run = async (argv, init) => {
      if (argv[0] === 'git') { w.calls.push([...argv]); return text('/wt/task\n') }
      const result = await run(argv, init)
      if (role === 'analyst' && argv[2] === 'list') {
        const data = JSON.parse(result.stdout)
        data.result.agents.push({ name: effectiveName('analyst', 'w1')!, workspace_id: 'w1', pane_id: 'home', agent_status: 'working' })
        return { ...result, stdout: JSON.stringify(data) }
      }
      return result
    }
    const result = await dispatch(w.team, { role, slug: 'assess', cwd: '/wt/task', model: 'gpt-6-luna', effort: 'low', task: 'Continue @luna-low !hard' })
    expect(result.ok).toBe(true)
    expect(result.text).not.toContain('reused')
    expect(result.text).not.toContain('pins ignored: reused')
    expect(result.text).toContain('started now')
    const selected = { model: 'gpt-6-luna', effort: 'low', source: 'pinned' }
    expect(JSON.parse(w.writes[w.writes.length - 1]!.text)).toMatchObject({ selection: selected, modelApplied: true, effortApplied: true })
    const verbs = w.calls.map(c => c.slice(0, 3).join(' '))
    expect(verbs.indexOf('herdr pane close')).toBeLessThan(verbs.indexOf('herdr agent start'))
    expect(w.calls.find(c => c[2] === 'get')![3]).toBe(effectiveName(name, 'w1'))
    expect(w.calls.find(c => c[2] === 'start')![3]).toBe(effectiveName(name, 'w1'))
    expect(w.calls.find(c => c[0] === 'codex')![2]).toBe(w.uuid)
    const prompt = w.calls.find(c => c[2] === 'prompt')![4]!
    if (role === 'developer') {
      expect(prompt).toContain('read your previous report at /home/u/.claude/codex-team/reports/repo/1r/assess-developer.md, inspect the git diff in your worktree and read the branch git log before continuing.')
      expect(w.tasks.get('developer:w1:/repo:assess')).toEqual({ cwd: '/wt/task', task: 'Original task' })
    }
  }
})

test('an agent that failed to start never records its chosen effort as applied', async () => {
  const world = io([agents([]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'p' } })], [['herdr', 'agent', 'start'], fail('agent_not_ready')]])
  const answer = await dispatch(world.team, { ...call(), effort: 'high' })
  expect(answer.ok).toBe(false)
  expect(world.writes).toHaveLength(1)
  expect(JSON.parse(world.writes[0]!.text)).toMatchObject({ modelApplied: false, effortApplied: false, started: false, promptStatus: 'not_sent', selection: { effort: 'high', source: 'pinned' } })
  expect(answer.text).toContain('not applied: agent not started')
})

test('working and blocked live agents refuse before profile selection', async () => {
  for (const [status, reason] of [['working', 'agent busy'], ['blocked', 'agent blocked']] as const) {
    const world = io([agents([{ name: effectiveName('analyst', 'w1')!, pane_id: 'p', agent_status: status }, { name: effectiveName('analyst-assess', 'w1')!, pane_id: 'q', agent_status: status }])])
    const answer = await dispatch(world.team, { ...call(), effort: 'high' })
    expect(answer.ok).toBe(false)
    expect(answer.text).toContain('model and effort not selected: agent not started')
    expect(answer.text).toContain(`delivery: not_sent (${reason})`)
    expect(JSON.parse(world.writes[0]!.text)).toMatchObject({ selection: null, modelApplied: false, effortApplied: false, started: false })
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
  expect(JSON.parse(world.writes[1]!.text)).toMatchObject({ expected: null, jevReason: null, selection: { source: 'pinned' } })
  privateOutputs(world, answer)
})

test('every Jev failure falls back to the role default with only a fixed reason', async () => {
  for (const role of ['developer', 'architect', 'analyst', 'reviewer'] as const) {
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
      const pending = dispatch(world.team, readyCall(world, role))
      if (reason === 'timeout') {
        for (let tick = 0; tick < 40; tick++) await Promise.resolve()
        expect(world.requests).toHaveLength(1)
        world.timers.find(t => t.ms === JEV_DEADLINE_MS)!.fn()
      }
      const answer = await pending
      const effort = SPECS[role].effort
      expect(answer.text).toContain(`effort ${effort} (default)`)
      expect(world.logs).toEqual([`codex-team: Jev off (${reason}); using role default`])
      expect(JSON.parse(world.writes[1]!.text)).toMatchObject({ v: 3, selection: { source: 'default', model: SPECS[role].model, effort: SPECS[role].effort }, expected: null, jevReason: reason })
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

test('authorized Astra dispatch caps pinned and default pairs and permits expert automatic selection', async () => {
  // Exercise a future Astra spec without changing the shipped roles; restore the fixture even when an assertion fails.
  const spec = SPECS.developer
  const original = { model: spec.model, effort: spec.effort }
  try {
    Object.assign(spec, { model: 'gpt-6-astra', effort: 'xhigh' })
    for (const source of ['pinned', 'jev', 'default'] as const) {
      const world = assessedWorld({ ...(source === 'default' ? { key: undefined } : {}), body: assessedBody({ '4': 1 }, { '3': 1 }, { '3': 1 }) })
      world.team.allowAstra = true
      const answer = await dispatch(world.team, { ...call('developer'), ...(source === 'pinned' ? { effort: 'xhigh' } : {}) })
      expect(answer.ok).toBe(true)
      expect(answer.text).toContain(source === 'jev' ? 'model gpt-6-astra, effort high (jev)' : `effort high (${source}), capped at high: gpt-6-astra never runs above high`)
      const start = world.calls.find(c => c[2] === 'start')!
      expect(start).toContain('model_reasoning_effort="high"')
      expect(start.some(arg => arg.startsWith('service_tier='))).toBe(false)
      for (const write of world.writes) expect(JSON.parse(write.text)).toMatchObject({ selection: { model: 'gpt-6-astra', effort: 'high', source }, effortApplied: true, modelApplied: true })
    }
  } finally {
    Object.assign(spec, original)
  }
})

test('reviewer refuses an undispatched slug or a working or blocked developer before any effect', async () => {
  const missing = io([])
  expect((await dispatch(missing.team, { role: 'reviewer', slug: 'fix' })).text).toContain('delivery: not_sent (no developer')
  expect(missing.calls).toEqual([])
  expect(missing.writes).toEqual([])
  for (const status of ['working', 'blocked']) {
    const w = io([agents([{ name: effectiveName('dev-fix', 'w1')!, pane_id: 'dev', agent_status: status }])])
    w.tasks.set('developer:w1:/repo:fix', { cwd: '/wt/fix', task: 'Original task' })
    const answer = await dispatch(w.team, { role: 'reviewer', slug: 'fix' })
    expect(answer.text).toContain(`delivery: not_sent (dev-fix is ${status})`)
    expect(w.calls).toEqual([['herdr', 'agent', 'list']])
    expect(w.writes).toEqual([])
  }
})

test('reviewer builds its recorded review brief and applies pinned effort with report-only permissions', async () => {
  const w = io([[['git'], text('/wt/fix\n')], ...freshTeam])
  await dispatch(w.team, { role: 'developer', task: 'Build the original feature', cwd: '/wt/fix', slug: 'fix', effort: 'high' })
  const reviewer = fakeRun([[['mkdir'], text('')], agents([{ name: effectiveName('dev-fix', 'w1')!, pane_id: 'dev', agent_status: 'done' }]),
    [['herdr', 'pane', 'split'], ok({ pane: { pane_id: 'review' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])
  w.team.run = reviewer.run
  w.team.settings = async () => { throw new Error('review must not read Jev settings') }
  const answer = await dispatch(w.team, { role: 'reviewer', slug: 'fix', task: 'Focus on errors', effort: 'low', cwd: '/ignored' })
  expect(answer.text).toContain('agent: architect-fix')
  expect(answer.text).toContain('effort low (pinned)')
  expect(answer.text).toContain('/fix-reviewer.md')
  const start = reviewer.calls.find(c => c[2] === 'start')!
  expect(start).toContain(SPECS.reviewer.model)
  expect(start).toContain('model_reasoning_effort="low"')
  expect(start).toContain('sandbox_workspace_write.writable_roots=[]')
  const prompt = reviewer.calls.find(c => c[2] === 'prompt')![4]!
  for (const text of ['/wt/fix', 'Build the original feature', 'Focus on errors', '/fix-developer.md', 'git status --short', 'git diff --staged', 'every untracked file', 'AGENTS.md', 'verdict: accept | changes_needed', 'risk: low | high', '- <severity> <file>:<line>']) expect(prompt).toContain(text)
  expect(reviewer.calls.find(c => c[2] === 'split')).toContain('/home/u/.claude/codex-team/reports')
  expect(w.logs.filter(line => line.includes('Jev'))).toHaveLength(0)
  expect(JSON.parse(w.writes[w.writes.length - 1]!.text)).toMatchObject({ role: 'reviewer', selection: { source: 'pinned', model: SPECS.reviewer.model, effort: 'low' }, expected: null })
})

test('reviewer followup falls back to its role default after safe retirement and honors the Astra cap', async () => {
  const spec = SPECS.reviewer, original = { model: spec.model, effort: spec.effort }
  try {
    for (const [model, effort] of [['gpt-6.1-sol', 'high'], ['gpt-6-astra', 'xhigh']] as const) {
      Object.assign(spec, { model, effort })
      const w = settledAgent('architect-fix', 'idle')
      w.team.allowAstra = true
      w.tasks.set('developer:w1:/repo:fix', { cwd: '/wt/fix', task: 'Original task' })
      const answer = await dispatch(w.team, { role: 'reviewer', slug: 'fix' })
      expect(answer.text).toContain(`model ${model}, effort high (default)`)
      if (model.includes('astra')) expect(answer.text).toContain('capped at high')
      else expect(answer.text).not.toContain('capped at high')
      expect(answer.text).toContain('started now')
      const starts = w.calls.filter(c => c[2] === 'start')
      expect(starts).toHaveLength(1)
      expect(starts[0]).toContain('model_reasoning_effort="high"')
      expect(JSON.parse(w.writes[w.writes.length - 1]!.text)).toMatchObject({ selection: { model, effort: 'high', source: 'default' } })
    }
  } finally { Object.assign(spec, original) }
})

test('developer followups keep the original task and cannot move the recorded slug to another worktree', async () => {
  const w = io([[['git'], text('/wt/fix\n')], ...freshTeam])
  await dispatch(w.team, { role: 'developer', slug: 'fix', cwd: '/wt/fix', task: 'Original task', effort: 'high' })
  await dispatch(w.team, { role: 'developer', slug: 'fix', cwd: '/wt/fix', task: 'Fix review findings', effort: 'high' })
  expect(w.tasks.get('developer:w1:/repo:fix')).toEqual({ cwd: '/wt/fix', task: 'Original task' })
  w.team.run = fakeRun([[['mkdir'], text('')], [['git'], text('/wt/other\n')]]).run
  expect((await dispatch(w.team, { role: 'developer', slug: 'fix', cwd: '/wt/other', task: 'Move', effort: 'high' })).text).toContain('another worktree')
})

test('dispatch publishes the plan after delivery and uses the actual fallback analyst in its decision', async () => {
  const w = io([agents([{ name: effectiveName('analyst', 'w1')!, pane_id: 'home', agent_status: 'working' }, { name: effectiveName('dev-fix', 'w1')!, pane_id: 'fix' }]),
    [['herdr', 'pane', 'split'], ok({ pane: { pane_id: 'new' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])
  const roots: string[] = []
  w.team.publish = async root => { roots.push(root); expect(w.calls.some(c => c[2] === 'prompt')).toBe(true) }
  const answer = await dispatch(w.team, { role: 'analyst', slug: 'fix', task: 'Inspect', effort: 'low' })
  expect(answer.text).toContain('agent: analyst-fix')
  expect(roots).toEqual(['/repo'])
  for (const write of w.writes) expect(JSON.parse(write.text).agent).toBe('analyst-fix')
})

test('a developer prompt refused before delivery does not authorize reviewer while an unknown delivery keeps its record', async () => {
  for (const [code, kept] of [['agent_blocked', false], ['agent_prompt_stalled', true]] as const) {
    const w = io([[['git'], text('/wt/fix\n')], agents([]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'dev' } })],
      [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], fail(code)]])
    await dispatch(w.team, { role: 'developer', slug: 'fix', cwd: '/wt/fix', task: 'Original task', effort: 'high' })
    expect(w.tasks.has('developer:w1:/repo:fix')).toBe(kept)
  }
})

test('a publisher failure leaves confirmed dispatch delivery intact with one log line', async () => {
  const w = io(freshTeam)
  w.team.publish = async () => { throw new Error('unexpected publisher failure') }
  const answer = await dispatch(w.team, { role: 'analyst', slug: 'fix', task: 'Inspect', effort: 'high' })
  expect(answer.text).toContain('delivery: confirmed')
  expect(w.logs).toEqual(['codex-team: dagr not published (publication failed)'])
})

test('reviewer rechecks done to working or blocked on the delivery listing before pane, startup or prompt effects', async () => {
  for (const status of ['working', 'blocked']) {
    const w = io([[['herdr', 'agent', 'list'], () => ok({ agents: [{ name: effectiveName('dev-fix', 'w1')!, workspace_id: 'w1', pane_id: 'dev', agent_status: ++listed === 1 ? 'done' : status }] })],
      [['herdr', 'pane', 'split'], ok({ pane: { pane_id: 'review' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])
    let listed = 0
    w.tasks.set('developer:w1:/repo:fix', { cwd: '/wt/fix', task: 'Original task' })
    const answer = await dispatch(w.team, { role: 'reviewer', slug: 'fix' })
    expect(answer.text).toContain(`delivery: not_sent (dev-fix is ${status})`)
    expect(w.calls.filter(call => call[0] === 'herdr')).toEqual([['herdr', 'agent', 'list'], ['herdr', 'agent', 'list']])
    expect(w.tasks.get('developer:w1:/repo:fix')).toEqual({ cwd: '/wt/fix', task: 'Original task' })
  }
})

/** A live in-memory agent list: startup/prompt effects are reflected on the next listing. */
function liveWorld() {
  const w = io([])
  const live: { name: string; workspace_id: string; pane_id: string; cwd?: string; agent_status: string }[] = []
  const calls: string[][] = []
  const panes = new Map<string, string>()
  let nextPane = 0
  w.team.run = async argv => {
    calls.push([...argv])
    if (argv[0] === 'mkdir') return text('')
    if (argv[0] === 'git') return text(argv[2]! + '\n')
    if (argv[2] === 'list') return ok({ agents: live.map(agent => ({ ...agent })) })
    if (argv[2] === 'create' || argv[2] === 'split') {
      const pane = `w1:p${++nextPane}`
      panes.set(pane, argv[argv.indexOf('--cwd') + 1]!)
      return ok(argv[2] === 'create' ? { root_pane: { pane_id: pane } } : { pane: { pane_id: pane } })
    }
    if (argv[2] === 'start') {
      const pane = argv[argv.indexOf('--pane') + 1]!
      live.push({ name: argv[3]!, workspace_id: 'w1', pane_id: pane, cwd: panes.get(pane), agent_status: 'idle' })
      return ok({})
    }
    if (argv[2] === 'prompt') { live.find(agent => agent.name === argv[3])!.agent_status = 'working'; return ok({}) }
    throw new Error('unexpected command')
  }
  return { ...w, calls, live }
}

test('concurrent developer and fallback analyst dispatches create one task tab without interleaving', async () => {
  const w = liveWorld()
  w.live.push({ name: effectiveName('analyst', 'w1')!, workspace_id: 'w1', pane_id: 'home', agent_status: 'working' })
  const [dev, analyst] = await Promise.all([
    dispatch(w.team, { role: 'developer', slug: 'fix', cwd: '/wt/fix', task: 'Build', effort: 'high' }),
    dispatch(w.team, { role: 'analyst', slug: 'fix', task: 'Inspect', effort: 'low' }),
  ])
  expect(dev.text).toContain('delivery: confirmed')
  expect(analyst.text).toContain('agent: analyst-fix')
  expect(analyst.text).toContain('delivery: confirmed')
  expect(w.calls.filter(call => call[2] === 'create').map(call => call[call.indexOf('--label') + 1])).toEqual(['codex - fix'])
  expect(w.calls.find(call => call[2] === 'split')).toContain(w.live.find(agent => agent.name === effectiveName('dev-fix', 'w1'))!.pane_id)
  const prompts = w.calls.map((call, index) => ({ call, index })).filter(({ call }) => call[2] === 'prompt')
  const lists = w.calls.map((call, index) => ({ call, index })).filter(({ call }) => call[2] === 'list')
  expect(lists[1]!.index).toBeGreaterThan(prompts[0]!.index)
})

test('concurrent shared analyst and architect dispatches create separate current task tabs', async () => {
  const w = liveWorld()
  const answers = await Promise.all([
    dispatch(w.team, { role: 'analyst', slug: 'docs', task: 'Inspect', effort: 'low' }),
    dispatch(w.team, { role: 'architect', slug: 'design', task: 'Design', effort: 'high' }),
  ])
  expect(answers.every(answer => answer.ok)).toBe(true)
  expect(w.calls.filter(call => call[2] === 'create').map(call => call[call.indexOf('--label') + 1])).toEqual(['codex - docs', 'codex - design'])
  expect(w.calls.filter(call => call[2] === 'split')).toHaveLength(0)
})

test('a concurrent not_sent preserves the first developer task record and only the creator cleans up a refused prompt', async () => {
  const w = liveWorld()
  const deleted: string[] = []
  w.team.store.delete = async key => { deleted.push(key); w.tasks.delete(key) }
  const [first, second] = await Promise.all([
    dispatch(w.team, { role: 'developer', slug: 'fix', cwd: '/wt/fix', task: 'Original task', effort: 'high' }),
    dispatch(w.team, { role: 'developer', slug: 'fix', cwd: '/wt/fix', task: 'Followup', effort: 'high' }),
  ])
  expect(first.text).toContain('delivery: confirmed')
  expect(second.text).toContain('delivery: not_sent (agent busy)')
  expect(w.tasks.get('developer:w1:/repo:fix')).toEqual({ cwd: '/wt/fix', task: 'Original task' })
  expect(deleted).toEqual([])
  const refused = io([[['git'], text('/wt/new\n')], agents([]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'dev' } })],
    [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], fail('agent_blocked')]])
  await dispatch(refused.team, { role: 'developer', slug: 'new', cwd: '/wt/new', task: 'New task', effort: 'high' })
  expect(refused.tasks.has('developer:w1:/repo:new')).toBe(false)
})

test('a failed dispatch does not poison the global queue for a later call', async () => {
  const broken = io([]), next = io(freshTeam)
  broken.team.root = async () => { throw new Error('cannot read root') }
  const results = await Promise.allSettled([
    dispatch(broken.team, { role: 'analyst', slug: 'broken', task: 'Inspect', effort: 'high' }),
    dispatch(next.team, { role: 'analyst', slug: 'next', task: 'Inspect', effort: 'high' }),
  ])
  expect(results[0]!.status).toBe('rejected')
  expect(results[1]!.status).toBe('fulfilled')
  expect(next.calls.some(call => call[2] === 'prompt')).toBe(true)
})

test('model effort and profile pins bypass Jev key settings and dimensional pins are ignored for explicit pairs', async () => {
  for (const [fields, task, model, effort, profileId] of [
    [{ model: 'gpt-6.1-sol' }, 'Task', 'gpt-6.1-sol', 'medium', 'sol-medium'],
    [{ effort: 'xhigh' }, 'Task', 'gpt-6-luna', 'xhigh', null],
    [{ model: 'gpt-6-luna', effort: 'low' }, 'Task', 'gpt-6-luna', 'low', 'luna-low'],
    [{}, 'Task @sol-xhigh !quick', 'gpt-6.1-sol', 'xhigh', 'sol-xhigh'],
    [{ model: 'gpt-6.1-sol', effort: 'high' }, 'Task @sol-high !hard', 'gpt-6.1-sol', 'high', 'sol-high'],
  ] as const) {
    const w = assessedWorld()
    w.team.settings = async () => { throw new Error('must bypass settings') }
    const answer = await dispatch(w.team, { ...call(), ...fields, task })
    expect(answer.text).toContain(`model ${model}, effort ${effort} (pinned)`)
    expect(w.requests).toEqual([])
    expect(JSON.parse(w.writes[1]!.text)).toMatchObject({ selection: { model, effort, profileId, source: 'pinned', penalty: null }, jevAsked: false, dimensionsIgnored: task.includes('!') })
    const prompt = w.calls.find(c => c[2] === 'prompt')![4]!
    expect(prompt).not.toContain('@sol-')
    expect(prompt).not.toContain('!quick')
    expect(prompt).not.toContain('!hard')
  }
})

test('all dimension pins score locally and partial pins ask only remaining questions after cleaning', async () => {
  const local = assessedWorld()
  local.team.settings = async () => { throw new Error('local pins must bypass settings') }
  const answer = await dispatch(local.team, { ...call(), task: 'Task !hard !long !scope=3 !task_type=research' })
  expect(answer.text).toContain('(override)')
  expect(local.requests).toEqual([])
  expect(JSON.parse(local.writes[1]!.text)).toMatchObject({ selection: { model: 'gpt-6.1-sol', effort: 'xhigh', source: 'override' }, pinsUsed: { dimensions: true }, expected: { difficulty: 3, duration: 3, scope: 3 }, taskType: { research: 1 }, jevAsked: false })
  const partial = assessedWorld({ body: JSON.stringify({ answers: { duration: { probabilities: { '1': 1 } }, scope: { probabilities: { '2': 1 } }, task_type: { probabilities: { docs: 0.2, research: 0.2 } } } }) })
  await dispatch(partial.team, { ...call(), task: 'Inspect /repo/src/a.ts !hard and docs' })
  const body = JSON.parse(partial.requests[0]!.init.body)
  expect(Object.keys(body.questions)).toEqual(['duration', 'scope', 'task_type'])
  expect(body.state).toBe('Inspect src/a.ts  and docs')
  const record = JSON.parse(partial.writes[1]!.text)
  expect(record).toMatchObject({ pinsUsed: { dimensions: true }, taskTypePrior: false, taskType: { docs: 0.5, research: 0.5 }, expected: { difficulty: 3, duration: 1, scope: 2 } })
  expect(JSON.stringify(partial.writes)).not.toContain('!hard')
})

test('invalid pins and directive-only tasks refuse before effects with fixed messages', async () => {
  for (const fields of [{ task: 'Task @private' }, { task: 'Task !duration=9' }, { task: 'Task @luna-low', model: 'gpt-6.1-sol' }, { task: 'Task', model: '/private/model' }, { task: '@sol-high !hard' }]) {
    const w = assessedWorld()
    const answer = await dispatch(w.team, { ...call(), ...fields })
    expect(answer.ok).toBe(false)
    expect(answer.text).toBe('codex-team: ' + (fields.task === '@sol-high !hard' ? 'task is empty' : 'invalid profile or pins'))
    expect(w.calls).toEqual([])
    expect(w.writes).toEqual([])
    expect(w.requests).toEqual([])
  }
})

test('malformed choice falls back to the exact role pair and does not use dimension pins', async () => {
  for (const role of ['developer', 'analyst', 'architect', 'reviewer'] as const) {
    const w = assessedWorld({ body: JSON.stringify({ answers: { duration: { probabilities: { '3': 1 } }, scope: { probabilities: { '3': 1 } }, task_type: { probabilities: { unknown: 1 } } } }) })
    await dispatch(w.team, { ...readyCall(w, role), task: 'Task !hard' })
    expect(JSON.parse(w.writes[1]!.text)).toMatchObject({ selection: { model: SPECS[role].model, effort: SPECS[role].effort, source: 'default', penalty: null }, expected: null, taskType: null, pinsUsed: { dimensions: false }, dimensionsIgnored: true, jevReason: 'malformed' })
  }
})

test('refused deliveries and failed shared finish never read settings or ask Jev', async () => {
  for (const kind of ['busy', 'foreign', 'writer', 'finish'] as const) {
    const w = kind === 'finish' ? settledAgent('architect', 'idle', 9) : assessedWorld()
    if (kind !== 'finish') w.team.run = fakeRun([[['mkdir'], text('')], [['git'], text('/wt/task\n')], agents([
      kind === 'writer' ? { name: effectiveName('dev-other', 'w1')!, pane_id: 'p', cwd: '/wt/task' }
        : { name: effectiveName(kind === 'busy' ? 'architect-assess' : 'architect', 'w1')!, pane_id: 'p', workspace_id: kind === 'foreign' ? 'w2' : 'w1', agent_status: 'working' },
    ])]).run
    let settings = 0, requests = 0
    if (kind === 'busy') w.tasks.set('developer:w1:/repo:assess', { cwd: '/wt/task', task: 'original' })
    w.team.env = async () => ({ ...ENV, JEV_API_KEY: KEY })
    w.team.settings = async () => { settings++; return {} }
    w.team.jev.fetch = async () => { requests++; throw new Error('must not request') }
    const result = await dispatch(w.team, { ...call(kind === 'writer' ? 'developer' : kind === 'busy' ? 'reviewer' : 'architect') })
    expect(result.ok).toBe(false)
    expect(settings).toBe(0)
    expect(requests).toBe(0)
    expect(JSON.parse(w.writes[w.writes.length - 1]!.text)).toMatchObject({ selection: null, jevAsked: false, modelApplied: false, effortApplied: false })
  }
})

test('settled sessions choose fresh pairs only after archive and dispatch duration includes assessment', async () => {
  for (const workspace of ['w6F', 'w6f']) for (const role of ['developer', 'analyst', 'architect', 'reviewer'] as const) {
    const name = role === 'developer' ? 'dev-assess' : role === 'reviewer' ? 'architect-assess' : role
    const w = settledAgent(name, 'done', 0, workspace)
    if (role === 'developer' || role === 'reviewer') w.tasks.set(`developer:${workspace}:/repo:assess`, { cwd: '/wt/task', task: 'Original task' })
    let clock = 1000, requests = 0
    let activeCalls = w.calls
    w.team.now = async () => clock
    w.team.env = async () => ({ ...ENV, HERDR_WORKSPACE_ID: workspace, JEV_API_KEY: KEY })
    w.team.jev.fetch = async () => {
      expect(activeCalls.some(c => c[0] === 'codex' && c[1] === 'archive')).toBe(true)
      clock += 75
      return { status: 200, text: ++requests === 1 ? POINT : assessedBody({ '4': 1 }, { '3': 1 }, { '3': 1 }) }
    }
    await dispatch(w.team, call(role))
    const first = JSON.parse(w.writes[w.writes.length - 1]!.text)
    expect(first).toMatchObject({ effectiveAgent: effectiveName(name, workspace), selection: { model: 'gpt-6-luna', effort: 'low' }, durationMs: 75 })
    expect(w.calls.find(c => c[2] === 'get')![3]).toBe(effectiveName(name, workspace))
    expect(w.calls.find(c => c[2] === 'start')![3]).toBe(effectiveName(name, workspace))
    // The next settled predecessor is retired by the same safe finish path.
    const next = settledAgent(name, 'idle', 0, workspace)
    w.team.run = next.team.run
    activeCalls = next.calls
    await dispatch(w.team, call(role))
    const second = JSON.parse(w.writes[w.writes.length - 1]!.text)
    expect(second).toMatchObject({ selection: { model: 'gpt-6.1-sol', effort: 'xhigh' }, durationMs: 75 })
    expect(requests).toBe(2)
  }
})

test('reviewer profile and structured pins apply with dimensional pins ignored only for explicit pairs', async () => {
  for (const [fields, task, model, effort, profileId] of [
    [{ model: 'gpt-6-luna' }, undefined, 'gpt-6-luna', 'high', 'luna-high'],
    [{ effort: 'low' }, undefined, 'gpt-6.1-sol', 'low', null],
    [{}, '@luna-low', 'gpt-6-luna', 'low', 'luna-low'],
    [{ model: 'gpt-6.1-sol', effort: 'high' }, 'Focus @sol-high !hard', 'gpt-6.1-sol', 'high', 'sol-high'],
  ] as const) {
    const w = assessedWorld()
    readyCall(w, 'reviewer')
    w.team.settings = async () => { throw new Error('explicit pins must bypass settings') }
    const answer = await dispatch(w.team, { role: 'reviewer', slug: 'assess', ...fields, task })
    expect(answer.ok).toBe(true)
    expect(answer.text).toContain(`model ${model}, effort ${effort} (pinned)`)
    expect(answer.text).not.toContain('pins ignored')
    expect(w.requests).toEqual([])
    expect(JSON.parse(w.writes[1]!.text)).toMatchObject({ selection: { model, effort, source: 'pinned', profileId }, pinsUsed: { dimensions: false }, dimensionsIgnored: task?.includes('!hard') ?? false })
    const start = w.calls.find(c => c[2] === 'start')!
    expect(start).toContain('sandbox_workspace_write.writable_roots=[]')
    expect(start).toContain(`developer_instructions=${JSON.stringify(SPECS.reviewer.instructions)}`)
    const prompt = w.calls.find(c => c[2] === 'prompt')![4]!
    expect(prompt).toContain('Original task:')
    expect(prompt).toContain(TASK)
    expect(prompt).not.toContain('@sol-high')
    expect(prompt).not.toContain('@luna-low')
  }
})

test('reviewer dimension pins score locally or ask Jev only remaining questions using the redacted review brief', async () => {
  const local = assessedWorld()
  readyCall(local, 'reviewer')
  local.team.settings = async () => { throw new Error('local pins must bypass settings') }
  const result = await dispatch(local.team, { role: 'reviewer', slug: 'assess', task: '!difficulty=0 !quick !scope=0 !task_type=review' })
  expect(result.ok).toBe(true)
  expect(local.requests).toEqual([])
  expect(JSON.parse(local.writes[1]!.text)).toMatchObject({ selection: { model: 'gpt-6-luna', effort: 'low', source: 'override' }, taskType: { review: 1 }, pinsUsed: { dimensions: true } })
  const partial = assessedWorld()
  readyCall(partial, 'reviewer')
  await dispatch(partial.team, { role: 'reviewer', slug: 'assess', task: 'Focus on failures !hard' })
  const body = JSON.parse(partial.requests[0]!.init.body)
  expect(Object.keys(body.questions)).toEqual(['duration', 'scope', 'task_type'])
  for (const text of ["Review the developer's worktree: <path>.", 'Original task:', TASK, 'Developer report:', 'git diff', 'Additional review focus:', 'Focus on failures']) expect(body.state).toContain(text)
  expect(body.state).not.toContain('!hard')
  expect(body.state).not.toContain('/wt/task')
  expect(body.state).not.toContain('/home/u')
  expect(JSON.parse(partial.writes[1]!.text)).toMatchObject({ selection: { source: 'jev' }, expected: { difficulty: 3, duration: 0, scope: 0 }, pinsUsed: { dimensions: true } })
})

test('hostile assessment metadata never enters v3 and task hash uses text after directive removal', async () => {
  const data = JSON.parse(POINT)
  data.raw = KEY
  data.answers.extra = KEY
  data.answers.task_type = { probabilities: { docs: 0.3, research: 0.3 }, metadata: KEY, choice: '/private/path' }
  const w = assessedWorld({ body: JSON.stringify(data) })
  const result = await dispatch(w.team, { ...call(), task: 'Task @literal-in-code `!quick` !hard' })
  // An unknown reserved mention is rejected; it cannot be sent or logged.
  expect(result.text).toBe('codex-team: invalid profile or pins')
  expect(w.requests).toEqual([])
  const safe = assessedWorld({ body: JSON.stringify(data) })
  await dispatch(safe.team, { ...call(), task: 'Task `@literal-in-code !quick` !hard' })
  const record = JSON.parse(safe.writes[1]!.text)
  expect(record).toMatchObject({ selection: { source: 'jev' }, taskType: { docs: 0.5, research: 0.5 }, expected: { difficulty: 3, duration: 0, scope: 0 } })
  expect(record.taskHash).toBe(fnv1a('Task `@literal-in-code !quick` '))
  expect(JSON.stringify(safe.writes)).not.toContain(KEY)
  expect(JSON.stringify(safe.writes)).not.toContain('/private/path')
  expect(JSON.stringify(safe.writes)).not.toContain('!hard')
  expect(JSON.stringify(safe.writes)).not.toContain('startup')
})

test('working and blocked named predecessors refuse without retirement settings or Jev', async () => {
  for (const role of ['developer', 'reviewer', 'analyst'] as const) for (const status of ['working', 'blocked']) {
    const name = role === 'developer' ? 'dev-assess' : role === 'reviewer' ? 'architect-assess' : 'analyst-assess'
    const w = settledAgent(name, status)
    w.tasks.set('developer:w1:/repo:assess', { cwd: '/wt/task', task: 'Original task' })
    const run = w.team.run
    w.team.run = async (argv, init) => {
      const result = await run(argv, init)
      if (role === 'analyst' && argv[2] === 'list') {
        const data = JSON.parse(result.stdout)
        data.result.agents.push({ name: effectiveName('analyst', 'w1')!, workspace_id: 'w1', pane_id: 'home', agent_status: 'working' })
        return { ...result, stdout: JSON.stringify(data) }
      }
      return result
    }
    let settings = 0, requests = 0
    w.team.env = async () => ({ ...ENV, JEV_API_KEY: KEY })
    w.team.settings = async () => { settings++; return {} }
    w.team.jev.fetch = async () => { requests++; throw new Error('unexpected request') }
    const result = await dispatch(w.team, { role, slug: 'assess', cwd: '/wt/task', task: 'Self-contained followup' })
    expect(result.ok).toBe(false)
    expect(result.text).toContain(status === 'working' ? 'delivery: not_sent (agent busy)' : 'delivery: not_sent (agent blocked)')
    expect(settings).toBe(0)
    expect(requests).toBe(0)
    expect(w.calls.filter(c => c[0] === 'herdr').every(c => c[2] === 'list')).toBe(true)
    expect(w.calls.some(c => c[0] === 'codex')).toBe(false)
    expect(w.tasks.get('developer:w1:/repo:assess')).toEqual({ cwd: '/wt/task', task: 'Original task' })
  }
})

test('foreign shared roles and equal developer or reviewer names do not block local dispatch', async () => {
  for (const role of ['analyst', 'architect', 'developer', 'reviewer'] as const) {
    const name = role === 'developer' ? 'dev-fix' : role === 'reviewer' ? 'architect-fix' : role
    const w = io([agents([
      { name: effectiveName(name, 'w2'), workspace_id: 'w2', pane_id: 'foreign', cwd: '/wt/fix', agent_status: 'working' },
      { name: 'analyst', workspace_id: 'w2', pane_id: 'legacy', agent_status: 'working' },
      { name: effectiveName('dev-fix', 'w2'), workspace_id: 'w2', pane_id: 'foreign-dev', agent_status: 'blocked' },
    ]), [['git'], text('/wt/fix\n')], ...freshTeam.slice(1)])
    if (role === 'reviewer') w.tasks.set('developer:w1:/repo:fix', { cwd: '/wt/fix', task: 'Original' })
    const answer = await dispatch(w.team, { role, slug: 'fix', cwd: '/wt/fix', task: 'Inspect', effort: 'high' })
    expect(answer.ok).toBe(true)
    expect(answer.text).toContain(`agent: ${name}`)
    expect(answer.text).toContain(`Herdr: ${effectiveName(name, 'w1')}`)
    expect(answer.text).toContain('agent_not_found means check the report and finish receipt')
    expect(w.calls.some(call => call[2] === 'split' || call[2] === 'get')).toBe(false)
    expect(JSON.parse(w.writes[w.writes.length - 1]!.text)).toMatchObject({ agent: name, effectiveAgent: effectiveName(name, 'w1'), promptStatus: 'confirmed' })
  }
})

test('unknown delivery hints use the effective Herdr name while finish accepts only the logical name', async () => {
  const w = io([agents([]), ...freshTeam.slice(1, 3), [['herdr', 'agent', 'prompt'], fail('agent_prompt_stalled')]])
  const answer = await dispatch(w.team, { role: 'analyst', slug: 'fix', task: 'Inspect', effort: 'low' })
  expect(answer.text).toContain('agent: analyst')
  expect(answer.text).toContain('herdr agent get n1r')
  expect(answer.text).toContain('herdr agent wait n1r')
  const settled = settledAgent('analyst', 'done')
  const finished = await finish(settled.team, { agent: 'analyst' })
  expect(finished.text).toContain('agent: analyst (Herdr: n1r)')
  expect(settled.calls.find(call => call[2] === 'get')).toEqual(['herdr', 'agent', 'get', 'n1r'])
  const invalid = io([])
  expect((await finish(invalid.team, { agent: 'n1r' })).ok).toBe(false)
  expect(invalid.calls).toEqual([])
})

test('workspace-specific developer context and decision paths do not cross with equal roots slugs and timestamps', async () => {
  const a = io([[['git'], text('/wt/a\n')], ...freshTeam], { ...ENV, HERDR_WORKSPACE_ID: 'w6F' })
  const b = io([[['git'], text('/wt/b\n')], ...freshTeam], { ...ENV, HERDR_WORKSPACE_ID: 'w6f' })
  b.team.store = a.team.store
  for (const w of [a, b]) w.team.now = async () => 1000
  expect((await dispatch(a.team, { role: 'developer', slug: 'fix', cwd: '/wt/a', task: 'A', effort: 'high' })).ok).toBe(true)
  // A stored task alone never authorizes a reviewer in B.
  const unauthorized = await dispatch(b.team, { role: 'reviewer', slug: 'fix' })
  expect(unauthorized.text).toContain('no developer was dispatched')
  expect(b.calls).toEqual([])
  expect((await dispatch(b.team, { role: 'developer', slug: 'fix', cwd: '/wt/b', task: 'B', effort: 'high' })).ok).toBe(true)
  expect(a.tasks.get('developer:w6F:/repo:fix')).toEqual({ cwd: '/wt/a', task: 'A' })
  expect(a.tasks.get('developer:w6f:/repo:fix')).toEqual({ cwd: '/wt/b', task: 'B' })
  expect(a.writes[0]!.path).not.toBe(b.writes[0]!.path)
})

test('unsupported workspace ids refuse dispatch and finish before any IO effect', async () => {
  for (const workspace of ['W1', 'wzzzzzzz']) {
    const w = io([], { ...ENV, HERDR_WORKSPACE_ID: workspace })
    expect((await dispatch(w.team, { role: 'analyst', slug: 'fix', task: 'Inspect' })).ok).toBe(false)
    expect((await finish(w.team, { agent: 'analyst' })).ok).toBe(false)
    expect(w.calls).toEqual([])
    expect(w.writes).toEqual([])
  }
})

test('equal roots and slugs in different workspaces get distinct report paths in every reply and brief', async () => {
  const seen = new Set<string>()
  for (const [workspace, token] of [['w6F', '39j'], ['w6f', '3a9']] as const) {
    const w = io([[['git'], text(`/wt/${workspace}\n`)], ...freshTeam], { ...ENV, HERDR_WORKSPACE_ID: workspace })
    for (const role of ['developer', 'analyst', 'architect', 'reviewer'] as const) {
      const answer = await dispatch(w.team, { role, slug: 'fix', task: `Task in ${workspace}`, cwd: `/wt/${workspace}`, effort: 'high' })
      expect(answer.ok).toBe(true)
      const expected = `/home/u/.claude/codex-team/reports/repo/${token}/fix-${role}.md`
      const prompt = w.calls.filter(call => call[2] === 'prompt').slice(-1)[0]![4]!
      expect(answer.text).toContain(`report: ${expected}`)
      expect(prompt).toContain(`write ${expected} (create its directory if needed)`)
      expect(w.calls.filter(call => call[0] === 'mkdir').slice(-1)[0]).toEqual(['mkdir', '-p', `/home/u/.claude/codex-team/reports/repo/${token}`])
      expect(seen.has(expected)).toBe(false)
      seen.add(expected)
      if (role === 'reviewer') {
        expect(prompt).toContain(`Developer report: /home/u/.claude/codex-team/reports/repo/${token}/fix-developer.md`)
        expect(prompt).not.toContain(`/repo/${workspace === 'w6F' ? '3a9' : '39j'}/`)
        expect(prompt).toContain(`Task in ${workspace}`)
      }
    }
  }
  expect(seen.size).toBe(8)
})

test('Astra off keeps Jev enabled and filters expert automatic and fully pinned local candidates', async () => {
  for (const local of [false, true]) for (const role of ['developer', 'analyst', 'architect', 'reviewer'] as const) {
    const w = assessedWorld({ body: assessedBody({ '4': 1 }, { '3': 1 }, { '3': 1 }) })
    w.team.allowAstra = true
    // This does not declare a Jev key: only Astra must be disabled.
    w.team.settings = async () => ({ pluginConfigs: { 'codex-team': { options: { allowAstra: false } } } })
    const answer = await dispatch(w.team, { ...readyCall(w, role), ...(local ? { task: 'Task !difficulty=4 !duration=3 !scope=3 !task_type=implement' } : {}) })
    expect(answer.ok).toBe(true)
    expect(answer.text).toContain(`model gpt-6.1-sol, effort xhigh (${local ? 'override' : 'jev'})`)
    expect(w.requests).toHaveLength(local ? 0 : 1)
    expect(w.calls.find(c => c[2] === 'start')).not.toContain('gpt-6-astra')
    expect(JSON.parse(w.writes[1]!.text)).toMatchObject({ selection: { model: 'gpt-6.1-sol', effort: 'xhigh' }, jevAsked: !local, modelApplied: true, effortApplied: true })
  }
})

test('authorized Astra Jev local and explicit pairs agree in startup answer and decision for every role', async () => {
  for (const role of ['developer', 'analyst', 'architect', 'reviewer'] as const) {
    for (const route of ['jev', 'local', 'model', 'profile'] as const) {
      const w = assessedWorld({ body: assessedBody({ '4': 1 }, { '3': 1 }, { '3': 1 }) })
      w.team.allowAstra = true
      const fields = route === 'model' ? { model: 'gpt-6-astra', effort: 'xhigh' }
        : route === 'profile' ? { task: 'Task @astra-high' }
          : route === 'local' ? { task: 'Task !difficulty=4 !duration=3 !scope=3 !task_type=implement' } : {}
      const answer = await dispatch(w.team, { ...readyCall(w, role), ...fields })
      const source = route === 'jev' ? 'jev' : route === 'local' ? 'override' : 'pinned'
      expect(answer.ok).toBe(true)
      expect(answer.text).toContain(`model gpt-6-astra, effort high (${source})`)
      if (route === 'model') expect(answer.text).toContain('capped at high')
      const start = w.calls.find(c => c[2] === 'start')!
      expect(start).toContain('gpt-6-astra')
      expect(start).toContain('model_reasoning_effort="high"')
      expect(start.some(arg => arg.startsWith('service_tier='))).toBe(false)
      expect(start).toContain(`developer_instructions=${JSON.stringify(SPECS[role].instructions)}`)
      expect(start).toContain(role === 'developer' ? 'sandbox_workspace_write.writable_roots=["/home/u/.claude/codex-team/reports"]' : 'sandbox_workspace_write.writable_roots=[]')
      for (const write of w.writes) expect(JSON.parse(write.text)).toMatchObject({ v: 3, selection: { model: 'gpt-6-astra', effort: 'high', source }, started: true, modelApplied: true, effortApplied: true })
      expect(w.requests).toHaveLength(route === 'jev' ? 1 : 0)
      expect(w.calls.find(c => c[2] === 'prompt')![4]).not.toContain('@astra-high')
    }
  }
})

test('Astra followup pins recheck permission before retiring developer or reviewer predecessors', async () => {
  for (const role of ['developer', 'reviewer'] as const) for (const allowed of [true, false]) {
    const w = settledAgent(role === 'developer' ? 'dev-fix' : 'architect-fix', 'done')
    w.team.allowAstra = allowed
    w.tasks.set('developer:w1:/repo:fix', { cwd: '/wt/task', task: 'Original task' })
    const answer = await dispatch(w.team, { role, slug: 'fix', cwd: '/wt/task', task: 'Continue @astra-high' })
    if (!allowed) {
      expect(answer).toEqual({ ok: false, text: ASTRA_REFUSAL })
      expect(w.calls).toEqual([])
      expect(w.writes).toEqual([])
    } else {
      expect(answer.text).toContain('model gpt-6-astra, effort high (pinned)')
      expect(w.calls.findIndex(c => c[0] === 'codex')).toBeLessThan(w.calls.findIndex(c => c[2] === 'start'))
      expect(JSON.parse(w.writes[w.writes.length - 1]!.text)).toMatchObject({ selection: { model: 'gpt-6-astra', effort: 'high' }, modelApplied: true, effortApplied: true })
    }
    expect(w.tasks.get('developer:w1:/repo:fix')).toEqual({ cwd: '/wt/task', task: 'Original task' })
  }
})


test('Jev Astra selection is capped defensively and revoked permission refuses before pane creation', async () => {
  const profile = PROFILES.find(p => p.id === 'astra-high')!, effort = profile.effort
  try {
    // Simulate a future policy error: the shared startup cap must still align flags, answer and record.
    profile.effort = 'xhigh'
    const w = assessedWorld({ body: assessedBody({ '4': 1 }, { '3': 1 }, { '3': 1 }) })
    w.team.allowAstra = true
    const answer = await dispatch(w.team, call())
    expect(answer.text).toContain('model gpt-6-astra, effort high (jev), capped at high')
    expect(w.calls.find(c => c[2] === 'start')).toContain('model_reasoning_effort="high"')
    for (const write of w.writes) expect(JSON.parse(write.text)).toMatchObject({ selection: { model: 'gpt-6-astra', effort: 'high', source: 'jev' }, started: true, modelApplied: true, effortApplied: true })
  } finally { profile.effort = effort }
  const revoked = assessedWorld({ body: assessedBody({ '4': 1 }, { '3': 1 }, { '3': 1 }) })
  revoked.team.allowAstra = true
  let reads = 0
  revoked.team.settings = async () => ++reads <= 4 ? {} : { pluginConfigs: { 'codex-team@inline': { options: { allowAstra: false } } } }
  let published = false
  revoked.team.publish = async () => { published = true }
  expect(await dispatch(revoked.team, call())).toEqual({ ok: false, text: ASTRA_REFUSAL })
  expect(revoked.requests).toHaveLength(1)
  expect(revoked.calls.filter(c => c[0] === 'herdr')).toEqual([['herdr', 'agent', 'list']])
  expect(JSON.parse(revoked.writes[0]!.text)).toMatchObject({ selection: { model: 'gpt-6-astra', effort: 'high', source: 'jev' }, started: false, modelApplied: false, effortApplied: false, promptStatus: 'not_sent', reason: ASTRA_REFUSAL })
  expect(published).toBe(true)
})

test('Fast mode follows the plugin option unless the dispatch chooses, and a malformed choice refuses before any effect', async () => {
  for (const [option, choice, on, source] of [
    [undefined, undefined, false, 'plugin option'], [true, undefined, true, 'plugin option'], ['true', undefined, false, 'plugin option'],
    [false, true, true, 'dispatch'], [true, false, false, 'dispatch'],
  ] as const) {
    const world = io(freshTeam)
    world.team.fast = option
    const answer = await dispatch(world.team, { role: 'analyst', task: 'Find X', slug: 'find-x', ...(choice === undefined ? {} : { fast: choice }) })
    expect(answer.ok).toBe(true)
    expect(answer.text).toContain(`fast: ${on ? 'on' : 'off'} (${source})`)
    const start = world.calls.find(call => call[2] === 'start')!
    expect(start.filter(arg => arg.startsWith('service_tier='))).toEqual(on ? ['service_tier="priority"'] : [])
  }
  const world = io(freshTeam)
  expect(await dispatch(world.team, { role: 'analyst', task: 'Find X', slug: 'find-x', fast: 'yes' })).toEqual({ ok: false, text: 'codex-team: fast must be true or false' })
  expect(world.calls).toEqual([])
  expect(world.writes).toEqual([])
})

test('auto finish shares dispatch and finish queue and a refusal preserves the current watcher', async () => {
  const w = lifecycle()
  await dispatch(w.io, { role: 'developer', slug: 'fix', task: 'original', cwd: '/wt/fix', effort: 'low' })
  const tracked = { workspace: 'w1', effectiveAgent: effectiveName('dev-fix', 'w1')!, pane: 'w1:p1', uuid: UUID, role: 'developer' as const, report: '/home/u/.claude/codex-team/reports/repo/1r/fix-developer.md', submittedAt: 1_000, baselineMtime: 0 }
  w.closer.track(tracked)
  expect((await dispatch(w.io, { role: 'developer', slug: 'fix', task: 'followup', cwd: '/wt/fix', effort: 'low' })).ok).toBe(false)
  expect(w.closer.current(tracked)).toBe(true)
  w.state.agents[0]!.agent_status = 'done'; w.put(tracked.report)
  let release!: () => void
  const runner = w.io.run
  w.io.run = async (argv, init) => { if (argv[0] === 'mkdir') await new Promise<void>(resolve => { release = resolve }); return runner(argv, init) }
  const dispatching = dispatch(w.io, { role: 'architect', slug: 'other', task: 'task', effort: 'low' })
  for (let i = 0; i < 30 && !release; i++) await Promise.resolve()
  const observing = w.closer.observe()
  for (let i = 0; i < 30; i++) await Promise.resolve()
  expect(w.calls.some(call => call[2] === 'close')).toBe(false)
  release(); await dispatching; await observing
  const commands = w.calls.map(call => call[2])
  expect(commands.lastIndexOf('prompt')).toBeLessThan(commands.indexOf('close'))
  expect(w.state.agents).toHaveLength(1)
  expect(w.state.agents[0]!.name).toBe(effectiveName('architect', 'w1'))
})

test('concurrent analyst architect and developer dispatches get distinct panes without interleaving', async () => {
  const w = lifecycle()
  const answers = await Promise.all(['analyst', 'architect', 'developer'].map(role => dispatch(w.io, { role, task: 'independent', slug: role, cwd: '/wt/fix', effort: 'low' })))
  expect(answers.every(answer => answer.ok)).toBe(true)
  expect(new Set(w.state.agents.map(agent => agent.pane_id)).size).toBe(3)
  expect(w.calls.filter(call => ['create', 'start', 'prompt'].includes(call[2] ?? '')).map(call => call[2])).toEqual(['create', 'start', 'prompt', 'create', 'start', 'prompt', 'create', 'start', 'prompt'])
  expect(w.timer().timers).toBe(1)
})

test('concurrent busy shared architects fall back to distinct task agents', async () => {
  const w = lifecycle()
  w.state.agents.push({ name: effectiveName('architect', 'w1')!, workspace_id: 'w1', pane_id: 'busy', agent_status: 'working' })
  const answers = await Promise.all(['one', 'two', 'three'].map(slug => dispatch(w.io, { role: 'architect', slug, task: 'design', effort: 'low' })))
  expect(answers.every(answer => answer.ok)).toBe(true)
  expect(new Set(w.state.agents.map(agent => agent.name)).size).toBe(4)
  expect(w.state.agents[0]!.pane_id).toBe('busy')
  expect(w.calls.some(call => call[2] === 'close')).toBe(false)
})

test('failed startup rolls back only its new empty pane and preserves pre-existing tabs and sibling agents', async () => {
  for (const occupied of [false, true]) {
    const w = lifecycle()
    w.state.startFail = true
    const peer = { name: effectiveName('architect-fix', 'w1')!, workspace_id: 'w1', pane_id: 'old', agent_status: 'working' }
    w.state.agents.push(peer)
    w.panes.set('old', { pane_id: 'old', terminal_id: 'old-terminal', workspace_id: 'w1', tab_id: 'old-tab' })
    const run = w.io.run
    if (occupied) w.io.run = async (argv, init) => { const result = await run(argv, init); if (argv[2] === 'start') w.state.agents.push({ ...peer, name: 'another', pane_id: 'w1:p1' }); return result }
    expect((await dispatch(w.io, { role: 'developer', slug: 'fix', task: 'task', cwd: '/wt/fix', effort: 'low' })).text).toContain('delivery: not_sent (start_failed)')
    expect(w.panes.has('old')).toBe(true)
    expect(w.state.agents[0]).toEqual(peer)
    expect(w.calls.filter(call => call[2] === 'close')).toEqual(occupied ? [] : [['herdr', 'pane', 'close', 'w1:p1']])
    expect(w.calls.some(call => call[0] === 'codex' || call[2] === 'prompt' || call[1] === 'tab' && call[2] === 'close')).toBe(false)
  }
  const w = lifecycle(); w.state.startFail = w.state.closeFail = true
  const answer = await dispatch(w.io, { role: 'analyst', slug: 'fix', task: 'task', effort: 'low' })
  expect(answer.text).toContain('delivery: not_sent (start_failed)')
  expect(w.logs).toEqual(['codex-team: startup pane cleanup failed'])
  expect(w.panes.size).toBe(1)
  const existing = lifecycle()
  existing.state.agents.push({ name: effectiveName('analyst', 'w1')!, workspace_id: 'w1', pane_id: 'old', agent_status: 'unknown' })
  expect((await dispatch(existing.io, { role: 'analyst', slug: 'fix', task: 'task', effort: 'low' })).ok).toBe(false)
  expect(existing.calls.some(call => call[2] === 'close' || call[2] === 'create')).toBe(false)
})
