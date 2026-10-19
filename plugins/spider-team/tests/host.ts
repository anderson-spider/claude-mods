// The host fake the plugin's tests share: tools, the command, panes, the clock, settings, spawns, steps and the band.
import type { On, RenderElement } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PluginState } from 'claude-code'

export type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }

export const NOW = Date.parse('2026-10-18T12:00:00Z')

/** The MCP name the host gives a tool this plugin registers. */
export const id = (name: string) => `mcp__spider-team__${name}`

/** What draws beneath this plugin's band: another plugin's tree. */
export const BENEATH: RenderElement = { type: 'Text', props: {}, children: ['beneath'] }

/**
 * A host recording tools, panes, spawned prompts and debug logs; a spawn starts `agent-1`, `agent-2`... on the model it names,
 * and a resume keeps its id. `broken.clock` makes the clock throw and `broken.settings` the settings read; `spawnTakes` is how
 * long the host takes to answer a spawn on the mock clock; `answeredBy` is the model a step's usage names; `context.window` is
 * the window the host measures; `stored` holds the plugin's state as last written.
 */
export function world(on: On, opts: { language?: string; env?: Record<string, string>; broken?: { clock?: boolean; settings?: boolean }; spawnTakes?: number; answeredBy?: string } = {}) {
  const tools: Tool[] = []
  const logs: string[] = []
  const context = { window: 500_000 }
  const stored: { [K in keyof PluginState['spider-team']]?: PluginState['spider-team'][K] } = {}
  const opened: string[] = []
  const prompts: string[] = []
  let spawns = 0
  const clock = mock.clock(((name: string, ...rest: unknown[]) => (name === 'clock.now' ? undefined : (on as (...a: unknown[]) => unknown)(name, ...rest))) as unknown as On)
  on('clock.now', () => {
    if (opts.broken?.clock) throw new Error('the clock is down')
    return { value: clock.now() + NOW }
  })
  on('tool.register', (_$, e) => (tools.push(e as unknown as Tool), { value: { tool: id(e.name) } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's1' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', (_$, e) => (opened.includes(e.id) || opened.push(e.id), { value: { isPlaced: true } }) as never)
  on('ui.close', (_$, e) => (opened.splice(opened.indexOf(e.id), 1), { value: undefined }) as never)
  on('ui.panes', () => ({ value: opened.map(pane => ({ id: pane, title: 'Spider agents' })) }) as never)
  on('state.set', async (_$, e, next) => {
    const result = await next(e)
    if ((result as unknown as { value?: { isSet?: boolean } }).value?.isSet && e.plugin === 'spider-team') (stored as Record<string, unknown>)[e.key] = e.value
    return result
  })
  on('ui.log', (_$, e) => (logs.push(e.text), { value: undefined }))
  on('settings.read', () => {
    // A throwing hook would be skipped for the kit's default; settings that are not an object make the read fail in the plugin.
    if (opts.broken?.settings) return { value: null } as never
    return { value: opts.language ? { language: opts.language } : {} } as never
  })
  on('env.get', (_$, e) => ({ value: opts.env?.[e.name] }))
  on('session.usage', () => ({ value: { context: { tokens: 1, window: context.window, percent: 0, breakdown: { rawMaxTokens: context.window } }, rateLimits: [] } }) as never)
  on('agent.spawn', async (_$, e) => {
    prompts.push(e.prompt)
    if (opts.spawnTakes) await clock.sleep(opts.spawnTakes)
    return { model: e.model ?? 'claude-sonnet-5-5', agentId: e.resume?.agentId ?? `agent-${++spawns}` }
  })
  on('turn.step', async function* (_$, e) {
    const usage = { model: opts.answeredBy ?? e.model, input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('ui.render', { component: 'AbovePrompt' }, () => BENEATH)
  return { tools, opened, prompts, clock, logs, context, stored }
}

export async function started($: Engine, tools: Tool[]): Promise<string[]> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await flush()
  expect(tools.length).toBeGreaterThan(0)
  return tools.map(tool => tool.name)
}

export const band = (columns = 60) => ({
  plugin: 'spider-team', component: 'AbovePrompt', surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: columns, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}) as never

export const pane = (columns = 100) => ({
  plugin: 'spider-team', component: 'Pane', surface: 'terminal', requestId: 'spider-agents',
  props: { title: 'Spider agents', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}) as never

/** Main's or an agent's (`agentId`) call to one of the plugin's tools, answered with its result text. */
export const call = async ($: Engine, name: string, input: Record<string, unknown>, agentId?: string) =>
  ((await $.tool.call({ tool: id(name), ...input, ...(agentId ? { agentId } : {}) } as never)) as { result?: string }).result

/** An agent's step on `model`, run to its result. */
export const step = async ($: Engine, agentId: string, model = 'claude-opus-5-5', effort = 'medium') => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, effort, messageCount: 1, agentId } as never)
  let item = await stream.next()
  while (!item.done) item = await stream.next()
  return item.value
}

/** The text a mounted surface drew. */
export const drawn = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) => (await ui.findAll({ type: 'Text' })).map(found => found.text).join('\n')

const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
export const pause = () => new Promise<void>(resolve => timers.setTimeout(resolve, 0))
export const flush = async () => { for (let i = 0; i < 10; i++) await pause() }
