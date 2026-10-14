import { atom, read, update } from 'claude-code'
import type { Hook, Register, Timer } from 'claude-code'
import type { SessionHudCard } from '../types'
import { EMPTY, began, completed, measured, stepped, tooled, windowed } from './card'
import type { Measured } from './card'
import { paint, paletteOf } from './palette'
import type { Palette } from './palette'
import { cardView } from './view'
import type { Segment } from './view'

type Dollar = Parameters<Hook<'session.start'>>[0]

const card = atom({ plugin: 'session-hud', key: 'card' } as const, EMPTY)
const nowAtom = atom({ plugin: 'session-hud', key: 'now' } as const, 0)
const paletteAtom = atom({ plugin: 'session-hud', key: 'palette' } as const, 'theme' as Palette)

/** The time left in a window is drawn in minutes: a tick every 30 s keeps it current without redrawing on every second. */
const TICK_MS = 30_000

/** What the module keeps between events: the clock's timers and the cost when the main session's turn began. */
type Held = { ticker?: Timer; fast?: Timer; baseline?: number }

/** Observation never changes what the host answered: a failure is one debug line. */
async function observe($: Dollar, action: () => Promise<void>): Promise<void> {
  try { await action() } catch {
    try { $.ui.log('session-hud: observation failed', { to: 'debug' }) } catch { /* Reporting cannot change the observed result. */ }
  }
}

function ensureTicker($: Dollar, held: Held): void {
  if (held.ticker) return
  held.ticker = $.clock.every(TICK_MS, () => { void observe($, async () => { const time = await $.clock.now(); await update($, nowAtom, () => time) }) })
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

/** The session's first figures: its model, the usage the status line has, the theme and the clock. */
async function prime($: Dollar, held: Held): Promise<void> {
  const [model, usage, time] = await Promise.all([$.session.model(), $.session.usage(), $.clock.now()])
  await update($, card, () => ({ ...measured(EMPTY, usage as Measured, undefined), model }))
  held.baseline = usage.cost?.usd
  await update($, nowAtom, () => time)
  const theme = await $.config.list().then(rows => rows.find(row => row.key === 'theme')?.value, () => undefined)
  await update($, paletteAtom, () => paletteOf(theme))
  await readWindow($)
}

export const register: Register = on => {
  const held: Held = {}

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
      await update($, card, current => measured(current, e as Measured, held.baseline))
      await update($, nowAtom, () => time)
    })
    return next(e)
  })
  // A main-session turn: its cost is what the session spent since it began.
  on('turn.start', {}, async ($, e, next) => {
    void observe($, async () => {
      held.baseline = (await read($, card)).cost
      const time = await $.clock.now()
      await update($, card, current => began(current, time))
      await update($, nowAtom, () => time)
      startFast($, held)
    })
    return next(e)
  })
  on('turn.step', {}, async function* ($, e, next) {
    const answer = yield* next(e)
    if (!e.agentId) void observe($, async () => { await update($, card, current => stepped(current, e.effort, answer.usage)) })
    return answer
  })
  on('turn.complete', {}, ($, e, next) => {
    if (!e.agentId) {
      stopFast(held)
      void observe($, async () => { await update($, card, current => completed(current, e.durationMs)) })
    }
    return next(e)
  })
  // After the result, which goes on exactly as it came: the main session's successful edits and its errors are counted.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) void observe($, async () => { await update($, card, current => tooled(current, (e as { tool?: unknown }).tool, result)) })
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
  // Reads prepared atoms only, never a host; a survey keeps the band, and a failure draws nothing of ours.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    try {
      const [shown, time, palette] = await Promise.all([read($, card), read($, nowAtom), read($, paletteAtom)])
      const columns = e.props.bodyColumns
      const view = cardView({ card: shown as SessionHudCard, now: time, columns, working: shown.turnStartedAt !== undefined })
      if (!view.top.length && !view.bottom.length) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      const line = (row: Segment[], key: string) => <Text key={key} wrap="truncate">{row.map((part, at) =>
        <Text key={`${key}-${at}`} {...paint(palette, part.style)}>{part.text}</Text>)}</Text>
      return <Box width={columns} flexDirection="column" borderStyle="round" borderColor={paint(palette, 'frame').color ?? 'inactive'} paddingX={1}>
        {view.top.map((row, at) => line(row, `top-${at}`))}
        <Text key="rule" {...paint(palette, 'track')}>{'─'.repeat(Math.max(0, columns - 4))}</Text>
        {view.bottom.map((row, at) => line(row, `bottom-${at}`))}
      </Box>
    } catch {
      $.ui.log('session-hud: render failed', { to: 'debug' })
      return next(e)
    }
  })
}
