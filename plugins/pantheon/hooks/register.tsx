import { atom, read, update } from 'claude-code'
import type { AgentSpec, FsStat, Hook, ProcessRunInit, ProcessRunResult, Register, ToolCallResult } from 'claude-code'

import type { Job, Native, SessionInfo } from '../types'
import { buildArgv, createJsonlReader } from './codex'
import { loadConfig } from './config'
import { decide } from './decisions'
import { gateContext, gateMessage } from './gate'
import { BUILTIN_PROFILES, DEFAULT_CONFIG } from './defaults'
import { createJobs, markLost } from './jobs'
import { buildCouncilBlock, isCouncilOrigin, matchesCouncilTrigger } from './prompts/council'
import { buildOrchestratorSection } from './prompts/orchestrator'
import { rolePrompt } from './prompts/roles'
import { pingPrompt, pingTargets } from './ping'
import type { PingResult, PingTarget } from './ping'
import { PANE_ID, configReport, doctorReport, drawPanel, statusText } from './pane'
import { isOffered, nativeAgentSpecs, resolveCodexCall, usesCodex } from './roles'
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
import type { Clock, ConfigResult, DelegateArgs, PantheonConfig, Spawn } from './types'
import { authorizedRoot, checkCwd } from './workspace'

const gateHeld = atom({ plugin: 'pantheon', key: 'gateHeld' }, null)

export async function withGateRecovery(work: () => Promise<ToolCallResult>, called: () => boolean, replay: () => Promise<ToolCallResult>, ask: () => Promise<ToolCallResult>): Promise<ToolCallResult> {
  try { return await work() } catch {
    if (called()) return replay()
    try { return await ask() } catch {
      return { deny: 'Pantheon edit gate could not obtain a decision. Edit denied.' }
    }
  }
}

/** New files inherit their nearest existing ancestor's resolved location. */
export async function resolveGatePath(stat: (path: string, resolve: boolean) => Promise<FsStat>, raw: string, cwd: string): Promise<string> {
  if (!raw) throw new Error('Missing edit path')
  const isMissing = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false
    if ('code' in error) return error.code === 'ENOENT'
    // Host errors may carry only their message. Never infer absence from arbitrary text.
    return error instanceof Error && /^ENOENT(?=:|$)/.test(error.message)
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
  realPath: (path: string) => Promise<string | undefined>
  toast: (text: string) => void
  status: (text: string | undefined) => void
  registerAgent: (spec: AgentSpec) => Promise<unknown>
  readJobs: () => Promise<Job[]>
  writeJobs: (list: Job[]) => Promise<unknown>
  now: () => Promise<number>
  after: Clock['after']
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

const PING_TIMEOUT_MS = 60_000

/** The `$` a hook receives; it cannot be stored, so every hook builds what it needs from its own. */
type Dollar = Parameters<Hook<'session.start'>>[0]

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

/** True when an agent message in Codex's JSONL output contains `pong <name>`. */
function saidPong(stdout: string, name: string): boolean {
  const reader = createJsonlReader()
  const want = `pong ${name}`.toLowerCase()
  return [...reader.push(stdout), ...reader.end()].some(
    ev => ev.kind === 'message' && ev.text.toLowerCase().includes(want),
  )
}

/** One Codex ping through `io.run`, outside the Jobs list. Never throws: any error becomes a `fail`. */
async function pingCodex(
  io: Pick<Io, 'run' | 'now' | 'after'>,
  config: PantheonConfig,
  target: PingTarget,
  ctx: { cwd: string; skipGitRepoCheck: boolean },
): Promise<PingResult> {
  const base = { name: target.name, engine: target.engine, model: target.model }
  const fail = (detail: string, ms?: number): PingResult => ({ ...base, state: 'fail', detail, ms })
  let timer: { cancel: () => void } | undefined
  try {
    const call = resolveCodexCall(
      config,
      { agent: target.name, prompt: `Reply with exactly: pong ${target.name}. Do not use any tools.` },
      target.name === 'git' ? { ...ctx, gitCommonDir: ctx.cwd } : ctx,
      rolePrompt,
    )
    if ('error' in call) return fail(call.error)
    // A ping never needs writes or the git role's explicit network access.
    call.sandbox = 'read-only'
    delete call.writableRoots
    delete call.network
    const start = await io.now()
    const timeout = new Promise<'timeout'>(resolve => { timer = io.after(PING_TIMEOUT_MS, () => resolve('timeout')) })
    const run = io.run(buildArgv(call), { cwd: call.cwd, stdin: call.prompt, timeoutMs: PING_TIMEOUT_MS })
    // The host kills the child at timeoutMs and rejects; the race below reports it as a timeout first, so swallow the late rejection.
    run.catch(() => {})
    const done = await Promise.race([run, timeout])
    timer?.cancel()
    const ms = (await io.now()) - start
    if (done === 'timeout') return fail('timeout', ms)
    if (done.exitCode === 0 && saidPong(done.stdout, target.name)) return { ...base, state: 'ok', ms }
    const first = (done.stderr || done.stdout).trim().split('\n')[0]
    return fail(`exit ${done.exitCode}${first ? `: ${first.slice(0, 120)}` : ''}`, ms)
  } catch (error) {
    timer?.cancel()
    return fail(error instanceof Error ? error.message : String(error))
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

export const TOOLS = {
  delegate: 'mcp__pantheon__delegate',
  result: 'mcp__pantheon__delegate_result',
  cancel: 'mcp__pantheon__delegate_cancel',
} as const

const jobsAtom = atom({ plugin: 'pantheon', key: 'jobs' } as const, [] as Job[])
const nativesAtom = atom({ plugin: 'pantheon', key: 'natives' } as const, [] as Native[])
const sessionAtom = atom({ plugin: 'pantheon', key: 'session' } as const, DEFAULT_SESSION)
const viewAtom = atom({ plugin: 'pantheon', key: 'view' } as const, DEFAULT_VIEW)

/** The agents the strip folds into its last row: every running job and native. */
async function stripAgents($: Dollar, now: number) {
  const [list, tracked] = await Promise.all([read($, jobsAtom), read($, nativesAtom)])
  return agentsFromState(list, normalizeNatives(tracked), now)
}

const DELEGATE_SCHEMA = {
  type: 'object',
  properties: {
    agent: { type: 'string', description: 'A role or councillor:<seat> currently on Codex.' },
    prompt: { type: 'string', description: 'The complete task for the role.' },
    description: { type: 'string', description: 'A short label shown in /pantheon.' },
    cwd: { type: 'string', description: 'Working directory inside the authorized root; defaults to the session directory.' },
    model: { type: 'string', description: 'Overrides the role model for this call.' },
    effort: { type: 'string', description: 'Overrides the role reasoning effort for this call.' },
    background: { type: 'boolean', description: 'Return { jobId, status: "background" } immediately.' },
    resume: { type: 'string', description: 'jobId of a finished, cancelled or lost job of this session to continue.' },
  },
  required: ['agent', 'prompt'],
} as const

const JOB_SCHEMA = {
  type: 'object',
  properties: { jobId: { type: 'string' } },
  required: ['jobId'],
} as const

const PARTIAL_NOTE = 'Partial changes from the job stay on disk; check git status before continuing.'

function reply(value: unknown): { result: string } {
  return { result: JSON.stringify(value) }
}

function elapsed(job: Job): number | undefined {
  return job.endedAt === undefined ? undefined : job.endedAt - job.startedAt
}

function summarize(job: Job) {
  return {
    jobId: job.id, agent: job.agent, status: job.status, model: job.model, cwd: job.cwd,
    result: job.result, error: job.error, tokens: job.tokens, elapsedMs: elapsed(job),
    lastActivity: job.lastActivity, isResumable: !!job.sessionId && !['running', 'background'].includes(job.status),
  }
}

const DELEGATE_TOOLS = ['mcp__pantheon__delegate', 'mcp__pantheon__delegate_result', 'mcp__pantheon__delegate_cancel']

export const register: Register = (on, options) => {
  // An empty field means /config never chose a profile, so the JSON layers decide.
  const selected = typeof options.profile === 'string' && options.profile.trim() ? options.profile : undefined
  let state: ConfigResult = { ok: true, config: DEFAULT_CONFIG, origins: {}, profiles: Object.keys(BUILTIN_PROFILES) }
  let lastValid: PantheonConfig | undefined
  let lastValidResult: Extract<ConfigResult, { ok: true }> | undefined
  let gateRoot: string | undefined
  let gateUid: Promise<string | undefined> | undefined
  type GateChoice = 'proceed' | 'cancel'
  let gateWaiting: { decision: GateChoice | null } | undefined

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
  let idSeq = 0
  // Último Io vivo: relógio, avisos e estado dos jobs que continuam depois do hook.
  let live: Io | undefined
  const aboveOn = options.abovePrompt !== false && options.abovePrompt !== 'false'
  configureStrip({ paceStart: options.paceStart })
  let minuteTicker: { cancel: () => void } | undefined
  let stripTicker: { cancel: () => void } | undefined
  let jobs: ReturnType<typeof createJobs> | undefined

  let warnedWrite = false
  const jobsQueue = createQueue<Job[]>(list => live!.writeJobs(list), error => {
    if (warnedWrite) return
    warnedWrite = true
    live?.toast(`pantheon: could not save the job state (the panel may be stale): ${error instanceof Error ? error.message : String(error)}`)
  })
  const persisted = jobsQueue.flushed

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

  const clock: Clock = {
    now: () => live!.now(),
    after: (ms, fn) => live!.after(ms, fn),
  }

  // Na primeira chamada do módulo (início ou reload), os jobs ativos do estado viram lost.
  async function ensureJobs(io: Io): Promise<ReturnType<typeof createJobs>> {
    live = io
    if (jobs) return jobs
    const saved = markLost(await io.readJobs())
    if (jobs) return jobs
    jobs = createJobs({
      spawn: () => { throw new Error('pantheon: spawn without an active call') },
      clock,
      codec: { buildArgv, createJsonlReader },
      newId: () => `pj${(++idSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      onChange: list => {
        live?.status(statusText(list))
        jobsQueue.push(list)
      },
      notify: text => { void live?.submit(text).catch(() => {}) },
      initial: saved,
    })
    jobsQueue.push(saved)
    await persisted()
    return jobs
  }

  async function workspace(io: Pick<Io, 'cwd' | 'run'>): Promise<{ sessionCwd: string; root: string; isRepo: boolean }> {
    const sessionCwd = await io.cwd()
    const top = await io.run(['git', 'rev-parse', '--show-toplevel'], { cwd: sessionCwd }).catch(() => undefined)
    const gitTop = top && top.exitCode === 0 ? top.stdout.trim() || undefined : undefined
    const root = authorizedRoot(sessionCwd, gitTop)
    gateRoot = root
    return { sessionCwd, root, isRepo: gitTop !== undefined }
  }

  async function profileDenial(io: Pick<Io, 'cwd' | 'run' | 'home' | 'readText'>, value: unknown): Promise<string | undefined> {
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return undefined
    const { root } = await workspace(io)
    const home = await io.home()
    const current = await loadConfig(io.readText, {
      user: `${home ?? '~'}/.claude/pantheon.json`,
      project: `${root}/.claude/pantheon.json`,
    }, lastValid, typeof value === 'string' ? value : undefined)
    if (!current.ok) return current.error.replace(/^profile: (unknown profile )/, '$1')
    if (typeof value !== 'string' || !current.profiles.includes(value)) {
      return `unknown profile "${value}"; known: ${current.profiles.join(', ')}`
    }
    return undefined
  }

  async function refreshConfig(io: Pick<Io, 'home' | 'readText' | 'toast' | 'registerAgent'>, root: string): Promise<ConfigResult> {
    const home = await io.home()
    state = await loadConfig(io.readText, {
      user: `${home ?? '~'}/.claude/pantheon.json`,
      project: `${root}/.claude/pantheon.json`,
    }, lastValid, selected)
    if (state.ok) {
      lastValid = state.config
      lastValidResult = state
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

  async function delegate(io: Io, args: DelegateArgs, spawn: Spawn, signal: AbortSignal) {
    const ws = await workspace(io)
    const current = await refreshConfig(io, ws.root)
    if (!current.ok) return reply({ error: `Invalid Pantheon config: ${current.error}. Fix the file to delegate.` })

    const all = await ensureJobs(io)
    let cwd = args.cwd ?? ws.sessionCwd
    let resumeSessionId: string | undefined
    if (args.resume) {
      const target = all.resumeTarget(args.resume)
      if ('error' in target) return reply({ error: target.error })
      if (args.cwd !== undefined && args.cwd !== target.cwd) {
        return reply({ error: `resume reuses the recorded cwd (${target.cwd}); it does not take a new cwd.` })
      }
      if (args.agent !== target.agent) {
        return reply({ error: `Job ${args.resume} belongs to ${target.agent}; use agent "${target.agent}" to resume it.` })
      }
      cwd = target.cwd
      resumeSessionId = target.sessionId
    }

    const checked = await checkCwd(io.realPath, ws.root, cwd)
    if (typeof checked !== 'string') return reply({ error: checked.error })

    let gitCommonDir: string | undefined
    if (args.agent === 'git') {
      try {
        const argv = [
          'env', '-u', 'GIT_DIR', '-u', 'GIT_COMMON_DIR', '-u', 'GIT_WORK_TREE',
          '-u', 'GIT_INDEX_FILE', '-u', 'GIT_OBJECT_DIRECTORY', '-u', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
          '-u', 'GIT_CEILING_DIRECTORIES', '-u', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
          'git', 'rev-parse', '--path-format=absolute', '--git-common-dir',
        ]
        const resolveCommonDir = async (cwd: string) => {
          const common = await io.run(argv, { cwd })
          return common.exitCode === 0 && common.stdout.trim()
            ? io.realPath(common.stdout.trim()) : undefined
        }
        const rootCommonDir = await resolveCommonDir(ws.root)
        const cwdCommonDir = await resolveCommonDir(checked)
        if (rootCommonDir && rootCommonDir === cwdCommonDir) gitCommonDir = rootCommonDir
      } catch { /* Resolution failures are reported by resolveCodexCall before spawning. */ }
    }

    const call = resolveCodexCall(current.config, args, {
      cwd: checked, skipGitRepoCheck: !ws.isRepo, resumeSessionId, gitCommonDir,
    }, rolePrompt)
    if ('error' in call) return reply({ error: call.error })

    const { job, outcome } = await all.run(call, {
      foregroundMs: current.config.foregroundMinutes * 60_000,
      background: args.background === true,
      signal,
      description: args.description,
      spawn,
    })
    await persisted()
    if (outcome === 'background') {
      return reply({ jobId: job.id, status: 'background', note: 'Finishes on its own and notifies the session; read it with delegate_result.' })
    }
    return reply({ ...summarize(job), ...(outcome === 'cancelled' ? { note: PARTIAL_NOTE } : {}) })
  }

  // Whether the delegate tools were last described as Codex-backed; undefined until session.start.
  let describedCodex: boolean | undefined
  on('tool.describe', async (_$, e, next) => {
    const result = await next(e)
    return DELEGATE_TOOLS.includes(e.tool) ? { ...result, isDeferred: !usesCodex(state.config) } : result
  })

  on('config.set', { key: 'pantheon.profile' }, async ($, e, next) => {
    const io: Pick<Io, 'cwd' | 'run' | 'home' | 'readText'> = {
      cwd: () => $.session.cwd(),
      run: (argv, init) => $.process.run(argv, init),
      home: () => $.env.get('HOME'),
      readText: async path => (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined,
    }
    const deny = await profileDenial(io, e.value)
    return deny === undefined ? next(e) : { deny }
  })

  on('session.start', async ($, e, next) => {
    gateWaiting = undefined
    if (options.gate === true) await update($, gateHeld, () => null)
    const io: Io = {
      cwd: () => $.session.cwd(),
      run: (argv, init) => $.process.run(argv, init),
      home: () => $.env.get('HOME'),
      readText: async path => (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined,
      realPath: async path => (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath,
      toast: text => $.ui.toast(text),
      status: text => $.ui.status(text),
      registerAgent: spec => $.agent.register(spec),
      readJobs: () => read($, jobsAtom),
      writeJobs: list => update($, jobsAtom, () => list),
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      submit: text => $.prompt.submit({ text }),
    }
    const started = await next(e)
    await ensureJobs(io)
    await refreshConfig(io, (await workspace(io)).root)
    // Without a Codex role or seat the tools are deferred (no fixed context); tool.describe follows
    // later profile switches.
    describedCodex = usesCodex(state.config)
    await $.tool.register({
      name: 'delegate',
      description: 'Run a Pantheon role or council seat on Codex on a task and return its final message, or a jobId when it goes to background.',
      inputSchema: DELEGATE_SCHEMA,
      isDeferred: !describedCodex,
    })
    await $.tool.register({
      name: 'delegate_result',
      description: 'Read the status and, once finished, the result of a delegate job.',
      inputSchema: JOB_SCHEMA,
      isDeferred: !describedCodex,
    })
    await $.tool.register({
      name: 'delegate_cancel',
      description: 'Stop a running delegate job and mark it cancelled; partial changes stay on disk.',
      inputSchema: JOB_SCHEMA,
      isDeferred: !describedCodex,
    })
    await $.command.register({
      name: 'pantheon',
      description: 'Open the Pantheon pane; subcommands: close, cancel <jobId>, config, doctor',
      argumentHint: '[close | cancel <jobId> | config | doctor]',
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
    const ask = async (message: string): Promise<ToolCallResult> => {
      const outcome = await holdGate({
        poll: () => $.process.run(['sleep', '0.25']),
        show: value => update($, gateHeld, () => value),
      }, message, next.signal)
      if (outcome === 'proceed') return next(e)
      return { deny: `${message}\n${outcome === 'cancel' ? 'The person pressed Cancel.' : 'The wait was interrupted before a decision.'}` }
    }
    return withGateRecovery(async () => {
      if (options.gate !== true || e.agentId) return next(e)
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
      if (context.skip) return next(e)
      const key = typeof options.jevApiKey === 'string' && options.jevApiKey.trim()
        ? options.jevApiKey : await $.env.get('OPENROUTER_API_KEY')
      const verdict = await decide((url, init) => $.http.fetch(url, init), key, context.ctx, {
        timer: (ms, fn) => { const timer = $.clock.after(ms, fn); return () => timer.cancel() },
      })
      if (verdict.action === 'allow') return next(e)
      // Codex roles are offered by delegate, not agent.offer; both engines use disabledAgents.
      const message = gateMessage(verdict, context.ctx, {
        executor: !state.config.disabledAgents.includes('executor'),
        designer: !state.config.disabledAgents.includes('designer'),
      })
      if (verdict.action === 'deny') return { deny: message }
      return ask(message)
    }, () => next.called, () => next(e), () => ask(gateMessage(
      { action: 'ask', source: 'rules', reason: 'The edit gate could not evaluate this edit. Ask the person.' },
      { tool: String(e.tool), path: '', ext: '', files: 1 },
      { executor: false, designer: false },
    )))
  }).catch((_$, e, next) => next.called || options.gate !== true || e.agentId
    ? next(e) : { deny: 'Pantheon edit gate could not obtain a decision. Edit denied.' })

  on('tool.call', { tool: TOOLS.delegate }, async ($, e, next) => {
    const io: Io = {
      cwd: () => $.session.cwd(),
      run: (argv, init) => $.process.run(argv, init),
      home: () => $.env.get('HOME'),
      readText: async path => (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined,
      realPath: async path => (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath,
      toast: text => $.ui.toast(text),
      status: text => $.ui.status(text),
      registerAgent: spec => $.agent.register(spec),
      readJobs: () => read($, jobsAtom),
      writeJobs: list => update($, jobsAtom, () => list),
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      submit: text => $.prompt.submit({ text }),
    }
    // O processo do Codex fica preso a esta chamada (Esc no foreground o encerra).
    const spawn: Spawn = req => {
      const stream = $.process.spawn({ argv: req.argv, cwd: req.cwd, input: req.input })
      return {
        [Symbol.asyncIterator]: () => stream,
        result: stream.result,
        return: () => stream.return(undefined as never),
      }
    }
    return delegate(io, e as unknown as DelegateArgs, spawn, next.signal)
  })

  on('tool.call', { tool: TOOLS.result }, async (_$, e) => {
    const { jobId } = e as unknown as { jobId: string }
    const job = jobs?.get(jobId)
    if (!job) return reply({ error: `Unknown job ${jobId} in this session.` })
    return reply(summarize(job))
  })

  on('tool.call', { tool: TOOLS.cancel }, async (_$, e) => {
    const { jobId } = e as unknown as { jobId: string }
    if (!jobs) return reply({ error: `Unknown job ${jobId} in this session.` })
    const done = jobs.cancel(jobId)
    if ('error' in done) return reply({ error: done.error })
    await persisted()
    return reply({ ...summarize(jobs.get(jobId) ?? done), note: PARTIAL_NOTE })
  })

  on('command.run', { command: 'pantheon' }, async ($, e) => {
    const io: Io = {
      cwd: () => $.session.cwd(),
      run: (argv, init) => $.process.run(argv, init),
      home: () => $.env.get('HOME'),
      readText: async path => (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined,
      realPath: async path => (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath,
      toast: text => $.ui.toast(text),
      status: text => $.ui.status(text),
      registerAgent: spec => $.agent.register(spec),
      readJobs: () => read($, jobsAtom),
      writeJobs: list => update($, jobsAtom, () => list),
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      submit: text => $.prompt.submit({ text }),
    }
    const [sub, ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (!sub) {
      await $.ui.open({ id: PANE_ID, title: 'Pantheon', focus: true, closeOnEscape: true })
      return { text: 'Pantheon panel opened.' }
    }
    if (sub === 'close') {
      await $.ui.close({ id: PANE_ID })
      return { text: 'Pantheon panel closed.' }
    }
    if (sub === 'cancel') {
      const jobId = rest[0]
      if (!jobId) return { text: 'Usage: /pantheon cancel <jobId>' }
      const done = jobs ? jobs.cancel(jobId) : { error: `Unknown job ${jobId} in this session.` }
      return { text: 'error' in done ? done.error : `Job ${jobId} cancelled. ${PARTIAL_NOTE}` }
    }
    const ws = await workspace(io)
    const current = await refreshConfig(io, ws.root)
    if (sub === 'config') return { text: configReport(current) }
    if (sub === 'doctor') {
      const version = await io.run(['codex', '--version']).catch(() => undefined)
      const login = version?.exitCode === 0 ? await io.run(['codex', 'login', 'status']).catch(() => undefined) : undefined
      const loginOk = login?.exitCode === 0
      let pings: PingResult[] | undefined
      if (current.ok) {
        const targets = pingTargets(current.config)
        const results = await Promise.all(targets.map(async (target): Promise<PingResult> => {
          const base = { name: target.name, engine: target.engine, model: target.model }
          if (target.off) return { ...base, state: 'off' }
          if (!target.valid) return { ...base, state: 'fail', detail: 'invalid seat name' }
          if (target.engine !== 'codex') return { ...base, state: 'pending' }
          if (!loginOk) return { ...base, state: 'fail', detail: 'codex unavailable' }
          return pingCodex(io, current.config, target, { cwd: ws.root, skipGitRepoCheck: !ws.isRepo })
        }))
        pings = results
        const native = results.filter(p => p.state === 'pending').map(p => p.name)
        // The host refuses prompt.submit while this hook holds the turn, so the prompt goes out after it returns.
        if (native.length > 0) io.after(0, () => {
          try { io.submit(pingPrompt(native)).catch(() => undefined) } catch { /* A failed submit must not break the doctor. */ }
        })
      }
      return {
        text: doctorReport({
          usesCodex: usesCodex(current.config),
          profile: current.config.profile,
          codexVersion: version?.exitCode === 0 ? version.stdout.trim() : undefined,
          loginStatus: login ? (login.stdout || login.stderr).trim().split('\n')[0] : undefined,
          loginOk,
          config: current,
          root: ws.root,
          isRepo: ws.isRepo,
          pings,
        }),
      }
    }
    return { text: `Unknown subcommand: ${sub}. Use /pantheon, /pantheon close, /pantheon cancel <jobId>, /pantheon config or /pantheon doctor.` }
  })

  // Last reading of the host clock, kept so a failed read can still draw static durations.
  let lastNow: number | undefined
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const io: Pick<Io, 'cwd' | 'run' | 'home' | 'readText' | 'toast' | 'registerAgent'> = {
      cwd: () => $.session.cwd(),
      run: (argv, init) => $.process.run(argv, init),
      home: () => $.env.get('HOME'),
      readText: async path => (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined,
      toast: text => $.ui.toast(text),
      registerAgent: spec => $.agent.register(spec),
    }
    const current = await refreshConfig(io, (await workspace(io)).root)
    // Keep the last valid selector names and lock along with the effective config.
    const panelConfig = current.ok ? current : lastValidResult ?? current
    const profileOrigin = panelConfig.ok ? panelConfig.origins.profile : undefined
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const hasClient = 'Client' in els
    const [list, natives, session, view, read1] = await Promise.all([
      read($, jobsAtom), read($, nativesAtom), read($, sessionAtom), read($, viewAtom),
      $.clock.now().then(n => n as number | undefined, () => undefined),
    ])
    const info = normalizeSession(session)
    const tracked = normalizeNatives(natives)
    // A failed read is not hidden: the panel draws no live clocks and says so. Durations stay on one
    // time base: the last reading, else the newest timestamp in the data.
    const isClockLost = read1 === undefined
    if (read1 !== undefined) lastNow = read1
    const stamps = [
      ...list.flatMap(j => [j.startedAt, j.endedAt ?? 0]),
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
      roster: buildRoster({ jobs: list, natives: tracked, session: info, config: panelConfig.config }),
      session: info,
      profiles: panelConfig.profiles,
      activeProfile: panelConfig.config.profile,
      profileLockedBy: profileOrigin === 'user' || profileOrigin === 'project' ? profileOrigin : undefined,
      onProfile: name => {
        void profileDenial(io, name).then(async deny => {
          if (deny !== undefined) {
            $.ui.toast(`pantheon: ${deny}`)
            return
          }
          const result = await $.config.set({ key: 'pantheon.profile', value: name })
          if (result.deny) $.ui.toast(`pantheon: ${result.deny}`)
          else $.ui.invalidate('ui.render')
        }).catch(error => {
          $.ui.toast(`pantheon: could not select profile: ${error instanceof Error ? error.message : String(error)}`)
        })
      },
      collapsed: normalizeView(view).collapsed ?? [],
      hasClient,
      clockLost: isClockLost,
      onToggle: group => { viewQueue.push(() => update($, viewAtom, cur => viewToggled(normalizeView(cur), group))) },
      onClose: () => { void $.ui.close({ id: PANE_ID }) },
      onCancel: jobId => {
        const done = jobs ? jobs.cancel(jobId) : { error: `Unknown job ${jobId} in this session.` }
        if ('error' in done) $.ui.toast(`pantheon: ${done.error}`)
      },
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
    const io: Io = {
      cwd: () => $.session.cwd(),
      run: (argv, init) => $.process.run(argv, init),
      home: () => $.env.get('HOME'),
      readText: async path => (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined,
      realPath: async path => (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath,
      toast: text => $.ui.toast(text),
      status: text => $.ui.status(text),
      registerAgent: spec => $.agent.register(spec),
      readJobs: () => read($, jobsAtom),
      writeJobs: list => update($, jobsAtom, () => list),
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      submit: text => $.prompt.submit({ text }),
    }
    const composed = await next(e)
    const current = await refreshConfig(io, (await workspace(io)).root)
    const codex = usesCodex(current.config)
    if (describedCodex !== undefined && codex !== describedCodex) {
      describedCodex = codex
      $.ui.invalidate('tool.describe')
    }
    return {
      ...composed,
      sections: [
        ...composed.sections.filter(section => section.id !== 'pantheon:orchestrator'),
        { id: 'pantheon:orchestrator', text: buildOrchestratorSection(current.config), scope: 'session' as const },
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
