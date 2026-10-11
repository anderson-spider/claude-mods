import { atom, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'
import { CODEX_BASE_EFFORT, SPECIALISTS, codexSection, leadSection, offersCodex } from './agents'
import type { Effort, Specialist } from './agents'
import { createConfirmations, confirmText } from './confirm'
import type { Confirmations } from './confirm'
import { decisionRecord, saveDecision, withRan } from './decisions'
import type { DecisionIo } from './decisions'
import { createEffortBook } from './effort'
import type { BindOutcome, EffortBook, Listed } from './effort'
import { createCodexEngine } from './codex/engine'
import type { Answer, CodexEngine, CodexHost, CodexInput, SizeEffort } from './codex/engine'
import { parseCodexModels } from './codex/models'
import { CODEX_LANES } from './codex/roles'
import type { JobSummary } from './codex/worker'
import { registerFlightdeck } from './flightdeck/register'
import { deniedWrite } from './guard'
import { createBreaker, createGate, createJev, failureText } from './jev'
import type { Breaker, Gate, JevIo } from './jev'
import { checkKey, resolveAccess } from './key'
import type { KeyIo, Off } from './key'
import { JEV_MODEL } from './questions'
import { describe, moved, noticeText, route, routable, sizeCodexJob, taggedDescription, untagged } from './routing'
import type { CodexSizing, Moved, Routed } from './routing'

/**
 * The `$` a hook receives. Every hook builds what it needs from its own, and nothing here keeps one past its hook, with
 * one exception: the Codex engine keeps the newest `codexHost($)` a crew hook handed it, because a Codex job outlives
 * the hook that started it (its poller, its card writes and its end notice run later). The typings show `$` used
 * after its hook only by example (a `process.spawn` loop), so the engine treats a failing host as gone: a poll waits
 * for the next hook's host, and a card or notice is retried on the main loop's next step.
 */
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

// --- Codex engine (on only with the `codex` option) ---

/** The Codex jobs of the session, for any reader; the job files under `.crew/codex/` are what a reload reads back. */
const codexJobs = atom({ plugin: 'crew', key: 'codexJobs' } as const, [] as JobSummary[])

const CODEX_ROLES = Object.keys(CODEX_LANES)

/** The engine's host access, built from one hook's `$`; the engine keeps the newest for the jobs that outlive a hook. */
function codexHost($: Dollar): CodexHost {
  return {
    run: async (argv, init) => {
      const out = await $.process.run(argv, init)
      return { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr }
    },
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    list: async path => (await $.fs.list(path)).map(entry => entry.name),
    realPath: async path => (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath,
    cwd: () => $.session.cwd(),
    sessionId: () => $.session.id(),
    // A host process, not a clock wait: a clock wait spends the hook's budget, and the call waits up to 20 s.
    sleep: async ms => { await $.process.run(['sleep', String(ms / 1000)], { timeoutMs: ms + 10_000 }) },
    log: text => $.ui.log(text, { to: 'debug' }),
    note: text => $.ui.log(text, { to: 'transcript' }),
    // The lead reads it as a turn of its own once the session is idle; the text is only an id, a role and a status.
    submit: text => $.prompt.submit({ text }),
    // The dashboard's `agents` value by its literal ref: the validate scan does not follow the atom across an import.
    writeCards: change => update($, { plugin: 'crew', key: 'agents' } as const, list => change(list ?? [])),
    writeJobs: jobs => update($, codexJobs, () => jobs),
  }
}

/** A custom tool's result is a string; `isError` is set only when true (the host rejects `false`). */
function codexReply(answer: Answer): { result: string } | { result: string; isError: true } {
  return answer.isError ? { result: answer.text, isError: true as const } : { result: answer.text }
}

const LEAD_ONLY = 'Codex jobs are started, read and stopped by the main session (the lead) only, not by a subagent.'

async function registerCodexTools($: Dollar) {
  await $.tool.register({
    name: 'codex',
    description:
      'Runs a crew role on OpenAI Codex (the local Codex CLI) instead of a Claude subagent: for a second opinion or extra parallel capacity. ' +
      'The prompt and what the job reads are sent to OpenAI. Each role runs in a Codex sandbox: read-only for code-reader, research and architect; ' +
      'workspace-write in this repository for developer, designer and tester (refused outside it). ' +
      "Approvals are on-request and Codex's own auto-review decides any request to leave the sandbox, so the sandbox is not a hard limit; " +
      "the person's ~/.codex config applies too (model, MCP servers), with the write lanes' writable roots and network pinned off. " +
      'architect and research run read-only and their final message is saved under .crew/. ' +
      'Each job runs on medium reasoning effort; when Jev routing is on (a jevKey), Jev may raise it to high, and then the redacted prompt is sent to Jev (api.typesafe.ai) too, adding about 3 s before the job starts. ' +
      'Waits up to 20 s and returns as soon as the job ends; past that the job goes on in the background and you get a message when it ends: ' +
      'collect it with codex_result, stop it with codex_cancel.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: CODEX_ROLES, description: 'The crew role to run.' },
        prompt: { type: 'string', description: 'The task, briefed as for the crew agent.' },
        description: { type: 'string', description: 'A few words naming the job (shown on its card and in its output file name).' },
        cwd: { type: 'string', description: "Directory to run in; the session's by default. Write roles must stay inside the repository." },
        background: { type: 'boolean', description: 'Return at once with the job id instead of waiting.' },
        resume: { type: 'string', description: 'The id of an ended job to continue in its Codex session, as the same agent.' },
      },
      required: ['agent', 'prompt', 'description'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'codex_result',
    description: "Reads a Codex job started with codex: its status, Codex's final answer, token usage, files changed and output file.",
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
    isDeferred: true,
  })
  await $.tool.register({
    name: 'codex_cancel',
    description: 'Stops a running Codex job (SIGINT): it answers cancelling, and the job ends cancelled once Codex stops; what it already changed stays changed.',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
    isDeferred: true,
  })
}

/** The crew's session start: the agents, then (with the option) the Codex tools and the jobs read back from disk. */
async function startCrew(engine: CodexEngine | undefined, modelErrors: readonly string[], $: Dollar, e: StartHook[1], next: StartHook[2]) {
  await registerSpecialists($)
  if (!engine) return next(e)
  // Its own try: a failure here must not keep the agents or the dashboard from starting.
  try {
    await registerCodexTools($)
  } catch (error) {
    $.ui.log(`crew codex: tools not registered (${error instanceof Error ? error.message : String(error)})`, { to: 'debug' })
  }
  if (modelErrors.length) $.ui.log(`crew codex: codexModels ignored in part: ${modelErrors.join('; ')}`, { to: 'debug' })
  const started = await next(e)
  try {
    engine.useHost(codexHost($))
    await engine.load()
  } catch (error) {
    $.ui.log(`crew codex: jobs not read back (${error instanceof Error ? error.message : String(error)})`, { to: 'debug' })
  }
  return started
}

type CodexCall = CodexInput & { agentId?: string; jobId?: unknown }

/** A Codex job's effort. Never rejects: no routing, no valid key or any failure of Jev gives the base. */
function sizeCodexEffort($: Dollar, routing: Routing): SizeEffort {
  const deps: CodexSizing = {
    enabled: routing.enabled,
    key: () => keyOf($, routing.access, routing.jevKey),
    context: () => redactContext($, routing.access),
    ask: key => createJev(jevIo($), key, { model: JEV_MODEL, breaker: routing.breaker, gate: routing.gate }),
    log: line => $.ui.log(line, { to: 'debug' }),
  }
  return (role, description, prompt, signal, jobId) => sizeCodexJob(deps, role, description, prompt, signal, jobId)
}

async function codexStart(engine: CodexEngine, $: Dollar, routing: Routing, e: CodexCall, signal: AbortSignal) {
  if (e.agentId) return codexReply({ text: LEAD_ONLY, isError: true })
  const host = codexHost($)
  engine.useHost(host)
  return codexReply(await engine.start(e, host, signal, sizeCodexEffort($, routing)))
}

async function codexResult(engine: CodexEngine, $: Dollar, e: CodexCall) {
  if (e.agentId) return codexReply({ text: LEAD_ONLY, isError: true })
  engine.useHost(codexHost($))
  return codexReply(await engine.result(e.jobId))
}

async function codexCancel(engine: CodexEngine, $: Dollar, e: CodexCall) {
  if (e.agentId) return codexReply({ text: LEAD_ONLY, isError: true })
  engine.useHost(codexHost($))
  return codexReply(await engine.cancel(e.jobId))
}

/**
 * The main loop's step: a newer host for the jobs, the jobs read back if no session.start did it since the module
 * loaded (once; later steps find them loaded), and the card writes that failed after their hook returned.
 */
async function codexStep(engine: CodexEngine, $: Dollar) {
  engine.useHost(codexHost($))
  await engine.load()
  await engine.flush()
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
  const record = decisionRecord({
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
  })
  const saved = saveDecision(decisionIo($), routing.access.home, result.agentId, record)
  // The tag is what Jev asked for; the subagent's next step says what ran (a step before this point is not seen).
  routing.confirms.add(result.agentId, {
    description: e.description,
    planned: { model: routed.decision.model, effort: routed.decision.effort },
    record,
    saved,
  })
  announce($, spec, routed, change, took, outcome, e.tool_use_id)
  await settleDecision($, saved)
  return result
}

export const register: Register = (on, options) => {
  // The `codex` option is the switch: off, no tool is registered, nothing runs and the lead section is unchanged.
  const codexModels = parseCodexModels(options.codexModels)
  const codex = options.codex === true
    ? createCodexEngine({
      prompts: Object.fromEntries(SPECIALISTS.map(agent => [agent.name, agent.prompt])),
      models: codexModels.models,
      now: wallNow,
      random: () => Math.random(),
    })
    : undefined

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
  }

  // A matcher on session.start, agent.spawn and turn.step: the engine refuses two hooks on one event without one, and
  // the vendored Flightdeck registers those events too. The crew's session.start is outermost, so a Flightdeck failure
  // cannot stop the agents from registering; Flightdeck is registered before the hooks below, so it wraps the spawn, the
  // step and the write (it sees the description and model as they came, and logs the guard's refusals).
  on('session.start', {}, ($, e, next) => startCrew(codex, codexModels.errors, $, e, next))
  registerFlightdeck(on, options)
  // Only a request that offers the Agent tool gets the lead's section: the crew agents' tool lists leave it out.
  // A teammate renders the lead's prompt too, and `bare` asks for the engine's one section alone.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes('Agent') || e.traits.includes('teammate') || e.traits.includes('bare')) return composed
    const jev = routing.enabled && (await keyOf($, routing.access, routing.jevKey)) !== undefined
    // The Codex sentence follows the tools offered, so the text is the same on every request of a session.
    const text = codex && offersCodex(e.tools) ? `${leadSection(jev)} ${codexSection(jev)}` : leadSection(jev)
    return { sections: [...composed.sections, { id: 'crew:lead', text, scope: 'session' as const }] }
  }).catch((_, e, next) => next(e))
  on('agent.spawn', {}, ($, e, next) => routeSpawn(routing, $, e, next)).catch((_, e, next) => next(e))
  // Runs on every request of every loop: the main loop and agents that were not routed return at once. A streaming
  // hook is written inline as an async generator: the engine reads no other form.
  on('turn.step', {}, async function* ($, e, next) {
    // The main loop hands the Codex jobs a newer host and writes the cards that could not be written before.
    // Not awaited: a panel write that hangs must not hold the step.
    if (codex && !e.agentId) void codexStep(codex, $).catch(() => {})
    let effort: Effort | undefined
    if (routing.enabled && e.agentId && e.effort !== undefined) {
      effort = await routing.book.lookup(e.agentId, () => listAgents($)).catch(() => undefined)
    }
    const sent = effort && effort !== e.effort ? { ...e, effort } : e
    const answer = yield* next(sent)
    // Only a step the API answered says what ran; one that failed leaves the check for the next.
    const pending = e.agentId && answer.usage ? routing.confirms.take(e.agentId) : undefined
    if (pending && e.agentId && answer.usage) {
      const ran = { model: answer.usage.model, effort: sent.effort === undefined ? undefined : String(sent.effort) }
      $.ui.log(confirmText(pending.description, pending.planned, ran), { to: 'transcript' })
      // After the spawn's own write, so the record with what ran is the one that stays; bounded like the spawn's, so
      // a hung write cannot hold the subagent's step.
      const id = e.agentId
      await settleDecision($, pending.saved.then(() => saveDecision(decisionIo($), routing.access.home, id, withRan(pending.record, ran))))
    }
    return answer
  })

  // The main loop has no agentId and is never held; a subagent is held by its type's rule in guard.ts.
  on('tool.call', { tool: 'Write' }, guardWrite).catch(holdUnchecked)
  on('tool.call', { tool: 'Edit' }, guardWrite).catch(holdUnchecked)

  // After registerFlightdeck, so the dashboard wraps them. Registered only with the option on: off, a call to these
  // names (none is offered) fails as for any unknown tool.
  if (codex) {
    const failed = (error: { message?: string; kind: string }) =>
      codexReply({ text: `crew codex failed: ${error.message ?? error.kind}`, isError: true })
    on('tool.call', { tool: 'mcp__crew__codex' }, ($, e, next) => codexStart(codex, $, routing, e, next.signal)).catch((_$, _e, next) => failed(next.error))
    on('tool.call', { tool: 'mcp__crew__codex_result' }, ($, e) => codexResult(codex, $, e)).catch((_$, _e, next) => failed(next.error))
    on('tool.call', { tool: 'mcp__crew__codex_cancel' }, ($, e) => codexCancel(codex, $, e)).catch((_$, _e, next) => failed(next.error))
  }
}
