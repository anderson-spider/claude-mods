import type { Hook, Register } from 'claude-code'
import { SPECIALISTS } from './agents'
import type { Effort } from './agents'
import { decisionRecord, saveDecision } from './decisions'
import type { DecisionIo } from './decisions'
import { createEffortBook } from './effort'
import type { BindOutcome, Listed } from './effort'
import { deniedWrite } from './guard'
import { createBreaker, createGate, createJev } from './jev'
import type { JevIo } from './jev'
import { declaresOption, resolveKey } from './key'
import type { KeyIo } from './key'
import { JEV_MODEL } from './questions'
import { describe, route, routable } from './routing'
import type { Routed } from './routing'

/** The `$` a hook receives; it cannot be stored, so every hook builds what it needs from its own. */
type Dollar = Parameters<Hook<'session.start'>>[0]

/** Jev's host access: the request goes through the host's network and the timer is the host's clock. */
function jevIo($: Dollar): JevIo {
  return {
    // Wrapped, not passed as a value: the engine's validate rejects the latter.
    fetch: async (url, init) => {
      const response = await $.http.fetch(url, init)
      return { status: response.status, text: response.text, headers: response.headers }
    },
    timer: (ms, fn) => {
      const handle = $.clock.after(ms, fn)
      return () => handle.cancel()
    },
    now: () => Date.now(),
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
    cancel = jevIo($).timer(DECISION_WAIT_MS, () => resolve(true))
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

export const register: Register = (on, options) => {
  const enabled = options.jevRouting === true || options.jevRouting === 'true'
  // Shared while the module lives: the rate limit is the account's, and a sick Jev is not asked again for a while.
  const breaker = createBreaker(() => Date.now())
  const gate = createGate()
  const book = createEffortBook()
  const access: Access = {}

  on('session.start', async ($, e, next) => {
    for (const agent of SPECIALISTS) {
      await $.agent.register({ ...agent, tools: [...agent.tools] })
    }
    return next(e)
  })

  // Jev moves model and effort, never the type: the lane and the tool allowlist stay the lead's choice. Anything that
  // goes wrong leaves the call as it came.
  on('agent.spawn', async ($, e, next) => {
    if (!enabled) return next(e)
    const spec = routable(e)
    if (!spec) return next(e)
    const key = await keyOf($, access, options.jevKey)
    if (!key) return next(e)

    let routed: Routed | undefined
    try {
      const ask = createJev(jevIo($), key, { model: JEV_MODEL, breaker, gate })
      routed = await route(ask, await redactContext($, access), spec, e)
    } catch (error) {
      const reason = (error as { reason?: unknown } | null)?.reason
      const status = (error as { status?: unknown } | null)?.status
      $.ui.log(`crew jev: crew:${spec.name} not routed (${typeof reason === 'string' ? reason : 'error'}${typeof status === 'number' ? ` ${status}` : ''})`, { to: 'debug' })
    }

    const model = routed && routed.decision.model !== spec.model ? routed.decision.model : undefined
    const effort: Effort | undefined = routed && routed.decision.effort !== spec.effort ? routed.decision.effort : undefined

    // An entry for every routable call, with the default effort when nothing changes: two calls alike then stay on
    // their defaults rather than trade the effort of the one that Jev moved. Added before the spawn continues, as the
    // subagent can step before this hook sees its id.
    const token = book.add(e.subagentType, e.description, effort ?? spec.effort, e.parentAgentId, effort !== undefined)
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(model ? { ...e, model } : e)
    } catch (error) {
      book.drop(token)
      throw error
    }
    let outcome: BindOutcome | undefined
    if (result.agentId) outcome = book.bind(token, result.agentId)
    else book.drop(token)
    // Nothing started when the host refused the spawn, so there is nothing to announce.
    if (!routed || !result.agentId) return result

    // What was applied, not what was asked: an effort that lost the race to the first step runs on the default.
    const took = outcome === 'applied' || outcome === 'matched'

    // The decision log: started before the notice so the write overlaps it, awaited for about a second before
    // returning (it never rejects), so a failing write cannot change the result and a hung one cannot hold it.
    const saved = saveDecision(decisionIo($), access.home, result.agentId, decisionRecord({
      ts: new Date().toISOString(),
      agent: spec.name,
      tier: routed.decision.tier,
      confidence: routed.decision.tierConfidence,
      depth: routed.decision.depth,
      defaultModel: spec.model,
      model: model ?? spec.model,
      defaultEffort: spec.effort,
      effortPlanned: routed.decision.effort,
      effortApplied: took ? routed.decision.effort : spec.effort,
      bind: outcome,
      jevModel: routed.jevModel,
      durationMs: routed.ms,
      description: e.description,
    }))
    $.ui.log(`crew jev: ${describe(spec, routed, { model, effort: effort !== undefined && took ? effort : undefined })}`, { to: 'debug' })
    if (effort !== undefined && !took) {
      $.ui.log(`crew jev: crew:${spec.name} effort ${effort} not applied (${outcome ?? 'no agent id'}); it runs on ${spec.effort}`, { to: 'debug' })
      $.ui.notice(e.tool_use_id, `crew:${spec.name} -> ${routed.decision.model} · ${spec.effort} (jev; effort ${effort} not applied)`)
    } else {
      $.ui.notice(e.tool_use_id, `crew:${spec.name} -> ${routed.decision.model} · ${routed.decision.effort} (jev)`)
    }
    await settleDecision($, saved)
    return result
  }).catch(($, e, next) => next(e))

  // Runs on every request of every loop: the main loop and agents that were not routed return at once.
  on('turn.step', async function* ($, e, next) {
    let effort: Effort | undefined
    if (enabled && e.agentId && e.effort !== undefined) {
      effort = await book.lookup(e.agentId, () => listAgents($)).catch(() => undefined)
    }
    return yield* next(effort && effort !== e.effort ? { ...e, effort } : e)
  })

  // The main loop has no agentId and is never held; a subagent is held by its type's rule in guard.ts.
  on('tool.call', { tool: 'Write' }, guardWrite).catch(holdUnchecked)
  on('tool.call', { tool: 'Edit' }, guardWrite).catch(holdUnchecked)
}
