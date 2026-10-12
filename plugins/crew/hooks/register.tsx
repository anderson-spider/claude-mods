import type { Hook, Register } from 'claude-code'
import type { CrewMode as Mode } from '../types'
import { SPECIALISTS, isGatewayBase, leadSection, nativeCodexSection, nativeCodexSpecs } from './agents'
import type { Agent, Effort } from './agents'
import { createConfirmations, confirmText, observedEffort } from './confirm'
import type { Confirmations } from './confirm'
import { decisionRecord, saveDecision, withRan } from './decisions'
import type { DecisionIo } from './decisions'
import { createEffortBook } from './effort'
import type { BindOutcome, EffortBook, Listed } from './effort'
import { deniedWrite } from './guard'
import { createBreaker, createGate, createJev, failureText } from './jev'
import type { Breaker, Gate, JevIo } from './jev'
import { checkKey, repoDeclares, resolveAccess } from './key'
import type { KeyIo, Off } from './key'
import { CODEX_MODELS, CODEX_PREFIX } from './native'
import { JEV_MODEL } from './questions'
import { defaultsOf, describe, moved, noticeText, route, routable, taggedDescription, twinFor, untagged } from './routing'
import type { Routed, Switch, Target } from './routing'

/**
 * The `$` a hook receives. Every hook builds what it needs from its own; nothing here keeps one past its hook.
 */
type Dollar = Parameters<Hook<'session.start'>>[0]

/** The wall clock. The breaker outlives every hook's `$`, so it reads this same function rather than a `$` call. */
const wallNow = () => Date.now()

/** The running session's crew mode: set from the `mode` option at session start, switched by `/crew-mode`. */
const MODE = { plugin: 'crew', key: 'mode' } as const

const MODE_COMMAND = 'crew-mode'

/** The option as a mode: anything but `codex` is `claude`. */
const modeOption = (value: unknown): Mode => (value === 'codex' ? 'codex' : 'claude')

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

/** The repository's settings and the user's home, which decide whether the key may be used. */
function keyIo($: Dollar): KeyIo {
  return {
    settings: async source => {
      const settings = await $.settings.read({ source })
      return { env: settings?.env, pluginConfigs: settings?.pluginConfigs }
    },
    home: () => $.env.get('HOME'),
  }
}

/** What module life resolves once, with the key: whether routing may run and the home that redaction trusts. */
type KeyCache = { key?: Promise<string | undefined>; home?: string }

/** The home of `/Users/<name>/...` or `/home/<name>/...`: a stand-in for redaction only, never a place to read from. */
function homeFromCwd(cwd: string | undefined): string | undefined {
  return /^(\/(?:Users|home)\/[^/]+)(?:\/|$)/.exec(cwd ?? '')?.[1]
}

/**
 * What redaction turns into `~` and repo-relative paths. The home is the one trusted when the key was resolved; when
 * there is none (the repository declares `HOME`, say) it is taken from the session's directory, so the username and
 * the dashed home still go. The repository's own `HOME` is never used.
 */
async function redactContext($: Dollar, access: KeyCache): Promise<{ home: string; root: string }> {
  const root = await $.session.cwd().catch(() => undefined)
  return { home: access.home ?? homeFromCwd(root) ?? '', root: root ?? '' }
}

const OFF_TEXT: Record<Off, string> = {
  'no-key': 'no key',
  'bad-key': 'the jevKey option is not a valid key',
  unreadable: 'the repository settings cannot be read',
  'repo-key': 'the repository settings declare jevKey (set it in user settings)',
}

/** The key, or undefined when routing may not run. Resolved once; concurrent callers share the read. */
function keyOf($: Dollar, access: KeyCache, option: unknown): Promise<string | undefined> {
  access.key ??= (async () => {
    const resolved = await resolveAccess(keyIo($), option)
    access.home = resolved.home
    if (resolved.off) $.ui.log(`crew jev: routing is off: ${OFF_TEXT[resolved.off]}`, { to: 'debug' })
    return resolved.key
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

async function registerSpecialists($: Dollar) {
  for (const agent of SPECIALISTS) {
    await $.agent.register({ ...agent, tools: [...agent.tools] })
  }
}

/** The fixed `-codex` definitions and the twins this activation registered. */
type Native = {
  specs: readonly Agent<string>[]
  /** The twins this activation registered, in order: empty until `session.start`, and when the gate or the registration refused. */
  registered: Agent<string>[]
}

/** The base URL the session sends its API calls to; a failing read is no URL. */
async function baseUrl($: Dollar): Promise<string | undefined> {
  try {
    return await $.env.get('ANTHROPIC_BASE_URL')
  } catch {
    return undefined
  }
}

/** The `-codex` types the session can reach: all of them behind a gateway base URL, none on Anthropic's API or with none set. */
async function reachableNative($: Dollar, native: Native): Promise<readonly Agent<string>[]> {
  return native.specs.length > 0 && isGatewayBase(await baseUrl($)) ? native.specs : []
}

/** Registers the `-codex` types when a gateway is the base URL; without it a spawn would only fail, so one debug line says why not. */
async function registerNative($: Dollar, native: Native) {
  native.registered.length = 0
  const reachable = await reachableNative($, native)
  if (reachable.length === 0) {
    $.ui.log('crew: Codex twins not registered (ANTHROPIC_BASE_URL is not a gateway URL)', { to: 'debug' })
  }
  // One refused registration leaves the other twins registered; only the registered ones are routed and listed.
  for (const agent of reachable) {
    try {
      await $.agent.register({ ...agent, model: `${CODEX_PREFIX}${agent.model}`, tools: [...agent.tools] })
      native.registered.push(agent)
    } catch {
      $.ui.log(`crew: Codex twin crew:${agent.name} not registered (registration failed)`, { to: 'debug' })
    }
  }
}

/** The agents, then the fixed twins behind a gateway base URL, then the session's mode from the option. No secret is read at start. */
async function startCrew(native: Native, mode: Mode, $: Dollar, e: StartHook[1], next: StartHook[2]) {
  native.registered.length = 0
  await registerSpecialists($)
  // A failed twin registration must not prevent the session from starting.
  try {
    await registerNative($, native)
  } catch {
    $.ui.log('crew: Codex twins not registered (registration failed)', { to: 'debug' })
  }
  // Each session starts in the option's mode; neither a failed write nor a refused command holds the session. A codex
  // mode that the repository's own settings declare would send the user's work to OpenAI on the repository's say.
  const declared = mode === 'codex' && (await repoDeclares(keyIo($), ['mode']).catch(() => true))
  if (declared) $.ui.log('crew: the session starts in claude: the repository settings declare the mode, or cannot be read', { to: 'debug' })
  await setMode($, declared ? 'claude' : mode).catch(() => {
    $.ui.log('crew: the crew mode could not be set', { to: 'debug' })
  })
  await $.command
    .register({ name: MODE_COMMAND, description: 'Crew mode: claude | codex (plain crew:<role> calls on the Codex twins), for this session', argumentHint: '[claude|codex]' })
    .catch(() => {
      $.ui.log(`crew: /${MODE_COMMAND} not registered`, { to: 'debug' })
    })
  return next(e)
}

/** The session's mode, and the status line that shows it while it is `codex`. */
async function setMode($: Dollar, mode: Mode): Promise<void> {
  await $.state.set(MODE, mode)
  await $.ui.status(mode === 'codex' ? 'crew: codex' : undefined)
}

/** The running session's mode; `claude` when the session has none or it cannot be read, so nothing moves by default. */
async function modeOf($: Dollar): Promise<Mode> {
  try {
    const { value } = await $.state.get(MODE)
    return value === 'codex' ? 'codex' : 'claude'
  } catch {
    return 'claude'
  }
}

/** `/crew-mode`: no argument toggles, `claude` or `codex` sets, anything else shows the mode and the usage. Answers in one line. */
async function runModeCommand($: Dollar, native: Native, option: Mode, args: string): Promise<string> {
  const current = await modeOf($)
  const word = args.trim().toLowerCase()
  if (word !== '' && word !== 'claude' && word !== 'codex') {
    return `crew mode: ${current}. Usage: /${MODE_COMMAND} [claude|codex]; no argument toggles.`
  }
  const mode: Mode = word === 'claude' || word === 'codex' ? word : current === 'codex' ? 'claude' : 'codex'
  try {
    await setMode($, mode)
  } catch {
    return `crew mode: ${current}; it could not be switched.`
  }
  const start = `New sessions start in ${option} (the mode option).`
  if (mode === 'claude') return `crew mode: claude for this session. Plain crew:<role> calls run on Claude. ${start}`
  if (native.registered.length === 0) {
    return `crew mode: codex for this session, but no Codex twin is registered, so every call stays on Claude. ${start}`
  }
  const twins = native.registered.map(twin => `crew:${twin.name}`).join(', ')
  return `crew mode: codex for this session. Plain crew:<role> calls run on their twins (${twins}); roles without one stay on Claude. ${start}`
}

/** What the routing hooks share while the module lives. */
type Routing = {
  enabled: boolean
  /** The `jevKey` option: the key, and the switch. */
  jevKey: unknown
  breaker: Breaker
  gate: Gate
  book: EffortBook
  /** Routed subagents whose first step is still to be checked against their tag. */
  confirms: Confirmations
  access: KeyCache
  /** The `-codex` twins that were registered (`Native.registered`): routable for their effort, and the codex mode's targets. */
  twins: readonly Agent<string>[]
  /** The `mode` option: the mode a session starts in. */
  mode: Mode
}

/** Asks Jev about one call. A failure is one debug line; the caller requests medium. */
async function askJev($: Dollar, routing: Routing, key: string, spec: Target, e: SpawnHook[1]): Promise<Routed | undefined> {
  try {
    const ask = createJev(jevIo($), key, { model: JEV_MODEL, breaker: routing.breaker, gate: routing.gate })
    return await route(ask, await redactContext($, routing.access), spec, e)
  } catch (error) {
    $.ui.log(`crew jev: crew:${spec.name} not routed (${failureText(error)})`, { to: 'debug' })
    return undefined
  }
}

/** What the notice and the debug lines say about a call: the target that runs it and, when the codex mode moved it, the switch. */
type Announced = { spec: Target; routed: Routed; jev: boolean; via?: Switch }

/** The notice and debug lines distinguish requested effort from known applied configuration. */
function announce($: Dollar, call: Announced, applied: Effort | null, requestedApply: boolean, outcome: BindOutcome | 'suffix' | undefined, toolUseId: string): void {
  const { spec, routed, jev, via } = call
  const notApplied = (requestedApply || applied !== null) && applied !== routed.decision.effort ? routed.decision.effort : undefined
  if (via) $.ui.log(`crew mode: ${via.requested} -> crew:${spec.name}`, { to: 'debug' })
  if (jev) {
    $.ui.log(`crew jev: ${describe(spec, routed, { effort: applied })}`, { to: 'debug' })
  }
  if (notApplied !== undefined) {
    $.ui.log(`crew jev: crew:${spec.name} effort ${notApplied} not applied (${outcome ?? 'no agent id'}); ${applied === null ? 'its effort is unknown' : `it runs on ${applied}`}`, { to: 'debug' })
  }
  $.ui.notice(toolUseId, noticeText(spec, routed, notApplied, via, jev, applied))
}

// Jev moves effort, never model or type: the lane and the tool allowlist stay the lead's choice. The one rewrite of
// the type is the codex mode's, to the same role's registered twin, and it comes first: everything after it (the Jev
// request, the effort book, the tag, the confirmation) reads the rewritten type.
// Any Jev failure requests medium through the same effort book.
async function routeSpawn(routing: Routing, $: Dollar, e: SpawnHook[1], next: SpawnHook[2]) {
  // The mode is read only with twins registered: without them the codex mode moves nothing.
  const codex = routing.twins.length > 0 && (await modeOf($)) === 'codex'
  if (!routing.enabled && !codex) return next(e)
  const asked = routable(e, routing.twins)
  if (!asked) return next(e)
  // The twin this call moves to, in the codex mode and for a call that may move.
  const twin = codex ? twinFor(e, routing.twins) : undefined
  if (!routing.enabled && !twin) return next(e)
  const key = routing.enabled ? await keyOf($, routing.access, routing.jevKey) : undefined

  // A description that already carries a tag (a call copied from the task list) is sent and tagged without it.
  e = { ...e, description: untagged(e.description, routing.twins.map(twin => twin.model)) }
  const requested = e.subagentType
  const spec: Target = twin ?? asked
  if (twin) e = { ...e, subagentType: `crew:${spec.name}` }
  const via: Switch | undefined = twin ? { requested } : undefined
  // Jev is asked about the target; a twin is sent as its base role, so the answer is the role's either way.
  const jevRouted = key ? await askJev($, routing, key, spec, e) : undefined
  // Models stay fixed. Any Jev failure requests medium; a switch without Jev uses medium too.
  const routed = jevRouted ?? defaultsOf(spec)
  // The gateway routes `cx/<model>-<effort>` to that effort's variant, ahead of the host's output_config.effort, even on the first step.
  const suffix = spec.base !== undefined && routed ? `${CODEX_PREFIX}${spec.model}-${routed.decision.effort}` : undefined
  const change = moved(spec, routed)
  // The task shows what was chosen, so the task list says whether routing runs; the book matches the shown description.
  const description = routed ? taggedDescription(e.description, routed, spec.model) : e.description

  // Failures explicitly request medium even when it equals the role default. Twins use only the suffix.
  const requestedApply = change.effort !== undefined || (routing.enabled && !jevRouted)
  const token = suffix ? undefined : routing.book.add(e.subagentType, description, change.effort ?? spec.effort, e.parentAgentId, requestedApply)
  let result: Awaited<ReturnType<SpawnHook[2]>>
  try {
    result = await next({ ...e, description, ...(suffix ? { model: suffix } : {}) })
  } catch (error) {
    if (token !== undefined) routing.book.drop(token)
    throw error
  }
  let outcome: BindOutcome | 'suffix' | undefined
  if (token !== undefined) {
    if (result.agentId) outcome = routing.book.bind(token, result.agentId)
    else routing.book.drop(token)
  } else if (result.agentId) outcome = 'suffix'
  // Nothing started when the host refused the spawn, so there is nothing to announce.
  if (!result.agentId) return result

  // Keep known configuration separate from the request. A first step without a binding leaves effort unknown.
  const took = outcome === 'suffix' || outcome === 'applied' || outcome === 'matched'
  const applied = suffix ? routed.decision.effort : routing.book.bound(result.agentId)
    ?? (took ? routed.decision.effort : requestedApply ? null : spec.effort)

  // The decision log: started before the notice so the write overlaps it, awaited for about a second before
  // returning (it never rejects), so a failing write cannot change the result and a hung one cannot hold it.
  const record = decisionRecord({
    ts: new Date().toISOString(),
    agent: spec.name,
    requested,
    provider: spec.base !== undefined ? 'codex' : 'claude',
    depth: routed.decision.depth,
    defaultEffort: spec.effort,
    effortPlanned: routed.decision.effort,
    effortApplied: applied,
    bind: outcome,
    jevModel: routed.jevModel,
    durationMs: routed.ms,
    description: e.description,
  })
  const by = jevRouted ? 'jev' : 'crew'
  const saved = saveDecision(decisionIo($), routing.access.home, result.agentId, record, by)
  // The tag is what was chosen; the subagent's next step says what ran (a step before this point is not seen).
  routing.confirms.add(result.agentId, {
    via: by,
    suffix: suffix !== undefined,
    description: e.description,
    planned: { model: spec.model, effort: routed.decision.effort },
    record,
    saved,
  })
  announce($, { spec, routed, jev: jevRouted !== undefined, ...(via ? { via } : {}) }, applied, requestedApply, outcome, e.tool_use_id)
  await settleDecision($, saved)
  return result
}

export const register: Register = (on, options) => {
  // Fixed twins register only at session start behind a gateway base URL, never on reload alone.
  const native: Native = { specs: nativeCodexSpecs(CODEX_MODELS), registered: [] }

  // Shared while the module lives: the rate limit is the account's, and a sick Jev is not asked again for a while.
  const routing: Routing = {
    // A filled `jevKey` is the switch; an empty one reads no settings and sends nothing. A malformed one is logged by `keyOf`.
    enabled: checkKey(options.jevKey).off !== 'no-key',
    jevKey: options.jevKey,
    breaker: createBreaker(wallNow),
    gate: createGate(),
    book: createEffortBook(),
    confirms: createConfirmations(),
    access: {},
    twins: native.registered,
    mode: modeOption(options.mode),
  }

  on('session.start', {}, ($, e, next) => startCrew(native, routing.mode, $, e, next))
  on('command.run', { command: MODE_COMMAND }, async ($, e) => ({ text: await runModeCommand($, native, routing.mode, e.args) }))
    .catch(() => ({ text: `crew: /${MODE_COMMAND} failed; run it again to see the mode.` }))
  // Only a request that offers the Agent tool gets the lead's section: the crew agents' tool lists leave it out.
  // A teammate renders the lead's prompt too, and `bare` asks for the lead's section alone.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes('Agent') || e.traits.includes('teammate') || e.traits.includes('bare')) return composed
    const jev = routing.enabled && (await keyOf($, routing.access, routing.jevKey)) !== undefined
    const lead = { id: 'crew:lead', text: leadSection(jev), scope: 'session' as const }
    // The `-codex` types get a section of their own, under the same rule and only for the twins this session registered.
    // It reads the same in either mode, so switching the mode does not change the prompt.
    if (native.registered.length === 0) return { sections: [...composed.sections, lead] }
    const twins = { id: 'crew:native-codex', text: nativeCodexSection(native.registered), scope: 'session' as const }
    return { sections: [...composed.sections, lead, twins] }
  }).catch((_, e, next) => next(e))
  on('agent.spawn', {}, ($, e, next) => {
    // A `model` on a twin's call wins over its definition and would run it on Claude with no tag or confirmation. The
    // fixed names decide, not the registered set: a later `session.start` that registered none leaves the host's types.
    if (e.model && native.specs.some(twin => e.subagentType === `crew:${twin.name}`)) {
      return { deny: `crew: ${e.subagentType} runs on its own Codex model; call it again without \`model\`` }
    }
    return routeSpawn(routing, $, e, next)
  }).catch((_, e, next) => next(e))
  // Runs on every request of every loop: the main loop and agents that were not routed return at once. A streaming
  // hook is written inline as an async generator: the engine reads no other form.
  on('turn.step', {}, async function* ($, e, next) {
    let effort: Effort | undefined
    if (routing.enabled && e.agentId && e.effort !== undefined) {
      effort = await routing.book.lookup(e.agentId, () => listAgents($)).catch(() => undefined)
    }
    const sent = effort && effort !== e.effort ? { ...e, effort } : e
    const answer = yield* next(sent)
    // Only a step the API answered says what ran; one that failed leaves the check for the next.
    const pending = e.agentId && answer.usage ? routing.confirms.take(e.agentId) : undefined
    if (pending && e.agentId && answer.usage) {
      const ran = { model: answer.usage.model, effort: observedEffort(sent, pending.suffix) }
      $.ui.log(confirmText(pending.description, pending.planned, ran, pending.via, pending.suffix), { to: 'transcript' })
      // After the spawn's own write, so the record with what ran is the one that stays; bounded like the spawn's, so
      // a hung write cannot hold the subagent's step.
      // Without a trusted home the spawn already said the record was not written; nothing more is said here.
      const id = e.agentId
      const home = routing.access.home
      if (home) await settleDecision($, pending.saved.then(() => saveDecision(decisionIo($), home, id, withRan(pending.record, ran))))
    }
    return answer
  })

  // The main loop has no agentId and is never held; a subagent is held by its type's rule in guard.ts.
  on('tool.call', { tool: 'Write' }, guardWrite).catch(holdUnchecked)
  on('tool.call', { tool: 'Edit' }, guardWrite).catch(holdUnchecked)
}
