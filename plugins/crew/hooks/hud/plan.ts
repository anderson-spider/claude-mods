// The plan file: the step grammar (fixed in skills/brainstorm/SKILL.md), which plan is active, and the next-steps view.
//
//   - <ID> (<owner>, after: <ids or —>) <text> — state: <state>[ (<note>)]
//
// Parsing is lenient: a line that does not parse is skipped and counted, never an error. The state is read after the last
// ` — state:`; text after the note is ignored; an id the plan does not hold is an external dependency.
import { fmtDuration, plural } from './format'
import { cellWidth, oneLine, truncate } from './width'
import { stepCell, type Cell, type StepKind } from './glyphs'
import { displayName, STEP_ID, typeInfo, shortLabel } from './roles'
import { isRunning, lastRound, runningAgents } from './state'
import type { AgentCard, Consult, LogLine, Session } from './types'

// ------------------------------------------------------------------ parser

export const STATES = ['queued', 'implementing', 'ready for QA', 'fixes requested', 'verified', 'blocked', 'committed'] as const
export type StepState = (typeof STATES)[number]

export type Step = {
  id: string
  /** `lead` or an agent type such as `crew:developer` or `crew:developer-codex`. */
  owner: string
  /** Step ids this one waits on (may name a step the plan does not hold). */
  after: string[]
  /** The text between the head and ` — state:`. */
  text: string
  state: StepState
  /** What the parentheses after the state held (a commit sha or a reason); '' when none. */
  note: string
  /** 1-based line in the file. */
  line: number
}

export type ParsedPlan = {
  steps: Step[]
  /** The numbered list under `## Waves`: the step ids found in each item. */
  waves: string[][]
  /** Lines that look like steps but did not parse. */
  skipped: number
}

const ID = STEP_ID.source
const HEAD = new RegExp(`^\\s*[-*]\\s+(${ID})\\s*\\(\\s*(lead|[a-z][a-z0-9-]*:[a-z][a-z0-9-]*)\\s*(?:,\\s*after:\\s*([^)]*))?\\)\\s*(.*)$`)
// A bullet that starts like a step: an id and a parenthesis.
const LOOKS_LIKE_STEP = new RegExp(`^\\s*[-*]\\s+${ID}\\s*\\(`)
const STATE_MARK = /\s(?:—|–|--)\s*state:\s*/gi
const STATE_WORD = /^(queued|implementing|ready for qa|fixes requested|verified|blocked|committed)(?![A-Za-z])/i
const NO_DEPENDENCY = new Set(['—', '–', '-', '--', 'none', 'n/a'])

const canonical = (word: string): StepState => STATES.find(state => state.toLowerCase() === word.toLowerCase()) as StepState

function parseAfter(raw: string | undefined): string[] {
  if (raw === undefined) return []
  const ids: string[] = []
  for (const piece of raw.split(/[,\s]+/)) {
    if (piece === '' || NO_DEPENDENCY.has(piece.toLowerCase())) continue
    if (new RegExp(`^${ID}$`).test(piece) && !ids.includes(piece)) ids.push(piece)
  }
  return ids
}

/** The note: the balanced parentheses right after the state word, or '' when none follow. */
function noteOf(rest: string): string {
  const text = rest.trimStart()
  if (!text.startsWith('(')) return ''
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(1, i).trim()
  }
  // Unbalanced: the note runs to the end of the line.
  return text.slice(1).trim()
}

function parseStep(raw: string, line: number): Step | null {
  const head = HEAD.exec(raw)
  if (!head) return null
  let last = -1
  let markLength = 0
  for (const mark of (head[4] as string).matchAll(STATE_MARK)) {
    last = mark.index as number
    markLength = mark[0].length
  }
  if (last < 0) return null
  const body = head[4] as string
  const state = STATE_WORD.exec(body.slice(last + markLength))
  if (!state) return null
  return {
    id: head[1] as string,
    owner: head[2] as string,
    after: parseAfter(head[3]),
    text: oneLine(body.slice(0, last)),
    state: canonical(state[1] as string),
    note: oneLine(noteOf(body.slice(last + markLength + state[0].length))),
    line,
  }
}

/** The step ids in a wave item: parenthesized asides ("(after T3b; …)") do not count. */
function wavesIds(item: string): string[] {
  const ids: string[] = []
  const plain = item.replace(/\([^)]*\)/g, ' ')
  for (const match of plain.matchAll(new RegExp(`(?<![A-Za-z0-9])(${ID})(?![A-Za-z0-9])`, 'g'))) {
    if (!ids.includes(match[1] as string)) ids.push(match[1] as string)
  }
  return ids
}

/** Parses a plan file. Never throws; lines inside code fences are ignored. */
export function parsePlan(text: string): ParsedPlan {
  const steps: Step[] = []
  const waves: string[][] = []
  let skipped = 0
  let fenced = false
  let inWaves = false
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw)
    if (heading) {
      inWaves = /^waves?\b/i.test(heading[1] as string)
      continue
    }
    if (inWaves) {
      const item = /^\s*\d+[.)]\s+(.*)$/.exec(raw)
      if (item) waves.push(wavesIds(item[1] as string))
      continue
    }
    if (!LOOKS_LIKE_STEP.test(raw)) continue
    const step = parseStep(raw, i + 1)
    if (step && !steps.some(s => s.id === step.id)) steps.push(step)
    else skipped++
  }
  return { steps, waves, skipped }
}

export const isDone = (step: Step): boolean => step.state === 'verified' || step.state === 'committed'

// ------------------------------------------------------------------ active plan

export type PlanCandidate = {
  path: string
  mtimeMs: number
  text: string
  /** Pinned by `/crew:panel plan <name>`. */
  pinned: boolean
  /** When the session last wrote or edited it (ms), or null. */
  writtenAt: number | null
}

export type PlanChoice = { path: string; why: 'pin' | 'written' | 'recent' }

/** A plan older than this does not become active on its own. */
export const RECENT_MS = 7 * 86_400_000

/** The plan's name: the file name without `.md`. */
export const planNameOf = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/, '')

/** Whether a tool's `file_path` is a plan file under `.crew/plans/`. */
export const isPlanPath = (path: string): boolean => /(^|\/)\.crew\/plans\/[^/]+\.md$/.test(path)

/** Whether a pin (`name` or `name.md`) names this path. */
export const pinMatches = (pin: string, path: string): boolean => planNameOf(path) === pin.replace(/\.md$/, '')

const newest = (a: PlanCandidate, b: PlanCandidate): number => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path)

/**
 * The active plan: the pinned one; else the one the session wrote or edited last; else the newest changed within 7 days
 * that still has a step not verified or committed; else none. A pin that names no candidate is ignored.
 */
export function choosePlan(candidates: readonly PlanCandidate[], now: number): PlanChoice | null {
  const pinned = candidates.filter(c => c.pinned).sort(newest)[0]
  if (pinned) return { path: pinned.path, why: 'pin' }
  const written = candidates
    .filter(c => c.writtenAt !== null)
    .sort((a, b) => (b.writtenAt as number) - (a.writtenAt as number) || newest(a, b))[0]
  if (written) return { path: written.path, why: 'written' }
  const recent = candidates
    .filter(c => now - c.mtimeMs <= RECENT_MS)
    .sort(newest)
    .find(c => parsePlan(c.text).steps.some(step => !isDone(step)))
  return recent ? { path: recent.path, why: 'recent' } : null
}

// ------------------------------------------------------------------ view

export type Bucket = 'now' | 'next' | 'waits' | 'blocked' | 'done'

/** What a step is right now: its glyph kind and bucket. */
export function kindOf(step: Step, byId: ReadonlyMap<string, Step>): { kind: StepKind; bucket: Bucket } {
  switch (step.state) {
    case 'verified':
    case 'committed':
      return { kind: 'done', bucket: 'done' }
    case 'implementing':
      return { kind: 'implementing', bucket: 'now' }
    case 'ready for QA':
      return { kind: 'qa', bucket: 'now' }
    case 'fixes requested':
      return { kind: 'fixes', bucket: 'now' }
    case 'blocked':
      return { kind: 'blocked', bucket: 'blocked' }
    default: {
      const waiting = step.after.some(id => {
        const dep = byId.get(id)
        return dep === undefined || !isDone(dep)
      })
      return waiting ? { kind: 'waits', bucket: 'waits' } : { kind: 'next', bucket: 'next' }
    }
  }
}

/** The right column: `kind` says what it is so the drawing can color it. */
export type Right = { kind: 'elapsed' | 'qa' | 'fixes' | 'failed' | 'ready' | 'on' | 'blocked' | 'none'; text: string }

export type StepRow = {
  step: Step
  kind: StepKind
  /** The owner as a column: `developer`, `developer·cx`, `lead`. */
  owner: string
  /** The short label (or, for a blocked step with a note, the note). */
  label: string
  right: Right
}

export type Group = { rows: StepRow[]; more: number; moreIds: string[] }

export type PlanView = {
  name: string
  total: number
  /** Verified or committed. */
  done: number
  committed: number
  allDone: boolean
  /** One cell per step in file order, or a 30-cell gauge beyond 30 steps. */
  strip: Cell[]
  waveNo: number | null
  waveCount: number
  /** The current wave's steps still to do, and the next wave's. */
  thisWave: string[]
  nextWave: string[]
  now: Group
  blocked: Group
  next: Group
  waits: Group
  /** Every step by bucket, uncapped, in file order (for S1 and S2). */
  lists: { fixes: Step[]; qa: Step[]; implementing: Step[]; blocked: Step[]; ready: Step[]; waits: Step[] }
  skipped: number
}

export const CAPS = { now: 3, blocked: 2, next: 2, waits: 2 } as const
const STRIP_CELLS = 30

function waitsText(step: Step, byId: ReadonlyMap<string, Step>): string {
  const pending = step.after.filter(id => {
    const dep = byId.get(id)
    return dep === undefined || !isDone(dep)
  })
  const stuck = pending.find(id => byId.get(id)?.state === 'blocked')
  if (stuck !== undefined) return `on ⊘${stuck}`
  const first = pending[0]
  if (first === undefined) return ''
  if (pending.length === 1) return `on ${first}`
  const two = `on ${pending.slice(0, 2).join(' ')}`
  if (pending.length === 2 && two.length <= 8) return two
  return `on ${first} +${pending.length - 1}`
}

function group(rows: StepRow[], cap: number): Group {
  return { rows: rows.slice(0, cap), more: Math.max(0, rows.length - cap), moreIds: rows.slice(cap).map(r => r.step.id) }
}

function stripOf(steps: readonly Step[], kinds: readonly { kind: StepKind }[]): Cell[] {
  if (steps.length <= STRIP_CELLS) return kinds.map(k => stepCell(k.kind))
  const total = steps.length
  const done = steps.filter(isDone).length
  const active = kinds.filter(k => k.kind === 'implementing' || k.kind === 'qa' || k.kind === 'fixes').length
  const doneCells = Math.round((done / total) * STRIP_CELLS)
  const activeCells = Math.min(STRIP_CELLS - doneCells, active > 0 ? Math.max(1, Math.round((active / total) * STRIP_CELLS)) : 0)
  return Array.from({ length: STRIP_CELLS }, (_, i): Cell =>
    i < doneCells
      ? { glyph: '▰', tone: 'ok' }
      : i < doneCells + activeCells
        ? { glyph: '▰', tone: 'warn' }
        : { glyph: '▱', tone: 'dim' },
  )
}

export type ViewContext = { agents: readonly AgentCard[]; now: number }

function rightOf(row: { step: Step; kind: StepKind; bucket: Bucket }, byId: ReadonlyMap<string, Step>, ctx: ViewContext): Right {
  const { step, bucket } = row
  if (bucket === 'next') return { kind: 'ready', text: 'ready' }
  if (bucket === 'waits') return { kind: 'on', text: waitsText(step, byId) }
  if (bucket === 'blocked') return { kind: 'blocked', text: 'blocked' }
  const linked = ctx.agents.filter(card => card.stepId === step.id)
  const running = linked.filter(isRunning).sort((a, b) => a.spawnedAt - b.spawnedAt)[0]
  if (running) {
    const round = lastRound(running)
    return { kind: 'elapsed', text: fmtDuration(ctx.now - (round?.startedAt ?? running.spawnedAt)) }
  }
  const latest = [...linked].sort((a, b) => b.spawnedAt - a.spawnedAt)[0]
  if (latest && lastRound(latest)?.status === 'failed' && (step.state === 'implementing' || step.state === 'fixes requested')) {
    return { kind: 'failed', text: '✗ failed' }
  }
  if (step.state === 'ready for QA') return { kind: 'qa', text: 'QA' }
  if (step.state === 'fixes requested') return { kind: 'fixes', text: 'fixes' }
  return { kind: 'none', text: '' }
}

/** The next-steps view of a parsed plan: progress, waves, and the steps by group with their caps. */
export function planView(plan: ParsedPlan, name: string, ctx: ViewContext): PlanView {
  const byId = new Map(plan.steps.map(step => [step.id, step]))
  const classified = plan.steps.map(step => ({ step, ...kindOf(step, byId) }))
  const rows = classified.map(
    (c): StepRow & { bucket: Bucket } => ({
      step: c.step,
      kind: c.kind,
      bucket: c.bucket,
      owner: displayName(c.step.owner),
      label: c.bucket === 'blocked' && c.step.note !== '' ? c.step.note : shortLabel(c.step.text),
      right: rightOf(c, byId, ctx),
    }),
  )
  const inBucket = (bucket: Bucket) => rows.filter(r => r.bucket === bucket)
  const nowRows = inBucket('now')
  const order: StepKind[] = ['fixes', 'qa', 'implementing']
  const nowSorted = order.flatMap(kind => nowRows.filter(r => r.kind === kind))

  const done = plan.steps.filter(isDone).length
  const open = (wave: readonly string[]) => wave.filter(id => byId.has(id) && !isDone(byId.get(id) as Step))
  const at = plan.waves.findIndex(wave => open(wave).length > 0)
  const after = at < 0 ? -1 : plan.waves.findIndex((wave, i) => i > at && open(wave).length > 0)
  const of = (kind: StepKind) => plan.steps.filter((_, i) => classified[i]?.kind === kind)

  return {
    name,
    total: plan.steps.length,
    done,
    committed: plan.steps.filter(s => s.state === 'committed').length,
    allDone: plan.steps.length > 0 && done === plan.steps.length,
    strip: stripOf(plan.steps, classified),
    waveNo: at < 0 ? null : at + 1,
    waveCount: plan.waves.length,
    thisWave: at < 0 ? [] : open(plan.waves[at] as string[]),
    nextWave: after < 0 ? [] : open(plan.waves[after] as string[]),
    now: group(nowSorted, CAPS.now),
    blocked: group(inBucket('blocked'), CAPS.blocked),
    next: group(inBucket('next'), CAPS.next),
    waits: group(inBucket('waits'), CAPS.waits),
    lists: {
      fixes: of('fixes'),
      qa: of('qa'),
      implementing: of('implementing'),
      blocked: of('blocked'),
      ready: of('next'),
      waits: of('waits'),
    },
    skipped: plan.skipped,
  }
}

/** `+4 more waiting: R1, R2` style overflow text, ids cut to `width` cells (the draw adds the prefix). */
export function overflowText(label: string, group: Group, width: number): string {
  if (group.more === 0) return ''
  const head = `+${group.more} more ${label}`
  const ids = group.moreIds.join(', ')
  const full = `${head}: ${ids}`
  if (full.length <= width) return full
  const room = width - head.length - 3
  if (room <= 0) return head
  return `${head}: ${ids.slice(0, room).replace(/[,\s]+$/, '')}…`
}

/** `this wave: T2 · next wave: T3`; the ids are cut to fit `width`, and a row still too long is cut with an ellipsis. */
export function waveFooter(view: PlanView, width: number): string | null {
  if (view.waveNo === null) return null
  const mine = view.thisWave.join(', ')
  const theirs = view.nextWave.join(', ')
  const full = `this wave: ${mine}${theirs === '' ? '' : ` · next wave: ${theirs}`}`
  if (cellWidth(full) <= width) return full
  // Share what is left after the labels between the two lists.
  const labels = cellWidth(`this wave: ${theirs === '' ? '' : ' · next wave: '}`)
  const room = Math.max(4, width - labels)
  const cut = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, Math.max(1, n - 1)).replace(/[,\s]+$/, '')}…`)
  const own = cut(mine, theirs === '' ? room : Math.ceil(room / 2))
  const text = `this wave: ${own}${theirs === '' ? '' : ` · next wave: ${cut(theirs, Math.max(2, room - own.length))}`}`
  return truncate(text, width)
}

// ------------------------------------------------------------------ problems, S1, S2

/** An amber row when the plan cannot be shown: unreadable, or no steps in the expected form. */
export function planProblem(name: string, plan: ParsedPlan | null): string | null {
  if (plan === null) return `Plan ${name}: the file could not be read.`
  return plan.steps.length === 0 ? `Plan ${name}: no steps in the expected form.` : null
}

/** `1 line not read` / `3 lines not read`, or '' when none were skipped. */
export const skippedNote = (skipped: number): string => (skipped > 0 ? `${plural(skipped, 'line')} not read` : '')

const idList = (steps: readonly Step[], max = 4): string => {
  const ids = steps.map(s => s.id)
  return ids.length <= max ? ids.join(', ') : `${ids.slice(0, max).join(', ')}, +${ids.length - max}`
}

/** A verifier is running: a tester or an architect (a twin too), or a consult. */
export function verifierRunning(agents: readonly AgentCard[], consults: readonly Consult[]): boolean {
  const role = (card: AgentCard) => typeInfo(card.type).role
  return (
    runningAgents(agents).some(card => role(card) === 'tester' || role(card) === 'architect') ||
    consults.some(c => c.endAt === null)
  )
}

/** S2: steps waiting for QA while no tester or architect runs, as the amber footer; null otherwise. */
export function verificationGap(view: PlanView, agents: readonly AgentCard[], consults: readonly Consult[]): string | null {
  const waiting = view.lists.qa
  if (waiting.length === 0 || verifierRunning(agents, consults)) return null
  const subject = waiting.length === 1 ? `${waiting[0]?.id} awaits QA` : `${idList(waiting)} await QA`
  return `${subject} · no tester or architect running`
}

export type Waiting = { kind: 'ask' | 'blocked' | 'fixes' | 'qa' | 'ready'; text: string }

/**
 * S1, "Waiting on you": a permission ask is pending (even while agents run), or nothing runs, the main loop is idle and
 * the plan holds work only the person can move: a blocked step, fixes to start, a step awaiting QA, steps ready. The text
 * has no prefix; the drawing puts `!` before `Waiting on you · `.
 */
export function waitingOnYou(
  view: PlanView | null,
  session: Session,
  agents: readonly AgentCard[],
  consults: readonly Consult[],
): Waiting | null {
  const ask = session.asks[0]
  if (ask) return { kind: 'ask', text: `${ask.who} asks to run ${ask.tool}` }
  if (view === null || session.isWorking || runningAgents(agents).length > 0 || consults.some(c => c.endAt === null)) return null
  const { blocked, fixes, qa, ready } = view.lists
  const blockedFirst = blocked[0]
  if (blockedFirst) {
    return blocked.length === 1
      ? { kind: 'blocked', text: blockedFirst.note !== '' ? `${blockedFirst.id} blocked: ${blockedFirst.note}` : `${blockedFirst.id} blocked` }
      : { kind: 'blocked', text: `${blocked.length} steps blocked: ${idList(blocked)}` }
  }
  if (fixes.length > 0) {
    return { kind: 'fixes', text: fixes.length === 1 ? `${fixes[0]?.id} needs fixes` : `${fixes.length} steps need fixes: ${idList(fixes)}` }
  }
  if (qa.length > 0) {
    return { kind: 'qa', text: qa.length === 1 ? `${qa[0]?.id} awaits QA` : `${qa.length} steps await QA: ${idList(qa)}` }
  }
  if (ready.length > 0) return { kind: 'ready', text: `${plural(ready.length, 'step')} ready: ${idList(ready)}` }
  return null
}

// ------------------------------------------------------------------ log

/** One `plan` log line per step whose state changed between two reads (`T2 queued → implementing`). */
export function planChanges(prev: ParsedPlan | null, next: ParsedPlan, now: number): LogLine[] {
  if (prev === null) return []
  const before = new Map(prev.steps.map(step => [step.id, step.state]))
  const lines: LogLine[] = []
  for (const step of next.steps) {
    const was = before.get(step.id)
    if (was !== undefined && was !== step.state) {
      lines.push({ at: now, who: 'plan', kind: 'plan', text: `${step.id} ${was} → ${step.state}` })
    }
  }
  return lines
}
