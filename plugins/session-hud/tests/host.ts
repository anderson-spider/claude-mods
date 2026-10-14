// The host fake the plugin's tests share: the session's model, usage and theme, the clock, the agents, and the band to mount.
import type { AgentInfo, On } from 'claude-code'
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

/** A host with the session's model, usage, theme and clock; a spawn (refused with `denySpawn`) starts `agent-1`, `agent-2`... on its `model` (Sonnet 4.5 when none), and `roster` is what `$.agent.list()` answers. */
export function world(on: On, opts: { theme?: string; window?: number; denySpawn?: string } = {}) {
  const roster: AgentInfo[] = []
  let spawns = 0
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
  // Opus answers with 95% of its input cached and 5 output tokens; any other model as named, uncached, with 700.
  on('turn.step', async function* (_$, e) {
    const usage = e.model === 'claude-opus-5-5'
      ? { model: e.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 950, cache_creation_input_tokens: 40 }
      : { model: e.model, input_tokens: 1_000, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  on('agent.spawn', (_$, e) => (opts.denySpawn !== undefined ? { deny: opts.denySpawn } : { model: e.model ?? 'claude-sonnet-4-5', agentId: `agent-${++spawns}` }))
  on('agent.list', () => ({ value: roster }))
  return { clock, roster }
}

/** An agent as `$.agent.list()` lists it. */
export const listed = (id: string, status: AgentInfo['status']): AgentInfo => ({ id, status, type: 'general-purpose', description: 'Fixture' })

export const start = ($: { session: { start: (e: never) => Promise<unknown> } }) =>
  $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

export const band = (columns = 110, hasSurvey = false, isWorking = false) => ({
  plugin: 'session-hud', component: 'AbovePrompt', surface: 'terminal',
  props: { hasSurvey, isWorking, maxRows: 20, bodyColumns: columns, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}) as never

/** A main-session step (or a subagent's, with `agentId`) on `model` at `effort`, run to its result. */
export const step = async ($: Engine, agentId?: string, model = 'claude-opus-5-5', effort = 'medium') => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, effort, messageCount: 1, ...(agentId ? { agentId } : {}) } as never)
  let item = await stream.next()
  while (!item.done) item = await stream.next()
  return item.value
}

const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
export const pause = () => new Promise<void>(resolve => timers.setTimeout(resolve, 0))
export const flush = async () => { for (let i = 0; i < 10; i++) await pause() }
