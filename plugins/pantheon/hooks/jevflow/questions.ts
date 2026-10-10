// The judgment step of JevFlow (judge.py), ported: the curated state sent to Jev within a character budget, the
// question set (every choice keeps `unclear`), the parsing of the answers, and compete-then-verify.
// Pure: the Jev call is the injected `ask`, nothing here touches host access, and `judge` never throws. A failed first
// call returns null and the Stop is held once (jev_unavailable). The sub-step questions (regions.py) are dropped with regions.
// Every string in the state goes through `redactSecrets` before it is trimmed: the state leaves the machine.

import { redactSecrets } from './redact'
import { UNCLEAR } from './types'
import type { CheckResult, Flow, Judgment } from './types'

export const LAST_MESSAGE_CHARS = 4000
export const HISTORY_ITEMS = 5
export const CHECK_OUTPUT_CHARS = 800
export const MAX_CHANGE_FILES = 40
export const DEFAULT_STATE_BUDGET = 12000

export const NEXT_ACTIONS: Readonly<Record<string, string>> = {
  continue_phase: 'Keep working on the current phase, it is not finished',
  advance_phase: 'The current phase is finished, move to the next phase',
  fix_regression: 'Something that previously worked is now broken and must be fixed',
  ask_human: 'The agent is blocked and needs a human decision',
  goal_complete: 'Every phase is finished and verified, the goal is met',
  [UNCLEAR]: 'The state does not make the next step clear',
}

// v3 wording chosen in the A2 spike (docs/RESEARCH.md).
const Q_PHASE = 'Which phase of the plan is the agent currently working on'
const Q_NEXT = 'What should happen next in this session'
const Q_STUCK = 'The recent history and latest message show the agent retrying the same failing approach without new information'
const Q_OFF = 'The latest message describes work unrelated to the goal and to the current phase'
const Q_CLAIMS = 'The latest message claims the work or the goal is complete'
const Q_PROGRESS = 'How far the work has progressed toward the whole goal'
export const PROGRESS_LEVELS: readonly string[] = ['Not started', 'Early', 'About halfway', 'Nearly done', 'Complete and verified']
const Q_UNCLEAR_PHASE = 'The state does not make the current phase clear'
const qDone = (name: string, doneWhen: string) => `The agent has fully completed the '${name}' phase: ${doneWhen}`

// --- Types ---

export type NoulQuestion = { type: 'noul'; instructions: string }
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> }
export type ScoreQuestion = { type: 'score'; instructions: string; criteria: string[] }
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion
export type Questions = Record<string, Question>
/** The `answers` object of Jev's response, keyed by question id. Shape-checked by `jev.ts`; `parseAnswers` reads it. */
export type Answers = Record<string, Record<string, unknown>>
/** What `judge` calls: the questions and the serialized state, resolving with the answers or throwing. */
export type AskFn = (questions: Questions, state: string) => Promise<Answers>

export type ChangeEntry = { path: string; added: number; removed: number; diff?: string }
/** A state.history entry. JevFlow's state.py writes `decision`, with `phase` and `reason`, and only decisions are shown. */
export type JournalEntry = { decision?: string; phase?: string | null; reason?: string; [key: string]: unknown }
/** The part of the flow state the judge reads. A FlowState fits it. */
export type JudgeState = {
  current_phase?: string | null
  phase_status?: Record<string, string>
  history?: ReadonlyArray<JournalEntry>
}
/** The judgment with the fields JevFlow keeps beyond `Judgment`: progress (logged only), the calls spent and the error. */
export type JevJudgment = Judgment & {
  progress: number | null
  progress_conf: number | null
  calls: number
  error: string | null
}

// --- Text helpers (judge.py `_tail` and `_head`: counted in code points, with three dots) ---

export function tailText(text: string, n: number): string {
  const chars = Array.from(text)
  if (chars.length <= n) return text
  if (n <= 3) return n > 0 ? chars.slice(-n).join('') : ''
  return '...' + chars.slice(-(n - 3)).join('')
}

export function headText(text: string, n: number): string {
  const chars = Array.from(text)
  if (chars.length <= n) return text
  if (n <= 3) return chars.slice(0, n).join('')
  return chars.slice(0, n - 3).join('') + '...'
}

// --- State ---

export type ChangeSummaryItem = string | { file: string; diff: string }

/** Change summary for Jev. Without `sendDiff` only `path +A -R` lines; a diff is kept only when asked for, truncated. */
export function summarizeChanges(
  entries: ReadonlyArray<ChangeEntry>,
  sendDiff: boolean,
  maxFiles: number = MAX_CHANGE_FILES,
): ChangeSummaryItem[] {
  const count = (value: unknown) => Math.trunc(Number(value) || 0)
  const size = (e: ChangeEntry) => count(e.added) + count(e.removed)
  const ordered = [...entries].sort((a, b) => size(b) - size(a))
  const out: ChangeSummaryItem[] = []
  for (const e of ordered.slice(0, maxFiles)) {
    const line = `${e.path ?? '?'} +${count(e.added)} -${count(e.removed)}`
    if (sendDiff && e.diff) out.push({ file: line, diff: headText(String(e.diff), 1500) })
    else out.push(line)
  }
  if (ordered.length > maxFiles) out.push(`... and ${ordered.length - maxFiles} more files`)
  return out
}

/** The decisions of the journal, oldest first, as one line each (judge.py `_history_view` before its cut). */
function decisionLines(state: JudgeState): string[] {
  const lines: string[] = []
  for (const h of state.history ?? []) {
    if (!h.decision) continue
    const head = `${h.decision} ${h.phase ?? ''}`.trim()
    lines.push(h.reason ? `${head}: ${headText(redactSecrets(String(h.reason)), 160)}` : head)
  }
  return lines
}

export type BuildStateInput = {
  checks: Readonly<Record<string, CheckResult>>
  lastMessage?: string
  changes?: ReadonlyArray<ChangeEntry>
  /** Characters; defaults to the flow's `state_char_budget`. */
  budget?: number
}

// Trimming levels, from the richest to the tightest: history items, check output chars, change files, last message
// chars, done_when chars. Goal and phase ids are never dropped.
const LEVELS = [
  { history: HISTORY_ITEMS, checkChars: CHECK_OUTPUT_CHARS, files: MAX_CHANGE_FILES, lastChars: LAST_MESSAGE_CHARS, doneWhenChars: 400 },
  { history: 3, checkChars: 400, files: 20, lastChars: 3000, doneWhenChars: 400 },
  { history: 1, checkChars: 200, files: 10, lastChars: 2000, doneWhenChars: 200 },
  { history: 0, checkChars: 120, files: 5, lastChars: 1000, doneWhenChars: 120 },
  { history: 0, checkChars: 60, files: 0, lastChars: 400, doneWhenChars: 60 },
  { history: 0, checkChars: 0, files: 0, lastChars: 150, doneWhenChars: 40 },
] as const

/**
 * The JSON state string sent to Jev, at most `budget` characters when achievable. Trimming order: history, check
 * outputs, change list, last message tail, done_when text. Goal and phase ids are never dropped.
 */
export function buildState(flow: Flow, state: JudgeState, input: BuildStateInput): string {
  const limit = Math.trunc(input.budget || flow.limits.state_char_budget || DEFAULT_STATE_BUDGET)
  const sendDiff = Boolean(flow.privacy?.send_diff)
  const status = state.phase_status ?? {}
  const changes = input.changes ?? []

  // Redacted once, before any trimming: a secret cut in half would no longer be recognized.
  const goal = redactSecrets(flow.goal)
  const phases = flow.phases.map(p => ({
    id: p.id,
    name: redactSecrets(p.name),
    doneWhen: redactSecrets(p.done_when),
    status: Object.hasOwn(status, p.id) ? status[p.id] : 'pending',
  }))
  const checks = Object.entries(input.checks).map(([pid, c]) => ({
    pid,
    passed: c.passed === undefined ? null : c.passed,
    text: redactSecrets(String(c.output ?? '')).trim(),
  }))
  const lastMessage = redactSecrets(input.lastMessage ?? '')
  const redactedChanges: ChangeEntry[] = changes.map(c => ({
    path: redactSecrets(String(c.path ?? '?')),
    added: c.added,
    removed: c.removed,
    ...(c.diff ? { diff: redactSecrets(String(c.diff)) } : {}),
  }))
  const decisions = decisionLines(state)

  const checkResult = (c: (typeof checks)[number], chars: number): string => {
    if (c.passed === null) return 'no check'
    if (c.passed) return 'pass'
    return 'fail' + (chars > 0 && c.text ? ': ' + tailText(c.text, chars) : '')
  }

  let out = ''
  for (const level of LEVELS) {
    const doc = {
      goal: headText(goal, 1000),
      phases: phases.map(p => ({
        id: p.id,
        name: headText(p.name, 80),
        done_when: headText(p.doneWhen, level.doneWhenChars),
        status: p.status,
      })),
      current_phase: state.current_phase ?? null,
      check_results: Object.fromEntries(checks.map(c => [c.pid, checkResult(c, level.checkChars)])),
      last_assistant_message: tailText(lastMessage, level.lastChars),
      change_summary: level.files
        ? summarizeChanges(redactedChanges, sendDiff, level.files)
        : redactedChanges.length > 0 ? [`${redactedChanges.length} files changed`] : [],
      recent_history: level.history > 0 ? decisions.slice(-level.history) : [],
    }
    out = JSON.stringify(doc)
    if (Array.from(out).length <= limit) return out
  }
  return out // best effort at the tightest level
}

// --- Questions ---

/** The question set of one judgment: the phase and next-action choices, three yes/no questions, progress, and
 *  `phase_done__` for the current phase and the one after it. */
export function buildQuestions(flow: Flow, currentPhase: string): Questions {
  const criteria: Record<string, string> = {}
  for (const p of flow.phases) criteria[p.id] = `${p.name}: ${p.done_when}`
  criteria[UNCLEAR] = Q_UNCLEAR_PHASE
  const questions: Questions = {
    current_phase: { type: 'choice', instructions: Q_PHASE, criteria },
    next_action: { type: 'choice', instructions: Q_NEXT, criteria: { ...NEXT_ACTIONS } },
    stuck: { type: 'noul', instructions: Q_STUCK },
    off_goal: { type: 'noul', instructions: Q_OFF },
    claims_done: { type: 'noul', instructions: Q_CLAIMS },
    progress: { type: 'score', instructions: Q_PROGRESS, criteria: [...PROGRESS_LEVELS] },
  }
  const ids = phaseIds(flow)
  const targets: string[] = []
  if (ids.includes(currentPhase)) {
    targets.push(currentPhase)
    const next = nextPhaseId(flow, currentPhase)
    if (next !== null) targets.push(next)
  }
  for (const pid of targets) {
    const p = findPhase(flow, pid)
    questions[`phase_done__${pid}`] = { type: 'noul', instructions: qDone(p.name, p.done_when) }
  }
  return questions
}

/** The verify question: "is phase X actually done", asked on the `current_phase` winner. */
export function buildVerifyQuestion(flow: Flow, phaseId: string): Questions {
  const p = findPhase(flow, phaseId)
  return { verify: { type: 'noul', instructions: qDone(p.name, p.done_when) } }
}

// --- Parsing ---

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('answer is not an object')
  return value
}

/** A finite number clamped to [0, 1] (judge.py `_num`); anything else is malformed. */
function num(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('not a finite number')
  return Math.min(1, Math.max(0, value))
}

const noulOf = (answer: unknown): number => num(asRecord(answer).noul)

function choiceOf(answer: Record<string, unknown>, allowed: readonly string[]): { choice: string; conf: number; probs: Record<string, number> } {
  const probs: Record<string, number> = {}
  const raw = answer.probabilities
  if (raw) {
    for (const [k, v] of Object.entries(asRecord(raw))) if (allowed.includes(k)) probs[k] = num(v)
  }
  // A choice outside the options falls back to the most probable one; with no probabilities, to `unclear`.
  let chosen = UNCLEAR
  let best = -Infinity
  for (const [k, v] of Object.entries(probs)) {
    if (v > best) { best = v; chosen = k }
  }
  if (typeof answer.choice === 'string' && allowed.includes(answer.choice)) chosen = answer.choice
  const conf = answer.confidence !== undefined && answer.confidence !== null ? num(answer.confidence) : (probs[chosen] ?? 0)
  return { choice: chosen, conf, probs }
}

/** Parses the answers of the first call (judge.py `parse_answers`, sub-steps dropped). Throws on a malformed shape. */
export function parseAnswers(flow: Flow, answers: Answers): JevJudgment {
  const ids = phaseIds(flow)
  const phase = choiceOf(answerOf(answers, 'current_phase'), [...ids, UNCLEAR])
  const next = choiceOf(answerOf(answers, 'next_action'), Object.keys(NEXT_ACTIONS))
  let progress: number | null = null
  let progressConf: number | null = null
  const prog = answers.progress
  if (prog !== undefined && prog !== null && Object.keys(asRecord(prog)).length > 0) {
    // assumed 0..(levels - 1) (A2 saw 1.64 and 2.52); normalised to [0, 1]. Logged only: the policy never keys on it.
    const score = asRecord(prog).score
    if (typeof score !== 'number' || !Number.isFinite(score)) throw new RangeError('progress score not finite')
    progress = Math.min(1, Math.max(0, score / (PROGRESS_LEVELS.length - 1)))
    const confidence = asRecord(prog).confidence
    if (confidence !== undefined && confidence !== null) progressConf = num(confidence)
  }
  const phaseDone: Record<string, number> = {}
  for (const [key, value] of Object.entries(answers)) {
    const pid = key.slice('phase_done__'.length)
    if (key.startsWith('phase_done__') && ids.includes(pid)) phaseDone[pid] = noulOf(value)
  }
  return {
    current_phase: phase.choice,
    current_phase_conf: phase.conf,
    current_phase_probs: phase.probs,
    next_action: next.choice,
    next_action_conf: next.conf,
    phase_done: phaseDone,
    verify_phase: null,
    verify: null,
    stuck: noulOf(answerOf(answers, 'stuck')),
    off_goal: noulOf(answerOf(answers, 'off_goal')),
    claims_done: noulOf(answerOf(answers, 'claims_done')),
    progress,
    progress_conf: progressConf,
    calls: 0,
    error: null,
  }
}

function answerOf(answers: Answers, name: string): Record<string, unknown> {
  const value = answers[name]
  if (value === undefined) throw new TypeError(`answer "${name}" is missing`)
  return asRecord(value)
}

/** Compact numbers for the step journal: no free text (judge.py `probs`). */
export function judgmentProbs(j: JevJudgment): Record<string, unknown> {
  const round3 = (x: number) => Math.round(x * 1000) / 1000
  const out: Record<string, unknown> = {
    current_phase: [j.current_phase, round3(j.current_phase_conf)],
    next_action: [j.next_action, round3(j.next_action_conf)],
    stuck: round3(j.stuck),
    off_goal: round3(j.off_goal),
    claims_done: round3(j.claims_done),
  }
  for (const [k, v] of Object.entries(j.phase_done)) out[`phase_done__${k}`] = round3(v)
  if (j.verify !== null) out.verify = [j.verify_phase, round3(j.verify)]
  if (j.progress !== null) out.progress = round3(j.progress)
  return out
}

// --- Orchestration ---

export type JudgeOptions = {
  checks: Readonly<Record<string, CheckResult>>
  lastMessage?: string
  changes?: ReadonlyArray<ChangeEntry>
  /** The host's cap on the state (judge.py `state_budget`); the smaller of it and the flow's budget applies. */
  stateBudget?: number
  /** Calls left for this judgment (judge.py `max_calls`). A call past it is not sent; it fails like a Jev error. */
  maxCalls?: number
}

const reasonOf = (error: unknown): string => {
  if (isRecord(error) && typeof error.reason === 'string') return error.reason
  return 'error'
}

/** What `judge` resolves to: the judgment, or null when Jev gave none (the Stop degrades to checks only, quoting `error`). */
export type JudgeResult = { judgment: JevJudgment | null; calls: number; error: string | null }

export const NO_JUDGE = 'no judge: Jev key missing (set the judgeKey option or OPENROUTER_API_KEY)'

/**
 * The judgment (judge.py `judge`): the main call, then, when a phase won, the verify call on that phase
 * (compete-then-verify). The judgment is null when the first call fails (no ask, a budget, a Jev error, a malformed
 * answer). A failed verify call keeps the first call's judgment with `verify` null and `error` set, because without
 * `verify` nothing can advance but the rest still informs the policy. Never throws.
 */
export async function judge(
  ask: AskFn | null | undefined,
  flow: Flow,
  state: JudgeState,
  opts: JudgeOptions,
): Promise<JudgeResult> {
  if (typeof ask !== 'function') return { judgment: null, calls: 0, error: NO_JUDGE }
  let spent = 0
  const call = async (questions: Questions, doc: string): Promise<Answers> => {
    if (opts.maxCalls !== undefined && spent >= opts.maxCalls) {
      throw Object.assign(new Error('max_jev_calls reached'), { reason: 'budget' })
    }
    spent += 1
    return ask(questions, doc)
  }

  let doc: string
  let judgment: JevJudgment
  try {
    const flowBudget = flow.limits.state_char_budget || DEFAULT_STATE_BUDGET
    const cap = opts.stateBudget
    const budget = cap !== undefined && cap > 0 ? Math.min(flowBudget, Math.trunc(cap)) : flowBudget
    doc = buildState(flow, state, { checks: opts.checks, lastMessage: opts.lastMessage, changes: opts.changes, budget })
    const current = state.current_phase ?? ''
    const answers = await call(buildQuestions(flow, current), doc)
    try {
      judgment = parseAnswers(flow, answers)
    } catch (error) {
      return { judgment: null, calls: spent, error: `malformed Jev answers (${error instanceof Error ? error.name : 'Error'})` }
    }
  } catch (error) {
    return { judgment: null, calls: spent, error: `Jev ${reasonOf(error)}: ${error instanceof Error ? error.message : String(error)}` }
  }

  if (judgment.current_phase !== UNCLEAR) {
    judgment.verify_phase = judgment.current_phase
    let verified: Answers | undefined
    try {
      verified = await call(buildVerifyQuestion(flow, judgment.current_phase), doc)
    } catch (error) {
      judgment.error = `verify failed: ${reasonOf(error)}`
    }
    if (verified !== undefined) {
      try {
        judgment.verify = noulOf(answerOf(verified, 'verify'))
      } catch {
        judgment.error = 'verify failed: malformed answer'
      }
    }
  }
  judgment.calls = spent
  return { judgment, calls: spent, error: judgment.error }
}

// --- Flow helpers ---

function phaseIds(flow: Flow): string[] {
  return flow.phases.map(p => p.id)
}

function findPhase(flow: Flow, phaseId: string) {
  const phase = flow.phases.find(p => p.id === phaseId)
  if (phase === undefined) throw new Error(`unknown phase ${phaseId}`)
  return phase
}

/** The next phase in declaration order, or null when it is the last one. */
function nextPhaseId(flow: Flow, phaseId: string): string | null {
  const ids = phaseIds(flow)
  const i = ids.indexOf(phaseId)
  return i >= 0 && i + 1 < ids.length ? (ids[i + 1] ?? null) : null
}
