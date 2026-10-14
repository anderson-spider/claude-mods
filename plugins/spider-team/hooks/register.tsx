import type { AgentInfo, BuiltinToolInputs, Hook, McpToolInputs, Register, TurnStepInput, TurnStepResult } from 'claude-code'
import type { ReportInput, Run, Runtime, IdentityCache, Observation, Context } from '../types'
import type { SchemaFor } from './schema'
import { SPECS, roleOf } from './roles'
import { createBreaker, createGate } from './jev'
import { acceptsSpawn, BLOCKED, cacheType, classify, close, complete, IDENTITY_VERSION, observe, policy, prepare } from './dispatch'
import { reviewDiff } from './diff'
import { decision } from './decisions'
import { REPORT_ERROR, safeDestination, saveReport } from './report'

type Dollar = Parameters<Hook<'session.start'>>[0]
type Envelope<T extends string> = { tool: T; tool_use_id: string; agentId?: string }
// Some connected MCP declarations have empty branches; validate the native envelope before narrowing.
function isAgent(e: unknown): e is Envelope<'Agent'> & BuiltinToolInputs['Agent'] {
  if (!e || typeof e !== 'object') return false
  const v = e as Record<string, unknown>
  return v.tool === 'Agent' && typeof v.tool_use_id === 'string' && typeof v.prompt === 'string' && typeof v.description === 'string'
}
function isReport(e: unknown): e is Envelope<'mcp__spider-team__report'> & ReportInput {
  if (!e || typeof e !== 'object') return false
  const v = e as Record<string, unknown>
  return v.tool === 'mcp__spider-team__report' && typeof v.tool_use_id === 'string' && ['status', 'summary', 'verdict', 'body'].every(k => typeof v[k] === 'string')
}
function isDiff(e: unknown): e is Envelope<'mcp__spider-team__diff'> & McpToolInputs['mcp__spider-team__diff'] {
  if (!e || typeof e !== 'object') return false
  const v = e as Record<string, unknown>
  return v.tool === 'mcp__spider-team__diff' && typeof v.tool_use_id === 'string' && typeof v.report === 'string' && (v.file === undefined || typeof v.file === 'string')
}
const identities = { plugin: 'spider-team', key: 'identities' } as const
const runtime = { plugin: 'spider-team', key: 'runtime' } as const
const breaker = createBreaker(() => Date.now())
const gate = createGate()
function io($: Dollar) {
  return {
    state: () => $.state.get(runtime),
    set: (value: Runtime, version: number) => $.state.set(runtime, value, { ifVersion: version }),
    list: () => $.agent.list(),
    identities: () => $.state.get(identities),
    setIdentities: (value: IdentityCache, version: number) => $.state.set(identities, value, { ifVersion: version }),
    stat: (path: string) => $.fs.stat(path, { resolve: true }),
    exists: (path: string) => $.fs.exists(path),
    read: (path: string) => $.fs.read(path),
    write: (path: string, text: string) => $.fs.write(path, text),
    run: (argv: string[]) => $.process.run(argv, { timeoutMs: 10000 }),
    settings: async (source: 'project' | 'local') => ({ env: (await $.settings.read({ source })).env }),
    jev: {
      fetch: async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
        const r = await $.http.fetch(url, init)
        return { status: r.status, text: r.text, headers: r.headers }
      },
      timer: (ms: number, fn: () => void) => { const h = $.clock.after(ms, fn); return () => h.cancel() },
      now: () => Date.now(),
    },
    breaker, gate,
    log: (text: string) => $.ui.log(text, { to: 'debug' }),
    now: () => $.clock.now(),
  }
}
type Io = ReturnType<typeof io>
async function update<T>(port: Io, fn: (state: Runtime) => T): Promise<T> {
  for (let n = 0; n < 8; n++) {
    const read = await port.state()
    const state: Runtime = read.value ? JSON.parse(JSON.stringify(read.value)) : { counter: 0, runs: {} }
    state.namespace ??= crypto.randomUUID()
    if (state.version !== 2) { state.version = 2; state.runs = {}; state.observations = {}; state.references = {}; state.retained = [] }
    state.observations ??= {}; state.references ??= {}; state.retained ??= []
    const value = fn(state)
    if ((await port.set(state, read.version)).isSet) return value
  }
  throw new Error(BLOCKED)
}
// The cache contains only native types and belongs to $.state, never module/global storage.
async function identity(port: Io, id: string): Promise<string> {
  let listed: string | undefined, listing: AgentInfo[] | undefined
  for (let n = 0; n < 8; n++) {
    const read = await port.identities()
    const cache: IdentityCache = read.value?.version === IDENTITY_VERSION ? JSON.parse(JSON.stringify(read.value)) : { version: IDENTITY_VERSION, entries: [] }
    let type: string | undefined, contradiction = false
    // A fresh listing may contradict another cached ID; never silently reclassify it.
    const reconcile = () => {
      if (!Array.isArray(listing)) return
      for (const entry of cache.entries) if (listing.some(row => row?.id === entry.id)) {
        try { if (classify(entry.id, listing) !== entry.type) entry.type = '' } catch { entry.type = '' }
      }
    }
    reconcile()
    try { type = cacheType(cache, id, listed) } catch { contradiction = true }
    if (type === undefined && !contradiction) {
      listing ??= await port.list()
      reconcile()
      try { listed ??= classify(id, listing); type = cacheType(cache, id, listed) } catch { contradiction = true }
    }
    if (!(await port.setIdentities(cache, read.version)).isSet) continue
    if (contradiction || !type) throw new Error(BLOCKED)
    return type
  }
  throw new Error(BLOCKED)
}
let telemetryQueue = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = telemetryQueue.then(fn)
  telemetryQueue = result.then(() => {}, () => {})
  return result
}
async function record(port: Io, run: Run) {
  try {
    const namespace = (await port.state()).value?.namespace
    if (!namespace) throw new Error(BLOCKED)
    const path = `${run.home}/.claude/spider-team/decisions/${namespace}/${run.taskHash}-${run.key}.json`
    await safeDestination(port, path)
    await port.write(path, JSON.stringify(decision(run, await port.now()), null, 2) + '\n')
  } catch { try { port.log('spider-team: decision telemetry unavailable.') } catch { /* Never repeat dispatch. */ } }
}
function trim<T>(entries: Record<string, T>, limit: number) {
  for (const key of Object.keys(entries).slice(0, Math.max(0, Object.keys(entries).length - limit))) delete entries[key]
}
function retain(state: Runtime, kind: 'call' | 'child', id: string) {
  // Calls and child observations share one budget; compact authorization references are separate.
  while (state.retained!.length >= 256) {
    const oldest = state.retained!.shift()!
    delete (oldest.kind === 'call' ? state.runs : state.observations!)[oldest.id]
  }
  state.retained!.push({ kind, id })
}
async function change(port: Io, fn: (state: Runtime) => Run | undefined) {
  return serialized(async () => {
    const { run, closed } = await update(port, s => {
      const run = fn(s)
      return { run, closed: Object.values(s.runs).filter(r => r !== run && r.finished && r.status === 'blocked') }
    })
    if (run) await record(port, run)
    for (const other of closed) await record(port, other)
    // All prior/current writes finish before any eviction. Late callbacks only update existing entries.
    await update(port, s => {
      for (const [key, r] of Object.entries(s.runs)) if (r.finished && (r.status === 'blocked' || r.settled)) delete s.runs[key]
      s.retained = s.retained!.filter(entry => Object.hasOwn(entry.kind === 'call' ? s.runs : s.observations!, entry.id))
      trim(s.references!, 128)
    })
    return run
  })
}
function emptyObservation(): Observation {
  return { status: 'running', finished: false, observed: [], turns: {}, durationMs: null, handbackChars: null, receiptChars: null }
}
function exact(state: Runtime, id: string): Context | undefined {
  const ref = state.references?.[id]
  return ref && !ref.ambiguous ? ref : undefined
}
function project(state: Runtime, id: string): Run | undefined {
  const ref = exact(state, id), observation = state.observations?.[id]
  const run = ref && state.runs[ref.toolId]
  if (!ref || !run || run.key !== ref.key || !observation) return
  const blocked = run.status === 'blocked' || ref.status === 'blocked'
  Object.assign(run, observation)
  if (blocked) close(run)
  ref.status = run.status; ref.finished = run.finished
  return run
}
function bind(state: Runtime, toolId: string, id: string) {
  const run = state.runs[toolId]
  if (!run) return
  const prior = state.references![id]
  const other = Object.values(state.references!).find(r => r.toolId === toolId && r.agentId !== id)
  if (run.linked && !prior && !other) return run // An expired context cannot be revived by a late spawn callback.
  if ((prior && (prior.toolId !== toolId || prior.key !== run.key || prior.ambiguous)) || other) {
    for (const ref of [prior, other]) if (ref) {
      ref.ambiguous = true
      const previous = state.runs[ref.toolId]
      if (previous) { Object.assign(previous, emptyObservation()); previous.agentId = undefined; close(previous) }
    }
    Object.assign(run, emptyObservation()); run.agentId = undefined
    trim(state.references!, prior ? 128 : 127)
    state.references![id] = { toolId, key: run.key, agentId: id, role: run.role, home: run.home, root: run.root, status: 'blocked', finished: true, ambiguous: true }
    return close(run)
  }
  run.agentId = id; run.linked = true
  if (!prior) trim(state.references!, 127)
  state.references![id] ??= { toolId, key: run.key, agentId: id, role: run.role, home: run.home, root: run.root, base: run.base, commonDir: run.commonDir, status: run.status, finished: run.finished }
  return project(state, id) ?? run
}
async function refuse(port: Io, toolId: string) {
  await change(port, s => {
    const r = s.runs[toolId]
    for (const ref of Object.values(s.references!)) if (ref.toolId === toolId) {
      close(ref)
      if (ref.agentId && s.observations![ref.agentId]) close(s.observations![ref.agentId]!)
    }
    return r ? close(r) : undefined
  })
}
function cancellation(port: Io, toolId: string, signal: AbortSignal) {
  let settled = Promise.resolve()
  const abort = () => { settled = refuse(port, toolId).catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return async () => { signal.removeEventListener('abort', abort); await settled }
}
const blockedStep = (e: TurnStepInput): TurnStepResult => ({ turnId: e.turnId, index: e.index, answer: BLOCKED, toolUses: [], stopReason: 'end_turn', usage: null })
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.agent.register({ ...SPECS.analyst, name: 'analyst' })
    await $.agent.register({ ...SPECS.developer, name: 'developer' })
    await $.agent.register({ ...SPECS.reviewer, name: 'reviewer' })
    await $.agent.register({ ...SPECS.architect, name: 'architect' })
    await $.tool.register({ name: 'report', isDeferred: false, description: 'Saves the caller report to a restricted local file and returns the exact final receipt.', inputSchema: {
      type: 'object', properties: {
        status: { type: 'string', enum: ['done', 'blocked', 'partial', 'no-changes'] },
        summary: { type: 'string', description: 'One short line.' },
        verdict: { type: 'string', enum: ['APPROVED', 'CHANGES', 'BLOCKED', 'NONE'] },
        body: { type: 'string', description: 'Full Markdown details, starting with ## sections; at most 64 KiB.' },
        worktreePath: { type: 'string', description: 'Developer only: absolute native checkout path.' },
        worktreeBranch: { type: 'string', description: 'Developer only: current branch.' },
      }, required: ['status', 'summary', 'verdict', 'body'],
    } satisfies SchemaFor<McpToolInputs['mcp__spider-team__report']> })
    await $.tool.register({ name: 'diff', isDeferred: false, description: 'Reviewer only: inspect a completed developer report checkout, one file per page.', inputSchema: {
      type: 'object', properties: { report: { type: 'string', description: 'The developer receipt report-id.' }, file: { type: 'string', description: 'One filename from the returned index; omit for index and untracked list.' } }, required: ['report'],
    } satisfies SchemaFor<McpToolInputs['mcp__spider-team__diff']> })
    return next(e)
  })
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (!isAgent(e)) return { deny: BLOCKED }
    if (!roleOf(e.subagent_type)) return next(e)
    const port = io($)
    const settings = await $.settings.read()
    const version = await $.session.version()
    const prepared = await prepare({ ...port,
      home: await $.env.get('HOME') ?? '', root: await $.session.root(), key: await $.env.get('JEV_API_KEY'), version: version.version,
      baseRef: (settings as unknown as { worktree?: { baseRef?: string } }).worktree?.baseRef,
      overrides: [await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL_FORCE'), await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')],
    }, e)
    if (!prepared || next.signal.aborted) return { deny: BLOCKED }
    const run = await change(port, s => {
      if (s.runs[e.tool_use_id]) throw new Error(BLOCKED)
      retain(s, 'call', e.tool_use_id)
      prepared.run.key = ++s.counter; s.runs[e.tool_use_id] = prepared.run
      return prepared.run
    })
    if (!run) return { deny: BLOCKED }
    const cancelled = cancellation(port, e.tool_use_id, next.signal)
    try {
      if (next.signal.aborted) { await refuse(port, e.tool_use_id); return { deny: BLOCKED } }
      // Exactly one native dispatch. Error cleanup never enters the selection fallback.
      const result = await next({ ...e, prompt: prepared.prompt, model: run.forwarded.model, effort: run.forwarded.effort, ...(run.role === 'developer' ? { isolation: 'worktree' as const } : {}) }).catch(async error => {
        try { await refuse(port, e.tool_use_id) } catch { /* Preserve the original native error. */ }
        throw error
      })
      try {
        await change(port, s => {
          const refForResult = Object.values(s.references!).find(ref => ref.toolId === e.tool_use_id && ref.key === run.key && !ref.ambiguous)
          if (refForResult && (result.deny || result.isError || next.signal.aborted)) {
            close(refForResult)
            const observation = refForResult.agentId && s.observations![refForResult.agentId]
            if (observation) close(observation)
          }
          const native = result.result
          if (refForResult && native && typeof native === 'object' && 'agentId' in native && native.agentId === refForResult.agentId && 'status' in native && native.status === 'completed') {
            const path = 'worktreePath' in native && typeof native.worktreePath === 'string' ? native.worktreePath : undefined
            const branch = 'worktreeBranch' in native && typeof native.worktreeBranch === 'string' ? native.worktreeBranch : undefined
            refForResult.nativePath = path; refForResult.nativeBranch = branch
            if (refForResult.report?.worktreePath && (path !== refForResult.report.worktreePath || branch !== refForResult.report.worktreeBranch)) close(refForResult)
          }
          const r = s.runs[e.tool_use_id]
          if (!r || r.key !== run.key) return
          r.settled = true
          if (result.deny || result.isError || next.signal.aborted) {
            if (r.agentId && exact(s, r.agentId)) close(exact(s, r.agentId)!)
            return close(r)
          }
          const value = result.result
          if (!value || typeof value !== 'object' || !('agentId' in value) || !r.agentId || value.agentId !== r.agentId) { r.finished = true; r.status = 'partial'; return r }
          const ref = exact(s, r.agentId)
          if (!ref) { r.finished = true; r.status = 'partial'; return r }
          if ('status' in value && value.status === 'async_launched') { if (!r.finished) r.status = 'launched' }
          else if ('status' in value && value.status === 'completed' && 'content' in value) {
            ref.nativePath = value.worktreePath; ref.nativeBranch = value.worktreeBranch
            const o = s.observations![r.agentId]
            if (o && !o.finished) complete(o, { answer: value.handbackReport?.text ?? value.content.map(c => c.text).join('\n'), durationMs: value.totalDurationMs, isAborted: false, reason: 'answer', turnId: 'synchronous', agentId: value.agentId, usage: { ...value.usage, model: value.resolvedModel ?? '' } }, ref.report)
            project(s, r.agentId)
            if (!o) { r.finished = true; r.status = 'partial' }
            if (ref.report?.worktreePath && (value.worktreePath !== ref.report.worktreePath || value.worktreeBranch !== ref.report.worktreeBranch)) close(r)
          }
          ref.status = r.status; ref.finished = r.finished
          return r
        })
      } catch { try { port.log('spider-team: native observation unavailable.') } catch { /* Preserve host result. */ } }
      return result
    } finally { await cancelled() }
  }).catch(async ($, e, next) => {
    try { if (isAgent(e)) await refuse(io($), e.tool_use_id) } catch { /* Preserve the native result. */ }
    return next.called || (isAgent(e) && !roleOf(e.subagent_type)) ? next(e) : { deny: BLOCKED }
  })

  on('agent.spawn', async ($, e, next) => {
    const port = io($), cancelled = cancellation(port, e.tool_use_id, next.signal)
    try {
      acceptsSpawn(e)
      if (next.signal.aborted) { await refuse(port, e.tool_use_id); return { deny: BLOCKED } }
      const result = await next(e)
      if (result.deny || !result.agentId || next.signal.aborted) await refuse(port, e.tool_use_id)
      else await change(port, s => bind(s, e.tool_use_id, result.agentId!))
      return result
    } catch (error) {
      try { await refuse(port, e.tool_use_id) } catch { /* Preserve the native rejection. */ }
      throw error
    } finally { await cancelled() }
  }).catch(async ($, e, next) => {
    try { await refuse(io($), e.tool_use_id) } catch { /* No inference authorization depends on telemetry. */ }
    return next.called ? next(e) : { deny: BLOCKED }
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) return yield* next(e)
    const port = io($), type = await identity(port, e.agentId)
    let allowed = true
    try { policy(type, e) } catch { allowed = false }
    if (roleOf(type)) {
      try {
        await change(port, s => {
          if (!s.observations![e.agentId!]) retain(s, 'child', e.agentId!)
          const o = s.observations![e.agentId!] ??= emptyObservation()
          if (allowed) observe(o, e)
          else close(o)
          return project(s, e.agentId!)
        })
      } catch { /* Telemetry loss never changes the identity policy. */ }
    }
    if (allowed) return yield* next(e)
    yield { kind: 'text', index: 0, text: BLOCKED }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return blockedStep(e)
  }).catch(async function* (_$, e, next) {
    if (next.called || e.agentId === undefined) return yield* next(e)
    yield { kind: 'text', index: 0, text: BLOCKED }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return blockedStep(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) return result
    try {
      const port = io($)
      await change(port, s => {
        const o = s.observations![e.agentId!]
        if (!o) return
        const ref = exact(s, e.agentId!)
        complete(o, e, ref?.report)
        if (ref) {
          if (ref.status === 'blocked') close(o)
          ref.status = o.status; ref.finished = o.finished
        }
        return project(s, e.agentId!)
      })
    } catch { /* A late callback cannot recreate an evicted observation. */ }
    return result
  })

  on('tool.call', { tool: 'mcp__spider-team__report' }, async ($, e) => {
    if (!isReport(e) || !e.agentId) return { deny: REPORT_ERROR }
    const port = io($), agentId = e.agentId, session = await $.session.id()
    const role = roleOf(await identity(port, agentId))
    if (!role) return { deny: REPORT_ERROR }
    return serialized(async () => {
      const state = (await port.state()).value
      const ref = state?.version === 2 ? exact(state, agentId) : undefined
      if (!ref) return { deny: REPORT_ERROR }
      // Authorization follows the native author; checkout/base always come from the exact host link.
      const report = await saveReport(port, session, { ...ref, role }, e)
      const saved = await update(port, s => {
        const r = exact(s, agentId)
        if (!r || r.key !== ref.key || r.finished || r.status === 'blocked') throw new Error(REPORT_ERROR)
        r.role = role; r.report = report
        const o = s.observations![agentId]
        if (o) o.receiptChars = report.receipt.length
        return project(s, agentId)
      })
      if (saved) await record(port, saved)
      return { result: report.receipt }
    })
  }).catch(() => ({ deny: REPORT_ERROR }))

  on('tool.call', { tool: 'mcp__spider-team__diff' }, async ($, e) => {
    if (!isDiff(e) || !e.agentId) return { deny: BLOCKED }
    const port = io($)
    if (roleOf(await identity(port, e.agentId)) !== 'reviewer') return { deny: BLOCKED }
    const state = (await port.state()).value
    const caller = state?.version === 2 ? exact(state, e.agentId) : undefined
    if (!caller || caller.finished || caller.status === 'blocked') return { deny: BLOCKED }
    const matches = Object.values(state!.references ?? {}).filter(r => !r.ambiguous && r.report?.id === e.report)
    if (matches.length !== 1) return { deny: BLOCKED }
    const developer = matches[0]!
    if (!developer.agentId || roleOf(await identity(port, developer.agentId)) !== 'developer') return { deny: BLOCKED }
    return { result: await reviewDiff(port, developer, e.file) }
  }).catch(() => ({ deny: BLOCKED }))
}
