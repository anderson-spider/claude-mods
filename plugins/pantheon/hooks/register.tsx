import { atom, read, update } from 'claude-code'
import type { AgentSpec, FsStat, Hook, ProcessRunInit, ProcessRunResult, Register, SettingsSource, ToolCallResult } from 'claude-code'

import type { FlowAgent, Native, SessionInfo } from '../types'
import { loadConfig } from './config'
import { rulesVerdict } from './decisions'
import { gateContext, gateMessage } from './gate'
import { DEFAULT_CONFIG } from './defaults'
import {
  approvePlan, controlFlow, flowStatus, flowTaskFiles, humanPrompt, inspectIsolation, inspectSpawn, mainEdit, noteOwnership,
  ownershipVerdict, parseNotification, pendingAgentTasks, qaCriteriaBrief, reviewed, stopFlow, taskEnded, taskIdOf,
} from './flow/controller'
import type { Ctx, Serial } from './flow/controller'
import type { CheckMemo } from './flow/checks'
import type { JudgeIo, Route } from './flow/judge'
import { createJudgeAccess, createJudgeSession, judgeModeOf, resolveJudge } from './flow/judging'
import type { JudgeSession, JudgeSetup, SettingsView } from './flow/judging'
import { createSerial } from './flow/store'
import type { Mode } from './flow/types'
import { buildCouncilBlock, isCouncilOrigin, matchesCouncilTrigger } from './prompts/council'
import { buildLeadSection } from './prompts/lead'
import { rolePrompt } from './prompts/roles'
import { pingPrompt, pingTargets } from './ping'
import type { PingResult } from './ping'
import { PANE_ID, configReport, doctorReport, drawPanel } from './pane'
import { isOffered, nativeAgentSpecs } from './roles'
import { buildRoster } from './roster'
import { agentsFromState, agentsKey } from './strip/agents'
import { renderStrip } from './strip/render'
import {
  adoptSharedLimits, cacheEnvFrom, configureStrip, endStrip, noteCompact, noteMeasure,
  noteStep, noteStripSpawn, noteStripTool, noteStripTurnStart, noteTurnComplete, startStrip, tickStrip,
} from './strip/state'
import type { StripHost } from './strip/state'
import {
  DEFAULT_SESSION, DEFAULT_VIEW, completed, describeTool, markNativesLost,
  normalizeNatives, normalizeSession, normalizeView, sessionCompleted, sessionMeasured, viewToggled,
  roundOpened, sessionStarted, sessionStepped, spawned, stepAccounted, toolNoted,
} from './tracking'
import type { ConfigResult, PantheonConfig } from './types'
import { authorizedRoot } from './workspace'

const gateHeld = atom({ plugin: 'pantheon', key: 'gateHeld' }, null)

type GateEvaluation = { deny: string } | undefined

export async function withGateRecovery(work: () => Promise<GateEvaluation>, forward: () => Promise<ToolCallResult>, ask: () => Promise<GateEvaluation>): Promise<ToolCallResult> {
  let evaluated: GateEvaluation
  try { evaluated = await work() } catch {
    try { evaluated = await ask() } catch {
      return { deny: 'Pantheon edit gate could not obtain a decision. Edit denied.' }
    }
  }
  // Forwarding is outside recovery. Only the engine's .catch can safely replay next.
  return evaluated ?? forward()
}

/** New files inherit their nearest existing ancestor's resolved location. */
export async function resolveGatePath(stat: (path: string, resolve: boolean) => Promise<FsStat>, raw: string, cwd: string): Promise<string> {
  if (!raw) throw new Error('Missing edit path')
  const isMissing = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false
    if ('code' in error) return error.code === 'ENOENT'
    // Host errors may carry only their message. Never infer absence from arbitrary text: the two shapes seen are a bare
    // `ENOENT: ...` and the engine's own `<plugin>: $.fs.stat(<path>) failed: ENOENT` (found by the end-to-end run, where
    // a new file of a task could not be written because only the first shape was known).
    return error instanceof Error && (/^ENOENT(?=:|$)/.test(error.message) || /^[\w@.-]+: \$\.fs\.stat\([\s\S]*\) failed: ENOENT(?=:|\s|$)/.test(error.message))
  }
  let candidate = raw.startsWith('/') ? raw : `${cwd}/${raw}`
  const missing: string[] = []
  while (true) {
    let own: FsStat | undefined
    try { own = await stat(candidate, true) } catch (error) {
      if (!isMissing(error)) throw error
      // stat without resolution still identifies the entry itself through isLink,
      // including dangling links. Only a second ENOENT confirms an absent entry.
      let absent = false
      try { await stat(candidate, false) } catch (inspectionError) {
        if (!isMissing(inspectionError)) throw inspectionError
        absent = true
      }
      if (!absent) throw new Error('Edit path exists but could not be resolved')
    }
    if (own) {
      const resolved = own.realPath
      if (!resolved?.startsWith('/') || (missing.length > 0 && own.kind !== 'dir')) {
        throw new Error('Could not resolve edit path')
      }
      // Collapsing a missing component followed by .. can expose an uninspected symlink.
      if (missing.includes('..')) throw new Error('Could not resolve parent traversal in missing path')
      const parts: string[] = []
      for (const part of `${resolved}/${missing.join('/')}`.split('/')) {
        if (part === '..') parts.pop()
        else if (part && part !== '.') parts.push(part)
      }
      return '/' + parts.join('/')
    }
    if (candidate === '/') throw new Error('Could not resolve edit path')
    const slash = candidate.lastIndexOf('/')
    missing.unshift(candidate.slice(slash + 1))
    candidate = candidate.slice(0, slash) || '/'
  }
}

/** O que os módulos precisam do engine, montado em cada hook (o `$` não pode ser guardado). */
type Io = {
  cwd: () => Promise<string>
  run: (argv: string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  home: () => Promise<string | undefined>
  readText: (path: string) => Promise<string | undefined>
  /** The path with its links followed; the path itself when the host cannot say. */
  realPath: (path: string) => Promise<string>
  toast: (text: string) => void
  registerAgent: (spec: AgentSpec) => Promise<unknown>
  after: (ms: number, fn: () => void) => { cancel: () => void }
  submit: (text: string) => Promise<unknown>
  /** One source of the engine's settings, as loaded (the judge options are checked against where they were set). */
  settings: (source: SettingsSource) => Promise<unknown>
}

type TrackingIo = {
  readNatives: () => Promise<unknown>
  writeNatives: (list: Native[]) => Promise<unknown>
  readSession: () => Promise<unknown>
  writeSession: (value: SessionInfo) => Promise<unknown>
  toast: (text: string) => void
  now: () => Promise<number>
}

/** The `$` a hook receives; it cannot be stored, so every hook builds what it needs from its own. */
type Dollar = Parameters<Hook<'session.start'>>[0]

/** What the config, doctor and native registration need from the engine, built from the hook's `$`. */
function hostIo($: Dollar): Io {
  return {
    cwd: () => $.session.cwd(),
    run: (argv, init) => $.process.run(argv, init),
    home: () => $.env.get('HOME'),
    readText: async path => (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined,
    realPath: async path => {
      try { return (await $.fs.stat(path, { resolve: true })).realPath ?? path } catch { return path }
    },
    toast: text => $.ui.toast(text),
    registerAgent: spec => $.agent.register(spec),
    after: (ms, fn) => $.clock.after(ms, fn),
    submit: text => $.prompt.submit({ text }),
    settings: source => $.settings.read({ source }),
  }
}

/**
 * The judge's host access from the hook's `$`: the request goes through the host's network (`$.http.fetch`, whose answer
 * carries the headers the retry reads), the timer is the host's clock, and the epoch clock and the jitter are plain
 * synchronous calls. Nothing else is sent than what `judge` builds: an Authorization and a Content-Type, no Referer, no X-Title.
 */
function judgeIo($: Dollar): JudgeIo {
  return {
    fetch: async (url, init) => {
      const response = await $.http.fetch(url, init)
      return { status: response.status, ok: response.ok, text: response.text, headers: response.headers }
    },
    timer: (ms, fn) => {
      const handle = $.clock.after(ms, fn)
      return () => handle.cancel()
    },
    now: () => Date.now(),
    random: () => Math.random(),
  }
}

/** Host access for the above-prompt strip modules, built from the hook's `$`. */
function stripHost($: Dollar): StripHost {
  return {
    now: () => $.clock.now(),
    sessionId: () => $.session.id(),
    cwd: () => $.session.cwd(),
    model: () => $.session.model(),
    run: (argv, init) => $.process.run(argv, init),
    usage: () => $.session.usage(),
    storeKeys: () => $.store.keys(),
    storeGet: key => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    storeDelete: key => $.store.delete(key),
  }
}

/**
 * Serialize writes and replace any waiting snapshot with the latest one; with `merge`, a waiting
 * value is combined with the new one instead (for actions that must all happen, in order).
 */
export function createQueue<T>(write: (v: T) => Promise<unknown>, onError: (e: unknown) => void, merge?: (waiting: T, next: T) => T) {
  let pending: { value: T } | undefined
  let flushing: Promise<void> | undefined
  return {
    push(value: T): void {
      pending = { value: pending && merge ? merge(pending.value, value) : value }
      flushing ??= Promise.resolve().then(async () => {
        try {
          while (pending) {
            const next = pending.value
            pending = undefined
            try { await write(next) } catch (error) {
              try { onError(error) } catch { /* Reporting must not stop the queue. */ }
            }
          }
        } finally {
          flushing = undefined
        }
      })
    },
    flushed: (): Promise<void> => flushing ?? Promise.resolve(),
  }
}

const nativesAtom = atom({ plugin: 'pantheon', key: 'natives' } as const, [] as Native[])
const sessionAtom = atom({ plugin: 'pantheon', key: 'session' } as const, DEFAULT_SESSION)
const viewAtom = atom({ plugin: 'pantheon', key: 'view' } as const, DEFAULT_VIEW)
const flowAgentsAtom = atom({ plugin: 'pantheon', key: 'flowAgents' } as const, {} as Record<string, FlowAgent>)

/** Links the controller keeps: the newest, so the atom stays small. */
export const FLOW_AGENTS_MAX = 48

/** The `flow` option: off, shadow (the default, also for anything unrecognised) or enforce. */
export function flowModeOf(value: unknown): Mode {
  return value === 'off' || value === 'enforce' ? value : 'shadow'
}

/** The link for an agent, replacing an older one and dropping the oldest links past the cap. */
export function withFlowAgent(links: Record<string, FlowAgent>, agentId: string, link: FlowAgent): Record<string, FlowAgent> {
  const rest = Object.entries(links).filter(([id]) => id !== agentId)
  return Object.fromEntries([...rest, [agentId, link]].slice(-FLOW_AGENTS_MAX))
}

/** What a flow call needs besides the hook's `$`; built by `register`, which owns the root, the config and the queues. */
type FlowDeps = {
  root: string
  mode: Mode
  config: PantheonConfig
  serial: (planId: string) => Serial
  memo: CheckMemo
  warn: (text: string) => void
  /** Present only while the judge is on and a key is set: what `flowCtx` builds the controller's `judge` from. */
  judge?: { mode: 'shadow' | 'escalate'; route: Route; home: string; session: JudgeSession; toast: (text: string) => void }
}

/** What the flow hooks share while a module instance lives (a hot reload starts it again). */
type FlowRuntime = {
  /**
   * The links as this module wrote them. `$.state` reads inside a dispatch are snapshots, so a write that raced a link's
   * storage must see it here; the state value is what survives a reload.
   */
  links: Map<string, FlowAgent>
  /** Delegations of a task's agents that are starting: the link of the agent they start is not written yet. */
  pending: Set<Promise<void>>
  /** Agents known not to belong to any task, so each write by one does not ask the engine again. */
  strangers: Set<string>
  uid: Promise<string | undefined> | undefined
}

const PENDING_WAIT_MS = 2000
const STRANGERS_MAX = 500

/** Keeps a link in memory (the newest FLOW_AGENTS_MAX) and in the state value. */
async function storeFlowAgent($: Dollar, rt: FlowRuntime, agentId: string, link: FlowAgent): Promise<void> {
  rt.links.delete(agentId)
  rt.links.set(agentId, link)
  while (rt.links.size > FLOW_AGENTS_MAX) rt.links.delete(rt.links.keys().next().value as string)
  await update($, flowAgentsAtom, links => withFlowAgent(links, agentId, link))
}

/** The link of an agent as last written: memory first, then the state value. */
async function flowAgentOf($: Dollar, rt: FlowRuntime, agentId: string): Promise<FlowAgent | undefined> {
  return rt.links.get(agentId) ?? (await read($, flowAgentsAtom))[agentId]
}

/** Counts a refused write for a work agent, or clears the count when its delivery has been judged. */
async function setFlowDenials($: Dollar, rt: FlowRuntime, agentId: string, count: (before: number) => number): Promise<void> {
  const current = await flowAgentOf($, rt, agentId)
  if (current) {
    rt.links.delete(agentId)
    rt.links.set(agentId, { ...current, denials: count(current.denials) })
  }
  await update($, flowAgentsAtom, links => links[agentId] ? { ...links, [agentId]: { ...links[agentId]!, denials: count(links[agentId]!.denials) } } : links)
}

/**
 * What a write gets when the ownership hook did not finish (it outlasted its budget, or failed outside what it guards): in
 * enforce, a write by an agent the flow linked to a task is not let through unchecked. Every other write is not the flow's to
 * hold, and nothing is refused outside enforce.
 */
export function flowWriteFallback(links: ReadonlyMap<string, FlowAgent>, mode: Mode, agentId: string | undefined): string | undefined {
  const link = mode === 'enforce' && agentId ? links.get(agentId) : undefined
  return link?.kind === 'work' && link.files
    ? `[Pantheon flow] The flow could not check this write against task ${link.task}'s files in time, so it was not made. Try it again.`
    : undefined
}

/** Marks a delegation as starting until the returned function is called. */
function holdPending(rt: FlowRuntime): () => void {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  rt.pending.add(gate)
  return () => { release(); rt.pending.delete(gate) }
}

/** An agent spawned by a task's work agent writes under that task's files, and its denials count for the task's agent. */
function inherited(parent: FlowAgent, parentId: string): FlowAgent {
  return { task: parent.task, plan: parent.plan, kind: 'work', end: parent.end, denials: 0, ...(parent.files ? { files: parent.files } : {}), root: parent.root ?? parentId }
}

/**
 * The link of an agent. A link is written only once its spawn has resolved, so an agent's first write can come first: it
 * waits for the delegations in flight (at most PENDING_WAIT_MS), then asks the engine what the agent is (its `[T]`
 * description, or the agent that spawned it) and adopts it. Agents that turn out to be no task's are remembered.
 */
async function flowLinkFor($: Dollar, rt: FlowRuntime, deps: FlowDeps, agentId: string, depth = 0): Promise<FlowAgent | undefined> {
  const find = () => flowAgentOf($, rt, agentId)
  let link = await find()
  if (link || rt.strangers.has(agentId)) return link
  // Only the first level waits: the wait for what is starting is one wait of at most PENDING_WAIT_MS, whatever the depth of
  // the parents asked after, not one per level.
  if (depth === 0 && rt.pending.size > 0) {
    let timer: { cancel: () => void } | undefined
    await Promise.race([
      Promise.allSettled([...rt.pending]),
      new Promise<void>(resolve => { timer = $.clock.after(PENDING_WAIT_MS, () => resolve()) }),
    ])
    timer?.cancel()
    link = await find()
    if (link) return link
  }
  const info = depth < 4 ? (await $.agent.list()).find(agent => agent.id === agentId) : undefined
  let adopted: FlowAgent | undefined
  if (info?.parentId) {
    const parent = await flowLinkFor($, rt, deps, info.parentId, depth + 1)
    if (parent?.kind === 'work' && parent.files) adopted = inherited(parent, info.parentId)
  } else if (info) {
    const taskId = taskIdOf(info.description)
    const check = taskId ? await inspectSpawn(flowCtx($, deps), { taskId, agentType: info.type, lookup: true }) : undefined
    if (taskId && check?.kind === 'work' && check.planId && check.files) {
      adopted = { task: taskId, plan: check.planId, kind: 'work', end: check.end, denials: 0, files: check.files }
    }
  }
  if (adopted) {
    await storeFlowAgent($, rt, agentId, adopted)
    return adopted
  }
  if (rt.strangers.size >= STRANGERS_MAX) rt.strangers.clear()
  rt.strangers.add(agentId)
  return undefined
}

/**
 * Whether a write is inside the task's files, with the path and the root both resolved by the host (links followed), as
 * the gate does, so `/var` against `/private/var` or a link out of an owned directory cannot change the answer. A path the
 * host cannot resolve is refused. The scratchpad allowed is this session's, for this user.
 */
async function flowOwnership($: Dollar, rt: FlowRuntime, deps: FlowDeps, link: FlowAgent, raw: string) {
  const cwd = await $.session.cwd()
  const stat = (path: string, resolve: boolean) => $.fs.stat(path, { resolve })
  const root = await resolveGatePath(stat, deps.root, cwd)
  rt.uid ??= $.process.run(['id', '-u']).then(out => {
    const uid = out.stdout.trim()
    return out.exitCode === 0 && /^\d+$/.test(uid) ? uid : undefined
  }).catch(() => undefined)
  const scratch = { uid: await rt.uid, sessionId: String(await $.session.id()) }
  let path: string
  try { path = await resolveGatePath(stat, raw, cwd) } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { owned: false as const, reason: `Task ${link.task}: ${raw} could not be resolved to a real path (${why}). Write it by a plain path inside the task's files.` }
  }
  // The plugin's own store holds what the flow trusts (the attestation, the plan in force): no task's agent writes it, wherever
  // the repository's root is. The configuration directory is `CLAUDE_CONFIG_DIR` when set, else `~/.claude`.
  const never: string[] = []
  try {
    const configured = await $.env.get('CLAUDE_CONFIG_DIR')
    const home = await $.env.get('HOME')
    for (const dir of [configured, home ? `${home}/.claude` : undefined]) {
      if (dir) never.push(await resolveGatePath(stat, `${dir.replace(/\/+$/, '')}/plugins/store`, cwd))
    }
  } catch { /* A directory that cannot be resolved is guarded as spelled by the other entry, or by being outside the files. */ }
  return ownershipVerdict(link.task, link.files ?? [], root, path, scratch, never)
}

/** The root and a path as the host resolves them (links followed), as the ownership gate reads them; a path it cannot resolve as written. */
async function flowResolved($: Dollar, root: string, raw: string): Promise<{ root: string; path: string }> {
  const cwd = await $.session.cwd()
  const stat = (path: string, resolve: boolean) => $.fs.stat(path, { resolve })
  const resolvedRoot = await resolveGatePath(stat, root, cwd)
  try { return { root: resolvedRoot, path: await resolveGatePath(stat, raw, cwd) } } catch { return { root: resolvedRoot, path: raw } }
}

/** The controller's host access, built from the hook's `$` (it cannot be stored). */
function flowCtx($: Dollar, deps: FlowDeps): Ctx {
  return {
    fs: {
      read: async path => (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined,
      write: (path, text) => $.fs.write(path, text),
    },
    run: async (argv, init) => {
      const out = await $.process.run(argv, { cwd: init.cwd, timeoutMs: init.timeoutMs, ...(init.stdin === undefined ? {} : { stdin: init.stdin }) })
      return { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr }
    },
    // A check's working directory: not there, not a directory, or fine. A host that cannot say rejects, and the check just runs.
    probeDir: async path => {
      if (!(await $.fs.exists(path))) return 'missing'
      return (await $.fs.stat(path)).kind === 'dir' ? 'directory' : 'other'
    },
    now: async () => Number(await $.clock.now()),
    root: deps.root,
    mode: deps.mode,
    available: {
      developer: isOffered(deps.config, 'pantheon:developer'),
      ux: isOffered(deps.config, 'pantheon:ux'),
      architect: isOffered(deps.config, 'pantheon:architect'),
      qa: isOffered(deps.config, 'pantheon:qa'),
    },
    serial: deps.serial,
    memo: deps.memo,
    // The plugin's own store, outside the repository: what the controller trusts to say what the person approved and which plan is in force.
    attest: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) },
    warn: deps.warn,
    ...(deps.judge ? {
      judge: createJudgeAccess({
        mode: deps.judge.mode, route: deps.judge.route, io: judgeIo($), session: deps.judge.session,
        redact: { home: deps.judge.home, root: deps.root }, toast: deps.judge.toast,
      }),
    } : {}),
  }
}

/**
 * A subagent of a flow task returned (a foreground Agent result, or a background task's notification): the controller
 * decides on that delivery. Returns the verdict text for the lead (enforce only).
 */
async function finishFlowAgent($: Dollar, rt: FlowRuntime, deps: FlowDeps, agentId: string, output: string, completed: boolean): Promise<string | undefined> {
  const link = await flowAgentOf($, rt, agentId)
  if (!link) return undefined
  // Each return is one delivery (a resumed agent returns again); its denials were counted for this one alone.
  if (link.denials > 0) await setFlowDenials($, rt, agentId, () => 0)
  // A diagnosis is advice for the lead, and an agent that did not finish proved nothing either way.
  if (link.kind === 'diagnosis' || !completed) return undefined
  const ctx = flowCtx($, deps)
  if (link.kind === 'work') return (await taskEnded(ctx, { taskId: link.task, ownershipDenials: link.denials, output })).text
  return (await reviewed(ctx, { taskId: link.task, by: link.by ?? 'qa', end: link.end, output, ...(link.git ? { git: link.git } : {}) })).text
}

/** The agents the strip folds into its last row: every running native. */
async function stripAgents($: Dollar, now: number) {
  return agentsFromState(normalizeNatives(await read($, nativesAtom)), now)
}

export const register: Register = (on, options) => {
  let state: ConfigResult = { ok: true, config: DEFAULT_CONFIG, origins: {} }
  let lastValid: PantheonConfig | undefined
  let gateRoot: string | undefined
  let gateUid: Promise<string | undefined> | undefined
  type GateChoice = 'proceed' | 'cancel'
  let gateWaiting: { decision: GateChoice | null } | undefined
  let gateInteractive = false

  // Like branch-guard, decisions travel in memory: state reads inside a dispatch are snapshots.
  async function holdGate(io: { poll: () => Promise<unknown>; show: (value: { message: string } | null) => Promise<unknown> }, message: string, signal: AbortSignal): Promise<GateChoice | 'aborted'> {
    const slot = { decision: null as GateChoice | null }
    try {
      while (gateWaiting !== undefined) {
        if (signal.aborted) return 'aborted'
        // A host call does not consume the hook's time budget while the person decides.
        await io.poll()
      }
      if (signal.aborted) return 'aborted'
      gateWaiting = slot
      await io.show({ message })
      while (slot.decision === null && !signal.aborted) await io.poll()
      return signal.aborted ? 'aborted' : slot.decision ?? 'aborted'
    } catch {
      return 'aborted'
    } finally {
      if (gateWaiting === slot) {
        try { await io.show(null) } catch { /* Cleanup failure must not release the edit. */ }
        finally { gateWaiting = undefined }
      }
    }
  }
  let registeredKey: string | undefined
  let toastedError: string | undefined
  const aboveOn = options.abovePrompt !== false && options.abovePrompt !== 'false'

  // The decision flow: its mode, one queue per plan (every write to a plan's files goes through it), and the last problem.
  const flowMode = flowModeOf(options.flow)
  const flowSerials = new Map<string, Serial>()
  const flowSerial = (planId: string): Serial => {
    let serial = flowSerials.get(planId)
    if (!serial) { serial = createSerial(); flowSerials.set(planId, serial) }
    return serial
  }
  const flowMemo: CheckMemo = new Map()
  const flowRuntime: FlowRuntime = { links: new Map(), pending: new Set(), strangers: new Set(), uid: undefined }
  let flowLastProblem: string | undefined
  const flowToasted = new Set<string>()
  const flowWarning = (io: Pick<Io, 'toast'>) => (text: string): void => {
    flowLastProblem = text
    // Only enforce changes the session, so only enforce is worth a toast, once per distinct problem.
    if (flowMode !== 'enforce' || flowToasted.has(text)) return
    flowToasted.add(text)
    try { io.toast(`pantheon: ${text}`) } catch { /* A failed toast changes nothing. */ }
  }
  const flowFailed = (io: Pick<Io, 'toast'>, error: unknown): void => {
    flowWarning(io)(`the flow failed open — ${error instanceof Error ? error.message : String(error)}`)
  }
  // Hooks act only once session.start has found the repository root: the flow never runs a command to look for it.
  const flowOn = (): boolean => flowMode !== 'off' && gateRoot !== undefined
  // The attestation is keyed by the real path of the root, not by how the session's cwd spells it.
  let flowRealRoot: { spelled: string; real: string } | undefined
  // The judge (decisions 10 and 18): `judge` is off by default, and then nothing is read or sent. The key, the route and a base URL
  // come from the plugin's options only (never a file of the repository, never the environment). One session, so one breaker
  // and one "off for the session" for every caller; it lives as long as this module instance does.
  const judgeSession = createJudgeSession(() => Date.now())
  let judgeSetup: Promise<JudgeSetup> | undefined
  const judgeDeps = async (io: Io): Promise<FlowDeps['judge']> => {
    if (judgeModeOf(options.judge) === 'off') return undefined
    judgeSetup ??= (async (): Promise<JudgeSetup> => {
      // Where the options were set matters only when there is a key to protect: with none, no request can be made and the
      // settings are not read. Every source is read (the engine gives each whole, its `env` included; only
      // `pluginConfigs` is looked at), and one that cannot be read leaves the options unattributable.
      let view: SettingsView | undefined
      if (typeof options.judgeKey === 'string' && options.judgeKey.trim() !== '') {
        const sources = async (names: readonly SettingsSource[]) => {
          const out: unknown[] = []
          let readable = true
          for (const name of names) {
            try { out.push(await io.settings(name)) } catch { readable = false }
          }
          return { out, readable }
        }
        const trusted = await sources(['user', 'flag', 'policy'])
        const repo = await sources(['project', 'local'])
        view = { trusted: trusted.out, repo: repo.out, readable: trusted.readable && repo.readable }
      }
      const setup = resolveJudge(options, view)
      for (const note of setup.notes) { try { io.toast(`pantheon: ${note}`) } catch { /* A failed toast changes nothing. */ } }
      return setup
    })()
    const setup = await judgeSetup
    if (setup.mode === 'off' || !setup.route) return undefined
    return { mode: setup.mode, route: setup.route, home: (await io.home()) ?? '', session: judgeSession, toast: text => io.toast(text) }
  }
  const flowDeps = async (io: Io): Promise<FlowDeps> => {
    const spelled = gateRoot ?? (await workspace(io)).root
    if (flowRealRoot?.spelled !== spelled) flowRealRoot = { spelled, real: await io.realPath(spelled) }
    const judge = await judgeDeps(io)
    return {
      root: flowRealRoot.real, mode: flowMode, config: state.config, serial: flowSerial, memo: flowMemo, warn: flowWarning(io),
      ...(judge ? { judge } : {}),
    }
  }
  configureStrip({ paceStart: options.paceStart })
  let minuteTicker: { cancel: () => void } | undefined
  let stripTicker: { cancel: () => void } | undefined

  let trackingLive: TrackingIo | undefined
  let natives: Native[] | undefined
  let session: SessionInfo | undefined
  let trackingLoad: Promise<void> | undefined
  let warnedTrackingWrite = false
  function notifyTrackingWrite(error: unknown): void {
    if (warnedTrackingWrite) return
    warnedTrackingWrite = true
    try {
      trackingLive?.toast(`pantheon: could not save the panel state (the panel may be stale): ${error instanceof Error ? error.message : String(error)}`)
    } catch { /* A failed warning must not affect the user's call. */ }
  }
  const nativesQueue = createQueue<Native[]>(list => trackingLive!.writeNatives(list), notifyTrackingWrite)
  const sessionQueue = createQueue<SessionInfo>(value => trackingLive!.writeSession(value), notifyTrackingWrite)
  // Each view write carries the `$` of the hook that asked for it; only the latest pending one runs.
  const viewQueue = createQueue<() => Promise<unknown>>(write => write(), notifyTrackingWrite, (a, b) => async () => { await a(); await b() })

  async function ensureTracking(io: TrackingIo): Promise<void> {
    trackingLive = io
    if (natives !== undefined && session !== undefined) return
    trackingLoad ??= (async () => {
      const [savedNatives, savedSession] = await Promise.all([io.readNatives(), io.readSession()])
      natives = markNativesLost(normalizeNatives(savedNatives))
      session = { ...normalizeSession(savedSession), isRunning: false }
      nativesQueue.push(natives)
      sessionQueue.push(session)
    })().finally(() => { trackingLoad = undefined })
    await trackingLoad
  }

  async function workspace(io: Pick<Io, 'cwd' | 'run'>): Promise<{ sessionCwd: string; root: string }> {
    const sessionCwd = await io.cwd()
    const top = await io.run(['git', 'rev-parse', '--show-toplevel'], { cwd: sessionCwd }).catch(() => undefined)
    const gitTop = top && top.exitCode === 0 ? top.stdout.trim() || undefined : undefined
    const root = authorizedRoot(sessionCwd, gitTop)
    gateRoot = root
    return { sessionCwd, root }
  }

  async function refreshConfig(io: Pick<Io, 'home' | 'readText' | 'toast' | 'registerAgent'>, root: string): Promise<ConfigResult> {
    const home = await io.home()
    state = await loadConfig(io.readText, {
      user: `${home ?? '~'}/.claude/pantheon.json`,
      project: `${root}/.claude/pantheon.json`,
    }, lastValid)
    if (state.ok) {
      lastValid = state.config
      toastedError = undefined
      await registerNatives(io, state.config)
    } else {
      // Sem nenhuma config válida até aqui, os nativos ficam com os padrões.
      if (!lastValid) await registerNatives(io, state.config)
      if (state.error !== toastedError) {
        toastedError = state.error
        io.toast(`pantheon: invalid config — ${state.error}`)
      }
    }
    return state
  }

  async function registerNatives(io: Pick<Io, 'registerAgent' | 'toast'>, config: PantheonConfig) {
    const key = JSON.stringify(config)
    if (key === registeredKey) return
    try {
      for (const spec of nativeAgentSpecs(config, rolePrompt)) {
        await io.registerAgent({
          name: spec.name, description: spec.description, prompt: spec.prompt,
          ...(spec.model ? { model: spec.model } : {}),
          ...(spec.effort ? { effort: spec.effort } : {}),
          ...(spec.disallowedTools ? { disallowedTools: spec.disallowedTools } : {}),
        })
      }
      // Só marca como registrado depois de todos: uma falha é tentada de novo no próximo turno.
      registeredKey = key
    } catch (error) {
      io.toast(`pantheon: could not register the native agents: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  on('session.start', async ($, e, next) => {
    gateInteractive = e.isInteractive === true && e.surface != null
    gateWaiting = undefined
    if (options.gate === true) await update($, gateHeld, () => null)
    const io = hostIo($)
    const started = await next(e)
    await refreshConfig(io, (await workspace(io)).root)
    await $.command.register({
      name: 'pantheon',
      description: 'Open the Pantheon pane; subcommands: close, config, doctor, flow',
      argumentHint: '[close | config | doctor | flow status|approve|pause|resume|stop]',
    })
    try {
      const trackingIo: TrackingIo = {
        readNatives: () => read($, nativesAtom),
        writeNatives: list => update($, nativesAtom, () => list),
        readSession: () => read($, sessionAtom),
        writeSession: value => update($, sessionAtom, () => value),
        toast: text => $.ui.toast(text),
        now: () => $.clock.now(),
      }
      await ensureTracking(trackingIo)
      await Promise.all([nativesQueue.flushed(), sessionQueue.flushed()])
      viewQueue.push(() => update($, viewAtom, normalizeView))
      await viewQueue.flushed()
    } catch { /* Tracking must not interrupt session setup. */ }
    try {
      await $.ui.open({ id: PANE_ID, title: 'Pantheon', columns: 72, rows: 8, closeOnEscape: true })
    } catch { /* A surface without panes must still start the session. */ }
    minuteTicker?.cancel()
    stripTicker?.cancel()
    if (aboveOn) {
      try {
        // Names stay literal: the engine lists the variables a module reads.
        const readEnv = async (get: () => Promise<string | undefined>) => { try { return (await get()) || '' } catch { return '' } }
        const env = {
          off: await readEnv(() => $.env.get('DISABLE_PROMPT_CACHING')),
          force5m: await readEnv(() => $.env.get('FORCE_PROMPT_CACHING_5M')),
          ttl: await readEnv(() => $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')),
          enable1h: await readEnv(() => $.env.get('ENABLE_PROMPT_CACHING_1H')),
        }
        await startStrip(stripHost($), cacheEnvFrom(env))
        // Every minute: elapsed time moves on, and another session may have measured something newer.
        minuteTicker = $.clock.every(60_000, async () => {
          try { await adoptSharedLimits(stripHost($)) } catch { /* The next tick tries again. */ }
          $.ui.invalidate('ui.render')
        })
        // Every second the agents' clocks move while any runs; the cache countdown, git and model
        // readings are checked every tenth tick, and a change in the agents redraws at once.
        let ticks = 0
        let lastKey = ''
        // A slow tick (git readings) must not overlap with the next one.
        let isTicking = false
        stripTicker = $.clock.every(1000, async () => {
          if (isTicking) return
          isTicking = true
          try {
            ticks++
            const now = await $.clock.now()
            const agents = await stripAgents($, now)
            const key = agentsKey(agents)
            const agentsChanged = key !== lastKey
            lastKey = key
            const due = ticks % 10 === 0
            const redraw = due ? await tickStrip(stripHost($), agentsChanged) : agentsChanged
            if (redraw || agents.length > 0) $.ui.invalidate('ui.render')
          } catch { /* A failed tick leaves the strip as it was. */ } finally { isTicking = false }
        })
        $.ui.invalidate('ui.render')
      } catch { /* The strip must not interrupt session setup. */ }
    }
    return started
  })

  on('turn.start', async ($, e, next) => {
    try {
      const io: TrackingIo = {
        readNatives: () => read($, nativesAtom),
        writeNatives: list => update($, nativesAtom, () => list),
        readSession: () => read($, sessionAtom),
        writeSession: value => update($, sessionAtom, () => value),
        toast: text => $.ui.toast(text),
        now: () => $.clock.now(),
      }
      await ensureTracking(io)
      const now = await io.now()
      session = sessionStarted(session!, now)
      sessionQueue.push(session)
      await sessionQueue.flushed()
    } catch { /* Tracking never changes the turn. */ }
    // turn.start is the main loop's: the last-turn receipt's counters begin again.
    if (aboveOn) { try { noteStripTurnStart() } catch { /* The strip never changes the turn. */ } }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const io: TrackingIo = {
      readNatives: () => read($, nativesAtom),
      writeNatives: list => update($, nativesAtom, () => list),
      readSession: () => read($, sessionAtom),
      writeSession: value => update($, sessionAtom, () => value),
      toast: text => $.ui.toast(text),
      now: () => $.clock.now(),
    }
    // A native's round opens before its response streams, so a continuation reads running while
    // it works; the step and its usage are counted once the response is in. The snapshot is queued,
    // never awaited: a slow write must not hold the step.
    if (e.agentId) {
      try {
        await ensureTracking(io)
        const now = await io.now()
        natives = roundOpened(natives!, { id: e.agentId, turnId: e.turnId, now })
        nativesQueue.push(natives)
      } catch { /* Tracking never changes the stream. */ }
    }
    let at = 0
    if (aboveOn && !e.agentId) { try { at = await $.clock.now() } catch { /* The strip falls back to 0. */ } }
    const result = yield* next(e)
    if (aboveOn && !e.agentId) {
      try { if (noteStep(e, result, at)) $.ui.invalidate('ui.render') } catch { /* The strip never changes the step. */ }
    }
    try {
      await ensureTracking(io)
      if (!e.agentId) {
        session = sessionStepped(session!, e.model, String(e.effort ?? ''))
        sessionQueue.push(session)
        await sessionQueue.flushed()
      } else {
        natives = stepAccounted(natives!, { id: e.agentId, usage: result.usage ?? undefined })
        nativesQueue.push(natives)
        await nativesQueue.flushed()
      }
    } catch { /* Preserve both the stream and its result when tracking fails. */ }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      const io: TrackingIo = {
        readNatives: () => read($, nativesAtom),
        writeNatives: list => update($, nativesAtom, () => list),
        readSession: () => read($, sessionAtom),
        writeSession: value => update($, sessionAtom, () => value),
        toast: text => $.ui.toast(text),
        now: () => $.clock.now(),
      }
      await ensureTracking(io)
      if (!e.agentId) {
        session = sessionCompleted(session!, e.durationMs)
        sessionQueue.push(session)
        await sessionQueue.flushed()
      } else {
        const now = await io.now()
        natives = completed(natives!, { id: e.agentId, reason: e.reason, now })
        nativesQueue.push(natives)
        await nativesQueue.flushed()
      }
    } catch { /* Tracking never changes the completion result. */ }
    if (aboveOn && !e.agentId) {
      try {
        await noteTurnComplete(stripHost($), { durationMs: e.durationMs, reason: e.reason })
        $.ui.invalidate('ui.render')
      } catch { /* No reading this turn: the strip keeps the previous one. */ }
    }
    return done
  })

  // A compaction of the main conversation: the context drops now, not at the end of the next prompt.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (aboveOn) {
      try { if (await noteCompact(stripHost($), e, result)) $.ui.invalidate('ui.render') } catch { /* The strip catches up at the next turn. */ }
    }
    return result
  })

  on('session.end', async (_$, e, next) => {
    // A real end (exit, or process stopped); /clear, /resume and disconnect keep the tickers.
    if (e.reason === 'prompt_input_exit' || e.reason === 'other') {
      minuteTicker?.cancel()
      stripTicker?.cancel()
      endStrip()
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    try {
      const io: TrackingIo = {
        readNatives: () => read($, nativesAtom),
        writeNatives: list => update($, nativesAtom, () => list),
        readSession: () => read($, sessionAtom),
        writeSession: value => update($, sessionAtom, () => value),
        toast: text => $.ui.toast(text),
        now: () => $.clock.now(),
      }
      await ensureTracking(io)
      session = sessionMeasured(session!, e.context, e.cost)
      sessionQueue.push(session)
      await sessionQueue.flushed()
    } catch { /* Tracking never changes the measurement result. */ }
    if (aboveOn) {
      try {
        await noteMeasure(stripHost($), e)
        $.ui.invalidate('ui.render')
      } catch { /* The strip never changes the measurement. */ }
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    // The receipt counts the subagents the main loop spawned.
    if (aboveOn && !e.parentAgentId && started.agentId) { try { noteStripSpawn() } catch { /* The strip never changes the spawn. */ } }
    try {
      if (started.agentId) {
        const io: TrackingIo = {
          readNatives: () => read($, nativesAtom),
          writeNatives: list => update($, nativesAtom, () => list),
          readSession: () => read($, sessionAtom),
          writeSession: value => update($, sessionAtom, () => value),
          toast: text => $.ui.toast(text),
          now: () => $.clock.now(),
        }
        await ensureTracking(io)
        const now = await io.now()
        natives = spawned(natives!, { id: started.agentId, type: e.subagentType, task: e.description, model: started.model, now })
        nativesQueue.push(natives)
        await nativesQueue.flushed()
      }
    } catch { /* Tracking never changes the spawn result. */ }
    return started
  })

  // The flow links a delegation to its task by the `[<taskId>]` that starts its description, and holds it to decisions 16 and 17:
  // the task's own role, or qa/architect only for a receipt the task awaits. Registered after tracking, so it runs beneath it.
  on('agent.spawn', { description: /^\s*\[[A-Za-z]/ }, async ($, e, next) => {
    const taskId = !flowOn() || e.parentAgentId ? undefined : taskIdOf(e.description)
    if (!taskId) return next(e)
    const io = hostIo($)
    let check: Awaited<ReturnType<typeof inspectSpawn>> | undefined
    try { check = await inspectSpawn(flowCtx($, await flowDeps(io)), { taskId, agentType: e.subagentType }) } catch (error) { flowFailed(io, error) }
    if (check?.deny) return { deny: check.deny }
    // The lead writes the QA brief, so in enforce the approved criteria are appended to it: the lead cannot hand QA its own
    // answers. Shadow rewrites nothing.
    const brief = flowMode === 'enforce' && check?.kind === 'review' && check.by === 'qa' && check.criteria ? qaCriteriaBrief(taskId, check.criteria) : undefined
    const forward = brief ? { ...e, prompt: `${e.prompt}\n\n${brief}` } : e
    // Nothing is linked unless a plan is in force for the task: nothing to wait for then either.
    if (!check?.kind || !check.planId) return next(forward)
    // The link is written after the spawn resolves; an agent's first write waits for it (flowLinkFor).
    const release = holdPending(flowRuntime)
    try {
      const started = await next(forward)
      if (started.agentId) {
        const link: FlowAgent = {
          task: taskId, plan: check.planId, kind: check.kind, end: check.end, denials: 0,
          ...(check.by ? { by: check.by } : {}), ...(check.files ? { files: check.files } : {}), ...(check.git ? { git: check.git } : {}),
        }
        try { await storeFlowAgent($, flowRuntime, started.agentId, link) } catch (error) { flowFailed(io, error) }
      }
      return started
    } finally { release() }
  })

  // A subagent spawned by a task's work agent writes under that task's files too: it inherits the task, whatever its description.
  on('agent.spawn', { parentAgentId: /./ }, async ($, e, next) => {
    if (!flowOn() || !e.parentAgentId) return next(e)
    const io = hostIo($)
    const parentId = e.parentAgentId
    let parent: FlowAgent | undefined
    try { parent = await flowLinkFor($, flowRuntime, await flowDeps(io), parentId) } catch (error) { flowFailed(io, error) }
    if (parent?.kind !== 'work' || !parent.files) return next(e)
    const release = holdPending(flowRuntime)
    try {
      const started = await next(e)
      const child = inherited(parent, parentId)
      if (started.agentId) {
        try { await storeFlowAgent($, flowRuntime, started.agentId, child) } catch (error) { flowFailed(io, error) }
      }
      return started
    } finally { release() }
  })

  on('tool.call', async ($, e, next) => {
    try {
      if (e.agentId) {
        const io: TrackingIo = {
          readNatives: () => read($, nativesAtom),
          writeNatives: list => update($, nativesAtom, () => list),
          readSession: () => read($, sessionAtom),
          writeSession: value => update($, sessionAtom, () => value),
          toast: text => $.ui.toast(text),
          now: () => $.clock.now(),
        }
        await ensureTracking(io)
        if (natives!.some(native => native.id === e.agentId)) {
          natives = toolNoted(natives!, e.agentId, describeTool(e.tool, e))
          nativesQueue.push(natives)
          await nativesQueue.flushed()
        }
      }
    } catch { /* Tracking must not prevent any tool, including delegate tools. */ }
    const result = await next(e)
    // The receipt counts the main loop's edits and failed tools; the result goes back as it came.
    if (aboveOn && !e.agentId) { try { noteStripTool(String(e.tool), result) } catch { /* The strip never changes the call. */ } }
    // An edit that went through voids the receipts of a task awaiting them, if the file is one of its own, when nobody that task
    // owns made it: the main session, or an agent no task links (a general-purpose subagent, a developer with no [T]). A
    // work agent of a task is held to the task's files by the ownership hook, and its delivery is a task end of its own.
    if (flowOn() && (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') && !result.deny && !result.isError) {
      const raw = String((e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path) ?? '')
      const io = hostIo($)
      if (raw) {
        try {
          const deps = await flowDeps(io)
          const link = e.agentId ? await flowLinkFor($, flowRuntime, deps, e.agentId) : undefined
          if (!e.agentId || link?.kind !== 'work') {
            const voided = await mainEdit(flowCtx($, deps), { path: raw, resolve: () => flowResolved($, deps.root, raw) })
            if (voided.text) return { ...result, context: [...(result.context ?? []), voided.text] } as typeof result
          }
        } catch (error) { flowFailed(io, error) }
      }
    }
    return result
  })

  // Tracking is registered first and wraps this gate: it sees the settled result once,
  // so held calls are not counted early and denied calls never count as successful edits.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const ask = async (message: string): Promise<GateEvaluation> => {
      if (!gateInteractive) return { deny: 'Pantheon edit gate requires an interactive session to confirm this edit. Edit denied.' }
      const outcome = await holdGate({
        poll: () => $.process.run(['sleep', '0.25']),
        show: value => update($, gateHeld, () => value),
      }, message, next.signal)
      if (outcome === 'proceed') return undefined
      return { deny: `${message}\n${outcome === 'cancel' ? 'The person pressed Cancel.' : 'The wait was interrupted before a decision.'}` }
    }
    return withGateRecovery(async () => {
      if (options.gate !== true || e.agentId) return undefined
      const cwd = await $.session.cwd()
      const workspaceRoot = gateRoot ?? (await workspace({ cwd: async () => cwd, run: (argv, init) => $.process.run(argv, init) })).root
      const stat = (path: string, resolve: boolean) => $.fs.stat(path, { resolve })
      const root = await resolveGatePath(stat, workspaceRoot, cwd)
      const rawHome = await $.env.get('HOME')
      const home = rawHome ? await resolveGatePath(stat, rawHome, cwd) : ''
      const pathField = e.tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
      const path = await resolveGatePath(stat, String(e[pathField] ?? ''), cwd)
      // gateContext receives a resolved absolute target; the forwarded event stays untouched.
      gateUid ??= $.process.run(['id', '-u']).then(result => {
        const uid = result.stdout.trim()
        return result.exitCode === 0 && /^\d+$/.test(uid) ? uid : undefined
      }).catch(() => undefined)
      const context = gateContext({ ...e, [pathField]: path }, { root, home, uid: await gateUid })
      if (context.skip) return undefined
      const verdict = rulesVerdict(context.ctx)
      if (verdict.action === 'allow') return undefined
      const message = gateMessage(verdict, {
        developer: !state.config.disabledAgents.includes('developer'),
        ux: !state.config.disabledAgents.includes('ux'),
      })
      if (verdict.action === 'deny') return { deny: message }
      return ask(message)
    }, () => next(e), () => ask(gateMessage(
      { action: 'ask', reason: 'The edit gate could not evaluate this edit. Ask the person.' },
      { developer: false, ux: false },
    )))
  }).catch((_$, e, next) => next.called || options.gate !== true || e.agentId
    ? next(e) : { deny: 'Pantheon edit gate could not obtain a decision. Edit denied.' })

  // Write ownership (decision 5): a developer or ux agent linked to a task writes only inside the task's files, and so does
  // everything it spawns.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'], agentId: /./ }, async ($, e, next) => {
    if (!flowOn() || !e.agentId) return next(e)
    const io = hostIo($)
    const agentId = e.agentId
    const raw = String((e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path) ?? '')
    // The verdict is settled first and the accounting of it is its own concern: a count or a journal line that fails must not
    // let a write through that the verdict refused.
    let refused: string | undefined
    try {
      const deps = await flowDeps(io)
      const link = raw ? await flowLinkFor($, flowRuntime, deps, agentId) : undefined
      if (link?.kind === 'work' && link.files) {
        const verdict = await flowOwnership($, flowRuntime, deps, link, raw)
        if (!verdict.owned) {
          refused = verdict.reason
          try {
            // A spawned agent's denials count for the work agent whose return the task end is.
            await setFlowDenials($, flowRuntime, link.root ?? agentId, before => before + 1)
            await noteOwnership(flowCtx($, deps), { planId: link.plan, taskId: link.task, path: raw, reason: verdict.reason })
          } catch (error) { flowFailed(io, error) }
        }
      }
    } catch (error) { flowFailed(io, error) }
    if (refused !== undefined && flowMode === 'enforce') return { deny: `[Pantheon flow] ${refused}` }
    return next(e)
  }).catch((_$, e, next) => {
    const deny = next.called ? undefined : flowWriteFallback(flowRuntime.links, flowMode, e.agentId)
    return deny === undefined ? next(e) : { deny }
  })

  // Task end for a foreground agent (decision 6): the Agent tool returned in the main loop; the controller's verdict is
  // appended for the lead to read. A background agent's end arrives as a task-notification prompt instead.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    // A task's delegation in its own worktree would write outside the task's files: the setting is only visible here.
    if (flowOn() && !e.agentId && e.isolation) {
      const taskId = taskIdOf(e.description)
      const io = hostIo($)
      if (taskId) {
        try {
          const refused = await inspectIsolation(flowCtx($, await flowDeps(io)), { taskId, isolation: String(e.isolation) })
          if (refused.deny) return { deny: refused.deny }
        } catch (error) { flowFailed(io, error) }
      }
    }
    const result = await next(e)
    if (!flowOn() || e.agentId || result.deny || result.isError) return result
    const io = hostIo($)
    try {
      const done = result.result
      if (done && typeof done === 'object' && 'status' in done && done.status === 'completed') {
        const output = done.content.map(block => block.text).join('\n')
        const text = await finishFlowAgent($, flowRuntime, await flowDeps(io), done.agentId, output, true)
        if (text) return { ...result, context: [...(result.context ?? []), text] }
      }
    } catch (error) { flowFailed(io, error) }
    return result
  })

  // The main session tries to stop (decisions 6 and 9). Shadow journals; enforce may hold the stop with a reason.
  on('classic.Stop', async ($, e, next) => {
    const below = await next(e)
    if (!flowOn() || e.agent_id || below.block || below.preventContinuation) return below
    const io = hostIo($)
    try {
      const running = normalizeNatives(await read($, nativesAtom)).filter(native => native.rounds[native.rounds.length - 1]?.status === 'running').length
      const out = await stopFlow(flowCtx($, await flowDeps(io)), {
        // A dev server or a monitor is not work the flow waits for; only agents and workflows are.
        stopHookActive: e.stop_hook_active === true, backgroundTasks: pendingAgentTasks(e.background_tasks), runningAgents: running,
      })
      if (out.notice) io.toast(out.notice)
      const context = out.context ? { additionalContext: [...(below.additionalContext ?? []), out.context] } : {}
      if (out.block) return { ...below, ...context, block: out.block }
      if (out.context) return { ...below, ...context }
    } catch (error) { flowFailed(io, error) }
    return below
  })

  // Background agents end as a prompt of origin task-notification: the verdict rides as context. A person's prompt
  // refills the block budget and brings the goal, the current task and the last instruction back (never the system prompt).
  on('prompt.submit', { origin: { kind: 'task-notification' } }, async ($, e, next) => {
    if (!flowOn()) return next(e)
    const io = hostIo($)
    let text: string | undefined
    try {
      const note = parseNotification(e.text)
      const known = note ? await flowAgentOf($, flowRuntime, note.agentId) : undefined
      // Only a linked agent's own envelope counts, and only a completed status is a delivery.
      if (note && known && !known.root) {
        text = await finishFlowAgent($, flowRuntime, await flowDeps(io), note.agentId, note.result, note.status === 'completed')
      }
    } catch (error) { flowFailed(io, error) }
    return text ? next({ ...e, context: [...(e.context ?? []), text] }) : next(e)
  })

  on('prompt.submit', { origin: { kind: /^(?:composer|bridge|sdk)$/ } }, async ($, e, next) => {
    if (!flowOn()) return next(e)
    const io = hostIo($)
    let context: string | undefined
    try { context = (await humanPrompt(flowCtx($, await flowDeps(io)))).context } catch (error) { flowFailed(io, error) }
    return context ? next({ ...e, context: [...(e.context ?? []), context] }) : next(e)
  })

  on('command.run', { command: 'pantheon' }, async ($, e) => {
    const io = hostIo($)
    const parts = e.args.trim().split(/\s+/).filter(Boolean)
    const [sub] = parts
    if (!sub) {
      await $.ui.open({ id: PANE_ID, title: 'Pantheon', focus: true, closeOnEscape: true })
      return { text: 'Pantheon panel opened.' }
    }
    if (sub === 'close') {
      await $.ui.close({ id: PANE_ID })
      return { text: 'Pantheon panel closed.' }
    }
    if (sub === 'config') return { text: configReport(await refreshConfig(io, (await workspace(io)).root)) }
    if (sub === 'flow') {
      const action = parts[1] ?? 'status'
      if (action !== 'status' && action !== 'approve' && action !== 'pause' && action !== 'resume' && action !== 'stop') {
        return { text: 'Use /pantheon flow status, approve [plan path] [hash], pause, resume or stop.' }
      }
      // What can be answered without reading anything is answered first: a flow that is off says so and touches nothing (no
      // repository lookup, no settings), and a run that is not the person's is refused before any work.
      if (action === 'status') {
        if (flowMode === 'off') return { text: 'Pantheon flow: off. Set the plugin option flow to shadow or enforce to use it.' }
      } else {
        // These change what the flow enforces: only the person's own run counts. A scheduled prompt, another session's message,
        // a channel or a plugin is the model's word at one remove, and may not approve a block the model wrote.
        const kind = e.origin?.kind
        if (kind !== 'composer' && kind !== 'bridge' && kind !== 'sdk') {
          return { text: `/pantheon flow ${action} changes what the flow enforces, so only the person can run it: this one came from ${kind ?? 'an origin the engine did not stamp'} (a scheduled prompt, another session, a channel, a plugin). Type it yourself.` }
        }
        if (flowMode === 'off') return { text: 'The flow is off. Set the plugin option flow to shadow or enforce first; while it is off nothing is written.' }
      }
      await refreshConfig(io, (await workspace(io)).root)
      const ctx = flowCtx($, await flowDeps(io))
      if (action === 'status') {
        const text = await flowStatus(ctx)
        return { text: flowLastProblem ? `${text}\nLast problem: ${flowLastProblem}` : text }
      }
      if (action === 'approve') return { text: await approvePlan(ctx, e.args.replace(/^\s*flow\s+approve\s*/, '')) }
      const done = await controlFlow(ctx, action)
      if (action === 'resume') {
        // Links made while the flow was paused, or before the plan's files changed, take the plan's files as they are now.
        try {
          const current = await flowTaskFiles(ctx)
          if (current) {
            const refresh = (links: Record<string, FlowAgent>) => Object.fromEntries(Object.entries(links).map(([id, link]) => {
              const files = link.plan === current.planId && link.kind === 'work' ? current.files[link.task] : undefined
              return [id, files ? { ...link, files } : link]
            }))
            for (const [id, link] of Object.entries(refresh(Object.fromEntries(flowRuntime.links)))) flowRuntime.links.set(id, link)
            await update($, flowAgentsAtom, refresh)
            // An agent found to belong to no task may belong to one of the plan's now.
            flowRuntime.strangers.clear()
          }
        } catch (error) { flowFailed(io, error) }
      }
      return { text: done }
    }
    if (sub === 'doctor') {
      const current = await refreshConfig(io, (await workspace(io)).root)
      let pings: PingResult[] | undefined
      if (current.ok) {
        const results = pingTargets(current.config).map((target): PingResult => {
          const base = { name: target.name, model: target.model }
          if (target.off) return { ...base, state: 'off' }
          if (!target.valid) return { ...base, state: 'fail', detail: 'invalid seat name' }
          return { ...base, state: 'pending' }
        })
        pings = results
        const native = results.filter(p => p.state === 'pending').map(p => p.name)
        // The host refuses prompt.submit while this hook holds the turn, so the prompt goes out after it returns.
        if (native.length > 0) io.after(0, () => {
          try { io.submit(pingPrompt(native)).catch(() => undefined) } catch { /* A failed submit must not break the doctor. */ }
        })
      }
      return {
        text: doctorReport({ config: current, pings }),
      }
    }
    return { text: `Unknown subcommand: ${sub}. Use /pantheon, /pantheon close, /pantheon config, /pantheon doctor or /pantheon flow.` }
  })

  // Last reading of the host clock, kept so a failed read can still draw static durations.
  let lastNow: number | undefined
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const io = hostIo($)
    const current = await refreshConfig(io, (await workspace(io)).root)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const hasClient = 'Client' in els
    const [natives, session, view, read1] = await Promise.all([
      read($, nativesAtom), read($, sessionAtom), read($, viewAtom),
      $.clock.now().then(n => n as number | undefined, () => undefined),
    ])
    const info = normalizeSession(session)
    const tracked = normalizeNatives(natives)
    // A failed read is not hidden: the panel draws no live clocks and says so. Durations stay on one
    // time base: the last reading, else the newest timestamp in the data.
    const isClockLost = read1 === undefined
    if (read1 !== undefined) lastNow = read1
    const stamps = [
      ...tracked.flatMap(n => n.rounds.flatMap(r => [r.startedAt, r.endedAt ?? 0])),
      info.turnStartedAt ?? 0,
      ...(info.turns ?? []).flatMap(t => [t.startedAt, t.endedAt]),
    ]
    const now = read1 ?? lastNow ?? Math.max(...stamps)
    return drawPanel({
      Box, Text, Button,
      ...('Select' in els ? { Select: els.Select } : {}),
      ...('Svg' in els ? { Svg: els.Svg } : {}),
      ...(hasClient ? {
        // The module paths are literals here: the engine reads them off this entry module.
        clock: ({ key, props }) => <els.Client key={key} module="./elapsed.tsx" width={6} props={props} />,
        // The rail links the cards on both surfaces; it moves only while something works.
        ...(isClockLost ? {} : {
          rail: ({ key, width, props }) => <els.Client key={key} module="./rail.tsx" width={width} height={1} props={props} />,
        }),
      } : {}),
    } as never, {
      surface: e.surface,
      placement: e.props.placement,
      columns: e.props.bodyColumns,
      // The pane's usable height, not the terminal's.
      rows: e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24,
      now,
      roster: buildRoster({ natives: tracked, session: info, config: current.config }),
      session: info,
      collapsed: normalizeView(view).collapsed ?? [],
      hasClient,
      clockLost: isClockLost,
      onToggle: group => { viewQueue.push(() => update($, viewAtom, cur => viewToggled(normalizeView(cur), group))) },
      onClose: () => { void $.ui.close({ id: PANE_ID }) },
    }) as never
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const held = options.gate === true ? await read($, gateHeld) : null
    if (held !== null && !e.props.hasSurvey) {
      const { Box, Text, Button } = $.ui.resolve(e)
      const choose = (decision: GateChoice) => {
        if (gateWaiting?.decision === null) gateWaiting.decision = decision
      }
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
          <Text bold color="warning">Pantheon edit gate</Text>
          <Text>{held.message}</Text>
          <Box marginTop={1} gap={2}>
            <Button key="proceed" label="Proceed" hotkey="1" plain onPress={() => choose('proceed')} />
            <Button key="cancel" label="Cancel" hotkey="2" plain autoFocus onPress={() => choose('cancel')} />
            <Text dimColor>Claude is waiting for your answer</Text>
          </Box>
        </Box>
      )
    }
    const below = await next(e)
    const props = e.props ?? (e as never as typeof e.props)
    if (!aboveOn || props?.hasSurvey) return below
    try {
      const now = await $.clock.now()
      return renderStrip({
        surface: e.surface, columns: props?.bodyColumns ?? 80, now, isWorking: props?.isWorking === true,
        agents: await stripAgents($, now), below,
      }, { elements: $.ui.resolve(e) }) as never
    } catch {
      // A failed read draws nothing of ours; what is below stays.
      return below
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const io = hostIo($)
    const composed = await next(e)
    const current = await refreshConfig(io, (await workspace(io)).root)
    return {
      ...composed,
      sections: [
        ...composed.sections.filter(section => section.id !== 'pantheon:lead'),
        { id: 'pantheon:lead', text: buildLeadSection(current.config), scope: 'session' as const },
      ],
    }
  })

  on('prompt.submit', async (_$, e, next) => {
    if (!isCouncilOrigin(e.origin?.kind) || !matchesCouncilTrigger(e.text)) return next(e)
    const block = buildCouncilBlock(state.config)
    if (!block) return next(e)
    return next({ ...e, context: [...(e.context ?? []), block] })
  })

  // Guarda: decide antes do next e, se falhar, esconde o pantheon:* (a API deixa passar por padrão).
  on('agent.offer', async (_$, e, next) => {
    if (!e.agent.startsWith('pantheon:')) return next(e)
    if (!isOffered(state.config, e.agent)) return { isOffered: false }
    return next(e)
  }).catch((_$, e, next) => e.agent.startsWith('pantheon:') ? { isOffered: false } : next(e))
}
