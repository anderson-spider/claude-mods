// What the agent cards and the Review card show, derived from the atoms (UI spec 4.4): job strips per type, the
// running rows' activity line, the finished rows (one per type), the empty-state texts and the consult rows.
import { fmtDuration } from './format'
import { AGENT_GLYPH, AGENT_TONE, JOB_GLYPH, JOB_TONE, PLANNED_GLYPH, type Cell } from './glyphs'
import { displayName } from './roles'
import { agentContextPct, agentSince, isRunning, jobOf, lastEndedAt, lastRound, runningAgents, statusOfCard } from './state'
import type { AgentCard, Consult, RoundStatus } from './types'

/** Glyphs a strip shows before `+N`. */
export const STRIP_MAX = 6

export type Strip = { cells: Cell[]; more: number }

/**
 * One cell per job of a type, oldest first, then one `▱` per queued plan step it owns. More than `max` cells: the
 * oldest finished jobs are folded into `more` (a running job and the planned cells stay).
 */
export function jobStrip(agents: readonly AgentCard[], type: string, planned: number, max = STRIP_MAX): Strip {
  // A job's cell is its first round's start and its last round's outcome (rounds of one job: background wakes).
  const jobs = agents
    .filter(card => card.type === type)
    .flatMap(card => {
      const byJob = new Map<number, { at: number; status: RoundStatus }>()
      for (const round of card.rounds) {
        const seen = byJob.get(jobOf(round))
        byJob.set(jobOf(round), { at: seen?.at ?? round.startedAt, status: round.status })
      }
      return [...byJob.values()]
    })
    .sort((a, b) => a.at - b.at)
  const items = [
    ...jobs.map(job => ({
      cell: { glyph: JOB_GLYPH[job.status], tone: JOB_TONE[job.status] } as Cell,
      keep: job.status === 'running' ? 1 : 0,
    })),
    ...Array.from({ length: planned }, () => ({ cell: { glyph: PLANNED_GLYPH, tone: 'dim' } as Cell, keep: 2 })),
  ]
  const drop = Math.max(0, items.length - max)
  if (drop === 0) return { cells: items.map(item => item.cell), more: 0 }
  // Fold finished jobs first (oldest first), then running ones, then planned cells.
  const order = items.map((item, i) => ({ i, keep: item.keep })).sort((a, b) => a.keep - b.keep || a.i - b.i)
  const folded = new Set(order.slice(0, drop).map(o => o.i))
  return { cells: items.filter((_, i) => !folded.has(i)).map(item => item.cell), more: drop }
}

/** How many queued steps in the plan are owned by this type (`crew:developer`, `crew:developer-codex`). */
export const plannedFor = (owners: readonly { owner: string; state: string }[], type: string): number =>
  owners.filter(step => step.owner === type && step.state === 'queued').length

export type Activity = { kind: 'starting' | 'denied' | 'tool' | 'idle'; text: string; ctxPct: number | null }

/** The running row's third line: `starting…` before the first step, a denied call in red, else the last tool, plus context. */
export function activityOf(card: AgentCard, window: number): Activity {
  const ctxPct = agentContextPct(card, window)
  if (card.denied !== '') return { kind: 'denied', text: `✗ denied ${card.denied}`, ctxPct }
  if (card.steps === 0 && card.lastTool === '') return { kind: 'starting', text: 'starting…', ctxPct }
  return card.lastTool === '' ? { kind: 'idle', text: '', ctxPct } : { kind: 'tool', text: card.lastTool, ctxPct }
}

/** Elapsed time since the current job started (`agentSince`): to now while it runs, to its last end once finished. */
export function elapsedOf(card: AgentCard, now: number): number {
  const round = lastRound(card)
  if (!round) return 0
  return Math.max(0, (round.status === 'running' ? now : (round.endedAt ?? now)) - agentSince(card))
}

export type RunningRow = {
  card: AgentCard
  name: string
  elapsed: string
  strip: Strip
  activity: Activity
}

/** The live agents, oldest first, with what their rows show. `planned` is the queued steps per type. */
export function runningRows(
  agents: readonly AgentCard[],
  o: { now: number; window: number; planned: (type: string) => number },
): RunningRow[] {
  return runningAgents(agents).map(card => ({
    card,
    name: displayName(card.type),
    elapsed: fmtDuration(elapsedOf(card, o.now)),
    strip: jobStrip(agents, card.type, o.planned(card.type)),
    activity: activityOf(card, o.window),
  }))
}

/** `2 min ago`, `1 h ago`; `just now` under a minute. */
export function fmtAgo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.floor(minutes / 60)} h ago`
}

/** The empty running card: nothing ran yet, or the last agent ended some time ago. */
export function runningEmptyText(agents: readonly AgentCard[], now: number): string {
  if (agents.length === 0) return 'No agents yet; delegated work shows here.'
  const at = lastEndedAt(agents)
  return at === null ? 'Nothing running' : `Nothing running · last agent ended ${fmtAgo(now - at)}`
}

export type FinishedRow = {
  type: string
  name: string
  status: Exclude<RoundStatus, 'running'>
  glyph: string
  /** Duration of the last job. */
  duration: string
  /** `failed · max_tokens`, `stopped · <description>`, or the description. */
  task: string
  strip: Strip
  endedAt: number
  /** The last job's model, for the 66-column model column. */
  model: string
}

/** One row per type with no live agent and a finished job, most recent first. */
export function finishedRows(
  agents: readonly AgentCard[],
  o: { planned: (type: string) => number },
): FinishedRow[] {
  const live = new Set(agents.filter(isRunning).map(card => card.type))
  const byType = new Map<string, AgentCard>()
  for (const card of agents) {
    if (live.has(card.type)) continue
    const last = lastRound(card)
    if (!last || last.status === 'running') continue
    const seen = byType.get(card.type)
    const seenEnd = seen ? (lastRound(seen)?.endedAt ?? 0) : -1
    if ((last.endedAt ?? 0) >= seenEnd) byType.set(card.type, card)
  }
  return [...byType.values()]
    .map((card): FinishedRow => {
      const round = lastRound(card) as NonNullable<ReturnType<typeof lastRound>>
      const status = statusOfCard(card) as Exclude<RoundStatus, 'running'>
      return {
        type: card.type,
        name: displayName(card.type),
        status,
        glyph: AGENT_GLYPH[status],
        duration: fmtDuration(Math.max(0, (round.endedAt ?? round.startedAt) - agentSince(card))),
        task:
          status === 'failed'
            ? `failed · ${round.failure ?? 'error'}`
            : status === 'stopped'
              ? `stopped · ${card.description}`
              : card.description,
        strip: jobStrip(agents, card.type, o.planned(card.type)),
        endedAt: round.endedAt ?? round.startedAt,
        model: card.model,
      }
    })
    .sort((a, b) => b.endedAt - a.endedAt || a.type.localeCompare(b.type))
}

export const FINISHED_MAX = 5

/** Tone of an agent row's status glyph. */
export const statusTone = (status: RoundStatus) => AGENT_TONE[status]

/** Level 4's single row: `done: tester·cx ▰ · research ▰✗ · +1`; the strips are shown without the planned cells. */
export function finishedInline(rows: readonly FinishedRow[], max = 3): string {
  if (rows.length === 0) return ''
  const shown = rows.slice(0, max).map(row => `${row.name} ${row.strip.cells.map(c => c.glyph).join('')}`)
  const more = rows.length - shown.length
  return `done: ${shown.join(' · ')}${more > 0 ? ` · +${more}` : ''}`
}

// ------------------------------------------------------------------ review

/** The consults, newest first, at most `max`. */
export const newestConsults = (consults: readonly Consult[], max: number): Consult[] =>
  [...consults].sort((a, b) => b.at - a.at).slice(0, max)

/** A consult running or ended within ten minutes (the mini form's Review line). */
export const REVIEW_RECENT_MS = 10 * 60_000
export const reviewRecent = (consults: readonly Consult[], now: number): Consult | null =>
  newestConsults(consults, consults.length).find(c => c.endAt === null || now - c.endAt < REVIEW_RECENT_MS) ?? null

/** A running consult's text: `consulting · 1:12 · T2 approach`. */
export function consultingText(c: Consult, now: number): string {
  return `consulting · ${fmtDuration(now - c.at)} · ${c.description || c.stepId || ''}`.replace(/ · $/, '')
}
