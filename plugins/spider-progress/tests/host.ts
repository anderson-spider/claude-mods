// The host fake the plugin's tests share: tools, the command, panes, the clock, settings, spawns, steps and the band.
import type { On, RenderElement } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

export type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }

export const NOW = Date.parse('2026-10-18T12:00:00Z')

/** The MCP name the host gives a tool this plugin registers. */
export const id = (name: string) => `mcp__spider-progress__${name}`

/** What draws beneath this plugin's band: another plugin's tree. */
export const BENEATH: RenderElement = { type: 'Text', props: {}, children: ['beneath'] }

/** A host recording tools, panes and spawned prompts; a spawn starts `agent-1`, `agent-2`... on the model it names, and a resume keeps its id. */
export function world(on: On, opts: { language?: string; env?: Record<string, string> } = {}) {
  const tools: Tool[] = []
  const opened: string[] = []
  const prompts: string[] = []
  let spawns = 0
  const clock = mock.clock(((name: string, ...rest: unknown[]) => (name === 'clock.now' ? undefined : (on as (...a: unknown[]) => unknown)(name, ...rest))) as unknown as On)
  on('clock.now', () => ({ value: clock.now() + NOW }))
  on('tool.register', (_$, e) => (tools.push(e as unknown as Tool), { value: { tool: id(e.name) } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's1' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', (_$, e) => (opened.includes(e.id) || opened.push(e.id), { value: { isPlaced: true } }) as never)
  on('ui.close', (_$, e) => (opened.splice(opened.indexOf(e.id), 1), { value: undefined }) as never)
  on('ui.panes', () => ({ value: opened.map(pane => ({ id: pane, title: 'Spider agents' })) }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('settings.read', () => ({ value: opts.language ? { language: opts.language } : {} }) as never)
  on('env.get', (_$, e) => ({ value: opts.env?.[e.name] }))
  on('session.usage', () => ({ value: { context: { tokens: 1, window: 500_000, percent: 0, breakdown: { rawMaxTokens: 500_000 } }, rateLimits: [] } }) as never)
  on('agent.spawn', (_$, e) => (prompts.push(e.prompt), { model: e.model ?? 'claude-sonnet-5-5', agentId: e.resume?.agentId ?? `agent-${++spawns}` }))
  on('turn.step', async function* (_$, e) {
    const usage = { model: e.model, input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('ui.render', { component: 'AbovePrompt' }, () => BENEATH)
  return { tools, opened, prompts, clock }
}

export async function started($: Engine, tools: Tool[]): Promise<string[]> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await flush()
  expect(tools.length).toBeGreaterThan(0)
  return tools.map(tool => tool.name)
}

export const band = (columns = 60) => ({
  plugin: 'spider-progress', component: 'AbovePrompt', surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: columns, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}) as never

export const pane = (columns = 100) => ({
  plugin: 'spider-progress', component: 'Pane', surface: 'terminal', requestId: 'spider-agents',
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
