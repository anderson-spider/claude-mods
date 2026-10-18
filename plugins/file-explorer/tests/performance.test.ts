// Measured budgets for the work a large project costs: each figure is printed, and each bound is far above what a
// laptop takes so that a slow CI machine still passes while a regression of an order of magnitude does not.
import { expect, test } from 'claude-code/testing'
import { DEFAULTS } from '../hooks/config'
import { parseStatus } from '../hooks/git'
import { rank, withDirectories } from '../hooks/search'
import { flatten, listingOf } from '../hooks/tree'
import type { Entry, Listing } from '../hooks/tree'
import { ROOT, cursor, key, pane, rows, start, world } from './host'

const clock = globalThis as unknown as { performance?: { now: () => number } }
const now = () => clock.performance?.now() ?? Date.now()
const report = (line: string) => (globalThis as unknown as { console: { log: (line: string) => void } }).console.log(`perf: ${line}`)
const timed = <T>(label: string, run: () => T): { value: T; ms: number } => {
  const begun = now()
  const value = run()
  const ms = now() - begun
  report(`${label} ${ms.toFixed(1)} ms`)
  return { value, ms }
}

test('flattening 20,000 expanded rows and ranking 50,000 paths stay within their budgets', () => {
  // 100 folders of 200 files each, all expanded.
  const dirs: Record<string, Listing> = {}
  const top: Entry[] = []
  for (let d = 0; d < 100; d++) {
    top.push({ name: `pkg${d}`, kind: 'dir', isLink: false, size: 0, mtimeMs: 0 })
    dirs[`/p/pkg${d}`] = listingOf(Array.from({ length: 200 }, (_, f) => ({ name: `file${f}.ts`, kind: 'file' as const, isLink: false, size: 1, mtimeMs: f })), 1, 'name')
  }
  dirs['/p'] = listingOf(top, 1, 'name')
  const expanded = new Set(top.map(one => `/p/${one.name}`))
  const flat = timed('flatten 20k rows', () => flatten('/p', dirs, expanded, { showHidden: false, ignore: DEFAULTS.ignore }))
  expect(flat.value.length).toBe(20_000)
  expect(flat.ms).toBeLessThan(500)

  const paths = Array.from({ length: 50_000 }, (_, i) => `packages/pkg${i % 500}/src/module${i}.ts`)
  const index = timed('index 50k paths with folders', () => withDirectories(paths))
  expect(index.ms).toBeLessThan(500)
  const fuzzy = timed('fuzzy rank over 50k', () => rank(index.value, 'mod123', { mode: 'fuzzy', showHidden: false }))
  expect(fuzzy.value[0]).toBe('packages/pkg123/src/module123.ts')
  expect(fuzzy.ms).toBeLessThan(1000)
})

test('parsing a git status of 20,000 changed files stays within its budget', () => {
  const text = `## main\0${Array.from({ length: 20_000 }, (_, i) => ` M src/f${i}.ts`).join('\0')}\0`
  const parsed = timed('parse 20k status entries', () => parseStatus(text, '/repo'))
  expect(Object.keys(parsed.value.files)).toHaveLength(20_000)
  expect(parsed.ms).toBeLessThan(500)
})

test("observing Claude's tool calls adds little to each call, and a key on a 2,000-row folder draws quickly", async ($, on) => {
  const w = world(on, ['big/', ...Array.from({ length: 2000 }, (_, i) => `big/f${i}.ts`)])
  on('tool.call', () => ({ result: {} }) as never)
  await start($)
  const ui = await $.ui.mount(pane(60, 40))

  const calls = 50
  let begun = now()
  for (let i = 0; i < calls; i++) await $.tool.call({ tool: 'Read', file_path: `${ROOT}/big/f${i}.ts` } as never)
  const perCall = (now() - begun) / calls
  report(`Read observed ${perCall.toFixed(2)} ms per call`)
  expect(perCall).toBeLessThan(50)
  expect(await cursor(ui)).toContain('f49.ts')

  begun = now()
  await key(ui, 'G')
  const keyMs = now() - begun
  report(`key on a 2000-row folder ${keyMs.toFixed(1)} ms`)
  expect(keyMs).toBeLessThan(250)
  expect((await rows(ui)).length).toBeLessThanOrEqual(40)
  // Observing reads never ran git or listed anything beyond the root and the one folder they opened.
  expect(w.runs.filter(argv => argv[1] === 'status')).toHaveLength(0)
  await ui.unmount()
})
