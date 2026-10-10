import { expect, test } from 'claude-code/testing'
import { CheckUnrunnable, SCRUBBED_ENV, checkCwd, createCheckPass, runCheck, runChecks, scrubbed } from '../hooks/flow/checks'
import type { CheckMemo, RunInit, RunOutput, Runner } from '../hooks/flow/checks'
import { OUTPUT_TAIL } from '../hooks/flow/policy'

const ROOT = '/repo'
const check = (argv: string[], extra: { cwd?: string; timeoutSec?: number } = {}) => ({ argv, timeoutSec: 30, ...extra })

const scripted = (answer: (argv: string[], init: RunInit) => RunOutput | Promise<RunOutput>) => {
  const calls: { argv: string[]; init: RunInit }[] = []
  const run: Runner = async (argv, init) => { calls.push({ argv, init }); return answer(argv, init) }
  return { run, calls }
}
const ok = (stdout = '', stderr = ''): RunOutput => ({ exitCode: 0, stdout, stderr })

test('a check runs from the root with the judge keys removed and the timeout in milliseconds', async () => {
  const { run, calls } = scripted(() => ok('3 passed'))
  const result = await runCheck(run, ROOT, check(['npm', 'test'], { timeoutSec: 45 }))
  expect(result).toEqual({ argv: ['npm', 'test'], passed: true, output: '3 passed' })
  expect(calls).toHaveLength(1)
  // `--` ends env's own options: the check's argv is never read as one (the plan also refuses a leading `-` or a `=`).
  expect(calls[0]!.argv).toEqual(['env', '-u', 'OPENROUTER_API_KEY', '-u', 'TYPESAFE_API_KEY', '--', 'npm', 'test'])
  expect(calls[0]!.init).toEqual({ cwd: '/repo', timeoutMs: 45_000 })
  expect(SCRUBBED_ENV).toEqual(['OPENROUTER_API_KEY', 'TYPESAFE_API_KEY'])
  expect(scrubbed(['a'])).toEqual(['env', '-u', 'OPENROUTER_API_KEY', '-u', 'TYPESAFE_API_KEY', '--', 'a'])
})

test('cwd is relative to the root', () => {
  expect(checkCwd('/repo', {})).toBe('/repo')
  expect(checkCwd('/repo/', { cwd: 'plugins/x/' })).toBe('/repo/plugins/x')
  expect(checkCwd('/repo', { cwd: './sub' })).toBe('/repo/sub')
  expect(checkCwd('/repo', { cwd: '.' })).toBe('/repo')
})

test('a failing check keeps its output and a silent one says the exit code', async () => {
  const failing = scripted(() => ({ exitCode: 1, stdout: 'out\n', stderr: 'err\n' }))
  expect(await runCheck(failing.run, ROOT, check(['t']))).toEqual({ argv: ['t'], passed: false, output: 'out\nerr' })
  const silent = scripted(() => ({ exitCode: 2, stdout: '', stderr: '' }))
  expect(await runCheck(silent.run, ROOT, check(['t']))).toEqual({ argv: ['t'], passed: false, output: 'exit code 2' })
})

test('the output is cut to the policy tail, keeping the end', async () => {
  const long = `${'x'.repeat(5000)}END`
  const { run } = scripted(() => ({ exitCode: 1, stdout: long, stderr: '' }))
  const result = await runCheck(run, ROOT, check(['t']))
  expect(result?.output).toHaveLength(OUTPUT_TAIL)
  expect(result?.output.startsWith('...')).toBe(true)
  expect(result?.output.endsWith('END')).toBe(true)
})

test('a missing or non-executable binary could not run: passed is null with why', async () => {
  for (const [exitCode, stderr] of [
    [127, 'env: nope: No such file or directory\n'],
    [127, "env: 'nope': No such file or directory\n"],
    [127, 'env: ‘nope’: No such file or directory\n'],
    [126, 'env: nope: Permission denied\n'],
  ] as const) {
    const { run } = scripted(() => ({ exitCode, stdout: '', stderr }))
    const result = await runCheck(run, ROOT, check(['nope', '--x']))
    expect(result?.passed).toBeNull()
    expect(result?.output).toContain('could not start nope')
    // A runner exit (126/127) is a real failure of the plan's command: it is not flagged as a check that could not run.
    expect(result?.couldNotRun).toBeUndefined()
  }
})

test('a 127 from the check itself is a failure, not a missing binary', async () => {
  const { run } = scripted(() => ({ exitCode: 127, stdout: '', stderr: 'sh: other: command not found\n' }))
  expect(await runCheck(run, ROOT, check(['make']))).toMatchObject({ passed: false })
})

test('a timeout is passed null with why; any other rejection is the host\'s fault and throws CheckUnrunnable', async () => {
  const timeout = scripted(() => { throw new Error('process timed out after 5000ms') })
  expect(await runCheck(timeout.run, ROOT, check(['slow'], { timeoutSec: 5 }))).toEqual({ argv: ['slow'], passed: null, output: 'timed out after 5s: slow' })
  // A timeout is a real failure: it never carries the could-not-run flag.
  expect(await runCheck(timeout.run, ROOT, check(['slow'], { timeoutSec: 5 }))).not.toHaveProperty('couldNotRun')
  const broken = scripted(() => { throw new Error('spawn denied') })
  await expect(runCheck(broken.run, ROOT, check(['x']))).rejects.toThrow(CheckUnrunnable)
  await expect(runCheck(broken.run, ROOT, check(['x']))).rejects.toThrow('x: spawn denied')
})

test('a working directory that is not there could not run: passed is null with why, and the runner is never called', async () => {
  const { run, calls } = scripted(() => ok('never'))
  const seen: string[] = []
  const probe = (kind: 'directory' | 'missing' | 'other') => async (path: string) => { seen.push(path); return kind }
  const missing = await runCheck(run, ROOT, check(['npm', 'test'], { cwd: 'packages/web' }), { probe: probe('missing') })
  expect(missing).toEqual({ argv: ['npm', 'test'], passed: null, output: 'working directory packages/web does not exist, so npm test could not run', couldNotRun: true })
  const file = await runCheck(run, ROOT, check(['npm', 'test'], { cwd: 'packages/web' }), { probe: probe('other') })
  expect(file).toMatchObject({ passed: null, output: 'working directory packages/web is not a directory, so npm test could not run', couldNotRun: true })
  expect(calls).toEqual([])
  expect(seen).toEqual(['/repo/packages/web', '/repo/packages/web'])
  // The directory is there: the check runs from it. A check with no cwd is not probed at all.
  expect(await runCheck(run, ROOT, check(['npm', 'test'], { cwd: 'packages/web' }), { probe: probe('directory') })).toMatchObject({ passed: true })
  expect(calls[0]!.init.cwd).toBe('/repo/packages/web')
  await runCheck(run, ROOT, check(['npm', 'test']), { probe: probe('missing') })
  expect(seen).toHaveLength(3)
  // A host that cannot say (the probe rejects) is not a reason to skip the check: it runs, and its own failure says what it is.
  const unsure = await runCheck(run, ROOT, check(['npm', 'test'], { cwd: 'packages/web' }), { probe: async () => { throw new Error('stat failed') } })
  expect(unsure).toMatchObject({ passed: true })
})

test('the engine\'s "failed to start" for a command or directory that is not there could not run; other rejections stay the host\'s', async () => {
  const message = "$.process.run(env) failed to start: ENOENT: no such file or directory, posix_spawn 'env'"
  const lost = scripted(() => { throw new Error(message) })
  const result = await runCheck(lost.run, ROOT, check(['npm', 'test'], { cwd: 'packages/web' }))
  expect(result).toMatchObject({ argv: ['npm', 'test'], passed: null })
  expect(result?.output).toContain('could not start npm (ENOENT)')
  expect(result?.couldNotRun).toBe(true)
  expect(result?.output).toContain('packages/web')
  for (const code of ['ENOTDIR', 'EACCES']) {
    const refused = scripted(() => { throw new Error(`$.process.run(env) failed to start: ${code}: posix_spawn 'env'`) })
    expect(await runCheck(refused.run, ROOT, check(['x']))).toMatchObject({ passed: null, couldNotRun: true })
  }
  // What says nothing about the plan still releases the gate: a spawn limit, a denied process, an unknown failure.
  for (const text of ['$.process.run(env) failed to start: EMFILE: too many open files', 'spawn denied', 'process table full']) {
    const broken = scripted(() => { throw new Error(text) })
    await expect(runCheck(broken.run, ROOT, check(['x']))).rejects.toThrow(CheckUnrunnable)
  }
})

test('in a pass a check with a missing directory is null and the next checks still run', async () => {
  const { run, calls } = scripted(argv => ok(argv.at(-1) ?? ''))
  const pass = await createCheckPass(run, ROOT, { probe: async path => (path.endsWith('/web') ? 'missing' : 'directory') })
  const results = await pass.runTask([check(['npm', 'test'], { cwd: 'web' }), check(['lint']), check(['build'], { cwd: 'api' })])
  expect(results.map(r => r.passed)).toEqual([null, true, true])
  expect(results[0]).toMatchObject({ couldNotRun: true })
  expect(calls.map(c => c.argv.at(-1))).toEqual(['lint', 'build'])
  expect((await pass.finish()).unverified).toBe(0)
})

test('a timeout the pass imposed (less than the check\'s own) leaves the check unverified, not null', async () => {
  const cut = scripted(() => { throw new Error('process timed out') })
  expect(await runCheck(cut.run, ROOT, check(['slow'], { timeoutSec: 60 }), { timeoutMs: 5_000 })).toBeUndefined()
  expect(cut.calls[0]!.init.timeoutMs).toBe(5_000)
  // A cap above the check's own limit changes nothing.
  expect(await runCheck(cut.run, ROOT, check(['slow'], { timeoutSec: 1 }), { timeoutMs: 5_000 })).toMatchObject({ passed: null })
})

test('runChecks runs a task\'s checks in order, once each', async () => {
  const { run, calls } = scripted(argv => ok(argv.at(-1) ?? ''))
  const results = await runChecks(run, ROOT, [check(['a']), check(['b'])])
  expect(results.map(r => r.output)).toEqual(['a', 'b'])
  expect(calls.map(c => c.argv.at(-1))).toEqual(['a', 'b'])
})

// --- passes: the memo and the deadline ---

const tree = (value: { now: string | undefined }) => async () => value.now

test('a pass reuses a result while the tree snapshot is the one it was produced on', async () => {
  const { run, calls } = scripted(argv => ok(argv.at(-1) ?? ''))
  const memo: CheckMemo = new Map()
  const snapshot = { now: 'tree-1' as string | undefined }
  const once = async (checks = [check(['a']), check(['b'])]) => {
    const pass = await createCheckPass(run, ROOT, { memo, scope: 'plan', snapshot: tree(snapshot) })
    const results = await pass.runTask(checks)
    return { results, summary: await pass.finish() }
  }
  const first = await once()
  expect(first.summary).toEqual({ ran: 2, reused: 0, unverified: 0 })
  const second = await once()
  expect(second.summary).toEqual({ ran: 0, reused: 2, unverified: 0 })
  expect(second.results.map(r => r.output)).toEqual(['a', 'b'])
  expect(calls).toHaveLength(2)
  // The tree changed: run again. A different check on the same tree runs, the others are reused.
  snapshot.now = 'tree-2'
  expect((await once()).summary).toEqual({ ran: 2, reused: 0, unverified: 0 })
  expect((await once([check(['a']), check(['c'])])).summary).toEqual({ ran: 1, reused: 1, unverified: 0 })
  // Without a snapshot nothing is reused or remembered.
  snapshot.now = undefined
  expect((await once()).summary.reused).toBe(0)
  expect((await once()).summary.ran).toBe(2)
})

test('only a pass is remembered: a fail or a result that could not run is run again', async () => {
  const memo: CheckMemo = new Map()
  const failing = scripted(() => ({ exitCode: 1, stdout: 'FAIL', stderr: '' }))
  for (let i = 0; i < 2; i++) {
    const pass = await createCheckPass(failing.run, ROOT, { memo, snapshot: async () => 't' })
    expect((await pass.runTask([check(['a'])]))[0]).toMatchObject({ passed: false })
    await pass.finish()
  }
  expect(failing.calls).toHaveLength(2)
  expect(memo.size).toBe(0)
  const slow = scripted(() => { throw new Error('timed out') })
  for (let i = 0; i < 2; i++) {
    const p = await createCheckPass(slow.run, ROOT, { memo, snapshot: async () => 't' })
    expect((await p.runTask([check(['slow'])]))[0]).toMatchObject({ passed: null })
    await p.finish()
  }
  expect(slow.calls).toHaveLength(2)
  expect(memo.size).toBe(0)
})

test('a check that could not run for its directory is never remembered, even on an unchanged tree', async () => {
  const memo: CheckMemo = new Map()
  const { run, calls } = scripted(() => ok('never'))
  const probe = async () => 'missing' as const
  for (let i = 0; i < 2; i++) {
    const p = await createCheckPass(run, ROOT, { memo, snapshot: async () => 't', probe })
    expect((await p.runTask([check(['npm', 'test'], { cwd: 'web' })]))[0]).toMatchObject({ passed: null, couldNotRun: true })
    await p.finish()
  }
  expect(calls).toEqual([])
  expect(memo.size).toBe(0)
})

test('a pass is stored under the tree only when the checks left it as they found it', async () => {
  const memo: CheckMemo = new Map()
  const snapshot = { now: 'before' as string | undefined }
  // A build check writes an artifact: the tree it passed on is not the one it leaves, so the pass is not remembered.
  const build = scripted(() => { snapshot.now = 'after'; return ok('built') })
  const pass = await createCheckPass(build.run, ROOT, { memo, snapshot: tree(snapshot) })
  await pass.runTask([check(['build'])])
  await pass.finish()
  expect(memo.size).toBe(0)
  const again = await createCheckPass(build.run, ROOT, { memo, snapshot: tree(snapshot) })
  expect((await again.runTask([check(['build'])])).map(r => r.output)).toEqual(['built'])
  expect((await again.finish()).reused).toBe(0)
  expect(build.calls).toHaveLength(2)
  // One that leaves the tree alone is.
  const quiet = scripted(() => ok('fine'))
  snapshot.now = 'steady'
  const first = await createCheckPass(quiet.run, ROOT, { memo, snapshot: tree(snapshot) })
  await first.runTask([check(['lint'])])
  await first.finish()
  const second = await createCheckPass(quiet.run, ROOT, { memo, snapshot: tree(snapshot) })
  expect((await second.runTask([check(['lint'])])).map(r => r.output)).toEqual(['fine'])
  expect((await second.finish()).reused).toBe(1)
  expect(quiet.calls).toHaveLength(1)
})

test('the same command in two tasks runs once in a pass', async () => {
  const { run, calls } = scripted(argv => ok(argv.at(-1) ?? ''))
  const pass = await createCheckPass(run, ROOT, {})
  await pass.runTask([check(['a']), check(['b'])])
  await pass.runTask([check(['b']), check(['c'])])
  expect(calls.map(c => c.argv.at(-1))).toEqual(['a', 'b', 'c'])
  // A different cwd or timeout is a different check.
  await pass.runTask([check(['b'], { cwd: 'sub' })])
  expect(calls.map(c => c.argv.at(-1))).toEqual(['a', 'b', 'c', 'b'])
})

test('past the deadline no check starts: the rest are unverified and what ran is kept', async () => {
  let clock = 0
  const { run, calls } = scripted((_argv, init) => { clock += 50_000; return ok(String(init.timeoutMs)) })
  const pass = await createCheckPass(run, ROOT, { deadline: { now: async () => clock, endsAt: 120_000 } })
  const long = (name: string) => check([name], { timeoutSec: 600 })
  const first = await pass.runTask([long('a'), long('b')])
  const second = await pass.runTask([long('c'), long('d')])
  const third = await pass.runTask([long('e')])
  // a: 120 s left, b: 70 s left, c: 20 s left (cut), then the clock is at 150 s: d and e never start.
  expect(first.map(r => r.output)).toEqual(['120000', '70000'])
  expect(second.map(r => r.output)).toEqual(['20000'])
  expect(third).toEqual([])
  expect(calls).toHaveLength(3)
  expect((await pass.finish()).unverified).toBe(2)
})

test('a check cut by the deadline is unverified, not a null result', async () => {
  let clock = 0
  const { run } = scripted((_argv, init) => { clock += init.timeoutMs; throw new Error('process timed out') })
  const pass = await createCheckPass(run, ROOT, { deadline: { now: async () => clock, endsAt: 30_000 } })
  const results = await pass.runTask([check(['slow'], { timeoutSec: 600 })])
  expect(results).toEqual([])
  expect((await pass.finish()).unverified).toBe(1)
})
