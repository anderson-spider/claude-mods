import { expect, test } from 'claude-code/testing'
import { amend, branchOnly, canonical, eligible, escapeUnsafe, filesOverlap, flowHash, globsOverlap, hasUnsafe, matchGlob, ownsPath, parseFlow, quoted, requiredTasks, sha256, validateFlow } from '../hooks/flow/plan'
import type { AmendState, Flow } from '../hooks/flow/plan'

const base = () => ({
  schemaVersion: 1,
  planId: 'decision-flow',
  goal: 'Ship the flow controller',
  tasks: [
    { id: 'T1', goal: 'Contract', files: ['plugins/pantheon/hooks/flow/plan.ts'], acceptance: { checks: [{ argv: ['claude', 'plugin', 'test', 'plugins/pantheon'] }] } },
    { id: 'T2', goal: 'Policy', files: ['plugins/pantheon/hooks/flow/'], acceptance: { criteria: ['every condition has a table test'] }, risk: true },
  ],
})
const plan = (flow: unknown, before = '# Plan\n\nText.\n\n', after = '\n\nMore text.\n') =>
  `${before}\`\`\`pantheon-flow\n${JSON.stringify(flow, null, 2)}\n\`\`\`${after}`
const errorsOf = (raw: unknown) => {
  const result = validateFlow(raw)
  return result.ok ? [] : result.errors
}

test('sha256 matches the FIPS 180-4 vectors', () => {
  expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  expect(sha256('ação ✓ 𝄞')).toBe('fa3e9d7defeceab1de6feb459c067bb7a54dee2b41b1012bff196ddcbdb7006f')
})

test('parses the fenced block with defaults filled in', () => {
  const result = parseFlow(plan(base()))
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.flow.limits).toEqual({ maxBlocks: 6, maxAttempts: 2 })
  expect(result.flow.tasks[0]).toMatchObject({ dependsOn: [], risk: false, sideEffect: false })
  expect(result.flow.tasks[0].acceptance.checks[0].timeoutSec).toBe(120)
  // Omitted dependsOn means after the task listed before it.
  expect(result.flow.tasks[1].dependsOn).toEqual(['T1'])
  expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
})

test('the hash ignores key order and whitespace but follows content', () => {
  const a = parseFlow(plan(base()))
  const reordered = JSON.parse(JSON.stringify(base()), (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.fromEntries(Object.entries(v).reverse()) : v)
  const b = parseFlow('```pantheon-flow\n' + JSON.stringify(reordered) + '\n```')
  const changed = base()
  changed.tasks[1].acceptance = { criteria: ['every condition has a table test, and more'] }
  const c = parseFlow(plan(changed))
  if (!a.ok || !b.ok || !c.ok) throw new Error('expected valid flows')
  expect(b.hash).toBe(a.hash)
  expect(c.hash).not.toBe(a.hash)
  expect(flowHash(a.flow)).toBe(a.hash)
})

test('canonical sorts keys and drops undefined', () => {
  expect(canonical({ b: 1, a: [2, { d: undefined, c: 'x' }] })).toBe('{"a":[2,{"c":"x"}],"b":1}')
})

for (const [label, markdown, error] of [
  ['no block', '# Plan\n', 'no ```pantheon-flow block'],
  ['two blocks', plan(base()) + plan(base()), '2 ```pantheon-flow blocks'],
  ['bad JSON', '```pantheon-flow\n{nope\n```', 'not JSON'],
] as const) {
  test(`rejects a plan with ${label}`, () => {
    const result = parseFlow(markdown)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('\n')).toContain(error)
  })
}

const mutate = (fn: (flow: any) => void) => { const flow: any = base(); fn(flow); return flow }
for (const [label, flow, error] of [
  ['an unknown top-level field', mutate(f => { f.mode = 'enforce' }), 'unknown field mode'],
  ['a wrong schema version', mutate(f => { f.schemaVersion = 2 }), 'schemaVersion must be 1'],
  ['a bad plan id', mutate(f => { f.planId = 'Bad Id' }), 'planId must match'],
  ['an empty goal', mutate(f => { f.goal = ' ' }), 'goal must be a non-empty string'],
  ['maxBlocks at the engine cap', mutate(f => { f.limits = { maxBlocks: 8 } }), 'limits.maxBlocks must be an integer from 1 to 7'],
  ['an unknown limit', mutate(f => { f.limits = { budget: 1 } }), 'limits: unknown field budget'],
  ['no tasks', mutate(f => { f.tasks = [] }), 'tasks must be a non-empty list'],
  ['a bad task id', mutate(f => { f.tasks[0].id = '1st' }), 'tasks[0].id must match'],
  ['an unknown task field', mutate(f => { f.tasks[0].owner = 'me' }), 'T1: unknown field owner'],
  ['an absolute file', mutate(f => { f.tasks[0].files = ['/etc/passwd'] }), 'must be relative'],
  ['a file escaping the repository', mutate(f => { f.tasks[0].files = ['../x'] }), 'must be relative'],
  ['no acceptance', mutate(f => { f.tasks[0].acceptance = {} }), 'acceptance needs at least one check or criterion'],
  ['a shell string as check', mutate(f => { f.tasks[0].acceptance = { checks: [{ argv: 'npm test' }] } }), 'argv must be a non-empty list'],
  ['a check command that starts with a dash', mutate(f => { f.tasks[0].acceptance.checks[0].argv = ['-i', 'npm', 'test'] }), 'argv[0] must be the command: it cannot start with "-" or contain "="'],
  ['a check command that is an assignment', mutate(f => { f.tasks[0].acceptance.checks[0].argv = ['CI=1', 'npm', 'test'] }), 'argv[0] must be the command'],
  ['a check cwd outside', mutate(f => { f.tasks[0].acceptance.checks[0].cwd = '../up' }), 'cwd must be a relative path'],
  ['a long timeout', mutate(f => { f.tasks[0].acceptance.checks[0].timeoutSec = 601 }), 'timeoutSec must be an integer from 1 to 600'],
  ['duplicate ids', mutate(f => { f.tasks[1].id = 'T1' }), 'duplicate task ids: T1'],
  ['an unknown dependency', mutate(f => { f.tasks[1].dependsOn = ['T9'] }), 'T2: dependsOn unknown task T9'],
  ['a self dependency', mutate(f => { f.tasks[1].dependsOn = ['T2'] }), 'T2: dependsOn itself'],
  ['a cycle', mutate(f => { f.tasks[0].dependsOn = ['T2'] }), 'dependsOn cycle: T1 -> T2 -> T1'],
  ['an unknown onFail', mutate(f => { f.tasks[0].onFail = 'T9' }), 'onFail names unknown task T9'],
  ['onFail on itself', mutate(f => { f.tasks[0].onFail = 'T1' }), 'onFail cannot target itself'],
  ['a bad loop', mutate(f => { f.tasks[0].loop = { maxIterations: 0 } }), 'loop must be { maxIterations }'],
  ['a side effect without a check', mutate(f => { f.tasks[1].sideEffect = true }), 'a sideEffect task needs a check'],
  ['criteria on a side effect', mutate(f => { f.tasks[0].sideEffect = true; f.tasks[0].acceptance.criteria = ['looks right'] }), 'T1: a sideEffect task cannot have criteria; move criteria to a preceding task'],
  ['risk on a side effect', mutate(f => { f.tasks[0].sideEffect = true; f.tasks[0].risk = true }), 'T1: a sideEffect task cannot be risk; review in a preceding task'],
  ['an unknown role', mutate(f => { f.tasks[0].role = 'wizard' }), 'T1: role wizard is not a task role; task roles are developer or ux'],
  ['a non-string role', mutate(f => { f.tasks[0].role = 3 }), 'T1: role must be developer or ux'],
  ['a read-only role', mutate(f => { f.tasks[0].role = 'architect' }), 'T1: role architect is not a task role; task roles are developer or ux'],
  ['a reader role', mutate(f => { f.tasks[0].role = 'code-reader' }), 'T1: role code-reader is not a task role; task roles are developer or ux'],
  ['the git role', mutate(f => { f.tasks[0].role = 'git' }), 'T1: role git is not a task role; task roles are developer or ux'],
  ['a non-boolean risk', mutate(f => { f.tasks[0].risk = 'yes' }), 'risk must be a boolean'],
] as const) {
  test(`rejects ${label}`, () => {
    expect(errorsOf(flow).join('\n')).toContain(error)
  })
}

const branched = () => {
  const result = validateFlow({
    schemaVersion: 1, planId: 'graph', goal: 'Release',
    tasks: [
      { id: 'plan', goal: 'Plan', files: ['docs/'], acceptance: { criteria: ['plan written'] } },
      { id: 'core', goal: 'Core', files: ['src/core/'], acceptance: { criteria: ['core works'] } },
      { id: 'cli', goal: 'CLI', files: ['src/cli/'], dependsOn: ['core'], acceptance: { criteria: ['cli works'] } },
      { id: 'docs', goal: 'Docs', files: ['README.md'], dependsOn: ['core'], acceptance: { criteria: ['documented'] } },
      { id: 'test', goal: 'Tests', files: ['tests/'], dependsOn: ['cli', 'docs'], loop: { maxIterations: 3 }, onFail: 'debug', acceptance: { checks: [{ argv: ['npm', 'test'] }] } },
      { id: 'debug', goal: 'Debug', files: ['src/'], dependsOn: [], acceptance: { criteria: ['root cause fixed'] } },
      { id: 'release', goal: 'Release', files: ['CHANGELOG.md'], dependsOn: ['test'], sideEffect: true, acceptance: { checks: [{ argv: ['git', 'tag', '-l', 'v1'] }] } },
    ],
  })
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return result.flow
}

test('onFail targets nothing depends on are branches, not required', () => {
  const flow = branched()
  expect([...branchOnly(flow.tasks)]).toEqual(['debug'])
  expect(requiredTasks(flow)).toEqual(['plan', 'core', 'cli', 'docs', 'test', 'release'])
})

test('eligibility follows the graph and never offers a branch', () => {
  const flow = branched()
  expect(eligible(flow, {})).toEqual(['plan'])
  expect(eligible(flow, { plan: 'done', core: 'done' })).toEqual(['cli', 'docs'])
  expect(eligible(flow, { plan: 'done', core: 'done', cli: 'done' })).toEqual(['docs'])
  expect(eligible(flow, { plan: 'done', core: 'done', cli: 'done', docs: 'done' })).toEqual(['test'])
})

for (const [pattern, path, expected] of [
  ['src/a.ts', 'src/a.ts', true],
  ['src/a.ts', 'src/a.tsx', false],
  ['src/', 'src/deep/a.ts', true],
  ['src/', 'srcx/a.ts', false],
  ['src/*.ts', 'src/a.ts', true],
  ['src/*.ts', 'src/deep/a.ts', false],
  ['src/**/*.ts', 'src/a.ts', true],
  ['src/**/*.ts', 'src/deep/er/a.ts', true],
  ['src/**', 'src/deep/a.ts', true],
  ['a.b', 'axb', false],
] as const) {
  test(`glob ${pattern} ${expected ? 'matches' : 'does not match'} ${path}`, () => {
    expect(matchGlob(pattern, path)).toBe(expected)
  })
}

test('ownership accepts ./ prefixes on either side', () => {
  expect(ownsPath({ files: ['./src/'] }, 'src/a.ts')).toBe(true)
  expect(ownsPath({ files: ['src/a.ts'] }, './src/a.ts')).toBe(true)
  expect(ownsPath({ files: ['src/a.ts'] }, 'src/b.ts')).toBe(false)
})

const roleOf = (patch: (flow: any) => void) => {
  const result = validateFlow(mutate(patch))
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return result
}

test('an explicit role is kept', () => {
  const result = roleOf(f => { f.tasks[0].role = 'developer'; f.tasks[1].role = 'ux' })
  expect(result.flow.tasks.map(task => task.role)).toEqual(['developer', 'ux'])
})

test('the default role is developer whatever the files, UI files included', () => {
  expect(roleOf(f => { f.tasks[0].files = ['src/ui/App.tsx', 'src/ui/app.css'] }).flow.tasks[0].role).toBe('developer')
  expect(roleOf(f => { f.tasks[0].files = ['src/ui/App.TSX', 'src/api.ts'] }).flow.tasks[0].role).toBe('developer')
  expect(roleOf(f => {}).flow.tasks.map(task => task.role)).toEqual(['developer', 'developer'])
  expect(roleOf(f => { f.tasks[0].files = ['a.tsx']; f.tasks[0].role = 'ux' }).flow.tasks[0].role).toBe('ux')
})

test('the hash changes with the role, explicit or defaulted', () => {
  const hashOf = (patch: (flow: any) => void) => roleOf(patch).hash
  const plain = hashOf(f => {})
  expect(hashOf(f => { f.tasks[0].role = 'ux' })).not.toBe(plain)
  expect(hashOf(f => { f.tasks[0].role = 'developer' })).toBe(plain)
  // The default does not depend on the files, so naming developer explicitly changes nothing.
  const ui = hashOf(f => { f.tasks[0].files = ['a.tsx'] })
  expect(hashOf(f => { f.tasks[0].files = ['a.tsx']; f.tasks[0].role = 'developer' })).toBe(ui)
  expect(hashOf(f => { f.tasks[0].files = ['a.tsx']; f.tasks[0].role = 'ux' })).not.toBe(ui)
})

test('the parser reports which tasks left dependsOn out', () => {
  const result = validateFlow({
    schemaVersion: 1, planId: 'p', goal: 'g',
    tasks: [
      { id: 'A', goal: 'a', files: ['a'], acceptance: { criteria: ['x'] } },
      { id: 'B', goal: 'b', files: ['b'], acceptance: { criteria: ['x'] } },
      { id: 'C', goal: 'c', files: ['c'], dependsOn: ['A'], acceptance: { criteria: ['x'] } },
      { id: 'D', goal: 'd', files: ['d'], dependsOn: [], acceptance: { criteria: ['x'] } },
    ],
  })
  if (!result.ok) throw new Error(result.errors.join('; '))
  // The first task has no task before it, so there is nothing to default.
  expect(result.implicit).toEqual(['B'])
  expect(parseFlow(plan(base())).ok && (parseFlow(plan(base())) as { implicit: string[] }).implicit).toEqual(['T2'])
})

// --- ownership overlap ---

for (const [a, b, expected] of [
  ['src/a.ts', 'src/a.ts', true],
  ['src/a.ts', 'src/b.ts', false],
  ['src/', 'src/a.ts', true],
  ['./src/', 'src/a.ts', true],
  ['src/', 'lib/', false],
  ['src/', 'src/deep/', true],
  ['src/deep/', 'src/', true],
  ['src/*.ts', 'src/a.ts', true],
  ['src/*.ts', 'src/a.js', false],
  ['src/*.ts', 'src/*.js', false],
  ['src/*.ts', 'src/*.ts', true],
  ['src/*', 'src/**', true],
  ['src/**', 'docs/**', false],
  ['**/a.ts', 'a.ts', true],
  ['**/a.ts', 'src/a.ts', true],
  ['**/a.ts', '**/b.ts', false],
  ['a/**/b.ts', 'a/b.ts', true],
  ['src/a*', 'src/b*', false],
  ['src/ab*', 'src/a*', true],
  // Never "no" when a path could match both: a glob and a directory it can reach are told to overlap.
  ['*.md', 'src/', true],
  ['**', 'src/deep/a.ts', true],
] as const) {
  test(`ownership ${a} and ${b} ${expected ? 'may overlap' : 'cannot overlap'}`, () => {
    expect(globsOverlap(a, b)).toBe(expected)
    expect(globsOverlap(b, a)).toBe(expected)
  })
}

test('lists of patterns overlap when any pair does', () => {
  expect(filesOverlap(['docs/', 'src/a.ts'], ['lib/', 'src/*.ts'])).toBe(true)
  expect(filesOverlap(['docs/'], ['lib/', 'src/*.ts'])).toBe(false)
  expect(filesOverlap([], ['lib/'])).toBe(false)
})

// --- amendments (decision 19) ---

type RawTask = Record<string, any>
const raw = (tasks: RawTask[], extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, planId: 'amend', goal: 'Ship it', ...extra, tasks })
const parsed = (value: unknown): { flow: Flow; implicit: string[] } => {
  const result = validateFlow(value)
  if (!result.ok) throw new Error(result.errors.join('; '))
  return { flow: result.flow, implicit: result.implicit }
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

// A done, B active, C pending and risky, D pending behind C, and F an onFail branch of A that nothing depends on.
const BASE_TASKS = (): RawTask[] => [
  { id: 'A', goal: 'Core', files: ['src/a.ts', 'src/a2.ts'], dependsOn: [], onFail: 'F', acceptance: { checks: [{ argv: ['npm', 'test'] }] } },
  { id: 'B', goal: 'Lint', files: ['src/b/**'], dependsOn: ['A'], acceptance: { checks: [{ argv: ['npm', 'run', 'lint'], cwd: 'tools', timeoutSec: 60 }] } },
  { id: 'C', goal: 'Docs', files: ['docs/'], dependsOn: ['B'], risk: true, acceptance: { criteria: ['reads well'] } },
  { id: 'D', goal: 'Lib', files: ['lib/d.ts'], dependsOn: ['C'], acceptance: { checks: [{ argv: ['npm', 'test'] }] } },
  { id: 'F', goal: 'Fallback', files: ['fallback/'], dependsOn: [], acceptance: { checks: [{ argv: ['git', 'status'] }] } },
]
const EFFECTIVE = parsed(raw(BASE_TASKS())).flow
const STATE: AmendState = {
  status: { A: 'done', B: 'active', C: 'pending', D: 'pending', F: 'pending' },
  attempts: {}, ends: { A: 1 }, awaiting: [], receipts: {},
}
const NEW_TASK = (extra: RawTask = {}): RawTask => ({ id: 'N1', goal: 'More', files: ['extra/n1.ts'], dependsOn: ['D'], acceptance: { criteria: ['works'] }, ...extra })

/** The effective flow edited by `change` (on the raw tasks and the raw plan), then run through `amend`. */
function amended(change: (tasks: RawTask[], plan: Record<string, any>) => void, options: { state?: Partial<AmendState>; seen?: string[]; effective?: Flow } = {}) {
  const tasks = BASE_TASKS()
  const plan: Record<string, any> = raw(tasks)
  change(tasks, plan)
  plan.tasks = tasks
  const edited = parsed(plan)
  const state: AmendState = { ...STATE, ...options.state }
  return amend(options.effective ?? EFFECTIVE, edited.flow, state, { seenIds: options.seen ?? [] }, edited.implicit)
}
const byId = (tasks: RawTask[], id: string) => tasks.find(task => task.id === id)!

for (const [label, change, options] of [
  ['an unchanged plan', () => {}, {}],
  ['a task appended at the end', tasks => { tasks.push(NEW_TASK()) }, {}],
  ['a task that reuses an approved command', tasks => { tasks.push(NEW_TASK({ acceptance: { checks: [{ argv: ['npm', 'test'] }] } })) }, {}],
  ['a task that reuses a command with its cwd and a lower timeout', tasks => { tasks.push(NEW_TASK({ acceptance: { checks: [{ argv: ['npm', 'run', 'lint'], cwd: 'tools', timeoutSec: 30 }] } })) }, {}],
  ['a task that reuses a command at its approved timeout', tasks => { tasks.push(NEW_TASK({ acceptance: { checks: [{ argv: ['npm', 'run', 'lint'], cwd: 'tools', timeoutSec: 60 }], criteria: ['and by hand'] } })) }, {}],
  ['a task behind a done task, a pending task and another new task', tasks => {
    tasks.push(NEW_TASK({ id: 'N1', dependsOn: ['A'] }), NEW_TASK({ id: 'N2', files: ['extra/n2.ts'], dependsOn: ['N1', 'D'] }))
  }, {}],
  ['a risky task appended', tasks => { tasks.push(NEW_TASK({ risk: true })) }, {}],
  ['a ux task appended', tasks => { tasks.push(NEW_TASK({ role: 'ux' })) }, {}],
  ['a task with a loop within maxAttempts', tasks => { tasks.push(NEW_TASK({ loop: { maxIterations: 2 } })) }, {}],
  ['extra criteria on a pending task', tasks => { byId(tasks, 'C').acceptance.criteria.push('has an example') }, {}],
  ['an approved command added to a pending task', tasks => { byId(tasks, 'D').acceptance.checks.push({ argv: ['npm', 'run', 'lint'], cwd: 'tools', timeoutSec: 45 }) }, {}],
  ['an approved command and a criterion added to a pending task', tasks => {
    byId(tasks, 'C').acceptance.checks = [{ argv: ['npm', 'test'] }]
    byId(tasks, 'C').acceptance.criteria.push('has an example')
  }, {}],
  ['risk raised on a pending task', tasks => { byId(tasks, 'D').risk = true }, {}],
  ['risk raised on an active task', tasks => { byId(tasks, 'B').risk = true }, {}],
  ['the same files and dependencies in another order', tasks => {
    byId(tasks, 'A').files.reverse()
    byId(tasks, 'D').dependsOn = ['C']
  }, {}],
  ['a task whose id was used by nobody else, with unrelated ids in the history', tasks => { tasks.push(NEW_TASK()) }, { seen: ['A', 'B', 'old-task'] }],
  ['everything additive at once', tasks => {
    byId(tasks, 'C').acceptance.criteria.push('has an example')
    byId(tasks, 'D').acceptance.checks.push({ argv: ['npm', 'run', 'lint'], cwd: 'tools', timeoutSec: 60 })
    byId(tasks, 'D').risk = true
    tasks.push(NEW_TASK(), NEW_TASK({ id: 'N2', files: ['extra/n2.ts'], dependsOn: ['N1'], acceptance: { checks: [{ argv: ['npm', 'test'] }] } }))
  }, {}],
] as [string, (tasks: RawTask[], plan: Record<string, any>) => void, Parameters<typeof amended>[1]][]) {
  test(`amend adopts ${label}`, () => {
    const result = amended(change, options)
    expect(result).toHaveProperty('adopt')
    if ('adopt' in result) {
      expect(requiredTasks(result.adopt)).toEqual(expect.arrayContaining(requiredTasks(EFFECTIVE)))
      expect(result.adopt.tasks.slice(0, EFFECTIVE.tasks.length).map(task => task.id)).toEqual(EFFECTIVE.tasks.map(task => task.id))
    }
  })
}

for (const [label, change, why, options] of [
  // what the person must approve: weakening, and anything the allowlist does not name
  ['an onFail retarget that makes a required task branch-only', tasks => { byId(tasks, 'B').onFail = 'C' }, 'B: onFail changed', {}],
  ['an onFail removed from a task', tasks => { delete byId(tasks, 'A').onFail }, 'A: onFail changed', {}],
  ['an onFail on a task appended', tasks => { tasks.push(NEW_TASK({ onFail: 'F' })) }, 'N1: onFail waits for approval', {}],
  ['a sideEffect task appended', tasks => { tasks.push(NEW_TASK({ sideEffect: true, acceptance: { checks: [{ argv: ['npm', 'test'] }] } })) }, 'N1: sideEffect waits for approval', {}],
  ['sideEffect set on an existing task', tasks => { byId(tasks, 'D').sideEffect = true }, 'D: sideEffect changed', {}],
  ['an id the ledger already holds', tasks => { tasks.push(NEW_TASK({ id: 'DEPLOY' })) }, 'DEPLOY: the id was used before', { seen: ['DEPLOY'] }],
  ['an id the journal holds', tasks => { tasks.push(NEW_TASK()) }, 'N1: the id was used before', { seen: ['N1'] }],
  ['a cwd change on an approved check', tasks => { byId(tasks, 'B').acceptance.checks[0].cwd = 'elsewhere' }, 'approved check 1', {}],
  ['a cwd added to an approved check', tasks => { byId(tasks, 'A').acceptance.checks[0].cwd = 'sub' }, 'approved check 1', {}],
  ['a timeout raise on an approved check', tasks => { byId(tasks, 'B').acceptance.checks[0].timeoutSec = 120 }, 'the timeout of `npm run lint` was raised from 60 to 120 s', {}],
  ['a timeout lowered on an approved check', tasks => { byId(tasks, 'B').acceptance.checks[0].timeoutSec = 30 }, 'was lowered from 60 to 30 s', {}],
  ['an approved command changed', tasks => { byId(tasks, 'A').acceptance.checks[0].argv = ['true'] }, 'approved check 1 (`npm test`) was changed, moved or removed', {}],
  ['an approved check removed', tasks => { byId(tasks, 'D').acceptance.checks = []; byId(tasks, 'D').acceptance.criteria = ['by hand'] }, 'approved check 1', {}],
  ['approved checks reordered', tasks => { byId(tasks, 'D').acceptance.checks.unshift({ argv: ['git', 'status'] }) }, 'approved check 1', {}],
  ['a new command on a task appended', tasks => { tasks.push(NEW_TASK({ acceptance: { checks: [{ argv: ['npm', 'run', 'deploy'] }] } })) }, 'N1: new command `npm run deploy` is not one of the approved checks', {}],
  ['a new command on a pending task', tasks => { byId(tasks, 'D').acceptance.checks.push({ argv: ['npm', 'run', 'deploy'] }) }, 'D: new command `npm run deploy`', {}],
  ['an approved command with another cwd on a pending task', tasks => { byId(tasks, 'D').acceptance.checks.push({ argv: ['npm', 'run', 'lint'], cwd: 'other' }) }, 'D: new command `npm run lint` (in other)', {}],
  ['an approved command without its cwd on a pending task', tasks => { byId(tasks, 'D').acceptance.checks.push({ argv: ['npm', 'run', 'lint'] }) }, 'D: new command `npm run lint`', {}],
  ['an approved command above its approved timeout', tasks => { byId(tasks, 'D').acceptance.checks.push({ argv: ['npm', 'run', 'lint'], cwd: 'tools', timeoutSec: 90 }) }, 'D: `npm run lint` asks for 90 s, above the 60 s approved', {}],
  ['a task appended with an approved command above its timeout', tasks => { tasks.push(NEW_TASK({ acceptance: { checks: [{ argv: ['npm', 'test'], timeoutSec: 500 }] } })) }, 'N1: `npm test` asks for 500 s, above the 120 s approved', {}],
  ['a dependency on an active task', tasks => { tasks.push(NEW_TASK({ dependsOn: ['B'] })) }, 'N1: depends on B, which is active', {}],
  ['files that overlap a pending task', tasks => { tasks.push(NEW_TASK({ files: ['docs/guide.md'] })) }, 'N1: its files overlap C, which is pending', {}],
  ['files that overlap an active task', tasks => { tasks.push(NEW_TASK({ files: ['src/b/extra.ts'] })) }, 'N1: its files overlap B, which is active', {}],
  ['files that overlap a failed task', tasks => { tasks.push(NEW_TASK({ files: ['src/a.ts'] })) }, 'N1: its files overlap A, which is failed', { state: { status: { ...STATE.status, A: 'failed' } } }],
  ['files that overlap the onFail branch', tasks => { tasks.push(NEW_TASK({ files: ['fallback/x.ts'] })) }, 'N1: its files overlap F', {}],
  ['two tasks appended with overlapping files', tasks => { tasks.push(NEW_TASK(), NEW_TASK({ id: 'N2', files: ['extra/'] })) }, 'N2: its files overlap N1, added in the same edit', {}],
  ['a task appended with its dependsOn left out', tasks => { const { dependsOn: _gone, ...task } = NEW_TASK(); tasks.push(task) }, 'N1: write dependsOn out', {}],
  ['a task appended behind an onFail branch', tasks => { tasks.push(NEW_TASK({ dependsOn: ['F'] })) }, 'N1: depends on F, an onFail branch', {}],
  ['a task appended with a loop above maxAttempts', tasks => { tasks.push(NEW_TASK({ loop: { maxIterations: 5 } })) }, 'N1: loop asks for more iterations than maxAttempts (2)', {}],
  ['a loop added to an existing task', tasks => { byId(tasks, 'D').loop = { maxIterations: 9 } }, 'D: loop changed', {}],
  ['the goal changed', (_tasks, plan) => { plan.goal = 'Another goal' }, "the plan's goal changed", {}],
  ['the limits changed', (_tasks, plan) => { plan.limits = { maxAttempts: 9 } }, "the plan's limits changed", {}],
  ['the plan id changed', (_tasks, plan) => { plan.planId = 'other' }, "the plan's planId changed", {}],
  ['a task goal changed', tasks => { byId(tasks, 'D').goal = 'Do something else' }, 'D: goal changed', {}],
  ['a role changed', tasks => { byId(tasks, 'D').role = 'ux' }, 'D: role changed', {}],
  ['a task\'s files changed', tasks => { byId(tasks, 'D').files = ['lib/d.ts', 'etc/'] }, 'D: files changed', {}],
  ['a dependency dropped', tasks => { byId(tasks, 'D').dependsOn = [] }, 'D: dependsOn changed', {}],
  ['a dependency added to an existing task', tasks => { tasks.push(NEW_TASK({ dependsOn: ['A'] })); byId(tasks, 'C').dependsOn = ['B', 'N1'] }, 'C: dependsOn changed', {}],
  ['risk lowered', tasks => { byId(tasks, 'C').risk = false }, 'C: risk was lowered', {}],
  ['a criterion changed', tasks => { byId(tasks, 'C').acceptance.criteria = ['reads fine'] }, 'C: an approved criterion was changed, moved or removed', {}],
  ['a criterion removed', tasks => { byId(tasks, 'C').acceptance.criteria = []; byId(tasks, 'C').acceptance.checks = [{ argv: ['npm', 'test'] }] }, 'C: an approved criterion was changed, moved or removed', {}],
  ['a criterion put in front of an approved one', tasks => { byId(tasks, 'C').acceptance.criteria.unshift('first') }, 'C: an approved criterion was changed, moved or removed', {}],
  ['extra criteria on an active task', tasks => { byId(tasks, 'B').acceptance.criteria = ['also by hand'] }, 'B: it already started', {}],
  ['extra criteria on a done task', tasks => { byId(tasks, 'A').acceptance.criteria = ['also by hand'] }, 'A: it already started', {}],
  ['an approved command added to an active task', tasks => { byId(tasks, 'B').acceptance.checks.push({ argv: ['npm', 'test'] }) }, 'B: it already started', {}],
  ['extra criteria on a pending task that was already delivered once', tasks => { byId(tasks, 'C').acceptance.criteria.push('more') }, 'C: it already started', { state: { ends: { A: 1, C: 1 } } }],
  ['extra criteria on a pending task that has an attempt', tasks => { byId(tasks, 'C').acceptance.criteria.push('more') }, 'C: it already started', { state: { attempts: { C: 1 } } }],
  ['extra criteria on a pending task that awaits a receipt', tasks => { byId(tasks, 'C').acceptance.criteria.push('more') }, 'C: it already started', { state: { awaiting: [{ task: 'C' }] } }],
  ['a task removed', tasks => { tasks.splice(3, 1) }, 'task D was removed', {}],
  ['a task removed after it was added', () => {}, 'task N1 was removed', {
    effective: parsed(raw([...BASE_TASKS(), NEW_TASK()])).flow,
  }],
  ['a task swapped for another', tasks => { tasks.splice(3, 1); tasks.push(NEW_TASK({ id: 'N9', dependsOn: ['C'] })) }, 'task D was removed', {}],
  ['tasks reordered', tasks => { tasks.splice(1, 0, tasks.splice(3, 1)[0]!) }, 'the existing tasks were reordered', {}],
  ['a task inserted in the middle', tasks => { tasks.splice(1, 0, NEW_TASK({ id: 'MID', files: ['mid/'], dependsOn: ['A'] })) }, 'MID: new tasks go after every existing one', {}],
] as [string, (tasks: RawTask[], plan: Record<string, any>) => void, string, Parameters<typeof amended>[1]][]) {
  test(`amend leaves ${label} for approval`, () => {
    const result = amended(change, options)
    expect(result).toHaveProperty('pending')
    if ('pending' in result) expect(result.pending.join('\n')).toContain(why)
  })
}

test('inserting a task changes an implicit dependsOn, so the edit waits for approval', () => {
  const implicit = raw([
    { id: 'A', goal: 'a', files: ['a/'], acceptance: { checks: [{ argv: ['npm', 'test'] }] } },
    { id: 'B', goal: 'b', files: ['b/'], acceptance: { checks: [{ argv: ['npm', 'test'] }] } },
    { id: 'C', goal: 'c', files: ['c/'], acceptance: { criteria: ['x'] } },
  ])
  const base = parsed(implicit).flow
  const inserted = parsed(raw([
    { id: 'A', goal: 'a', files: ['a/'], acceptance: { checks: [{ argv: ['npm', 'test'] }] } },
    { id: 'X', goal: 'x', files: ['x/'], dependsOn: ['A'], acceptance: { criteria: ['x'] } },
    { id: 'B', goal: 'b', files: ['b/'], acceptance: { checks: [{ argv: ['npm', 'test'] }] } },
    { id: 'C', goal: 'c', files: ['c/'], acceptance: { criteria: ['x'] } },
  ]))
  expect(base.tasks.find(task => task.id === 'B')!.dependsOn).toEqual(['A'])
  expect(inserted.flow.tasks.find(task => task.id === 'B')!.dependsOn).toEqual(['X'])
  const state: AmendState = { status: { A: 'done', B: 'pending', C: 'pending' }, attempts: {}, ends: {}, awaiting: [], receipts: {} }
  const result = amend(base, inserted.flow, state, { seenIds: [] }, inserted.implicit)
  expect(result).toHaveProperty('pending')
  if ('pending' in result) {
    expect(result.pending).toContain('X: new tasks go after every existing one')
    expect(result.pending).toContain('B: dependsOn changed')
  }
  // The same task appended at the end, with dependsOn written out, is the additive form of that edit.
  const appended = parsed(raw([
    { id: 'A', goal: 'a', files: ['a/'], acceptance: { checks: [{ argv: ['npm', 'test'] }] } },
    { id: 'B', goal: 'b', files: ['b/'], acceptance: { checks: [{ argv: ['npm', 'test'] }] } },
    { id: 'C', goal: 'c', files: ['c/'], acceptance: { criteria: ['x'] } },
    { id: 'X', goal: 'x', files: ['x/'], dependsOn: ['A'], acceptance: { criteria: ['x'] } },
  ]))
  expect(amend(base, appended.flow, state, { seenIds: [] }, appended.implicit)).toHaveProperty('adopt')
  // An appended task that leaves dependsOn out would silently follow whichever task is last.
  const quiet = parsed(raw([
    { id: 'A', goal: 'a', files: ['a/'], acceptance: { checks: [{ argv: ['npm', 'test'] }] } },
    { id: 'B', goal: 'b', files: ['b/'], acceptance: { checks: [{ argv: ['npm', 'test'] }] } },
    { id: 'C', goal: 'c', files: ['c/'], acceptance: { criteria: ['x'] } },
    { id: 'X', goal: 'x', files: ['x/'], acceptance: { criteria: ['x'] } },
  ]))
  expect(quiet.implicit).toEqual(['B', 'C', 'X'])
  expect(amend(base, quiet.flow, state, { seenIds: [] }, quiet.implicit)).toHaveProperty('pending')
})

test('adoptions chain: each edit is judged against what was adopted before it', () => {
  const first = amended(tasks => { tasks.push(NEW_TASK()) })
  if (!('adopt' in first)) throw new Error('the first edit should be adopted')
  const tasks = BASE_TASKS()
  tasks.push(NEW_TASK())
  // A second addition builds on the first one's task, which the approved plan never had.
  const secondRaw = raw([...tasks, NEW_TASK({ id: 'N2', files: ['extra/n2.ts'], dependsOn: ['N1'] })])
  const second = parsed(secondRaw)
  const state: AmendState = { ...STATE, status: { ...STATE.status, N1: 'pending' } }
  const adopted = amend(first.adopt, second.flow, state, { seenIds: [] }, second.implicit)
  expect(adopted).toHaveProperty('adopt')
  // Going back to the approved text removes what was adopted: a removal against the flow in force.
  const back = parsed(raw(BASE_TASKS()))
  const removal = amend(first.adopt, back.flow, state, { seenIds: [] }, back.implicit)
  expect(removal).toEqual({ pending: ['task N1 was removed'] })
  // Changing a task adopted earlier is a change of an existing task, however recently it came in.
  const changed = parsed(raw([...BASE_TASKS(), NEW_TASK({ goal: 'Something else' })]))
  const edit = amend(first.adopt, changed.flow, state, { seenIds: [] }, changed.implicit)
  expect(edit).toEqual({ pending: ['N1: goal changed'] })
  // And what was adopted counts as taken: an id never comes back under a new meaning.
  const reused = amend(EFFECTIVE, first.adopt, STATE, { seenIds: ['N1'] }, [])
  expect(reused).toEqual({ pending: ['N1: the id was used before; an id is never reused'] })
})

test('amend reports every reason, once, and never changes its inputs', () => {
  const tasks = BASE_TASKS()
  byId(tasks, 'D').goal = 'Different'
  byId(tasks, 'B').acceptance.checks[0].timeoutSec = 600
  tasks.push(NEW_TASK({ sideEffect: true, acceptance: { checks: [{ argv: ['npm', 'run', 'deploy'] }] } }))
  const edited = parsed(raw(tasks, { goal: 'Other' }))
  const frozen = {
    effective: deepFreeze(clone(EFFECTIVE)), edited: deepFreeze(clone(edited.flow)), state: deepFreeze(clone(STATE)),
    history: deepFreeze({ seenIds: ['DEPLOY'] }), implicit: deepFreeze([...edited.implicit]),
  }
  const result = amend(frozen.effective, frozen.edited, frozen.state, frozen.history, frozen.implicit)
  expect(result).toHaveProperty('pending')
  if ('pending' in result) {
    expect(result.pending).toEqual(expect.arrayContaining([
      "the plan's goal changed", 'D: goal changed', 'B: the timeout of `npm run lint` was raised from 60 to 600 s',
      'N1: sideEffect waits for approval', 'N1: new command `npm run deploy` is not one of the approved checks',
    ]))
    expect(new Set(result.pending).size).toBe(result.pending.length)
  }
  expect(clone(frozen.edited)).toEqual(edited.flow)
})

test('a field this version does not know on a new task or on the plan is not adopted', () => {
  const extra = parsed(raw([...BASE_TASKS(), NEW_TASK()]))
  ;(extra.flow.tasks[5] as unknown as Record<string, unknown>).owner = 'me'
  const task = amend(EFFECTIVE, extra.flow, STATE, { seenIds: [] }, [])
  expect(task).toEqual({ pending: ['N1: it carries fields this version does not adopt'] })
  const plan = parsed(raw(BASE_TASKS()))
  ;(plan.flow as unknown as Record<string, unknown>).mode = 'enforce'
  expect(amend(EFFECTIVE, plan.flow, STATE, { seenIds: [] }, [])).toEqual({ pending: ["the plan's mode changed"] })
})

test('the edit is judged against the flow in force even when the plan file is the older one', () => {
  // The effective flow grew by an adoption; the file was reverted to the approved text: the extra task is "removed".
  const grown = parsed(raw([...BASE_TASKS(), NEW_TASK()])).flow
  const reverted = parsed(raw(BASE_TASKS()))
  const result = amend(grown, reverted.flow, { ...STATE, status: { ...STATE.status, N1: 'pending' } }, { seenIds: [] }, reverted.implicit)
  expect(result).toEqual({ pending: ['task N1 was removed'] })
})

// --- limits (M2) and the roots no task owns ---

const oneTask = (patch: (task: any) => void) => mutate(f => { patch(f.tasks[0]) })
const many = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i))

for (const [label, flow, error] of [
  ['more tasks than the limit', mutate(f => { f.tasks = many(101, i => ({ id: `T${i}`, goal: 'g', files: [`f${i}`], dependsOn: [], acceptance: { criteria: ['x'] } })) }), 'a flow has at most 100 tasks; this one has 101'],
  ['more files than the limit', oneTask(t => { t.files = many(51, i => `src/f${i}.ts`) }), 'at most 50 files or globs per task; this one lists 51'],
  ['more checks than the limit', oneTask(t => { t.acceptance = { checks: many(21, i => ({ argv: ['run', String(i)] })) } }), 'at most 20 checks per task; this one lists 21'],
  ['more criteria than the limit', oneTask(t => { t.acceptance = { criteria: many(21, i => `criterion ${i}`) } }), 'at most 20 criteria per task; this one lists 21'],
  ['an argv with too many words', oneTask(t => { t.acceptance = { checks: [{ argv: many(65, i => `w${i}`) }] } }), 'argv has more than 64 words'],
  ['a file pattern that is too long', oneTask(t => { t.files = [`src/${'a'.repeat(300)}.ts`] }), 'a file pattern is at most 300 characters'],
  ['a pattern with too many wildcards', oneTask(t => { t.files = ['a/*/*/*/*/*/*/*/*/*.ts'] }), 'has more than 8 wildcards'],
  ['a dependsOn list longer than the tasks can be', oneTask(t => { t.dependsOn = many(101, i => `T${i}`) }), 'dependsOn must be a list of task ids'],
  ['files in .pantheon', oneTask(t => { t.files = ['.pantheon/flow/demo/approved.json'] }), 'is inside .pantheon, which no task owns'],
  ['the whole .pantheon directory', oneTask(t => { t.files = ['.pantheon/'] }), 'is inside .pantheon, which no task owns'],
  ['the plans directory', oneTask(t => { t.files = ['./.pantheon/plans/a.md'] }), 'is inside .pantheon, which no task owns'],
  ['files in .git', oneTask(t => { t.files = ['.git/hooks/pre-commit'] }), 'is inside .git, which no task owns'],
  ['files in .claude', oneTask(t => { t.files = ['.claude/settings.json'] }), 'is inside .claude, which no task owns'],
  ['a protected root spelled in another case', oneTask(t => { t.files = ['.PANTHEON/flow/x', 'docs/a.md'] }), 'is inside .pantheon, which no task owns'],
] as const) {
  test(`rejects ${label}`, () => {
    expect(errorsOf(flow).join('\n')).toContain(error)
  })
}

test('a plan at the limits is still a plan, and similar names are not the protected roots', () => {
  const edge = mutate(f => {
    f.tasks = many(100, i => ({
      id: `T${i}`, goal: 'g', dependsOn: [],
      files: many(50, j => `src/t${i}/f${j}.ts`),
      acceptance: { checks: many(1, j => ({ argv: many(64, k => `w${j}${k}`) })), criteria: many(20, j => `criterion ${j}`) },
    }))
  })
  expect(errorsOf(edge)).toEqual([])
  for (const file of ['.pantheonx/a', 'docs/.pantheon/a.md', '.github/workflows/ci.yml', '.gitignore', '.gitattributes', '.claudex/a', '.pantheon-notes/a']) {
    expect(errorsOf(oneTask(t => { t.files = [file] })), file).toEqual([])
  }
})

test('a plan holds at most 100 checks in all, so that approval lists every command', () => {
  const spread = (count: number) => mutate(f => {
    f.tasks = many(Math.ceil(count / 20), i => ({
      id: `T${i}`, goal: 'g', dependsOn: [], files: [`src/t${i}`],
      acceptance: { checks: many(Math.min(20, count - i * 20), j => ({ argv: ['run', `${i}-${j}`] })) },
    }))
  })
  expect(errorsOf(spread(100))).toEqual([])
  expect(errorsOf(spread(101)).join('\n')).toContain('a flow has at most 100 checks in all, so that approval can list every command; this one has 101')
  // 20 per task is still allowed on its own; the per-task limit is reported by itself.
  expect(errorsOf(oneTask(t => { t.acceptance = { checks: many(21, i => ({ argv: ['run', String(i)] })) } })).join('\n')).toContain('at most 20 checks per task; this one lists 21')
})

// A command, a directory or a pattern is plain text: nothing that moves, hides or reorders what the person reads.
const UNSAFE_CASES: [string, string][] = [
  ['a newline', 'echo\nrm -rf /'],
  ['a carriage return', 'ok\r- [T9] "safe" NEW'],
  ['an escape sequence', 'ok\u001b[2K\u001b[1Aforged'],
  ['a NUL', 'a\u0000b'],
  ['a tab', 'a\tb'],
  ['DEL', 'a\u007fb'],
  ['a C1 control (CSI)', 'a\u009b2Jb'],
  ['a right-to-left override', 'a\u202eb'],
  ['a left-to-right embedding', 'a\u202ab'],
  ['an isolate', 'a\u2066b'],
  ['a pop isolate', 'a\u2069b'],
  ['a left-to-right mark', 'a\u200eb'],
  ['a right-to-left mark', 'a\u200fb'],
  ['an Arabic letter mark', 'a\u061cb'],
  ['a line separator', 'a\u2028b'],
  ['a byte order mark', 'a\ufeffb'],
]
for (const [label, word] of UNSAFE_CASES) {
  test(`rejects ${label} in an argv word, a cwd and a file pattern`, () => {
    expect(hasUnsafe(word)).toBe(true)
    expect(errorsOf(oneTask(t => { t.acceptance = { checks: [{ argv: ['run', word] }] } })).join('\n')).toContain('argv[1] holds a control or direction character')
    expect(errorsOf(oneTask(t => { t.acceptance = { checks: [{ argv: ['run'], cwd: `sub/${word}` }] } })).join('\n')).toContain('cwd holds a control or direction character')
    expect(errorsOf(oneTask(t => { t.files = [`src/${word}.ts`] })).join('\n')).toContain('holds a control or direction character; a pattern is plain text')
  })
}

test('a pattern is refused for what was written, not for what the trim leaves; plain text with spaces, quotes and unicode is fine', () => {
  expect(errorsOf(oneTask(t => { t.files = ['src/a.ts\n'] })).join('\n')).toContain('holds a control or direction character')
  expect(errorsOf(oneTask(t => { t.files = ['\ufeffsrc/a.ts'] })).join('\n')).toContain('holds a control or direction character')
  expect(errorsOf(oneTask(t => {
    t.files = ['src/my dir/ação ✓.ts', 'it\'s "quoted"/x']
    t.acceptance = { checks: [{ argv: ['node', '-e', 'console.log("ação ✓")', "it's"], cwd: 'my pkg' }] }
  }))).toEqual([])
  // The goal is prose and may span lines; the listing quotes it.
  expect(errorsOf(mutate(f => { f.goal = 'one\ntwo' }))).toEqual([])
  // What an error echoes of the plan is spelled out too.
  const echoed = errorsOf(mutate(f => { f.tasks[1].dependsOn = ['T9\u202e'] })).join('\n')
  expect(echoed).toContain('dependsOn unknown task T9\\u202e')
  expect(echoed).not.toContain('\u202e')
})

test('quoted spells out everything JSON leaves raw, and escapeUnsafe leaves the rest alone', () => {
  expect(quoted('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"')
  expect(quoted('x\u007fy\u009bz\u202e\u2066\ufeff\u200f\u2028')).toBe('"x\\u007fy\\u009bz\\u202e\\u2066\\ufeff\\u200f\\u2028"')
  expect(quoted('ação ✓ 𝄞')).toBe('"ação ✓ 𝄞"')
  expect(escapeUnsafe('plain "text"\\')).toBe('plain "text"\\')
  expect(hasUnsafe('plain text, ação ✓')).toBe(false)
})

test('a block over 256 KB is refused before it is parsed', () => {
  const huge = plan(mutate(f => { f.goal = 'x'.repeat(256 * 1024) }))
  const result = parseFlow(huge)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.errors.join('\n')).toMatch(/the flow block is \d+ KB; keep it under 256 KB/)
  expect(parseFlow(plan(base())).ok).toBe(true)
})

// --- amendments: done work, reuse of commands, case, a hostile plan ---

test('a new task that overlaps finished work waits unless it is risk, and finished risk work always waits', () => {
  const done = (id: string) => ({ state: { status: { ...STATE.status, [id]: 'done' as const } } })
  // A is done and not risk: rewriting its files is allowed only for a risk task.
  expect(amended(tasks => { tasks.push(NEW_TASK({ files: ['src/a.ts'] })) })).toEqual({
    pending: ['N1: its files overlap A, which is done; a task that rewrites finished work must be risk'],
  })
  expect(amended(tasks => { tasks.push(NEW_TASK({ files: ['src/a.ts'], risk: true })) })).toHaveProperty('adopt')
  // C is done and risk: nothing rewrites what the architect reviewed without the person.
  for (const risk of [false, true]) {
    const result = amended(tasks => { tasks.push(NEW_TASK({ files: ['docs/guide.md'], risk })) }, done('C'))
    expect(result).toEqual({ pending: ['N1: its files overlap C, a finished risk task whose reviewed work it would rewrite'] })
  }
  // Files nobody owns are as before.
  expect(amended(tasks => { tasks.push(NEW_TASK({ files: ['elsewhere/x.ts'] })) }, done('C'))).toHaveProperty('adopt')
})

test('the commands of an onFail branch and of a side-effect task are not reusable by another task, only by themselves', () => {
  // F (branch) runs `git status`: another task asking for it is asking for a new command.
  expect(amended(tasks => { tasks.push(NEW_TASK({ acceptance: { checks: [{ argv: ['git', 'status'] }] } })) })).toEqual({
    pending: ['N1: new command `git status` is not one of the approved checks'],
  })
  expect(amended(tasks => { byId(tasks, 'D').acceptance.checks.push({ argv: ['git', 'status'] }) })).toEqual({
    pending: ['D: new command `git status` is not one of the approved checks'],
  })
  // The branch may be given its own command again, and a regular task's command is still reusable by everyone.
  expect(amended(tasks => { byId(tasks, 'F').acceptance.checks.push({ argv: ['git', 'status'], timeoutSec: 30 }) })).toHaveProperty('adopt')
  expect(amended(tasks => { byId(tasks, 'F').acceptance.checks.push({ argv: ['npm', 'test'] }) })).toHaveProperty('adopt')
  // A side-effect task's command is its own.
  const withDeploy = parsed(raw([
    ...BASE_TASKS(),
    { id: 'S', goal: 'Deploy', files: ['deploy/'], dependsOn: ['D'], sideEffect: true, acceptance: { checks: [{ argv: ['./deploy.sh'] }] } },
  ])).flow
  const reuse = amended(tasks => {
    tasks.push({ id: 'S', goal: 'Deploy', files: ['deploy/'], dependsOn: ['D'], sideEffect: true, acceptance: { checks: [{ argv: ['./deploy.sh'] }] } })
    tasks.push({ ...NEW_TASK(), acceptance: { checks: [{ argv: ['./deploy.sh'] }] } })
  }, { effective: withDeploy, state: { status: { ...STATE.status, S: 'pending' } } })
  expect(reuse).toEqual({ pending: ['N1: new command `./deploy.sh` is not one of the approved checks'] })
})

test('ownership is compared without case and in Unicode NFC, as the usual file systems do', () => {
  expect(globsOverlap('src/Main.ts', 'src/main.ts')).toBe(true)
  expect(globsOverlap('SRC/', 'src/a.ts')).toBe(true)
  expect(globsOverlap('Docs/**', 'docs/a/b.md')).toBe(true)
  expect(globsOverlap('docs/caf\u00e9.md', 'docs/cafe\u0301.md')).toBe(true)
  expect(globsOverlap('docs/CAFE\u0301.md', 'docs/caf\u00e9.md')).toBe(true)
  expect(globsOverlap('docs/caf\u00e9.md', 'docs/cafe.md')).toBe(false)
  // So a new task cannot dodge an active one by spelling its files in another case.
  const result = amended(tasks => { tasks.push(NEW_TASK({ files: ['SRC/B/extra.ts'] })) })
  expect(result).toEqual({ pending: ['N1: its files overlap B, which is active'] })
})

test('the reasons are listed up to twenty and the rest are counted', () => {
  const result = amended(tasks => {
    for (let i = 0; i < 40; i++) tasks.push(NEW_TASK({ id: `N${i}`, files: [`extra/n${i}.ts`], sideEffect: true, acceptance: { checks: [{ argv: ['npm', 'test'] }] } }))
  })
  expect('pending' in result).toBe(true)
  if ('pending' in result) {
    expect(result.pending).toHaveLength(21)
    expect(result.pending.at(-1)).toBe('and possibly more; the first 20 are listed')
  }
})

test('a hostile edit at the limits costs well under the hook\'s budget', () => {
  const heavy = (prefix: string, count: number) => many(count, i => ({
    id: `${prefix}${i}`, goal: 'g', dependsOn: [], files: many(50, j => `src/${prefix.toLowerCase()}${i}/**/f${j}-*.ts`),
    acceptance: { criteria: ['x'] },
  })) as RawTask[]
  const existing = parsed(raw(heavy('E', 50))).flow
  const edited = parsed(raw([...heavy('E', 50), ...heavy('N', 50).map(task => ({ ...task, files: task.files.map((file: string) => file.replace('src/n', 'src/e')) }))]))
  const state: AmendState = { status: {}, attempts: {}, ends: {}, awaiting: [], receipts: {} }
  const started = Date.now()
  const result = amend(existing, edited.flow, state, { seenIds: [] }, edited.implicit)
  const took = Date.now() - started
  expect(result).toHaveProperty('pending')
  expect(took).toBeLessThan(2500)
  // Disjoint, the whole matrix is still compared.
  const disjoint = parsed(raw([...heavy('E', 50), ...heavy('N', 50)]))
  const again = Date.now()
  expect(amend(existing, disjoint.flow, state, { seenIds: [] }, disjoint.implicit)).toHaveProperty('adopt')
  expect(Date.now() - again).toBeLessThan(2500)
})
