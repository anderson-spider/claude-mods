// The flow controller: finds the active flow, loads or creates its state, asks the policy for a decision, applies the
// mode, saves and journals, and tells the host what to do. Pure orchestration: every host access (files, commands,
// clock, the config's enabled roles) arrives in `Ctx`, and the module never touches `$`.
//
// Rules this module keeps:
// - Fail open. Any internal error (corrupt files, a failing file system or clock) allows and is warned and journaled when
//   possible; nothing here throws into the engine.
// - Nothing unapproved runs. The checks of a plan run only for the effective flow: what the person approved
//   (`approved.json`) plus the amendments `amend` adopted over it. An edit of the plan file never switches enforcement off
//   and never widens it: the controller keeps running the snapshot, and whatever the allowlist does not let in waits for
//   `/pantheon flow approve`. A plan file that does not parse changes nothing (fail open on the edit, not on enforcement).
// - The repository's files are not the approval. `approved.json` and `state.json` are plain files that any edit can write, so
//   a snapshot is believed only while the plugin's store (`Ctx.attest`, outside the repository) holds a record of exactly it,
//   written by `approvePlan` and by an adoption, and the plan in force is the one that store names, not the pointer file. A
//   snapshot that is missing, edited or unattested is never run and never forgotten: the flow stays approved in the state,
//   says so (a Stop is held once per prompt in enforce), and waits for the person's approve, which lists what it would run.
// - Every write to a plan's files (state, journal, ledger) is one job on that plan's serial queue. Long work (running
//   checks, git) happens before the job, so a hook waiting for the queue never waits for a command.
// - Shadow decides exactly as enforce and applies `applyMode`: it journals what enforce would have done and returns
//   nothing for the host to act on. Off never reaches this module's work; every entry point returns at once.

import { amend, branchOnly, canonical, eligible, extractBlock, findTask, flowHash, ownsPath, parseFlow, sha256 } from './plan'
import type { Amendment, Flow, FlowTask, ParseResult } from './plan'
import { CheckUnrunnable, createCheckPass } from './checks'
import type { CheckMemo, Runner } from './checks'
import { parseArchitect, parseQa } from './verdicts'
import { CONSECUTIVE_CAP, applyMode, decide, newState, rebase, withMode } from './policy'
import type { ModeDecision } from './policy'
import { retryEscalation, taskEndEscalation } from './escalate'
import type { JudgeResult } from './judge'
import type { JudgeAccess } from './judging'
import { QUESTION_SET_HASH, THRESHOLDS, checkpoint } from './questions'
import type { Thresholds } from './questions'
import { redact, tail } from './redact'
import type { RedactContext } from './redact'
import {
  activeKey, appendJournal, approve as setApproved, attestKey, attestOf, isApproved, loadApproved, loadState, matchesAttest, parseActive,
  parseAttest, readJournal, readSideEffects, recordSideEffect, restoreFromLedger, saveApproved, saveState, statePath, unapprove,
} from './store'
import type { ApprovedFile, AttestRecord, FlowFs, JournalInput, JournalKind, JudgeRecord } from './store'
import { LAST_OUTPUT_MAX, LAST_OUTPUT_TASKS_MAX, SEEN_EDITS_MAX, SEEN_IDS_MAX, remember } from './types'
import type { CheckResult, DecideOptions, Decision, FlowEvent, FlowState, Mode, Reviewer } from './types'

export type Serial = <T>(work: () => Promise<T>) => Promise<T>
/** Which roles the live configuration offers. */
export type Available = { developer: boolean; ux: boolean; architect: boolean; qa: boolean }

/**
 * The plugin's own key-value store (`$.store`): outside the repository, so no write of the plan, the state or the journal
 * reaches it (a Bash call or a Write to its file does: that boundary is the person's permission rules, see store.ts). The
 * controller keeps the record of an approval there, and the plan in force; see `AttestRecord`.
 */
export type Attest = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
}

export type Ctx = {
  fs: FlowFs
  run: Runner
  now: () => Promise<number>
  /** The repository root, as its real path (links resolved: two spellings of it are one repository); every path of a plan is relative to it. */
  root: string
  mode: Mode
  available: Available
  /** One queue per plan: `createSerial()` from the store, kept by the host across hooks. */
  serial: (planId: string) => Serial
  /** Check results by tree snapshot, kept by the host across hooks; without it every check runs every time. */
  memo?: CheckMemo
  /** The time a Stop may spend running checks; STOP_DEADLINE_MS when absent. */
  stopDeadlineMs?: number
  /**
   * Where the approval and the plan in force are recorded: the plugin's store, outside the repository. Required: without it
   * the files would be all there is, and a file anyone can write cannot say what the person approved.
   */
  attest: Attest
  /**
   * The judge (decisions 10 and 18); absent while the plugin option `judge` is off or no key is set, and then nothing leaves
   * the machine and every decision is the policy's alone. It is asked at most once per event, outside the plan's queue (a
   * request is long work), and only where the first decision depends on its answer.
   */
  judge?: JudgeAccess
  /** Called when the controller fails open or notices something the person should know; never throws into the controller. */
  warn: (text: string) => void
}

/** What a task end or a review leaves for the host: text for the lead (enforce only) and the decision for tests and the journal. */
export type Outcome = { text?: string; decision?: ModeDecision }
export type StopOutcome = { block?: string; notice?: string; /** Text for the lead that is not a block: what the Stop could not verify. */ context?: string; decision?: ModeDecision }
export type Snapshot = { head: string; dirty: string }

/** A Stop evaluation that runs checks gives up starting new ones after this long; those are unverified, never failed. */
export const STOP_DEADLINE_MS = 120_000
/** More untracked files than this are listed in a snapshot but their content is not read. */
const UNTRACKED_HASH_CAP = 300

export const ACTIVE_FILE = '.pantheon/flow/active'
/**
 * Beside the pointer: `{ plan, planId }` for the plan file the pointer names. The plan file's own `planId` may be edited, and
 * the approved snapshot must stay reachable (it lives under the id it was approved with). Not a plan id's name: it has a dot.
 */
export const ACTIVE_META_FILE = '.pantheon/flow/active.json'
const PLAN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
export const PLANS_DIR = '.pantheon/plans'
/** The Stop block reasons and the verdict text lead with this tag so the lead knows where they come from. */
const TAG = 'Pantheon flow'
/** Conditions whose reason is bookkeeping, not an instruction. */
const QUIET = new Set(['unapproved', 'already_done', 'paused', 'stopped', 'refill'])
/** What an edit waiting for approval is told to do, in every message that mentions one. */
const APPROVE = '/pantheon flow approve'

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

export function activeMetaPath(root: string): string {
  return `${stripRoot(root)}/${ACTIVE_META_FILE}`
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

/**
 * Never a task's, whatever its `files` match (lower case: the usual file systems fold it). All of `.pantheon` is in it, the
 * plans included: a task whose pattern is `**\/*.md` would otherwise own the plan, edit it, and have the additive edit adopted
 * without the lead (a plan is the lead's, from the main session, which is not held to ownership).
 */
const NEVER_OWNED = ['.pantheon', '.git', '.claude']

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
  never: readonly string[] = [],
): { owned: true } | { owned: false; rel?: string; reason: string } {
  const base = norm(stripRoot(root))
  const abs = norm(rawPath.startsWith('/') ? rawPath : `${base}/${rawPath}`)
  // Directories outside the repository that hold what the flow trusts (the plugin's store): not a task's, wherever the root is.
  const forbidden = never.find(dir => within(abs.normalize('NFC').toLowerCase(), norm(dir).normalize('NFC').toLowerCase()))
  if (forbidden !== undefined) {
    return { owned: false, reason: `${abs} holds what the flow trusts (the plugin's store): it is not a task's to write. Do not write it; tell the lead what has to change there.` }
  }
  if (scratchpadOf(scratch)?.test(abs)) return { owned: true }
  const rel = within(abs, base) && abs !== base ? abs.slice(base === '/' ? 1 : base.length + 1) : undefined
  // The flow's own files, the repository's git data and the agent configuration are written by the controller, git and the
  // person: no task owns them, whatever its patterns match (a plan cannot list them, but `**` reaches them).
  const folded = rel?.normalize('NFC').toLowerCase()
  if (rel !== undefined && folded !== undefined && NEVER_OWNED.some(dir => folded === dir || folded.startsWith(`${dir}/`))) {
    return { owned: false, rel, reason: `${rel} is not a task's to write: it belongs to the flow controller, git or the agent configuration. Do not write it; tell the lead what has to change there.` }
  }
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

/** A moment the snapshot's git calls must not run past: each is cut to the time left, and none starts after it. */
type Until = { now: () => Promise<number>; endsAt: number }
/** More files than this under a task's paths are digested by the diff instead of one by one. */
const FILES_HASH_CAP = 2000

/**
 * HEAD and a digest of the working tree, as git computes it (the diff can be megabytes).
 *
 * Without `files`, the whole tree outside `.pantheon/`: `git diff HEAD` plus the untracked files' names and, up to a cap,
 * their content. That is what a check's result is reused under.
 *
 * With `files` (a task's paths) the digest is of what those paths hold now: the names git lists for them (tracked or not),
 * the ones deleted, and the content of each, so an unrelated commit, a change elsewhere, or a commit of these very files
 * (content unchanged) does not move it. Past FILES_HASH_CAP files it falls back to the diff.
 *
 * Undefined when git cannot tell (not a repository, no commit, out of time).
 */
export async function treeSnapshot(ctx: Pick<Ctx, 'run' | 'root'>, files?: readonly string[], until?: Until): Promise<Snapshot | undefined> {
  try {
    const run = async (argv: string[], stdin?: string) => {
      let timeoutMs = 30_000
      if (until) {
        const left = until.endsAt - (await until.now())
        if (left <= 0) throw new Error('out of time')
        timeoutMs = Math.min(timeoutMs, left)
      }
      return ctx.run(argv, { cwd: ctx.root, timeoutMs, ...(stdin === undefined ? {} : { stdin }) })
    }
    const scoped = files !== undefined && files.length > 0
    const specs = scoped ? [...files] : ['.', ':(exclude).pantheon']
    const head = await run(['git', 'rev-parse', 'HEAD'])
    if (head.exitCode !== 0) return undefined
    const hashPaths = async (names: string[]): Promise<string> => {
      const hashable = names.filter(name => !name.includes('\n'))
      if (hashable.length === 0) return ''
      const hashed = await run(['git', 'hash-object', '--stdin-paths'], `${hashable.join('\n')}\n`)
      return hashed.exitCode === 0 ? hashed.stdout : ''
    }
    const parts: string[] = []
    let byContent = false
    if (scoped) {
      const listed = await run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...specs])
      const gone = await run(['git', 'ls-files', '-z', '--deleted', '--', ...specs])
      if (listed.exitCode !== 0 || gone.exitCode !== 0) return undefined
      const deleted = new Set(gone.stdout.split('\0').filter(Boolean))
      const names = [...new Set(listed.stdout.split('\0').filter(Boolean))].filter(name => !deleted.has(name)).sort()
      if (names.length <= FILES_HASH_CAP) {
        byContent = true
        parts.push(names.join('\n'), [...deleted].sort().join('\n'), await hashPaths(names))
      }
    }
    if (!byContent) {
      const diff = await run(['git', 'diff', '--no-ext-diff', '--no-color', 'HEAD', '--', ...specs])
      const others = await run(['git', 'ls-files', '-z', '--others', '--exclude-standard', '--', ...specs])
      if (diff.exitCode !== 0 || others.exitCode !== 0) return undefined
      const names = others.stdout.split('\0').filter(name => name && !(!scoped && name.startsWith('.pantheon/'))).sort()
      parts.push(diff.stdout, names.join('\n'), names.length <= UNTRACKED_HASH_CAP ? await hashPaths(names) : '')
    }
    const digest = await run(['git', 'hash-object', '--stdin'], parts.join('\0'))
    if (digest.exitCode !== 0) return undefined
    return { head: head.stdout.trim(), dirty: digest.stdout.trim().slice(0, 16) }
  } catch { return undefined }
}

const snapshotKey = async (ctx: Pick<Ctx, 'run' | 'root'>, until?: Until): Promise<string | undefined> => {
  const snapshot = await treeSnapshot(ctx, undefined, until)
  return snapshot ? `${snapshot.head}:${snapshot.dirty}` : undefined
}

// --- locating and loading ---

/** What the plan file says compared with the flow in force. */
type Edit =
  | { kind: 'same' }
  | { kind: 'changed'; flow: Flow; hash: string; implicit: string[] }
  | { kind: 'invalid'; key: string; errors: string[] }

type Located = {
  /** The plan file as the pointer names it. */
  path: string
  planId: string
  /**
   * The flow the controller runs: the approved snapshot (with what was adopted), or the plan file's own flow while nothing is
   * approved for it. The file may say more than this; `edit` says what.
   */
  flow: Flow
  hash: string
  /** An approved, attested snapshot stands for the plan: `flow` is it and is enforced (while the state is not paused, stopped or done). */
  approved: boolean
  /** What the plugin store attests, when `approved`. */
  record?: AttestRecord
  edit: Edit
}
/**
 * `tampered`: the plan was approved, and what stands for that approval cannot be believed (the snapshot is missing,
 * unreadable or not the one the host attested, or the state records an approval that was never attested). None of its
 * commands run and nothing is forgotten: the person approves again.
 */
type Tampered = { kind: 'tampered'; path: string; /** Undefined when nothing names the plan (the store is unreadable and no pointer file exists). */ planId?: string; why: string }
type Locate = { kind: 'none' } | { kind: 'invalid'; path: string; errors: string[] } | Tampered | ({ kind: 'ok' } & Located)
type Trace = { planId?: string }
type Note = { kind: JournalKind; condition: string; detail: string; approvedHash?: string; adoptedHash?: string }

/** Everything a decision starts from: the flow in force (after what was just adopted), its state and what is left to journal. */
type Prepared = {
  flow: Flow
  hash: string
  state: FlowState
  approved: boolean
  onDisk: string | undefined
  /** Journaled before the state is saved (a rejected state file is on record before it is replaced). */
  notes: Note[]
  /** Journaled after: the plan edits this call saw. */
  edits: Note[]
  ledger: string[]
  /** `approved.json` to write, and the record that attests it: the record goes to the plugin store first. */
  snapshot?: ApprovedFile
  attest?: AttestRecord
  /** Why the plan file's edit waits for approval; set whenever one is waiting, journaled or not. */
  pending?: string[]
  /** The errors of a plan file that does not validate. */
  invalid?: string[]
  /** What was adopted by this call, for the lead. */
  adopted?: string
  /** The tasks adopted over the approval (the lead's text, not the person's). */
  adoptedTasks: string[]
}

/** Whether the flow in force is enforced for this prepared state. */
const enforcing = (p: Pick<Prepared, 'approved' | 'state' | 'hash'>): boolean => p.approved && isApproved(p.state, p.hash)

const TAMPERED = `the approved snapshot changed outside ${APPROVE}`
/** What `flowStatus` holds an adoptable edit for: it reads, it does not adopt. */
const SOON = 'it is purely additive and the next event adopts it'

async function readMeta(ctx: Pick<Ctx, 'fs' | 'root'>, rel: string): Promise<string | undefined> {
  const text = await ctx.fs.read(activeMetaPath(ctx.root))
  if (text === undefined) return undefined
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return undefined
    const meta = raw as { plan?: unknown; planId?: unknown }
    return meta.plan === rel && typeof meta.planId === 'string' && PLAN_ID.test(meta.planId) ? meta.planId : undefined
  } catch { return undefined }
}

/**
 * Whether anything of a flow was ever kept in this repository: `.pantheon/flow/` is there (a plan's directory, a journal, a
 * state, an approved.json or the pointer). `FlowFs.read` answers undefined only for a path that does not exist, and a directory
 * is not a file it can read, so anything but undefined (the text of a file by that name, a rejection) is the path being there:
 * a read that fails for any reason counts as present, the safe way round.
 */
async function flowKept(ctx: Pick<Ctx, 'fs' | 'root'>): Promise<boolean> {
  try { return (await ctx.fs.read(`${stripRoot(ctx.root)}/.pantheon/flow`)) !== undefined } catch { return true }
}

/**
 * The plan in force for this repository: the plan file and the id it was approved under. The plugin's store says it (written
 * by `approvePlan`), so deleting or redirecting the pointer file changes nothing; a repository approved before the store held
 * it falls back to the pointer file (and its id file, then the id in the plan file itself).
 */
async function planInForce(ctx: Pick<Ctx, 'fs' | 'root' | 'attest'>): Promise<{ rel?: string; planId?: string; stored: boolean; unreadable?: string } | undefined> {
  // A store that cannot be read names no plan, and the pointer file is not a substitute for it (it is what a redirect would
  // write): the caller holds the plan, with no check run, the way it holds a snapshot that is not attested.
  let stored: ReturnType<typeof parseActive>
  let unreadable: string | undefined
  try { stored = parseActive(await ctx.attest.get(activeKey(ctx.root))) } catch (error) { stored = undefined; unreadable = message(error) }
  if (stored) return { rel: stored.plan, planId: stored.planId, stored: true }
  const pointer = await ctx.fs.read(activePath(ctx.root))
  const rel = pointer?.split('\n')[0]?.trim()
  // No pointer file either: with the store readable that is no plan. With it unreadable it is a plan nobody can name when a
  // flow was kept here (a missing pointer is what a deletion leaves, so it is not "none": the caller holds it), and no plan
  // at all in a repository that never had one.
  if (!rel) return unreadable !== undefined && await flowKept(ctx) ? { stored: false, unreadable } : undefined
  return { rel, ...(await readMeta(ctx, rel).then(id => (id ? { planId: id } : {}))), stored: false, ...(unreadable !== undefined ? { unreadable } : {}) }
}

/** The id of the plan in force: the one it was approved under, or the plan file's own. Undefined when there is none. */
export async function activePlanId(ctx: Pick<Ctx, 'fs' | 'root' | 'attest'>): Promise<string | undefined> {
  const found = await planInForce(ctx)
  if (!found) return undefined
  if (found.planId) return found.planId
  if (found.rel === undefined) return undefined
  const text = await ctx.fs.read(planFile(ctx.root, found.rel))
  const parsed = text === undefined ? undefined : parseFlow(text)
  return parsed?.ok ? parsed.flow.planId : undefined
}

type Standing =
  | { status: 'approved'; planId: string; flow: Flow; record: AttestRecord }
  | { status: 'none'; planId: string }
  | { status: 'tampered'; planId: string; why: string }

/**
 * Whether a plan id stands approved: the store's record exists and the snapshot is exactly what it names. The state does not
 * decide it: it is progress, and a lost or forged one is brought back to the approval, never the other way round.
 */
async function standing(ctx: Pick<Ctx, 'fs' | 'root' | 'attest'>, planId: string): Promise<Standing> {
  const state = await loadState(ctx.fs, ctx.root, planId)
  const snapshot = await loadApproved(ctx.fs, ctx.root, planId)
  let record: AttestRecord | undefined
  // A store that cannot be read says nothing: the approval is then unattested (held, never believed), not an error to fail open on.
  let unreadable: string | undefined
  try { record = parseAttest(await ctx.attest.get(attestKey(ctx.root, planId))) } catch (error) { unreadable = message(error) }
  if (!record) {
    if (unreadable !== undefined && (state?.approvedHash !== undefined || snapshot.kind !== 'missing')) {
      return { status: 'tampered', planId, why: `the plugin store that attests the approval could not be read (${clip(unreadable, 120)})` }
    }
    return state?.approvedHash !== undefined
      ? { status: 'tampered', planId, why: 'nothing attests the approval this state records (it predates attestation, or the plugin store was cleared)' }
      : { status: 'none', planId }
  }
  if (snapshot.kind === 'missing') return { status: 'tampered', planId, why: 'approved.json is missing' }
  if (snapshot.kind === 'invalid') return { status: 'tampered', planId, why: snapshot.why }
  if (!matchesAttest(snapshot.approved, record)) return { status: 'tampered', planId, why: 'approved.json is not the flow that was attested' }
  return { status: 'approved', planId, flow: snapshot.approved.flow, record }
}

async function locate(ctx: Ctx): Promise<Locate> {
  const inForce = await planInForce(ctx)
  if (!inForce) return { kind: 'none' }
  if (inForce.rel === undefined) {
    // The store that says which plan is in force cannot be read and no pointer file names one: nothing can be said of a plan,
    // and nothing may be taken for "no plan". It is held the way an unattested snapshot is, with no check run.
    return { kind: 'tampered', path: '', why: `the plugin store that names the plan in force could not be read (${clip(inForce.unreadable ?? 'no reason given', 120)}) and no pointer file names a plan` }
  }
  const { rel } = inForce
  const path = planFile(ctx.root, rel)
  const text = await ctx.fs.read(path)
  const parsed: ParseResult = text === undefined ? { ok: false, errors: [`the plan file ${rel} does not exist`] } : parseFlow(text)
  const fileId = parsed.ok ? parsed.flow.planId : undefined
  if (inForce.unreadable !== undefined) {
    // The store that says which plan is in force cannot be read: nothing of the pointer file may stand in for it. The plan the
    // pointer files point at is held (the id is the best there is), and nothing of it runs.
    const planId = inForce.planId ?? fileId
    if (planId) return { kind: 'tampered', path: rel, planId, why: `the plugin store that names the plan in force could not be read (${clip(inForce.unreadable, 120)})` }
  }

  // The id the plan was approved under is the plan; the file's own id is only used when nothing was approved under the
  // other, so editing the id in the file can neither hide an approval nor lose its snapshot. When the store names the plan
  // there is no other: what the file says about itself is an edit like any other.
  let found = inForce.planId ? await standing(ctx, inForce.planId) : undefined
  if (!inForce.stored && (!found || found.status === 'none') && fileId !== undefined && fileId !== found?.planId) found = await standing(ctx, fileId)
  if (!found) return { kind: 'invalid', path: rel, errors: parsed.ok ? [] : parsed.errors }
  if (found.status === 'tampered') return { kind: 'tampered', path: rel, planId: found.planId, why: found.why }
  let flow: Flow
  if (found.status === 'approved') flow = found.flow
  else if (parsed.ok) flow = parsed.flow
  else return { kind: 'invalid', path: rel, errors: parsed.errors }
  const hash = flowHash(flow)
  let edit: Edit = { kind: 'same' }
  if (found.status === 'approved') {
    if (!parsed.ok) {
      const block = text === undefined ? undefined : extractBlock(text)
      edit = { kind: 'invalid', key: sha256(`${block && 'json' in block ? block.json : ''}\n${parsed.errors.join('\n')}`), errors: parsed.errors }
    } else if (parsed.hash !== hash) edit = { kind: 'changed', flow: parsed.flow, hash: parsed.hash, implicit: parsed.implicit }
  }
  return {
    kind: 'ok', path: rel, planId: found.planId, flow, hash, approved: found.status === 'approved', edit,
    ...(found.status === 'approved' ? { record: found.record } : {}),
  }
}

/** A short account of what an adoption added, for the journal and the lead. */
function summarize(before: Flow, after: Flow): string {
  const had = new Map(before.tasks.map(task => [task.id, task]))
  const parts: string[] = []
  const added = after.tasks.filter(task => !had.has(task.id)).map(task => task.id)
  if (added.length) parts.push(`new ${added.length === 1 ? 'task' : 'tasks'} ${added.join(', ')}`)
  for (const task of after.tasks) {
    const old = had.get(task.id)
    if (!old) continue
    const checks = task.acceptance.checks.length - old.acceptance.checks.length
    const criteria = task.acceptance.criteria.length - old.acceptance.criteria.length
    if (checks > 0) parts.push(`${checks} more ${checks === 1 ? 'check' : 'checks'} on ${task.id}`)
    if (criteria > 0) parts.push(`${criteria} more ${criteria === 1 ? 'criterion' : 'criteria'} on ${task.id}`)
    if (task.risk && !old.risk) parts.push(`${task.id} is now risk`)
  }
  return parts.join('; ') || 'no visible change'
}

/**
 * The saved state for `flow` (or a fresh one, with a note when the saved file failed validation) with the ledger applied.
 * A state from before `seenIds` is seeded with every id the journal and the ledger remember, once.
 */
async function baseState(ctx: Ctx, planId: string, flow: Flow, hash: string): Promise<{ state: FlowState; onDisk: string | undefined; notes: Note[]; ledger: string[] }> {
  const notes: Note[] = []
  let state = await loadState(ctx.fs, ctx.root, planId)
  // Compared by content: key order never decides whether a state is written again.
  const onDisk = state ? canonical(state) : undefined
  if (!state) {
    if ((await ctx.fs.read(statePath(ctx.root, planId))) !== undefined) {
      notes.push({ kind: 'note', condition: 'state_invalid', detail: 'state.json failed validation; a fresh state replaces it and the approved flow starts its tasks over.' })
    }
    state = newState(flow, hash)
  }
  const ledger = await readSideEffects(ctx.fs, ctx.root, planId)
  state = restoreFromLedger(state, ledger, flow.tasks.map(task => task.id))
  if (state.seenIds === undefined) {
    const journal = await readJournal(ctx.fs, ctx.root, planId)
    state = { ...state, seenIds: remember(undefined, [...journal.flatMap(entry => (entry.task ? [entry.task] : [])), ...ledger.map(entry => entry.taskId), ...flow.tasks.map(task => task.id)], SEEN_IDS_MAX) }
  }
  if (!onDisk && !flow.tasks.some(task => state!.status[task.id] === 'active')) {
    const first = eligible(flow, state.status)[0]
    if (first) state = { ...state, status: { ...state.status, [first]: 'active' } }
  }
  return { state, onDisk, notes, ledger: ledger.map(entry => entry.taskId) }
}

// What `amend` said about an edit, kept for the process: its cost grows with the plan, and it runs on every event while an
// edit waits. The key holds everything the verdict depends on, so it is never answered from another situation.
const VERDICTS = new Map<string, Amendment>()
const VERDICTS_MAX = 32
/** For tests: how many verdicts the process remembers. */
export const verdictCache = { get size() { return VERDICTS.size }, clear: () => VERDICTS.clear() }

function judge(flow: Flow, state: FlowState, edit: Extract<Edit, { kind: 'changed' }>, seen: readonly string[]): Amendment {
  const progress = canonical({
    s: state.status, a: state.attempts, e: state.ends, w: state.awaiting,
    r: Object.keys(state.receipts).sort(),
  })
  const key = [flowHash(flow), edit.hash, progress, [...seen].sort().join(','), edit.implicit.join(',')].join('\n')
  const known = VERDICTS.get(key)
  if (known) return known
  const verdict = amend(flow, edit.flow, state, { seenIds: seen }, edit.implicit)
  if (VERDICTS.size >= VERDICTS_MAX) VERDICTS.clear()
  VERDICTS.set(key, verdict)
  return verdict
}

/**
 * The state as the next decision sees it, read-only: the saved state (or a fresh one, with a note when the saved file
 * failed validation), the ledger applied, the flow in force and the plan file's edit settled against it, and the mode
 * recorded. An edit is adopted only when `amend` says it is purely additive; anything else is `pending` and changes nothing
 * here. `hold` makes an adoptable edit wait for that reason (the job could not record it). Safe outside the queue; only
 * `transact` writes it back.
 */
async function prepare(ctx: Ctx, loc: Located, hold?: string): Promise<Prepared> {
  const edits: Note[] = []
  let flow = loc.flow
  let hash = loc.hash
  const base = await baseState(ctx, loc.planId, flow, hash)
  const { notes, onDisk, ledger } = base
  let state = base.state
  if (!loc.approved) state = unapprove(state)
  else if (loc.record && state.approvedHash !== loc.record.approvedHash) {
    // The approval is the host's record and the snapshot; a state that lost it, or carries another, is brought back to it.
    state = { ...state, approvedHash: loc.record.approvedHash }
  }
  if (state.hash !== hash) {
    // For an approved plan this is a write that was cut short (the record and the snapshot are written before the state):
    // the state is brought up to the snapshot, never the other way round.
    if (loc.approved && onDisk !== undefined) notes.push({ kind: 'note', condition: 'plan_rebased', detail: 'The state was behind the approved flow (an interrupted write): its progress was carried over to it.' })
    state = rebase(flow, state)
  } else if (loc.approved) {
    // The adoption the state records is derived from the snapshot, never trusted from a file that could lag it.
    const want = state.approvedHash !== undefined && state.approvedHash !== hash ? hash : undefined
    if (state.adoptedHash !== want) {
      state = { ...state }
      if (want) state.adoptedHash = want
      else delete state.adoptedHash
    }
  }
  state = { ...state, seenIds: remember(state.seenIds, flow.tasks.map(task => task.id), SEEN_IDS_MAX) }

  let snapshot: ApprovedFile | undefined
  let attest: AttestRecord | undefined
  let pending: string[] | undefined
  let invalid: string[] | undefined
  let adopted: string | undefined
  let adoptedTasks = loc.record?.adopted ?? []
  const edit = loc.edit
  if (loc.approved && edit.kind === 'changed') {
    const seen = [...(state.seenIds ?? []), ...ledger]
    const verdict = judge(flow, state, edit, seen)
    let reasons: string[]
    if ('pending' in verdict) reasons = verdict.pending
    else if (hold !== undefined) reasons = [hold]
    else {
      // A role the new work needs, that the configuration disabled, is what approval refuses: it waits for approval too.
      const already = missingRoles(flow, ctx.available)
      reasons = missingRoles(verdict.adopt, ctx.available).filter(role => !already.includes(role))
        .map(role => `the edit needs ${role}, which is disabled in the pantheon configuration`)
    }
    if ('adopt' in verdict && reasons.length === 0) {
      const next = verdict.adopt
      const nextHash = flowHash(next)
      adopted = summarize(flow, next)
      const approvedHash = state.approvedHash!
      const had = new Set(flow.tasks.map(task => task.id))
      adoptedTasks = [...new Set([...adoptedTasks, ...next.tasks.map(task => task.id).filter(id => !had.has(id))])]
      state = rebase(next, state)
      state = { ...state, seenIds: remember(state.seenIds, next.tasks.map(task => task.id), SEEN_IDS_MAX) }
      snapshot = { approvedHash, ...(nextHash !== approvedHash ? { adoptedHash: nextHash } : {}), flow: next }
      attest = attestOf(snapshot, adoptedTasks)
      edits.push({
        kind: 'amendment', condition: 'amendment_adopted', approvedHash, adoptedHash: nextHash,
        detail: `adopted ${nextHash} over the approved ${approvedHash}: ${adopted}`,
      })
      flow = next
      hash = nextHash
    } else {
      pending = reasons
      if (!(state.seenEdits ?? []).includes(edit.hash)) {
        edits.push({
          kind: 'amendment', condition: 'amendment_pending', approvedHash: state.approvedHash,
          detail: `edit ${edit.hash} waits for ${APPROVE} (the approved flow keeps running): ${reasons.join('; ')}`,
        })
        state = { ...state, seenEdits: remember(state.seenEdits, [edit.hash], SEEN_EDITS_MAX) }
      }
    }
  } else if (loc.approved && edit.kind === 'invalid') {
    invalid = edit.errors
    if (!(state.seenEdits ?? []).includes(edit.key)) {
      edits.push({
        kind: 'amendment', condition: 'amendment_invalid', approvedHash: state.approvedHash,
        detail: `the plan file does not validate, so the approved flow keeps running: ${edit.errors.join('; ')}`,
      })
      state = { ...state, seenEdits: remember(state.seenEdits, [edit.key], SEEN_EDITS_MAX) }
    }
  }
  return {
    flow, hash, state: withMode(state, ctx.mode), approved: loc.approved, onDisk, notes, edits, ledger, adoptedTasks,
    ...(snapshot ? { snapshot } : {}), ...(attest ? { attest } : {}),
    ...(pending ? { pending } : {}), ...(invalid ? { invalid } : {}), ...(adopted ? { adopted } : {}),
  }
}

type Work<T> = { state?: FlowState; entries?: Omit<JournalInput, 'at'>[]; value: T }

async function appendSafe(ctx: Ctx, planId: string, entry: JournalInput): Promise<void> {
  try { await appendJournal(ctx.fs, ctx.root, planId, entry) } catch (error) { ctx.warn(`journal: ${message(error)}`) }
}

/**
 * load -> work -> ledger -> record -> snapshot -> state -> journal as one job on the plan's queue. `work` is synchronous: the
 * long parts happened before. The plan is located again inside the job, so an adoption or an approval that landed while this
 * call waited is what `work` sees (`work` takes the flow from the prepared state, never from the caller's earlier view). A
 * plan that stopped being trustworthy meanwhile (`tampered`) is not worked on: `fallback` is the answer.
 */
async function transact<T>(ctx: Ctx, loc: Located, trace: Trace, work: (state: FlowState, prepared: Prepared) => Work<T>, fallback?: { value: T }): Promise<T> {
  const planId = loc.planId
  trace.planId = planId
  return ctx.serial(planId)(async () => {
    const fresh = await locate(ctx)
    if (fresh.kind === 'tampered' && fresh.planId === planId) {
      if (!fallback) throw new Error(`the approved snapshot of ${planId} stopped being trustworthy: ${fresh.why}`)
      return fallback.value
    }
    const here = fresh.kind === 'ok' && fresh.planId === planId ? fresh : loc
    let prepared = await prepare(ctx, here)
    // The record of an adoption goes to the store before anything is written for it. When the store does not take it, the
    // adoption is dropped: the edit waits for approval with that reason and the flow in force goes on being enforced.
    if (prepared.attest) {
      try { await ctx.attest.set(attestKey(ctx.root, planId), prepared.attest) } catch (error) {
        try { ctx.warn(`an adopted plan edit was held: the plugin store did not take its record (${message(error)})`) } catch { /* A failing warning changes nothing. */ }
        prepared = await prepare(ctx, here, `the plugin store did not take the record of the adoption (${clip(message(error), 120)})`)
      }
    }
    const at = await ctx.now()
    // A rejected state file is journaled before the fresh one replaces it.
    for (const note of prepared.notes) await appendSafe(ctx, planId, { at, mode: ctx.mode, ...note })
    const out = work(prepared.state, prepared)
    let next = out.state ?? prepared.state
    // The failing output kept for the judge goes away with the judge: turning it off (or no key, or a refused one) leaves no text.
    if (next.lastOutput !== undefined && !judgeLive(ctx)) {
      next = { ...next }
      delete next.lastOutput
    }
    for (const id of next.sideEffectsDone) if (!prepared.ledger.includes(id)) await recordSideEffect(ctx.fs, ctx.root, planId, id, at)
    // The record went first, then the snapshot, then the state: a crash in between leaves a snapshot that is not the
    // attested one (held as tampered until the next approve), or a state older than its snapshot (brought up to it).
    if (prepared.snapshot) await saveApproved(ctx.fs, ctx.root, planId, prepared.snapshot)
    if (canonical(next) !== prepared.onDisk) await saveState(ctx.fs, ctx.root, next)
    for (const entry of prepared.edits) await appendSafe(ctx, planId, { at, mode: ctx.mode, ...entry })
    for (const entry of out.entries ?? []) await appendSafe(ctx, planId, { at, mode: ctx.mode, ...entry })
    return out.value
  })
}

/**
 * `transact` for a decision made on results gathered earlier, against the flow `hash` they were gathered for. If an
 * adoption or an approval moved the flow in force meanwhile, those results say nothing about it (a check of another command
 * must never mark a task done), so nothing is decided: `STALE`, and the caller looks again.
 */
const STALE = Symbol('stale')
async function transactAt<T>(ctx: Ctx, loc: Located, trace: Trace, hash: string, work: (state: FlowState, prepared: Prepared) => Work<T>): Promise<T | typeof STALE> {
  return transact<T | typeof STALE>(ctx, loc, trace, (state, prepared) => (prepared.hash === hash ? work(state, prepared) : { value: STALE }), { value: STALE })
}

/** The state a decision would start from, with what `prepare` found (an adoption, an edit waiting, a rejected state file) made durable and journaled once. */
async function observe(ctx: Ctx, loc: Located, trace: Trace): Promise<Prepared> {
  trace.planId = loc.planId
  const prepared = await prepare(ctx, loc)
  // What was made durable is what the caller goes on with: an adoption the store did not take is not one.
  if (prepared.notes.length > 0 || prepared.edits.length > 0 || prepared.snapshot) {
    return transact<Prepared>(ctx, loc, trace, (_state, settled) => ({ value: settled }), { value: prepared })
  }
  return prepared
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

/** One decision on a state, without the judge: events other than a task end are never asked about. */
function step(ctx: Ctx, flow: Flow, state: FlowState, event: FlowEvent): ModeDecision {
  const first = decide(flow, state, event, undefined, decideOpts(ctx))
  return applyMode(first, ctx.mode, state)
}

// --- the judge: two passes (decision 18) ---
//
// The judge informs and code decides. A task end is decided once without it (pass 1). Only where an escalation would change
// that decision (a task that would be done and has no QA receipt required yet; a retry that has attempts left) is the judge
// asked, with the one battery of that branch. Its answers become `requireQa` or `retryToArchitect`, the second input of a
// second `decide`, never a patch on the first, and that second decision is made before `applyMode`. Anything that goes wrong
// (no key, a breaker, a timeout, an answer that does not parse, a state that moved meanwhile) leaves pass 1 as the decision.

type Branch = 'taskEnd' | 'retry'
type TaskEndEvent = Extract<FlowEvent, { kind: 'taskEnd' }>
type Escalation = { requireQa?: true; retryToArchitect?: true; why: string[] }
/** What the judge answered for one event: asked once, before the job, and used inside it. */
type Asked = {
  branch: Branch
  mode: 'shadow' | 'escalate'
  result: JudgeResult
  /** From the answers, computed before any decision uses them. Absent when the call failed. */
  escalation?: Escalation
  /** The thresholds the answers were measured against, for the journal. */
  thresholds: Record<string, number>
}
/** One per call of `taskEnded`: its second attempt (a flow that moved while checks ran) reuses the answer, never asks again. */
type JudgeMemo = { asked?: Asked | null }

const sameDecision = (a: Decision, b: Decision): boolean =>
  a.action === b.action && a.condition === b.condition && a.task === b.task && canonical(a.state) === canonical(b.state)

/**
 * Whether pass 1 of a task end depends on the judge: the decision with each escalation in turn, compared with the decision
 * without. A side-effect task and a delivery with ownership denials are never judged (nothing to escalate to, or an answer the
 * ladder already gave); a paused, stopped or unapproved flow answers the same whatever is asked.
 */
function probe(ctx: Ctx, flow: Flow, state: FlowState, event: TaskEndEvent): { branch: Branch; first: Decision; second: Decision } | undefined {
  const task = findTask(flow, event.taskId)
  if (!task || task.sideEffect || event.ownershipDenials > 0) return undefined
  const opts = decideOpts(ctx)
  const first = decide(flow, state, event, undefined, opts)
  const tries: [Branch, DecideOptions][] = [['retry', { ...opts, retryToArchitect: true }], ['taskEnd', { ...opts, requireQa: true }]]
  for (const [branch, escalated] of tries) {
    const second = decide(flow, state, event, undefined, escalated)
    if (!sameDecision(first, second)) return { branch, first, second }
  }
  return undefined
}

/** The judge's answer for a task end, or undefined when it was not asked (no judge, nothing to escalate, nothing to judge). */
async function askJudge(ctx: Ctx, p: Pick<Prepared, 'flow' | 'state'>, task: FlowTask, event: TaskEndEvent, output: string | undefined, memo: JudgeMemo): Promise<Asked | undefined> {
  const access = ctx.judge
  if (!access) return undefined
  if (memo.asked !== undefined) return memo.asked ?? undefined
  memo.asked = null
  try {
    // Without the agent's own report there is nothing to judge, and a guess would only escalate.
    const message = (output ?? '').trim()
    if (!message) return undefined
    const found = probe(ctx, p.flow, p.state, event)
    if (!found) return undefined
    const previous = p.state.lastOutput?.[task.id]
    const failing = event.checks.find(check => check.passed !== true)
    const request = found.branch === 'retry'
      ? checkpoint('retry', { goal: task.goal, agentMessage: message, checkOutput: failing?.output ?? '', ...(previous === undefined ? {} : { previousCheckOutput: previous }) }, access.redact)
      : checkpoint('taskEnd', { goal: task.goal, agentMessage: message }, access.redact)
    const result = await access.ask(request)
    if (!result) return undefined
    const thresholds: Thresholds = access.thresholds ?? THRESHOLDS
    const asked: Asked = {
      branch: found.branch, mode: access.mode, result,
      thresholds: found.branch === 'retry'
        ? { retryFlagAtLeast: thresholds.retryFlagAtLeast }
        : { goalReportedDoneAtMost: thresholds.goalReportedDoneAtMost, taskEndFlagAtLeast: thresholds.taskEndFlagAtLeast },
    }
    if (result.ok) {
      if (found.branch === 'retry') {
        const out = retryEscalation(result.answers, thresholds)
        asked.escalation = { ...(out.retryToArchitect ? { retryToArchitect: true as const } : {}), why: out.why }
      } else {
        const out = taskEndEscalation(result.answers, task, thresholds)
        asked.escalation = { ...(out.requireQa ? { requireQa: true as const } : {}), why: out.why }
      }
    }
    memo.asked = asked
    return asked
  } catch {
    // A judge that fails in any way is no judge: the decision is the policy's.
    return undefined
  }
}

/** The journal's account of one judged checkpoint: the answers as returned, the thresholds, what they escalated to and what happened. */
function judgeEntry(
  ctx: Ctx, event: TaskEndEvent, asked: Asked,
  outcome: { would?: Decision; applied: boolean; final: ModeDecision; stale: boolean },
): Omit<JournalInput, 'at'> {
  const { result } = asked
  const kind = asked.branch
  const final = { action: outcome.final.action, condition: outcome.final.condition, ...(outcome.final.task ? { task: outcome.final.task } : {}) }
  const base: JudgeRecord = { checkpoint: kind, judgeMode: asked.mode, questionSet: QUESTION_SET_HASH, final }
  let record: JudgeRecord
  let condition: string
  let reason: string
  if (!result.ok) {
    record = {
      ...base, attempts: result.attempts, ms: result.ms,
      failure: {
        reason: result.reason,
        ...(result.status === undefined ? {} : { status: result.status }),
        ...(result.off === undefined ? {} : { off: result.off }),
        ...(result.detail === undefined ? {} : { detail: result.detail }),
        ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
      },
    }
    condition = 'judge_failed'
    reason = `the judge gave no answer (${result.reason}${result.status === undefined ? '' : ` ${result.status}`}): the decision is the policy's`
  } else {
    const escalation = asked.escalation ?? { why: [] }
    const escalated = escalation.requireQa === true || escalation.retryToArchitect === true
    record = {
      ...base,
      model: result.requestModel,
      ...(result.model === undefined ? {} : { responseModel: result.model }),
      ...(result.id === undefined ? {} : { requestId: result.id }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      uncalibrated: result.uncalibrated,
      attempts: result.attempts, ms: result.ms,
      answers: result.answers,
      thresholds: asked.thresholds,
      escalation: { ...(escalation.requireQa ? { requireQa: true } : {}), ...(escalation.retryToArchitect ? { retryToArchitect: true } : {}) },
      ...(outcome.would ? { would: { action: outcome.would.action, condition: outcome.would.condition, ...(outcome.would.task ? { task: outcome.would.task } : {}) } } : {}),
      applied: outcome.applied,
    }
    condition = outcome.stale ? 'judge_stale' : escalated ? 'judge_escalated' : 'judge_clear'
    reason = outcome.stale
      ? 'the state moved while the judge was asked: its answer was not used'
      : escalated ? [...escalation.why, ...(outcome.would?.note ? [`set aside: ${outcome.would.note}`] : [])].join('; ') : 'no escalation'
  }
  const would = outcome.final.wouldBe
  return {
    kind: 'escalation', event: 'taskEnd', task: event.taskId,
    action: outcome.final.action, condition, reason: clip(reason, 600), mode: ctx.mode,
    ...(would && would.action !== outcome.final.action ? { wouldBe: would.action } : {}),
    judge: record,
  }
}

/**
 * A task end decided with the judge's answer (if any). Pass 1 is the decision; when the judge answered for this branch and
 * its answers escalate, pass 2 is `decide` with the escalation in `DecideOptions`. Pass 2 replaces pass 1 only when the judge
 * mode is `escalate`, the flow mode is `enforce` and the plan is approved (`live`); otherwise it is journaled as what would
 * have happened. `applyMode` comes last, so shadow journals the escalated action as `wouldBe` like any other.
 */
function stepJudged(ctx: Ctx, flow: Flow, state: FlowState, event: TaskEndEvent, asked: Asked | undefined, live: boolean): { decision: ModeDecision; entries: Omit<JournalInput, 'at'>[] } {
  const opts = decideOpts(ctx)
  if (!asked) return { decision: applyMode(decide(flow, state, event, undefined, opts), ctx.mode, state), entries: [] }
  const found = probe(ctx, flow, state, event)
  const first = found?.first ?? decide(flow, state, event, undefined, opts)
  // The branch it answered is still the decision's, and the answers escalate: the second input of the second decision.
  const current = found !== undefined && found.branch === asked.branch
  const escalation = asked.result.ok && current ? asked.escalation : undefined
  let would: Decision | undefined
  let final: Decision = first
  let applied = false
  if (escalation && (escalation.requireQa || escalation.retryToArchitect)) {
    would = decide(flow, state, event, undefined, { ...opts, ...(escalation.requireQa ? { requireQa: true } : {}), ...(escalation.retryToArchitect ? { retryToArchitect: true } : {}) })
    if (asked.mode === 'escalate' && ctx.mode === 'enforce' && live && !sameDecision(first, would)) {
      final = would
      applied = true
    }
  }
  const decision = applyMode(final, ctx.mode, state)
  const stale = asked.result.ok && !current
  const entry = judgeEntry(ctx, event, asked, { ...(would ? { would } : {}), applied, final: decision, stale })
  // The lead is told why QA is asked for a task that has no criteria: the doubt was about the agent's own report.
  if (applied && escalation?.requireQa && ctx.mode === 'enforce') {
    return { decision: { ...decision, reason: `${decision.reason} (The agent's own report did not back "done": ${escalation.why.join('; ')}.)` }, entries: [entry] }
  }
  return { decision, entries: [entry] }
}

/** Whether the judge is on for this call: configured, and not switched off for the session by a refused key. */
function judgeLive(ctx: Ctx): boolean {
  if (!ctx.judge) return false
  try { return !ctx.judge.status().off } catch { return true }
}

/**
 * The failing output the retry battery compares the next failure with; only while the judge is on, and never for a done task.
 * It is redacted as what is sent is (secrets, emails, and the home and the root as paths): the state file is the repository's.
 */
function withLastOutput(state: FlowState, taskId: string, checks: readonly CheckResult[], where: RedactContext): FlowState {
  const failing = checks.find(check => check.passed !== true)
  const current = state.lastOutput ?? {}
  const settled = state.status[taskId] === 'done' || failing === undefined
  if (settled) {
    if (!(taskId in current)) return state
    const rest = Object.fromEntries(Object.entries(current).filter(([id]) => id !== taskId))
    const { lastOutput: _dropped, ...kept } = state
    return Object.keys(rest).length > 0 ? { ...kept, lastOutput: rest } : kept
  }
  const text = tail(redact(failing.output, where), LAST_OUTPUT_MAX)
  const rest = Object.entries(current).filter(([id]) => id !== taskId)
  const next = Object.fromEntries([...rest, [taskId, text]].slice(-LAST_OUTPUT_TASKS_MAX))
  return { ...state, lastOutput: next }
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
    // The flow in force may move while its checks run (an approval, an adoption): what ran says nothing about the new one, so
    // the evaluation starts over once, with the checks of the flow that is in force now.
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await evaluateStop(ctx, input, trace)
      if (out !== STALE) return out
    }
    return staleStop(ctx, input, trace)
  })
}

/**
 * The flow in force changed under its checks twice: nothing was decided, and in enforce the Stop is held once, saying so. It is
 * a block like any other: it waits for background work, spends the budget, counts toward the engine's run of consecutive
 * blocks, and is let through when either is used up, so a plan that is edited faster than its checks run cannot hold a turn.
 */
async function staleStop(ctx: Ctx, input: StopInput, trace: Trace): Promise<StopOutcome> {
  if (ctx.mode !== 'enforce' || input.backgroundTasks > 0 || input.runningAgents > 0) return {}
  const loc = await locate(ctx)
  if (loc.kind !== 'ok' || !loc.approved) return {}
  const held = { block: `${TAG}: the flow in force changed while its checks ran, so none of their results was used. Stop again and they run against it.` }
  return transact<StopOutcome>(ctx, loc, trace, (state, p) => {
    if (!enforcing(p) || state.done || state.paused || state.stopped) return { value: {} }
    const run = input.stopHookActive ? state.consecutiveBlocks : 0
    if (state.blocks >= p.flow.limits.maxBlocks || run >= CONSECUTIVE_CAP) return { value: {} }
    return { state: { ...state, blocks: state.blocks + 1, consecutiveBlocks: run + 1 }, value: held }
  }, { value: {} })
}

async function evaluateStop(ctx: Ctx, input: StopInput, trace: Trace): Promise<StopOutcome | typeof STALE> {
  const loc = await locate(ctx)
  if (loc.kind === 'tampered') return tamperedStop(ctx, loc, input, trace)
  if (loc.kind !== 'ok') return {}
  trace.planId = loc.planId
  const peek = await observe(ctx, loc, trace)
  // A plan nobody approved is never enforced and none of its commands run; an approved one is, whatever its file now says.
  if (!enforcing(peek)) return {}
  const state = peek.state
  const idle = state.done || state.paused || state.stopped || input.backgroundTasks > 0 || input.runningAgents > 0
  const checks: Record<string, CheckResult[]> = {}
  let unverified = 0
  // Tasks being worked on (or waiting for a receipt) whose checks did not all get to run.
  const cut: string[] = []
  if (!idle) {
    // The whole evaluation has a deadline: a check that does not get to run in time is unverified, never a fail.
    // The snapshots the pass takes (its git calls) are inside the deadline too.
    const limit = ctx.stopDeadlineMs ?? STOP_DEADLINE_MS
    const until: Until = { now: ctx.now, endsAt: (await ctx.now()) + limit }
    const pass = await createCheckPass(ctx.run, ctx.root, {
      scope: loc.planId, snapshot: () => snapshotKey(ctx, until), deadline: until,
      ...(ctx.memo ? { memo: ctx.memo } : {}),
    })
    try {
      for (const task of stopTargets(peek.flow, state)) {
        const ran = await pass.runTask(task.acceptance.checks)
        checks[task.id] = ran
        if (ran.length < task.acceptance.checks.length && (state.status[task.id] === 'active' || state.awaiting.some(a => a.task === task.id))) cut.push(task.id)
      }
    } catch (error) {
      if (error instanceof CheckUnrunnable) return unrunnable(ctx, loc.planId, error)
      throw error
    }
    unverified = (await pass.finish()).unverified
  }
  const event: FlowEvent = { kind: 'stop', stopHookActive: input.stopHookActive, backgroundTasks: input.backgroundTasks, runningAgents: input.runningAgents, checks }
  const decision = await transactAt(ctx, loc, trace, peek.hash, (before, p) => {
    const d = step(ctx, p.flow, before, event)
    const all = Object.values(checks).flat()
    const entries: Omit<JournalInput, 'at'>[] = journalable(d, before) ? [entryFor(ctx, 'stop', d, all)] : []
    if (unverified > 0) {
      entries.push({
        kind: 'note', event: 'stop', condition: 'checks_unverified',
        detail: `${unverified} check(s) did not get to run within ${Math.round((ctx.stopDeadlineMs ?? STOP_DEADLINE_MS) / 1000)} s: unverified, not failed.`,
      })
    }
    return { state: d.state, entries, value: d }
  })
  if (decision === STALE) return STALE
  const enforce = ctx.mode === 'enforce'
  // A pause is also a block: the lead must hear the reason before the turn ends.
  const blocking = (decision.action === 'block' || decision.action === 'pause') && decision.reason !== ''
  // Waiting on background work never blocks, whatever the policy said.
  const waiting = input.backgroundTasks > 0 || input.runningAgents > 0
  return {
    decision,
    ...(enforce && blocking && !waiting ? { block: `${TAG}: ${decision.reason}` } : {}),
    ...(enforce && (decision.condition === 'budget' || decision.condition === 'complete') ? { notice: `${TAG}: ${decision.reason}` } : {}),
    // The checks of a task in progress that never ran are neither a pass nor a fail: the lead is told, to run them itself.
    ...(enforce && cut.length > 0 ? { context: `[${TAG}] The checks of ${cut.length === 1 ? 'task' : 'tasks'} ${cut.join(', ')} did not get to run within ${Math.round((ctx.stopDeadlineMs ?? STOP_DEADLINE_MS) / 1000)} s, so ${cut.length === 1 ? 'it is' : 'they are'} unverified (not failed). Run them yourself before calling ${cut.length === 1 ? 'it' : 'them'} done.` } : {}),
  }
}

/** A state with nothing in it, for a plan whose own state is gone and whose flow cannot be believed. */
function emptyState(planId: string): FlowState {
  return {
    planId, hash: '', status: {}, attempts: {}, awaiting: [], receipts: {}, qaRequired: [], ends: {}, sideEffectsDone: [],
    blocks: 0, consecutiveBlocks: 0, paused: false, stopped: false, done: false,
  }
}

// A plan nobody can name has no state file to count its holds in: they are counted here, per repository root.
const UNNAMED_HELD = new Map<string, number>()
/** For tests: forget the holds of plans nobody could name. */
export const unnamedHolds = { clear: () => UNNAMED_HELD.clear() }

const tamperedReason = (why: string) => `${TAMPERED} (${why}). Ask the person to run ${APPROVE}, read the commands it lists, then confirm with the hash it prints. No check of the plan runs until then.`
/** A held plan blocks the lead's Stop this many times between two prompts of the person: the lead cannot resolve it, the person can. */
const TAMPERED_BLOCKS = 1

/**
 * A plan whose approval cannot be believed: no check of it runs and the state keeps its approval (an approval lost by a
 * stray write would be a switch). Enforce holds the Stop once between two prompts of the person (the lead cannot resolve it,
 * and a refill comes with every prompt, with the reason injected again), then lets it through; shadow journals once. A pause,
 * a stop or a finished flow is left alone, and so is a wait for background work.
 */
async function tamperedStop(ctx: Ctx, loc: Tampered, input: StopInput, trace: Trace): Promise<StopOutcome> {
  const reason = tamperedReason(loc.why)
  const planId = loc.planId
  if (planId === undefined) {
    // No plan can be named, so there is no state or journal to write: the hold is counted in memory, once between two prompts.
    if (input.backgroundTasks > 0 || input.runningAgents > 0) return {}
    if (ctx.mode !== 'enforce') {
      try { ctx.warn(`the flow would hold the stop: ${loc.why}`) } catch { /* A failing warning changes nothing. */ }
      return {}
    }
    const held = UNNAMED_HELD.get(ctx.root) ?? 0
    if (held >= TAMPERED_BLOCKS) return { notice: `${TAG}: ${reason} The stop was held once and is let through now; the next prompt of the person brings this back.` }
    UNNAMED_HELD.set(ctx.root, held + 1)
    return { block: `${TAG}: ${reason}` }
  }
  trace.planId = planId
  return ctx.serial(planId)(async () => {
    const at = await ctx.now()
    const saved = (await loadState(ctx.fs, ctx.root, planId)) ?? emptyState(planId)
    if (input.backgroundTasks > 0 || input.runningAgents > 0 || saved.done || saved.paused || saved.stopped) return {}
    const key = `tampered:${loc.why}`
    const told = (saved.seenEdits ?? []).includes(key)
    let state: FlowState = { ...saved }
    if (!input.stopHookActive) state.consecutiveBlocks = 0
    const save = async () => { if (canonical(state) !== canonical(saved)) await saveState(ctx.fs, ctx.root, state) }
    const note = (entry: Omit<JournalInput, 'at'>) => appendSafe(ctx, planId, { at, mode: ctx.mode, event: 'stop', condition: 'snapshot_tampered', reason: clip(reason, 600), ...entry })
    if (ctx.mode !== 'enforce') {
      if (told) return {}
      state = { ...state, seenEdits: remember(state.seenEdits, [key], SEEN_EDITS_MAX) }
      await save()
      await note({ kind: 'decision', action: 'allow', wouldBe: 'block' })
      return {}
    }
    if (state.blocks >= TAMPERED_BLOCKS || (input.stopHookActive && saved.consecutiveBlocks >= TAMPERED_BLOCKS)) {
      state.consecutiveBlocks = 0
      state = { ...state, seenEdits: remember(state.seenEdits, [key], SEEN_EDITS_MAX) }
      await save()
      if (!told) await note({ kind: 'decision', action: 'allow', condition: 'snapshot_tampered_budget' })
      return { notice: `${TAG}: ${reason} The stop was held once and is let through now; the next prompt of the person brings this back.` }
    }
    state.blocks += 1
    state.consecutiveBlocks += 1
    state = { ...state, seenEdits: remember(state.seenEdits, [key], SEEN_EDITS_MAX) }
    await save()
    await note({ kind: 'decision', action: 'block' })
    return { block: `${TAG}: ${reason}` }
  })
}

// --- task end and reviews ---

/** What a delivery carries: the task, the writes refused during it, and the agent's final message (what the judge reads). */
export type TaskEndInput = { taskId: string; ownershipDenials: number; output?: string }

/**
 * A work agent (developer or ux) returned for a task: its own checks decide. With a judge on `ctx` and the agent's message,
 * the judge is asked once, where the decision depends on it, and its answer is journaled whatever it does to the decision.
 */
export async function taskEnded(ctx: Ctx, input: TaskEndInput): Promise<Outcome> {
  return guarded<Outcome>(ctx, 'task end', {}, async trace => {
    // One request per delivery: the second attempt (the flow moved while checks ran) reuses the answer.
    const memo: JudgeMemo = {}
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await evaluateTaskEnd(ctx, input, trace, memo)
      if (out !== STALE) return out
    }
    return ctx.mode === 'enforce'
      ? { text: `[${TAG}] The flow in force changed while the checks of task ${input.taskId} ran, so none of their results was used. Deliver the task again and they run against it.` }
      : {}
  })
}

async function evaluateTaskEnd(ctx: Ctx, input: TaskEndInput, trace: Trace, memo: JudgeMemo): Promise<Outcome | typeof STALE> {
  const loc = await locate(ctx)
  if (loc.kind !== 'ok') return {}
  trace.planId = loc.planId
  const peek = await observe(ctx, loc, trace)
  const task = findTask(peek.flow, input.taskId)
  if (!task) return {}
  if (!enforcing(peek)) return {}
  const idle = peek.state.done || peek.state.paused || peek.state.stopped
  let checks: CheckResult[] = []
  if (!idle) {
    const pass = await createCheckPass(ctx.run, ctx.root, { scope: loc.planId, snapshot: () => snapshotKey(ctx), ...(ctx.memo ? { memo: ctx.memo } : {}) })
    try { checks = await pass.runTask(task.acceptance.checks) } catch (error) {
      if (error instanceof CheckUnrunnable) return unrunnable(ctx, loc.planId, error)
      throw error
    }
    await pass.finish()
  }
  const event: TaskEndEvent = { kind: 'taskEnd', taskId: task.id, checks, ownershipDenials: input.ownershipDenials }
  // The judge is long work: it is asked here, before the plan's queue, from the state as `observe` saw it. The decision inside
  // the job starts over from the state as it is then, and uses the answer only for the branch it was asked about.
  const asked = idle ? undefined : await askJudge(ctx, peek, task, event, input.output, memo)
  const decision = await transactAt(ctx, loc, trace, peek.hash, (before, p) => {
    const judged = stepJudged(ctx, p.flow, before, event, asked, enforcing(p))
    const d = judged.decision
    // The failing output is kept (only while the judge is on) for the retry battery to compare the next failure with.
    const state = ctx.judge && judgeLive(ctx) && !idle ? withLastOutput(d.state, task.id, checks, ctx.judge.redact) : d.state
    const entries = [...(journalable(d, before) ? [entryFor(ctx, 'taskEnd', d, checks, task.id)] : []), ...judged.entries]
    return { state, entries, value: d }
  })
  if (decision === STALE) return STALE
  const text = leadText(ctx, decision)
  return { decision, ...(text ? { text } : {}) }
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
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await evaluateReview(ctx, input, trace)
      if (out !== STALE) return out
    }
    return ctx.mode === 'enforce'
      ? { text: `[${TAG}] The flow in force changed while the answer for task ${input.taskId} was read, so it was not used. Ask ${input.by} again.` }
      : {}
  })
}

async function evaluateReview(ctx: Ctx, input: ReviewInput, trace: Trace): Promise<Outcome | typeof STALE> {
  const loc = await locate(ctx)
  if (loc.kind !== 'ok') return {}
  trace.planId = loc.planId
  const peek = await observe(ctx, loc, trace)
  const task = findTask(peek.flow, input.taskId)
  if (!task) return {}
  if (!enforcing(peek)) return {}
  const who = input.by === 'qa' ? 'QA' : 'The architect'
  const lead = (text: string) => (ctx.mode === 'enforce' ? { text: `[${TAG}] ${text}` } : {})
  const refuse = async (condition: string, detail: string, text: string): Promise<Outcome> => {
    await noteQueued(ctx, loc.planId, { kind: 'note', event: 'review', task: task.id, condition, detail: clip(detail, 600) })
    return lead(text)
  }
  if (!peek.state.awaiting.some(a => a.task === task.id && a.by === input.by)) {
    await noteQueued(ctx, loc.planId, { kind: 'note', event: 'review', task: task.id, condition: 'review_ignored', detail: `${input.by} returned for ${task.id}, which is not awaiting it` })
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
  const decision = await transactAt(ctx, loc, trace, peek.hash, (before, p) => {
    const d = step(ctx, p.flow, before, event)
    return { state: d.state, entries: journalable(d, before) ? [entryFor(ctx, 'review', d, undefined, task.id)] : [], value: d }
  })
  if (decision === STALE) return STALE
  const text = leadText(ctx, decision)
  return { decision, ...(text ? { text } : {}) }
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

/**
 * Decisions 16 and 17: a `[T]` delegation goes to the task's role; qa and architect only for a receipt the task awaits (or the
 * architect's diagnosis). With `lookup` the agent already exists (the host is asking what it is): nothing is refused or
 * journaled, since its spawn was judged, and journaled, when it started.
 */
export async function inspectSpawn(ctx: Ctx, input: { taskId: string; agentType: string; lookup?: boolean }): Promise<SpawnCheck> {
  const unknown: SpawnCheck = { known: false, end: 0 }
  return guarded<SpawnCheck>(ctx, 'spawn', unknown, async trace => {
    const loc = await locate(ctx)
    if (loc.kind !== 'ok') return unknown
    trace.planId = loc.planId
    const peek = await observe(ctx, loc, trace)
    const task = findTask(peek.flow, input.taskId)
    if (!task) return unknown
    const state = peek.state
    const approved = enforcing(peek)
    const live = approved && !state.done && !state.paused && !state.stopped
    const role = input.agentType.replace(/^pantheon:/, '')
    const end = state.ends[task.id] ?? 0
    const base = { known: true, planId: loc.planId, end, ...(live ? { files: [...task.files] } : {}) }
    let kind: SpawnCheck['kind']
    let by: Reviewer | undefined
    let why: { condition: string; reason: string } | undefined
    if (input.agentType.startsWith('pantheon:') && role === task.role) kind = 'work'
    else if (input.agentType.startsWith('pantheon:') && (role === 'qa' || role === 'architect')) {
      if (state.awaiting.some(a => a.task === task.id && a.by === role)) { kind = 'review'; by = role }
      else if (role === 'architect' && diagnosisOpen(peek.flow, state, task)) kind = 'diagnosis'
      else why = { condition: 'spawn_no_receipt', reason: `Task ${task.id} is not waiting for ${role === 'qa' ? 'a QA verdict' : "the architect's review"} now, so ${input.agentType} cannot be spawned for it. [${task.id}] delegations go to pantheon:${task.role}; the flow asks for ${role} only after the task's checks pass and a receipt is due.` }
    } else {
      why = { condition: 'spawn_wrong_role', reason: `Task ${task.id} is a ${task.role} task: delegate it to pantheon:${task.role}, or drop the [${task.id}] prefix if this delegation is not that task's work.` }
    }
    if (why && live && !input.lookup) {
      await noteQueued(ctx, loc.planId, {
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
    trace.planId = loc.planId
    const peek = await observe(ctx, loc, trace)
    const task = findTask(peek.flow, input.taskId)
    if (!task) return {}
    const state = peek.state
    if (!(enforcing(peek) && !state.done && !state.paused && !state.stopped)) return {}
    const reason = `Task ${task.id} cannot be delegated with isolation "${input.isolation}": its agent would write in another worktree, outside the task's files. Delegate it without isolation.`
    await noteQueued(ctx, loc.planId, {
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
export async function mainEdit(ctx: Ctx, input: { path: string; resolve?: () => Promise<{ root: string; path: string }> }): Promise<{ text?: string }> {
  return guarded<{ text?: string }>(ctx, 'main edit', {}, async trace => {
    const loc = await locate(ctx)
    if (loc.kind !== 'ok') return {}
    trace.planId = loc.planId
    const peek = await observe(ctx, loc, trace)
    // The host's resolved root and path (links followed, as the ownership gate does), asked for only now that a plan is in
    // force; a path it cannot resolve is read as written.
    let where = { root: ctx.root, path: input.path }
    if (input.resolve) { try { where = await input.resolve() } catch { /* The path as written is what there is. */ } }
    const base = norm(stripRoot(where.root))
    const abs = norm(where.path.startsWith('/') ? where.path : `${base}/${where.path}`)
    // The plan itself: its edit was just adopted or left waiting by `observe` (journaled once); the lead is told which.
    if (abs === planFile(where.root, loc.path)) return ctx.mode === 'enforce' && enforcing(peek) ? editNotice(peek) : {}
    if (!enforcing(peek) || peek.state.awaiting.length === 0) return {}
    if (!within(abs, base) || abs === base) return {}
    const rel = abs.slice(base === '/' ? 1 : base.length + 1)
    const hit = (state: FlowState, flow: Flow) => [...new Set(state.awaiting.map(a => a.task))]
      .filter(id => state.status[id] !== 'done' && ownsPath({ files: findTask(flow, id)?.files ?? [] }, rel))
    if (hit(peek.state, peek.flow).length === 0) return {}
    return transact<{ text?: string }>(ctx, loc, trace, (state, p) => {
      const tasks = hit(state, p.flow)
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

/** What the lead is told about its edit to the plan file: adopted, waiting for approval, or not valid. */
function editNotice(p: Prepared): { text?: string } {
  if (p.adopted) return { text: `[${TAG}] Your edit to the plan was adopted over the approved flow (${p.adopted}); the flow keeps running with it.` }
  if (p.pending?.length) {
    return { text: `[${TAG}] Your edit to the plan waits for ${APPROVE}; the approved flow keeps running without it:\n${p.pending.map(reason => `- ${reason}`).join('\n')}` }
  }
  if (p.invalid) return { text: `[${TAG}] The plan file does not validate, so the approved flow keeps running without your edit:\n${p.invalid.map(error => `- ${error}`).join('\n')}` }
  return {}
}

// --- human prompts ---

function reinjection(flow: Flow, state: FlowState, pending?: readonly string[], adoptedTasks: readonly string[] = []): string {
  const lines = [`[${TAG}] Goal: ${flow.goal}`]
  const active = flow.tasks.filter(task => state.status[task.id] === 'active')
  // A task adopted from an edit has the lead's own words for a goal: it is said so, under a tag that otherwise means approved.
  const mark = (id: string) => (adoptedTasks.includes(id) ? ' (adopted from a plan edit, not approved by the person)' : '')
  for (const task of active) lines.push(`Current task ${task.id} (${task.role})${mark(task.id)}: ${task.goal}. Files: ${task.files.join(', ')}.`)
  const waiting = state.awaiting.filter(a => state.status[a.task] !== 'done')
  if (waiting.length) lines.push(`Waiting for: ${waiting.map(a => `${a.task} (${a.by})`).join(', ')}.`)
  if (state.paused) lines.push('The flow is paused until the person runs /pantheon flow resume.')
  if (pending?.length) lines.push(`${pending.length} plan ${pending.length === 1 ? 'edit waits' : 'edits wait'} for ${APPROVE}; the flow runs the approved plan without ${pending.length === 1 ? 'it' : 'them'}.`)
  if (state.lastInstruction) lines.push(`Last instruction: ${clip(state.lastInstruction, 600)}`)
  return lines.join('\n')
}

/** The person wrote: the block budget refills, and in enforce the goal, the current task and the last instruction come back. */
export async function humanPrompt(ctx: Ctx): Promise<{ context?: string }> {
  return guarded<{ context?: string }>(ctx, 'human prompt', {}, async trace => {
    const loc = await locate(ctx)
    if (loc.kind === 'tampered') return tamperedPrompt(ctx, loc, trace)
    if (loc.kind !== 'ok') return {}
    trace.planId = loc.planId
    const peek = await observe(ctx, loc, trace)
    const needsRefill = peek.state.blocks > 0 || peek.state.consecutiveBlocks > 0
    const approved = enforcing(peek)
    if (!needsRefill && !(approved && !peek.state.done && !peek.state.stopped)) return {}
    return transact(ctx, loc, trace, (state, p) => {
      const d = step(ctx, p.flow, state, { kind: 'humanPrompt' })
      const live = p.approved && isApproved(d.state, p.hash) && !d.state.done && !d.state.stopped
      return {
        state: d.state,
        entries: journalable(d, state) ? [entryFor(ctx, 'humanPrompt', d)] : [],
        value: ctx.mode === 'enforce' && live ? { context: reinjection(p.flow, d.state, p.pending, p.adoptedTasks) } : {},
      }
    })
  })
}

/** The person wrote and the plan's approval cannot be believed: the budget refills, and in enforce the lead is told what to ask. */
async function tamperedPrompt(ctx: Ctx, loc: Tampered, trace: Trace): Promise<{ context?: string }> {
  const planId = loc.planId
  if (planId === undefined) {
    UNNAMED_HELD.delete(ctx.root)
    return ctx.mode === 'enforce' ? { context: `[${TAG}] ${tamperedReason(loc.why)} Tell the person; do not rely on the plan's checks.` } : {}
  }
  trace.planId = planId
  return ctx.serial(planId)(async () => {
    const saved = await loadState(ctx.fs, ctx.root, planId)
    if (saved && (saved.blocks > 0 || saved.consecutiveBlocks > 0)) await saveState(ctx.fs, ctx.root, { ...saved, blocks: 0, consecutiveBlocks: 0 })
    if (ctx.mode !== 'enforce' || saved?.stopped || saved?.done) return {}
    return { context: `[${TAG}] ${tamperedReason(loc.why)} Tell the person; do not rely on the plan's checks.` }
  })
}

// --- commands ---

const short = (hash: string) => hash.slice(0, 12)
/** The digits of the plan's hash the person types to confirm an approval. */
const CONFIRM_DIGITS = 12
export const confirmationOf = (flow: Flow): string => flowHash(flow).slice(0, CONFIRM_DIGITS)

// What `approve` listed in this process, by repository, plan id and plan file: the FULL hash of the block it printed. Twelve
// digits are what the person types, and they are too few to bind a block by themselves (a birthday collision between a benign
// block and a malicious one is seconds of hashing): a confirmation approves only the block that was listed, whole. Memory
// only, so a confirmation with no listing in this process (a restart, a reload) starts over.
const LISTED = new Map<string, string>()
const LISTED_BLOCKS_MAX = 32
const listedKey = (ctx: Pick<Ctx, 'root'>, planId: string, rel: string): string => `${attestKey(ctx.root, planId)}\n${rel}`
/**
 * Whether a confirmation approves the block as it is now: a listing of this very block (its whole hash, not its first digits)
 * was printed in this process, and what was typed is the start of that hash.
 */
export function confirmationVerdict(listed: string | undefined, current: string, typed: string): 'ok' | 'unlisted' | 'changed' | 'digits' {
  if (listed === undefined) return 'unlisted'
  if (listed !== current) return 'changed'
  return typed.length >= CONFIRM_DIGITS && listed.startsWith(typed) ? 'ok' : 'digits'
}
/** For tests: how many listings the process remembers. */
export const approvalListings = { get size() { return LISTED.size }, clear: () => LISTED.clear() }

/** `approve`'s argument: a plan path, the confirmation (12 hex digits), or both with the path first. */
export function approveArgs(arg: string | undefined): { path?: string; confirm?: string } {
  const text = (arg ?? '').trim()
  const found = /^(?:(.*\S)\s+)?([0-9a-f]{12})$/i.exec(text)
  if (found) return { ...(found[1] ? { path: found[1] } : {}), confirm: found[2]!.toLowerCase() }
  return text ? { path: text } : {}
}

const LISTED_MAX = 100
const commandKey = (check: { argv: readonly string[]; cwd?: string }) => `${check.cwd ?? ''}\0${check.argv.join('\0')}`

/**
 * What approving a plan would make runnable, for the person to read before confirming: every check (argv, directory,
 * timeout) with what is new or changed against the approved plan (when one stands), the files each task may write, and the
 * confirmation to type. It records nothing.
 */
function describePlan(rel: string, flow: Flow, previous: { flow?: Flow; why?: string }): string {
  const known = new Map<string, number>()
  for (const task of previous.flow?.tasks ?? []) for (const check of task.acceptance.checks) known.set(commandKey(check), check.timeoutSec)
  const now = new Set<string>()
  const commands: string[] = []
  const unchanged: string[] = []
  for (const task of flow.tasks) {
    for (const check of task.acceptance.checks) {
      now.add(commandKey(check))
      const was = known.get(commandKey(check))
      const line = `- [${task.id}] ${check.argv.join(' ')} (in ${check.cwd ?? 'the repository root'}, ${check.timeoutSec} s)`
      if (previous.flow === undefined || was === undefined) commands.push(`${line} NEW`)
      else if (was !== check.timeoutSec) commands.push(`${line} CHANGED (timeout was ${was} s)`)
      else unchanged.push(line)
    }
  }
  const dropped = [...known.keys()].filter(key => !now.has(key)).map(key => key.split('\0').slice(1).join(' '))
  const cap = (lines: string[]) => (lines.length > LISTED_MAX ? [...lines.slice(0, LISTED_MAX), `- ... and ${lines.length - LISTED_MAX} more; read them in ${rel}`] : lines)
  const files = flow.tasks.map(task => {
    const flags = [task.risk ? 'risk' : '', task.sideEffect ? 'side effect' : ''].filter(Boolean)
    return `- [${task.id}] ${task.role}${flags.length ? ` (${flags.join(', ')})` : ''}: ${task.files.join(', ') || 'no files'}`
  })
  const confirm = confirmationOf(flow)
  return [
    `Plan ${flow.planId} (${rel}): ${flow.tasks.length} tasks, hash ${confirm}. Nothing is approved yet and nothing was recorded.`,
    previous.flow
      ? 'Compared with the approved plan: NEW and CHANGED commands are the ones you have not approved before.'
      : `There is no approved plan to compare with${previous.why ? ` (${previous.why})` : ''}: every command is new.`,
    '',
    `Commands that would run on this machine, when a task ends and when the session stops (argv, directory, timeout):`,
    ...(commands.length + unchanged.length === 0 ? ['- none'] : cap([...commands, ...unchanged])),
    ...(dropped.length > 0 ? ['', 'No longer run:', ...cap(dropped.map(command => `- ${command}`))] : []),
    '',
    'Files each task may write:',
    ...cap(files),
    '',
    `To approve exactly this plan, run: ${APPROVE} ${rel} ${confirm}`,
  ].join('\n')
}

export async function approvePlan(ctx: Ctx, arg?: string): Promise<string> {
  return guarded(ctx, 'approve', 'The flow could not approve the plan (an internal error; see the warning).', async trace => {
    const { path: given, confirm } = approveArgs(arg)
    // The plan is the one named, or the one in force: never "the newest", which a file written meanwhile would change.
    const rel = given ? pointerValue(ctx.root, planFile(ctx.root, given)) : (await planInForce(ctx))?.rel
    if (!rel) return `No plan is in force yet, and approving never picks one by itself. Name it: ${APPROVE} <plan path> (plans live under ${PLANS_DIR}/).`
    const text = await ctx.fs.read(planFile(ctx.root, rel))
    if (text === undefined) return `Plan not found: ${rel}`
    if (!/^```pantheon-flow/m.test(text)) return `${rel} has no \`\`\`pantheon-flow block.`
    const parsed = parseFlow(text)
    if (!parsed.ok) return `${rel} is not a valid flow:\n${parsed.errors.map(error => `- ${error}`).join('\n')}`
    const missing = missingRoles(parsed.flow, ctx.available)
    if (missing.length) return `Not approved: the plan needs ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} disabled in the pantheon configuration. Enable ${missing.length > 1 ? 'them' : 'it'} or change the plan.`
    const { flow, hash } = parsed
    const planId = flow.planId
    trace.planId = planId
    // Two steps: the plan is shown first, and only the confirmation of what was shown approves it. The block can change between
    // the two (an edit, a file restored, a plan another session wrote), and then the confirmation is not the one printed.
    const key = listedKey(ctx, planId, rel)
    if (!confirm) {
      const now = await standing(ctx, planId)
      // The listing is what the confirmation is held to: the whole hash of this block, not the digits it prints.
      LISTED.delete(key)
      LISTED.set(key, hash)
      while (LISTED.size > LISTED_BLOCKS_MAX) LISTED.delete(LISTED.keys().next().value as string)
      return describePlan(rel, flow, now.status === 'approved' ? { flow: now.flow } : now.status === 'tampered' ? { why: now.why } : {})
    }
    const listed = LISTED.get(key)
    const verdict = confirmationVerdict(listed, hash, confirm)
    if (verdict === 'unlisted') {
      return `Not approved: ${rel} was not listed in this session yet, and a confirmation approves only a plan that was listed first. Run ${APPROVE} ${rel} (it lists what would run), read it, then confirm with the hash it prints.`
    }
    if (verdict === 'changed') {
      return `Not approved: the block of ${rel} is hash ${confirmationOf(flow)} now, not the one that was listed (${listed!.slice(0, CONFIRM_DIGITS)}). It changed after the commands were listed. Run ${APPROVE} ${rel} again, read what it lists and confirm with the new hash.`
    }
    if (verdict === 'digits') {
      return `Not approved: ${confirm} is not the hash that was printed for ${rel} (${listed!.slice(0, CONFIRM_DIGITS)}). Type the hash the listing printed, or list it again.`
    }
    LISTED.delete(key)
    // Approval replaces the snapshot with the block as it is now: adopted amendments and waiting edits are folded into it.
    const before = await ctx.serial(planId)(async () => {
      const file: ApprovedFile = { approvedHash: hash, flow }
      // The record of the approval and the plan in force go to the store before anything else is written for this approval
      // (the state's own loss note, the ledger, the snapshot, the state, the pointer, the journal): a crash anywhere after
      // leaves a snapshot that is not the attested one (held until the next approve) or a state behind its snapshot
      // (brought up to it), and never a pointer at a plan that was not approved.
      await ctx.attest.set(attestKey(ctx.root, planId), attestOf(file))
      await ctx.attest.set(activeKey(ctx.root), { planId, plan: rel })
      const at = await ctx.now()
      const base = await baseState(ctx, planId, flow, hash)
      for (const note of base.notes) await appendSafe(ctx, planId, { at, mode: ctx.mode, ...note })
      const previous = base.state
      // The progress of the tasks still in the flow is kept; the approval itself is what the person gives here.
      const moved = setApproved(withMode(previous.hash === hash ? previous : rebase(flow, previous), ctx.mode), hash)
      const state: FlowState = { ...moved, seenIds: remember(moved.seenIds, flow.tasks.map(task => task.id), SEEN_IDS_MAX) }
      for (const id of state.sideEffectsDone) if (!base.ledger.includes(id)) await recordSideEffect(ctx.fs, ctx.root, planId, id, at)
      await saveApproved(ctx.fs, ctx.root, planId, file)
      if (canonical(state) !== base.onDisk) await saveState(ctx.fs, ctx.root, state)
      await ctx.fs.write(activeMetaPath(ctx.root), `${JSON.stringify({ plan: rel, planId })}\n`)
      await ctx.fs.write(activePath(ctx.root), `${rel}\n`)
      const replaced = previous.approvedHash !== undefined && previous.approvedHash !== hash
      await appendSafe(ctx, planId, {
        at, mode: ctx.mode, kind: 'approval', event: 'approve', condition: 'approved', approvedHash: hash,
        detail: `approved ${hash} (${flow.tasks.length} tasks) from ${rel}, confirmed with ${confirm}${replaced ? `; replaces the approval ${previous.approvedHash}${previous.adoptedHash ? ` and its adopted amendments (${previous.adoptedHash})` : ''}` : ''}`,
      })
      return { amended: previous.adoptedHash !== undefined, waiting: (previous.seenEdits ?? []).length > 0 }
    })
    const commands = [...new Set(parsed.flow.tasks.flatMap(task => task.acceptance.checks.map(check => check.argv.join(' '))))]
    return [
      `Approved ${parsed.flow.planId} (hash ${short(parsed.hash)}, ${parsed.flow.tasks.length} tasks) from ${rel}. Mode: ${ctx.mode}.`,
      commands.length ? `Approving the plan approves its checks; they run on this machine:\n${commands.slice(0, 12).map(command => `- ${command}`).join('\n')}${commands.length > 12 ? `\n- ... and ${commands.length - 12} more` : ''}` : 'The plan declares no check commands.',
      ...(before.amended || before.waiting ? ['The approved snapshot is now this plan: adopted amendments and edits that were waiting are part of it.'] : []),
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
    const change = (state: FlowState): { state: FlowState; entries: Omit<JournalInput, 'at'>[] } => {
      if (action === 'pause') return { state: { ...state, paused: true }, entries: [{ kind: 'note', event: 'command', condition: 'command_pause', detail: 'paused by the person' }] }
      if (action === 'stop') return { state: { ...state, stopped: true, paused: false }, entries: [{ kind: 'note', event: 'command', condition: 'command_stop', detail: 'stopped by the person' }] }
      // A resume starts the attempts and the failure loop over: the person has decided how to go on.
      const attempts = Object.fromEntries(Object.entries(state.attempts).filter(([id]) => state.status[id] === 'done'))
      const next: FlowState = { ...state, paused: false, stopped: false, attempts, consecutiveBlocks: 0 }
      delete next.lastFailure
      delete next.lastOutput
      return { state: next, entries: [{ kind: 'note', event: 'command', condition: 'command_resume', detail: 'resumed by the person' }] }
    }
    if (loc.kind === 'tampered') {
      // The person may still pause or end a flow whose approval cannot be believed; approving it again is what restores it.
      const planId = loc.planId
      if (planId === undefined) return `No plan can be named, so there is nothing to ${action} (${loc.why}). Once the plugin store can be read, ${APPROVE} <plan path> brings the flow back.`
      trace.planId = planId
      await ctx.serial(planId)(async () => {
        const at = await ctx.now()
        const done = change((await loadState(ctx.fs, ctx.root, planId)) ?? emptyState(planId))
        await saveState(ctx.fs, ctx.root, done.state)
        for (const entry of done.entries) await appendSafe(ctx, planId, { at, mode: ctx.mode, ...entry })
      })
      return `Flow ${planId} ${label}. Its approval cannot be believed (${loc.why}): nothing of the plan runs until you ${APPROVE}.`
    }
    const result = await transact(ctx, loc, trace, state => ({ ...change(state), value: true }))
    return result ? `Flow ${loc.planId} ${label}.` : 'Nothing changed.'
  })
}

/** The task files of the approved plan, for links that were made before its edits were adopted (after a resume). */
export async function flowTaskFiles(ctx: Ctx): Promise<{ planId: string; files: Record<string, string[]> } | undefined> {
  return guarded<{ planId: string; files: Record<string, string[]> } | undefined>(ctx, 'task files', undefined, async () => {
    const loc = await locate(ctx)
    if (loc.kind !== 'ok') return undefined
    const p = await prepare(ctx, loc)
    if (!enforcing(p)) return undefined
    return { planId: loc.planId, files: Object.fromEntries(p.flow.tasks.map(task => [task.id, [...task.files]])) }
  })
}

export async function flowStatus(ctx: Ctx): Promise<string> {
  try {
    const head = `Pantheon flow: ${ctx.mode}`
    if (ctx.mode === 'off') return `${head}. Set the plugin option flow to shadow or enforce to use it.`
    const loc = await locate(ctx)
    if (loc.kind === 'none') return `${head}. No active flow; approve a plan with /pantheon flow approve.`
    if (loc.kind === 'invalid') return `${head}. The active plan ${loc.path} is not valid, so nothing is enforced:\n${loc.errors.map(error => `- ${error}`).join('\n')}`
    if (loc.kind === 'tampered') {
      return [
        head,
        loc.planId === undefined ? 'Plan: none can be named' : `Plan: ${loc.path} (${loc.planId})`,
        `Approval: NOT trusted: ${TAMPERED} (${loc.why}); run ${APPROVE}`,
        'Nothing of the plan is enforced or run until you do; the approval is still recorded in the state.',
      ].join('\n')
    }
    // Read-only: an adoptable edit is shown as one the next event adopts (and records first), not as one already in force.
    const p = await prepare(ctx, loc, SOON)
    const { flow, hash, state } = p
    const approved = enforcing(p)
    const approval = approved
      ? `approved (hash ${short(state.approvedHash ?? hash)}${state.adoptedHash ? `, amended by adopted edits: now ${short(hash)}` : ''})`
      : `NOT approved (hash ${short(hash)}); run ${APPROVE}`
    const lines = [
      head,
      `Plan: ${loc.path} (${loc.planId}), ${flow.tasks.length} tasks`,
      `Approval: ${approval}`,
      ...(p.adoptedTasks.length > 0 ? [`Adopted from plan edits, not approved by the person: ${p.adoptedTasks.join(', ')}`] : []),
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
    if (ctx.judge) {
      const judge = ctx.judge.status()
      const notes = [judge.off ? 'off for this session (the key or the endpoint was refused)' : '', judge.breakerOpen ? 'paused by its breaker' : '', judge.stoppedBatteries > 0 ? `${judge.stoppedBatteries} question set(s) stopped after a rejection` : ''].filter(Boolean)
      lines.push(`Judge: ${ctx.judge.mode}${notes.length > 0 ? `, ${notes.join('; ')}` : ''}`)
    } else lines.push('Judge: off (nothing is sent)')
    const waiting = (p.pending ?? []).filter(reason => reason !== SOON)
    if (approved && (p.pending ?? []).includes(SOON)) lines.push('Edits: the plan file holds an edit that is purely additive; the next event adopts it, recording it in the plugin store first.')
    if (approved && waiting.length) {
      lines.push(`Edits: ${waiting.length} waiting for ${APPROVE}; the approved flow keeps running without ${waiting.length === 1 ? 'it' : 'them'}:`)
      for (const reason of waiting) lines.push(`  - ${reason}`)
    }
    if (approved && p.invalid) {
      lines.push(`Plan file: not valid, so the approved flow keeps running until it is fixed or approved again:`)
      for (const error of p.invalid) lines.push(`  - ${error}`)
    }
    const last = (await readJournal(ctx.fs, ctx.root, flow.planId)).filter(entry => entry.kind === 'decision').pop()
    if (last) lines.push(`Last decision: ${last.event ?? '?'} ${last.action ?? ''} ${last.condition ?? ''}${last.task ? ` (${last.task})` : ''}${last.wouldBe ? `, enforce would ${last.wouldBe}` : ''} at ${new Date(last.at).toISOString()}`)
    return lines.join('\n')
  } catch (error) {
    return `Pantheon flow: ${ctx.mode}. The status could not be read: ${message(error)}`
  }
}
