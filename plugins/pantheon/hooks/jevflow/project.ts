// Pure project helpers of the JevFlow port: the flow's files under .pantheon/flow, the slug of a flow name, the
// deterministic checks a Stop runs, and the SUMMARY.md text of an archived flow (JevFlow project.py).
// Nothing here reads or writes a file, runs a command or reads a clock: callers pass the data in and write the result.
// The flow layout, session bindings, run_check and git_changes do I/O and live in controller.ts.

import type { Flow, FlowState, PhaseStatus } from './types'

/** The flows of a project live here (JevFlow kept them under .jevflow/): flows/<id>/, done/<id>/, sessions/<session id>. */
export const FLOW_DIR_REL = '.pantheon/flow'

/** A state.history record as JevFlow writes it (loosely typed: stop records carry event, decision, reason, ts, ...). */
export type HistoryRecord = Record<string, unknown>

/** The fields of state.json these helpers read. JevFlow's history records and error dicts are loosely typed on disk. */
export type StateView = Omit<Partial<FlowState>, 'history' | 'last_error'> & {
  history?: HistoryRecord[]
  last_error?: unknown
  last_jev_error?: unknown
}

export const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Python's str() of a value as JevFlow prints it: a missing value reads as None. */
export const pyStr = (v: unknown): string => (v === undefined || v === null ? 'None' : String(v))

/** `YYYY-MM-DD HH:MM:SSZ` in UTC for epoch seconds, or '?' when the value is out of range. */
export function utcStamp(seconds: number): string {
  const d = new Date(seconds * 1000)
  const year = d.getUTCFullYear()
  if (Number.isNaN(d.getTime()) || year < 0 || year > 9999) return '?'
  return `${d.toISOString().slice(0, 19).replace('T', ' ')}Z`
}

const SLUG_STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'with', 'please', 'can',
  'you', 'me', 'my', 'i', 'it', 'that', 'this', 'is', 'be', 'we', 'our',
])

/** Dash-joined words of a name or goal, without filler words, at most 48 characters. */
export function slugify(text: string, words = 5): string {
  const toks = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const kept = toks.filter(t => !SLUG_STOP.has(t)).slice(0, words)
  const joined = (kept.length ? kept : ['flow']).join('-')
  return joined.slice(0, 48).replace(/^-+|-+$/g, '') || 'flow'
}

/** on_fail targets that no phase depends on (for example `debug`): they run only when routed to by on_fail. */
export function branchOnly(flow: Flow): Set<string> {
  const targets = new Set<string>()
  const depended = new Set<string>()
  for (const p of flow.phases) {
    if (p.on_fail) targets.add(p.on_fail)
    for (const d of p.depends_on) depended.add(d)
  }
  return new Set(Array.from(targets).filter(t => !depended.has(t)))
}

/** The phases that must be done for the goal to be complete, in declaration order. */
export function requiredPhases(flow: Flow): string[] {
  const bo = branchOnly(flow)
  return flow.phases.map(p => p.id).filter(id => !bo.has(id))
}

/**
 * Phases whose check runs on this Stop: the current phase and every done phase (branch-only excluded). While the
 * caller's budget or cap is hit (`settling`, JevFlow's policy.cap_reached), pending phases with a check also run,
 * except loops, side effects and branch-only phases, so the policy can record work that is already finished.
 */
export function checksToRun(flow: Flow, state: StateView, settling = false): string[] {
  const status: Partial<Record<string, PhaseStatus>> = state.phase_status ?? {}
  const cur = state.current_phase
  const bo = branchOnly(flow)
  const out: string[] = []
  for (const p of flow.phases) {
    if (p.check == null) continue
    if (p.id === cur || (status[p.id] === 'done' && !bo.has(p.id))) out.push(p.id)
    else if (settling && !bo.has(p.id) && p.loop == null && !p.side_effect) out.push(p.id)
  }
  return out
}

export type SummaryInput = {
  /** The heading of the summary: the id the archived flow is kept under. */
  flowId: string
  /** Absent for a draft that was never laid out. */
  flow?: Flow
  state: StateView
  draft: { goal?: string; created_at?: number }
  now: number
  outcome: string
}

/** SUMMARY.md of an archived flow: outcome, goal, timing, the stop decisions and the phase table. */
export function summaryMarkdown({ flowId, flow, state, draft, now, outcome }: SummaryInput): string {
  const goal = flow?.goal || draft.goal || '?'
  const started = state.started_at || draft.created_at || now
  const counts = new Map<string, number>()
  for (const h of state.history ?? []) {
    if (!isDict(h) || h.event !== 'stop') continue
    const key = pyStr(h.decision)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const stops = Array.from(counts.keys()).sort().map(k => `${k} ${counts.get(k)}`).join(', ') || 'none'
  const status: Partial<Record<string, PhaseStatus>> = state.phase_status ?? {}
  const lines = [
    `# ${flowId}`,
    '',
    `Outcome: **${outcome}**`,
    '',
    `Goal: ${goal}`,
    '',
    `Started ${utcStamp(started)}, archived ${utcStamp(now)} (${((now - started) / 60).toFixed(1)} min).`,
    `Jev calls: ${state.jev_calls ?? 0}. Restarts: ${state.restarts ?? 0}. Stops: ${stops}.`,
    '',
    '| Phase | Status | Done when |',
    '| --- | --- | --- |',
    ...(flow?.phases ?? []).map(ph => `| ${ph.id} | ${status[ph.id] ?? 'pending'} | ${ph.done_when.replace(/\|/g, '/')} |`),
  ]
  return `${lines.join('\n')}\n`
}
