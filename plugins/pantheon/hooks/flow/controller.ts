// The flow controller: finds the active flow, loads or creates its state, asks the policy for a decision, applies the
// mode, saves and journals, and tells the host what to do. Pure orchestration: every host access (files, commands,
// clock, the config's enabled roles) arrives in `Ctx`, and the module never touches `$`.
//
// Rules this module keeps:
// - Fail open. Any internal error (corrupt files, a failing file system or clock) allows and is warned and journaled when
//   possible; nothing here throws into the engine.
// - Nothing unapproved runs. The checks of a plan run only for the hash the person approved.
// - Every write to a plan's files (state, journal, ledger) is one job on that plan's serial queue. Long work (running
//   checks, git) happens before the job, so a hook waiting for the queue never waits for a command.
// - Shadow decides exactly as enforce and applies `applyMode`: it journals what enforce would have done and returns
//   nothing for the host to act on. Off never reaches this module's work; every entry point returns at once.

import { branchOnly, canonical, eligible, findTask, ownsPath, parseFlow } from './plan'
import type { Flow, FlowTask } from './plan'
import { CheckUnrunnable, createCheckPass } from './checks'
import type { CheckMemo, Runner } from './checks'
import { parseArchitect, parseQa } from './verdicts'
import { applyMode, decide, newState, rebase, withMode } from './policy'
import type { ModeDecision } from './policy'
import {
  appendJournal, approve as setApproved, isApproved, loadState, readJournal, readSideEffects, recordSideEffect,
  restoreFromLedger, saveState, statePath,
} from './store'
import type { FlowFs, JournalInput } from './store'
import type { CheckResult, DecideOptions, FlowEvent, FlowState, Mode, Reviewer } from './types'

export type Serial = <T>(work: () => Promise<T>) => Promise<T>
export type DirEntry = { name: string; kind: string; mtimeMs: number }
/** Which roles the live configuration offers. */
export type Available = { developer: boolean; ux: boolean; architect: boolean; qa: boolean }

export type Ctx = {
  fs: FlowFs
  run: Runner
  now: () => Promise<number>
  /** The repository root; every path of a plan is relative to it. */
  root: string
  mode: Mode
  available: Available
  list: (dir: string) => Promise<DirEntry[]>
  /** One queue per plan: `createSerial()` from the store, kept by the host across hooks. */
  serial: (planId: string) => Serial
  /** Check results by tree snapshot, kept by the host across hooks; without it every check runs every time. */
  memo?: CheckMemo
  /** The time a Stop may spend running checks; STOP_DEADLINE_MS when absent. */
  stopDeadlineMs?: number
  /** Called when the controller fails open or notices something the person should know; never throws into the controller. */
  warn: (text: string) => void
}

/** What a task end or a review leaves for the host: text for the lead (enforce only) and the decision for tests and the journal. */
export type Outcome = { text?: string; decision?: ModeDecision }
export type StopOutcome = { block?: string; notice?: string; decision?: ModeDecision }
export type Snapshot = { head: string; dirty: string }

/** A Stop evaluation that runs checks gives up starting new ones after this long; those are unverified, never failed. */
export const STOP_DEADLINE_MS = 120_000
/** More untracked files than this are listed in a snapshot but their content is not read. */
const UNTRACKED_HASH_CAP = 300

export const ACTIVE_FILE = '.pantheon/flow/active'
export const PLANS_DIR = '.pantheon/plans'
/** The Stop block reasons and the verdict text lead with this tag so the lead knows where they come from. */
const TAG = 'Pantheon flow'
/** Conditions whose reason is bookkeeping, not an instruction. */
const QUIET = new Set(['unapproved', 'already_done', 'paused', 'stopped', 'refill'])

// --- small pure helpers ---

const norm = (path: string): string => {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return '/' + parts.join('/')
}
const stripRoot = (root: string) => root.replace(/\/+$/, '') || '/'
const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir === '/' ? '/' : dir + '/')
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 3)}...`)

export function activePath(root: string): string {
  return `${stripRoot(root)}/${ACTIVE_FILE}`
}

/** A plan path as the person gave it or the pointer holds it: relative to the root, or absolute. */
export function planFile(root: string, path: string): string {
  return path.startsWith('/') ? norm(path) : norm(`${stripRoot(root)}/${path}`)
}

/** The path as stored in the pointer: relative to the root when it lies under it. */
function pointerValue(root: string, file: string): string {
  const base = norm(stripRoot(root))
  return within(file, base) && file !== base ? file.slice(base === '/' ? 1 : base.length + 1) : file
}

/** `[T3]` at the start of a delegation's description names the flow task it is for. */
export function taskIdOf(description: string): string | undefined {
  return /^\s*\[([A-Za-z][A-Za-z0-9_-]{0,31})\]/.exec(description)?.[1]
}

/**
 * The agent a background-task notification is about, its status and its final text. The id and the status are read only
 * from the envelope, the part before `<result>`, which carries the agent's own words; a notification missing either is
 * not recognised (a missing status is never "completed").
 */
export function parseNotification(text: string): { agentId: string; status: string; result: string } | undefined {
  const at = text.indexOf('<result>')
  const envelope = at === -1 ? text : text.slice(0, at)
  const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(envelope)?.[1]?.trim()
  const agentId = tag('task-id')
  const status = tag('status')
  if (!agentId || !status) return undefined
  const result = /<result>([\s\S]*)<\/result>/.exec(text)?.[1]?.trim() ?? text
  return { agentId, status, result }
}

/** How many of the Stop's background tasks are agents: a dev server or a monitor is not work the flow waits for. */
export function pendingAgentTasks(tasks: readonly { type?: string }[] | undefined): number {
  return (tasks ?? []).filter(task => task.type === 'subagent' || task.type === 'workflow').length
}

/** The roles a plan depends on that the live configuration has disabled. */
export function missingRoles(flow: Flow, available: Available): string[] {
  const needed = new Set<keyof Available>()
  for (const task of flow.tasks) {
    needed.add(task.role === 'ux' ? 'ux' : 'developer')
    if (task.risk) needed.add('architect')
    if (!task.sideEffect && task.acceptance.criteria.length > 0) needed.add('qa')
  }
  return [...needed].filter(role => !available[role]).sort()
}

/** Whether the task failed its attempts and now waits for the architect's diagnosis (the policy's `failTask`/`architect`). */
export function diagnosisOpen(flow: Flow, state: FlowState, task: FlowTask): boolean {
  if (state.status[task.id] === 'done') return false
  const max = task.loop?.maxIterations ?? flow.limits.maxAttempts
  if ((state.attempts[task.id] ?? 0) !== max) return false
  const branch = task.onFail ? findTask(flow, task.onFail) : undefined
  return !(branch && state.status[branch.id] !== 'done')
}

/** The session scratchpad of this user and this session: `<tmp>/claude-<uid>/<project>/<session id>/scratchpad`. */
function scratchpadOf(scratch: { uid?: string; sessionId?: string } | undefined): RegExp | undefined {
  if (!scratch?.uid || !scratch.sessionId || !/^\d+$/.test(scratch.uid)) return undefined
  const session = scratch.sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^/(?:private/)?tmp/claude-${scratch.uid}/[^/]+/${session}/scratchpad(?:/|$)`)
}

/**
 * Whether a write belongs to the task: inside the repository under one of its `files`. `root` and `rawPath` are expected
 * canonical (links resolved by the host, as the gate does). Only this session's scratchpad is also allowed (a ux prototype
 * lives there), and only when the caller knows the uid and session id.
 */
export function ownershipVerdict(
  taskId: string, files: readonly string[], root: string, rawPath: string, scratch?: { uid?: string; sessionId?: string },
): { owned: true } | { owned: false; rel?: string; reason: string } {
  const base = norm(stripRoot(root))
  const abs = norm(rawPath.startsWith('/') ? rawPath : `${base}/${rawPath}`)
  if (scratchpadOf(scratch)?.test(abs)) return { owned: true }
  const rel = within(abs, base) && abs !== base ? abs.slice(base === '/' ? 1 : base.length + 1) : undefined
  if (rel !== undefined && ownsPath({ files: [...files] }, rel)) return { owned: true }
  const where = rel ?? abs
  return {
    owned: false, ...(rel !== undefined ? { rel } : {}),
    reason: `Task ${taskId} owns only ${files.join(', ') || 'no files'}; ${where} is outside them. Do not write it: finish within your files and tell the lead which task should own ${where}.`,
  }
}

function sameTree(a: Snapshot, b: Snapshot): boolean {
  return a.dirty === b.dirty
}

/**
 * HEAD and a digest of the working tree: `git diff HEAD` plus the untracked files (their names and, up to a cap, their
 * content), without the controller's own `.pantheon/` files. With `files` (the task's paths) the digest covers only those
 * paths, so an unrelated commit or a change elsewhere does not matter. Hashing is git's own: the diff can be megabytes.
 * Undefined when git cannot tell (not a repository, no commit).
 */
export async function treeSnapshot(ctx: Pick<Ctx, 'run' | 'root'>, files?: readonly string[]): Promise<Snapshot | undefined> {
  try {
    const run = (argv: string[], stdin?: string) => ctx.run(argv, { cwd: ctx.root, timeoutMs: 30_000, ...(stdin === undefined ? {} : { stdin }) })
    const specs = files && files.length > 0 ? [...files] : ['.', ':(exclude).pantheon']
    const head = await run(['git', 'rev-parse', 'HEAD'])
    const diff = await run(['git', 'diff', '--no-ext-diff', '--no-color', 'HEAD', '--', ...specs])
    const others = await run(['git', 'ls-files', '-z', '--others', '--exclude-standard', '--', ...specs])
    if (head.exitCode !== 0 || diff.exitCode !== 0 || others.exitCode !== 0) return undefined
    const names = others.stdout.split('\0').filter(name => name && !(!files && name.startsWith('.pantheon/'))).sort()
    const hashable = names.filter(name => !name.includes('\n'))
    let contents = ''
    if (hashable.length > 0 && hashable.length <= UNTRACKED_HASH_CAP) {
      const hashed = await run(['git', 'hash-object', '--stdin-paths'], `${hashable.join('\n')}\n`)
      if (hashed.exitCode === 0) contents = hashed.stdout
    }
    const digest = await run(['git', 'hash-object', '--stdin'], [diff.stdout, names.join('\n'), contents].join('\0'))
    if (digest.exitCode !== 0) return undefined
    return { head: head.stdout.trim(), dirty: digest.stdout.trim().slice(0, 16) }
  } catch { return undefined }
}

const snapshotKey = async (ctx: Pick<Ctx, 'run' | 'root'>): Promise<string | undefined> => {
  const snapshot = await treeSnapshot(ctx)
  return snapshot ? `${snapshot.head}:${snapshot.dirty}` : undefined
}

// --- locating and loading ---

type Located = { path: string; flow: Flow; hash: string }
type Locate = { kind: 'none' } | { kind: 'invalid'; path: string; errors: string[] } | ({ kind: 'ok' } & Located)
type Trace = { planId?: string }
type Note = { condition: string; detail: string }
type Prepared = { state: FlowState; onDisk: string | undefined; notes: Note[]; ledger: string[] }

async function locate(ctx: Ctx): Promise<Locate> {
  const pointer = await ctx.fs.read(activePath(ctx.root))
  const rel = pointer?.split('\n')[0]?.trim()
  if (!rel) return { kind: 'none' }
  const path = planFile(ctx.root, rel)
  const text = await ctx.fs.read(path)
  if (text === undefined) return { kind: 'invalid', path: rel, errors: [`the plan file ${rel} does not exist`] }
  const parsed = parseFlow(text)
  if (!parsed.ok) return { kind: 'invalid', path: rel, errors: parsed.errors }
  return { kind: 'ok', path: rel, flow: parsed.flow, hash: parsed.hash }
}

/**
 * The state as the next decision sees it, read-only: the saved state (or a fresh one, with a note when the saved file
 * failed validation), the ledger applied, the plan's edits rebased and the mode recorded. Safe outside the queue; only
 * `transact` writes it back.
 */
async function prepare(ctx: Ctx, loc: Located): Promise<Prepared> {
  const { flow, hash } = loc
  const notes: Note[] = []
  let state = await loadState(ctx.fs, ctx.root, flow.planId)
  // Compared by content: key order never decides whether a state is written again.
  const onDisk = state ? canonical(state) : undefined
  if (!state) {
    if ((await ctx.fs.read(statePath(ctx.root, flow.planId))) !== undefined) {
      notes.push({ condition: 'state_invalid', detail: 'state.json failed validation; a fresh state replaces it. Approve the plan again.' })
    }
    state = newState(flow, hash)
  }
  const ledger = await readSideEffects(ctx.fs, ctx.root, flow.planId)
  state = restoreFromLedger(state, ledger, flow.tasks.map(task => task.id))
  if (!onDisk && !flow.tasks.some(task => state!.status[task.id] === 'active')) {
    const first = eligible(flow, state.status)[0]
    if (first) state = { ...state, status: { ...state.status, [first]: 'active' } }
  }
  if (state.hash !== hash) {
    notes.push({ condition: 'plan_edited', detail: 'The plan changed since the state was saved: its approval is cleared and nothing is enforced until /pantheon flow approve.' })
    state = rebase(flow, state)
  }
  return { state: withMode(state, ctx.mode), onDisk, notes, ledger: ledger.map(entry => entry.taskId) }
}

type Work<T> = { state?: FlowState; entries?: Omit<JournalInput, 'at'>[]; value: T }

async function appendSafe(ctx: Ctx, planId: string, entry: JournalInput): Promise<void> {
  try { await appendJournal(ctx.fs, ctx.root, planId, entry) } catch (error) { ctx.warn(`journal: ${message(error)}`) }
}

/** load -> work -> ledger -> save -> journal as one job on the plan's queue. `work` is synchronous: the long parts happened before. */
async function transact<T>(ctx: Ctx, loc: Located, trace: Trace, work: (state: FlowState, prepared: Prepared) => Work<T>): Promise<T> {
  const planId = loc.flow.planId
  trace.planId = planId
  return ctx.serial(planId)(async () => {
    const prepared = await prepare(ctx, loc)
    const at = await ctx.now()
    // A rejected state file is journaled before the fresh one replaces it.
    for (const note of prepared.notes) await appendSafe(ctx, planId, { at, kind: 'note', mode: ctx.mode, condition: note.condition, detail: note.detail })
    const out = work(prepared.state, prepared)
    const next = out.state ?? prepared.state
    for (const id of next.sideEffectsDone) if (!prepared.ledger.includes(id)) await recordSideEffect(ctx.fs, ctx.root, planId, id, at)
    if (canonical(next) !== prepared.onDisk) await saveState(ctx.fs, ctx.root, next)
    for (const entry of out.entries ?? []) await appendSafe(ctx, planId, { at, mode: ctx.mode, ...entry })
    return out.value
  })
}

/** The state a decision would start from, with what `prepare` found (an edited plan, a rejected state file) made durable and journaled once. */
async function observe(ctx: Ctx, loc: Located, trace: Trace): Promise<FlowState> {
  const prepared = await prepare(ctx, loc)
  if (prepared.notes.length > 0) await transact(ctx, loc, trace, () => ({ value: undefined }))
  return prepared.state
}

/** Runs `fn`; an error anywhere is warned, journaled when the plan is known, and answered with `fallback` (allow). */
async function guarded<T>(ctx: Ctx, label: string, fallback: T, fn: (trace: Trace) => Promise<T>): Promise<T> {
  if (ctx.mode === 'off') return fallback
  const trace: Trace = {}
  try {
    return await fn(trace)
  } catch (error) {
    const text = `${label}: ${message(error)}`
    try { ctx.warn(`the flow failed open — ${text}`) } catch { /* A failing warning changes nothing. */ }
    if (trace.planId) {
      try {
        let at = 0
        try { at = await ctx.now() } catch { /* The clock may be what failed. */ }
        await ctx.serial(trace.planId)(() => appendSafe(ctx, trace.planId!, { at, kind: 'note', mode: ctx.mode, condition: 'internal_error', detail: clip(text, 600) }))
      } catch { /* The journal may be what failed. */ }
    }
    return fallback
  }
}

function decideOpts(ctx: Ctx): DecideOptions {
  return { available: { qa: ctx.available.qa, architect: ctx.available.architect } }
}

/**
 * One decision. The judge's seam (T9): ask it here, between the first `decide` and `applyMode`, only when the result finishes a
 * task or retries, and feed an escalation into a second `decide` through `DecideOptions` (`requireQa`, `retryToArchitect`).
 * Until then no judgment exists and the decision is the policy's alone.
 */
function step(ctx: Ctx, flow: Flow, state: FlowState, event: FlowEvent): ModeDecision {
  const first = decide(flow, state, event, undefined, decideOpts(ctx))
  return applyMode(first, ctx.mode, state)
}

function entryFor(ctx: Ctx, event: string, decision: ModeDecision, checks?: readonly CheckResult[], task?: string): Omit<JournalInput, 'at'> {
  const would = decision.wouldBe
  const subject = decision.task ?? task
  return {
    kind: 'decision', event,
    ...(subject ? { task: subject } : {}),
    action: decision.action, condition: decision.condition,
    reason: clip(decision.reason || would?.reason || '', 600),
    mode: ctx.mode,
    ...(would && would.action !== decision.action ? { wouldBe: would.action } : {}),
    ...(checks?.length ? { checks: checks.map(check => ({ label: clip(check.argv.join(' '), 200), passed: check.passed })) } : {}),
  }
}

/** Decisions that change nothing and say nothing are not worth a journal line. */
function journalable(decision: ModeDecision, before: FlowState): boolean {
  if (decision.condition === 'refill') return before.blocks > 0 || before.consecutiveBlocks > 0
  if (decision.action === 'allow' && QUIET.has(decision.condition)) return false
  return true
}

/** What the lead reads, in enforce only: the policy's reason, tagged. */
function leadText(ctx: Ctx, decision: ModeDecision): string | undefined {
  if (ctx.mode !== 'enforce' || !decision.reason || QUIET.has(decision.condition)) return undefined
  return `[${TAG}] ${decision.reason}`
}

async function noteQueued(ctx: Ctx, planId: string, entry: Omit<JournalInput, 'at'>): Promise<void> {
  const at = await ctx.now()
  await ctx.serial(planId)(() => appendSafe(ctx, planId, { at, mode: ctx.mode, ...entry }))
}

/** The host, not the plan, failed to run a check: allow, say so, journal it and charge nothing. */
async function unrunnable(ctx: Ctx, planId: string, error: CheckUnrunnable): Promise<Record<string, never>> {
  try { ctx.warn(`the flow failed open — a check could not be run: ${error.message}`) } catch { /* A failing warning changes nothing. */ }
  await noteQueued(ctx, planId, { kind: 'note', event: 'check', condition: 'check_unrunnable', detail: clip(error.message, 600) })
  return {}
}

// --- Stop ---

export type StopInput = { stopHookActive: boolean; backgroundTasks: number; runningAgents: number }

/** The tasks whose checks a Stop needs: active ones, ones awaiting a receipt, and done ones (a regression or an unverified check). */
function stopTargets(flow: Flow, state: FlowState): FlowTask[] {
  const branches = branchOnly(flow.tasks)
  return flow.tasks.filter(task => {
    if (task.acceptance.checks.length === 0) return false
    const status = state.status[task.id]
    if (status === 'active') return true
    if (status !== 'done') return state.awaiting.some(a => a.task === task.id)
    return !branches.has(task.id)
  })
}

export async function stopFlow(ctx: Ctx, input: StopInput): Promise<StopOutcome> {
  return guarded<StopOutcome>(ctx, 'stop', {}, async trace => {
    const loc = await locate(ctx)
    if (loc.kind !== 'ok') return {}
    trace.planId = loc.flow.planId
    const peek = await observe(ctx, loc, trace)
    // An unapproved or edited plan is never enforced and none of its commands run.
    if (!isApproved(peek, loc.hash)) return {}
    const idle = peek.done || peek.paused || peek.stopped || input.backgroundTasks > 0 || input.runningAgents > 0
    const checks: Record<string, CheckResult[]> = {}
    let unverified = 0
    if (!idle) {
      // The whole evaluation has a deadline: a check that does not get to run in time is unverified, never a fail.
      const limit = ctx.stopDeadlineMs ?? STOP_DEADLINE_MS
      const pass = await createCheckPass(ctx.run, ctx.root, {
        scope: loc.flow.planId, snapshot: () => snapshotKey(ctx), deadline: { now: ctx.now, endsAt: (await ctx.now()) + limit },
        ...(ctx.memo ? { memo: ctx.memo } : {}),
      })
      try {
        for (const task of stopTargets(loc.flow, peek)) checks[task.id] = await pass.runTask(task.acceptance.checks)
      } catch (error) {
        if (error instanceof CheckUnrunnable) return unrunnable(ctx, loc.flow.planId, error)
        throw error
      }
      unverified = (await pass.finish()).unverified
    }
    const event: FlowEvent = { kind: 'stop', stopHookActive: input.stopHookActive, backgroundTasks: input.backgroundTasks, runningAgents: input.runningAgents, checks }
    const decision = await transact(ctx, loc, trace, state => {
      const d = step(ctx, loc.flow, state, event)
      const all = Object.values(checks).flat()
      const entries: Omit<JournalInput, 'at'>[] = journalable(d, state) ? [entryFor(ctx, 'stop', d, all)] : []
      if (unverified > 0) {
        entries.push({
          kind: 'note', event: 'stop', condition: 'checks_unverified',
          detail: `${unverified} check(s) did not get to run within ${Math.round((ctx.stopDeadlineMs ?? STOP_DEADLINE_MS) / 1000)} s: unverified, not failed.`,
        })
      }
      return { state: d.state, entries, value: d }
    })
    const enforce = ctx.mode === 'enforce'
    // A pause is also a block: the lead must hear the reason before the turn ends.
    const blocking = (decision.action === 'block' || decision.action === 'pause') && decision.reason !== ''
    // Waiting on background work never blocks, whatever the policy said.
    const waiting = input.backgroundTasks > 0 || input.runningAgents > 0
    return {
      decision,
      ...(enforce && blocking && !waiting ? { block: `${TAG}: ${decision.reason}` } : {}),
      ...(enforce && (decision.condition === 'budget' || decision.condition === 'complete') ? { notice: `${TAG}: ${decision.reason}` } : {}),
    }
  })
}

// --- task end and reviews ---

/** A work agent (developer or ux) returned for a task: its own checks decide. */
export async function taskEnded(ctx: Ctx, input: { taskId: string; ownershipDenials: number }): Promise<Outcome> {
  return guarded<Outcome>(ctx, 'task end', {}, async trace => {
    const loc = await locate(ctx)
    if (loc.kind !== 'ok') return {}
    trace.planId = loc.flow.planId
    const task = findTask(loc.flow, input.taskId)
    if (!task) return {}
    const peek = await observe(ctx, loc, trace)
    if (!isApproved(peek, loc.hash)) return {}
    const idle = peek.done || peek.paused || peek.stopped
    let checks: CheckResult[] = []
    if (!idle) {
      const pass = await createCheckPass(ctx.run, ctx.root, { scope: loc.flow.planId, snapshot: () => snapshotKey(ctx), ...(ctx.memo ? { memo: ctx.memo } : {}) })
      try { checks = await pass.runTask(task.acceptance.checks) } catch (error) {
        if (error instanceof CheckUnrunnable) return unrunnable(ctx, loc.flow.planId, error)
        throw error
      }
      await pass.finish()
    }
    const event: FlowEvent = { kind: 'taskEnd', taskId: task.id, checks, ownershipDenials: input.ownershipDenials }
    const decision = await transact(ctx, loc, trace, state => {
      const d = step(ctx, loc.flow, state, event)
      return { state: d.state, entries: journalable(d, state) ? [entryFor(ctx, 'taskEnd', d, checks, task.id)] : [], value: d }
    })
    const text = leadText(ctx, decision)
    return { decision, ...(text ? { text } : {}) }
  })
}

export type ReviewInput = {
  taskId: string
  by: Reviewer
  /** The task's end count when the reviewer was spawned. */
  end: number
  /** The reviewer's final text. */
  output: string
  /** The task's files as they were when a QA agent was spawned; a receipt does not outlive a change to them. */
  git?: Snapshot
}

/** A qa or architect agent spawned for a task awaiting its receipt returned. */
export async function reviewed(ctx: Ctx, input: ReviewInput): Promise<Outcome> {
  return guarded<Outcome>(ctx, 'review', {}, async trace => {
    const loc = await locate(ctx)
    if (loc.kind !== 'ok') return {}
    trace.planId = loc.flow.planId
    const task = findTask(loc.flow, input.taskId)
    if (!task) return {}
    const peek = await observe(ctx, loc, trace)
    if (!isApproved(peek, loc.hash)) return {}
    const who = input.by === 'qa' ? 'QA' : 'The architect'
    const lead = (text: string) => (ctx.mode === 'enforce' ? { text: `[${TAG}] ${text}` } : {})
    const refuse = async (condition: string, detail: string, text: string): Promise<Outcome> => {
      await noteQueued(ctx, loc.flow.planId, { kind: 'note', event: 'review', task: task.id, condition, detail: clip(detail, 600) })
      return lead(text)
    }
    if (!peek.awaiting.some(a => a.task === task.id && a.by === input.by)) {
      await noteQueued(ctx, loc.flow.planId, { kind: 'note', event: 'review', task: task.id, condition: 'review_ignored', detail: `${input.by} returned for ${task.id}, which is not awaiting it` })
      return {}
    }
    const parsed = input.by === 'qa' ? parseQa(input.output, task.acceptance.criteria.length) : parseArchitect(input.output)
    if (!parsed.ok) {
      const format = input.by === 'qa' ? 'one `C<n>: pass|fail — <evidence>` line per criterion and a final `QA: pass|fail|blocked`' : 'a final line `REVIEW: pass|fail`'
      return refuse('review_unparseable', parsed.why, `${who}'s answer for task ${task.id} had ${parsed.why}, so it counts as no receipt. Ask ${input.by} again and require ${format}.`)
    }
    if (input.by === 'qa' && input.git) {
      const now = await treeSnapshot(ctx, task.files)
      if (now && !sameTree(input.git, now)) {
        return refuse('qa_void', `the files of ${task.id} differ: ${input.git.dirty} -> ${now.dirty}`,
          `QA's verdict for task ${task.id} is void: the task's files (or an untracked file among them) changed while QA ran. Ask qa again once nothing else is writing them.`)
      }
    }
    const event: FlowEvent = input.by === 'qa'
      ? { kind: 'review', taskId: task.id, end: input.end, by: 'qa', verdict: parsed.verdict as 'pass' | 'fail' | 'blocked', ...(parsed.note ? { note: parsed.note } : {}) }
      : { kind: 'review', taskId: task.id, end: input.end, by: 'architect', verdict: parsed.verdict as 'pass' | 'fail', ...(parsed.note ? { note: parsed.note } : {}) }
    const decision = await transact(ctx, loc, trace, state => {
      const d = step(ctx, loc.flow, state, event)
      return { state: d.state, entries: journalable(d, state) ? [entryFor(ctx, 'review', d, undefined, task.id)] : [], value: d }
    })
    const text = leadText(ctx, decision)
    return { decision, ...(text ? { text } : {}) }
  })
}

// --- spawn ---

export type SpawnCheck = {
  /** The id names a task of the active flow. */
  known: boolean
  kind?: 'work' | 'review' | 'diagnosis'
  by?: Reviewer
  planId?: string
  /** The task's end count now: a reviewer spawned here answers for this delivery. */
  end: number
  /** The task's files, while the flow is live (approved, not paused, stopped or done): what its agent may write. */
  files?: string[]
  /** Set only in enforce: the reason to refuse the spawn. */
  deny?: string
  /** The task's files as they are now, for a QA spawn: its verdict is void if they change before it returns. */
  git?: Snapshot
  /** The approved plan's acceptance criteria of the task, for a QA spawn: the brief must carry them. */
  criteria?: string[]
}

/** What the QA agent is told about the task whatever the lead's brief says: the approved criteria, numbered as it must answer them. */
export function qaCriteriaBrief(taskId: string, criteria: readonly string[]): string {
  return [
    `## Acceptance criteria of task ${taskId} (from the approved plan; they decide your verdict)`,
    ...criteria.map((criterion, index) => `C${index + 1}: ${criterion}`),
    'Answer with one line `C<n>: pass|fail — <evidence>` per criterion above, using these numbers, then a final line `QA: pass|fail|blocked`.',
  ].join('\n')
}

/** Decisions 16 and 17: a `[T]` delegation goes to the task's role; qa and architect only for a receipt the task awaits (or the architect's diagnosis). */
export async function inspectSpawn(ctx: Ctx, input: { taskId: string; agentType: string }): Promise<SpawnCheck> {
  const unknown: SpawnCheck = { known: false, end: 0 }
  return guarded<SpawnCheck>(ctx, 'spawn', unknown, async trace => {
    const loc = await locate(ctx)
    if (loc.kind !== 'ok') return unknown
    trace.planId = loc.flow.planId
    const task = findTask(loc.flow, input.taskId)
    if (!task) return unknown
    const state = await observe(ctx, loc, trace)
    const approved = isApproved(state, loc.hash)
    const live = approved && !state.done && !state.paused && !state.stopped
    const role = input.agentType.replace(/^pantheon:/, '')
    const end = state.ends[task.id] ?? 0
    const base = { known: true, planId: loc.flow.planId, end, ...(live ? { files: [...task.files] } : {}) }
    let kind: SpawnCheck['kind']
    let by: Reviewer | undefined
    let why: { condition: string; reason: string } | undefined
    if (input.agentType.startsWith('pantheon:') && role === task.role) kind = 'work'
    else if (input.agentType.startsWith('pantheon:') && (role === 'qa' || role === 'architect')) {
      if (state.awaiting.some(a => a.task === task.id && a.by === role)) { kind = 'review'; by = role }
      else if (role === 'architect' && diagnosisOpen(loc.flow, state, task)) kind = 'diagnosis'
      else why = { condition: 'spawn_no_receipt', reason: `Task ${task.id} is not waiting for ${role === 'qa' ? 'a QA verdict' : "the architect's review"} now, so ${input.agentType} cannot be spawned for it. [${task.id}] delegations go to pantheon:${task.role}; the flow asks for ${role} only after the task's checks pass and a receipt is due.` }
    } else {
      why = { condition: 'spawn_wrong_role', reason: `Task ${task.id} is a ${task.role} task: delegate it to pantheon:${task.role}, or drop the [${task.id}] prefix if this delegation is not that task's work.` }
    }
    if (why && live) {
      await noteQueued(ctx, loc.flow.planId, {
        kind: 'decision', event: 'spawn', task: task.id, condition: why.condition, reason: clip(why.reason, 600),
        action: ctx.mode === 'enforce' ? 'block' : 'allow', ...(ctx.mode === 'enforce' ? {} : { wouldBe: 'block' as const }),
      })
      if (ctx.mode === 'enforce') return { ...base, deny: `[${TAG}] ${why.reason}` }
    }
    if (!kind) return { ...base }
    const asQa = kind === 'review' && by === 'qa'
    const git = asQa ? await treeSnapshot(ctx, task.files) : undefined
    const criteria = asQa && approved && task.acceptance.criteria.length > 0 ? [...task.acceptance.criteria] : undefined
    return { ...base, kind, ...(by ? { by } : {}), ...(git ? { git } : {}), ...(criteria ? { criteria } : {}) }
  })
}

/**
 * A `[T]` delegation that sets `isolation` would write in another worktree, outside the task's files: refused in enforce
 * (the Agent tool call is where the setting is visible), only journaled in shadow.
 */
export async function inspectIsolation(ctx: Ctx, input: { taskId: string; isolation: string }): Promise<{ deny?: string }> {
  return guarded<{ deny?: string }>(ctx, 'isolation', {}, async trace => {
    const loc = await locate(ctx)
    if (loc.kind !== 'ok') return {}
    trace.planId = loc.flow.planId
    const task = findTask(loc.flow, input.taskId)
    if (!task) return {}
    const state = await observe(ctx, loc, trace)
    if (!(isApproved(state, loc.hash) && !state.done && !state.paused && !state.stopped)) return {}
    const reason = `Task ${task.id} cannot be delegated with isolation "${input.isolation}": its agent would write in another worktree, outside the task's files. Delegate it without isolation.`
    await noteQueued(ctx, loc.flow.planId, {
      kind: 'decision', event: 'spawn', task: task.id, condition: 'spawn_isolation', reason: clip(reason, 600),
      action: ctx.mode === 'enforce' ? 'block' : 'allow', ...(ctx.mode === 'enforce' ? {} : { wouldBe: 'block' as const }),
    })
    return ctx.mode === 'enforce' ? { deny: `[${TAG}] ${reason}` } : {}
  })
}

// --- main-session edits ---

/**
 * A successful main-session edit to a file of a task awaiting a receipt voids what the reviews covered: the earned receipts
 * are cleared and the task's delivery count moves on, so a reviewer already at work answers for older code and is ignored.
 * The task keeps waiting (`awaiting` stays): it needs a new review. In enforce the text for the lead says so.
 */
export async function mainEdit(ctx: Ctx, input: { path: string }): Promise<{ text?: string }> {
  return guarded<{ text?: string }>(ctx, 'main edit', {}, async trace => {
    const loc = await locate(ctx)
    if (loc.kind !== 'ok') return {}
    trace.planId = loc.flow.planId
    const peek = await observe(ctx, loc, trace)
    if (!isApproved(peek, loc.hash) || peek.awaiting.length === 0) return {}
    const base = norm(stripRoot(ctx.root))
    const abs = norm(input.path.startsWith('/') ? input.path : `${base}/${input.path}`)
    if (!within(abs, base) || abs === base) return {}
    const rel = abs.slice(base === '/' ? 1 : base.length + 1)
    const hit = (state: FlowState) => [...new Set(state.awaiting.map(a => a.task))]
      .filter(id => state.status[id] !== 'done' && ownsPath({ files: findTask(loc.flow, id)?.files ?? [] }, rel))
    if (hit(peek).length === 0) return {}
    return transact<{ text?: string }>(ctx, loc, trace, state => {
      const tasks = hit(state)
      if (tasks.length === 0) return { value: {} }
      const waiting = (id: string) => state.awaiting.filter(a => a.task === id).map(a => a.by).join(' and ')
      const earned = (id: string) => Object.keys(state.receipts[id] ?? {})
      const entries: Omit<JournalInput, 'at'>[] = tasks.map(id => ({
        kind: 'note' as const, event: 'edit', task: id, condition: 'receipts_voided',
        detail: `The main session edited ${rel}, a file of ${id}, while it awaited ${waiting(id)}${ctx.mode === 'enforce' ? `: receipts cleared (${earned(id).join(', ') || 'none earned'}), a new review is needed` : ' (shadow: nothing cleared)'}.`,
      }))
      if (ctx.mode !== 'enforce') return { entries, value: {} }
      const next: FlowState = {
        ...state,
        awaiting: state.awaiting.map(a => ({ ...a })),
        ends: { ...state.ends, ...Object.fromEntries(tasks.map(id => [id, (state.ends[id] ?? 0) + 1])) },
        receipts: Object.fromEntries(Object.entries(state.receipts).filter(([id]) => !tasks.includes(id)).map(([id, r]) => [id, { ...r }])),
      }
      const text = `[${TAG}] Your edit to ${rel} changed code that ${tasks.length > 1 ? 'tasks' : 'task'} ${tasks.join(', ')} had delivered for review. ${tasks.map(id => `${id}: receipts invalidated (${earned(id).join(', ') || 'none earned yet'}), still waiting for ${waiting(id)}`).join('; ')}. A review already running answers for the older code and will be ignored: a new QA or review is needed once the code is settled.`
      return { state: next, entries, value: { text } }
    })
  })
}

/** A developer or ux agent tried to write outside its task's files. */
export async function noteOwnership(ctx: Ctx, input: { planId: string; taskId: string; path: string; reason: string }): Promise<void> {
  await guarded<void>(ctx, 'ownership', undefined, async () => {
    await noteQueued(ctx, input.planId, {
      kind: 'decision', event: 'write', task: input.taskId, condition: 'ownership', reason: clip(input.reason, 600),
      action: ctx.mode === 'enforce' ? 'block' : 'allow', ...(ctx.mode === 'enforce' ? {} : { wouldBe: 'block' as const }),
    })
  })
}

// --- human prompts ---

function reinjection(flow: Flow, state: FlowState): string {
  const lines = [`[${TAG}] Goal: ${flow.goal}`]
  const active = flow.tasks.filter(task => state.status[task.id] === 'active')
  for (const task of active) lines.push(`Current task ${task.id} (${task.role}): ${task.goal}. Files: ${task.files.join(', ')}.`)
  const waiting = state.awaiting.filter(a => state.status[a.task] !== 'done')
  if (waiting.length) lines.push(`Waiting for: ${waiting.map(a => `${a.task} (${a.by})`).join(', ')}.`)
  if (state.paused) lines.push('The flow is paused until the person runs /pantheon flow resume.')
  if (state.lastInstruction) lines.push(`Last instruction: ${clip(state.lastInstruction, 600)}`)
  return lines.join('\n')
}

/** The person wrote: the block budget refills, and in enforce the goal, the current task and the last instruction come back. */
export async function humanPrompt(ctx: Ctx): Promise<{ context?: string }> {
  return guarded<{ context?: string }>(ctx, 'human prompt', {}, async trace => {
    const loc = await locate(ctx)
    if (loc.kind !== 'ok') return {}
    trace.planId = loc.flow.planId
    const peek = await observe(ctx, loc, trace)
    const needsRefill = peek.blocks > 0 || peek.consecutiveBlocks > 0
    const approved = isApproved(peek, loc.hash)
    if (!needsRefill && !(approved && !peek.done && !peek.stopped)) return {}
    return transact(ctx, loc, trace, state => {
      const d = step(ctx, loc.flow, state, { kind: 'humanPrompt' })
      const live = isApproved(d.state, loc.hash) && !d.state.done && !d.state.stopped
      return {
        state: d.state,
        entries: journalable(d, state) ? [entryFor(ctx, 'humanPrompt', d)] : [],
        value: ctx.mode === 'enforce' && live ? { context: reinjection(loc.flow, d.state) } : {},
      }
    })
  })
}

// --- commands ---

const short = (hash: string) => hash.slice(0, 12)

/** The newest plan that carries a flow block, or undefined. */
async function newestPlan(ctx: Ctx): Promise<string | undefined> {
  const dir = `${stripRoot(ctx.root)}/${PLANS_DIR}`
  const entries = (await ctx.list(dir)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1))
  for (const entry of entries) {
    const text = await ctx.fs.read(`${dir}/${entry.name}`)
    if (text !== undefined && /^```pantheon-flow/m.test(text)) return `${PLANS_DIR}/${entry.name}`
  }
  return undefined
}

export async function approvePlan(ctx: Ctx, arg?: string): Promise<string> {
  return guarded(ctx, 'approve', 'The flow could not approve the plan (an internal error; see the warning).', async trace => {
    const given = arg?.trim()
    const rel = given ? pointerValue(ctx.root, planFile(ctx.root, given)) : await newestPlan(ctx)
    if (!rel) return `No plan with a \`\`\`pantheon-flow block under ${PLANS_DIR}/. Write one with the brainstorm skill, or pass the plan's path.`
    const text = await ctx.fs.read(planFile(ctx.root, rel))
    if (text === undefined) return `Plan not found: ${rel}`
    if (!/^```pantheon-flow/m.test(text)) return `${rel} has no \`\`\`pantheon-flow block.`
    const parsed = parseFlow(text)
    if (!parsed.ok) return `${rel} is not a valid flow:\n${parsed.errors.map(error => `- ${error}`).join('\n')}`
    const missing = missingRoles(parsed.flow, ctx.available)
    if (missing.length) return `Not approved: the plan needs ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} disabled in the pantheon configuration. Enable ${missing.length > 1 ? 'them' : 'it'} or change the plan.`
    const loc: Located = { path: rel, flow: parsed.flow, hash: parsed.hash }
    await ctx.fs.write(activePath(ctx.root), `${rel}\n`)
    await transact(ctx, loc, trace, state => ({
      state: setApproved(state, parsed.hash),
      entries: [{ kind: 'approval', event: 'approve', condition: 'approved', detail: `approved ${parsed.hash} (${parsed.flow.tasks.length} tasks) from ${rel}` }],
      value: undefined,
    }))
    const commands = [...new Set(parsed.flow.tasks.flatMap(task => task.acceptance.checks.map(check => check.argv.join(' '))))]
    return [
      `Approved ${parsed.flow.planId} (hash ${short(parsed.hash)}, ${parsed.flow.tasks.length} tasks) from ${rel}. Mode: ${ctx.mode}.`,
      commands.length ? `Approving the plan approves its checks; they run on this machine:\n${commands.slice(0, 12).map(command => `- ${command}`).join('\n')}${commands.length > 12 ? `\n- ... and ${commands.length - 12} more` : ''}` : 'The plan declares no check commands.',
      ctx.mode === 'enforce' ? 'The flow is enforced from now on.' : 'Shadow: the flow only journals what enforce would do.',
    ].join('\n')
  })
}

export async function controlFlow(ctx: Ctx, action: 'pause' | 'resume' | 'stop'): Promise<string> {
  return guarded(ctx, action, 'The flow could not do that (an internal error; see the warning).', async trace => {
    const loc = await locate(ctx)
    if (loc.kind === 'none') return 'No active flow. Approve one with /pantheon flow approve.'
    if (loc.kind === 'invalid') return `The active plan is not valid:\n${loc.errors.map(error => `- ${error}`).join('\n')}`
    const label = { pause: 'paused', resume: 'resumed', stop: 'stopped' }[action]
    const result = await transact(ctx, loc, trace, state => {
      if (action === 'pause') return { state: { ...state, paused: true }, entries: [{ kind: 'note', event: 'command', condition: 'command_pause', detail: 'paused by the person' }], value: true }
      if (action === 'stop') return { state: { ...state, stopped: true, paused: false }, entries: [{ kind: 'note', event: 'command', condition: 'command_stop', detail: 'stopped by the person' }], value: true }
      // A resume starts the attempts and the failure loop over: the person has decided how to go on.
      const attempts = Object.fromEntries(Object.entries(state.attempts).filter(([id]) => state.status[id] === 'done'))
      const next: FlowState = { ...state, paused: false, stopped: false, attempts, consecutiveBlocks: 0 }
      delete next.lastFailure
      return { state: next, entries: [{ kind: 'note', event: 'command', condition: 'command_resume', detail: 'resumed by the person' }], value: true }
    })
    return result ? `Flow ${loc.flow.planId} ${label}.` : 'Nothing changed.'
  })
}

/** The task files of the approved plan, for links that were made before its edits were adopted (after a resume). */
export async function flowTaskFiles(ctx: Ctx): Promise<{ planId: string; files: Record<string, string[]> } | undefined> {
  return guarded<{ planId: string; files: Record<string, string[]> } | undefined>(ctx, 'task files', undefined, async () => {
    const loc = await locate(ctx)
    if (loc.kind !== 'ok') return undefined
    const state = (await prepare(ctx, loc)).state
    if (!isApproved(state, loc.hash)) return undefined
    return { planId: loc.flow.planId, files: Object.fromEntries(loc.flow.tasks.map(task => [task.id, [...task.files]])) }
  })
}

export async function flowStatus(ctx: Ctx): Promise<string> {
  try {
    const head = `Pantheon flow: ${ctx.mode}`
    if (ctx.mode === 'off') return `${head}. Set the plugin option flow to shadow or enforce to use it.`
    const loc = await locate(ctx)
    if (loc.kind === 'none') return `${head}. No active flow; approve a plan with /pantheon flow approve.`
    if (loc.kind === 'invalid') return `${head}. The active plan ${loc.path} is not valid, so nothing is enforced:\n${loc.errors.map(error => `- ${error}`).join('\n')}`
    const { flow, hash } = loc
    const state = (await prepare(ctx, loc)).state
    const approved = isApproved(state, hash)
    // An edited plan's approval is cleared once the first event sees it, so what was approved is also read from the journal.
    const before = (await loadState(ctx.fs, ctx.root, flow.planId))?.approvedHash
    const history = (await readJournal(ctx.fs, ctx.root, flow.planId)).filter(entry => entry.condition === 'approved' || entry.condition === 'plan_edited')
    const edited = (before !== undefined && before !== hash) || history.at(-1)?.condition === 'plan_edited'
    const lines = [
      head,
      `Plan: ${loc.path} (${flow.planId}), ${flow.tasks.length} tasks`,
      `Approval: ${approved ? `approved (hash ${short(hash)})` : edited ? `NOT approved: the plan changed after it was approved (now hash ${short(hash)}); run /pantheon flow approve` : `NOT approved (hash ${short(hash)}); run /pantheon flow approve`}`,
      `State: ${state.done ? 'done' : state.stopped ? 'stopped' : state.paused ? 'paused' : 'running'}`,
      'Tasks:',
    ]
    for (const task of flow.tasks) {
      const parts: string[] = [state.status[task.id] ?? 'pending', task.role]
      if (task.risk) parts.push('risk')
      if (task.sideEffect) parts.push('side effect')
      const waiting = state.awaiting.filter(a => a.task === task.id).map(a => a.by)
      if (waiting.length && state.status[task.id] !== 'done') parts.push(`awaiting ${waiting.join(' + ')}`)
      const earned = Object.keys(state.receipts[task.id] ?? {})
      if (earned.length) parts.push(`receipts ${earned.join(' + ')}`)
      const attempts = state.attempts[task.id]
      if (attempts) parts.push(`attempts ${attempts}/${task.loop?.maxIterations ?? flow.limits.maxAttempts}`)
      lines.push(`  ${task.id}: ${parts.join(', ')}`)
    }
    lines.push(`Budget: ${state.blocks}/${flow.limits.maxBlocks} blocks, ${state.consecutiveBlocks} in a row`)
    const last = (await readJournal(ctx.fs, ctx.root, flow.planId)).filter(entry => entry.kind === 'decision').pop()
    if (last) lines.push(`Last decision: ${last.event ?? '?'} ${last.action ?? ''} ${last.condition ?? ''}${last.task ? ` (${last.task})` : ''}${last.wouldBe ? `, enforce would ${last.wouldBe}` : ''} at ${new Date(last.at).toISOString()}`)
    return lines.join('\n')
  } catch (error) {
    return `Pantheon flow: ${ctx.mode}. The status could not be read: ${message(error)}`
  }
}
