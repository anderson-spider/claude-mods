import { atom, read, update } from 'claude-code'
import type { Hook, Register, RenderElement, RenderSurface, Timer } from 'claude-code'
import type { SessionHudCard, SessionHudStep, SessionHudSteps } from '../types'
import * as roster from './panel/agents'
import { terminalLines } from './panel/cards'
import { paneModel } from './panel/model'
import { pruned, restorable, savedKey, toSave } from './panel/saved'
import { svgOf } from './panel/svg'
import type { Piece as PanePiece, Style as PaneStyle } from './panel/text'
import { EMPTY, agentBegan, agentEnded, agentStepped, agentUsed, began, cacheUsed, compactedNow, completed, located, measured, reconciled, spawned, stepped, switched, timed, tooled, touchedCache, windowed } from './card'
import { BRANCH, REV_PARSE, workspaceOf } from './workspace'
import type { Measured } from './card'
import { paint, paletteOf } from './palette'
import type { Palette } from './palette'
import { layoutView } from './layout'
import type { Drawing, Piece } from './layout'
import { HIDDEN, earnsSteps, forkPrompt, isCommand, offered, parseSteps, skillList } from './steps'

type Dollar = Parameters<Hook<'session.start'>>[0]

const card = atom({ plugin: 'session-hud', key: 'card' } as const, EMPTY)
const nowAtom = atom({ plugin: 'session-hud', key: 'now' } as const, 0)
const paletteAtom = atom({ plugin: 'session-hud', key: 'palette' } as const, 'theme' as Palette)
const stepsAtom = atom({ plugin: 'session-hud', key: 'steps' } as const, HIDDEN)
const panelAtom = atom({ plugin: 'session-hud', key: 'panel' } as const, roster.EMPTY_PANEL)
const panelNowAtom = atom({ plugin: 'session-hud', key: 'panelNow' } as const, 0)

/** The time left in a window is drawn in minutes: a tick every 30 s keeps it current without redrawing on every second. */
const TICK_MS = 30_000
/** A git reading that takes longer than this is dropped; the card keeps the last one. */
const GIT_TIMEOUT_MS = 5_000

/** The session panel's pane and command. */
const PANE = 'session-panel'
/** The narrowest pane the panel is laid out for; a narrower one truncates it. */
const PANE_MIN_COLUMNS = 20
/** The most characters an `Svg` source may hold. */
const SVG_MAX = 131_072
/** Engine forks end without a spawn, so only the latest few endings wait for one. */
const EARLY_MAX = 20

/** An agent's turn ended: why, when, and the usage its end reported. */
type Ending = { reason: string; now: number; usage?: unknown }

/**
 * What the module keeps between events: the clock's timers (the card's, the main turn's and the panel's), endings heard
 * before their spawn, the session whose saved panel was read, and the queue of panel saves.
 */
type Held = { ticker?: Timer; fast?: Timer; beat?: Timer; early: Map<string, Ending>; restoredFor?: string; saving: Promise<void> }

/** Theme keys only, so the panel follows the person's Claude Code theme. */
const PANE_PAINT: Record<PaneStyle, { color?: string; backgroundColor?: string; weight?: 'bold'; dimColor?: boolean }> = {
  plain: {},
  title: { weight: 'bold' },
  dim: { dimColor: true },
  ok: { color: 'success' },
  warn: { color: 'warning' },
  error: { color: 'error', weight: 'bold' },
  bar: { color: 'claude' },
  barEmpty: { color: 'subtle' },
  badge: { color: 'inverseText', backgroundColor: 'claude', weight: 'bold' },
}

/** A panel piece's paint: its style's, in its tone's colour when it has one. */
const panePaint = (piece: PanePiece) => (piece.tone ? { ...PANE_PAINT[piece.style], color: piece.tone, dimColor: undefined } : PANE_PAINT[piece.style])

/** The `cacheTtl` option: `5m` or `1h` names the lifetime the card draws until the host reports one; `off` or anything else leaves it to the host. Resolved at render, so a changed option (which reloads the module) shows at once and never overwrites the host's. */
const ttlOf = (value: unknown): '5m' | '1h' | undefined => (value === '5m' || value === '1h' ? value : undefined)

/** Observation never changes what the host answered: a failure is one debug line. */
async function observe($: Dollar, action: () => Promise<void>): Promise<void> {
  try { await action() } catch {
    try { $.ui.log('session-hud: observation failed', { to: 'debug' }) } catch { /* Reporting cannot change the observed result. */ }
  }
}

/** The agents the host lists as idle or ended leave the card; asked only while the card shows some. */
async function reconcile($: Dollar): Promise<void> {
  if (!(await read($, card)).agents?.length) return
  const list = await $.agent.list()
  await update($, card, current => reconciled(current, list))
}

/** Git's answer for the session's directory, or undefined when it is not a repository or git fails; read-only and lock-free. */
async function git($: Dollar, cwd: string, args: readonly string[]): Promise<string | undefined> {
  const run = await $.process.run(['git', '--no-optional-locks', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined)
  return run?.exitCode === 0 ? run.stdout : undefined
}

/** Where the session works: its directory's repository, folder and branch, read again whenever a checkout, a `cd` or a worktree move could have changed them. */
async function locate($: Dollar): Promise<void> {
  const cwd = await $.session.cwd()
  const [paths, branch] = await Promise.all([git($, cwd, REV_PARSE), git($, cwd, BRANCH)])
  await update($, card, current => located(current, workspaceOf(cwd, paths, branch)))
}

function ensureTicker($: Dollar, held: Held): void {
  if (held.ticker) return
  held.ticker = $.clock.every(TICK_MS, () => {
    void observe($, async () => { const time = await $.clock.now(); await update($, nowAtom, () => time) })
    void observe($, () => reconcile($))
    void observe($, () => settle($, held, false))
    // A checkout made outside the session (another terminal, an IDE) raises no event; the tick catches it.
    void observe($, () => locate($))
  })
}

/** While a main-session turn runs its time is drawn in seconds, so the clock beats every second until it ends. */
function startFast($: Dollar, held: Held): void {
  if (held.fast) return
  held.fast = $.clock.every(1_000, () => { void observe($, async () => { const time = await $.clock.now(); await update($, nowAtom, () => time) }) })
}
function stopFast(held: Held): void {
  held.fast?.cancel()
  held.fast = undefined
}

/** The window the host compacts against, from a locally estimated breakdown (no request): the model's or a smaller `autoCompactWindow`. */
async function readWindow($: Dollar): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  await update($, card, current => windowed(current, usage.context.breakdown?.rawMaxTokens))
}

/** The session's figures: its model, the usage the status line has, the theme and the clock. The card the state holds stays: at the first load it is empty, and a reload (an option change runs `session.start` again) keeps what the session observed, which no event would bring back. */
async function prime($: Dollar, held: Held): Promise<void> {
  const [model, usage, time] = await Promise.all([$.session.model(), $.session.usage(), $.clock.now()])
  const primed = await update($, card, current => ({ ...measured(current, usage as Measured), model }))
  // A reload during a main-session turn starts the one-second clock the turn had.
  if (primed.turnStartedAt !== undefined) startFast($, held)
  await update($, nowAtom, () => time)
  const theme = await $.config.list().then(rows => rows.find(row => row.key === 'theme')?.value, () => undefined)
  await update($, paletteAtom, () => paletteOf(theme))
  await readWindow($)
}

/**
 * Asks a fork of the session, which shares its prompt cache, for the likely next prompts after the main turn `turnId`,
 * handing it the session's skills and slash commands; the steps are offered only if no other turn started meanwhile.
 */
async function suggest($: Dollar, turnId: string): Promise<void> {
  await update($, stepsAtom, (): SessionHudSteps => ({ kind: 'loading', turnId }))
  let found: SessionHudStep[] = []
  try {
    // Without the list the fork still suggests; slash prompts then go unchecked.
    const commands = await $.command.list().catch(() => null)
    const known = commands === null ? null : new Set(commands.map(command => command.name))
    const reply = await $.model.fork({ prompt: forkPrompt(commands === null ? '' : skillList(commands)) })
    found = reply.isAnswered ? parseSteps(reply.text, known) : []
  } finally {
    const shown = await update($, stepsAtom, current => offered(current, turnId, found))
    const first = shown.kind === 'offer' ? shown.steps[0] : undefined
    if (first) void $.prompt.suggest({ text: first.prompt }).catch(() => undefined)
  }
}

/** Puts step `i` in the prompt box as a draft, never sent; where the surface draws its own composer, on the clipboard. */
async function fill($: Dollar, surface: RenderSurface, i: number): Promise<void> {
  const current = await read($, stepsAtom)
  const text = current.kind === 'offer' ? current.steps[i]?.prompt ?? '' : ''
  if (text === '') return
  const filled = await $.prompt.fill({ text })
  if (!filled.isFilled) {
    if (filled.refusal !== 'no_composer') return $.ui.toast('The prompt box is busy; try again')
    const copied = await $.ui.copy({ text, surface })
    if (!copied.isCopied) return $.ui.toast('Could not put the step in the prompt')
    $.ui.toast('Copied; paste it into the prompt')
  }
  await update($, stepsAtom, () => HIDDEN)
}

/** The panel's durations, spinners and timeline move once a second, only while an agent or a main turn runs. */
function ensureBeat($: Dollar, held: Held): void {
  if (held.beat) return
  held.beat = $.clock.every(1_000, () => void observe($, async () => {
    const [panel, shown] = await Promise.all([read($, panelAtom), read($, card)])
    if (!panel.agents.some(agent => agent.status === 'running') && shown.turnStartedAt === undefined) return
    const time = await $.clock.now()
    await update($, panelNowAtom, () => time)
  }))
}

/**
 * The panel written to the store under this session, or its entry removed once empty. Saves run one after another,
 * each reading the panel when its turn comes, so a slow one never writes back what a later change replaced.
 */
function savePanel($: Dollar, held: Held): Promise<void> {
  const save = async () => {
    const [id, panel, now] = await Promise.all([$.session.id(), read($, panelAtom), $.clock.now()])
    const saved = toSave(panel, now)
    if (saved) await $.store.set(savedKey(id), saved)
    else await $.store.delete(savedKey(id))
  }
  held.saving = held.saving.then(save, save)
  return held.saving
}

/**
 * Once per session id: with an empty panel in memory, the one the store kept for this session (a restarted app, a
 * resumed session) comes back, its agents the host no longer runs ended; then stale and surplus entries are pruned.
 */
async function restorePanel($: Dollar, held: Held): Promise<void> {
  const id = await $.session.id()
  if (held.restoredFor === id) return
  const now = await $.clock.now()
  const current = await read($, panelAtom)
  if (!current.agents.length && !current.main.turns.length) {
    const panel = restorable(await $.store.get(savedKey(id)), now)
    if (panel) await update($, panelAtom, kept => (kept.agents.length || kept.main.turns.length ? kept : panel))
  }
  // Marked once read, so a failed read is tried again on the next chance.
  held.restoredFor = id
  await settle($, held, true)
  const keys = await $.store.keys()
  const entries = await Promise.all(keys.map(async key => [key, await $.store.get(key)] as [string, unknown]))
  for (const key of pruned(entries, now)) await $.store.delete(key)
}

/** A tracked agent's turn ended: its row ends and the panel is saved. */
async function endAgent($: Dollar, held: Held, agentId: string, ending: Ending): Promise<void> {
  await update($, panelAtom, panel => ({ ...panel, agents: roster.agentEnded(panel.agents, agentId, ending.reason, ending.now, ending.usage) }))
  await savePanel($, held)
}

/** The running agents the host lists as stopped end; with `unlisted` (a reload or a restore), so do the ones it no longer lists. */
async function settle($: Dollar, held: Held, unlisted: boolean): Promise<void> {
  if (!(await read($, panelAtom)).agents.some(agent => agent.status === 'running')) return
  const [list, now] = await Promise.all([$.agent.list(), $.clock.now()])
  for (const ending of roster.endingsOf((await read($, panelAtom)).agents, list, unlisted)) await endAgent($, held, ending.agentId, { reason: ending.reason, now })
}

/** `/session-panel clear`: the agents and the main session's figures forgotten, and this session's saved panel removed. */
async function clearPanel($: Dollar, held: Held): Promise<string> {
  held.early.clear()
  held.restoredFor = await $.session.id()
  await update($, panelAtom, () => roster.EMPTY_PANEL)
  await savePanel($, held)
  return 'Session panel cleared: its agents and turns are forgotten.'
}

async function openPane($: Dollar): Promise<string> {
  const opened = await $.ui.open({ id: PANE, title: 'Session panel', focus: true })
  return opened.isPlaced ? 'Session panel open.' : `The session panel waits for room: ${opened.reason}`
}

async function closePane($: Dollar): Promise<string> {
  await $.ui.close({ id: PANE })
  return 'Session panel closed.'
}

async function togglePane($: Dollar): Promise<string> {
  return (await $.ui.panes()).some(pane => pane.id === PANE) ? closePane($) : openPane($)
}

/** The panel's part of a session start: its command, the clock and the saved panel. A reload keeps the state the host holds. */
async function startPanel($: Dollar, held: Held): Promise<void> {
  await $.command.register({ name: PANE, description: 'Toggle the session panel (open or close it), or clear what it shows', argumentHint: '[open|close|clear]' })
  ensureBeat($, held)
  const time = await $.clock.now()
  await update($, panelNowAtom, () => time)
  await restorePanel($, held)
}

/** A spawned agent joins the panel, or a resumed one runs again; an ending heard before this start applies once it runs. */
async function trackSpawn($: Dollar, held: Held, agentId: string, type: string | undefined, model: string | undefined, resume: boolean): Promise<void> {
  const now = await $.clock.now()
  await update($, panelAtom, panel => ({
    ...panel,
    agents: resume && panel.agents.some(agent => agent.id === agentId) ? roster.resumed(panel.agents, agentId) : roster.spawned(panel.agents, { agentId, type, model, now }),
  }))
  ensureBeat($, held)
  await update($, panelNowAtom, () => now)
  const early = held.early.get(agentId)
  held.early.delete(agentId)
  // An ending heard before this start belongs to an earlier turn of the agent.
  if (early && early.now >= now) return endAgent($, held, agentId, early)
  await savePanel($, held)
}

/** An agent's turn ended: a running row ends; else the ending waits for the spawn, which the host may answer after it. */
async function agentDone($: Dollar, held: Held, agentId: string, ending: Ending): Promise<void> {
  if ((await read($, panelAtom)).agents.some(agent => agent.id === agentId && agent.status === 'running')) return endAgent($, held, agentId, ending)
  held.early.set(agentId, ending)
  for (const id of held.early.keys()) if (held.early.size > EARLY_MAX) held.early.delete(id)
}

/** A main turn ended: its span joins the timeline, a resume in this process brings its saved panel back, and the panel is saved. */
async function mainDone($: Dollar, held: Held, durationMs: unknown): Promise<void> {
  const now = await $.clock.now()
  await restorePanel($, held)
  await update($, panelAtom, panel => ({ ...panel, main: roster.mainTurned(panel.main, now, durationMs) }))
  await update($, panelNowAtom, () => now)
  await savePanel($, held)
  await settle($, held, false)
}

export const register: Register = (on, options) => {
  const held: Held = { early: new Map(), saving: Promise.resolve() }
  const ttl = ttlOf((options as Record<string, unknown> | undefined)?.cacheTtl)
  // Off unless set to true: a fork after every main turn costs about one short reply.
  const suggests = (options as Record<string, unknown> | undefined)?.nextSteps === true

  on('session.start', {}, async ($, e, next) => {
    const started = await next(e)
    void observe($, async () => { ensureTicker($, held); await prime($, held) })
    void observe($, () => locate($))
    void observe($, () => startPanel($, held))
    return started
  })
  // A /clear or a resume empties the panel; a resume brings its own saved panel back on the next main turn's end.
  on('session.end', {}, ($, e, next) => {
    held.ticker?.cancel()
    held.ticker = undefined
    stopFast(held)
    held.early.clear()
    held.restoredFor = undefined
    void observe($, async () => { await update($, panelAtom, () => roster.EMPTY_PANEL) })
    return next(e)
  })
  on('session.measure', {}, ($, e, next) => {
    void observe($, async () => {
      ensureTicker($, held)
      const time = await $.clock.now()
      await update($, card, current => measured(current, e as Measured))
      await update($, nowAtom, () => time)
    })
    return next(e)
  })
  // A main-session turn: it starts the clock and its context afresh. A subagent's or teammate's turn: it runs.
  on('turn.start', {}, async ($, e, next) => {
    if (e.agentId !== undefined) {
      void observe($, async () => { await update($, card, current => agentBegan(current, e.agentId)) })
      return next(e)
    }
    // A new turn makes the steps stale, and drops a fork still answering.
    void observe($, async () => { await update($, stepsAtom, () => HIDDEN) })
    // The context is cleared before the clock is read, so a step that lands meanwhile is not wiped.
    void observe($, async () => {
      await update($, card, current => began(current))
      const time = await $.clock.now()
      await update($, card, current => timed(current, time))
      await update($, nowAtom, () => time)
      startFast($, held)
    })
    return next(e)
  })
  on('turn.step', {}, async function* ($, e, next) {
    const answer = yield* next(e)
    // The step lands before the clock is read, so the turn's completion cannot overtake it.
    if (e.agentId === undefined) {
      void observe($, async () => {
        await update($, card, current => stepped(current, e.effort, answer.usage))
        if (!touchedCache(answer.usage)) return
        const time = await $.clock.now()
        await update($, card, current => cacheUsed(current, time))
      })
      void observe($, async () => { await update($, panelAtom, panel => ({ ...panel, main: roster.mainStepped(panel.main, answer.usage) })) })
    } else {
      // Every agent step counts toward the agents' total, a step of an agent the card does not show included.
      void observe($, async () => { await update($, card, current => agentUsed(agentStepped(current, e.agentId, typeof answer.usage?.model === 'string' ? answer.usage.model : e.model, e.effort), answer.usage)) })
      const agentId = e.agentId
      void observe($, async () => {
        await update($, panelAtom, panel => ({ ...panel, agents: roster.agentStepped(panel.agents, agentId, { model: e.model, ...(typeof e.effort === 'string' ? { effort: e.effort } : {}), usage: answer.usage }) }))
      })
    }
    return answer
  })
  on('turn.complete', {}, ($, e, next) => {
    if (e.agentId === undefined) {
      stopFast(held)
      void observe($, async () => { await update($, card, current => completed(current, e.durationMs)) })
      void observe($, () => reconcile($))
      // The turn may have checked out a branch or entered a worktree.
      void observe($, () => locate($))
      void observe($, () => mainDone($, held, e.durationMs))
    } else {
      const agentId = e.agentId
      void observe($, async () => { await update($, card, current => agentEnded(current, agentId)) })
      void observe($, async () => agentDone($, held, agentId, { reason: e.reason, now: await $.clock.now(), usage: (e as { usage?: unknown }).usage }))
    }
    return next(e)
  })
  // A main turn that ends in a full answer asks the fork for next steps, detached, so the completion never waits on it.
  on('turn.complete', {}, async ($, e, next) => {
    const result = await next(e)
    if (suggests && e.agentId === undefined && earnsSteps(e.reason, e.answer)) void observe($, () => suggest($, e.turnId))
    return result
  })
  // A started agent runs on the model the spawn answers, as the type it asked for; the answer passes unchanged, and a refused spawn or one with no `agentId` is not tracked.
  // The input names no remote run: a remote workflow agent (internal builds only) that answers with an id stays until a list shows it ended.
  on('agent.spawn', {}, async ($, e, next) => {
    const result = await next(e)
    if (!result.deny && result.agentId !== undefined) {
      const agentId = result.agentId
      void observe($, async () => { await update($, card, current => spawned(current, agentId, result.model, e.subagentType)) })
      void observe($, () => trackSpawn($, held, agentId, e.subagentType, result.model, e.resume !== undefined))
    }
    return result
  })
  // After the result, which goes on exactly as it came: the main session's successful edits and its errors are counted,
  // and a subagent's call is its activity in the panel, a refusal or an error counted as failed.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const tool = (e as { tool?: unknown }).tool
    if (!e.agentId) void observe($, async () => { await update($, card, current => tooled(current, tool, result)) })
    else if (typeof tool === 'string') {
      const agentId = e.agentId
      const failed = result.deny !== undefined || result.isError === true
      void observe($, async () => { await update($, panelAtom, panel => ({ ...panel, agents: roster.toolUsed(panel.agents, agentId, tool, failed) })) })
    }
    return result
  })
  on('command.run', { command: PANE }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === '') return { text: await togglePane($) }
    if (arg === 'open') return { text: await openPane($) }
    if (arg === 'close') return { text: await closePane($) }
    if (arg === 'clear') return { text: await clearPanel($, held) }
    return { text: 'Usage: /session-panel [open|close|clear]' }
  })
  // Reads prepared atoms only; a failure draws one dim line instead of failing the pane.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    try {
      const [panel, shown, now] = await Promise.all([read($, panelAtom), read($, card), read($, panelNowAtom)])
      const ui = $.ui.resolve(e)
      const { Box, Text } = ui
      const columns = Math.max(PANE_MIN_COLUMNS, e.props.bodyColumns)
      const model = paneModel({ panel, card: shown, columns, now: now || (await $.clock.now()), frame: Math.floor(now / 1000), rows: e.props.scroll.bodyRows })
      // Lines are laid out in cells (the borders, the timeline's buckets): `mono` keeps them aligned on a surface whose
      // body font is proportional, as the desktop's is; the terminal ignores it.
      const text = (line: PanePiece[], key: string) => <Text key={key} mono wrap="truncate-end">{line.length ? line.map((piece, i) => <Text key={`${key}-${i}`} {...panePaint(piece)}>{piece.text}</Text>) : ' '}</Text>
      const lines = () => <Box flexDirection="column" width={columns}>{terminalLines(model, columns).map((line, i) => text(line, `line-${i}`))}</Box>
      // Only a graphical surface draws the cards as a picture; the terminal, which has no `Svg`, draws them as lines.
      if (e.surface === 'terminal' || !('Svg' in ui)) return lines()
      const drawing = svgOf(model, columns)
      // A drawing past the host's limit falls back to the terminal's lines.
      if (drawing.source.length > SVG_MAX) return lines()
      return <Box flexDirection="column" width={columns} gap={1}>
        {text(model.header, 'header')}
        <ui.Svg key="cards" source={drawing.source} alt="Session panel" {...(drawing.moving ? { isInteractive: true } : {})} />
        {text(model.footer, 'footer')}
      </Box>
    } catch {
      $.ui.log('session-hud: panel render failed', { to: 'debug' })
      return { type: 'Text', props: { dimColor: true }, children: ['?'] } satisfies RenderElement
    }
  })
  // A model switch is the only event that names the prompt cache's lifetime, and a switch to another model loses the cache; the switch passes unchanged.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    void observe($, async () => { await update($, card, current => switched(current, e.cache_ttl, e.from_model, e.to_model)) })
    return result
  })
  // A main-session compaction marks the turn it comes before (or during) in the history; a subagent's (`agent_id`) does not; the event passes unchanged.
  on('classic.PostCompact', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id === undefined) void observe($, async () => { await update($, card, current => compactedNow(current)) })
    return result
  })
  // A directory change (`/cd`, a worktree move) moves the workspace; the event passes unchanged.
  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    void observe($, () => locate($))
    return result
  })
  // A theme change repaints the card; the change itself is the person's and passes unchanged.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (!result.deny) await observe($, async () => { await update($, paletteAtom, () => paletteOf(result.value)) })
    return result
  })
  // A setting or a model change can move the window the host compacts at: it is read again after any change that took.
  on('config.set', async ($, e, next) => {
    const result = await next(e)
    if (!result.deny) void observe($, () => readWindow($))
    return result
  })
  // Reads prepared atoms only, never a host; a survey keeps the band, and a failure draws nothing of ours. What draws
  // beneath (another plugin's band) is always asked and kept under the card, never replaced by it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    try {
      const [shown, time, palette, steps] = await Promise.all([read($, card), read($, nowAtom), read($, paletteAtom), read($, stepsAtom)])
      const terminal = e.surface === 'terminal'
      const drawnCard = (shown.cacheTtl === undefined && ttl ? { ...shown, cacheTtl: ttl } : shown) as SessionHudCard
      // The card's own turn says it is the main session's; the host's `isWorking` drops one whose completion never reached the card.
      const working = shown.turnStartedAt !== undefined && e.props.isWorking
      const lines = layoutView({ card: drawnCard, now: time, working, palette, draw: terminal ? 'cells' : 'svg' })
      if (!lines.length) return below
      const ui = $.ui.resolve(e)
      const { Box, Text, Button } = ui
      // Only a graphical surface gets drawings; the terminal, which has no `Svg`, draws its bars as text.
      const drawing = (part: Drawing, key: string) => ('Svg' in ui ? <ui.Svg key={key} source={part.source} alt={part.alt} width={part.width} height={part.height} /> : null)
      // In a terminal too narrow for a whole group, the group shrinks and its text is cut at the edge instead of breaking the frame.
      const piece = (part: Piece, key: string) => ('text' in part
        ? <Text key={key} {...paint(palette, part.style)} {...(terminal ? { wrap: 'truncate-end' as const } : {})}>{part.text}</Text>
        : drawing(part, key))
      // The next steps under the card's lines: a digit (from an empty prompt box) puts its step in the prompt box, 0
      // dismisses. A slash command is drawn in the sent colour, apart from a prompt in prose.
      const stepsSection = () => {
        if (steps.kind === 'hidden') return null
        const head = <Text key="steps-head" {...paint(palette, 'secondary')}>{steps.kind === 'loading' ? 'next steps…' : 'next steps'}</Text>
        if (steps.kind === 'loading') return <Box key="steps" flexDirection="column" marginTop={1}>{head}</Box>
        const row = (step: SessionHudStep, i: number) =>
          <Button key={`step-${i}`} hotkey={String(i + 1)} plain onPress={() => fill($, e.surface, i)}>
            <Text {...paint(palette, isCommand(step) ? 'sent' : 'secondary')}>{`${i + 1}. ${step.label}`}</Text>
          </Button>
        const half = Math.ceil(steps.steps.length / 2)
        return <Box key="steps" flexDirection="column" marginTop={1}>
          {head}
          <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
            <Box flexDirection="column">{steps.steps.slice(0, half).map((step, i) => row(step, i))}</Box>
            <Box flexDirection="column">{steps.steps.slice(half).map((step, i) => row(step, i + half))}</Box>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
            <Text key="steps-hint" {...paint(palette, 'secondary')}>1–{steps.steps.length} puts one in the prompt</Text>
            <Button key="steps-dismiss" hotkey="0" plain dimColor label="dismiss" onPress={() => update($, stepsAtom, () => HIDDEN)} />
          </Box>
        </Box>
      }
      // Each group wraps to the next row whole, so a narrow card breaks between parts, never inside one.
      const drawn = <Box {...(terminal ? { width: e.props.bodyColumns } : {})} flexDirection="column" borderStyle="round" borderColor={paint(palette, 'frame').color ?? 'inactive'} paddingX={1}>
        {lines.map((groups, at) => <Box key={`line-${at}`} flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={3} marginTop={at === lines.length - 1 && at > 0 ? 1 : 0}>
          {groups.map((group, i) => group === 'spacer'
            ? <Box key={`g-${i}`} flexGrow={1} />
            : <Box key={`g-${i}`} flexDirection="row" alignItems="center" flexShrink={terminal ? 1 : 0}>{group.map((part, j) => piece(part, `p-${i}-${j}`))}</Box>)}
        </Box>)}
        {e.props.isWorking ? null : stepsSection()}
      </Box>
      return <Box flexDirection="column">{drawn}{below}</Box>
    } catch {
      $.ui.log('session-hud: render failed', { to: 'debug' })
      return below
    }
  })
}
