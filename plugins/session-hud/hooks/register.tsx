import { atom, read, update } from 'claude-code'
import type { Hook, Register, Timer } from 'claude-code'
import type { SessionHudCard } from '../types'
import { EMPTY, agentBegan, agentEnded, agentStepped, began, completed, measured, reconciled, spawned, stepped, tooled, ttlSet, windowed } from './card'
import type { Measured } from './card'
import { paint, paletteOf } from './palette'
import type { Palette } from './palette'
import { desktopView } from './desktop'
import { cardView } from './view'
import type { Segment } from './view'

type Dollar = Parameters<Hook<'session.start'>>[0]

const card = atom({ plugin: 'session-hud', key: 'card' } as const, EMPTY)
const nowAtom = atom({ plugin: 'session-hud', key: 'now' } as const, 0)
const paletteAtom = atom({ plugin: 'session-hud', key: 'palette' } as const, 'theme' as Palette)

/** The time left in a window is drawn in minutes: a tick every 30 s keeps it current without redrawing on every second. */
const TICK_MS = 30_000

/** What the module keeps between events: the clock's timers. */
type Held = { ticker?: Timer; fast?: Timer }

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

/** The session's first figures: its model, the usage the status line has, the theme and the clock. */
async function prime($: Dollar): Promise<void> {
  const [model, usage, time] = await Promise.all([$.session.model(), $.session.usage(), $.clock.now()])
  await update($, card, () => ({ ...measured(EMPTY, usage as Measured), model }))
  await update($, nowAtom, () => time)
  const theme = await $.config.list().then(rows => rows.find(row => row.key === 'theme')?.value, () => undefined)
  await update($, paletteAtom, () => paletteOf(theme))
  await readWindow($)
}

export const register: Register = on => {
  const held: Held = {}

  on('session.start', {}, async ($, e, next) => {
    const started = await next(e)
    void observe($, async () => { ensureTicker($, held); await prime($) })
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
    void observe($, async () => {
      const time = await $.clock.now()
      await update($, card, current => began(current, time))
      await update($, nowAtom, () => time)
      startFast($, held)
    })
    return next(e)
  })
  on('turn.step', {}, async function* ($, e, next) {
    const answer = yield* next(e)
    if (e.agentId === undefined) void observe($, async () => { const time = await $.clock.now(); await update($, card, current => stepped(current, e.effort, answer.usage, time)) })
    else void observe($, async () => { await update($, card, current => agentStepped(current, e.agentId, typeof answer.usage?.model === 'string' ? answer.usage.model : e.model)) })
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
  // A started agent runs on the model the spawn answers; the answer passes unchanged, and a refused spawn or one with no `agentId` is not tracked.
  // The input names no remote run: a remote workflow agent (internal builds only) that answers with an id stays until a list shows it ended.
  on('agent.spawn', {}, async ($, e, next) => {
    const result = await next(e)
    if (!result.deny && result.agentId !== undefined) void observe($, async () => { await update($, card, current => spawned(current, result.agentId, result.model)) })
    return result
  })
  // After the result, which goes on exactly as it came: the main session's successful edits and its errors are counted.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) void observe($, async () => { await update($, card, current => tooled(current, (e as { tool?: unknown }).tool, result)) })
    return result
  })
  // A model switch is the only event that names the prompt cache's lifetime; the switch itself passes unchanged.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    void observe($, async () => { await update($, card, current => ttlSet(current, e.cache_ttl)) })
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
      const working = shown.turnStartedAt !== undefined
      if (e.surface !== 'terminal') {
        const lines = desktopView({ card: shown as SessionHudCard, now: time, working, palette })
        if (!lines.length) return next(e)
        const { Box, Text, Svg } = $.ui.resolve(e)
        return <Box flexDirection="column" borderStyle="round" borderColor={paint(palette, 'frame').color ?? 'inactive'} paddingX={1} rowGap={0}>
          {lines.map((pieces, at) => <Box key={`line-${at}`} flexDirection="row" alignItems="center" marginTop={at === lines.length - 1 && at > 0 ? 1 : 0}>
            {pieces.map((piece, i) => 'text' in piece
              ? <Text key={`p-${i}`} {...paint(palette, piece.style)}>{piece.text}</Text>
              : piece.kind === 'svg'
                ? <Svg key={`p-${i}`} source={piece.source} alt={piece.alt} width={piece.width} height={piece.height} />
                : <Box key={`p-${i}`} flexGrow={1} />)}
          </Box>)}
        </Box>
      }
      const view = cardView({ card: shown as SessionHudCard, now: time, columns, working })
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
