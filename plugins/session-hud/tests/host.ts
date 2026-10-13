// The host fake the plugin's tests share: the session's model, usage and theme, the clock, and the band to mount.
import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

export const NOW = Date.parse('2026-10-13T12:00:00Z')
const HOUR = 3_600_000

/** What `$.session.usage()` answers by default: a fifth of the window, both windows and a cost. */
export const USAGE = {
  startedAt: NOW - HOUR,
  context: { tokens: 200_000, window: 1_000_000, percent: 20 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 74, resetsAt: new Date(NOW + 38 * 60_000).toISOString() },
    { kind: 'seven_day', percentUsed: 60, resetsAt: new Date(NOW + 84 * HOUR).toISOString() },
  ],
  cost: { usd: 4.43 },
}

/** A host with the session's model, usage, theme and clock; `crew` answers the crew's HUD atoms when given. */
export function world(on: On, opts: { theme?: string; window?: number; crew?: { plans: unknown[]; agents: unknown[] } } = {}) {
  // `mock.clock` registers `clock.now` itself and the engine refuses a second one: the test's own reads NOW.
  const clock = mock.clock(((name: string, ...rest: unknown[]) => (name === 'clock.now' ? undefined : (on as (...a: unknown[]) => unknown)(name, ...rest))) as unknown as On)
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', (_$, e) => ({ value: (e as { breakdown?: string }).breakdown
    ? { ...USAGE, context: { ...USAGE.context, breakdown: { rawMaxTokens: opts.window ?? 1_000_000 } } } : USAGE }) as never)
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: opts.theme ?? 'dark' }] }) as never)
  on('config.set', (_$, e) => ({ value: e.value }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 950, cache_creation_input_tokens: 40 } } as never
  })
  if (opts.crew) {
    const crew = opts.crew
    on('state.get', (_$, e, next) => (e.plugin === 'crew' && (e.key === 'plans' || e.key === 'agents')
      ? { value: { value: crew[e.key], version: 1 } } : next(e)) as never)
  }
  return { clock }
}

export const start = ($: { session: { start: (e: never) => Promise<unknown> } }) =>
  $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

export const band = (columns = 110, hasSurvey = false, isWorking = false) => ({
  plugin: 'session-hud', component: 'AbovePrompt', surface: 'terminal',
  props: { hasSurvey, isWorking, maxRows: 20, bodyColumns: columns, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}) as never

/** A main-session step (or a subagent's, with `agentId`), run to its result. */
export const step = async ($: Engine, agentId?: string) => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1, ...(agentId ? { agentId } : {}) } as never)
  let item = await stream.next()
  while (!item.done) item = await stream.next()
  return item.value
}

const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
export const pause = () => new Promise<void>(resolve => timers.setTimeout(resolve, 0))
export const flush = async () => { for (let i = 0; i < 10; i++) await pause() }
