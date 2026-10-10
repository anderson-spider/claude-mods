import { atom, read, update } from 'claude-code'
import type { AgentSpec, FsStat, Hook, ProcessRunInit, ProcessRunResult, Register, ToolCallResult } from 'claude-code'

import type { Native, SessionInfo } from '../types'
import { loadConfig } from './config'
import { rulesVerdict } from './decisions'
import { gateContext, gateMessage } from './gate'
import { DEFAULT_CONFIG } from './defaults'
import * as jevflow from './jevflow/controller'
import { ROLES } from './jevflow/types'
import { createBreaker, createJev } from './jevflow/jev'
import type { Breaker, JevIo } from './jevflow/jev'
import type { FlowView } from './jevflow/view'
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
/** The Proceed/Cancel box: what it asks and its title (the edit gate's when none is given). */
type GateHeld = { message: string; title?: string }

/** The check commands the person approved, per repository root, in the plugin's store (newest last). */
const CHECK_APPROVALS_KEY = 'flowCheckApprovals'
const CHECK_APPROVALS_MAX = 200
/** How long the flow check box waits for the person before the Stop goes through unjudged. */
const CHECK_ANSWER_MINUTES = 2

function approvalsIn(all: unknown, root: string): string[] {
  const list = all && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, unknown>)[root] : undefined
  return Array.isArray(list) ? list.filter((cmd): cmd is string => typeof cmd === 'string') : []
}

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
  toast: (text: string) => void
  registerAgent: (spec: AgentSpec) => Promise<unknown>
  after: (ms: number, fn: () => void) => { cancel: () => void }
  submit: (text: string) => Promise<unknown>
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
    toast: text => $.ui.toast(text),
    registerAgent: spec => $.agent.register(spec),
    after: (ms, fn) => $.clock.after(ms, fn),
    submit: text => $.prompt.submit({ text }),
  }
}

/** Jev's host access from the hook's `$`: the request goes through the host's network and the timer is the host's clock. */
function jevIo($: Dollar): JevIo {
  return {
    fetch: async (url, init) => {
      const response = await $.http.fetch(url, init)
      return { status: response.status, text: response.text, headers: response.headers }
    },
    timer: (ms, fn) => {
      const handle = $.clock.after(ms, fn)
      return () => handle.cancel()
    },
  }
}

/**
 * The flow controller's host access (times in seconds, as JevFlow's). There is no delete or move on `$.fs`, so a draft
 * is removed and a finished flow archived through `rm` and `mv`.
 */
function flowIo($: Dollar, ask?: jevflow.Io['ask']): jevflow.Io {
  return {
    read: async path => (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined,
    write: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    list: async dir => (await $.fs.list(dir)).map(entry => ({ name: entry.name, kind: entry.kind, mtimeMs: entry.mtimeMs })),
    remove: async path => { await $.process.run(['rm', '-f', '--', path]) },
    move: async (from, to) => {
      const out = await $.process.run(['mv', '--', from, to])
      if (out.exitCode !== 0) throw new Error(`mv failed: ${out.stderr.trim()}`)
    },
    run: async (argv, init) => {
      const out = await $.process.run(argv, { cwd: init.cwd, timeoutMs: init.timeoutMs })
      return { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr }
    },
    now: async () => Number(await $.clock.now()) / 1000,
    ...(ask ? { ask } : {}),
  }
}

/**
 * Jev's key (empty means checks only), where it came from, and the breaker shared while the module lives. The judgeKey
 * option wins; without it `resolveJevKey` falls back to OPENROUTER_API_KEY once.
 */
type JevAccess = { key: string; breaker: Breaker; source?: 'option' | 'env' | 'repo-env'; resolving?: Promise<void> }

const JEV_REPO_ENV = "OPENROUTER_API_KEY comes from this repository's settings and is ignored; set the judgeKey option"
/** JEV_REPO_ENV as the flow card's row, short enough not to be cut in a 68-cell card. */
const JEV_REPO_ENV_ROW = "No Jev key: repo's OPENROUTER_API_KEY ignored; set judgeKey."

/**
 * Falls back to OPENROUTER_API_KEY when the judgeKey option is not set. The process environment also carries the
 * settings' `env` blocks, so a key a repository's project or local settings declare is dropped: the flow's data would
 * go out under that repository's account. A settings read that fails drops it too. Concurrent callers share one read.
 */
function resolveJevKey($: Dollar, jev: JevAccess): Promise<void> {
  jev.resolving ??= readJevEnvKey($, jev)
  return jev.resolving
}

async function readJevEnvKey($: Dollar, jev: JevAccess): Promise<void> {
  if (jev.key) return
  const key = (await $.env.get('OPENROUTER_API_KEY').catch(() => undefined))?.trim()
  if (!key) return
  try {
    for (const source of ['project', 'local'] as const) {
      const env = (await $.settings.read({ source }))?.env as Record<string, unknown> | undefined
      if (env && typeof env === 'object' && Object.hasOwn(env, 'OPENROUTER_API_KEY')) { jev.source = 'repo-env'; return }
    }
  } catch { jev.source = 'repo-env'; return }
  jev.key = key
  jev.source = 'env'
}

/** The flow controller's host access, with Jev when a key is set. */
function flowHost($: Dollar, jev: JevAccess): jevflow.Io {
  const ask = jev.key ? createJev(jevIo($), jev.key, { breaker: jev.breaker }) : undefined
  return {
    ...flowIo($, ask),
    ...(ask ? { jevSource: jev.source === 'env' ? 'OPENROUTER_API_KEY' : 'judgeKey option' } : {}),
    ...(jev.source === 'repo-env' ? { jevOff: JEV_REPO_ENV } : {}),
  }
}

/** What the panel's flow card draws: the flow this session is bound to, none otherwise. */
async function flowViewOf($: Dollar, jev: JevAccess, root: string): Promise<FlowView> {
  try {
    const io = flowHost($, jev)
    const p = await jevflow.boundFlow(io, root, await $.session.id().then(id => String(id), () => undefined))
    if (!p) return { kind: 'none' }
    if (await jevflow.isDraft(io, p)) {
      const draft = await io.read(p.draft).catch(() => undefined)
      let goal = ''
      try { goal = String((JSON.parse(draft ?? '{}') as { goal?: unknown }).goal ?? '') } catch { /* An unreadable draft shows no goal. */ }
      return { kind: 'draft', id: p.id, goal }
    }
    try {
      const loaded = await jevflow.loadFlowAndState(io, p)
      const needsHuman = await io.read(p.needsHuman).catch(() => undefined)
      return { kind: 'flow', id: p.id, archived: p.archived, ...loaded, ...(needsHuman ? { needsHuman: needsHuman.slice(0, 2000) } : {}) }
    } catch (error) {
      return { kind: 'error', id: p.id, error: error instanceof Error ? error.message : String(error) }
    }
  } catch (error) {
    return { kind: 'error', id: '?', error: error instanceof Error ? error.message : String(error) }
  }
}

/** Whether the person approved this exact check command in this repository before. */
async function isApprovedCheck($: Dollar, root: string, cmd: string): Promise<boolean> {
  return approvalsIn(await $.store.get(CHECK_APPROVALS_KEY), root).includes(cmd)
}

/** Remembers an approved check command for this repository, keeping the newest CHECK_APPROVALS_MAX. */
async function rememberCheck($: Dollar, root: string, cmd: string): Promise<void> {
  const all = await $.store.get(CHECK_APPROVALS_KEY)
  const kept: Record<string, unknown> = all && typeof all === 'object' && !Array.isArray(all) ? { ...(all as Record<string, unknown>) } : {}
  kept[root] = [...approvalsIn(all, root).filter(c => c !== cmd), cmd].slice(-CHECK_APPROVALS_MAX)
  await $.store.set(CHECK_APPROVALS_KEY, kept)
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
/** The agents the strip folds into its last row: every running native. */
async function stripAgents($: Dollar, now: number) {
  return agentsFromState(normalizeNatives(await read($, nativesAtom)), now)
}

const FLOW_TOOL_DESCRIPTION = 'The Pantheon flow (JevFlow): tracks a multi-step task against phases with checks, and holds a premature stop. '
  + 'start starts a flow when the person runs /pantheon:goal or asks for one: it lays out a new flow for a task that takes several '
  + 'steps and should be finished and verified (then write the phases to the flow.json it names and call validate); join binds this session to a flow another session runs here; claim marks the phase you '
  + 'take, as your Pantheon role (re-claim when you move); status shows the phases, claims and recent decisions.'

export const register: Register = (on, options) => {
  let state: ConfigResult = { ok: true, config: DEFAULT_CONFIG, origins: {} }
  let lastValid: PantheonConfig | undefined
  let gateRoot: string | undefined
  let gateUid: Promise<string | undefined> | undefined
  type GateChoice = 'proceed' | 'cancel'
  let gateWaiting: { decision: GateChoice | null } | undefined
  let gateInteractive = false

  // Like branch-guard, decisions travel in memory: state reads inside a dispatch are snapshots.
  // With `timeout`, the box gives up once it has been shown that long without an answer.
  async function holdGate(
    io: { poll: () => Promise<unknown>; show: (value: GateHeld | null) => Promise<unknown> },
    held: GateHeld,
    signal: AbortSignal,
    timeout?: { ms: number; now: () => Promise<number> },
  ): Promise<GateChoice | 'aborted' | 'timeout'> {
    const slot = { decision: null as GateChoice | null }
    try {
      while (gateWaiting !== undefined) {
        if (signal.aborted) return 'aborted'
        // A host call does not consume the hook's time budget while the person decides.
        await io.poll()
      }
      if (signal.aborted) return 'aborted'
      gateWaiting = slot
      await io.show(held)
      const deadline = timeout ? (await timeout.now()) + timeout.ms : undefined
      while (slot.decision === null && !signal.aborted) {
        if (deadline !== undefined && (await timeout!.now()) >= deadline) return 'timeout'
        await io.poll()
      }
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

  // The flow (JevFlow): every read-modify-write of its files goes through one queue, and Jev has one breaker while this
  // module lives. Jev's key is the judgeKey option, else OPENROUTER_API_KEY; without one no flow starts and a Stop that
  // needs a judgment is held once.
  let flowChain: Promise<unknown> = Promise.resolve()
  function flowSerial<T>(work: () => Promise<T>): Promise<T> {
    const run = flowChain.then(work, work)
    flowChain = run.catch(() => undefined)
    return run
  }
  const jevBreaker = createBreaker(() => Date.now())
  const jevKey = typeof options.judgeKey === 'string' ? options.judgeKey.trim() : ''
  const jev: JevAccess = { key: jevKey, breaker: jevBreaker, ...(jevKey ? { source: 'option' as const } : {}) }
  const flowRoot = async (io: Io): Promise<string> => gateRoot ?? (await workspace(io)).root
  // Sessions that sent a prompt since this module loaded: the first prompt gets the join hint (JevFlow's first prompt).
  const prompted = new Set<string>()
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
    // A box left by an earlier session is cleared whether or not the edit gate is on; a failed write must not stop the start.
    try { await update($, gateHeld, () => null) } catch { /* The box is only a prompt; the session starts without the clear. */ }
    const io = hostIo($)
    const started = await next(e)
    await refreshConfig(io, (await workspace(io)).root)
    await $.command.register({
      name: 'pantheon',
      description: 'Open the Pantheon pane; subcommands: close, config, doctor, flow',
      argumentHint: '[close | config | doctor | flow]',
    })
    try {
      await $.tool.register({
        name: 'flow',
        description: FLOW_TOOL_DESCRIPTION,
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['start', 'validate', 'join', 'claim', 'status'], description: 'What to do.' },
            goal: { type: 'string', description: "start: the person's request, verbatim." },
            name: { type: 'string', description: 'start: a short kebab-case name of 2 to 5 words saying what the work delivers.' },
            flow: { type: 'string', description: 'join: the id of a flow another session runs in this folder.' },
            phase: { type: 'string', description: 'claim: the id of the phase you take.' },
            as: { type: 'string', enum: [...ROLES], description: 'claim: your Pantheon role.' },
          },
          required: ['action'],
        },
      })
    } catch { /* A host without plugin tools still starts the session. */ }
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
    // A delegated phase: the lead's Agent description starts with `[<phase id>]` and the type is a Pantheon role. The
    // claim is the one the agent's own flow tool call would make; a failure never changes the spawn.
    const agentId = started.agentId
    const claim = agentId ? jevflow.spawnClaim(e.subagentType, e.description) : undefined
    if (agentId && claim) {
      try {
        const root = await flowRoot(hostIo($))
        const sessionId = String(await $.session.id())
        await flowSerial(() => jevflow.claimFlow(flowHost($, jev), root, { sessionId, agentId, agentType: e.subagentType }, claim.phase, claim.role))
        $.ui.invalidate('ui.render')
      } catch { /* The claim is advisory and fails open. */ }
    }
    return started
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
      }, { message }, next.signal)
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

  // The flow (JevFlow hooks.py): SessionStart gives the lead the flow's context (or the join hint), a prompt refills the
  // block budget, the Stop runs the checks, Jev and the policy, and StopFailure keeps the API error. A flow starts only
  // with the /pantheon:goal skill or when the person asks for one, never from a prompt. Each fails open: an error adds
  // nothing and never holds the session.
  on('classic.SessionStart', async ($, e, next) => {
    const below = await next(e)
    try {
      const io = flowHost($, jev)
      const root = await flowRoot(hostIo($))
      const context = await flowSerial(() => jevflow.onSessionStart(io, root, { session_id: e.session_id, source: e.source }))
      $.ui.invalidate('ui.render')
      if (context) return { ...below, additionalContext: [...(below.additionalContext ?? []), context] }
    } catch { /* Fail open. */ }
    return below
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const below = await next(e)
    try {
      const first = !prompted.has(e.session_id)
      prompted.add(e.session_id)
      const io = flowHost($, jev)
      const root = await flowRoot(hostIo($))
      const context = await flowSerial(() => jevflow.onUserPrompt(io, root, { session_id: e.session_id, prompt: e.prompt }, first))
      if (context) return { ...below, additionalContext: [...(below.additionalContext ?? []), context] }
    } catch { /* Fail open. */ }
    return below
  })

  on('classic.Stop', async ($, e, next) => {
    const below = await next(e)
    if (e.agent_id || below.block || below.preventContinuation) return below
    // Background agents still work: the flow does not judge the phase until they finish (a shell or monitor is not waited for).
    if (jevflow.pendingAgentTasks(e.background_tasks) > 0) return below
    try {
      await resolveJevKey($, jev)
      const root = await flowRoot(hostIo($))
      // A check is a shell command the flow runs outside the permission system: it runs only when Claude Code's rules
      // allow it, or the person approves that exact command here (an approval is kept for this repository).
      const io: jevflow.Io = {
        ...flowHost($, jev),
        authorize: async (cmd, phase): Promise<jevflow.CheckAuthorization> => {
          try {
            const verdict = await $.tool.check({ tool: 'Bash', input: { command: cmd } })
            if (verdict.decision === 'allow') return { ok: true }
            if (verdict.decision === 'deny') {
              return { ok: false, reason: `Claude Code's permission rules deny it${verdict.reason ? `: ${verdict.reason}` : ''}` }
            }
            if (await isApprovedCheck($, root, cmd)) return { ok: true }
            if (!gateInteractive) {
              return { ok: false, reason: "it needs permission and there is no one to ask; add an allow rule for it in Claude Code's settings" }
            }
            const outcome = await holdGate({
              poll: () => $.process.run(['sleep', '0.25']),
              show: value => update($, gateHeld, () => value),
            }, {
              message: `Run the check of phase \`${phase}\`?\n  ${cmd}\nWithout an answer in ${CHECK_ANSWER_MINUTES} minutes, this Stop goes through unjudged.`,
              title: 'Pantheon flow check',
            }, next.signal, { ms: CHECK_ANSWER_MINUTES * 60_000, now: async () => Number(await $.clock.now()) })
            if (outcome === 'proceed') {
              // The run was approved either way; a store that cannot keep the approval only asks again next time.
              await rememberCheck($, root, cmd).catch(() => undefined)
              return { ok: true }
            }
            if (outcome === 'timeout') return { ok: false, reason: `no answer within ${CHECK_ANSWER_MINUTES} minutes`, unanswered: true }
            return { ok: false, reason: outcome === 'cancel' ? 'the person cancelled it' : 'no answer from the person' }
          } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) }
          }
        },
      }
      const out = await flowSerial(() => jevflow.onStop(io, root, e))
      $.ui.invalidate('ui.render')
      if (out.message) $.ui.toast(out.message)
      if (out.block) return { ...below, block: out.block }
    } catch { /* Fail open: the stop is allowed. */ }
    return below
  })

  on('classic.StopFailure', async ($, e, next) => {
    const below = await next(e)
    try {
      const io = flowHost($, jev)
      const root = await flowRoot(hostIo($))
      await flowSerial(() => jevflow.onStopFailure(io, root, { session_id: e.session_id, error: String(e.error), error_details: e.error_details }))
    } catch { /* Fail open. */ }
    return below
  })

  // The flow's tool, in place of JevFlow's CLI: start, validate, join, claim (as one of Pantheon's roles) and status.
  on('tool.call', { tool: 'mcp__pantheon__flow' }, async ($, e) => {
    const input: Record<string, unknown> = { ...e }
    const str = (key: string) => typeof input[key] === 'string' ? (input[key] as string).trim() : ''
    await resolveJevKey($, jev).catch(() => undefined)
    const io = flowHost($, jev)
    const root = await flowRoot(hostIo($))
    const sessionId = String(await $.session.id())
    let text: string
    try {
      text = await flowSerial(async () => {
        switch (str('action')) {
          case 'start':
            if (!str('goal')) return 'start needs goal: the person\'s request, verbatim.'
            return jevflow.startFlow(io, root, sessionId, str('goal'), str('name') || undefined)
          case 'validate': return jevflow.validateFlow(io, root, sessionId)
          case 'join': return str('flow') ? jevflow.joinFlow(io, root, sessionId, str('flow')) : 'join needs flow: the flow id.'
          case 'claim':
            if (!str('phase') || !str('as')) return 'claim needs phase (a phase id) and as (one of the Pantheon roles).'
            return jevflow.claimFlow(io, root, { sessionId, ...(e.agentId ? { agentId: e.agentId } : {}) }, str('phase'), str('as'))
          case 'status': return jevflow.statusText(io, root, sessionId)
          default: return 'Unknown action: use start, validate, join, claim or status.'
        }
      })
    } catch (error) {
      text = `The flow could not do that: ${error instanceof Error ? error.message : String(error)}`
    }
    $.ui.invalidate('ui.render')
    return { result: text }
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
      try {
        await resolveJevKey($, jev)
        return { text: await jevflow.statusText(flowHost($, jev), await flowRoot(hostIo($)), String(await $.session.id())) }
      } catch (error) {
        return { text: `The flow status could not be read: ${error instanceof Error ? error.message : String(error)}` }
      }
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
    // A draw failure never blanks the pane: it draws one error line instead.
    try {
      return (await draw()) as never
    } catch (error) {
      const message = `pantheon: panel failed to draw: ${error instanceof Error ? error.message : String(error)}`
      try {
        const { Text } = $.ui.resolve(e)
        return <Text key="pane-error" color="error" wrap="wrap">{message}</Text> as never
      } catch {
        return { type: 'Text', props: { color: 'error' }, children: [message] } as never
      }
    }
    async function draw() {
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
    const columns = e.props.bodyColumns
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    // This session's own flow only (draft, active or just archived); the panel draws nothing for none.
    await resolveJevKey($, jev).catch(() => undefined)
    const flow = await flowViewOf($, jev, await flowRoot(io))
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
      rows: bodyRows,
      now,
      flow,
      jevOn: Boolean(jev.key),
      ...(jev.source === 'repo-env' ? { jevOff: JEV_REPO_ENV_ROW } : {}),
      roster: buildRoster({ natives: tracked, session: info, config: current.config }),
      session: info,
      collapsed: normalizeView(view).collapsed ?? [],
      hasClient,
      clockLost: isClockLost,
      onToggle: group => { viewQueue.push(() => update($, viewAtom, cur => viewToggled(normalizeView(cur), group))) },
      onClose: () => { void $.ui.close({ id: PANE_ID }) },
    })
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const held = await read($, gateHeld)
    if (held !== null && !e.props.hasSurvey) {
      const { Box, Text, Button } = $.ui.resolve(e)
      const choose = (decision: GateChoice) => {
        if (gateWaiting?.decision === null) gateWaiting.decision = decision
      }
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
          <Text bold color="warning">{held.title ?? 'Pantheon edit gate'}</Text>
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
