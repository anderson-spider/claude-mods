// The flow controller's files: state per plan, an append-only journal, the side-effect ledger and calibration labels.
// Pure: file access is injected and the module never reads a clock (callers pass `at`) or touches `$`.
//
// Layout under `<root>/.pantheon/flow/<planId>/`:
//   state.json         the FlowState, pretty JSON, written whole
//   journal.jsonl      one JournalEntry per line, ids climbing, capped at JOURNAL_CAP entries and JOURNAL_MAX_BYTES
//   side-effects.jsonl one { taskId, at } per line; the ledger outranks state.json
//   labels.jsonl       one calibration label per line, referencing a journal id, capped like the journal
//
// The host has no append, only whole-file read and write, so every append is a read-modify-write of the file.
// SERIALIZATION IS THE CALLER'S JOB: hooks for parallel tool calls run concurrently, and nothing here locks. EVERY
// write to a plan's files (state, journal, side effects, labels, approvals, and the pause/resume/stop commands) must go
// through the same per-plan `createSerial()` queue, load -> decide -> save -> journal as one job. This includes labels:
// `appendJournal` reads labels.jsonl to compute its id floor, so an unqueued label write can race it.
// Reads never throw on content: torn, foreign or malformed lines are skipped. A failure of `fs` itself propagates and
// the caller (which fails open) decides what to do.
//
// Approval: when the plan's flow hash differs from `state.hash`, the host calls the policy's `rebase(flow, state)` (new
// hash, `approvedHash` cleared) and the person approves again with `approve`. `approve` only sets `approvedHash`.
// The ledger is per planId, not per hash: a side effect recorded for an earlier version of the plan stays recorded.

import type { TaskStatus } from './plan'
import type { Action, Awaiting, FlowState, Mode, Receipts, Reviewer } from './types'

export type FlowFs = {
  /**
   * The file's text. Must return undefined ONLY when the file does not exist and must reject on any other error
   * (permission, I/O, over the host's 4 MiB read limit): a rejection is never treated as "missing", because a
   * read-modify-write on a file that merely failed to read would erase it.
   */
  read: (path: string) => Promise<string | undefined>
  write: (path: string, text: string) => Promise<void>
}

export const JOURNAL_CAP = 2000
export const REASON_MAX = 600
const DETAIL_MAX = 2000
const NOTE_MAX = 300
const LABELS_CAP = 2000
/** The host rejects reads over 4 MiB; journal and labels stay far below that. */
export const JOURNAL_MAX_BYTES = 1024 * 1024
const TASK_MAX = 64
const CONDITION_MAX = 64
const CHECK_LABEL_MAX = 200
const CHECKS_MAX = 20

// Same pattern plan.ts validates; checked again here because the id becomes a path segment.
const PLAN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export type JournalKind = 'decision' | 'judgment' | 'approval' | 'note'

export type JournalEntry = {
  /** Assigned by appendJournal: the last id plus one, starting at 1. */
  id: number
  /** Epoch milliseconds, supplied by the caller. */
  at: number
  kind: JournalKind
  /** The FlowEvent kind that triggered it ('taskEnd', 'stop', 'humanPrompt', 'review'). */
  event?: string
  task?: string
  action?: Action
  /** The rule tag that fired (Decision.condition). */
  condition?: string
  /** At most REASON_MAX characters. */
  reason?: string
  mode?: Mode
  /** In shadow mode, the action enforce would have taken when it differs from `action`. */
  wouldBe?: Action
  scores?: Partial<Record<'claimsDone' | 'complete' | 'stuck', number>>
  /** Pass/fail per check; never the output text. `passed` is null when the check could not run. */
  checks?: { label: string; passed: boolean | null }[]
  detail?: string
}

/** What a caller passes: everything but the id. */
export type JournalInput = Omit<JournalEntry, 'id'>

export type SideEffect = { taskId: string; at: number }

export type Label = {
  journalId: number
  label: 'right' | 'wrong' | 'skip'
  source: 'auto' | 'person'
  at: number
  note?: string
}

// --- paths ---

function checkPlanId(planId: string): string {
  if (typeof planId !== 'string' || !PLAN_ID.test(planId)) throw new Error(`invalid flow planId: ${JSON.stringify(planId)}`)
  return planId
}

export function flowDir(root: string, planId: string): string {
  return `${root.replace(/\/+$/, '')}/.pantheon/flow/${checkPlanId(planId)}`
}
export const statePath = (root: string, planId: string) => `${flowDir(root, planId)}/state.json`
export const journalPath = (root: string, planId: string) => `${flowDir(root, planId)}/journal.jsonl`
export const ledgerPath = (root: string, planId: string) => `${flowDir(root, planId)}/side-effects.jsonl`
export const labelsPath = (root: string, planId: string) => `${flowDir(root, planId)}/labels.jsonl`

// --- validation helpers ---

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isCount = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)
const optional = (v: unknown, test: (x: unknown) => boolean) => v === undefined || test(v)
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s)
const STATUSES: readonly string[] = ['pending', 'active', 'done', 'failed']

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

/** The valid values of a JSONL file, in order. A torn last line, non-JSON and wrong shapes are skipped. */
function parseLines<T>(text: string | undefined, parse: (raw: unknown) => T | undefined): T[] {
  const out: T[] = []
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue
    const value = parse(parseJson(line))
    if (value !== undefined) out.push(value)
  }
  return out
}

const toJsonl = (items: unknown[]) => items.map(item => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '')

function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++ }
    else n += 3
  }
  return n
}

/** The JSONL text of the newest items: at most `cap` of them and under JOURNAL_MAX_BYTES (the newest always stays). */
function serializeCapped(items: unknown[], cap: number): string {
  const lines = items.slice(Math.max(0, items.length - cap)).map(item => JSON.stringify(item))
  let bytes = lines.reduce((sum, line) => sum + utf8Length(line) + 1, 0)
  let first = 0
  while (bytes > JOURNAL_MAX_BYTES && first < lines.length - 1) bytes -= utf8Length(lines[first++]!) + 1
  const kept = lines.slice(first)
  return kept.join('\n') + (kept.length ? '\n' : '')
}

/**
 * A promise chain that runs the given jobs one at a time, in call order, and never stays rejected: a failed job rejects
 * its own promise and the next one still runs. Use one per plan to serialize load -> decide -> save -> journal.
 */
export function createSerial(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return work => {
    const run = tail.then(work)
    tail = run.then(() => undefined, () => undefined)
    return run
  }
}

// --- state ---

const REVIEWERS: readonly string[] = ['architect', 'qa']
const isAwaitingList = (v: unknown): boolean => Array.isArray(v) && v.every(a => isObj(a) && isStr(a.task) && isStr(a.by) && REVIEWERS.includes(a.by))
const isReceiptsMap = (v: unknown): boolean => isObj(v) && Object.values(v).every(r => isObj(r) && optional(r.architect, x => x === true) && optional(r.qa, x => x === true))

function addAwaiting(state: FlowState, task: string, by: Reviewer): void {
  if (!state.awaiting.some(a => a.task === task && a.by === by)) state.awaiting.push({ task, by })
}

function parseState(raw: unknown, planId: string): FlowState | undefined {
  if (!isObj(raw)) return undefined
  if (raw.planId !== planId || !isStr(raw.hash)) return undefined
  if (!optional(raw.approvedHash, isStr) || !optional(raw.lastInstruction, isStr)) return undefined
  if (!optional(raw.mode, v => isStr(v) && MODES.includes(v))) return undefined
  if (!isObj(raw.status) || !Object.values(raw.status).every(v => isStr(v) && STATUSES.includes(v))) return undefined
  if (!isObj(raw.attempts) || !Object.values(raw.attempts).every(isCount)) return undefined
  if (!isStrList(raw.sideEffectsDone)) return undefined
  // Receipts replaced `reviewed` and `awaitingReview`; a state saved before that still loads: its reviews become architect
  // receipts and its pending reviews wait for the architect. A state needs one of the two receipt forms.
  if (!optional(raw.reviewed, isStrList) || !optional(raw.awaitingReview, isStrList)) return undefined
  if (!optional(raw.awaiting, isAwaitingList) || !optional(raw.receipts, isReceiptsMap)) return undefined
  if (raw.reviewed === undefined && raw.receipts === undefined) return undefined
  // Added with the QA escalation and the delivery count: an older state.json has neither and loads with them empty.
  if (!optional(raw.qaRequired, isStrList) || !optional(raw.ends, v => isObj(v) && Object.values(v).every(isCount))) return undefined
  if (!isCount(raw.blocks) || !isCount(raw.consecutiveBlocks)) return undefined
  if (typeof raw.paused !== 'boolean' || typeof raw.stopped !== 'boolean' || typeof raw.done !== 'boolean') return undefined
  const lf = raw.lastFailure
  if (lf !== undefined && !(isObj(lf) && isStr(lf.key) && isCount(lf.count))) return undefined
  // Rebuilt field by field so unknown keys never leak into the state.
  const state: FlowState = {
    planId, hash: raw.hash,
    status: { ...raw.status } as Record<string, TaskStatus>,
    attempts: { ...raw.attempts } as Record<string, number>,
    awaiting: [], receipts: {}, qaRequired: raw.qaRequired === undefined ? [] : [...(raw.qaRequired as string[])],
    ends: raw.ends === undefined ? {} : { ...(raw.ends as Record<string, number>) },
    sideEffectsDone: [...raw.sideEffectsDone],
    blocks: raw.blocks, consecutiveBlocks: raw.consecutiveBlocks,
    paused: raw.paused, stopped: raw.stopped, done: raw.done,
  }
  for (const id of (raw.reviewed as string[] | undefined) ?? []) state.receipts[id] = { ...state.receipts[id], architect: true }
  for (const [id, r] of Object.entries((raw.receipts as Record<string, Obj> | undefined) ?? {})) {
    const receipts: Receipts = { ...state.receipts[id] }
    if (r.architect === true) receipts.architect = true
    if (r.qa === true) receipts.qa = true
    state.receipts[id] = receipts
  }
  for (const id of (raw.awaitingReview as string[] | undefined) ?? []) addAwaiting(state, id, 'architect')
  for (const a of (raw.awaiting as Awaiting[] | undefined) ?? []) addAwaiting(state, a.task, a.by)
  if (raw.approvedHash !== undefined) state.approvedHash = raw.approvedHash as string
  if (lf !== undefined) state.lastFailure = { key: (lf as Obj).key as string, count: (lf as Obj).count as number }
  if (raw.lastInstruction !== undefined) state.lastInstruction = raw.lastInstruction as string
  if (raw.mode !== undefined) state.mode = raw.mode as Mode
  return state
}

/**
 * The saved state, or undefined when the file is missing, is not valid JSON, has the wrong shape or belongs to another
 * plan. The caller starts a fresh state in every one of those cases and then applies `restoreFromLedger`.
 */
export async function loadState(fs: FlowFs, root: string, planId: string): Promise<FlowState | undefined> {
  const text = await fs.read(statePath(root, planId))
  if (text === undefined) return undefined
  return parseState(parseJson(text), planId)
}

/** Writes the whole file as pretty JSON. */
export async function saveState(fs: FlowFs, root: string, state: FlowState): Promise<void> {
  await fs.write(statePath(root, state.planId), `${JSON.stringify(state, null, 2)}\n`)
}

// --- approval ---

/** Records the hash the person approved. Approving a hash the state does not carry is recorded but never counts. */
export function approve(state: FlowState, hash: string): FlowState {
  return { ...state, approvedHash: hash }
}

/** True only when the approved hash, the plan's current hash and the state's hash are all the same. */
export function isApproved(state: FlowState, hash: string): boolean {
  return state.approvedHash !== undefined && state.approvedHash === hash && state.hash === hash
}

// --- journal ---

const KINDS: readonly string[] = ['decision', 'judgment', 'approval', 'note']
const ACTIONS: readonly string[] = ['allow', 'block', 'advance', 'wait', 'pause', 'complete', 'failTask']
const MODES: readonly string[] = ['off', 'shadow', 'enforce']
const SCORE_KEYS = ['claimsDone', 'complete', 'stuck'] as const

function parseEntry(raw: unknown): JournalEntry | undefined {
  if (!isObj(raw)) return undefined
  if (!isCount(raw.id) || raw.id < 1 || !isNum(raw.at) || !isStr(raw.kind) || !KINDS.includes(raw.kind)) return undefined
  for (const key of ['event', 'task', 'condition', 'reason', 'detail'] as const) if (!optional(raw[key], isStr)) return undefined
  for (const key of ['action', 'wouldBe'] as const) if (!optional(raw[key], v => isStr(v) && ACTIONS.includes(v))) return undefined
  if (!optional(raw.mode, v => isStr(v) && MODES.includes(v))) return undefined
  if (!optional(raw.scores, v => isObj(v) && Object.values(v).every(isNum))) return undefined
  if (!optional(raw.checks, v => Array.isArray(v) && v.every(c => isObj(c) && isStr(c.label) && (c.passed === null || typeof c.passed === 'boolean')))) return undefined

  const entry: JournalEntry = { id: raw.id, at: raw.at, kind: raw.kind as JournalKind }
  if (raw.event !== undefined) entry.event = raw.event as string
  if (raw.task !== undefined) entry.task = clip(raw.task as string, TASK_MAX)
  if (raw.action !== undefined) entry.action = raw.action as Action
  if (raw.condition !== undefined) entry.condition = clip(raw.condition as string, CONDITION_MAX)
  if (raw.reason !== undefined) entry.reason = clip(raw.reason as string, REASON_MAX)
  if (raw.mode !== undefined) entry.mode = raw.mode as Mode
  if (raw.wouldBe !== undefined) entry.wouldBe = raw.wouldBe as Action
  if (raw.scores !== undefined) {
    const scores: NonNullable<JournalEntry['scores']> = {}
    for (const key of SCORE_KEYS) if (isNum((raw.scores as Obj)[key])) scores[key] = (raw.scores as Obj)[key] as number
    entry.scores = scores
  }
  if (raw.checks !== undefined) entry.checks = (raw.checks as Obj[]).slice(0, CHECKS_MAX).map(c => ({ label: clip(c.label as string, CHECK_LABEL_MAX), passed: c.passed as boolean | null }))
  if (raw.detail !== undefined) entry.detail = clip(raw.detail as string, DETAIL_MAX)
  return entry
}

/**
 * Appends one entry and returns it as stored. The id is one more than the highest id on file in the journal and the
 * highest `journalId` in labels.jsonl (1 when both are empty), so ids never repeat even if the journal was lost or
 * trimmed. The entry is sanitized like a read: `reason` is cut to REASON_MAX characters, `task` and `condition` to 64,
 * check labels to 200 with at most 20 checks, and unknown fields are dropped. After the append the oldest entries are
 * dropped until at most JOURNAL_CAP remain and the file is under JOURNAL_MAX_BYTES. A torn last line is dropped.
 */
export async function appendJournal(fs: FlowFs, root: string, planId: string, entry: JournalInput): Promise<JournalEntry> {
  const path = journalPath(root, planId)
  const existing = parseLines(await fs.read(path), parseEntry)
  const labels = parseLines(await fs.read(labelsPath(root, planId)), parseLabel)
  const id = Math.max(0, ...existing.map(e => e.id), ...labels.map(l => l.journalId)) + 1
  const stored = parseEntry({ ...entry, id })
  if (!stored) throw new Error('invalid journal entry')
  await fs.write(path, serializeCapped([...existing, stored], JOURNAL_CAP))
  return stored
}

/** Every valid entry, oldest first. Torn, non-JSON and wrongly shaped lines are skipped. */
export async function readJournal(fs: FlowFs, root: string, planId: string): Promise<JournalEntry[]> {
  return parseLines(await fs.read(journalPath(root, planId)), parseEntry)
}

// --- side-effect ledger ---

function parseSideEffect(raw: unknown): SideEffect | undefined {
  if (!isObj(raw) || !isStr(raw.taskId) || !raw.taskId || !isNum(raw.at)) return undefined
  return { taskId: raw.taskId, at: raw.at }
}

/** Notes that a side-effect task ran. Idempotent per task: the first record stays. The ledger is never capped. */
export async function recordSideEffect(fs: FlowFs, root: string, planId: string, taskId: string, at: number): Promise<void> {
  const path = ledgerPath(root, planId)
  const entry = parseSideEffect({ taskId, at })
  if (!entry) throw new Error('invalid side-effect record')
  const existing = parseLines(await fs.read(path), parseSideEffect)
  if (existing.some(e => e.taskId === taskId)) return
  await fs.write(path, toJsonl([...existing, entry]))
}

export async function readSideEffects(fs: FlowFs, root: string, planId: string): Promise<SideEffect[]> {
  return parseLines(await fs.read(ledgerPath(root, planId)), parseSideEffect)
}

/**
 * Marks every ledger task `done` and in `sideEffectsDone`. The ledger outranks state.json: a state that was lost, reset
 * or says the task failed never re-runs a side effect. Returns a new state; the input is untouched. `taskIds` (the flow's
 * task ids), when given, filters the ledger.
 */
export function restoreFromLedger(state: FlowState, ledger: readonly SideEffect[], taskIds?: readonly string[]): FlowState {
  const status = { ...state.status }
  const sideEffectsDone = [...state.sideEffectsDone]
  for (const { taskId } of ledger) {
    // The ledger is per planId, not per hash: with the flow's task ids, entries for tasks the plan no longer has are ignored.
    if (taskIds && !taskIds.includes(taskId)) continue
    status[taskId] = 'done'
    if (!sideEffectsDone.includes(taskId)) sideEffectsDone.push(taskId)
  }
  return { ...state, status, sideEffectsDone }
}

// --- calibration labels ---

function parseLabel(raw: unknown): Label | undefined {
  if (!isObj(raw) || !isCount(raw.journalId) || !isNum(raw.at)) return undefined
  if (raw.label !== 'right' && raw.label !== 'wrong' && raw.label !== 'skip') return undefined
  if (raw.source !== 'auto' && raw.source !== 'person') return undefined
  if (!optional(raw.note, isStr)) return undefined
  const label: Label = { journalId: raw.journalId, label: raw.label, source: raw.source, at: raw.at }
  if (raw.note !== undefined) label.note = clip(raw.note as string, NOTE_MAX)
  return label
}

/** Appends a label for a journal entry, keeping the newest LABELS_CAP and staying under JOURNAL_MAX_BYTES. A later label for the same entry wins at read time. */
export async function appendLabel(fs: FlowFs, root: string, planId: string, label: Label): Promise<void> {
  const stored = parseLabel(label)
  if (!stored) throw new Error('invalid label')
  const path = labelsPath(root, planId)
  const existing = parseLines(await fs.read(path), parseLabel)
  await fs.write(path, serializeCapped([...existing, stored], LABELS_CAP))
}

export async function readLabels(fs: FlowFs, root: string, planId: string): Promise<Label[]> {
  return parseLines(await fs.read(labelsPath(root, planId)), parseLabel)
}
