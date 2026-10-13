import { atom, read, update } from 'claude-code'
import type { Hook, Register, Timer, TurnStepChunk, TurnStepResult } from 'claude-code'
import type { CrewAgent, CrewMode as Mode, CrewPlanDisplay } from '../types'
import { createAgentTracker } from './hud/agents'
import type { AgentIo, AgentTracker } from './hud/agents'
import { createPlanRefresher } from './hud/files'
import type { PlanIo, PlanRefresher } from './hud/files'
import { bandRows, paneView } from './hud/view'
import type { Segment } from './hud/view'
import { paint, paletteOf } from './hud/palette'
import type { Palette } from './hud/palette'
import { SPECIALISTS, isGatewayBase, mainSection, nativeCodexSection, nativeCodexSpecs, onCodexLogin } from './agents'
import type { Agent, Effort } from './agents'
import { HANDBACK_ID, HELPER_ROLES, callerOf, handedBackMessage, helperReady, helperServes, lastUserText, runTurn, socketOf } from './appserver'
import type { Probe } from './appserver'
import { CODEX_URL, HANDBACK, codexBody, codexEffort, codexHeaders, failedStep, handbackStep, rejectionNote, statusReason, stepOf, textStep } from './codex'
import type { ApiMessage, CodexEffort, CodexStep } from './codex'
import { parseLogin } from './codex-login'
import { TOOL_SCHEMAS, describable } from './codex-tools'
import { createConfirmations, confirmText, observedEffort } from './confirm'
import type { Confirmations } from './confirm'
import { decisionRecord, saveDecision, withRan } from './decisions'
import type { DecisionIo } from './decisions'
import { createEffortBook } from './effort'
import type { BindOutcome, EffortBook, Listed } from './effort'
import { deniedWrite } from './guard'
import { createBreaker, createGate, createJev, failureText } from './jev'
import type { Breaker, Gate, JevIo } from './jev'
import { checkKey, repoDeclares, resolveAccess, resolveLoginHome } from './key'
import type { KeyIo, LoginOff, Off } from './key'
import { CODEX_MODELS, CODEX_PREFIX } from './native'
import { JEV_MODEL } from './questions'
import { defaultsOf, describe, noticeText, route, routable, twinFor, untagged } from './routing'
import type { Routed, Switch, Target } from './routing'
import { appliedEffort, spawnRequest } from './spawn'

/**
 * The `$` a hook receives. Every hook builds what it needs from its own. The HUD ticker, its queued observations and the
 * plan read flight keep the `$` of the hook that started them, and the breaker reads the wall clock instead.
 */
type Dollar = Parameters<Hook<'session.start'>>[0]

/** The wall clock. The breaker outlives every hook's `$`, so it reads this same function rather than a `$` call. */
const wallNow = () => Date.now()

/** The running session's crew mode: set from the `mode` option at session start, switched by `/crew-mode`. */
const MODE = { plugin: 'crew', key: 'mode' } as const

const MODE_COMMAND = 'crew-mode'
/** The pane that draws the plans as trees: `/crew-hud` opens it, and its id keys the `ui.render` hook. */
const HUD_COMMAND = 'crew-hud'
const HUD_PANE = 'crew-hud'

/** The option as a mode: anything but `codex` is `claude`. */
const modeOption = (value: unknown): Mode => (value === 'codex' ? 'codex' : 'claude')

const plans = atom({ plugin: 'crew', key: 'plans' } as const, [] as CrewPlanDisplay[])
const agents = atom({ plugin: 'crew', key: 'agents' } as const, [] as CrewAgent[])
const nowAtom = atom({ plugin: 'crew', key: 'now' } as const, 0)
const paletteAtom = atom({ plugin: 'crew', key: 'palette' } as const, 'theme' as Palette)

/** The pane's palette from the person's theme; an unreadable theme keeps the theme's keys. */
async function readPalette($: Dollar): Promise<void> {
  const theme = await $.config.list().then(rows => rows.find(row => row.key === 'theme')?.value, () => undefined)
  await update($, paletteAtom, () => paletteOf(theme))
}

/** HUD failures must never affect host results or router decisions. */
async function hud($: Dollar, action: () => Promise<void>): Promise<void> {
  try { await action() } catch {
    try { $.ui.log('crew HUD: observation failed', { to: 'debug' }) } catch { /* Reporting cannot change the observed result. */ }
  }
}

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

/** The host's HTTP access for the pure modules: wrapped, not passed as a value, since the engine's validate rejects the latter. */
function httpIo($: Dollar): Pick<JevIo, 'fetch'> {
  return {
    fetch: async (url, init) => {
      const response = await $.http.fetch(url, init)
      return { status: response.status, text: response.text, headers: response.headers }
    },
  }
}

/** Jev's host access: the request goes through the host's network, time is the host's clock. */
function jevIo($: Dollar): JevIo {
  return { ...httpIo($), ...clockOf($) }
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
async function redactContext($: Dollar, home?: string): Promise<{ home: string; root: string }> {
  const root = await $.session.cwd().catch(() => undefined)
  return { home: home ?? homeFromCwd(root) ?? '', root: root ?? '' }
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
type StepHook = Parameters<Hook<'turn.step'>>

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
  /** The registered twins crew answers itself on the Codex login, by type (`crew:<name>`). */
  onLogin: Map<string, Agent<string>>
  /** The types among them that run on the crew Codex helper rather than on a direct backend request. */
  helped: Set<string>
}

/** The base URL the session sends its API calls to; a failing read is no URL. */
async function baseUrl($: Dollar): Promise<string | undefined> {
  try {
    return await $.env.get('ANTHROPIC_BASE_URL')
  } catch {
    return undefined
  }
}

/** How a twin is reached: answered by crew straight from the Codex backend, run by the crew Codex helper, or behind a gateway. */
type Via = 'backend' | 'helper' | 'gateway'

/**
 * The `-codex` types the session can reach, each with how: on the Codex login (`codexLogin` on) through the helper
 * for a helper role when the helper is ready, else through the backend when crew can describe every tool of the twin
 * (the fallback of the planner and the challenger); else behind a gateway base URL; none on Anthropic's API or with
 * none set.
 */
async function reachableNative($: Dollar, native: Native, onLogin: boolean, helperRoles: readonly string[]): Promise<{ agent: Agent<string>; via: Via }[]> {
  if (native.specs.length === 0) return []
  const gateway = isGatewayBase(await baseUrl($))
  return native.specs.flatMap((agent): { agent: Agent<string>; via: Via }[] =>
    onLogin && helperServes(agent.name, helperRoles)
      ? [{ agent: onCodexLogin(agent), via: 'helper' }]
      : onLogin && describable(agent.tools)
        ? [{ agent: onCodexLogin(agent), via: 'backend' }]
        : gateway ? [{ agent, via: 'gateway' }] : [],
  )
}

/** The host's `fetch` and `run` as the helper link takes them: wrapped, since the engine's validate rejects a function value. */
function probeOf($: Dollar): Probe {
  return {
    fetch: async (url, init) => await $.http.fetch(url, init),
    run: async (argv, init) => await $.process.run(argv, init),
  }
}

/** Registers the `-codex` types the session can reach; without a route a spawn would only fail, so one debug line says why not. */
async function registerNative($: Dollar, native: Native, home: string | undefined) {
  native.registered.length = 0
  native.onLogin.clear()
  native.helped.clear()
  // The helper is asked only for a login the session may use; one status call, which starts nothing.
  let helperRoles: readonly string[] = []
  if (home !== undefined) {
    const ready = await helperReady(probeOf($), socketOf(home)).catch(() => ({ ready: false as const, reason: 'the crew Codex helper could not be asked' }))
    if (ready.ready) {
      helperRoles = ready.roles
      // A helper from before a role's lane is ready for the roles it has, and serves no more: the rest fall back.
      if (HELPER_ROLES.some(role => !helperRoles.includes(role))) $.ui.log('crew: the running crew Codex helper has no lane for every twin (rerun plugins/crew/helper/install.sh)', { to: 'debug' })
    } else {
      $.ui.log(`crew: the helper twins are not on the helper: ${ready.reason}`, { to: 'debug' })
    }
  }
  const reachable = await reachableNative($, native, home !== undefined, helperRoles)
  if (reachable.length === 0) {
    $.ui.log('crew: Codex twins not registered (no gateway URL, and no twin can run on the Codex login)', { to: 'debug' })
  }
  // One refused registration leaves the other twins registered; only the registered ones are routed and listed.
  for (const { agent, via } of reachable) {
    try {
      // A twin on the login keeps the Codex id too: should its step ever reach Anthropic, the unknown model fails there.
      await $.agent.register({ ...agent, model: `${CODEX_PREFIX}${agent.model}`, tools: [...agent.tools] })
      native.registered.push(agent)
      if (via !== 'gateway') native.onLogin.set(`crew:${agent.name}`, agent)
      if (via === 'helper') native.helped.add(`crew:${agent.name}`)
    } catch {
      $.ui.log(`crew: Codex twin crew:${agent.name} not registered (registration failed)`, { to: 'debug' })
    }
  }
}

const LOGIN_OFF_TEXT: Record<LoginOff, string> = {
  unreadable: 'the repository settings cannot be read',
  'repo-option': 'the repository settings declare codexLogin (set it in user settings)',
  'repo-home': 'the repository settings declare HOME',
  'no-home': 'HOME is not an absolute path',
}

/** What the `codexLogin` option resolved to at session start, and what the twins on the login keep between steps. */
type CodexLogin = {
  /** The option: on, a twin whose tools crew can describe runs on the user's Codex login, with no gateway. */
  enabled: boolean
  /** The trusted home whose `.codex/auth.json` is read; set at session start while the option may be used. */
  home?: string
  /** Agent types by id, as the host listed them; a running agent's type never changes. */
  types: Map<string, string>
  /** Per agent on the login: the backend's session id and the reasoning kept by call id. */
  sessions: Map<string, { id: string; reasoning: Map<string, readonly string[]> }>
}

/** The most agents and calls whose state is kept; the oldest go first. */
const KEPT_AGENTS = 64
const KEPT_CALLS = 256

function keep<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > cap) map.delete(map.keys().next().value as K)
}

/** Resolves the trusted home for the Codex login, once per session start; off with one debug line when it may not be used. */
async function resolveLogin($: Dollar, login: CodexLogin): Promise<void> {
  login.home = undefined
  if (!login.enabled) return
  const resolved = await resolveLoginHome(keyIo($)).catch(() => ({ off: 'unreadable' as const, home: undefined }))
  if (resolved.off) {
    $.ui.log(`crew: codexLogin is off: ${LOGIN_OFF_TEXT[resolved.off]}`, { to: 'debug' })
    return
  }
  login.home = resolved.home
}

/** The agents, then the fixed twins behind a gateway base URL, then the session's mode from the option. No secret is read at start. */
async function startCrew(native: Native, login: CodexLogin, mode: Mode, $: Dollar, e: StartHook[1], next: StartHook[2]) {
  native.registered.length = 0
  native.onLogin.clear()
  native.helped.clear()
  await registerSpecialists($)
  // A failed twin registration must not prevent the session from starting.
  try {
    await resolveLogin($, login)
    await registerNative($, native, login.home)
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
  await $.command.register({ name: HUD_COMMAND, description: 'Open the crew pane: plan steps as a tree and the running helpers' }).catch(() => {
    $.ui.log(`crew: /${HUD_COMMAND} not registered`, { to: 'debug' })
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

// --- Twins on the Codex login: the step hook answers their model requests itself ---

/** The type of a stepping agent, as the host lists it; remembered, since it never changes. */
async function agentType($: Dollar, login: CodexLogin, agentId: string): Promise<string | undefined> {
  const known = login.types.get(agentId)
  if (known !== undefined) return known
  const type = (await $.agent.list()).find(agent => agent.id === agentId)?.type
  if (type !== undefined) keep(login.types, agentId, type, KEPT_AGENTS)
  return type
}

/** The twin on the login a step belongs to, or undefined. A list that fails is no twin: the step's Codex id then fails at Anthropic. */
async function twinOnLogin($: Dollar, native: Native, login: CodexLogin, agentId: string | undefined): Promise<Agent<string> | undefined> {
  if (!agentId || native.onLogin.size === 0) return undefined
  const type = await agentType($, login, agentId).catch(() => undefined)
  return type === undefined ? undefined : native.onLogin.get(type)
}

/** A v4 UUID for the backend's session id, one per agent, so the agent's requests share the backend's cache. */
function sessionId(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16))
  hex[12] = '4'
  hex[16] = '89ab'.charAt(Math.floor(Math.random() * 4))
  const id = hex.join('')
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
}

/** Whether the host gave this agent the SubagentHandback tool: in its tool list or named in its conversation. */
async function handbackOffered($: Dollar, agentId: string | undefined): Promise<boolean> {
  if (!agentId) return false
  const listed = await $.tool.list().catch(() => [])
  if (listed.some(tool => tool.name === HANDBACK)) return true
  const messages = await $.session.messages({ agentId, as: 'api' }).catch(() => undefined)
  if (!Array.isArray(messages)) return false
  // Only the host's own reminder counts: a conversation that merely mentions the tool does not give the agent one.
  return (messages as ApiMessage[]).some(message => message.content.some(block => typeof block.text === 'string' && /<system-reminder>[\s\S]*?SubagentHandback[\s\S]*?<\/system-reminder>/.test(block.text)))
}

/** The developer message: the twin's own prompt, then where and when it runs. */
function systemOf(twin: Agent<string>, cwd: string | undefined, now: number): string {
  return [
    twin.prompt,
    '',
    `Working directory: ${cwd ?? 'unknown'}. Today's date: ${new Date(now).toISOString().slice(0, 10)}.`,
    'Read and search the project only through your tools; pass absolute file paths.',
  ].join('\n')
}

/**
 * One step of a twin on the login: the login file, the conversation and the tool descriptions, then one request to the
 * Codex backend. Every failure is a reason, never a throw. The token goes only to the backend and into no log.
 */
async function askCodex($: Dollar, login: CodexLogin, twin: Agent<string>, e: StepHook[1], effort: CodexEffort): Promise<CodexStep> {
  if (!login.home || !e.agentId) return failedStep('the Codex login is off')
  const now = await $.clock.now()
  const file = await $.fs.read(`${login.home}/.codex/auth.json`).catch(() => undefined)
  if (typeof file !== 'string') return failedStep('no Codex login file at ~/.codex/auth.json (run `codex login`)')
  const read = parseLogin(file, now)
  if (!read.ok) return failedStep(read.reason)
  const messages = await $.session.messages({ agentId: e.agentId, as: 'api' }).catch(() => undefined)
  if (!Array.isArray(messages)) return failedStep('the subagent conversation could not be read')
  const listed = await $.tool.list().catch(() => [])
  const tools = twin.tools.flatMap(name => {
    const schema = TOOL_SCHEMAS[name]
    return schema ? [{ name, description: listed.find(tool => tool.name === name)?.description || name, parameters: schema }] : []
  })
  const cwd = await $.session.cwd().catch(() => undefined)
  let session = login.sessions.get(e.agentId)
  if (!session) {
    session = { id: sessionId(), reasoning: new Map() }
    keep(login.sessions, e.agentId, session, KEPT_AGENTS)
  }
  const reasoning = session.reasoning
  const body = codexBody({ model: twin.model, effort, system: systemOf(twin, cwd, now), messages: messages as ApiMessage[], tools, reasoning: id => reasoning.get(id) })
  let rejection: unknown
  const response = await $.http.fetch(CODEX_URL, { method: 'POST', headers: codexHeaders(read.login, session.id), body: JSON.stringify(body) }).catch((error: unknown) => {
    rejection = error
    return undefined
  })
  if (!response) return failedStep(`the Codex backend could not be reached${rejectionNote(rejection)}`)
  if (response.status < 200 || response.status >= 300) return failedStep(statusReason(response.status, response.text))
  const step = stepOf(response.text, twin.model)
  for (const [id, items] of step.reasoning) keep(reasoning, id, items, KEPT_CALLS)
  return step
}

/** The helper twin's developer message: the role's prompt, then where it runs and what its sandbox allows. */
function helperInstructions(twin: Agent<string>, repo: string, now: number): string {
  return [
    twin.prompt,
    '',
    `Repository: ${repo}. Today's date: ${new Date(now).toISOString().slice(0, 10)}.`,
    'Your working directory is the repository. The sandbox is read-only: every write and all network access are refused, so work from the repository, its git history and local files.',
  ].join('\n')
}

/**
 * One step of a twin run by the crew Codex helper: the agent's last request goes to its thread as a turn, and the
 * turn's final text is the step's answer. Every failure is a reason, never a throw. No token is read here: the helper's
 * Codex owns the login.
 */
async function askHelper($: Dollar, login: CodexLogin, twin: Agent<string>, e: StepHook[1], effort: CodexEffort, signal: AbortSignal): Promise<CodexStep> {
  if (!login.home || !e.agentId) return failedStep('the Codex login is off')
  const messages = await $.session.messages({ agentId: e.agentId, as: 'api' }).catch(() => undefined)
  if (!Array.isArray(messages)) return failedStep('the subagent conversation could not be read')
  const prompt = lastUserText(messages as ApiMessage[])
  if (prompt === undefined) return failedStep('the subagent has no request to answer')
  const repo = await $.session.cwd().catch(() => undefined)
  if (!repo) return failedStep('the session directory is unknown')
  const now = await $.clock.now()
  const outcome = await runTurn(
    probeOf($),
    socketOf(login.home),
    { caller: callerOf(e.agentId), role: twin.name.replace(/-codex$/, ''), repo, model: twin.model, effort, instructions: helperInstructions(twin, repo, now), prompt },
    () => signal.aborted,
  )
  if (outcome.kind === 'text') return textStep(outcome.text)
  return outcome.kind === 'aborted' ? textStep('') : failedStep(outcome.reason)
}

/**
 * A step of a twin on the Codex login, answered here: nothing is sent to Anthropic. A failure answers with its reason
 * and never throws, since a hook that throws is skipped and the engine would send the request itself.
 */
async function* stepOnLogin($: Dollar, login: CodexLogin, twin: Agent<string>, helped: boolean, e: StepHook[1], effort: CodexEffort, signal: AbortSignal): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  // The host asked for another step after the answer was handed back: the task is done, and is not run again.
  const handed = e.agentId ? await $.session.messages({ agentId: e.agentId, as: 'api' }).then(list => (Array.isArray(list) ? handedBackMessage(list as ApiMessage[]) : undefined)).catch(() => undefined) : undefined
  const asked = handed !== undefined ? Promise.resolve(textStep(handed)) : helped ? askHelper($, login, twin, e, effort, signal) : askCodex($, login, twin, e, effort)
  const answered = await asked.catch(() => failedStep('the Codex request failed'))
  // An interrupted step shows nothing: the person stopped it while Codex answered.
  if (signal.aborted) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  // A final answer (no tool call) reaches the caller only through SubagentHandback where the host runs the agent as a subagent.
  const handback = handed === undefined && answered.toolUses.length === 0 && answered.answer !== '' && (await handbackOffered($, e.agentId).catch(() => false))
  const step = handback ? handbackStep(answered, `${HANDBACK_ID}${e.turnId}_${e.index}`.replace(/[^A-Za-z0-9_-]/g, '_')) : answered
  for (const chunk of step.chunks) yield chunk
  return { turnId: e.turnId, index: e.index, answer: step.answer, toolUses: step.toolUses, stopReason: step.stopReason, usage: step.usage }
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

/** Asks Jev about one call. A failure is one debug line; the caller requests the role default. */
async function askJev($: Dollar, routing: Routing, key: string, spec: Target, e: SpawnHook[1]): Promise<Routed | undefined> {
  try {
    const ask = createJev(jevIo($), key, { model: JEV_MODEL, breaker: routing.breaker, gate: routing.gate })
    return await route(ask, await redactContext($, routing.access.home), spec, e)
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

// Jev moves effort, never model or type: the tool allowlist stays the main session's choice. The one rewrite of the
// type is the codex mode's, to the same role's registered twin, and it comes first: everything after it (the Jev
// request, the effort book, the tag, the confirmation) reads the rewritten type.
// Any Jev failure requests the role default through the same effort book.
async function routeSpawn(routing: Routing, $: Dollar, e: SpawnHook[1], next: (input: SpawnHook[1]) => ReturnType<SpawnHook[2]>) {
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
  // Models stay fixed. Any Jev failure requests the role default; a switch without Jev uses it too.
  const routed = jevRouted ?? defaultsOf(spec)
  // The task shows what was chosen, so the task list says whether routing runs; the book matches the shown description.
  // A twin's suffix is the gateway's `cx/<model>-<effort>`, ahead of the host's output_config.effort, even on the first step.
  const { description, suffix, requestedApply, bookEffort } = spawnRequest(spec, routed, {
    enabled: routing.enabled,
    jevAnswered: jevRouted !== undefined,
    description: e.description,
  })

  // Failures explicitly request the role default. Twins use only the suffix.
  const token = suffix ? undefined : routing.book.add(e.subagentType, description, bookEffort, e.parentAgentId, requestedApply)
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
  const applied = appliedEffort({ suffix: suffix !== undefined, outcome, bound: routing.book.bound(result.agentId), routed, requestedApply, spec })

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

/**
 * The step as it goes out: a routed subagent's effort from the book, which the first step decides. A twin on the login and
 * a step with no routing keep the step as the host sent it.
 */
async function bindStepEffort($: Dollar, routing: Routing, e: StepHook[1], twin: Agent<string> | undefined): Promise<StepHook[1]> {
  let effort: Effort | undefined
  if (!twin && routing.enabled && e.agentId && e.effort !== undefined) {
    effort = await routing.book.lookup(e.agentId, () => listAgents($)).catch(() => undefined)
  }
  return effort && effort !== e.effort ? { ...e, effort } : e
}

/**
 * The first step after a routed spawn: what ran goes to the transcript and the decision log. Only a step the API answered
 * says what ran; one that failed leaves the check for the next. The log write is bounded like the spawn's, so a hung write
 * cannot hold the subagent's step.
 */
async function confirmStep($: Dollar, routing: Routing, agentId: string | undefined, sent: StepHook[1], answer: TurnStepResult, loginEffort: string | undefined): Promise<void> {
  const pending = agentId && answer.usage ? routing.confirms.take(agentId) : undefined
  if (!pending || !agentId || !answer.usage) return
  const ran = { model: answer.usage.model, effort: loginEffort ?? observedEffort(sent, pending.suffix) }
  $.ui.log(confirmText(pending.description, pending.planned, ran, pending.via, pending.suffix), { to: 'transcript' })
  // After the spawn's own write, so the record with what ran is the one that stays.
  // Without a trusted home the spawn already said the record was not written; nothing more is said here.
  const home = routing.access.home
  if (home) await settleDecision($, pending.saved.then(() => saveDecision(decisionIo($), home, agentId, withRan(pending.record, ran))))
}

/** The band's own state. Agent observation and the plan read are kept apart from routing, effort and confirmation. */
type HudState = { agents: AgentTracker; plans: PlanRefresher; ticker?: Timer; initial?: Promise<void>; ticks: number }

/** The agent observation's host access: the clock, the agent list and the displayed records. */
function agentIo($: Dollar): AgentIo {
  return {
    now: () => $.clock.now(),
    list: async () => (await $.agent.list()).map(a => ({ id: a.id, type: a.type, status: a.status })),
    update: async change => { await update($, agents, change) },
    log: text => $.ui.log(text, { to: 'debug' }),
  }
}

/** The plan files' host access: the session directory, the files and the displayed plans. */
function planIo($: Dollar): PlanIo {
  return {
    cwd: () => $.session.cwd(),
    exists: path => $.fs.exists(path),
    stat: path => $.fs.stat(path, { resolve: true }),
    list: path => $.fs.list(path),
    read: path => $.fs.read(path),
    publish: async change => { await update($, plans, change) },
    context: () => redactContext($),
    log: text => $.ui.log(text, { to: 'debug' }),
  }
}

function ensureTicker($: Dollar, state: HudState): void {
  if (state.ticker) return
  const lifecycle = state.agents.lifecycle()
  state.initial = hud($, async () => {
    const time = await $.clock.now()
    if (state.agents.lifecycle() === lifecycle) await update($, nowAtom, () => time)
  })
  state.ticker = $.clock.every(1_000, () => {
    void hud($, async () => {
      state.ticks++
      await state.agents.reconcile(agentIo($))
      if (state.ticks % 5 === 0) await state.plans.refresh(planIo($))
      const active = (await read($, agents)).some(agent => agent.status === 'running')
      if (active || state.ticks % 30 === 0) {
        const time = await $.clock.now()
        await update($, nowAtom, () => time)
      }
    })
  })
}

async function observeWrite<E extends object, R extends { deny?: string; isError?: boolean }>(
  $: Dollar, e: E, next: (input: E) => Promise<R>, display: HudState,
): Promise<R> {
  await hud($, async () => { ensureTicker($, display) })
  const answer = await next(e)
  if (answer && typeof answer === 'object' && !('deny' in answer) && !answer.isError) {
    await hud($, async () => { await display.plans.written(planIo($), (e as { file_path?: unknown }).file_path) })
  }
  return answer
}

export const register: Register = (on, options) => {
  // Fixed twins register only at session start behind a gateway base URL, never on reload alone.
  const native: Native = { specs: nativeCodexSpecs(CODEX_MODELS), registered: [], onLogin: new Map(), helped: new Set() }
  // The `codexLogin` option: a twin crew can describe runs on the user's Codex login, its steps answered below.
  const codex: CodexLogin = { enabled: options.codexLogin === true, types: new Map(), sessions: new Map() }

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

  const display: HudState = { agents: createAgentTracker(), plans: createPlanRefresher(), ticks: 0 }
  // The start itself comes first and unchanged; the band's first plan read follows and cannot alter its result.
  on('session.start', {}, async ($, e, next) => {
    try {
      return await startCrew(native, codex, routing.mode, $, e, next)
    } finally {
      // Neither waits on the start: the first plan read runs behind it and the tick rereads.
      void hud($, async () => { ensureTicker($, display) })
      void hud($, async () => {
        await display.initial
        await display.plans.refresh(planIo($))
      })
      void hud($, () => readPalette($))
    }
  })
  // A theme change repaints the pane; the change itself is the person's and passes unchanged.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (!result.deny) await hud($, async () => { await update($, paletteAtom, () => paletteOf(result.value)) })
    return result
  })
  on('command.run', { command: MODE_COMMAND }, async ($, e) => ({ text: await runModeCommand($, native, routing.mode, e.args) }))
    .catch(() => ({ text: `crew: /${MODE_COMMAND} failed; run it again to see the mode.` }))
  on('command.run', { command: HUD_COMMAND }, async $ => {
    const opened = await $.ui.open({ id: HUD_PANE, title: 'Crew', closeOnEscape: true })
    return { text: opened.isPlaced ? 'the pane is open.' : 'the pane waits for a wider terminal; the band above the prompt shows the summary.' }
  }).catch(() => ({ text: `/${HUD_COMMAND} failed; the band above the prompt still shows the summary.` }))
  // Reads the same prepared atoms as the band, never a host: a failure draws nothing and leaves the pane as it was.
  // The width is the body's; the rows are all drawn and the host scrolls them while the pane has the keyboard.
  on('ui.render', { component: 'Pane', requestId: HUD_PANE }, async ($, e, next) => {
    try {
      const [shown, running, time, palette] = await Promise.all([read($, plans), read($, agents), read($, nowAtom), read($, paletteAtom)])
      const columns = e.props?.bodyColumns ?? e.viewport?.columns ?? 80
      const view = paneView({ plans: shown, agents: running, now: time, columns })
      const { Box, Text } = $.ui.resolve(e)
      if (view.empty) {
        return <Box flexDirection="column"><Text dimColor>No plan or helper yet. Plans live in .crew/plans/.</Text></Box>
      }
      const line = (row: Segment[], key: string) => <Text key={key} wrap="truncate">{row.map((part, at) =>
        <Text key={`${key}-${at}`} {...paint(palette, part.style, part.bold)}>{part.text}</Text>)}</Text>
      return <Box flexDirection="column">
        {line(view.head, 'head')}
        {view.boxes.map((box, index) =>
          <Box key={`box-${index}`} flexDirection="column" borderStyle="round" borderColor={paint(palette, box.tone).color ?? 'inactive'} paddingX={1}>
            {line(box.title, `title-${index}`)}
            {box.rows.map((row, at) => line(row, `row-${index}-${at}`))}
          </Box>)}
        {line(view.foot, 'foot')}
      </Box>
    } catch {
      $.ui.log('crew HUD: pane render failed', { to: 'debug' })
      return next(e)
    }
  })
  on('session.end', {}, (_$, e, next) => {
    display.ticker?.cancel()
    display.ticker = undefined
    display.agents.reset()
    display.initial = undefined
    return next(e)
  })
  // Only a request that offers the Agent tool gets the main section: the crew agents' tool lists leave it out.
  // A teammate renders the main session's prompt too, and `bare` asks for that prompt alone.
  on('prompt.compose', async ($, e, next) => {
    await hud($, async () => { ensureTicker($, display) })
    const composed = await next(e)
    if (!e.tools.includes('Agent') || e.traits.includes('teammate') || e.traits.includes('bare')) return composed
    const jev = routing.enabled && (await keyOf($, routing.access, routing.jevKey)) !== undefined
    const main = { id: 'crew:main', text: mainSection(jev), scope: 'session' as const }
    // The `-codex` types get a section of their own, under the same rule and only for the twins this session registered.
    // It reads the same in either mode, so switching the mode does not change the prompt.
    if (native.registered.length === 0) return { sections: [...composed.sections, main] }
    const twins = { id: 'crew:native-codex', text: nativeCodexSection(native.registered), scope: 'session' as const }
    return { sections: [...composed.sections, main, twins] }
  }).catch((_, e, next) => next(e))
  on('agent.spawn', {}, ($, e, next) => {
    void hud($, async () => { ensureTicker($, display) })
    // A `model` on a twin's call wins over its definition and would run it on Claude with no tag or confirmation. The
    // fixed names decide, not the registered set: a later `session.start` that registered none leaves the host's types.
    if (e.model && native.specs.some(twin => e.subagentType === `crew:${twin.name}`)) {
      return { deny: `crew: ${e.subagentType} runs on its own Codex model; call it again without \`model\`` }
    }
    const observeNext = async (sent: SpawnHook[1]) => {
      const spawned = display.agents.spawning(agentIo($))
      const result = await next(sent)
      if (result.agentId) spawned({ id: result.agentId, type: sent.subagentType, model: result.model, description: sent.description })
      return result
    }
    return routeSpawn(routing, $, e, observeNext)
  }).catch((_, e, next) => next(e))
  // Runs on every request of every loop: the main loop and agents that were not routed return at once. A streaming
  // hook is written inline as an async generator: the engine reads no other form.
  on('turn.step', {}, async function* ($, e, next) {
    void hud($, async () => { ensureTicker($, display) })
    // A twin on the Codex login is answered here and never reaches the API; every other step goes on.
    const twin = await twinOnLogin($, native, codex, e.agentId)
    const sent = await bindStepEffort($, routing, e, twin)
    // The spawn's `-<effort>` suffix decides, else the host's effort, else the twin's default; it is what goes out.
    const loginEffort = twin ? codexEffort(observedEffort(sent, true), codexEffort(twin.effort, 'medium')) : undefined
    // The band's own record of this step: synchronous, never throws, and reads what is sent without changing it.
    const noted = display.agents.stepped(agentIo($), e.agentId, sent, loginEffort)
    let answer: TurnStepResult
    if (twin && loginEffort) answer = yield* stepOnLogin($, codex, twin, native.helped.has(`crew:${twin.name}`), sent, loginEffort, next.signal)
    else answer = yield* next(sent)
    display.agents.answered(agentIo($), e.agentId, noted, answer)
    await confirmStep($, routing, e.agentId, sent, answer, loginEffort)
    return answer
  })

  on('turn.complete', {}, ($, e, next) => {
    void hud($, async () => { ensureTicker($, display) })
    if (e.agentId) display.agents.completed(agentIo($), e.agentId)
    return next(e)
  })

  // The main loop has no agentId and is never held; a subagent is held by its type's rule in guard.ts.
  on('tool.call', { tool: 'Write' }, guardWrite).catch(holdUnchecked)
  on('tool.call', { tool: 'Edit' }, guardWrite).catch(holdUnchecked)
  // Post-result only: guardWrite and holdUnchecked remain the sole write gates.
  on('tool.call', { tool: 'Write' }, ($, e, next) => observeWrite($, e, next, display))
  on('tool.call', { tool: 'Edit' }, ($, e, next) => observeWrite($, e, next, display))
  // A crew agent's tool calls, after their result: the HUD keeps the name from a fixed set, never the input, and the
  // result goes on exactly as it came.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      const failed = result.isError === true || result.deny !== undefined
      void hud($, async () => { display.agents.tooled(agentIo($), e.agentId, (e as { tool?: unknown }).tool, failed) })
    }
    return result
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    try {
      const [shown, running, time] = await Promise.all([read($, plans), read($, agents), read($, nowAtom)])
      const rows = bandRows({ plans: shown, agents: running, now: time, columns: e.props.bodyColumns }).rows
      if (!rows.length) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      return <Box width={e.props.bodyColumns} flexDirection="column">{rows.map((row, index) =>
        <Text key={`crew-hud-${index}`} wrap="wrap">{row.map(segment => segment.text).join('')}</Text>)}</Box>
    } catch {
      $.ui.log('crew HUD: render failed', { to: 'debug' })
      return next(e)
    }
  })
}
