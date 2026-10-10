import { expect, test } from 'claude-code/testing'
import { branchOnly, canonical, eligible, flowHash, matchGlob, ownsPath, parseFlow, requiredTasks, sha256, validateFlow } from '../hooks/flow/plan'

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
