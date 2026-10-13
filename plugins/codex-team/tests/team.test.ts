import { expect, test } from 'claude-code/testing'
import { dispatch, NOT_IN_HERDR } from '../hooks/team'
import type { TeamIo } from '../hooks/team'
import { agents, fail, fakeRun, ok, text } from './fake-run'
import type { Rule } from './fake-run'

const ENV: Record<string, string> = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1', HOME: '/home/u' }

function io(rules: Rule[], env: Record<string, string | undefined> = ENV) {
  const { run, calls } = fakeRun([[['mkdir'], text('')], ...rules])
  const writes: { path: string; text: string }[] = []
  const logs: string[] = []
  let clock = 1_000
  const team: TeamIo = {
    run,
    env: async () => ({ HERDR_ENV: env.HERDR_ENV, HERDR_WORKSPACE_ID: env.HERDR_WORKSPACE_ID, HOME: env.HOME }),
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
  expect(start).toContain('sandbox_workspace_write.writable_roots=[]')
  const tab = world.calls.find(call => call[2] === 'create')!
  expect(tab).toContain('/home/u/.claude/codex-team/reports')
  const prompt = world.calls.find(call => call[2] === 'prompt')![4]
  expect(prompt).toContain('Repository: /repo.')
  expect(prompt).toContain('Find X')
  expect(prompt).toContain('/home/u/.claude/codex-team/reports/repo/find-x-analyst.md')
})

test('the developer works in its worktree and may write only there, in the git directory and the reports', async () => {
  const world = io([
    [['git', '-C', '/wt/feat', 'rev-parse', '--show-toplevel'], text('/wt/feat\n')],
    [['git', '-C', '/wt/feat', 'rev-parse', '--path-format=absolute', '--git-common-dir'], text('/repo/.git\n')],
    ...freshTeam,
  ])
  const answer = await dispatch(world.team, { role: 'developer', task: 'Build', slug: 'feat', cwd: '/wt/feat', effort: 'xhigh' })

  expect(answer.text).toContain('agent: dev-feat')
  expect(answer.text).toContain('effort xhigh (pinned)')
  const start = world.calls.find(call => call[2] === 'start')!
  expect(start).toContain('sandbox_workspace_write.writable_roots=["/repo/.git", "/home/u/.claude/codex-team/reports"]')
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
  expect(after).toMatchObject({ v: 1, role: 'architect', agent: 'architect', model: 'gpt-6.1-sol', effort: 'high', source: 'default', started: true, promptStatus: 'confirmed', reason: null })
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
