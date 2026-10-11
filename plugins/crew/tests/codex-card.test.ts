import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { MAX_CARDS, codexCard, createThrottle, isTerminal, untaggedDescription, upsertCard } from '../hooks/codex/card'
import type { CodexJob } from '../hooks/codex/types'
import { cardTitle, elapsedOf, lanes, normalizeCard, titleLines } from '../hooks/flightdeck/core'
import type { AgentCard } from '../types'

const job = (over: Partial<CodexJob> = {}): CodexJob => ({
  id: 'job-1',
  agent: 'developer',
  description: 'fix the parser',
  status: 'running',
  startedAt: 1_000,
  activity: [],
  ...over,
})

test('a running job is a running card of type codex:<role>, still open', () => {
  const c = codexCard(job({ model: 'gpt-x', activity: ['read a.ts'] }), 5_000)
  expect(c).toEqual({
    id: 'job-1',
    type: 'codex:developer',
    model: 'gpt-x',
    description: 'fix the parser',
    status: 'running',
    spawnedAt: 1_000,
    endedAt: null,
    ctx: 0,
    out: 0,
    steps: 1,
    lastStop: null,
    tools: [{ tool: 'codex', text: 'read a.ts', isError: false }],
    answer: '',
  })
})

test('the card is whole: it survives normalizeCard unchanged', () => {
  const c = codexCard(job({ status: 'done', endedAt: 2_000, usage: { input: 10, cached: 4, output: 2 }, answer: 'ok' }), 9_000)
  expect(normalizeCard(c)).toEqual(c)
})

test('background counts as running; each end maps to a status the dashboard draws', () => {
  expect(codexCard(job({ status: 'background' }), 2_000).status).toBe('running')
  expect(codexCard(job({ status: 'background' }), 2_000).endedAt).toBeNull()
  expect(codexCard(job({ status: 'done', endedAt: 3_000 }), 9_000).status).toBe('done')
  expect(codexCard(job({ status: 'error', endedAt: 3_000 }), 9_000).status).toBe('failed')
  expect(codexCard(job({ status: 'lost' }), 9_000).status).toBe('failed')
  expect(codexCard(job({ status: 'cancelled', endedAt: 3_000 }), 9_000).status).toBe('stopped')
})

test('an ended card takes the job end, else now', () => {
  expect(codexCard(job({ status: 'done', endedAt: 3_000 }), 9_000).endedAt).toBe(3_000)
  expect(codexCard(job({ status: 'lost' }), 9_000).endedAt).toBe(9_000)
})

test('usage fills the context and output; no usage leaves zeros; the model may be absent', () => {
  const c = codexCard(job({ usage: { input: 1200, cached: 800, output: 90 } }), 2_000)
  expect(c.ctx).toBe(1200)
  expect(c.out).toBe(90)
  expect(codexCard(job(), 2_000).model).toBe('')
})

test('the card keeps the last three activity lines, cut short, and counts them as steps', () => {
  const c = codexCard(job({ activity: ['a', 'b', 'c', 'd', 'x'.repeat(200)] }), 2_000)
  expect(c.tools.map(t => t.text.slice(0, 1))).toEqual(['c', 'd', 'x'])
  expect(c.tools[2]!.text.length).toBeLessThanOrEqual(64)
  expect(c.steps).toBe(5)
})

test('an answer is shortened for the card', () => {
  expect(codexCard(job({ status: 'done', answer: 'y'.repeat(900) }), 2_000).answer.length).toBeLessThanOrEqual(400)
})

test('every role gets its own codex: type, the architect included', () => {
  expect(codexCard(job({ agent: 'architect' }), 2_000).type).toBe('codex:architect')
  expect(codexCard(job({ agent: 'code-reader' }), 2_000).type).toBe('codex:code-reader')
})

test('upsertCard appends a new card and replaces one with the same id in place', () => {
  const a = codexCard(job({ id: 'a' }), 2_000)
  const b = codexCard(job({ id: 'b' }), 2_000)
  const first = upsertCard([a], b)
  expect(first.map(c => c.id)).toEqual(['a', 'b'])
  const done = codexCard(job({ id: 'a', status: 'done', endedAt: 3_000 }), 4_000)
  const second = upsertCard(first, done)
  expect(second.map(c => c.id)).toEqual(['a', 'b'])
  expect(second[0]!.status).toBe('done')
})

test('upsertCard keeps the dashboard cap, dropping the oldest, and reads a list that is not one as empty', () => {
  let list: unknown = []
  for (let i = 0; i < MAX_CARDS + 3; i++) list = upsertCard(list, codexCard(job({ id: `j${i}` }), 2_000))
  const ids = (list as { id: string }[]).map(c => c.id)
  expect(ids).toHaveLength(MAX_CARDS)
  expect(ids[0]).toBe('j3')
  expect(ids.at(-1)).toBe(`j${MAX_CARDS + 2}`)
  expect(upsertCard(undefined, codexCard(job(), 2_000)).map(c => c.id)).toEqual(['job-1'])
  expect(upsertCard([{ id: 'a' }, { id: 'b' }, { id: 'c' }], codexCard(job({ id: 'd' }), 2_000), 2).map(c => c.id)).toEqual(['c', 'd'])
})

test('upsertCard leaves other agents’ cards as they are', () => {
  const native = { ...normalizeCard({}), id: 'n1', type: 'crew:developer', status: 'running' }
  const out = upsertCard([native], codexCard(job(), 2_000))
  expect(out[0]).toEqual(native)
})

test('isTerminal is true for the ends only', () => {
  expect(['running', 'background'].map(s => isTerminal(s as never))).toEqual([false, false])
  expect(['done', 'error', 'cancelled', 'lost'].map(s => isTerminal(s as never))).toEqual([true, true, true, true])
})

test('the throttle lets one write per job through each second', () => {
  const t = createThrottle()
  expect(t.allow('a', 'running', 0)).toBe(true)
  expect(t.allow('a', 'running', 400)).toBe(false)
  expect(t.allow('a', 'background', 999)).toBe(false)
  expect(t.allow('a', 'running', 1000)).toBe(true)
  // A skipped call does not move the window.
  expect(t.allow('a', 'running', 1500)).toBe(false)
  expect(t.allow('a', 'running', 2000)).toBe(true)
})

test('the throttle counts each job on its own', () => {
  const t = createThrottle()
  expect(t.allow('a', 'running', 0)).toBe(true)
  expect(t.allow('b', 'running', 10)).toBe(true)
  expect(t.allow('a', 'running', 20)).toBe(false)
  expect(t.allow('b', 'running', 30)).toBe(false)
})

test('a terminal state always passes, inside the window too', () => {
  const t = createThrottle()
  expect(t.allow('a', 'running', 0)).toBe(true)
  for (const s of ['done', 'error', 'cancelled', 'lost'] as const) {
    expect(t.allow('a', s, 1)).toBe(true)
    expect(t.allow('a', s, 2)).toBe(true)
  }
})

test('the throttle honors another interval and forgets a job on request', () => {
  const t = createThrottle(5000)
  expect(t.allow('a', 'running', 0)).toBe(true)
  expect(t.allow('a', 'running', 4999)).toBe(false)
  t.forget('a')
  expect(t.allow('a', 'running', 5000)).toBe(true)
})

// --- C1: every status gives a whole AgentCard ---

const STATUSES = ['running', 'background', 'done', 'error', 'cancelled', 'lost'] as const

test('every status gives a card with the AgentCard shape that normalizeCard leaves unchanged', () => {
  const keys = Object.keys(normalizeCard({})).sort()
  for (const status of STATUSES) {
    const c = codexCard(job({ status, endedAt: 3_000, usage: { input: 5, cached: 1, output: 2 }, answer: 'a', activity: ['x'] }), 9_000)
    expect(Object.keys(c).sort()).toEqual(keys)
    expect(normalizeCard(c)).toEqual(c)
    for (const k of ['id', 'type', 'model', 'description', 'status', 'answer'] as const) expect(typeof c[k]).toBe('string')
    for (const k of ['spawnedAt', 'ctx', 'out', 'steps'] as const) expect(typeof c[k]).toBe('number')
    expect(c.lastStop).toBeNull()
    expect(Array.isArray(c.tools)).toBe(true)
    expect(['running', 'done', 'failed', 'stopped']).toContain(c.status)
  }
})

test('endedAt is null only while running or in the background, for every status and with or without an end', () => {
  for (const status of STATUSES) {
    for (const endedAt of [undefined, 3_000]) {
      const c = codexCard(job({ status, endedAt }), 9_000)
      const open = status === 'running' || status === 'background'
      expect(c.endedAt === null).toBe(open)
      if (!open) expect(c.endedAt).toBe(endedAt ?? 9_000)
    }
  }
  // A job that is open keeps no end even when the record carries one.
  expect(codexCard(job({ status: 'running', endedAt: 3_000 }), 9_000).endedAt).toBeNull()
})

test('terminal agrees with an ended card for every status', () => {
  for (const status of STATUSES) expect(isTerminal(status)).toBe(codexCard(job({ status }), 9_000).endedAt !== null)
})

test('a status the type does not list still gives a whole, failed, ended card', () => {
  const c = codexCard(job({ status: 'weird' as never }), 9_000)
  expect(c.status).toBe('failed')
  expect(c.endedAt).toBe(9_000)
})

// --- C2: upsert details ---

test('upsertCard replaces in place without moving other cards, at the cap too', () => {
  let list: unknown = []
  for (let i = 0; i < MAX_CARDS; i++) list = upsertCard(list, codexCard(job({ id: `j${i}` }), 2_000))
  const before = (list as AgentCard[]).map(c => c.id)
  const again = upsertCard(list, codexCard(job({ id: 'j5', status: 'done', endedAt: 3_000 }), 4_000))
  expect(again.map(c => c.id)).toEqual(before)
  expect(again[5]!.status).toBe('done')
  // A new one at the cap drops exactly the oldest.
  const next = upsertCard(again, codexCard(job({ id: 'new' }), 5_000))
  expect(next).toHaveLength(MAX_CARDS)
  expect(next.map(c => c.id)).toEqual([...before.slice(1), 'new'])
})

test('upsertCard tolerates every kind of non-array and junk entries', () => {
  const card = codexCard(job(), 2_000)
  for (const bad of [null, undefined, 'x', 5, {}, { length: 3 }]) expect(upsertCard(bad, card)).toEqual([card])
  const out = upsertCard([null, 'x', { id: 'old' }] as unknown, card)
  expect(out.map(c => c.id)).toEqual(['', '', 'old', 'job-1'].slice(0, 4))
  for (const c of out) expect(normalizeCard(c)).toEqual(c)
})

test('upsertCard does not mutate the list it was given', () => {
  const a = codexCard(job({ id: 'a' }), 2_000)
  const list = [a]
  upsertCard(list, codexCard(job({ id: 'a', status: 'done', endedAt: 3 }), 4))
  upsertCard(list, codexCard(job({ id: 'b' }), 4))
  expect(list).toEqual([a])
})

// --- C3: throttle details ---

test('the throttle window is the interval exactly, from the last write', () => {
  const t = createThrottle(1000)
  expect(t.allow('a', 'running', 5_000)).toBe(true)
  expect(t.allow('a', 'running', 5_999)).toBe(false)
  expect(t.allow('a', 'running', 6_000)).toBe(true)
})

test('a terminal write resets the job: a later running write for it passes at once', () => {
  const t = createThrottle()
  expect(t.allow('a', 'running', 0)).toBe(true)
  expect(t.allow('a', 'done', 10)).toBe(true)
  expect(t.allow('a', 'running', 20)).toBe(true)
})

test('forget resets only the job named', () => {
  const t = createThrottle()
  t.allow('a', 'running', 0)
  t.allow('b', 'running', 0)
  t.forget('a')
  t.forget('never-seen')
  expect(t.allow('a', 'running', 1)).toBe(true)
  expect(t.allow('b', 'running', 1)).toBe(false)
})

test('two throttles do not share state', () => {
  const x = createThrottle()
  const y = createThrottle()
  expect(x.allow('a', 'running', 0)).toBe(true)
  expect(y.allow('a', 'running', 1)).toBe(true)
})

// --- C5: long and odd text ---

test('newlines and runs of space in activity and answer become single spaces', () => {
  const c = codexCard(job({ status: 'done', answer: 'line one\n\nline   two\t\tend', activity: ['ran\nnpm   test\r\n'] }), 2_000)
  expect(c.answer).toBe('line one line two end')
  expect(c.tools[0]!.text).toBe('ran npm test')
})

test('a 1000-character answer is cut to 400 with an ellipsis, a short one is left alone', () => {
  const c = codexCard(job({ status: 'done', answer: 'z'.repeat(1000) }), 2_000)
  expect(c.answer).toHaveLength(400)
  expect(c.answer.endsWith('…')).toBe(true)
  expect(codexCard(job({ answer: 'z'.repeat(400) }), 2_000).answer).toBe('z'.repeat(400))
  expect(codexCard(job({ answer: '' }), 2_000).answer).toBe('')
  expect(codexCard(job({ answer: '  \n ' }), 2_000).answer).toBe('')
})

test('an activity line is cut to 64 with an ellipsis; no activity gives no tools and zero steps', () => {
  const t = codexCard(job({ activity: ['q'.repeat(500)] }), 2_000).tools[0]!
  expect(t.text).toHaveLength(64)
  expect(t.text.endsWith('…')).toBe(true)
  const none = codexCard(job(), 2_000)
  expect(none.tools).toEqual([])
  expect(none.steps).toBe(0)
})

test('emoji and wide characters survive, and a cut never leaves a lone surrogate half that the card cannot hold', () => {
  const c = codexCard(job({ status: 'done', activity: ['🚀'.repeat(100), '日本語のテキスト'.repeat(20), '👩‍💻 ok'], answer: '😀'.repeat(900) }), 2_000)
  expect(c.tools[2]!.text).toBe('👩‍💻 ok')
  for (const t of c.tools) expect(t.text.length).toBeLessThanOrEqual(64)
  expect(c.answer.length).toBeLessThanOrEqual(400)
  expect(() => JSON.stringify(c)).not.toThrow()
  expect(normalizeCard(JSON.parse(JSON.stringify(c)))).toEqual(c)
})

test('a long description and an empty one are kept for the card to title', () => {
  expect(codexCard(job({ description: 'd'.repeat(500) }), 2_000).description).toHaveLength(500)
  const empty = codexCard(job({ description: '' }), 2_000)
  expect(cardTitle(empty)).toBe('codex:developer')
  expect(titleLines(cardTitle(codexCard(job({ description: 'word '.repeat(80) }), 2_000)), 13, 16)).toHaveLength(2)
})

test('swimlane geometry and elapsed time take a codex card, open or ended', () => {
  const open = codexCard(job({ id: 'o', startedAt: 1_000 }), 2_000)
  const done = codexCard(job({ id: 'd', status: 'done', startedAt: 1_000, endedAt: 4_000 }), 9_000)
  const rows = lanes([open, done], 10_000, 20)
  expect(rows.map(r => r.id)).toEqual(['o', 'd'])
  for (const r of rows) expect(r.before + r.bar + r.after).toBe(20)
  expect(elapsedOf(open, 10_000)).toBe(9_000)
  expect(elapsedOf(done, 10_000)).toBe(3_000)
})

// --- C4: the dashboard draws codex cards (through the host: the drawing code is not exported) ---

/**
 * The test host cannot write the dashboard's atoms itself (its own `$.state` is refused: it is no hooks module that calls
 * it), so the host side keeps a small state: `crew/agents` starts as the cards given, every other value as it was never
 * written. The dashboard reads and draws exactly as it would from its own atom.
 */
const world = (on: On, cards: unknown) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const values = new Map<string, unknown>([['agents', cards]])
  const versions = new Map<string, number>()
  on('state.get', (_$, e) => ({ value: { value: values.get((e as { key: string }).key), version: versions.get((e as { key: string }).key) ?? 0 } }) as never)
  on('state.set', (_$, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    values.set(key, value)
    versions.set(key, (versions.get(key) ?? 0) + 1)
    return { value: { isSet: true, version: versions.get(key)! } } as never
  })
}

const pane = (bodyColumns: number, placement: 'dock' | 'inline' = 'dock') => ({
  plugin: 'crew',
  component: 'Pane' as const,
  requestId: 'flightdeck',
  surface: 'terminal' as const,
  props: { title: 'Flightdeck', isFocused: true, bodyColumns, placement, scroll: { offset: 0, bodyRows: 70 }, view: {} },
})

const oddJobs = (): CodexJob[] => [
  ...STATUSES.map((status, i) =>
    job({ id: `s-${status}`, status, description: `job ${status}`, startedAt: 1_000 + i, endedAt: status === 'running' || status === 'background' ? undefined : 2_000, activity: ['read a.ts'], answer: 'done it', usage: { input: 1200, cached: 10, output: 30 }, model: 'gpt-x' }),
  ),
  job({ id: 'odd', agent: 'architect', description: 'multi\nline 🚀 日本語 ' + 'w'.repeat(300), status: 'done', endedAt: 2_000, activity: ['🚀'.repeat(100), 'a\nb', ''], answer: 'long '.repeat(300) }),
  job({ id: 'bare', description: '', activity: [] }),
]

test('the pane and the summary draw codex cards of every status, odd text included, without throwing', async ($, on) => {
  const jobs = oddJobs()
  world(on, jobs.reduce((list, j) => upsertCard(list, codexCard(j, 5_000)), [] as AgentCard[]))
  for (const cols of [40, 64, 86, 120]) {
    const ui = await $.ui.mount(pane(cols))
    expect(await ui.find({ text: /agents ·/ })).toBeDefined()
    await ui.unmount()
  }
  const inline = await $.ui.mount(pane(80, 'inline'))
  expect(await inline.find({ text: /job running/ })).toBeDefined()
  await inline.unmount()
})

test('a codex card is titled by its description in the wide pane', async ($, on) => {
  world(on, [codexCard(job({ id: 'c1', description: 'port the parser', activity: ['read a.ts'] }), 5_000)])
  const ui = await $.ui.mount(pane(120))
  expect(await ui.find({ text: /port the parser/ })).toBeDefined()
  await ui.unmount()
})

test('a card list from a past session in the wrong shape is still drawn after the upsert', async ($, on) => {
  world(on, upsertCard([{ id: 'old' }, null, 'x'], codexCard(job({ id: 'c1', description: 'after junk' }), 5_000)))
  const ui = await $.ui.mount(pane(120))
  expect(await ui.find({ text: /after junk/ })).toBeDefined()
  await ui.unmount()
})

test('an empty description gives the tag alone, with no leading separator', () => {
  expect(codexCard(job({ description: '', effort: 'medium' }), 2_000).description).toBe('codex/medium')
})

test('an effort tags the card description with the model, or codex when there is none; the job description is unchanged', () => {
  const j = job({ effort: 'high' })
  expect(codexCard(j, 2_000).description).toBe('fix the parser · codex/high')
  expect(j.description).toBe('fix the parser')
  expect(codexCard(job({ effort: 'medium', model: 'gpt-5.3-codex-max' }), 2_000).description).toBe('fix the parser · gpt-5.3-codex-max/medium')
  expect(codexCard(job(), 2_000).description).toBe('fix the parser')
})

test('untaggedDescription strips every trailing card tag, and a title that is only the tag', () => {
  expect(untaggedDescription('audit auth · codex/medium')).toBe('audit auth')
  expect(untaggedDescription('audit auth · codex/m · codex/medium')).toBe('audit auth · codex/m')
  expect(untaggedDescription('audit auth · codex/medium · gpt-5.3-codex-max/high')).toBe('audit auth')
  expect(untaggedDescription('codex/medium')).toBe('')
  expect(untaggedDescription('review codex/high flags')).toBe('review codex/high flags')
})
