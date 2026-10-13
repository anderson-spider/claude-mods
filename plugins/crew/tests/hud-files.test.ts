import { expect, test } from 'claude-code/testing'
import { createPlanRefresher, missingPlan, normalizePath } from '../hooks/hud/files'
import type { PlanIo } from '../hooks/hud/files'
import type { CrewPlanDisplay } from '../types'

const ROOT = '/Users/jane/work/app'
const DIR = `${ROOT}/.crew/plans`
const plan = (...steps: string[]) => ['## Steps', '### Release', ...steps.map((id, i) => `- ${id} (crew:developer, after: —) do ${i} — state: implementing`)].join('\n')
const failure = (code: string, message = code) => Object.assign(new Error(message), { code })
const tick = () => new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(resolve, 0))

/** An in-memory repository: the plans directory, its files and the calls the refresher made. */
function world(files: Record<string, string> = {}) {
  const w = {
    files,
    directory: 'dir' as 'dir' | 'missing' | 'link' | 'elsewhere',
    links: new Set<string>(),
    realOf: {} as Record<string, string>,
    statFails: new Map<string, unknown>(),
    readFails: new Map<string, unknown>(),
    listFails: false,
    contextFails: false,
    existsHidesFiles: new Set<string>(),
    existsFails: new Set<string>(),
    published: [] as CrewPlanDisplay[][],
    shown: [] as CrewPlanDisplay[],
    logs: [] as string[],
    reads: 0,
    statFirst: undefined as undefined | (() => Promise<void>),
  }
  const io: PlanIo = {
    cwd: async () => ROOT,
    exists: async path => w.existsFails.has(path) ? Promise.reject(new Error('exists failed')) : path === DIR ? w.directory !== 'missing' : path.startsWith(`${DIR}/`) && path.slice(DIR.length + 1) in w.files && !w.existsHidesFiles.has(path),
    stat: async given => {
      const path = normalizePath(given)
      if (w.statFails.has(path)) throw w.statFails.get(path)
      if (path === ROOT) return { kind: 'dir', isLink: false, realPath: ROOT }
      if (path === DIR) return { kind: 'dir', isLink: w.directory === 'link', realPath: w.directory === 'elsewhere' ? '/elsewhere/plans' : DIR }
      if (!path.startsWith(`${DIR}/`)) return { kind: 'file', isLink: false, realPath: path }
      const name = path.slice(DIR.length + 1)
      if (!(name in w.files)) throw failure('ENOENT')
      return { kind: 'file', isLink: w.links.has(name), realPath: w.realOf[name] ?? (w.directory === 'elsewhere' ? `/elsewhere/plans/${name}` : path) }
    },
    list: async () => {
      if (w.listFails) throw new Error('list failed')
      return Object.keys(w.files).map(name => ({ name, kind: 'file', isLink: w.links.has(name) }))
    },
    read: async path => {
      w.reads++
      const error = w.readFails.get(path)
      if (error) throw error
      return w.files[path.slice(DIR.length + 1)]!
    },
    publish: async change => { w.shown = change(w.shown); w.published.push(w.shown) },
    context: async () => { if (w.contextFails) throw new Error('context failed'); return { home: '/Users/jane', root: ROOT } },
    log: text => { w.logs.push(text) },
  }
  return { w, io }
}
const names = (shown: CrewPlanDisplay[]) => shown.map(p => 'name' in p ? p.name : p.state)

test('a plan is gone by its ENOENT or ENOTDIR code, never by the code appearing in a message or filename', () => {
  expect(missingPlan(failure('ENOENT', 'missing'))).toBe(true)
  expect(missingPlan(failure('ENOTDIR', 'not a directory'))).toBe(true)
  expect(missingPlan(failure('EACCES', 'permission denied for ENOENT.md'))).toBe(false)
  expect(missingPlan(new Error('ENOENT: filename contains ENOENT.md'))).toBe(false)
  expect(missingPlan(null)).toBe(false)
  expect(missingPlan('ENOENT')).toBe(false)
})

test('paths are normalized to an absolute form without dot segments', () => {
  expect(normalizePath('/a/./b//c/../d')).toBe('/a/b/d')
  expect(normalizePath('/../..')).toBe('/')
  expect(normalizePath('a/b')).toBe('/a/b')
})

test('a refresh publishes loading before the first read, then the plans, and the same bytes publish nothing more', async () => {
  const { w, io } = world({ 'b.md': plan('T2'), 'a.md': plan('T1'), 'notes.txt': 'x' })
  const refresher = createPlanRefresher()
  await refresher.refresh(io)
  expect(w.published.map(names)).toEqual([['loading'], ['a', 'b']])
  await refresher.refresh(io)
  expect(w.published).toHaveLength(2)
  w.files['a.md'] = plan('T1', 'T3')
  await refresher.refresh(io)
  expect(w.published).toHaveLength(3)
})

test('a repository with no plans directory publishes an empty list without logging, and one that is a link or elsewhere too', async () => {
  for (const directory of ['missing', 'link', 'elsewhere'] as const) {
    const { w, io } = world({ 'a.md': plan('T1') })
    w.directory = directory
    await createPlanRefresher().refresh(io)
    expect(w.published).toEqual([[]])
    expect(w.logs).toEqual([])
    expect(w.reads).toBe(0)
  }
})

test('plans that come back unchanged after the directory went away are published again', async () => {
  const { w, io } = world({ 'a.md': plan('T1') })
  const refresher = createPlanRefresher()
  await refresher.refresh(io)
  w.directory = 'missing'
  await refresher.refresh(io)
  expect(w.shown).toEqual([])
  w.directory = 'dir'
  await refresher.refresh(io)
  expect(names(w.shown)).toEqual(['a'])
})

test('a missing-path code from the directory check reads as no plans, and any other failure is unknown with one log line', async () => {
  const gone = world({ 'a.md': plan('T1') })
  gone.w.statFails.set(DIR, failure('ENOENT'))
  await createPlanRefresher().refresh(gone.io)
  expect(gone.w.published).toEqual([[]])
  expect(gone.w.logs).toEqual([])
  const denied = world({ 'a.md': plan('T1') })
  denied.w.statFails.set(DIR, failure('EACCES'))
  await createPlanRefresher().refresh(denied.io)
  expect(denied.w.published).toEqual([[{ state: 'unknown' }]])
  expect(denied.w.logs).toEqual(['crew HUD: plan refresh failed'])
})

test('a link, a destination outside the directory and a nested real path are never read', async () => {
  const { w, io } = world({ 'ok.md': plan('T1'), 'link.md': plan('T2'), 'out.md': plan('T3'), 'deep.md': plan('T4') })
  w.links.add('link.md')
  w.realOf['out.md'] = '/elsewhere/out.md'
  w.realOf['deep.md'] = `${DIR}/sub/deep.md`
  await createPlanRefresher().refresh(io)
  expect(names(w.shown)).toEqual(['ok'])
  expect(w.reads).toBe(1)
})

test('an unreadable file adds unknown after the readable plans; a removed one is dropped by code or by exists', async () => {
  const { w, io } = world({ 'a.md': plan('T1'), 'b.md': plan('T2'), 'c.md': plan('T3') })
  w.readFails.set(`${DIR}/b.md`, failure('EACCES'))
  const refresher = createPlanRefresher()
  await refresher.refresh(io)
  expect(w.shown).toMatchObject([{ name: 'a' }, { name: 'c' }, { state: 'unknown' }])
  w.readFails.set(`${DIR}/b.md`, failure('ENOENT'))
  await refresher.refresh(io)
  expect(names(w.shown)).toEqual(['a', 'c'])
  // A failure with another code is proven gone only when `exists` says so.
  w.readFails.set(`${DIR}/b.md`, failure('EIO'))
  w.existsHidesFiles.add(`${DIR}/b.md`)
  await refresher.refresh(io)
  expect(names(w.shown)).toEqual(['a', 'c'])
  w.existsHidesFiles.clear()
  await refresher.refresh(io)
  expect(names(w.shown)).toEqual(['a', 'c', 'unknown'])
  // An `exists` that itself fails proves nothing either.
  w.existsHidesFiles.add(`${DIR}/b.md`)
  w.existsFails.add(`${DIR}/b.md`)
  await refresher.refresh(io)
  expect(names(w.shown)).toEqual(['a', 'c', 'unknown'])
})

test('a stat failure on a listed file is judged like a read failure', async () => {
  const { w, io } = world({ 'a.md': plan('T1'), 'b.md': plan('T2') })
  w.statFails.set(`${DIR}/b.md`, failure('EIO'))
  await createPlanRefresher().refresh(io)
  expect(names(w.shown)).toEqual(['a', 'unknown'])
})

test('a failed context is unknown and logged; the same bytes are reread and published once it recovers', async () => {
  const { w, io } = world({ 'a.md': plan('T1') })
  const refresher = createPlanRefresher()
  w.contextFails = true
  await refresher.refresh(io)
  expect(w.shown).toEqual([{ state: 'unknown' }])
  expect(w.logs).toEqual(['crew HUD: plan refresh failed'])
  w.contextFails = false
  await refresher.refresh(io)
  expect(names(w.shown)).toEqual(['a'])
})

test('a refresh during a read joins its flight and schedules one more snapshot after it', async () => {
  const { w, io } = world({ 'a.md': plan('T1') })
  const refresher = createPlanRefresher()
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const read = io.read
  let first = true
  io.read = async path => { if (first) { first = false; await held }; return read(path) }
  const flight = refresher.refresh(io)
  await tick()
  w.files['b.md'] = plan('T2')
  const joined = refresher.refresh(io)
  release()
  await Promise.all([flight, joined])
  expect(names(w.shown)).toEqual(['a', 'b'])
  expect(w.reads).toBe(3)
})

test('after a flight ends the next refresh starts a new one', async () => {
  const { w, io } = world({ 'a.md': plan('T1') })
  const refresher = createPlanRefresher()
  await refresher.refresh(io)
  w.files['a.md'] = plan('T9')
  await refresher.refresh(io)
  expect(JSON.stringify(w.shown)).toContain('T9')
})

test('a written plan file is retained as touched and read when the listing is unavailable', async () => {
  const { w, io } = world({ 'a.md': plan('T1') })
  w.listFails = true
  const refresher = createPlanRefresher()
  await refresher.refresh(io)
  expect(w.shown).toEqual([])
  await refresher.written(io, '.crew/plans/a.md')
  expect(names(w.shown)).toEqual(['a'])
  await refresher.written(io, `${ROOT}/.crew/plans/../plans/a.md`)
  expect(names(w.shown)).toEqual(['a'])
})

test('a write outside the plans, to a link, to a non-markdown file or with no path refreshes nothing', async () => {
  const { w, io } = world({ 'a.md': plan('T1'), 'link.md': plan('T2'), 'n.txt': 'x', 'sub-file': '' })
  w.links.add('link.md')
  w.realOf['sub-file'] = `${DIR}/sub/file.md`
  const refresher = createPlanRefresher()
  for (const path of [undefined, 42, 'README.md', '.crew/other/a.md', '.crew/plans/link.md', '.crew/plans/n.txt', '.crew/plans/sub-file']) {
    await refresher.written(io, path)
  }
  expect(w.published).toEqual([])
  expect(w.reads).toBe(0)
  // A path the host cannot stat rejects to the caller, which keeps it from the tool result.
  await expect(refresher.written(io, '.crew/plans/missing.md')).rejects.toThrow('ENOENT')
  expect(w.published).toEqual([])
})

test('a write when the plans directory is absent refreshes nothing', async () => {
  const { w, io } = world({ 'a.md': plan('T1') })
  w.directory = 'missing'
  await createPlanRefresher().written(io, '.crew/plans/a.md')
  expect(w.published).toEqual([])
})
