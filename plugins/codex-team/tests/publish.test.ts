import { expect, test } from 'claude-code/testing'
import { createPublisher, isPlanFile, publishDagr } from '../hooks/publish'
import type { PublishIo } from '../hooks/publish'
import { agents, fakeRun, text } from './fake-run'
import type { RunResult } from '../hooks/herdr'

const PLAN = '## Steps\n### Feature\n- feature (main, after: —) Ship — state: verified (lead report)'
function world(check: RunResult = text('[]')) {
  const { run, calls } = fakeRun([[['dagr', '--version'], text('dagr 0.3.1')], agents([]), [['dagr', 'check'], check], [['mv'], text('')]])
  const files = new Map<string, string>([['/repo/.crew/plans/new.md', PLAN], ['/repo/.crew/plans/old.md', 'invalid'], ['/repo/.dagr/run.json', 'old run']])
  const writes: string[] = [], logs: string[] = []
  const io: PublishIo = {
    env: async () => ({ HERDR_ENV: '1', HERDR_PANE_ID: 'lead', HERDR_WORKSPACE_ID: 'w1' }), run,
    exists: async path => files.has(path) || [...files.keys()].some(file => file.startsWith(path + '/')),
    list: async () => [{ name: 'old.md', kind: 'file', mtimeMs: 1, size: 7 }, { name: 'new.md', kind: 'file', mtimeMs: 2, size: PLAN.length }],
    read: async path => { if (!files.has(path)) throw new Error('missing'); return files.get(path)! },
    write: async (path, body) => { writes.push(path); files.set(path, body) },
    now: async () => Date.parse('2026-10-13T20:00:00Z'), log: line => { logs.push(line) },
  }
  return { io, files, writes, logs, calls }
}

test('publishing selects the newest plan, writes a temp file and validates strictly before moving it', async () => {
  const w = world()
  await publishDagr(w.io, '/repo')
  expect(w.writes).toEqual(['/repo/.dagr/run.json.tmp', '/repo/.dagr/times.json'])
  expect(w.calls[w.calls.length - 2]).toEqual(['dagr', 'check', '/repo/.dagr/run.json.tmp', '--strict', '--json'])
  expect(w.calls[w.calls.length - 1]).toEqual(['mv', '/repo/.dagr/run.json.tmp', '/repo/.dagr/run.json'])
  expect(JSON.parse(w.files.get('/repo/.dagr/run.json.tmp')!).run.id).toBe('run-new')
  expect(w.logs).toEqual([])
})

test('publication admits implementing lead and git-master and blocks absent workers under the strict locator rule', async () => {
  const w = world()
  w.files.set('/repo/.crew/plans/new.md', `## Steps
### Work
- lead (main, after: —) Lead work — state: implementing
- ship (git-master, after: —) Ship work — state: implementing
- absent (dev-fix, after: —) Build — state: implementing`)
  const run = w.io.run
  w.io.run = async argv => {
    if (argv[0] !== 'dagr' || argv[1] !== 'check') return run(argv)
    expect(argv).toEqual(['dagr', 'check', '/repo/.dagr/run.json.tmp', '--strict', '--json'])
    const document = JSON.parse(w.files.get(argv[2]!)!) as { tasks: { state: string; attempts: { locator?: { pane: string } }[] }[] }
    const missingLocator = document.tasks.some(task => task.state === 'working' && task.attempts.some(attempt => !attempt.locator?.pane))
    return missingLocator ? { ...text('[{"code":"W204"}]'), exitCode: 1 } : text('[]')
  }
  await publishDagr(w.io, '/repo')
  expect(w.logs).toEqual([])
  expect(w.calls[w.calls.length - 1]).toEqual(['mv', '/repo/.dagr/run.json.tmp', '/repo/.dagr/run.json'])
  const document = JSON.parse(w.files.get('/repo/.dagr/run.json.tmp')!)
  expect(document.tasks.slice(0, 2).map((task: { attempts: { locator: { pane: string } }[] }) => task.attempts[0]!.locator)).toEqual([{ pane: 'lead' }, { pane: 'lead' }])
  expect(document.tasks[2]).toMatchObject({ state: 'blocked', unblock: 'Restore a live pane for dev-fix', attempts: [] })
})

test('nonzero, empty, malformed, truncated or nonempty validator output never publishes and preserves the old run', async () => {
  for (const check of [
    { ...text('[]'), exitCode: 1 }, text(''), text('not json'), text('[{"code":"E120"}]'), text('{}'), { ...text('[]'), isStdoutTruncated: true },
  ]) {
    const w = world(check)
    await publishDagr(w.io, '/repo')
    expect(w.calls.some(c => c[0] === 'mv')).toBe(false)
    expect(w.files.get('/repo/.dagr/run.json')).toBe('old run')
    expect(w.logs).toEqual(['codex-team: dagr not published (validation failed)'])
  }
})

test('missing dagr logs once when override, PATH and installed plugin discovery all fail', async () => {
  const w = world()
  w.io.env = async () => ({ HERDR_ENV: '1', HOME: '/home/u', DAGR_BIN: '/missing/dagr' })
  w.io.list = async () => []
  let probes = 0
  w.io.run = async () => { probes++; if (probes % 2) throw new Error('missing'); return { ...text(''), exitCode: 127 } }
  await publishDagr(w.io, '/repo')
  await publishDagr(w.io, '/repo')
  expect(w.writes).toEqual([])
  expect(w.logs).toEqual(['codex-team: dagr not found; set DAGR_BIN or install dagr'])
})

test('an explicit DAGR_BIN with spaces is passed as one argv element before PATH or discovery', async () => {
  const w = world()
  const calls: string[][] = []
  w.io.env = async () => ({ HERDR_ENV: '1', DAGR_BIN: '/a path/dagr' })
  w.io.run = async argv => { calls.push([...argv]); return argv[0] === 'herdr' ? text('{"result":{"agents":[]}}') : text(argv[1] === 'check' ? '[]' : '') }
  await publishDagr(w.io, '/repo')
  expect(calls[0]).toEqual(['/a path/dagr', '--version'])
  expect(calls.find(c => c[1] === 'check')?.[0]).toBe('/a path/dagr')
  expect(calls.some(call => call[0] === 'dagr')).toBe(false)
})

test('dagr installed outside PATH is discovered under HOME without a fixed hash and paths with spaces stay one argument', async () => {
  for (const home of ['/home/u', '/home/with spaces']) {
    const w = world(), calls: string[][] = []
    const candidate = `${home}/.config/herdr/plugins/github/herdr-dagr-a-new-hash/bin/dagr`
    const originalList = w.io.list
    w.io.env = async () => ({ HERDR_ENV: '1', HOME: home })
    w.io.list = async path => path.endsWith('/plugins/github')
      ? [{ name: 'herdr-dagr-z-other', kind: 'dir', mtimeMs: 0, size: 0 }, { name: 'unrelated', kind: 'dir', mtimeMs: 0, size: 0 }, { name: 'herdr-dagr-a-new-hash', kind: 'dir', mtimeMs: 0, size: 0 }]
      : originalList(path)
    const originalRun = w.io.run
    w.io.run = async argv => {
      calls.push([...argv])
      if (argv[0] === 'dagr') return { ...text(''), exitCode: 127 }
      if (argv[0] === candidate) return text(argv[1] === 'check' ? '[]' : 'dagr 0.3.1')
      return originalRun(argv)
    }
    await publishDagr(w.io, '/repo')
    expect(calls[0]).toEqual(['dagr', '--version'])
    expect(calls[1]).toEqual([candidate, '--version'])
    expect(calls.find(call => call[1] === 'check')).toEqual([candidate, 'check', '/repo/.dagr/run.json.tmp', '--strict', '--json'])
    expect(calls.some(call => call[0] === 'mv')).toBe(true)
    expect(w.logs).toEqual([])
  }
})

test('unknown dependency errors are reported and write, list, times or rename failures preserve the previous run', async () => {
  for (const failure of ['dependency', 'write', 'agents', 'times', 'read', 'list', 'rename']) {
    const w = world()
    if (failure === 'dependency') w.files.set('/repo/.crew/plans/new.md', PLAN.replace('after: —', 'after: missing'))
    if (failure === 'list') w.io.list = async () => { throw new Error('unreadable') }
    if (failure === 'read') { w.files.set('/repo/.dagr/times.json', '{}'); const read = w.io.read; w.io.read = async path => { if (path.endsWith('times.json')) throw new Error('unreadable'); return read(path) } }
    if (failure === 'write') w.io.write = async () => { throw new Error('disk full') }
    if (failure === 'times') w.files.set('/repo/.dagr/times.json', 'broken')
    if (failure === 'agents' || failure === 'rename') {
      const original = w.io.run
      w.io.run = async argv => argv[0] === (failure === 'agents' ? 'herdr' : 'mv') ? { ...text(''), exitCode: 1 } : original(argv)
    }
    await publishDagr(w.io, '/repo')
    expect(w.files.get('/repo/.dagr/run.json')).toBe('old run')
    expect(w.logs).toHaveLength(1)
    if (failure === 'dependency') expect(w.logs[0]).toContain('unknown dependency: feature -> missing')
  }
})

test('plan path matching handles relative paths and excludes siblings and paths outside the plan directory', () => {
  for (const path of ['/repo/.crew/plans/feature.md', '.crew/plans/feature.md', './.crew/plans/feature.md']) expect(isPlanFile(path, '/repo')).toBe(true)
  for (const path of ['/other/.crew/plans/a.md', '.crew/plans-other/a.md', '.crew/plans/../../other/a.md']) expect(isPlanFile(path, '/repo')).toBe(false)
})

test('publication serializes candidates per root and retains first observations on the next dispatch', async () => {
  const w = world(), publish = createPublisher()
  let active = 0, maximum = 0
  const original = w.io.write
  w.io.write = async (path, body) => { active++; maximum = Math.max(active, maximum); await Promise.resolve(); await original(path, body); active-- }
  await Promise.all([publish(w.io, '/repo'), publish(w.io, '/repo')])
  expect(maximum).toBe(1)
  expect(w.calls.filter(c => c[0] === 'mv')).toHaveLength(2)
})

test('publication maps effective names to logical owners only in the dispatch workspace', async () => {
  const w = world()
  w.files.set('/repo/.crew/plans/new.md', '## Steps\n### Work\n- local (dev-fix, after: —) Build — state: implementing\n- foreign (analyst, after: —) Inspect — state: implementing')
  const run = w.io.run
  w.io.run = async argv => argv[0] === 'herdr' ? text(JSON.stringify({ result: { agents: [
    { name: 'd1r-fix', workspace_id: 'w1', pane_id: 'local' },
    { name: 'd1s-fix', workspace_id: 'w2', pane_id: 'foreign-dev' },
    { name: 'n1s', workspace_id: 'w2', pane_id: 'foreign-analyst' },
  ] } })) : run(argv)
  await publishDagr(w.io, '/repo')
  const document = JSON.parse(w.files.get('/repo/.dagr/run.json.tmp')!)
  expect(document.tasks[0]).toMatchObject({ owner: 'dev-fix', state: 'working', attempts: [{ locator: { pane: 'local' } }] })
  expect(document.tasks[1]).toMatchObject({ owner: 'analyst', state: 'blocked', attempts: [] })
})

test('an unchanged published plan needs only one listing with no reads, stats or processes', async () => {
  const w = world(), publish = createPublisher()
  await publish(w.io, '/repo')
  const entries = await w.io.list('/repo/.crew/plans')
  let lists = 0
  w.io.list = async path => { expect(path).toBe('/repo/.crew/plans'); lists++; return entries }
  w.io.read = w.io.exists = async () => { throw new Error('unchanged plans need no reads or stats') }
  w.io.run = async () => { throw new Error('unchanged plans need no processes') }
  w.writes.length = 0
  await publish(w.io, '/repo', { ifChanged: true })
  expect(lists).toBe(1)
  expect(w.writes).toEqual([])
  expect(w.logs).toEqual([])
})

test('path, mtime and size changes publish once through the same queue and only successful publications advance the fingerprint', async () => {
  const w = world(), publish = createPublisher()
  const entry = { name: 'new.md', kind: 'file', mtimeMs: 2, size: PLAN.length }
  w.io.list = async () => [entry]
  await publish(w.io, '/repo')
  for (const field of ['path', 'mtime', 'size'] as const) {
    if (field === 'path') { entry.name = 'other.md'; w.files.set('/repo/.crew/plans/other.md', PLAN) }
    if (field === 'mtime') entry.mtimeMs++
    if (field === 'size') entry.size++
    const before = w.calls.filter(c => c[0] === 'mv').length
    await Promise.all([publish(w.io, '/repo', { ifChanged: true }), publish(w.io, '/repo', { ifChanged: true })])
    expect(w.calls.filter(c => c[0] === 'mv')).toHaveLength(before + 1)
  }
  entry.mtimeMs++
  const original = w.io.run
  w.io.run = async argv => argv[0] === 'mv' ? { ...text(''), exitCode: 1 } : original(argv)
  await publish(w.io, '/repo', { ifChanged: true })
  expect(w.logs).toHaveLength(1)
  w.io.run = original
  const before = w.calls.filter(c => c[0] === 'mv').length
  await publish(w.io, '/repo', { ifChanged: true })
  await publish(w.io, '/repo', { ifChanged: true })
  expect(w.calls.filter(c => c[0] === 'mv')).toHaveLength(before + 1)
})

test('fingerprints are independent per root and plan observation skips absent directories and nonregular plans', async () => {
  const w = world(), publish = createPublisher()
  w.io.read = async path => path.endsWith('times.json') ? '{}' : PLAN
  w.io.exists = async () => false
  await publish(w.io, '/repo', { ifChanged: true })
  await publish(w.io, '/other', { ifChanged: true })
  expect(w.calls.filter(c => c[0] === 'mv')).toHaveLength(2)
  w.calls.length = 0
  w.writes.length = 0
  w.io.list = async () => { throw new Error('directory absent') }
  await publish(w.io, '/absent', { ifChanged: true })
  w.io.list = async () => [
    { name: 'link.md', kind: 'file', mtimeMs: 10, size: 1, isLink: true },
    { name: 'dir.md', kind: 'dir', mtimeMs: 10, size: 1 },
    { name: 'notes.txt', kind: 'file', mtimeMs: 10, size: 1 },
  ]
  await publish(w.io, '/empty', { ifChanged: true })
  expect(w.calls).toEqual([])
  expect(w.writes).toEqual([])
  expect(w.logs).toEqual([])
})

test('changed plan observation publishes nothing when dagr is unavailable or outside Herdr', async () => {
  const w = world(), publish = createPublisher()
  w.io.run = async () => ({ ...text(''), exitCode: 127 })
  await publish(w.io, '/repo', { ifChanged: true })
  expect(w.writes).toEqual([])
  w.io.env = async () => ({ HERDR_ENV: '0' })
  w.io.list = async () => { throw new Error('outside Herdr must not list') }
  await publish(w.io, '/repo', { ifChanged: true })
  expect(w.writes).toEqual([])
})
