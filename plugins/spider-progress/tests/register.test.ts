import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { STEP_BRIEF } from '../hooks/tiers'
import { band, call, drawn, flush, pane, started, step, world } from './host'

const PLAN = { title: 'Auth', phase: 'execute', tasks: [{ id: 'T1', title: 'Build login', owner: 'opus' }] }
const run = ($: Engine, args = '') => $.command.run({ command: 'spider-agents', args } as never) as Promise<{ text?: string }>
const spawn = ($: Engine, prompt: string, subagentType = 'spider-team:spider-opus') => $.agent.spawn({ prompt, subagentType, description: 'Build login' } as never) as Promise<{ agentId?: string }>
const end = ($: Engine, agentId: string, reason = 'answer') => $.turn.complete({ turnId: 't1', agentId, answer: 'ok', durationMs: 1, isAborted: false, reason } as never)

test('session start registers progress, step and the spider-agents command', async ($, on) => {
  const { tools } = world(on)
  expect(await started($, tools)).toEqual(['progress', 'step'])
  expect((await run($, 'nonsense')).text).toBe('Usage: /spider-agents [open|close]')
})

test('progress from a subagent is refused; step from the main session is refused', async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  expect(await call($, 'progress', PLAN, 'agent-9')).toBe('refused: only the main session reports the run')
  expect(await call($, 'step', { done: 1, total: 2 })).toBe('refused: only a subagent reports steps; Main reports with progress')
})

test('a tool failure returns text and never throws', async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  expect(await call($, 'progress', { title: 'Bad', tasks: 'junk' })).toBe('refused: tasks must be a list')
  expect(await call($, 'progress', { phase: 'execute' })).toBe('refused: no run; start one with a title')
})

test('a spawned spider worker gets the step brief and binds its task, which moves to running then reviewing', async ($, on) => {
  const { tools, prompts } = world(on)
  await started($, tools)
  expect(await call($, 'progress', PLAN)).toBe('ok: 0/1 tasks accepted · execute')
  const { agentId } = await spawn($, 'spider-task: T1\nBuild the login form.')
  await flush()
  expect(prompts[0]).toBe(`spider-task: T1\nBuild the login form.${STEP_BRIEF}`)
  await step($, agentId!)
  expect(await call($, 'step', { done: 1, total: 3 }, agentId)).toBe('ok: 1/3')
  let ui = await $.ui.mount(pane())
  expect(await drawn(ui)).toMatch(/T1 Build login · opus · running \(1\/3\)/)
  await ui.unmount()
  await end($, agentId!)
  await flush()
  ui = await $.ui.mount(pane())
  expect(await drawn(ui)).toMatch(/T1 Build login · opus · reviewing/)
  expect(await call($, 'step', { done: 2, total: 3 }, agentId)).toBe(`ignored: ${agentId} already ended`)
  await ui.unmount()
})

test('the band draws above what the band below returns, and nothing without a run', async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  let ui = await $.ui.mount(band())
  expect(await drawn(ui)).toBe('beneath')
  await ui.unmount()
  await call($, 'progress', PLAN)
  ui = await $.ui.mount(band())
  const text = await drawn(ui)
  expect(text).toContain('SPIDER TEAM · Auth')
  expect(text).toContain('Execute · 0/1 tasks · 0 agents')
  expect(text.indexOf('SPIDER TEAM')).toBeLessThan(text.indexOf('beneath'))
  await ui.unmount()
})

test('dismiss hides the band until a new run', async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  await call($, 'progress', PLAN)
  let ui = await $.ui.mount(band())
  await ui.press({ key: 'spider-dismiss' })
  await flush()
  await ui.unmount()
  ui = await $.ui.mount(band())
  expect(await drawn(ui)).toBe('beneath')
  await ui.unmount()
  await call($, 'progress', { finished: true })
  await call($, 'progress', { title: 'Next', tasks: [{ id: 'T1', title: 'Go', owner: 'main' }] })
  ui = await $.ui.mount(band())
  expect(await drawn(ui)).toContain('SPIDER TEAM · Next')
  await ui.unmount()
})

test('/spider-agents toggles, open opens, close closes', { options: { autoOpen: 'off' } }, async ($, on) => {
  const { tools, opened } = world(on)
  await started($, tools)
  expect((await run($)).text).toBe('Agents pane open.')
  expect(opened).toEqual(['spider-agents'])
  expect((await run($)).text).toBe('Agents pane closed.')
  expect(opened).toEqual([])
  await run($, 'open')
  await run($, 'open')
  expect(opened).toEqual(['spider-agents'])
  await run($, 'close')
  expect(opened).toEqual([])
})

test('autoOpen team opens on a new run', async ($, on) => {
  const { tools, opened } = world(on)
  await started($, tools)
  await spawn($, 'Find the router.', 'Explore')
  await flush()
  expect(opened).toEqual([])
  await call($, 'progress', PLAN)
  await flush()
  expect(opened).toEqual(['spider-agents'])
})

test('autoOpen any opens on any spawn', { options: { autoOpen: 'any' } }, async ($, on) => {
  const { tools, opened } = world(on)
  await started($, tools)
  await spawn($, 'Find the router.', 'Explore')
  await flush()
  expect(opened).toEqual(['spider-agents'])
})

test('autoOpen off never opens', { options: { autoOpen: 'off' } }, async ($, on) => {
  const { tools, opened } = world(on)
  await started($, tools)
  await call($, 'progress', PLAN)
  await spawn($, 'spider-task: T1\nGo')
  await flush()
  expect(opened).toEqual([])
})

test('session end clears the state', async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  await call($, 'progress', PLAN)
  await $.session.end({ reason: 'other' } as never)
  await flush()
  const ui = await $.ui.mount(band())
  expect(await drawn(ui)).toBe('beneath')
  await ui.unmount()
})

test('without spider-team the pane lists any subagent and no band is drawn', { options: { language: 'pt-BR' } }, async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  const { agentId } = await spawn($, 'Find the router.', 'Explore')
  await flush()
  await step($, agentId!, 'claude-haiku-5-5', 'low')
  await flush()
  let ui = await $.ui.mount(pane())
  const text = await drawn(ui)
  expect(text).toContain('Nenhuma execução do spider-team')
  expect(text).toMatch(/Explore.*Haiku 5\.5.*low.*rodando/)
  await ui.unmount()
  ui = await $.ui.mount(band())
  expect(await drawn(ui)).toBe('beneath')
  await ui.unmount()
})
