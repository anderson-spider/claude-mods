import { atom, read, update } from 'claude-code'
import type { Hook, Register, Timer } from 'claude-code'
import type { SessionHudCard, SessionHudStep, SessionHudSteps } from '../types'
import { EMPTY, agentBegan, agentEnded, agentStepped, agentUsed, began, cacheUsed, compactedNow, completed, located, measured, reconciled, spawned, stepped, switched, timed, tooled, touchedCache, windowed } from './card'
import { BRANCH, REV_PARSE, workspaceOf } from './workspace'
import type { Measured } from './card'
import { paint, paletteOf } from './palette'
import type { Palette } from './palette'
import { layoutView } from './layout'
import type { Drawing, Piece } from './layout'
import { HIDDEN, draftOf, earnsSteps, forkPrompt, isCommand, offered, parseSteps, skillList, toggled } from './steps'

type Dollar = Parameters<Hook<'session.start'>>[0]

const card = atom({ plugin: 'session-hud', key: 'card' } as const, EMPTY)
const nowAtom = atom({ plugin: 'session-hud', key: 'now' } as const, 0)
const paletteAtom = atom({ plugin: 'session-hud', key: 'palette' } as const, 'theme' as Palette)
const stepsAtom = atom({ plugin: 'session-hud', key: 'steps' } as const, HIDDEN)

/** The time left in a window is drawn in minutes: a tick every 30 s keeps it current without redrawing on every second. */
const TICK_MS = 30_000
/** A git reading that takes longer than this is dropped; the card keeps the last one. */
const GIT_TIMEOUT_MS = 5_000

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

/** Puts the ticked steps in the prompt box as a draft, never sent; where the surface draws its own composer, on the clipboard. */
async function fill($: Dollar, surface: string): Promise<void> {
  const text = draftOf(await read($, stepsAtom))
  if (text === '') return
  const filled = await $.prompt.fill({ text })
  if (!filled.isFilled) {
    if (filled.refusal !== 'no_composer') return $.ui.toast('The prompt box is busy; try again')
    const copied = await $.ui.copy({ text, surface: surface as never })
    if (!copied.isCopied) return $.ui.toast('Could not put the steps in the prompt')
    $.ui.toast('Copied; paste it into the prompt')
  }
  await update($, stepsAtom, () => HIDDEN)
}

export const register: Register = (on, options) => {
  const held: Held = {}
  const ttl = ttlOf((options as Record<string, unknown> | undefined)?.cacheTtl)
  // Off unless set to true: a fork after every main turn costs about one short reply.
  const suggests = (options as Record<string, unknown> | undefined)?.nextSteps === true

  on('session.start', {}, async ($, e, next) => {
    const started = await next(e)
    void observe($, async () => { ensureTicker($, held); await prime($, held) })
    void observe($, () => locate($))
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
      // The turn may have checked out a branch or entered a worktree.
      void observe($, () => locate($))
    } else void observe($, async () => { await update($, card, current => agentEnded(current, e.agentId)) })
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
      // The next steps under the card's lines: a digit ticks one (from an empty prompt box), p puts the ticked ones in
      // the prompt box, 0 dismisses. A slash command is drawn in the sent colour, apart from a prompt in prose.
      const stepsSection = () => {
        if (steps.kind === 'hidden') return null
        const head = <Text key="steps-head" {...paint(palette, 'secondary')}>{steps.kind === 'loading' ? 'next steps…' : 'next steps'}</Text>
        if (steps.kind === 'loading') return <Box key="steps" flexDirection="column" marginTop={1}>{head}</Box>
        const row = (step: SessionHudStep, i: number) => {
          const ticked = steps.picked.includes(i)
          const style = isCommand(step) ? 'sent' : ticked ? 'plain' : 'secondary'
          return <Button key={`step-${i}`} hotkey={String(i + 1)} plain onPress={() => update($, stepsAtom, current => toggled(current, i))}>
            <Text {...paint(palette, style)}>{`${ticked ? '☑' : '☐'} ${step.label}`}</Text>
          </Button>
        }
        const half = Math.ceil(steps.steps.length / 2)
        const count = steps.picked.length
        return <Box key="steps" flexDirection="column" marginTop={1}>
          {head}
          <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
            <Box flexDirection="column">{steps.steps.slice(0, half).map((step, i) => row(step, i))}</Box>
            <Box flexDirection="column">{steps.steps.slice(half).map((step, i) => row(step, i + half))}</Box>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
            {count > 0
              ? <Button key="steps-fill" hotkey="p" variant="primary" label={count === 1 ? 'Put in prompt' : `Put ${count} in prompt`} onPress={() => fill($, e.surface)} />
              : <Text key="steps-hint" {...paint(palette, 'secondary')}>tick with 1–{steps.steps.length}, then p puts them in the prompt</Text>}
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
