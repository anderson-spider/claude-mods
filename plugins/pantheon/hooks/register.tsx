import { atom, read, update } from 'claude-code'
import { COLS, ROWS } from './clawd'
import type { AgentSpec, ProcessRunInit, ProcessRunResult, Register } from 'claude-code'

import type { Job, Native, SessionInfo } from '../types'
import { buildArgv, createJsonlReader } from './codex'
import { loadConfig } from './config'
import { BUILTIN_PROFILES, DEFAULT_CONFIG } from './defaults'
import { createJobs, markLost } from './jobs'
import { buildCouncilBlock, isCouncilOrigin, matchesCouncilTrigger } from './prompts/council'
import { buildOrchestratorSection } from './prompts/orchestrator'
import { rolePrompt } from './prompts/roles'
import { PANE_ID, configReport, doctorReport, drawPanel, statusText } from './pane'
import { isOffered, nativeAgentSpecs, resolveCodexCall, usesCodex } from './roles'
import { buildRoster } from './roster'
import {
  DEFAULT_SESSION, DEFAULT_VIEW, completed, describeTool, markNativesLost,
  normalizeNatives, normalizeSession, normalizeView, sessionCompleted, sessionMeasured, viewTab, viewToggled,
  roundOpened, sessionStarted, sessionStepped, spawned, stepAccounted, toolNoted,
} from './tracking'
import type { Clock, ConfigResult, DelegateArgs, PantheonConfig, Spawn } from './types'
import { authorizedRoot, checkCwd } from './workspace'

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

export const register: Register = (on, options) => {
  // An empty field means /config never chose a profile, so the JSON layers decide.
  const selected = typeof options.profile === 'string' && options.profile.trim() ? options.profile : undefined
  let state: ConfigResult = { ok: true, config: DEFAULT_CONFIG, origins: {}, profiles: Object.keys(BUILTIN_PROFILES) }
  let lastValid: PantheonConfig | undefined
  let lastValidResult: Extract<ConfigResult, { ok: true }> | undefined
  let registeredKey: string | undefined
  let toastedError: string | undefined
  let idSeq = 0
  // Último Io vivo: relógio, avisos e estado dos jobs que continuam depois do hook.
  let live: Io | undefined
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
    return { sessionCwd, root: authorizedRoot(sessionCwd, gitTop), isRepo: gitTop !== undefined }
  }

  async function profileDenial(io: Pick<Io, 'cwd' | 'run' | 'home' | 'readText'>, value: unknown): Promise<string | undefined> {
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
          ...(spec.tools ? { tools: spec.tools } : {}),
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

    const call = resolveCodexCall(current.config, args, {
      cwd: checked, skipGitRepoCheck: !ws.isRepo, resumeSessionId,
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
    await $.tool.register({
      name: 'delegate',
      description: 'Run a Pantheon role or council seat currently on Codex on a task and return its final message, or a jobId when it goes to background.',
      inputSchema: DELEGATE_SCHEMA,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'delegate_result',
      description: 'Read the status and, once finished, the result of a job for a Pantheon role or council seat currently on Codex.',
      inputSchema: JOB_SCHEMA,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'delegate_cancel',
      description: 'Stop a running job for a Pantheon role or council seat currently on Codex and mark it cancelled; partial changes stay on disk.',
      inputSchema: JOB_SCHEMA,
      isDeferred: false,
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
    const result = yield* next(e)
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
    return done
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
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
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
    return next(e)
  })

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
      return {
        text: doctorReport({
          usesCodex: usesCodex(current.config),
          profile: current.config.profile,
          codexVersion: version?.exitCode === 0 ? version.stdout.trim() : undefined,
          loginStatus: login ? (login.stdout || login.stderr).trim().split('\n')[0] : undefined,
          loginOk: login?.exitCode === 0,
          config: current,
          root: ws.root,
          isRepo: ws.isRepo,
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
        // Both terminal placements use the same compact mascot.
        ...(isClockLost ? {} : {
          mascot: ({ key, props }) => <els.Client key={key} module="./mascot.tsx" width={COLS} height={ROWS} props={props} />,
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
      jobs: list,
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
      tab: normalizeView(view).tab,
      collapsed: normalizeView(view).collapsed ?? [],
      hasClient,
      clockLost: isClockLost,
      onTab: tab => { viewQueue.push(() => update($, viewAtom, cur => viewTab(normalizeView(cur), tab))) },
      onToggle: group => { viewQueue.push(() => update($, viewAtom, cur => viewToggled(normalizeView(cur), group))) },
      onClose: () => { void $.ui.close({ id: PANE_ID }) },
      onCancel: jobId => { jobs?.cancel(jobId) },
      onCopy: (text, surface) => { void $.ui.copy({ text, surface }) },
    }) as never
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
