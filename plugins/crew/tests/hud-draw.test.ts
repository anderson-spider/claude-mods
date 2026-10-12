import { expect, test } from 'claude-code/testing'
import type { Elements, RenderElement } from 'claude-code'
import { decide, type Quota, type Reading } from '../hooks/quota'
import { MINI_HINT, BAND_HINT, bandShows, paneForm, paneLayout, paneRows, summaryLines, terminalRows, type PaneRow } from '../hooks/hud/compose'
import { drawBand, drawPane, drawSummary, type HudEls } from '../hooks/hud/draw'
import { levelPlan } from '../hooks/hud/layout'
import { lineText, type Line, type Span } from '../hooks/hud/line'
import { elapsedCell, elapsedText, railRuns } from '../hooks/hud/live'
import { colorsOption, paint, paletteOf } from '../hooks/hud/palette'
import { parsePlan, planView } from '../hooks/hud/plan'
import { derive, linkedStep, quotaHeading, type HudContext, type HudInput } from '../hooks/hud/sections'
import {
  agentCompleted,
  agentDenied,
  agentMessaged,
  agentSpawned,
  agentStepped,
  agentTool,
  askOpened,
  consultEnded,
  consultStarted,
  defaultSession,
  logged,
  promptLine,
  sessionCompacted,
  sessionMeasured,
  sessionStepped,
  spawnLine,
  turnEnded,
  turnStarted,
} from '../hooks/hud/state'
import { timelineSvg } from '../hooks/hud/svg'
import type { AgentCard, Consult, Loop, Session } from '../hooks/hud/types'
import { cellWidth } from '../hooks/hud/width'
import { CREW_HARNESS, PROXY_REWRITE } from './hud-fixtures'

// ------------------------------------------------------------------ fixtures

const NOW = Date.parse('2026-10-12T14:32:00')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const win = (percentUsed: number, resetMin?: number) => ({ percentUsed, ...(resetMin === undefined ? {} : { resetsAt: iso(NOW + resetMin * MIN) }) })
const CLAUDE: Reading = { fiveHour: win(41, 130), sevenDay: win(71, 76 * 60) }
const CODEX: Reading = { fiveHour: win(12, 245), sevenDay: win(38, 145 * 60) }

function quota(over: Partial<Quota> = {}): Quota {
  const q: Quota = {
    claude: CLAUDE,
    codex: CODEX,
    codexState: 'ok',
    fetchedAt: NOW - MIN,
    codexObservedAt: NOW - MIN,
    claudeAt: NOW - MIN,
    decision: { provider: 'claude', reason: '' },
    ...over,
  }
  return over.decision ? q : { ...q, decision: decide(q.claude, q.codex, q.codexState, true, NOW) }
}

const CTX: HudContext = { routing: true, jev: true, twins: true, claudeMeasured: true }
const BARE: HudContext = { routing: false, jev: false, twins: false, claudeMeasured: true }

function workingSession(): Session {
  let s = defaultSession(NOW - 72 * MIN)
  s = { ...s, model: 'claude-opus-5-5', effort: 'high', mode: 'auto' }
  s = sessionMeasured(s, { tokens: 128_000, window: 200_000, costUsd: 4.12 })
  s = turnStarted(s, { now: NOW - 42_000 })
  return sessionStepped(s, { isMain: true, usage: { input_tokens: 100_000, cache_read_input_tokens: 1_100_000, output_tokens: 84_000 } })
}

function busyAgents(): AgentCard[] {
  let a: AgentCard[] = []
  a = agentSpawned(a, { id: 'a1', type: 'crew:developer', description: 'T2: contract injection point: //go:build contract files', model: 'claude-sonnet-5-5', effort: 'high', now: NOW - 192_000 })
  a = agentStepped(a, { id: 'a1', usage: { input_tokens: 82_000 }, now: NOW - 100_000 })
  a = agentTool(a, 'a1', 'Edit internal/config/contract_on.go')
  a = agentSpawned(a, { id: 'a2', type: 'crew:code-reader', description: 'where does the router read codex.base_url?', model: 'claude-haiku-5-5', effort: 'medium', now: NOW - 21_000 })
  a = agentSpawned(a, { id: 'a3', type: 'crew:tester-codex', description: 'T0 allowlist check', model: 'gpt-6-astra', now: NOW - 10 * MIN })
  a = agentCompleted(a, { id: 'a3', reason: 'answer', now: NOW - 10 * MIN + 106_000 })
  a = agentSpawned(a, { id: 'a4', type: 'crew:research', description: 'API2 migration notes', now: NOW - 8 * MIN })
  a = agentStepped(a, { id: 'a4', stopReason: 'max_tokens', now: NOW - 7 * MIN })
  return agentCompleted(a, { id: 'a4', reason: 'error', now: NOW - 6 * MIN })
}

function consults(): Consult[] {
  let c: Consult[] = []
  c = consultStarted(c, { id: 'c1', type: 'crew:architect', description: 'T1 review', now: NOW - 12 * MIN })
  c = consultEnded(c, { id: 'c1', now: NOW - 11 * MIN, answer: 'Approve: T1 module path is clean' })
  c = consultStarted(c, { id: 'c2', type: 'crew:architect-codex', description: 'R3', now: NOW - 9 * MIN })
  c = consultEnded(c, { id: 'c2', now: NOW - 8 * MIN, answer: 'Fixes: keepalive test races on stop' })
  c = consultStarted(c, { id: 'c3', type: 'crew:architect', description: 'T2 approach', now: NOW - 72_000 })
  return c
}

const LOOPS: Loop[] = [
  { id: 'l1', firstAt: NOW - 30_000, lastAt: NOW - 1000, steps: 3, isDone: false },
  { id: 'l2', firstAt: NOW - 90_000, lastAt: NOW - 60_000, steps: 3, isDone: true },
]

function busy(over: Partial<HudInput> = {}): HudInput {
  const agents = busyAgents()
  let log = logged([], promptLine('split the proxy rewrite into steps', NOW - 5 * MIN))
  for (const card of agents) log = logged(log, spawnLine(card, NOW - 3 * MIN))
  return {
    session: workingSession(),
    agents,
    consults: consults(),
    log,
    loops: LOOPS,
    favored: null,
    quota: quota(),
    plan: { name: 'proxy-rewrite', parsed: parsePlan(PROXY_REWRITE) },
    now: NOW,
    ...over,
  }
}

function fresh(over: Partial<HudInput> = {}): HudInput {
  return {
    session: { ...defaultSession(NOW), model: 'claude-opus-5-5', effort: 'high' },
    agents: [],
    consults: [],
    log: [],
    loops: [],
    favored: null,
    quota: quota({ codex: null, codexState: 'off' }),
    plan: null,
    now: NOW,
    ...over,
  }
}

/** A plan file from step lines. */
const planOf = (name: string, ...steps: string[]) => ({ name, parsed: parsePlan(['## Steps', '', ...steps].join('\n')) })

// ------------------------------------------------------------------ fake constructors

type Node = { type: string; props: Record<string, unknown>; kids: (Node | string)[] }

const flat = (children: unknown): (Node | string)[] => {
  if (children === null || children === undefined || children === false || children === true) return []
  if (Array.isArray(children)) return children.flatMap(flat)
  if (typeof children === 'string' || typeof children === 'number') return [String(children)]
  return [children as Node]
}

function fakes(o: { svg?: boolean; clock?: boolean; rail?: boolean; button?: boolean } = {}): HudEls<Node> {
  const el = (type: string) => (props: { children?: unknown } & Record<string, unknown>): Node => {
    const { children, ...rest } = props
    return { type, props: rest, kids: flat(children) }
  }
  return {
    Box: el('Box'),
    Text: el('Text'),
    ...(o.svg ? { Svg: el('Svg') } : {}),
    ...(o.button ? { Button: el('Button') } : {}),
    ...(o.clock === false ? {} : { Clock: (c: { key: string; width: number; props: unknown }) => ({ type: 'Clock', props: c as unknown as Record<string, unknown>, kids: [] }) }),
    ...(o.rail ? { Rail: (r: { key: string; width: number; props: unknown }) => ({ type: 'Rail', props: r as unknown as Record<string, unknown>, kids: [] }) } : {}),
  }
}

/** The text a node draws: a clock its cell, a rail its still line. */
function textOf(n: Node | string): string {
  if (typeof n === 'string') return n
  if (n.type === 'Clock') return elapsedCell((n.props as { props: Parameters<typeof elapsedCell>[0] }).props)
  if (n.type === 'Rail') return '─'.repeat(n.props.width as number)
  // The host's plain Button draws its hotkey, a colon and a space before its content (`1: Yes`).
  if (n.type === 'Button') return `${n.props.plain && n.props.hotkey ? `${n.props.hotkey}: ` : ''}${n.kids.map(textOf).join('')}`
  return n.kids.map(textOf).join('')
}

/** A column Box's rows as text. */
const linesOf = (tree: Node) => tree.kids.map(textOf)

function findAll(n: Node | string, pred: (n: Node) => boolean): Node[] {
  if (typeof n === 'string') return []
  return [...(pred(n) ? [n] : []), ...n.kids.flatMap(k => findAll(k, pred))]
}

const texts = (rows: readonly PaneRow[]) => rows.map(r => lineText(r.spans))
const pane = (input: HudInput, ctx = CTX, width = 56, rows = 200) => paneRows(input, ctx, { width, rows })
const titles = (lines: readonly string[]) => lines.filter(l => l.startsWith('╭─ ')).map(l => l.replace(/^╭─ /, '').replace(/ ─+╮$/, ''))
const spansOf = (rows: readonly PaneRow[], has: string): Span[] => rows.find(r => lineText(r.spans).includes(has))?.spans ?? []

const expectExact = (lines: readonly string[], width: number) => {
  for (const line of lines) {
    if (cellWidth(line) !== width) throw new Error(`row is ${cellWidth(line)} cells, not ${width}: ${JSON.stringify(line)}`)
  }
}

// ------------------------------------------------------------------ surfaces

test('terminal pane: every card in the spec order, each row exactly 56 cells, drawn through the injected constructors', () => {
  const els = fakes()
  const drawn = drawPane(els, busy(), CTX, { width: 56, rows: 200, surface: 'terminal', colors: 'theme', motion: false })
  const lines = linesOf(drawn.tree)
  expect(drawn.level).toBe(0)
  expect(drawn.errors).toEqual([])
  expect(drawn.height).toBe(lines.length)
  expectExact(lines, 56)
  expect(lines[0]).toMatch(/^ CREW  auto · jev · cx +14:32$/)
  expect(titles(lines)).toEqual(['Session', 'Quota', 'Plan · proxy-rewrite', 'Agents · running 2', 'Review 3', 'Agents · finished 2', 'Last 15 minutes', 'Log'])
  expect(lines[lines.length - 1]).toBe('  ▶ run ▰ done ✗ fail ▪ stop ▱ planned ⊘ blocked'.padEnd(56))
  // Session and Quota sit flush; a rail precedes each later card.
  const at = (t: string) => lines.findIndex(l => l.startsWith(`╭─ ${t}`))
  expect(lines[at('Quota') - 1]?.startsWith('╰')).toBe(true)
  for (const t of ['Plan', 'Agents · running', 'Review', 'Agents · finished', 'Last 15', 'Log']) expect(lines[at(t) - 1]).toBe(`  ${'─'.repeat(52)}  `)
})

test('terminal pane matches the spec sketch rows (4.3)', () => {
  const lines = texts(pane(busy()).rows)
  expect(lines).toContain('│ Opus 5.5 · high effort                     ● working │')
  expect(lines).toContain('│ ctx ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱ 64%     128k/200k │')
  expect(lines).toContain('│ $4.12  in 1.2M 92% cached  out 84k           up 1:12 │')
  expect(lines).toContain('│     Claude           resets  Codex ◆          resets │')
  expect(lines).toContain('│ 5h  ▰▰▰▰▱▱▱▱▱▱  41%   2h10m  ▰▱▱▱▱▱▱▱▱▱  12%   4h05m │')
  expect(lines).toContain('│ 7d  ▰▰▰▰▰▰▰▱▱▱  71%!   3d4h  ▰▰▰▰▱▱▱▱▱▱  38%    6d1h │')
  expect(lines).toContain('│ → Codex favored: 7d 38% used vs Claude 7d 71%        │')
  expect(lines).toContain('│ ● developer    Sonnet 5.5 · high   ▶▱▱▱▱▱       3:12 │')
  expect(lines).toContain('│   ↳ T2 contract injection point: //go:build contrac… │')
  expect(lines).toContain('│     Edit internal/config/contract_on.go      ctx 41% │')
  expect(lines).toContain('│ ● code-reader  Haiku 5.5 · medium  ▶            0:21 │')
  expect(lines).toContain('│ ⋯ 2 loops · 1 active (workflow agents, forks)        │')
  expect(lines).toContain('│              -15m      -10m      -5m    now          │')
})

test('the clocks are live regions the caller ticks; without a Clock constructor the same rows are static text', () => {
  const live = drawPane(fakes(), busy(), CTX, { width: 56, rows: 200, surface: 'terminal', colors: 'theme', motion: false })
  const clocks = findAll(live.tree, n => n.type === 'Clock')
  expect(clocks.map(c => c.props.key)).toEqual(['run-a1', 'run-a2'])
  expect(clocks[0]?.props).toMatchObject({ width: 8, props: { since: NOW - 192_000, now: NOW, endAt: null, align: 'right' } })
  const still = drawPane(fakes({ clock: false }), busy(), CTX, { width: 56, rows: 200, surface: 'terminal', colors: 'theme', motion: false })
  expect(findAll(still.tree, n => n.type === 'Clock')).toHaveLength(0)
  expect(linesOf(still.tree)).toEqual(linesOf(live.tree))
})

test('rails animate only into live cards and only with motion; Finished, the timeline and the Log stay still', () => {
  const moving = drawPane(fakes({ rail: true }), busy(), CTX, { width: 56, rows: 200, surface: 'terminal', colors: 'roles', motion: true })
  const rails = findAll(moving.tree, n => n.type === 'Rail')
  expect(rails.map(r => r.props.key)).toEqual(['rail-running', 'rail-review'])
  expect(rails[0]?.props).toMatchObject({ width: 52, props: { active: true, width: 52, color: '#4CC2A0', faint: '#3B4354' } })
  expectExact(linesOf(moving.tree), 56)
  const still = drawPane(fakes({ rail: true }), busy(), CTX, { width: 56, rows: 200, surface: 'terminal', colors: 'roles', motion: false })
  expect(findAll(still.tree, n => n.type === 'Rail')).toHaveLength(0)
  // A plan step whose linked agent runs makes the rail into Plan live.
  const linked = busy({ plan: planOf('p', '- T2 (crew:developer, after: —) contract — state: implementing') })
  const planRails = findAll(drawPane(fakes({ rail: true }), linked, CTX, { width: 56, rows: 200, surface: 'terminal', colors: 'theme', motion: true }).tree, n => n.type === 'Rail')
  expect(planRails.map(r => r.props.key)).toContain('rail-plan')
})

test('mini: one line per item at the width, at most 8 rows, in the table order', () => {
  const tree = drawSummary(fakes(), busy(), CTX, { width: 56, form: 'mini', maxRows: 8, colors: 'theme', motion: false })
  const lines = linesOf(tree)
  expectExact(lines, 56)
  expect(lines.length).toBeLessThanOrEqual(8)
  expect(lines[0]).toBe('● working 0:42  Opus 5.5·high  ctx ▰▰▰▰▰▰▱▱▱▱ 64%  $4.12')
  expect(lines[1]).toBe('7d Claude ▰▰▰▰▰▰▱▱ 71%! · Codex ▰▰▰▱▱▱▱▱ 38% → Codex'.padEnd(56))
  expect(lines[2]?.startsWith('plan 7/16 ▰▰▰▰▶▶▱▱ · now T3 R1 R3')).toBe(true)
  expect(lines[3]).toBe('● developer    T2 contract injection point: //go:…  3:12')
  expect(lines[5]?.startsWith('● architect    consulting · 1:12 · T2 approach')).toBe(true)
  expect(lines[6]?.trim()).toBe('2 loops')
  expect(findAll(tree, n => n.type === 'Clock').map(c => c.props.key)).toEqual(['mini-turn', 'mini-run-a1', 'mini-run-a2'])
})

test('mini footer carries the docking hint when it fits', () => {
  const lines = summaryLines(busy({ loops: [] }), CTX, { width: 120, form: 'mini', maxRows: 3 })
  expect(lines).toHaveLength(3)
  expect(lineText(lines[2] as Line).trim()).toBe(`+1 more running · ${MINI_HINT}`)
})

test('F8: a docked pane under layout mini has no docking hint; the footer keeps what was left out', () => {
  const lines = summaryLines(busy({ loops: [] }), CTX, { width: 120, form: 'mini', maxRows: 3, docked: true })
  expect(lines).toHaveLength(3)
  expect(lineText(lines[2] as Line).trim()).toBe('+1 more running')
  const tree = drawSummary(fakes(), busy(), CTX, { width: 120, form: 'mini', maxRows: 3, docked: true, colors: 'theme', motion: false })
  expect(linesOf(tree).join('\n')).not.toContain(MINI_HINT)
  // Nothing left out but the docking hint: no footer row at all.
  const roomy = summaryLines(busy({ loops: [], agents: busyAgents().slice(0, 1) }), CTX, { width: 120, form: 'mini', maxRows: 8, docked: true })
  expect(roomy.map(lineText).some(l => l.trim() === '')).toBe(false)
})

test('band: at most min(6, maxRows - 4) rows and min(3, max(1, maxRows - 5)) agents, exactly bodyColumns wide (below 40 too)', () => {
  const four = busyAgents().concat(
    agentSpawned([], { id: 'a5', type: 'crew:developer-codex', description: 'R3 typed structs', model: 'gpt-6-astra', effort: 'high', now: NOW - 30_000 }),
    agentSpawned([], { id: 'a6', type: 'crew:designer', description: 'HUD spec', now: NOW - 20_000 }),
  )
  for (const maxRows of [5, 6, 7, 8, 10, 14]) {
    const tree = drawBand(fakes(), busy({ agents: four }), CTX, { surface: 'terminal', hasSurvey: false, choice: { isVisible: true, placement: 'prompt' }, maxRows, bodyColumns: 60, colors: 'theme', motion: false })
    const lines = linesOf(tree as Node)
    expectExact(lines, 60)
    expect(lines.length).toBeLessThanOrEqual(Math.max(1, Math.min(6, maxRows - 4)))
    expect(lines.filter(l => l.startsWith('● ') && !l.startsWith('● working')).length).toBeLessThanOrEqual(Math.min(3, Math.max(1, maxRows - 5)))
  }
  const narrow = drawBand(fakes(), busy(), CTX, { surface: 'desktop', hasSurvey: false, choice: { isVisible: true, placement: 'prompt' }, maxRows: 10, bodyColumns: 30, colors: 'theme', motion: false })
  expectExact(linesOf(narrow as Node), 30)
  expect((narrow as Node).props.width).toBe(30)
  const tall = summaryLines(busy({ agents: four, loops: [] }), CTX, { width: 80, form: 'band', maxRows: 10 })
  expect(lineText(tall[tall.length - 1] as Line).trim()).toBe(`+2 more running · ${BAND_HINT}`)
})

test('the band yields: hidden, at side, under a survey, before a choice, on vscode and mobile', () => {
  const draw = (o: Partial<Parameters<typeof drawBand>[3]>) =>
    drawBand(fakes(), busy(), CTX, { surface: 'terminal', hasSurvey: false, choice: { isVisible: true, placement: 'prompt' }, maxRows: 10, bodyColumns: 80, colors: 'theme', motion: false, ...o })
  expect(draw({})).not.toBeNull()
  expect(draw({ surface: 'desktop' })).not.toBeNull()
  expect(draw({ choice: { isVisible: false, placement: 'prompt' } })).toBeNull()
  expect(draw({ choice: { isVisible: true, placement: 'side' } })).toBeNull()
  expect(draw({ choice: null })).toBeNull()
  expect(draw({ hasSurvey: true })).toBeNull()
  expect(draw({ surface: 'vscode' })).toBeNull()
  expect(draw({ surface: 'mobile' })).toBeNull()
  expect(bandShows({ surface: 'terminal', hasSurvey: false, choice: { isVisible: true, placement: 'prompt' } })).toBe(true)
})

test('pane form: full when docked under auto, the summary inline or under mini', () => {
  expect(paneForm({ layout: 'auto', placement: 'dock' })).toBe('full')
  expect(paneForm({ layout: 'auto', placement: 'inline' })).toBe('mini')
  expect(paneForm({ layout: 'mini', placement: 'dock' })).toBe('mini')
})

test('desktop: native round boxes in section colors, the title inside, no rails, the timeline as one SVG with alt', () => {
  const drawn = drawPane(fakes({ svg: true, rail: true }), busy(), CTX, { width: 72, rows: 200, surface: 'desktop', colors: 'theme', motion: true })
  const boxes = findAll(drawn.tree, n => n.type === 'Box' && n.props.borderStyle === 'round')
  expect(boxes.map(b => textOf(b.kids[0] as Node))).toEqual(['Session', 'Quota', 'Plan · proxy-rewrite', 'Agents · running 2', 'Review 3', 'Agents · finished 2', 'Last 15 minutes', 'Log'])
  expect(boxes.map(b => b.props.borderColor)).toEqual(['suggestion', 'suggestion', 'warning', 'success', 'merged', 'inactive', 'permission', 'subtle'])
  expect(boxes[1]?.props.marginTop).toBe(1)
  expect(findAll(drawn.tree, n => n.type === 'Rail')).toHaveLength(0)
  const svgs = findAll(drawn.tree, n => n.type === 'Svg')
  expect(svgs).toHaveLength(1)
  expect(svgs[0]?.props.alt).toBe('Last 15 minutes: lead busy 1 minute; code-reader 1 job, under a minute; research 1 job, 2 minutes; developer 1 job, 3 minutes; tester·cx 1 job, 2 minutes; architect 2 jobs, 2 minutes; architect·cx 1 job, 1 minute')
  expect(String(svgs[0]?.props.source)).toMatch(/^<svg [^>]*>.*<\/svg>$/)
  // The card bodies are the same rows as the terminal's, at the content width.
  for (const box of boxes.filter(b => !findAll(b, n => n.type === 'Svg').length)) for (const row of box.kids.slice(1)) expect(cellWidth(textOf(row))).toBe(68)
  // Without Svg the lanes stay text.
  const text = drawPane(fakes(), busy(), CTX, { width: 72, rows: 200, surface: 'desktop', colors: 'theme', motion: false })
  expect(findAll(text.tree, n => n.type === 'Svg')).toHaveLength(0)
  expect(linesOf(text.tree).join('\n')).toContain('-15m')
})

test('desktop from 110 columns: two columns (Session, Quota, Plan, Review | Running, Finished, timeline), Log across', () => {
  const drawn = drawPane(fakes(), busy(), CTX, { width: 121, rows: 200, surface: 'desktop', colors: 'theme', motion: false })
  const split = paneLayout(busy(), CTX, { width: 121, rows: 200, surface: 'desktop' }).split
  expect(split).toEqual({ left: ['session', 'quota', 'plan', 'review'], right: ['running', 'finished', 'timeline'], width: 60 })
  const row = findAll(drawn.tree, n => n.type === 'Box' && n.props.flexDirection === 'row' && n.props.columnGap === 1)
  expect(row).toHaveLength(1)
  const log = findAll(drawn.tree, n => n.props.borderStyle === 'round' && textOf(n.kids[0] as Node) === 'Log')
  expect(log[0]?.props.width).toBe(121)
})

test('the pressable agent rows: Buttons with hotkeys 1-9 in display order when focused, the details block when open', () => {
  const opened: string[] = []
  const drawn = drawPane(fakes({ button: true }), busy(), CTX, {
    width: 56,
    rows: 200,
    surface: 'terminal',
    colors: 'theme',
    motion: false,
    focus: { isFocused: true, openId: 'a1' },
    onOpen: id => opened.push(id),
  })
  const buttons = findAll(drawn.tree, n => n.type === 'Button')
  expect(buttons.map(b => [b.props.key, b.props.hotkey])).toEqual([
    ['agent-a1', '1'],
    ['agent-a2', '2'],
    ['agent-a4', '3'],
    ['agent-a3', '4'],
  ])
  ;(buttons[1]?.props.onPress as () => void)()
  expect(opened).toEqual(['a2'])
  const lines = linesOf(drawn.tree)
  // The Button's `1: ` takes the cells the row reserved: the frame stays whole.
  expectExact(lines, 56)
  expect(lines).toContain('│ 1: ● developer    Sonnet 5.5 · hi… ▶▱▱▱▱▱       3:12 │')
  expect(lines).toContain('│ 2: ● code-reader  Haiku 5.5 · med… ▶            0:21 │')
  expect(lines).toContain('│ 3: ✗ research     ✗         2:00 failed · max_tokens │')
  // The frame is drawn outside the Button.
  const row = findAll(drawn.tree, n => n.type === 'Box' && n.kids.some(k => typeof k !== 'string' && k.type === 'Button' && k.props.key === 'agent-a1'))[0] as Node
  expect(textOf(row.kids[0] as Node)).toBe('│ ')
  expect(textOf(row.kids[2] as Node)).toBe(' │')
  expect(textOf(row.kids[1] as Node).startsWith('1: ● developer')).toBe(true)
  for (const width of [57, 66, 48]) {
    const wide = drawPane(fakes({ button: true }), busy(), CTX, { width, rows: 200, surface: 'terminal', colors: 'theme', motion: false, focus: { isFocused: true, openId: null }, onOpen: () => {} })
    expectExact(linesOf(wide.tree), width)
  }
  // The desktop's rows keep the content width too.
  const desk = drawPane(fakes({ button: true }), busy(), CTX, { width: 72, rows: 200, surface: 'desktop', colors: 'theme', motion: false, focus: { isFocused: true, openId: null }, onOpen: () => {} })
  for (const box of findAll(desk.tree, n => n.props.borderStyle === 'round')) for (const kid of box.kids.slice(1)) expect(cellWidth(textOf(kid))).toBe(68)
  expect(lines).toContain('│   ┆ T2: contract injection point: //go:build         │')
  expect(lines).toContain('│   ┆ Sonnet 5.5 · high · 1 step · 0 out               │')
  expect(lines).toContain('│   ┆ · Edit internal/config/contract_on.go            │')
  expect(lines).toContain('│ 1-9 details (again to close)                         │')
  // Unfocused: no buttons, no footer.
  const plain = linesOf(drawPane(fakes({ button: true }), busy(), CTX, { width: 56, rows: 200, surface: 'terminal', colors: 'theme', motion: false }).tree)
  expect(plain.join('\n')).not.toContain('1-9 details')
})

// ------------------------------------------------------------------ exact widths

test('every row of every surface is exactly its width, at 56/57/60/66 and narrow', () => {
  const inputs = [busy(), fresh(), busy({ plan: { name: 'gone', parsed: null } }), busy({ quota: quota({ codexState: 'down' }) })]
  for (const input of inputs) {
    for (const width of [56, 57, 60, 66, 52, 50, 48, 44, 40]) {
      for (const rows of [200, 40, 25, 12]) expectExact(texts(pane(input, CTX, width, rows).rows), width)
      for (const form of ['mini', 'band'] as const) expectExact(summaryLines(input, CTX, { width, form, maxRows: 12 }).map(lineText), width)
    }
  }
})

test('extra columns from 57 to 66 go to the text columns; fixed columns keep their place', () => {
  const at = (width: number) => texts(pane(busy(), CTX, width).rows)
  const r56 = at(56).find(l => l.includes('↳ T2'))
  const r66 = at(66).find(l => l.includes('↳ T2'))
  expect(r56).toBe('│   ↳ T2 contract injection point: //go:build contrac… │')
  expect(r66).toBe('│   ↳ T2 contract injection point: //go:build contract files     │')
  // The elapsed column stays at the right edge.
  expect(at(66).find(l => l.includes('● developer'))?.endsWith('       3:12 │')).toBe(true)
  // At 66 the finished rows gain a model column.
  expect(at(66).find(l => l.includes('tester·cx'))).toContain('GPT-6 Ast…')
  expect(at(56).find(l => l.includes('tester·cx'))).not.toContain('GPT-6')
})

test('narrow docked widths drop the job strip, then the effort and the plan owner; Quota keeps its heading', () => {
  const at48 = texts(pane(busy(), CTX, 48).rows)
  expect(at48.find(l => l.includes('● developer'))).toBe('│ ● developer    Sonnet 5.5 · high        3:12 │')
  expect(at48.find(l => l.includes('◇ T3'))).toBe('│ now     ◇ T3  contract suite proxy…       QA │')
  const at44 = texts(pane(busy(), CTX, 44).rows)
  expect(at44.find(l => l.includes('● developer'))).toBe('│ ● developer    Sonnet 5.5           3:12 │')
})

test('a docked pane of 47 or 48 columns keeps the Quota heading with each provider\'s state; gauges and resets give way', () => {
  // The width a 277-column terminal gave the dock live: the heading must still say Claude is waiting, Codex stale or down.
  expect(quotaRows(quota({ claude: null, claudeAt: null }), { ...CTX, claudeMeasured: false }, 48)).toEqual([
    '│     Claude · waiting ◆   Codex        resets │',
    '│ 5h  ╌╌╌╌╌╌    —          ▰▱▱▱▱▱  12%   4h05m │',
    '│ 7d  ╌╌╌╌╌╌    —          ▰▰▱▱▱▱  38%    6d1h │',
    '│ → Claude favored: no Claude plan limits      │',
  ])
  expect(quotaRows(quota({ claude: null, claudeAt: null }), { ...CTX, claudeMeasured: false }, 47)[0]).toBe('│     Claude · waiting ◆  Codex        resets │')
  expect(quotaRows(quota({ codexState: 'stale', codexObservedAt: NOW - 18 * MIN }), CTX, 47)[0]).toBe('│     Claude ◆    resets  Codex · 18m old     │')
  expect(quotaRows(quota({ codexState: 'down' }), CTX, 47)[0]).toBe('│     Claude ◆    resets  Codex · proxy down  │')
  expect(quotaRows(quota({ codex: null, codexState: 'off' }), BARE, 47)).toEqual([
    '│     Claude                           resets │',
    '│ 5h  ▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱  41%   2h10m │',
    '│ 7d  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱  71%!   3d4h │',
  ])
})

// ------------------------------------------------------------------ cards: Session

test('Session: fresh, typical, compacted, idle receipts', () => {
  const lines = texts(pane(fresh(), BARE).rows)
  expect(lines.slice(0, 7)).toEqual([
    ' CREW                                              14:32',
    '╭─ Session ────────────────────────────────────────────╮',
    '│ Opus 5.5 · high effort                        ○ idle │',
    '│ ctx —                                                │',
    '│ $0.00  in 0  out 0                           up 0:00 │',
    '│ no turn finished yet                                 │',
    '╰──────────────────────────────────────────────────────╯',
  ])
  let s = sessionCompacted(sessionCompacted(workingSession()))
  s = turnEnded(s, { now: NOW, reason: 'answer' })
  const idle = texts(pane(busy({ session: s })).rows)
  expect(idle).toContain('│ $4.12  in 1.2M 92% cached  out 84k        ⟲2 up 1:12 │')
  expect(idle).toContain('│ ✓ last turn 0:42 · +$0.00 · in 1.2M · out 84k        │')
  const stopped = texts(pane(busy({ session: turnEnded(workingSession(), { now: NOW, reason: 'aborted' }) })).rows)
  expect(stopped).toContain('│ ✗ last turn 0:42 · stopped · +$0.00 · in 1.2M        │')
  // A context at 85% or more: red and `!!`.
  const hot = texts(pane(busy({ session: sessionMeasured(workingSession(), { tokens: 180_000 }) })).rows)
  expect(hot).toContain(`│ ctx ${'▰'.repeat(27)}${'▱'.repeat(3)} 90%!!   180k/200k │`)
  const tone = spansOf(pane(busy({ session: sessionMeasured(workingSession(), { tokens: 180_000 }) })).rows, '90%').find(x => x.text.includes('90%'))
  expect(tone?.tone).toBe('bad')
})

// ------------------------------------------------------------------ cards: Quota states

const quotaRows = (q: Quota, ctx = CTX, width = 56) => {
  const lines = texts(pane(busy({ quota: q }), ctx, width).rows)
  const start = lines.findIndex(l => l.startsWith('╭─ Quota'))
  const end = lines.findIndex((l, i) => i > start && l.startsWith('╰'))
  return lines.slice(start + 1, end)
}

test('Quota: Codex not known yet: faint unknown gauges, a dash, no resets heading, Claude favored', () => {
  expect(quotaRows(quota({ codex: null, codexState: 'unknown' }))).toEqual([
    '│     Claude ◆         resets  Codex · not known yet   │',
    '│ 5h  ▰▰▰▰▱▱▱▱▱▱  41%   2h10m  ╌╌╌╌╌╌╌╌╌╌    —         │',
    '│ 7d  ▰▰▰▰▰▰▰▱▱▱  71%!   3d4h  ╌╌╌╌╌╌╌╌╌╌    —         │',
    '│ → Claude favored: Codex quota not known yet          │',
  ])
})

test('Quota: stale Codex dims its last values and names its age; countdowns still run', () => {
  const rows = pane(busy({ quota: quota({ codexState: 'stale', codexObservedAt: NOW - 18 * MIN }) })).rows
  const lines = texts(rows)
  expect(lines).toContain('│     Claude ◆         resets  Codex · 18m old  resets │')
  expect(lines).toContain('│ 5h  ▰▰▰▰▱▱▱▱▱▱  41%   2h10m  ▰▱▱▱▱▱▱▱▱▱  12%   4h05m │')
  const codexSpans = spansOf(rows, '5h  ').slice(-7, -1)
  expect(codexSpans.every(s => s.dim === true)).toBe(true)
  expect(lines).toContain('│ → Claude favored: Codex quota is stale               │')
})

test('Quota: the proxy is down: last values dimmed, no resets, and "Claude only"', () => {
  expect(quotaRows(quota({ codexState: 'down' }))).toEqual([
    '│     Claude ◆         resets  Codex · proxy down      │',
    '│ 5h  ▰▰▰▰▱▱▱▱▱▱  41%   2h10m  ▰▱▱▱▱▱▱▱▱▱  12%         │',
    '│ 7d  ▰▰▰▰▰▰▰▱▱▱  71%!   3d4h  ▰▰▰▰▱▱▱▱▱▱  38%         │',
    '│ → Claude only: Codex proxy is down                   │',
  ])
})

test('Quota: Claude waiting for its first reading, Claude with no plan limits, and a passed reset', () => {
  expect(quotaRows(quota({ claude: null, claudeAt: null }), { ...CTX, claudeMeasured: false })[0]).toBe('│     Claude · waiting ◆       Codex            resets │')
  const billed = quotaRows(quota({ claude: null, claudeAt: null, codex: null, codexState: 'off' }), BARE)
  expect(billed).toEqual(['│     Claude · no plan limits                          │'])
  const passed = quotaRows(quota({ codex: { fiveHour: { percentUsed: 99, resetsAt: iso(NOW - MIN) }, sevenDay: win(38, 600) } }))
  expect(passed[1]).toBe('│ 5h  ▰▰▰▰▱▱▱▱▱▱  41%   2h10m  ╌╌╌╌╌╌╌╌╌╌    —   reset │')
})

test('Quota: Claude only (no twins, no proxy): 30-cell gauges, no Codex block', () => {
  expect(quotaRows(quota({ codex: null, codexState: 'off' }), BARE)).toEqual([
    '│     Claude                                    resets │',
    '│ 5h  ▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱  41%        2h10m │',
    '│ 7d  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱  71%!        3d4h │',
  ])
})

test('Quota: routing off leaves out the favored row and the ◆', () => {
  const rows = quotaRows(quota(), { ...CTX, routing: false })
  expect(rows).toEqual([
    '│     Claude           resets  Codex            resets │',
    '│ 5h  ▰▰▰▰▱▱▱▱▱▱  41%   2h10m  ▰▱▱▱▱▱▱▱▱▱  12%   4h05m │',
    '│ 7d  ▰▰▰▰▰▰▰▱▱▱  71%!   3d4h  ▰▰▰▰▱▱▱▱▱▱  38%    6d1h │',
  ])
  expect(lineText(summaryLines(busy(), { ...CTX, routing: false }, { width: 56, form: 'mini', maxRows: 8 })[1] as Line)).not.toContain('→')
})

test('F7.1: a provider heading fits its 23-cell block: `resets` goes first, then the name is cut, the ◆ stays', () => {
  const d = derive(busy({ quota: quota({ claudeAt: NOW - 59 * MIN, decision: { provider: 'claude', reason: 'Codex quota is stale' } }) }), CTX)
  const claude = d.quota?.claude
  expect(claude?.header).toBe('Claude · 59m old')
  const heading = quotaHeading(claude as NonNullable<typeof claude>, 23)
  expect(lineText(heading)).toBe('Claude · 59m old ◆     ')
  expect(cellWidth(lineText(heading))).toBe(23)
  const long = quotaHeading({ ...(claude as NonNullable<typeof claude>), header: 'Claude · a very long state name' }, 23)
  expect(lineText(long)).toBe('Claude · a very long… ◆')
  // The whole card row stays 52 cells.
  const lines = texts(pane(busy({ quota: quota({ claudeAt: NOW - 59 * MIN, decision: { provider: 'claude', reason: 'x' } }) })).rows)
  expect(lines).toContain('│     Claude · 59m old ◆       Codex            resets │')
})

// ------------------------------------------------------------------ cards: Plan, S1, S2

test('Plan: typical buckets, overflow per bucket, wave footer', () => {
  const lines = texts(pane(busy()).rows)
  expect(lines).toContain('│ ▰▰▰◇▰▰▰▶▰▶······  7/16 verified · wave 3/13          │')
  expect(lines).toContain('│ now     ◇ T3  developer    contract suite…        QA │')
  expect(lines).toContain('│ waits   · R4  developer    rewrite interna…    on R1 │')
  expect(lines).toContain('│         +4 more waiting: R6, J1, R7, A1              │')
  expect(lines).toContain('│ this wave: T3 · next wave: R1, R3                    │')
})

test('Plan: unreadable, no steps, all verified, and lines not read', () => {
  const unread = texts(pane(busy({ plan: { name: 'gone', parsed: null } })).rows)
  expect(unread).toContain('│ Plan gone: the file could not be read.               │')
  const empty = texts(pane(busy({ plan: planOf('empty') })).rows)
  expect(empty).toContain('│ Plan empty: no steps in the expected form.           │')
  const done = texts(pane(busy({ plan: planOf('done', '- A1 (lead, after: —) a — state: verified', '- A2 (lead, after: A1) b — state: committed (abc)') })).rows)
  expect(done).toContain('│ ▰▰  2/2 verified                                     │')
  expect(done).toContain('│ ✓ all 2 steps verified · 1 committed                 │')
  const skipped = texts(pane(busy({ plan: planOf('odd', '- A1 (lead, after: —) a — state: queued', '- A2 (lead) b — state: done') })).rows)
  expect(skipped).toContain('│ 1 line not read                                      │')
})

test('Plan: fixes, QA and blocked rows, the S2 footer in amber, S1 for the blocked step', () => {
  const plan = planOf(
    'r',
    '- R2 (crew:developer, after: —) rewrite internal/config — state: ready for QA',
    '- R3 (crew:developer, after: —) rewrite internal/translate — state: fixes requested',
    '- R4 (crew:developer, after: —) rewrite internal/codex — state: blocked (needs Go 1.27 on CI)',
    '- R5 (crew:developer, after: R4) rewrite internal/router — state: queued',
  )
  const idle = { ...defaultSession(NOW - MIN), model: 'claude-opus-5-5', effort: 'high' }
  const rows = pane(fresh({ plan, session: idle })).rows
  const lines = texts(rows)
  expect(lines).toContain('│ now     ↺ R3  developer    rewrite interna…    fixes │')
  expect(lines).toContain('│         ◇ R2  developer    rewrite interna…       QA │')
  expect(lines).toContain('│ blocked ⊘ R4  developer    needs Go 1.27 o…  blocked │')
  expect(lines).toContain('│ waits   · R5  developer    rewrite interna…   on ⊘R4 │')
  expect(lines).toContain('│ R2 awaits QA · no tester or architect running        │')
  expect(spansOf(rows, 'R2 awaits QA').find(s => s.text.includes('awaits'))?.tone).toBe('warn')
  // S1: the amber row under the header, and first in the summary.
  expect(lines[1]).toBe(' ! Waiting on you · R4 blocked: needs Go 1.27 on CI'.padEnd(56))
  expect(lineText(summaryLines(fresh({ plan, session: idle }), BARE, { width: 56, form: 'mini', maxRows: 8 })[0] as Line).trimEnd()).toBe('! Waiting on you · R4 blocked: needs Go 1.27 on CI')
  // A tester running closes the gap.
  const tested = agentSpawned([], { id: 't', type: 'crew:tester', description: 'R2 QA', now: NOW - MIN })
  expect(texts(pane(fresh({ plan, session: idle, agents: tested })).rows).join('\n')).not.toContain('awaits QA · no tester')
})

test('S1 for steps ready and for a pending permission ask', () => {
  const plan = planOf('r', '- T3 (crew:developer, after: —) a — state: queued', '- R1 (crew:developer, after: —) b — state: queued', '- R2 (crew:tester, after: —) c — state: queued')
  const idle = defaultSession(NOW)
  expect(texts(pane(fresh({ plan, session: idle })).rows)[1]?.trimEnd()).toBe(' ! Waiting on you · 3 steps ready: T3, R1, R2')
  const asking = askOpened(workingSession(), { id: 'q', who: 'developer', tool: 'Bash' })
  expect(texts(pane(busy({ session: asking })).rows)[1]?.trimEnd()).toBe(' ! Waiting on you · developer asks to run Bash')
  expect(texts(pane(busy()).rows)[1]?.startsWith('╭─ Session')).toBe(true)
})

test('F7.2: an agent links to a step only when the plan holds that id', () => {
  const card = agentSpawned([], { id: 'm', type: 'crew:developer', description: 'API2 migration notes', now: NOW - MIN })
  expect(card[0]?.stepId).toBe('API2')
  expect(linkedStep(card[0] as AgentCard, new Set(['T1']))).toBeNull()
  expect(linkedStep(card[0] as AgentCard, new Set(['API2']))).toBe('API2')
  const unlinked = pane(busy({ agents: card, plan: planOf('p', '- T1 (lead, after: —) a — state: queued') })).rows
  const row = spansOf(unlinked, '↳')
  expect(lineText(row)).toBe('│   ↳ API2 migration notes                             │')
  expect(row.some(s => s.bold && s.text === 'API2')).toBe(false)
  const linked = spansOf(pane(busy({ agents: card, plan: planOf('p', '- API2 (lead, after: —) a — state: implementing') })).rows, '↳')
  expect(linked.some(s => s.bold && s.text === 'API2')).toBe(true)
  // `T2:` is folded into `T2` only when T2 is a step.
  const t2 = agentSpawned([], { id: 'x', type: 'crew:developer', description: 'T2: contract injection', now: NOW - MIN })
  expect(texts(pane(busy({ agents: t2, plan: planOf('p', '- T1 (lead, after: —) a — state: queued') })).rows)).toContain('│   ↳ T2: contract injection                           │')
  expect(texts(pane(busy({ agents: t2, plan: planOf('p', '- T2 (lead, after: —) a — state: implementing') })).rows)).toContain('│   ↳ T2 contract injection                            │')
  // And in the summary.
  const mini = summaryLines(busy({ agents: card, plan: planOf('p', '- T1 (lead, after: —) a — state: queued') }), CTX, { width: 56, form: 'mini', maxRows: 8 }).map(lineText)
  expect(mini.some(l => l.includes('● developer    API2 migration notes'))).toBe(true)
})

test('a plan step shows the linked agent clock, or `✗ failed` when it failed while the file still says implementing', () => {
  const plan = planOf('p', '- T2 (crew:developer, after: —) contract — state: implementing')
  const rows = pane(busy({ plan })).rows
  expect(texts(rows)).toContain('│ now     ▶ T2  developer    contract             3:12 │')
  expect(spansOf(rows, '▶ T2').find(s => s.live)?.live).toMatchObject({ key: 'plan-T2', since: NOW - 192_000, width: 8 })
  const failed = agentCompleted(busyAgents(), { id: 'a1', reason: 'error', now: NOW })
  expect(texts(pane(busy({ plan, agents: failed })).rows)).toContain('│ now     ▶ T2  developer    contract         ✗ failed │')
})

// ------------------------------------------------------------------ cards: agents, Review, timeline, Log

test('Agents · running: empty states, a denial in red, a -codex twin, overflow at level 7', () => {
  expect(texts(pane(fresh()).rows)).toContain('│ No agents yet; delegated work shows here.            │')
  const ended = agentCompleted(agentSpawned([], { id: 'e', type: 'crew:developer', description: 'x', now: NOW - 5 * MIN }), { id: 'e', reason: 'answer', now: NOW - 2 * MIN })
  expect(texts(pane(fresh({ agents: ended })).rows)).toContain('│ Nothing running · last agent ended 2 min ago         │')
  let twin = agentSpawned([], { id: 'cx', type: 'crew:developer-codex', description: 'R3 typed structs', model: 'gpt-6-astra', effort: 'high', now: NOW - 30_000 })
  twin = agentDenied(twin, 'cx', 'Bash git push')
  const rows = pane(busy({ agents: twin })).rows
  expect(texts(rows)).toContain('│ ● developer·cx GPT-6 Astra · high  ▶            0:30 │')
  expect(texts(rows)).toContain('│     ✗ denied Bash git push                           │')
  expect(spansOf(rows, 'denied').find(s => s.text.includes('denied'))?.tone).toBe('bad')
  // Many agents on a short pane: one row kept, the rest counted.
  let many: AgentCard[] = []
  for (let i = 0; i < 6; i++) many = agentSpawned(many, { id: `m${i}`, type: 'crew:developer', description: `job ${i}`, now: NOW - (10 - i) * MIN })
  const short = pane(busy({ agents: many, consults: [] }), CTX, 56, 12)
  expect(short.layout.level).toBe(7)
  expect(texts(short.rows)).toContain('│ +5 more running                                      │')
  expect(texts(short.rows).some(l => l.includes('job 0') || l.includes('● developer'))).toBe(true)
})

test('Agents · finished: one row per type, failed and stopped wording, a twin, +N more types', () => {
  let a: AgentCard[] = []
  const types = ['crew:developer', 'crew:tester-codex', 'crew:research', 'crew:designer', 'crew:code-reader', 'crew:architect-codex', 'general-purpose']
  types.forEach((type, i) => {
    a = agentSpawned(a, { id: `f${i}`, type, description: `job ${i}`, now: NOW - (20 - i) * MIN })
    a = agentCompleted(a, { id: `f${i}`, reason: i === 2 ? 'error' : i === 3 ? 'aborted' : 'answer', now: NOW - (19 - i) * MIN })
  })
  const lines = texts(pane(busy({ agents: a, consults: [] })).rows)
  expect(lines).toContain('│ ■ designer     ▪         1:00 stopped · job 3        │')
  expect(lines).toContain('│ ✗ research     ✗         1:00 failed · error         │')
  expect(lines).toContain('│ ✓ architect·cx ▰         1:00 job 5                  │')
  expect(lines).toContain('│ ✓ general-pur… ▰         1:00 job 6                  │')
  expect(lines).toContain('│ +2 more types                                        │')
  expect(lines.find(l => l.startsWith('╭─ Agents · finished'))).toContain('Agents · finished 7')
})

test('Review: newest first, verdict glyphs and tones, consulting, unclassified and empty answers', () => {
  let c = consults()
  c = consultStarted(c, { id: 'c4', type: 'crew:architect', description: 'T5 gate', now: NOW - 30 * MIN })
  c = consultEnded(c, { id: 'c4', now: NOW - 29 * MIN, answer: 'Reject: the suite misses the lock' })
  const rows = pane(busy({ consults: c })).rows
  const lines = texts(rows)
  expect(lines).toContain('│ ● 14:30 architect    consulting · 1:12 · T2 approach │')
  expect(lines).toContain('│ ↺ 14:23 architect·cx Fixes: keepalive test races on… │')
  expect(lines).toContain('│ ✓ 14:20 architect    Approve: T1 module path is cle… │')
  expect(lines.some(l => l.includes('Reject'))).toBe(false)
  expect(lines.find(l => l.startsWith('╭─ Review'))).toContain('Review 4')
  expect(spansOf(rows, 'Approve:')[1]).toMatchObject({ text: '✓ ', tone: 'ok' })
  expect(spansOf(rows, 'Fixes:')[1]).toMatchObject({ text: '↺ ', tone: 'warn' })
  const rejected = pane(busy({ consults: consultEnded(consultStarted([], { id: 'r', type: 'crew:architect', description: 'x', now: NOW - MIN }), { id: 'r', now: NOW, answer: 'Reject: no' }) })).rows
  expect(spansOf(rejected, 'Reject:')[1]).toMatchObject({ text: '✗ ', tone: 'bad' })
  const loose = consultEnded(consultStarted([], { id: 'u', type: 'advisor', description: 'x', now: NOW - MIN }), { id: 'u', now: NOW, answer: 'Looks fine to me' })
  expect(texts(pane(busy({ consults: loose })).rows)).toContain('│ » 14:31 advisor      Looks fine to me                │')
  const mute = consultEnded(consultStarted([], { id: 'm', type: 'crew:architect', description: 'x', now: NOW - MIN }), { id: 'm', now: NOW })
  expect(texts(pane(busy({ consults: mute })).rows)).toContain('│ » 14:31 architect    ended without an answer         │')
  expect(titles(texts(pane(busy({ consults: [] })).rows))).not.toContain('Review 0')
})

test('Last 15 minutes: absent before the first agent, lanes in role order with twins apart, the axis', () => {
  expect(titles(texts(pane(fresh()).rows))).not.toContain('Last 15 minutes')
  const lines = texts(pane(busy()).rows)
  const start = lines.findIndex(l => l.startsWith('╭─ Last 15'))
  const lanes = lines.slice(start + 1, start + 9).map(l => l.slice(2, 14).trim())
  expect(lanes).toEqual(['lead', 'code-reader', 'research', 'developer', 'tester·cx', 'architect', 'architect·cx', ''])
  expect(lines[start + 3]).toBe('│ research     ··············━━━✗············ ×1    2m │')
})

test('Log: empty, newest at the bottom, 10 rows at level 0, `you`/`plan` in amber, failures in red', () => {
  expect(texts(pane(fresh()).rows)).toContain('│ Nothing logged yet.                                  │')
  let log = logged([], promptLine('first', NOW - 20 * MIN))
  for (let i = 0; i < 14; i++) log = logged(log, { at: NOW - (14 - i) * MIN, who: i === 13 ? 'research' : 'plan', kind: i === 13 ? 'failed' : 'plan', text: i === 13 ? '✗ failed · max_tokens' : `T${i} queued → implementing`, ...(i === 13 ? { type: 'crew:research' } : {}) })
  const rows = pane(busy({ log })).rows
  const lines = texts(rows)
  const start = lines.findIndex(l => l.startsWith('╭─ Log'))
  const body = lines.slice(start + 1, lines.findIndex((l, i) => i > start && l.startsWith('╰')))
  expect(body).toHaveLength(10)
  expect(body[9]).toBe('│ 14:31:00 research     ✗ failed · max_tokens          │')
  expect(spansOf(rows, 'T4 queued').find(s => s.text.startsWith('plan'))?.tone).toBe('warn')
  expect(spansOf(rows, 'max_tokens').find(s => s.text.includes('max_tokens'))?.tone).toBe('bad')
})

test('a section that throws is one red row and the others still draw', () => {
  const broken = busy({ quota: {} as Quota })
  const drawn = drawPane(fakes(), broken, CTX, { width: 56, rows: 200, surface: 'terminal', colors: 'theme', motion: false })
  const lines = linesOf(drawn.tree)
  expect(drawn.errors).toEqual(['quota'])
  expect(lines).toContain('│ Quota could not be drawn; see the debug log.         │')
  expect(titles(lines)).toContain('Agents · running 2')
  expectExact(lines, 56)
  // The summary leaves the broken item out.
  expect(summaryLines(broken, CTX, { width: 56, form: 'mini', maxRows: 8 }).map(lineText)[0]?.startsWith('● working')).toBe(true)
})

// ------------------------------------------------------------------ the degradation ladder

test('the ladder: each level drops what the spec says, and the chosen level fits the rows', () => {
  const input = busy()
  const levels = [200, 64, 56, 45, 40, 27, 19, 12].map(rows => {
    const { layout, rows: drawn } = pane(input, CTX, 56, rows)
    if (layout.level < 7) expect(drawn.length).toBeLessThanOrEqual(rows)
    return { rows, level: layout.level, lines: texts(drawn) }
  })
  expect(levels.map(l => l.level)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  const of = (level: number) => (levels.find(l => l.level === level) as { lines: string[] }).lines
  expect(of(0).join('\n')).toContain('▶ run ▰ done')
  expect(of(1).join('\n')).not.toContain('▶ run ▰ done')
  expect(titles(of(1))).toContain('Log')
  expect(titles(of(2))).not.toContain('Log')
  expect(titles(of(2))).toContain('Last 15 minutes')
  expect(titles(of(3))).not.toContain('Last 15 minutes')
  expect(titles(of(3))).toContain('Agents · finished 2')
  // Level 4: finished inline under the running card, the quota without its heading row.
  expect(titles(of(4))).not.toContain('Agents · finished 2')
  expect(of(4)).toContain('│ done: research ✗ · tester·cx ▰                       │')
  expect(of(4).some(l => l.includes('resets'))).toBe(false)
  expect(of(4).some(l => l.startsWith('│ 7d Claude'))).toBe(true)
  // Level 5: no rails, no activity row, Review one row, Plan strip + first now + first next.
  expect(of(5).some(l => l.startsWith('  ─'))).toBe(false)
  expect(of(5).some(l => l.includes('Edit internal/config'))).toBe(false)
  expect(of(5).filter(l => /^│ [●✓↺»✗] \d\d:\d\d/.test(l))).toHaveLength(1)
  expect(of(5).filter(l => /^│ (now|next|waits|blocked)?\s+[▶◇↺▱·⊘] /.test(l))).toHaveLength(1)
  // Level 6: one-line Session, Quota and Plan; one row per agent.
  expect(of(6)).toContain('│ Opus 5.5 · high effort  ● working  ctx 64%     $4.12 │')
  expect(of(6)).toContain('│ 7d Claude ▰▰▰▰▰▰▱▱ 71%! · Codex ▰▰▰▱▱▱▱▱ 38% → Codex │')
  expect(of(6).some(l => l.startsWith('│ plan 7/16'))).toBe(true)
  expect(of(6).some(l => l.includes('↳'))).toBe(false)
  // Level 7: Review and Plan go first; Session and the first running row stay.
  // Plan outranks Quota (spec 6, 7: "the plan is compressed, never dropped"); the header goes before both.
  expect(titles(of(7))).toEqual(['Session', 'Plan · proxy-rewrite', 'Agents · running 2'])
  expect(of(7)[0]?.startsWith('╭─ Session')).toBe(true)
  expect(of(7)).toContain('│ +1 more running                                      │')
  const tiny = texts(pane(input, CTX, 56, 5).rows)
  expect(tiny).toHaveLength(5)
  expect(tiny[1]).toContain('Opus 5.5')
  expect(tiny[4]).toContain('● developer')
  for (const l of levels) expectExact(l.lines, 56)
})

test('levelPlan and the terminal rows agree: rails only below level 5', () => {
  const d = paneLayout(busy(), CTX, { width: 56, rows: 200, surface: 'terminal' })
  expect(levelPlan(d.level).rails).toBe(true)
  expect(terminalRows(d).filter(r => r.rail).map(r => r.rail?.section)).toEqual(['plan', 'running', 'review', 'finished', 'timeline', 'log'])
})

test('the desktop picks its level from its own rows (boxes and gaps, no rails)', () => {
  const tall = drawPane(fakes(), busy(), CTX, { width: 72, rows: 200, surface: 'desktop', colors: 'theme', motion: false })
  const short = drawPane(fakes(), busy(), CTX, { width: 72, rows: 30, surface: 'desktop', colors: 'theme', motion: false })
  expect(tall.level).toBe(0)
  expect(short.level).toBeGreaterThan(0)
  if (short.level < 7) expect(short.height).toBeLessThanOrEqual(30)
})

// ------------------------------------------------------------------ colors, live text

test('colors: theme keys by default; the roles table in hex; anything else stored reads as theme', () => {
  expect(colorsOption(undefined)).toBe('theme')
  expect(colorsOption('pastel')).toBe('theme')
  expect(colorsOption('roles')).toBe('roles')
  const theme = paletteOf('theme')
  expect(paint({ text: 'x', tone: 'section' }, theme, 'running')).toEqual({ color: 'success' })
  expect(paint({ text: 'x', tone: 'role', role: 'developer' }, theme)).toEqual({ color: 'text', bold: true })
  expect(paint({ text: 'x', tone: 'warn' }, theme)).toEqual({ color: 'warning' })
  expect(paint({ text: 'x', tone: 'dim' }, theme)).toEqual({ dimColor: true })
  const roles = paletteOf('roles')
  expect(paint({ text: 'x', tone: 'role', role: 'developer' }, roles)).toEqual({ color: '#F0A35E' })
  expect(paint({ text: 'x', tone: 'section', section: 'plan' }, roles)).toEqual({ color: '#D9A441' })
  expect(paint({ text: 'x', tone: 'role', role: 'tester' }, paletteOf('roles', true))).toEqual({ color: '#1E7F94' })
  // A twin keeps its base role's hue.
  const rows = pane(busy({ agents: agentSpawned([], { id: 'cx', type: 'crew:tester-codex', description: 'x', now: NOW }) })).rows
  expect(spansOf(rows, 'tester·cx').find(s => s.text.startsWith('tester·cx'))?.role).toBe('tester')
  // The header chip is inverse on the lead color.
  const tree = drawPane(fakes(), fresh(), BARE, { width: 56, rows: 200, surface: 'terminal', colors: 'roles', motion: false }).tree
  expect(findAll(tree, n => n.type === 'Text' && n.kids[0] === ' CREW ')[0]?.props).toEqual({ color: '#5B93E6', bold: true, inverse: true })
})

test('live text: the clock cell ticks from the drawing time; the rail runs', () => {
  const p = { since: NOW - 59_000, now: NOW, endAt: null, width: 8, align: 'right' as const }
  expect(elapsedCell(p)).toBe('    0:59')
  expect(elapsedCell(p, 1)).toBe('    1:00')
  expect(elapsedCell({ ...p, endAt: NOW - 1000 }, 30)).toBe('    0:58')
  expect(elapsedText(NOW - 3_720_000, NOW)).toBe('1h02')
  expect(railRuns(10, null)).toEqual([{ text: '──────────', isLit: false }])
  expect(railRuns(10, 4)).toEqual([
    { text: '─', isLit: false },
    { text: '•••●', isLit: true },
    { text: '─────', isLit: false },
  ])
})

test('the timeline SVG escapes lane names and spells its alt', () => {
  const lanes = [{ key: 'x:<b>', name: '<b>&', isLead: false, cells: Array.from({ length: 30 }, (_, i) => (i === 3 ? 'failed' : i > 25 ? 'running' : 'idle')) as never, jobs: 2, busyMs: 4 * MIN }]
  const svg = timelineSvg(lanes, 52)
  expect(svg.source).toContain('&lt;b&gt;&amp;')
  expect(svg.source).not.toContain('<b>')
  expect(svg.alt).toBe('Last 15 minutes: <b>& 2 jobs, 4 minutes')
  // XML 1.0 forbids C0 controls: they become spaces.
  const odd = timelineSvg([{ ...(lanes[0] as (typeof lanes)[number]), name: 'a\u0001b\u001bc' }], 52)
  expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(odd.source)).toBe(false)
  expect(odd.source).toContain('a b c')
})

// ------------------------------------------------------------------ malformed atoms

const DRAW = { colors: 'theme', motion: false } as const
const BAND = { surface: 'terminal', hasSurvey: false, choice: { isVisible: true, placement: 'prompt' }, maxRows: 10, bodyColumns: 56, ...DRAW } as const

test('no input shape makes drawPane, drawSummary or drawBand throw: a null session or loops atom', () => {
  const shapes: Partial<HudInput>[] = [
    { session: null as never },
    { session: undefined as never },
    { session: {} as never },
    { loops: null as never },
    { loops: undefined as never },
    { agents: null as never, consults: null as never, log: null as never },
    { plan: 'x' as never, favored: 3 as never, now: Number.NaN },
    // T3: a list with a malformed element among good ones.
    { loops: [null, { id: 1 }, { id: 'l9', firstAt: NOW, lastAt: NOW, steps: 1, isDone: false }] as never },
  ]
  for (const over of shapes) {
    for (const surface of ['terminal', 'desktop'] as const) {
      const drawn = drawPane(fakes(), busy(over), CTX, { width: 56, rows: 40, surface, ...DRAW })
      expect(drawn.tree.type).toBe('Box')
    }
    const lines = linesOf(drawPane(fakes(), busy(over), CTX, { width: 56, rows: 200, surface: 'terminal', ...DRAW }).tree)
    expect(lines.some(l => l.startsWith('╭─ Agents · running'))).toBe(true)
    expect(linesOf(drawSummary(fakes(), busy(over), CTX, { width: 56, form: 'mini', maxRows: 8, ...DRAW })).length).toBeGreaterThan(0)
    expect(drawBand(fakes(), busy(over), CTX, BAND)).not.toBeNull()
  }
  // A null session draws the default one, idle.
  expect(texts(pane(busy({ session: null as never })).rows)).toContain('│ model unknown                                 ○ idle │')
  // Even a null input stays inside: the pane says so in one row, the band yields.
  const none = drawPane(fakes(), null as never, CTX, { width: 56, rows: 40, surface: 'terminal', ...DRAW })
  expect(linesOf(none.tree).length).toBeGreaterThan(0)
  expect(drawSummary(fakes(), null as never, CTX, { width: 56, form: 'mini', maxRows: 8, ...DRAW }).type).toBe('Box')
})

test('a malformed agent card drops itself only: the others still draw in the pane and the summary', () => {
  const good = busyAgents()
  for (const bad of [{ id: 'z', type: 'crew:developer', description: 'x' }, null, { id: 'y', type: 'crew:tester', description: 'y', rounds: [null] }, 'card']) {
    const input = busy({ agents: [...good, bad as never], consults: [...consults(), { id: 9 } as never] })
    const drawn = drawPane(fakes(), input, CTX, { width: 56, rows: 200, surface: 'terminal', ...DRAW })
    const lines = linesOf(drawn.tree)
    expect(drawn.errors).toEqual([])
    expect(titles(lines)).toEqual(['Session', 'Quota', 'Plan · proxy-rewrite', 'Agents · running 2', 'Review 3', 'Agents · finished 2', 'Last 15 minutes', 'Log'])
    expect(lines.some(l => l.includes('could not be drawn'))).toBe(false)
    const mini = summaryLines(input, CTX, { width: 56, form: 'mini', maxRows: 8 }).map(lineText)
    expect(mini.some(l => l.startsWith('● developer'))).toBe(true)
    expect(mini.some(l => l.startsWith('● code-reader'))).toBe(true)
  }
})

// The host's own tables fit the injected interface (checked by tsc; never called).
export const hostTablesFit = (t: Elements['terminal'], k: Elements['desktop']): HudEls<RenderElement>[] => [
  { Box: t.Box, Text: t.Text, Button: t.Button },
  { Box: k.Box, Text: k.Text, Svg: k.Svg, Button: k.Button },
]

test('the crew-harness plan draws too (external ids wait)', () => {
  const lines = texts(pane(busy({ plan: { name: 'crew-harness', parsed: parsePlan(CREW_HARNESS) } })).rows)
  expect(lines.some(l => l.includes('Plan · crew-harness'))).toBe(true)
  expectExact(lines, 56)
})

// ------------------------------------------------------------------ H2 re-audit gaps

test('T1: on a focused pane an agent row without a hotkey (the 10th and later) keeps its columns where a keyed row has them', () => {
  let agents: AgentCard[] = []
  for (let i = 1; i <= 11; i++) {
    agents = agentSpawned(agents, { id: `r${i}`, type: 'crew:developer', description: `job ${i}`, model: 'claude-sonnet-5-5', effort: 'high', now: NOW - i * 1000 })
  }
  const drawn = drawPane(fakes({ button: true }), busy({ agents, consults: [], plan: null }), CTX, {
    width: 56, rows: 400, surface: 'terminal', colors: 'theme', motion: false, focus: { isFocused: true, openId: null }, onOpen: () => {},
  })
  const lines = linesOf(drawn.tree)
  expectExact(lines, 56)
  const rows = lines.filter(l => l.includes('● developer'))
  expect(rows).toHaveLength(11)
  expect(findAll(drawn.tree, n => n.type === 'Button')).toHaveLength(9)
  const keyed = rows.filter(l => /^│ \d: /.test(l))
  const unkeyed = rows.filter(l => l.startsWith('│    ● '))
  expect([keyed.length, unkeyed.length]).toEqual([9, 2])
  // Every column starts at the same cell: the status, the model, the strip and the clock.
  const at = (l: string, text: string) => cellWidth(l.slice(0, l.indexOf(text)))
  for (const text of ['● developer', 'Sonnet 5.5']) expect(new Set(rows.map(l => at(l, text))).size).toBe(1)
  expect(new Set(rows.map(l => cellWidth(l.trimEnd())))).toEqual(new Set([56]))
})

test('T2: each entry point\'s last resort is reached: a Box constructor that throws once gives the red row, the empty column and a null band', () => {
  const throwingOnce = (): HudEls<Node> => {
    const els = fakes()
    let thrown = false
    return {
      ...els,
      Box: props => {
        if (!thrown) {
          thrown = true
          throw new Error('Box refused')
        }
        return els.Box(props)
      },
    }
  }
  const pane = drawPane(throwingOnce(), busy(), CTX, { width: 56, rows: 40, surface: 'terminal', ...DRAW })
  expect(pane.errors).toEqual(['session'])
  expect(linesOf(pane.tree)).toEqual(['Session could not be drawn; see the debug log.'.padEnd(56)])
  const desk = drawPane(throwingOnce(), busy(), CTX, { width: 72, rows: 40, surface: 'desktop', ...DRAW })
  expect(desk.errors).toEqual(['session'])

  const summary = drawSummary(throwingOnce(), busy(), CTX, { width: 56, form: 'mini', maxRows: 8, ...DRAW })
  expect(summary.type).toBe('Box')
  expect(summary.kids).toEqual([])

  expect(drawBand(throwingOnce(), busy(), CTX, BAND)).toBeNull()
  // The same input draws whole with constructors that do not throw.
  expect(drawBand(fakes(), busy(), CTX, BAND)).not.toBeNull()
  expect(drawPane(fakes(), busy(), CTX, { width: 56, rows: 40, surface: 'terminal', ...DRAW }).errors).toEqual([])
})

test('T2: an input whose getter throws reaches the same last resorts', () => {
  const input = busy()
  Object.defineProperty(input, 'agents', { get: () => { throw new Error('atom unreadable') } })
  const pane = drawPane(fakes(), input, CTX, { width: 56, rows: 40, surface: 'terminal', ...DRAW })
  expect(pane.errors).toEqual(['session'])
  expect(linesOf(pane.tree)[0]?.trim()).toBe('Session could not be drawn; see the debug log.')
  expect(drawSummary(fakes(), input, CTX, { width: 56, form: 'mini', maxRows: 8, ...DRAW }).kids).toEqual([])
  expect(drawBand(fakes(), input, CTX, BAND)).toBeNull()
})

// ------------------------------------------------------------------ agent clocks: the current job

/**
 * A developer spawned 30 min ago fails at 25 min ago; the lead sends fixes 4 min ago (a new job), which ends 3 min ago
 * and wakes for a background task 1 min ago (the same job). Its clock reads 4:00 everywhere: not 30:00 (the spawn),
 * not 1:00 (the last round).
 */
function resumedDeveloper(): AgentCard[] {
  let a = agentSpawned([], { id: 'a1', type: 'crew:developer', description: 'T3: implement the router', model: 'claude-sonnet-5-5', now: NOW - 30 * MIN })
  a = agentStepped(a, { id: 'a1', stopReason: 'max_tokens', now: NOW - 26 * MIN })
  a = agentCompleted(a, { id: 'a1', reason: 'error', now: NOW - 25 * MIN })
  a = agentMessaged(a, 'a1')
  a = agentStepped(a, { id: 'a1', usage: { input_tokens: 1 }, now: NOW - 4 * MIN })
  a = agentCompleted(a, { id: 'a1', reason: 'answer', now: NOW - 3 * MIN })
  return agentStepped(a, { id: 'a1', usage: { input_tokens: 1 }, now: NOW - MIN })
}
const RESUMED_PLAN = planOf('demo', '- T3 (crew:developer, after: —) implement the router — state: fixes requested')
const liveSince = (spans: readonly Span[]) => spans.find(sp => sp.live !== undefined)?.live?.since

test('the running card\'s clock counts the current job, as text and as the live clock', () => {
  const rows = pane(busy({ agents: resumedDeveloper(), plan: RESUMED_PLAN, consults: [], loops: [] })).rows
  const row = texts(rows).find(l => l.includes('● developer'))
  expect(row).toMatch(/ 4:00 │$/)
  expect(liveSince(spansOf(rows, '● developer'))).toBe(NOW - 4 * MIN)
})

test('the Plan\'s now row counts the linked agent\'s current job: its text and its live clock', () => {
  const agents = resumedDeveloper()
  const v = planView(RESUMED_PLAN.parsed, 'demo', { agents, now: NOW })
  expect(v.now.rows.find(r => r.step.id === 'T3')?.right).toEqual({ kind: 'elapsed', text: '4:00' })
  const rows = pane(busy({ agents, plan: RESUMED_PLAN, consults: [], loops: [] })).rows
  const planRow = texts(rows).find(l => /◇ T3|▶ T3|↺ T3|T3 /.test(l) && !l.includes('● developer') && !l.includes('↳'))
  expect(planRow).toMatch(/4:00 │$/)
  expect(liveSince(spansOf(rows, planRow?.slice(2, 20) ?? 'none'))).toBe(NOW - 4 * MIN)
})

test('the mini line\'s clock counts the current job', () => {
  const lines = summaryLines(busy({ agents: resumedDeveloper(), plan: RESUMED_PLAN, consults: [], loops: [] }), CTX, { width: 120, form: 'mini', maxRows: 8 })
  const line = lines.find(l => lineText(l).includes('● developer'))
  expect(line && lineText(line)).toMatch(/ 4:00$/)
  expect(line && liveSince(line)).toBe(NOW - 4 * MIN)
})
