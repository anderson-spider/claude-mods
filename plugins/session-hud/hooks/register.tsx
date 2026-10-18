import { atom, read, update } from 'claude-code'
import type { Hook, Register, Timer } from 'claude-code'
import type { SessionHudCard } from '../types'
import { EMPTY, agentBegan, agentEnded, agentStepped, agentUsed, began, cacheUsed, compactedNow, completed, measured, reconciled, spawned, stepped, switched, timed, tooled, touchedCache, windowed } from './card'
import type { Measured } from './card'
import { paint, paletteOf } from './palette'
import type { Palette } from './palette'
import { layoutView } from './layout'
import type { Drawing, Piece } from './layout'

type Dollar = Parameters<Hook<'session.start'>>[0]

const card = atom({ plugin: 'session-hud', key: 'card' } as const, EMPTY)
const nowAtom = atom({ plugin: 'session-hud', key: 'now' } as const, 0)
const paletteAtom = atom({ plugin: 'session-hud', key: 'palette' } as const, 'theme' as Palette)

/** The time left in a window is drawn in minutes: a tick every 30 s keeps it current without redrawing on every second. */
const TICK_MS = 30_000

/** What the module keeps between events: the clock's timers. */
type Held = { ticker?: Timer; fast?: Timer }

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

function ensureTicker($: Dollar, held: Held): void {
  if (held.ticker) return
  held.ticker = $.clock.every(TICK_MS, () => {
    void observe($, async () => { const time = await $.clock.now(); await update($, nowAtom, () => time) })
    void observe($, () => reconcile($))
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

export const register: Register = (on, options) => {
  const held: Held = {}
  const ttl = ttlOf((options as Record<string, unknown> | undefined)?.cacheTtl)

  on('session.start', {}, async ($, e, next) => {
    const started = await next(e)
    void observe($, async () => { ensureTicker($, held); await prime($, held) })
    return started
  })
  on('session.end', {}, (_$, e, next) => {
    held.ticker?.cancel()
    held.ticker = undefined
    stopFast(held)
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
    }
    // Every agent step counts toward the agents' total, a step of an agent the card does not show included.
    else void observe($, async () => { await update($, card, current => agentUsed(agentStepped(current, e.agentId, typeof answer.usage?.model === 'string' ? answer.usage.model : e.model, e.effort), answer.usage)) })
    return answer
  })
  on('turn.complete', {}, ($, e, next) => {
    if (e.agentId === undefined) {
      stopFast(held)
      void observe($, async () => { await update($, card, current => completed(current, e.durationMs)) })
      void observe($, () => reconcile($))
    } else void observe($, async () => { await update($, card, current => agentEnded(current, e.agentId)) })
    return next(e)
  })
  // A started agent runs on the model the spawn answers, as the type it asked for; the answer passes unchanged, and a refused spawn or one with no `agentId` is not tracked.
  // The input names no remote run: a remote workflow agent (internal builds only) that answers with an id stays until a list shows it ended.
  on('agent.spawn', {}, async ($, e, next) => {
    const result = await next(e)
    if (!result.deny && result.agentId !== undefined) void observe($, async () => { await update($, card, current => spawned(current, result.agentId, result.model, e.subagentType)) })
    return result
  })
  // After the result, which goes on exactly as it came: the main session's successful edits and its errors are counted.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) void observe($, async () => { await update($, card, current => tooled(current, (e as { tool?: unknown }).tool, result)) })
    return result
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
      const [shown, time, palette] = await Promise.all([read($, card), read($, nowAtom), read($, paletteAtom)])
      const terminal = e.surface === 'terminal'
      const drawnCard = (shown.cacheTtl === undefined && ttl ? { ...shown, cacheTtl: ttl } : shown) as SessionHudCard
      const lines = layoutView({ card: drawnCard, now: time, working: shown.turnStartedAt !== undefined, palette, draw: terminal ? 'cells' : 'svg' })
      if (!lines.length) return below
      const ui = $.ui.resolve(e)
      const { Box, Text } = ui
      // Only a graphical surface gets drawings; the terminal, which has no `Svg`, draws its bars as text.
      const drawing = (part: Drawing, key: string) => ('Svg' in ui ? <ui.Svg key={key} source={part.source} alt={part.alt} width={part.width} height={part.height} /> : null)
      // In a terminal too narrow for a whole group, the group shrinks and its text is cut at the edge instead of breaking the frame.
      const piece = (part: Piece, key: string) => ('text' in part
        ? <Text key={key} {...paint(palette, part.style)} {...(terminal ? { wrap: 'truncate-end' as const } : {})}>{part.text}</Text>
        : drawing(part, key))
      // Each group wraps to the next row whole, so a narrow card breaks between parts, never inside one.
      const drawn = <Box {...(terminal ? { width: e.props.bodyColumns } : {})} flexDirection="column" borderStyle="round" borderColor={paint(palette, 'frame').color ?? 'inactive'} paddingX={1}>
        {lines.map((groups, at) => <Box key={`line-${at}`} flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={3} marginTop={at === lines.length - 1 && at > 0 ? 1 : 0}>
          {groups.map((group, i) => group === 'spacer'
            ? <Box key={`g-${i}`} flexGrow={1} />
            : <Box key={`g-${i}`} flexDirection="row" alignItems="center" flexShrink={terminal ? 1 : 0}>{group.map((part, j) => piece(part, `p-${i}-${j}`))}</Box>)}
        </Box>)}
      </Box>
      return <Box flexDirection="column">{drawn}{below}</Box>
    } catch {
      $.ui.log('session-hud: render failed', { to: 'debug' })
      return below
    }
  })
}
