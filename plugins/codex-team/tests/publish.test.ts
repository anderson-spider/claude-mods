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
    env: async () => ({ HERDR_ENV: '1', HERDR_PANE_ID: 'lead' }), run,
    exists: async path => files.has(path) || [...files.keys()].some(file => file.startsWith(path + '/')),
    list: async () => [{ name: 'old.md', kind: 'file', mtimeMs: 1 }, { name: 'new.md', kind: 'file', mtimeMs: 2 }],
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
      ? [{ name: 'herdr-dagr-z-other', kind: 'dir', mtimeMs: 0 }, { name: 'unrelated', kind: 'dir', mtimeMs: 0 }, { name: 'herdr-dagr-a-new-hash', kind: 'dir', mtimeMs: 0 }]
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
