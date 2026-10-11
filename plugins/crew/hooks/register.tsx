import type { Hook, Register } from 'claude-code'
import { SPECIALISTS, leadSection } from './agents'
import type { Effort, Specialist } from './agents'
import { decisionRecord, saveDecision } from './decisions'
import type { DecisionIo } from './decisions'
import { createEffortBook } from './effort'
import type { BindOutcome, EffortBook, Listed } from './effort'
import { deniedWrite } from './guard'
import { createBreaker, createGate, createJev, failureText } from './jev'
import type { Breaker, Gate, JevIo } from './jev'
import { declaresOption, resolveKey } from './key'
import type { KeyIo } from './key'
import { JEV_MODEL } from './questions'
import { describe, moved, noticeText, route, routable, taggedDescription, untagged } from './routing'
import type { Moved, Routed } from './routing'

/** The `$` a hook receives; it cannot be stored, so every hook builds what it needs from its own. */
type Dollar = Parameters<Hook<'session.start'>>[0]

/** The wall clock. The breaker outlives every hook's `$`, so it reads this same function rather than a `$` call. */
const wallNow = () => Date.now()

/** Time as the pure modules take it: the host's timer and the wall clock. */
type Clock = Pick<JevIo, 'timer' | 'now'>

function clockOf($: Dollar): Clock {
  return {
    timer: (ms, fn) => {
      const handle = $.clock.after(ms, fn)
      return () => handle.cancel()
    },
    now: wallNow,
  }
}

/** Jev's host access: the request goes through the host's network, time is the host's clock. */
function jevIo($: Dollar): JevIo {
  return {
    // Wrapped, not passed as a value: the engine's validate rejects the latter.
    fetch: async (url, init) => {
      const response = await $.http.fetch(url, init)
      return { status: response.status, text: response.text, headers: response.headers }
    },
    ...clockOf($),
  }
}

/** The decision log's host access: one file write and the debug log. */
function decisionIo($: Dollar): DecisionIo {
  return {
    write: (path, text) => $.fs.write(path, text),
    log: text => $.ui.log(text, { to: 'debug' }),
  }
}

/** How long a spawn's result waits for the decision write; the write itself is not aborted. */
const DECISION_WAIT_MS = 1_000

/** Waits for the decision write, but no longer than DECISION_WAIT_MS: a hung `$.fs.write` must not hold the spawn. */
async function settleDecision($: Dollar, saved: Promise<void>): Promise<void> {
  let cancel: () => void = () => {}
  const slow = new Promise<true>(resolve => {
    cancel = clockOf($).timer(DECISION_WAIT_MS, () => resolve(true))
  })
  const timedOut = await Promise.race([saved.then(() => false as const), slow])
  cancel()
  if (timedOut) $.ui.log('crew jev: decision write slow', { to: 'debug' })
}

/** Where the key may come from; the names are literal so the engine sees which variables are read. */
function keyIo($: Dollar): KeyIo {
  return {
    env: async name => {
      if (name === 'TYPESAFE_API_KEY') return $.env.get('TYPESAFE_API_KEY')
      if (name === 'JEV_API_KEY') return $.env.get('JEV_API_KEY')
      return undefined
    },
    settingsEnv: async source => (await $.settings.read({ source }))?.env as Record<string, unknown> | undefined,
    read: async path => String(await $.fs.read(path)),
    home: () => $.env.get('HOME'),
  }
}

/** What the repository's own settings (project or local) say about this plugin's options. */
type RepoOptions = { jevRouting: boolean; jevKey: boolean; unreadable: boolean }

/** A declaration there is ignored: it is the repository's choice, not the user's. Unreadable settings turn routing off. */
async function repoOptions($: Dollar): Promise<RepoOptions> {
  const found: RepoOptions = { jevRouting: false, jevKey: false, unreadable: false }
  try {
    for (const source of ['project', 'local'] as const) {
      const configs = (await $.settings.read({ source }))?.pluginConfigs
      if (declaresOption(configs, 'crew', 'jevRouting')) found.jevRouting = true
      if (declaresOption(configs, 'crew', 'jevKey')) found.jevKey = true
    }
  } catch {
    found.unreadable = true
  }
  return found
}

/** What module life resolves once, with the key: whether routing may run and the home that redaction trusts. */
type Access = { key?: Promise<string | undefined>; home?: string }

/** The home of `/Users/<name>/...` or `/home/<name>/...`: a stand-in for redaction only, never a place to read from. */
function homeFromCwd(cwd: string | undefined): string | undefined {
  return /^(\/(?:Users|home)\/[^/]+)(?:\/|$)/.exec(cwd ?? '')?.[1]
}

/**
 * What redaction turns into `~` and repo-relative paths. The home is the one trusted when the key was resolved; when
 * there is none (the repository declares `HOME`, say) it is taken from the session's directory, so the username and
 * the dashed home still go. The repository's own `HOME` is never used.
 */
async function redactContext($: Dollar, access: Access): Promise<{ home: string; root: string }> {
  const root = await $.session.cwd().catch(() => undefined)
  return { home: access.home ?? homeFromCwd(root) ?? '', root: root ?? '' }
}

/** The key, or undefined when routing may not run. Resolved once; concurrent callers share the read. */
function keyOf($: Dollar, access: Access, option: unknown): Promise<string | undefined> {
  access.key ??= (async () => {
    const repo = await repoOptions($)
    const off = repo.unreadable
      ? 'the repository settings cannot be read'
      : repo.jevRouting ? 'the repository settings declare jevRouting (set it in user settings)' : undefined
    if (off) {
      $.ui.log(`crew jev: routing is off: ${off}`, { to: 'debug' })
      return undefined
    }
    const { key, home } = await resolveKey(keyIo($), repo.jevKey ? undefined : option)
    access.home = home
    if (!key) $.ui.log(`crew jev: routing is off: no key${repo.jevKey ? ' (a jevKey declared by the repository is ignored)' : ''}`, { to: 'debug' })
    return key
  })().catch(() => undefined)
  return access.key
}

async function listAgents($: Dollar): Promise<Listed[]> {
  return (await $.agent.list()).map(a => ({ id: a.id, type: a.type, description: a.description, parentId: a.parentId }))
}

/** Holds a subagent's write that its type's rule refuses; the main loop (no `agentId`) always passes. */
async function guardWrite<E extends { agentId?: string; file_path?: unknown }, R>($: Dollar, e: E, next: (e: E) => Promise<R>) {
  if (!e.agentId) return next(e)

  const agents = await $.agent.list()
  const type = agents.find(agent => agent.id === e.agentId)?.type
  const deny = type === undefined ? undefined : deniedWrite(type, String(e.file_path ?? ''))

  return deny === undefined ? next(e) : { deny }
}

/** A subagent whose write could not be checked is held; the main loop is never blocked by this guard. */
function holdUnchecked<E extends { agentId?: string }, R>(_$: Dollar, e: E, next: ((e: E) => Promise<R>) & { called: boolean }) {
  if (next.called || !e.agentId) return next(e)
  return { deny: 'crew could not check this write, so it was not made' }
}

type StartHook = Parameters<Hook<'session.start'>>
type SpawnHook = Parameters<Hook<'agent.spawn'>>

async function registerSpecialists($: Dollar, e: StartHook[1], next: StartHook[2]) {
  for (const agent of SPECIALISTS) {
    await $.agent.register({ ...agent, tools: [...agent.tools] })
  }
  return next(e)
}

/** What the routing hooks share while the module lives. */
type Routing = {
  enabled: boolean
  /** The `jevKey` option: the last fallback for the key. */
  jevKey: unknown
  breaker: Breaker
  gate: Gate
  book: EffortBook
  access: Access
}

/** Asks Jev about one call. A failure is one debug line and the call goes on as it came (undefined). */
async function askJev($: Dollar, routing: Routing, key: string, spec: Specialist, e: SpawnHook[1]): Promise<Routed | undefined> {
  try {
    const ask = createJev(jevIo($), key, { model: JEV_MODEL, breaker: routing.breaker, gate: routing.gate })
    return await route(ask, await redactContext($, routing.access), spec, e)
  } catch (error) {
    $.ui.log(`crew jev: crew:${spec.name} not routed (${failureText(error)})`, { to: 'debug' })
    return undefined
  }
}

/** The debug lines and the one notice of a decision; `took` is whether the effort that was moved runs on the subagent. */
function announce($: Dollar, spec: Specialist, routed: Routed, change: Moved, took: boolean, outcome: BindOutcome | undefined, toolUseId: string): void {
  const notApplied = change.effort !== undefined && !took ? change.effort : undefined
  $.ui.log(`crew jev: ${describe(spec, routed, { model: change.model, effort: change.effort !== undefined && took ? change.effort : undefined })}`, { to: 'debug' })
  if (notApplied !== undefined) {
    $.ui.log(`crew jev: crew:${spec.name} effort ${notApplied} not applied (${outcome ?? 'no agent id'}); it runs on ${spec.effort}`, { to: 'debug' })
  }
  $.ui.notice(toolUseId, noticeText(spec, routed, notApplied))
}

// Jev moves model and effort, never the type: the lane and the tool allowlist stay the lead's choice. Anything that
// goes wrong leaves the call as it came.
async function routeSpawn(routing: Routing, $: Dollar, e: SpawnHook[1], next: SpawnHook[2]) {
  if (!routing.enabled) return next(e)
  const spec = routable(e)
  if (!spec) return next(e)
  const key = await keyOf($, routing.access, routing.jevKey)
  if (!key) return next(e)

  // A description that already carries a tag (a call copied from the task list) is sent and tagged without it.
  e = { ...e, description: untagged(e.description) }
  const routed = await askJev($, routing, key, spec, e)
  const change = moved(spec, routed)
  // The task shows what Jev chose, so the task list says whether routing runs; the book matches the shown description.
  const description = routed ? taggedDescription(e.description, routed) : e.description

  // An entry for every routable call, with the default effort when nothing changes: two calls alike then stay on
  // their defaults rather than trade the effort of the one that Jev moved. Added before the spawn continues, as the
  // subagent can step before this hook sees its id.
  const token = routing.book.add(e.subagentType, description, change.effort ?? spec.effort, e.parentAgentId, change.effort !== undefined)
  let result: Awaited<ReturnType<SpawnHook[2]>>
  try {
    result = await next({ ...e, description, ...(change.model ? { model: change.model } : {}) })
  } catch (error) {
    routing.book.drop(token)
    throw error
  }
  let outcome: BindOutcome | undefined
  if (result.agentId) outcome = routing.book.bind(token, result.agentId)
  else routing.book.drop(token)
  // Nothing started when the host refused the spawn, so there is nothing to announce.
  if (!routed || !result.agentId) return result

  // What was applied, not what was asked: an effort that lost the race to the first step runs on the default.
  const took = outcome === 'applied' || outcome === 'matched'

  // The decision log: started before the notice so the write overlaps it, awaited for about a second before
  // returning (it never rejects), so a failing write cannot change the result and a hung one cannot hold it.
  const saved = saveDecision(decisionIo($), routing.access.home, result.agentId, decisionRecord({
    ts: new Date().toISOString(),
    agent: spec.name,
    tier: routed.decision.tier,
    confidence: routed.decision.tierConfidence,
    depth: routed.decision.depth,
    defaultModel: spec.model,
    model: change.model ?? spec.model,
    defaultEffort: spec.effort,
    effortPlanned: routed.decision.effort,
    effortApplied: took ? routed.decision.effort : spec.effort,
    bind: outcome,
    jevModel: routed.jevModel,
    durationMs: routed.ms,
    description: e.description,
  }))
  announce($, spec, routed, change, took, outcome, e.tool_use_id)
  await settleDecision($, saved)
  return result
}

export const register: Register = (on, options) => {
  // Shared while the module lives: the rate limit is the account's, and a sick Jev is not asked again for a while.
  const routing: Routing = {
    enabled: options.jevRouting === true || options.jevRouting === 'true',
    jevKey: options.jevKey,
    breaker: createBreaker(wallNow),
    gate: createGate(),
    book: createEffortBook(),
    access: {},
  }

  on('session.start', registerSpecialists)
  // Only a request that offers the Agent tool gets the lead's section: the crew agents' tool lists leave it out.
  // A teammate renders the lead's prompt too, and `bare` asks for the engine's one section alone.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes('Agent') || e.traits.includes('teammate') || e.traits.includes('bare')) return composed
    const jev = routing.enabled && (await keyOf($, routing.access, routing.jevKey)) !== undefined
    return { sections: [...composed.sections, { id: 'crew:lead', text: leadSection(jev), scope: 'session' as const }] }
  }).catch((_, e, next) => next(e))
  on('agent.spawn', ($, e, next) => routeSpawn(routing, $, e, next)).catch((_, e, next) => next(e))
  // Runs on every request of every loop: the main loop and agents that were not routed return at once. A streaming
  // hook is written inline as an async generator: the engine reads no other form.
  on('turn.step', async function* ($, e, next) {
    let effort: Effort | undefined
    if (routing.enabled && e.agentId && e.effort !== undefined) {
      effort = await routing.book.lookup(e.agentId, () => listAgents($)).catch(() => undefined)
    }
    return yield* next(effort && effort !== e.effort ? { ...e, effort } : e)
  })

  // The main loop has no agentId and is never held; a subagent is held by its type's rule in guard.ts.
  on('tool.call', { tool: 'Write' }, guardWrite).catch(holdUnchecked)
  on('tool.call', { tool: 'Edit' }, guardWrite).catch(holdUnchecked)
}
