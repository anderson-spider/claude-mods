// The crew HUD's hooks: they feed the atoms through the reducers (state.ts), read the active plan, answer /crew:panel and
// draw the pane and the band through draw.ts. Every `$` call of the HUD is here, in functions declared at the top of
// this file (the engine follows `$` no further). The crew's `register` calls `registerHud` after its own session.start
// hook and before its other hooks, so the HUD wraps the spawn, the step and the write, and reads what the crew decided
// from `shared` once `next` returned.
//
// Every hook that calls `next` observes and never throws: its own work sits in try/catch and it returns what `next`
// returned (or `next(e)`), so a HUD failure never reaches the call or the crew's hooks on the same event. No pass-through
// `.catch` either: it would let a write that the lane guard could not check go through.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import { INITIAL_QUOTA } from '../quota'
import type { Shared } from '../routing'
import { paneForm } from './compose'
import { drawBand, drawPane, drawSummary, type HudEls } from './draw'
import { WRITE_TOOLS, openingOf, serverConsults, toolLine } from './events'
import { colorsOption } from './palette'
import {
  HIDDEN_REPLY,
  LAYOUT_IN_PROMPT,
  NO_PLAN_AUTO_REPLY,
  PANEL_FAILED,
  PANEL_USAGE,
  PLAN_AUTO_REPLY,
  PROMPT_REPLY,
  REMOVED_LAYOUT,
  RESET_REPLY,
  choiceAfterClose,
  choiceOf,
  hudOptions,
  layoutReply,
  noPlanReply,
  parsePanelArgs,
  planReply,
  recentPlanReply,
  sideReply,
  storedChoice,
  type HudOptions,
  type PanelChoice,
} from './panel'
import { RECENT_MS, choosePlan, isPlanPath, parsePlan, pinMatches, planChanges, planNameOf, type PlanCandidate } from './plan'
import { ADVISOR, displayName, isConsultType } from './roles'
import type { HudContext, HudInput } from './sections'
import {
  agentCompleted,
  agentDenied,
  agentMessaged,
  agentSpawned,
  agentStepped,
  agentTool,
  askClosed,
  askOpened,
  compactLine,
  consultEnded,
  consultLine,
  consultStarted,
  defaultSession,
  denyLine,
  endLine,
  logged,
  loopEnded,
  loopStepped,
  modeChanged,
  promptLine,
  sessionCompacted,
  sessionMeasured,
  sessionStarted,
  sessionStepped,
  spawnLine,
  trackFavored,
  turnEnded,
  turnSpawned,
  turnStarted,
  verdictLine,
} from './state'
import { DEFAULT_VIEW, type AgentCard, type Consult, type Favored, type HudPlan, type HudView, type LogLine, type Loop, type Session } from './types'

type Dollar = EngineInterface
type On = Parameters<Register>[0]
type Options = Parameters<Register>[1]

const PANE = 'crew'
const TITLE = 'Crew'
/**
 * The pane's body columns when docked (inside the frame, as `bodyColumns`) and its rows when seated inline. Both are
 * requests: a width the person dragged or keyed the dock to wins, this session's or a kept one.
 */
const PANE_COLUMNS = 56
const MINI_ROWS = 8
/** The `$.store` key holding the person's pick: `{ v: 1, isVisible, placement }`. */
const PANEL_KEY = 'panel'
/** Plans read at the start to pick the active one: the newest this many. */
const START_PLANS = 20

// ------------------------------------------------------------------ atoms

const sessionAtom = atom({ plugin: 'crew', key: 'hudSession' } as const, defaultSession(0))
const agentsAtom = atom({ plugin: 'crew', key: 'hudAgents' } as const, [])
const consultsAtom = atom({ plugin: 'crew', key: 'hudConsults' } as const, [])
const logAtom = atom({ plugin: 'crew', key: 'hudLog' } as const, [])
const loopsAtom = atom({ plugin: 'crew', key: 'hudLoops' } as const, [])
const favoredAtom = atom({ plugin: 'crew', key: 'hudFavored' } as const, null)
const planAtom = atom({ plugin: 'crew', key: 'hudPlan' } as const, null)
const viewAtom = atom({ plugin: 'crew', key: 'hudView' } as const, DEFAULT_VIEW)
/** The session's effective panel choice; null until session.start seeded it (the band passes until then). */
const panelAtom = atom({ plugin: 'crew', key: 'panel' } as const, null)
/** The crew's own quota atom (hooks/register.tsx writes it); the HUD only reads it. */
const quotaAtom = atom({ plugin: 'crew', key: 'quota' } as const, INITIAL_QUOTA)

// ------------------------------------------------------------------ reads, lenient (a value of another shape reads as empty)

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const listOf = <T,>(v: unknown, keep: (x: Record<string, unknown>) => boolean): T[] =>
  Array.isArray(v) ? (v.filter(x => isObject(x) && keep(x)) as T[]) : []

const sessionOf = (v: unknown): Session => (isObject(v) ? { ...defaultSession(0), ...(v as Session) } : defaultSession(0))
const cardsOf = (v: unknown): AgentCard[] => listOf(v, c => typeof c.id === 'string' && typeof c.type === 'string' && Array.isArray(c.rounds))
const consultsOf = (v: unknown): Consult[] => listOf(v, c => typeof c.id === 'string' && typeof c.who === 'string')
const logOf = (v: unknown): LogLine[] => listOf(v, l => typeof l.text === 'string')
const loopsOf = (v: unknown): Loop[] => listOf(v, l => typeof l.id === 'string')
const viewOf = (v: unknown): HudView => (isObject(v) ? { ...DEFAULT_VIEW, ...(v as HudView) } : DEFAULT_VIEW)
const planOf = (v: unknown): HudPlan | null => (isObject(v) && typeof v.path === 'string' && typeof v.name === 'string' ? (v as HudPlan) : null)

async function getSession($: Dollar): Promise<Session> {
  return sessionOf(await read($, sessionAtom))
}
async function getCards($: Dollar): Promise<AgentCard[]> {
  return cardsOf(await read($, agentsAtom))
}
async function getConsults($: Dollar): Promise<Consult[]> {
  return consultsOf(await read($, consultsAtom))
}
async function getView($: Dollar): Promise<HudView> {
  return viewOf(await read($, viewAtom))
}
async function getPlan($: Dollar): Promise<HudPlan | null> {
  return planOf(await read($, planAtom))
}

async function say($: Dollar, line: LogLine) {
  await update($, logAtom, list => logged(logOf(list), line))
}

async function setSession($: Dollar, fn: (s: Session) => Session) {
  await update($, sessionAtom, s => fn(sessionOf(s)))
}

async function setView($: Dollar, fn: (v: HudView) => HudView) {
  await update($, viewAtom, v => fn(viewOf(v)))
}

/** Who a call or a step belongs to, as the Log names it: the main loop is the lead. */
async function whoIs($: Dollar, agentId: string | undefined): Promise<{ who: string; type?: string }> {
  if (!agentId) return { who: 'lead' }
  const card = (await getCards($)).find(c => c.id === agentId)
  if (card) return { who: displayName(card.type), type: card.type }
  const consult = (await getConsults($)).find(c => c.id === agentId)
  return consult ? { who: consult.who, type: 'crew:architect' } : { who: 'agent' }
}

/** Everything a drawing reads, fetched together (each read subscribes the drawing to that atom). */
async function loadInput($: Dollar): Promise<{ input: HudInput; view: HudView }> {
  const [session, agents, consults, log, loops, favored, quota, plan, view, now] = await Promise.all([
    read($, sessionAtom),
    read($, agentsAtom),
    read($, consultsAtom),
    read($, logAtom),
    read($, loopsAtom),
    read($, favoredAtom),
    read($, quotaAtom),
    read($, planAtom),
    read($, viewAtom),
    $.clock.now(),
  ])
  const active = planOf(plan)
  return {
    input: {
      session: session as Session,
      agents: agents as AgentCard[],
      consults: consults as Consult[],
      log: log as LogLine[],
      loops: loops as Loop[],
      favored: favored as Favored | null,
      quota,
      plan: active ? { name: active.name, parsed: active.parsed } : null,
      now,
    },
    view: viewOf(view),
  }
}

// ------------------------------------------------------------------ the session, the turn and the quota

/**
 * The session's usage now: the context and the cost. Claude's limits are left to `session.measure`, after which the
 * crew's quota atom holds them; marking Claude measured from a read here would show "no plan limits" before it does.
 */
async function readUsage($: Dollar) {
  const u = await $.session.usage().catch(() => null)
  if (!u) return
  await setSession($, s => sessionMeasured(s, { tokens: u.context.tokens, window: u.context.window, percent: u.context.percent, costUsd: u.cost?.usd }))
}

/** The provider the router last favored, when provider routing is on; a change is stamped (the mini's quota line). */
async function noteFavored($: Dollar, isOn: boolean) {
  if (!isOn) return
  const [quota, prev, now] = await Promise.all([read($, quotaAtom), read($, favoredAtom), $.clock.now()])
  const provider = quota?.decision?.provider
  if (provider !== 'claude' && provider !== 'codex') return
  const before = isObject(prev) ? (prev as Favored) : null
  const next = trackFavored(before, provider, now)
  if (next !== before) await update($, favoredAtom, () => next)
}

async function noteMode($: Dollar, mode: string | undefined) {
  if (mode) await setSession($, s => modeChanged(s, mode))
}

/** Clears what the HUD shows of the session's work (`/crew:panel reset`, `/clear`); the plan, its pin and the panel stay. */
async function resetAll($: Dollar) {
  const now = await $.clock.now()
  await setSession($, s => ({ ...sessionStarted(s, { now }), effort: s.effort }))
  await update($, agentsAtom, () => [])
  await update($, consultsAtom, () => [])
  await update($, logAtom, () => [])
  await update($, loopsAtom, () => [])
  await update($, favoredAtom, () => null)
  await setView($, v => ({ ...v, openId: null }))
}

async function startSession($: Dollar) {
  const now = await $.clock.now()
  await setSession($, s => sessionStarted(s, { now }))
  // A host without usage (headless, an SDK host, a session not yet bound) just starts without it.
  await readUsage($)
}

// ------------------------------------------------------------------ the active plan

/** `<project root>/.crew/plans`: absolute, as `$.fs` resolves a relative path under the working directory instead. */
async function plansDir($: Dollar): Promise<string> {
  return `${(await $.session.root()).replace(/\/+$/, '')}/.crew/plans`
}

/** A tool's `file_path` as an absolute path (a relative one is the working directory's, as the tool reads it). */
async function absolutePath($: Dollar, path: string): Promise<string> {
  if (path.startsWith('/')) return path
  return `${(await $.session.cwd()).replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`
}

/** Reads a plan into the atom; a step whose state changed since the last read of the same file is one Log line. */
async function loadPlan($: Dollar, path: string, why: HudPlan['why'], known?: { text: string; mtimeMs: number }) {
  const now = await $.clock.now()
  let next: HudPlan
  try {
    const [text, mtimeMs] = known ? [known.text, known.mtimeMs] : await Promise.all([$.fs.read(path), $.fs.stat(path).then(s => s.mtimeMs)])
    next = { path, name: planNameOf(path), parsed: parsePlan(text), mtimeMs, why }
  } catch {
    next = { path, name: planNameOf(path), parsed: null, mtimeMs: 0, why }
  }
  const prev = await getPlan($)
  await update($, planAtom, () => next)
  if (prev && prev.path === path && prev.parsed && next.parsed) {
    for (const line of planChanges(prev.parsed, next.parsed, now)) await say($, line)
  }
}

/** At the start and on `plan auto` with nothing written: the newest plan changed in the last 7 days that has a step left (UI spec 13.1); its name, or null. */
async function startPlan($: Dollar): Promise<string | null> {
  const dir = await plansDir($)
  const now = await $.clock.now()
  const entries = await $.fs.list(dir).catch(() => [])
  const recent = entries
    .filter(f => f.kind === 'file' && f.name.endsWith('.md') && now - f.mtimeMs <= RECENT_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, START_PLANS)
  const candidates: PlanCandidate[] = []
  for (const f of recent) {
    const text = await $.fs.read(`${dir}/${f.name}`).catch(() => null)
    if (typeof text === 'string') candidates.push({ path: `${dir}/${f.name}`, mtimeMs: f.mtimeMs, text, pinned: false, writtenAt: null })
  }
  const choice = choosePlan(candidates, now)
  const picked = choice ? candidates.find(c => c.path === choice.path) : undefined
  if (!choice || !picked) return null
  await loadPlan($, choice.path, choice.why, picked)
  return planNameOf(choice.path)
}

/** A write to a plan file: it becomes the active plan unless another is pinned; the active one is read again. */
async function planWritten($: Dollar, rawPath: string) {
  const [path, dir] = await Promise.all([absolutePath($, rawPath), plansDir($)])
  if (!isPlanPath(path, dir)) return
  const [view, plan] = await Promise.all([getView($), getPlan($)])
  await setView($, v => ({ ...v, lastWritten: path }))
  if (view.pin !== null && !pinMatches(view.pin, path, dir)) {
    if (plan?.path === path) await loadPlan($, path, plan.why)
    return
  }
  await loadPlan($, path, view.pin !== null ? 'pin' : 'written')
}

/** After a main-loop turn: the active plan is read again when its file changed. */
async function refreshPlan($: Dollar) {
  const plan = await getPlan($)
  if (!plan) return
  const mtimeMs = await $.fs
    .stat(plan.path)
    .then(s => s.mtimeMs)
    .catch(() => 0)
  if (mtimeMs !== plan.mtimeMs) await loadPlan($, plan.path, plan.why)
}

// ------------------------------------------------------------------ agents, consults and loops

type SpawnFacts = { id: string; type: string; description: string; isUntagged: boolean; model: string; effort?: string; provider?: 'claude' | 'codex' }

async function agentStarted($: Dollar, f: SpawnFacts) {
  const now = await $.clock.now()
  await update($, loopsAtom, l => loopsOf(l).filter(x => x.id !== f.id))
  await setSession($, s => turnSpawned(s))
  if (isConsultType(f.type)) {
    let started: Consult | undefined
    await update($, consultsAtom, list => {
      const next = consultStarted(consultsOf(list), { id: f.id, type: f.type, description: f.description, now, isUntagged: f.isUntagged })
      started = next.find(c => c.id === f.id)
      return next
    })
    if (started) await say($, consultLine(started))
    return
  }
  let card: AgentCard | undefined
  await update($, agentsAtom, list => {
    const next = agentSpawned(cardsOf(list), { ...f, now })
    card = next.find(c => c.id === f.id)
    return next
  })
  if (card) await say($, spawnLine(card, now))
}

async function agentStep($: Dollar, id: string, step: { model?: string; effort?: string; usage?: Parameters<typeof sessionStepped>[1]['usage']; stopReason?: string | null }) {
  const now = await $.clock.now()
  await setSession($, s => sessionStepped(s, { isMain: false, usage: step.usage }))
  const [cards, consults] = await Promise.all([getCards($), getConsults($)])
  if (cards.some(c => c.id === id)) {
    await update($, agentsAtom, list => agentStepped(cardsOf(list), { id, ...step, now }))
  } else if (!consults.some(c => c.id === id)) {
    await update($, loopsAtom, l => loopStepped(loopsOf(l), id, now))
  }
}

async function consultDone($: Dollar, id: string, answer: string) {
  const now = await $.clock.now()
  const open = (await getConsults($)).find(c => c.id === id && c.endAt === null)
  if (!open) return
  let ended: Consult | undefined
  await update($, consultsAtom, list => {
    const next = consultEnded(consultsOf(list), { id, now, answer })
    ended = next.find(c => c.id === id)
    return next
  })
  if (ended) await say($, verdictLine(ended))
}

async function agentDone($: Dollar, id: string, reason: string, answer: string) {
  await asksEnded($, id)
  const now = await $.clock.now()
  const [cards, consults] = await Promise.all([getCards($), getConsults($)])
  if (consults.some(c => c.id === id)) return consultDone($, id, answer)
  if (!cards.some(c => c.id === id)) {
    await update($, loopsAtom, l => loopEnded(loopsOf(l), id))
    return
  }
  let card: AgentCard | undefined
  await update($, agentsAtom, list => {
    const next = agentCompleted(cardsOf(list), { id, reason, now })
    card = next.find(c => c.id === id)
    return next
  })
  const line = card ? endLine(card, now) : null
  if (line) await say($, line)
}

async function mainTurnDone($: Dollar, reason: string, durationMs: number) {
  await asksEnded($, undefined)
  const now = await $.clock.now()
  // The cost is read fresh: the receipt subtracts the cost at the turn's start from it.
  await readUsage($)
  await setSession($, s => turnEnded(s, { now, reason, durationMs }))
}

// ------------------------------------------------------------------ tools: activity, denials, permission asks, plan writes

async function toolStarted($: Dollar, agentId: string | undefined, text: string) {
  if (!agentId) return
  const cards = await getCards($)
  if (cards.some(c => c.id === agentId)) await update($, agentsAtom, list => agentTool(cardsOf(list), agentId, text))
}

async function toolDenied($: Dollar, agentId: string | undefined, text: string) {
  const now = await $.clock.now()
  const { who, type } = await whoIs($, agentId)
  if (agentId) await update($, agentsAtom, list => agentDenied(cardsOf(list), agentId, text))
  await say($, denyLine(who, text, now, type))
}

/** A permission dialog waits on the person: one per agent and tool (a PermissionRequest names no tool_use_id). */
const askKey = (agentId: string | undefined, tool: string) => `${agentId ?? 'lead'}:${tool}`

/** Modes that never show a dialog: their requests settle without the person. */
const UNATTENDED_MODES = new Set(['auto', 'dontAsk', 'bypassPermissions'])

/** Opens the ask unless the mode answers it alone; the key, or undefined when none was opened. */
async function askOpen($: Dollar, agentId: string | undefined, tool: string, mode: string | undefined): Promise<string | undefined> {
  if (UNATTENDED_MODES.has(mode || (await getSession($)).mode)) return undefined
  const id = askKey(agentId, tool)
  const { who } = await whoIs($, agentId)
  await setSession($, s => askOpened(s, { id, who, tool }))
  return id
}

async function askSettled($: Dollar, id: string) {
  const s = await getSession($)
  if (s.asks.some(a => a.id === id)) await setSession($, x => askClosed(x, id))
}

/** An agent's loop ended (the lead's turn, a subagent's run): no dialog of its can still be waiting. */
async function asksEnded($: Dollar, agentId: string | undefined) {
  const owner = `${agentId ?? 'lead'}:`
  const ids = (await getSession($)).asks.filter(a => a.id.startsWith(owner)).map(a => a.id)
  if (ids.length > 0) await setSession($, x => ids.reduce(askClosed, x))
}

// ------------------------------------------------------------------ the panel choice

/** The person's pick when there is one, else what the options say. */
async function pickedChoice($: Dollar, cfg: HudOptions): Promise<PanelChoice> {
  const stored = storedChoice(await $.store.get(PANEL_KEY).catch(() => undefined))
  return stored ?? { isVisible: cfg.openOnStart, placement: cfg.placement }
}

/** The session's choice; before session.start seeded it, what it would seed. */
async function currentChoice($: Dollar, cfg: HudOptions): Promise<PanelChoice> {
  return choiceOf(await read($, panelAtom)) ?? (await pickedChoice($, cfg))
}

/** The atom first (it redraws the band), then the store; a store that fails leaves the session's choice standing. */
async function setChoice($: Dollar, choice: PanelChoice) {
  await update($, panelAtom, () => choice)
  try {
    await $.store.set(PANEL_KEY, { v: 1, ...choice })
  } catch {
    $.ui.log('crew panel: the choice could not be saved; it holds for this session', { to: 'debug' })
  }
}

async function seedChoice($: Dollar, cfg: HudOptions) {
  const choice = await pickedChoice($, cfg)
  await update($, panelAtom, () => choice)
  if (choice.isVisible && choice.placement === 'side') void openPane($).catch(() => undefined)
}

function openPane($: Dollar) {
  // columns apply when docked beside the transcript, rows when seated inline above the prompt.
  return $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS, rows: MINI_ROWS })
}

function openSide($: Dollar) {
  return openPane($).catch(() => ({ isPlaced: false as const, reason: 'the pane could not be opened' }))
}

/** In side mode the pane the surface draws; an unasked pane waiting undrawn counts as hidden. */
async function isShown($: Dollar, choice: PanelChoice) {
  if (choice.placement === 'prompt') return choice.isVisible
  try {
    return (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
  } catch {
    return choice.isVisible
  }
}

/** `/crew:panel plan <name>`: pins the plan when its file exists. */
async function pinPlan($: Dollar, name: string): Promise<string> {
  const path = `${await plansDir($)}/${name}.md`
  const exists = await $.fs
    .stat(path)
    .then(s => s.kind === 'file')
    .catch(() => false)
  if (!exists) return noPlanReply(name)
  await setView($, v => ({ ...v, pin: name }))
  await loadPlan($, path, 'pin')
  return planReply(name)
}

/** `/crew:panel plan auto`: no pin; the plan last written this session, else the plans ranked as at the start. */
async function unpinPlan($: Dollar): Promise<string> {
  const view = await getView($)
  await setView($, v => ({ ...v, pin: null }))
  if (view.lastWritten) {
    await loadPlan($, view.lastWritten, 'written')
    return PLAN_AUTO_REPLY
  }
  const name = await startPlan($)
  if (name !== null) return recentPlanReply(name)
  await update($, planAtom, () => null)
  return NO_PLAN_AUTO_REPLY
}

type Presentation = { isFullscreen: boolean; columns: number } | undefined

async function runPanel($: Dollar, cfg: HudOptions, args: unknown, presentation: Presentation): Promise<string> {
  const command = parsePanelArgs(args)
  if (command.kind === 'usage') return PANEL_USAGE
  if (command.kind === 'removed-layout') return REMOVED_LAYOUT
  if (command.kind === 'reset') {
    await resetAll($)
    return RESET_REPLY
  }
  if (command.kind === 'plan') return pinPlan($, command.name)
  if (command.kind === 'plan-auto') return unpinPlan($)
  const current = await currentChoice($, cfg)
  if (command.kind === 'layout') {
    await setView($, v => ({ ...v, layout: command.layout }))
    if (current.placement === 'prompt') return LAYOUT_IN_PROMPT
    await setChoice($, { isVisible: true, placement: 'side' })
    const opened = await openSide($)
    return opened.isPlaced ? layoutReply(command.layout) : sideReply(opened, presentation)
  }
  const kind = command.kind === 'toggle' ? ((await isShown($, current)) ? 'off' : 'on') : command.kind
  if (kind === 'off') {
    await setChoice($, { isVisible: false, placement: current.placement })
    await $.ui.close({ id: PANE })
    return HIDDEN_REPLY
  }
  const placement = kind === 'on' ? current.placement : kind === 'prompt' ? 'prompt' : 'side'
  await setChoice($, { isVisible: true, placement })
  if (placement === 'prompt') {
    await $.ui.close({ id: PANE })
    return PROMPT_REPLY
  }
  return sideReply(await openSide($), presentation)
}

// ------------------------------------------------------------------ drawing

type Els = ReturnType<Dollar['ui']['resolve']>
type El = RenderElement

/**
 * The surface's table as the drawing takes it: Box and Text everywhere, Svg and Button where the surface has them, and
 * the clock and rail as client regions where it has `Client` (they tick on the surface's frame clock).
 */
function hudEls(els: Els, motion: boolean): HudEls<El> {
  const out: HudEls<El> = { Box: els.Box as HudEls<El>['Box'], Text: els.Text as HudEls<El>['Text'] }
  if ('Svg' in els) out.Svg = els.Svg as HudEls<El>['Svg']
  if ('Button' in els) out.Button = els.Button as HudEls<El>['Button']
  if ('Client' in els) {
    const table = els
    out.Clock = o => (<table.Client key={o.key} module="./clock.tsx" width={o.width} height={1} props={o.props} />) as El
    if (motion) out.Rail = o => (<table.Client key={o.key} module="./rail.tsx" width={o.width} height={1} props={o.props} />) as El
  }
  return out
}

/** One debug line per section the pane failed to draw, once per load (the pane redraws on every change). */
function logDrawErrors($: Dollar, seen: Set<string>, errors: readonly string[]) {
  for (const section of errors) {
    if (seen.has(section)) continue
    seen.add(section)
    $.ui.log(`crew hud: the ${section} section could not be drawn`, { to: 'debug' })
  }
}

// ------------------------------------------------------------------ hooks

/** The HUD: atoms fed from the session's events, the side pane, the band above the prompt and /crew:panel. */
export function registerHud(on: On, options: Options, shared: Shared): void {
  const cfg = hudOptions(options as Record<string, unknown>)
  const colors = colorsOption(options.colors)
  const quotaOn = options.quotaRouting === true
  const routingOn = () => quotaOn && shared.twins.length > 0
  const ctxOf = (view: HudView): HudContext => ({ routing: routingOn(), jev: shared.jev, twins: shared.twins.length > 0, claudeMeasured: view.claudeMeasured })
  const draw = { colors, motion: cfg.motion }
  // tool.check carries the refusal first; the tool.call around it must not log it a second time.
  const denied = new Set<string>()
  const drawErrors = new Set<string>()

  on('session.start', async ($, e, next) => {
    try {
      await startSession($)
      await noteFavored($, routingOn())
    } catch {}
    // Its own try: a plan that cannot be read skips nothing above.
    try {
      await startPlan($)
    } catch {}
    // Its own try: a store that fails skips nothing above, and the options then decide.
    try {
      await seedChoice($, cfg)
    } catch {}
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      if (e.reason === 'clear') await resetAll($)
    } catch {}
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    try {
      await noteMode($, e.permission_mode)
    } catch {}
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      await setSession($, s => turnStarted(s, { now }))
      // A background agent's report reaches the main loop as the text opening this turn: a consult's is its verdict.
      const opening = openingOf(e.text)
      if (opening.kind === 'handback') await consultDone($, opening.from, e.text)
      else if (opening.kind === 'prompt' && e.text.trim() !== '') await say($, promptLine(e.text, now))
    } catch {}
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      // The main loop's model is known when its request starts; a long first request should not read "model unknown".
      try {
        await setSession($, s => sessionStepped(s, { isMain: true, model: e.model, effort: e.effort === undefined ? undefined : String(e.effort) }))
      } catch {}
      const result = yield* next(e)
      try {
        await setSession($, s => sessionStepped(s, { isMain: false, usage: result.usage ?? undefined }))
        if (result.usage?.model) {
          const model = result.usage.model
          await setSession($, s => (s.model === model ? s : { ...s, model }))
        }
      } catch {}
      return result
    }
    const result = yield* next(e)
    try {
      // The crew rewrote the effort beneath this hook; the one it applied is in `shared`. A step that sent none ran on none.
      const effort = e.effort === undefined ? undefined : (shared.agents.get(e.agentId)?.effort ?? String(e.effort))
      await agentStep($, e.agentId, { model: result.usage?.model, effort, usage: result.usage ?? undefined, stopReason: result.stopReason })
    } catch {}
    return result
  })

  on('session.measure', async ($, e, next) => {
    const answer = await next(e)
    try {
      await setSession($, s => sessionMeasured(s, { tokens: e.context.tokens, window: e.context.window, percent: e.context.percent, costUsd: e.cost?.usd }))
      // The host measures after each main-loop turn: from here an absent Claude window means no plan limits.
      await setView($, v => (v.claudeMeasured ? v : { ...v, claudeMeasured: true }))
      await noteFavored($, routingOn())
    } catch {}
    return answer
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    try {
      if (!e.agentId && e.trigger !== 'precompute') {
        const now = await $.clock.now()
        await setSession($, s => sessionCompacted(s))
        await say($, compactLine(now))
      }
    } catch {}
    return done
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    try {
      const id = e.tool_use_id
      if (verdict.decision === 'deny') {
        if (id) {
          denied.add(id)
          if (denied.size > 200) denied.delete(denied.values().next().value as string)
        }
        await toolDenied($, e.agentId, toolLine(String(e.tool), e.input))
      }
    } catch {}
    return verdict
  })

  // A verdict of `ask` is not a dialog (auto mode's classifier and dontAsk answer it alone): the dialog is this request.
  on('classic.PermissionRequest', async ($, e, next) => {
    let key: string | undefined
    try {
      key = await askOpen($, e.agent_id, e.tool_name, e.permission_mode)
    } catch {}
    let answer: Awaited<ReturnType<typeof next>> | undefined
    try {
      answer = await next(e)
      return answer
    } finally {
      // A hook beneath that decided answered the request: nobody is asked. Else the call's end closes it.
      if (key && (answer === undefined || answer.decision !== undefined)) await askSettled($, key).catch(() => undefined)
    }
  })

  on('tool.call', async ($, e, next) => {
    let tool = ''
    let text = ''
    try {
      tool = String(e.tool)
      text = tool
      text = toolLine(tool, e)
    } catch {}
    // The lead messages an ended agent (the crew's fix loop): its next round is a new job. Marked before the call, as the
    // resumed agent may step before the call returns. A `to` that is the Agent call's `name` matches no card id: that
    // resume stays in the job it continues.
    let messaged: string | undefined
    try {
      const to = (e as unknown as { to?: unknown }).to
      if (!e.agentId && tool === 'SendMessage' && typeof to === 'string' && (await getCards($)).some(c => c.id === to)) {
        messaged = to
        await update($, agentsAtom, list => agentMessaged(cardsOf(list), to))
      }
    } catch {}
    try {
      await toolStarted($, e.agentId, text)
    } catch {}
    // A message that was not sent (refused, or the call failed) resumes nothing: the mark goes. Its own try, so a state
    // failure here neither changes the call's outcome nor skips the lines below.
    const unmark = async () => {
      const sentTo = messaged
      if (sentTo === undefined) return
      try {
        await update($, agentsAtom, list => agentMessaged(cardsOf(list), sentTo, false))
      } catch {}
    }
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } catch (error) {
      await unmark()
      throw error
    } finally {
      // The call settled (run, refused or failed): a permission ask it raised is no longer waiting.
      if (tool) await askSettled($, askKey(e.agentId, tool)).catch(() => undefined)
    }
    if (ran.deny !== undefined) await unmark()
    try {
      const wasDenied = denied.delete(e.tool_use_id)
      if (ran.deny !== undefined && !wasDenied) await toolDenied($, e.agentId, text)
      // A background agent hands its report back through this tool; a consult's report is its verdict.
      const message = (e as unknown as { message?: unknown }).message
      if (tool === 'SubagentHandback' && e.agentId && typeof message === 'string') await consultDone($, e.agentId, message)
      const path = (e as unknown as { file_path?: unknown }).file_path
      if (ran.deny === undefined && WRITE_TOOLS.has(tool) && typeof path === 'string') await planWritten($, path)
    } catch {}
    return ran
  })

  // The server advisor tool never reaches tool.call: it shows only in the main loop's assistant rows.
  on('session.append', async ($, e, next) => {
    try {
      if (!e.agentId && e.message.type === 'assistant') {
        for (const event of serverConsults(e.message.content, ADVISOR)) {
          if (event.kind === 'open') {
            if (!(await getConsults($)).some(c => c.id === event.id)) {
              await agentStarted($, { id: event.id, type: ADVISOR, description: 'advisor tool', isUntagged: true, model: '' })
            }
          } else await consultDone($, event.id, event.answer)
        }
      }
    } catch {}
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    try {
      if (!e.parentAgentId) await noteMode($, e.permissionMode)
      if (started.deny === undefined && started.agentId) {
        // The crew's hook beneath this one may have switched the type and tagged the description; it left both here.
        const routed = shared.agents.get(started.agentId)
        await agentStarted($, {
          id: started.agentId,
          type: routed?.type ?? e.subagentType,
          description: routed?.description ?? e.description,
          isUntagged: routed?.description !== undefined,
          model: started.model,
          ...(routed ? { provider: routed.provider } : {}),
        })
        await noteFavored($, routingOn())
      }
    } catch {}
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      if (!e.agentId) {
        await mainTurnDone($, e.reason, e.durationMs)
        // The plan is read again when its file changed during the turn (a subagent's turn does not trigger it).
        await refreshPlan($)
      } else await agentDone($, e.agentId, e.reason, e.answer)
    } catch {}
    return done
  })

  // Answers the command itself, so a failure must not reach commands/panel.md (the model would run it): the catch answers.
  on('command.run', { command: 'crew:panel' }, async ($, e) => ({ text: await runPanel($, cfg, e.args, e.presentation) })).catch(() => ({ text: PANEL_FAILED }))

  // The band is one instance: a tree returned without `next` keeps every plugin beneath from drawing, and a held commit
  // (branch-guard) lives there. So the summary only draws over the engine's own empty band, whatever the plugin order.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let choice: PanelChoice | null = null
    // Read before any early return: a later `set` redraws the band only for a hook that read the atom.
    try {
      choice = choiceOf(await read($, panelAtom))
    } catch {}
    if (e.props.hasSurvey || !choice?.isVisible || choice.placement !== 'prompt') return next(e)
    const below = await next(e)
    if (below.type !== 'engine') return below
    try {
      const { input, view } = await loadInput($)
      const els = hudEls($.ui.resolve(e), false)
      const band = drawBand(els, input, ctxOf(view), { ...draw, surface: e.surface, hasSurvey: e.props.hasSurvey, choice, maxRows: e.props.maxRows, bodyColumns: e.props.bodyColumns })
      return band ?? below
    } catch {
      return below
    }
  })

  // The close mark or key hides the panel for good; our own close (off, prompt) and an unload say nothing about the person.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    try {
      const after = choiceAfterClose(e.origin)
      if (after) await setChoice($, after)
    } catch {}
    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    try {
      const { input, view } = await loadInput($)
      const ctx = ctxOf(view)
      const width = Math.max(0, Math.floor(e.props.bodyColumns))
      const rows = Math.max(1, Math.floor(e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40))
      const tables = hudEls(els, draw.motion)
      if (paneForm({ layout: view.layout, placement: e.props.placement }) === 'mini') {
        // Inline the pane is a summary of at most 8 rows; docked under `layout mini` it needs no docking hint.
        return drawSummary(tables, input, ctx, { ...draw, width, form: 'mini', maxRows: Math.min(MINI_ROWS, rows), docked: e.props.placement === 'dock' })
      }
      const drawn = drawPane(tables, input, ctx, {
        ...draw,
        width,
        rows,
        surface: e.surface === 'terminal' ? 'terminal' : 'desktop',
        focus: { isFocused: e.props.isFocused, openId: view.openId },
        onOpen: id => void setView($, v => ({ ...v, openId: v.openId === id ? null : id })).catch(() => undefined),
      })
      logDrawErrors($, drawErrors, drawn.errors)
      return drawn.tree
    } catch {
      return <els.Text color="error">The crew panel could not be drawn; see the debug log.</els.Text>
    }
  })
}
