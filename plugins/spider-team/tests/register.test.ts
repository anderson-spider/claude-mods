import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { refusal } from '../hooks/git-guard'
import { STEP_BRIEF } from '../hooks/tiers'
import { NOW, band, call, drawn, flush, pane, started, step, world } from './host'

const PLAN = { title: 'Auth', phase: 'execute', tasks: [{ id: 'T1', title: 'Build login', owner: 'worker' }] }
const run = ($: Engine, args = '') => $.command.run({ command: 'spider-agents', args } as never) as Promise<{ text?: string }>
const spawn = ($: Engine, prompt: string, subagentType = 'spider-team:spider-worker') => $.agent.spawn({ prompt, subagentType, description: 'Build login' } as never) as Promise<{ agentId?: string }>
const end = ($: Engine, agentId: string, reason = 'answer') => $.turn.complete({ turnId: 't1', agentId, answer: 'ok', durationMs: 1, isAborted: false, reason } as never)

test('session start registers progress, step and the spider-agents command', async ($, on) => {
  const { tools } = world(on)
  expect(await started($, tools)).toEqual(['progress', 'step'])
  expect((await run($, 'nonsense')).text).toBe('Usage: /spider-agents [open|close|clear]')
})

test('progress from a subagent is refused; step from the main session is refused', async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  expect(await call($, 'progress', PLAN, 'agent-9')).toBe('refused: only the main session reports the run')
  expect(((await $.tool.call({ tool: 'mcp__spider-team__progress', ...PLAN, agentId: '' } as never)) as { result?: string }).result).toBe('refused: only the main session reports the run')
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
  expect(await drawn(ui)).toMatch(/T1 Build login  worker · running \(1\/3\)  ← worker/)
  await ui.unmount()
  await end($, agentId!)
  await flush()
  ui = await $.ui.mount(pane())
  expect(await drawn(ui)).toMatch(/T1 Build login  worker · reviewing/)
  expect(await call($, 'step', { done: 2, total: 3 }, agentId)).toBe(`ignored: ${agentId} already ended`)
  await ui.unmount()
})

test("a subagent's tool calls are its activity, failures counted; Main's calls and the answers pass through unchanged", async ($, on) => {
  const { tools, stored } = world(on)
  on('tool.call', { tool: 'Read' }, () => ({ result: 'file' }) as never)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'boom', isError: true }) as never)
  await started($, tools)
  const { agentId } = await spawn($, 'Find the router.', 'Explore')
  await flush()
  expect(((await $.tool.call({ tool: 'Read', file_path: '/a', agentId } as never)) as { result?: string }).result).toBe('file')
  expect(((await $.tool.call({ tool: 'Bash', command: 'false', agentId } as never)) as { isError?: boolean }).isError).toBe(true)
  await $.tool.call({ tool: 'Read', file_path: '/b' } as never)
  await call($, 'step', { done: 1, total: 2 }, agentId)
  await flush()
  expect(stored.agents?.[0]?.activity).toEqual({ tools: ['Read', 'Bash'], calls: 2, errors: 1 })
})

test("a spider-team agent's Git write is refused before it runs; its reads, Main's writes and other agents' pass", async ($, on) => {
  const { tools, stored } = world(on)
  const ran: string[] = []
  on('tool.call', { tool: 'Bash' }, (_$, e) => { ran.push((e as { command: string }).command); return { result: 'ok' } as never })
  await started($, tools)
  const { agentId: worker } = await spawn($, 'spider-task: T1\nBuild the login form.')
  const { agentId: explorer } = await spawn($, 'Find the router.', 'Explore')
  await flush()
  const bash = (command: string, agentId?: string) => $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never) as Promise<{ deny?: string; result?: string }>
  expect((await bash('npm test && git commit -m wip', worker)).deny).toBe(refusal('git commit'))
  expect((await bash('git status', worker)).result).toBe('ok')
  expect((await bash('git commit -m wip')).result).toBe('ok')
  expect((await bash('git commit -m wip', explorer)).result).toBe('ok')
  expect(ran).toEqual(['git status', 'git commit -m wip', 'git commit -m wip'])
  await flush()
  expect(stored.agents?.find(a => a.agentId === worker)?.activity).toEqual({ tools: ['Bash', 'Bash'], calls: 2, errors: 1 })
})

test("when the agent's role cannot be looked up, a subagent's Git write is refused and its reads still run", async ($, on) => {
  const broken: { list?: boolean } = {}
  const { tools } = world(on, { broken })
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }) as never)
  await started($, tools)
  const { agentId } = await spawn($, 'Find the router.', 'Explore')
  await flush()
  await run($, 'clear')
  broken.list = true
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command, agentId } as never) as Promise<{ deny?: string; result?: string }>
  expect((await bash('git commit -m x')).deny).toBe(refusal('git commit'))
  expect((await bash('git status')).result).toBe('ok')
})

test("a spider-team agent the plugin no longer tracks is found in the host's list, and its Git write is still refused", async ($, on) => {
  const { tools } = world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }) as never)
  await started($, tools)
  const { agentId } = await spawn($, 'spider-task: T1\nBuild the login form.')
  await flush()
  await run($, 'clear')
  const reply = (await $.tool.call({ tool: 'Bash', command: 'git push', agentId } as never)) as { deny?: string }
  expect(reply.deny).toBe(refusal('git push'))
})

test('the plugin draws no band above the prompt, with or without a run', async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  for (const step of [null, PLAN]) {
    if (step) await call($, 'progress', step)
    const ui = await $.ui.mount(band())
    expect(await drawn(ui)).toBe('beneath')
    await ui.unmount()
  }
})

test('the pane header counts only the agents of the current run', async ($, on) => {
  const { tools, clock } = world(on)
  await started($, tools)
  await spawn($, 'Find the router.', 'Explore')
  await flush()
  await clock.advance(1_000)
  await call($, 'progress', PLAN)
  let ui = await $.ui.mount(pane())
  let text = await drawn(ui)
  expect(text).not.toContain('● 1 running')
  expect(text).toContain('Agents · running 1')
  await ui.unmount()
  await clock.advance(1_000)
  await spawn($, 'spider-task: T1\nBuild the login form.')
  await flush()
  ui = await $.ui.mount(pane())
  text = await drawn(ui)
  expect(text).toMatch(/Auth · Execute +● 1 running/)
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

test('autoOpen team opens on a new run only, so a closed pane stays closed for its workers', async ($, on) => {
  const { tools, opened } = world(on)
  await started($, tools)
  await spawn($, 'Find the router.', 'Explore')
  await flush()
  expect(opened).toEqual([])
  await call($, 'progress', PLAN)
  await flush()
  expect(opened).toEqual(['spider-agents'])
  await run($, 'close')
  await spawn($, 'spider-task: T1\nBuild the login form.')
  await flush()
  expect(opened).toEqual([])
})

test('autoOpen any opens when a subagent starts with none running, and a closed pane stays closed while they run', { options: { autoOpen: 'any' } }, async ($, on) => {
  const { tools, opened } = world(on)
  await started($, tools)
  const first = await spawn($, 'Find the router.', 'Explore')
  await flush()
  expect(opened).toEqual(['spider-agents'])
  await run($, 'close')
  const second = await spawn($, 'Find the views.', 'Explore')
  await flush()
  expect(opened).toEqual([])
  await end($, first.agentId!)
  await end($, second.agentId!)
  await flush()
  await spawn($, 'Find the tests.', 'Explore')
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
  const ui = await $.ui.mount(pane())
  expect(await drawn(ui)).toContain('no spider-team run')
  await ui.unmount()
})

test('without spider-team the pane lists any subagent', { options: { language: 'pt-BR' } }, async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  const { agentId } = await spawn($, 'Find the router.', 'Explore')
  await flush()
  await step($, agentId!, 'claude-haiku-5-5', 'low')
  await flush()
  let ui = await $.ui.mount(pane())
  const text = await drawn(ui)
  expect(text).toContain('nenhuma execução do spider-team')
  expect(text).toContain('Agentes · rodando 1')
  expect(text).toMatch(/│ . Explore +Haiku 5\.5 /)
  expect(text).toMatch(/│ {3}└ low/)
  await ui.unmount()
})

test('a resumed worker keeps its prompt, runs again and sends its task back to review', async ($, on) => {
  const { tools, prompts } = world(on)
  await started($, tools)
  await call($, 'progress', PLAN)
  const { agentId } = await spawn($, 'spider-task: T1\nBuild the login form.')
  await flush()
  await end($, agentId!)
  await flush()
  expect(await call($, 'progress', { task: { id: 'T1', state: 'running' } })).toBe('ok: 0/1 tasks accepted · execute')
  await $.agent.spawn({ prompt: 'Fix the review notes.', subagentType: 'spider-team:spider-worker', description: 'T1 Build login', resume: { agentId } } as never)
  await flush()
  expect(prompts[1]).toBe('Fix the review notes.')
  expect(await call($, 'step', { done: 1, total: 2 }, agentId)).toBe('ok: 1/2')
  await end($, agentId!)
  await flush()
  const ui = await $.ui.mount(pane())
  expect(await drawn(ui)).toMatch(/T1 Build login  worker · reviewing/)
  await ui.unmount()
})

test('an ending heard before its spawn is recorded leaves no running row', async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  await call($, 'progress', PLAN)
  await end($, 'agent-1', 'error')
  await flush()
  await spawn($, 'spider-task: T1\nBuild the login form.')
  await flush()
  const ui = await $.ui.mount(pane())
  const text = await drawn(ui)
  expect(text).toMatch(/● worker .*error · just now/)
  expect(text).not.toContain('Agents · running')
  expect(text).toContain('T1 Build login  worker · running  ← worker')
  expect(text).toContain('\nthe worker ended: error\n')
  await ui.unmount()
})

test('an exception inside a tool returns text', async ($, on) => {
  const broken = { clock: false }
  const { tools, logs } = world(on, { broken })
  await started($, tools)
  broken.clock = true
  expect(await call($, 'progress', PLAN)).toBe('error: the run could not be updated; go on with the work')
  expect(await call($, 'step', { done: 1, total: 2 }, 'agent-1')).toBe('error: the step could not be recorded; go on with the work')
  expect(logs).toContain('spider-team: progress failed: no implementation for clock.now')
  expect(logs).toContain('spider-team: step failed: no implementation for clock.now')
})

test('an agent starts when its spawn is asked, not when the host answers it', async ($, on) => {
  const { tools, clock, stored } = world(on, { spawnTakes: 5_000 })
  await started($, tools)
  const spawning = spawn($, 'Find the router.', 'Explore')
  await clock.settle()
  await clock.advance(5_000)
  const { agentId } = await spawning
  await end($, agentId!)
  await flush()
  const agent = stored.agents?.find(a => a.agentId === agentId)
  expect(agent?.startedAt).toBe(NOW)
  expect(agent?.endedAt).toBe(NOW + 5_000)
})

test('a resumed agent whose ending is heard before its resume is recorded ends instead of running on', async ($, on) => {
  const { tools, stored } = world(on)
  let gate: Promise<void> | undefined
  on('state.get', async (_$, e, next) => {
    if (gate && e.key === 'agents') {
      const held = gate
      gate = undefined
      await held
    }
    return next(e)
  })
  await started($, tools)
  const { agentId } = await spawn($, 'Find the router.', 'Explore')
  await flush()
  await end($, agentId!)
  await flush()
  let release = () => {}
  gate = new Promise(resolve => { release = resolve })
  await $.agent.spawn({ prompt: 'Look again.', subagentType: 'Explore', description: 'Router', resume: { agentId } } as never)
  await end($, agentId!)
  await flush()
  release()
  await flush()
  expect(stored.agents?.find(a => a.agentId === agentId)?.status).toBe('done')
})

test('an ending held from an earlier turn does not end a later resume', async ($, on) => {
  const { tools, clock, stored } = world(on)
  await started($, tools)
  const { agentId } = await spawn($, 'Find the router.', 'Explore')
  await flush()
  await end($, agentId!)
  await flush()
  await end($, agentId!)
  await flush()
  await clock.advance(1_000)
  await $.agent.spawn({ prompt: 'Look again.', subagentType: 'Explore', description: 'Router', resume: { agentId } } as never)
  await flush()
  expect(stored.agents?.find(a => a.agentId === agentId)?.status).toBe('running')
})

test('a settings read that fails at start still starts the clock, and a reload keeps the run and ends agents the host no longer lists', async ($, on) => {
  const { tools, clock, stored, listed } = world(on, { broken: { settings: true } })
  await started($, tools)
  expect(stored.now).toBe(NOW)
  await call($, 'progress', PLAN)
  await spawn($, 'Find the router.', 'Explore')
  await flush()
  await clock.advance(1_000)
  await flush()
  expect(stored.now).toBe(NOW + 1_000)
  expect(stored.agents?.[0]?.status).toBe('running')
  // The reload missed the Explore agent's ending: the host no longer lists it.
  listed.length = 0
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await flush()
  expect(stored.run?.title).toBe('Auth')
  expect(stored.agents?.[0]?.status).toBe('cancelled')
})

test('the clock ticks once a second only while an agent runs', async ($, on) => {
  const { tools, clock, stored } = world(on)
  await started($, tools)
  expect(stored.now).toBe(NOW)
  await clock.advance(1_000)
  await flush()
  expect(stored.now).toBe(NOW)
  const { agentId } = await spawn($, 'Find the router.', 'Explore')
  await flush()
  await clock.advance(1_000)
  await flush()
  expect(stored.now).toBe(NOW + 2_000)
  await end($, agentId!)
  await flush()
  await clock.advance(1_000)
  await flush()
  expect(stored.now).toBe(NOW + 2_000)
})

test("Main's steps add to its usage on the model that answered, and its turn end reads the window again", async ($, on) => {
  const { tools, context, stored } = world(on, { answeredBy: 'claude-opus-5-5' })
  await started($, tools)
  expect(stored.main?.contextWindow).toBe(500_000)
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 1 } as never)
  let item = await stream.next()
  while (!item.done) item = await stream.next()
  await flush()
  const main = stored.main
  expect(main?.model).toBe('claude-opus-5-5')
  expect(main?.usage).toEqual({ input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 })
  expect(main?.effort).toBe('high')
  expect(main?.busySince).toBe(NOW)
  context.window = 200_000
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  await flush()
  expect(stored.main?.contextWindow).toBe(200_000)
  expect(stored.main?.busySince).toBeUndefined()
  expect(stored.main?.turns).toEqual([[NOW, NOW]])
})

for (const reason of ['clear', 'resume']) {
  test(`session end for ${reason} clears the state and keeps the clock`, async ($, on) => {
    const { tools, clock, stored } = world(on)
    await started($, tools)
    await call($, 'progress', PLAN)
    await spawn($, 'Find the router.', 'Explore')
    await flush()
    await $.session.end({ reason } as never)
    await flush()
    expect(stored.run).toBeNull()
    expect(stored.agents).toEqual([])
    await spawn($, 'Find the views.', 'Explore')
    await flush()
    await clock.advance(1_000)
    await flush()
    expect(stored.now).toBe(NOW + 1_000)
  })
}

test('session end for another reason stops the clock', async ($, on) => {
  const { tools, clock, stored } = world(on)
  await started($, tools)
  await $.session.end({ reason: 'other' } as never)
  await flush()
  await spawn($, 'Find the router.', 'Explore')
  await flush()
  await clock.advance(1_000)
  await flush()
  expect(stored.now).toBe(NOW)
})

test('invalid options are named in one debug line', { options: { historyLimit: 5 } }, async ($, on) => {
  const { tools, logs } = world(on)
  await started($, tools)
  expect(logs).toContain('spider-team: invalid options fall back to defaults: historyLimit')
})

test('a failed observation logs its error and leaves the answer as the host gave it', async ($, on) => {
  const broken = { clock: false }
  const { tools, logs } = world(on, { broken })
  await started($, tools)
  broken.clock = true
  expect((await spawn($, 'Find the router.', 'Explore')).agentId).toBe('agent-1')
  await flush()
  expect(logs).toContain('spider-team: observation failed: no implementation for clock.now')
})

test('a spawn hook that throws logs why and still lets the spawn through', async ($, on) => {
  const { tools, logs } = world(on)
  await started($, tools)
  const result = await $.agent.spawn({ prompt: 42, subagentType: 'spider-team:spider-worker', description: 'Bad' } as never) as { agentId?: string }
  expect(result.agentId).toBe('agent-1')
  expect(logs.some(line => line.startsWith('spider-team: spawn hook failed:'))).toBe(true)
})

test('a pane that cannot be drawn logs why and draws one line instead of failing', async ($, on) => {
  const { tools, logs } = world(on, { broken: { clock: true } })
  await started($, tools)
  const ui = await $.ui.mount(pane())
  expect(await drawn(ui)).toBe('N/A')
  expect(logs).toContain('spider-team: pane render failed: no implementation for clock.now')
  await ui.unmount()
})

test('the terminal draws the cards as monospaced lines with the title bold in the border, the desktop as one SVG, neither with buttons', async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  await call($, 'progress', PLAN)
  const terminal = await $.ui.mount(pane(100, 'terminal'))
  expect((await terminal.find({ type: 'Text', text: /T1 Build login/ }))?.props.mono).toBe(true)
  const titles = (await terminal.findAll({ type: 'Text' })).filter(found => found.text === ' Plan ')
  expect(titles.some(found => found.props.weight === 'bold' && found.props.color === 'suggestion')).toBe(true)
  expect(await terminal.find({ type: 'Svg' })).toBeFalsy()
  expect(await terminal.find({ type: 'Button' })).toBeFalsy()
  await terminal.unmount()
  const desktop = await $.ui.mount(pane(100, 'desktop'))
  expect((await desktop.find({ type: 'Text', text: /Panel/ }))?.props.mono).toBe(true)
  const svg = await desktop.find({ type: 'Svg' })
  expect(svg?.props.source).toContain('>T1 Build login<')
  expect(svg?.props.source).toContain('> Plan <')
  expect(svg?.props).toMatchObject({ alt: 'Spider agents' })
  expect(svg?.props.isInteractive).toBeUndefined()
  expect(await desktop.find({ type: 'Button' })).toBeFalsy()
  await desktop.unmount()
})

test('the open run is kept in the store under the session and comes back after the state is lost; a closed run leaves it', async ($, on) => {
  const { tools, stored, disk } = world(on)
  await started($, tools)
  await call($, 'progress', PLAN)
  expect((disk.get('run:s1') as { run: { title: string } }).run.title).toBe('Auth')
  // A restarted app starts with no state but the store: an end that is no /clear or resume drops the memory.
  await $.session.end({ reason: 'logout', sessionId: 's', resume: { id: 's' } } as never)
  await flush()
  expect(stored.run).toBeNull()
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await flush()
  expect(stored.run?.title).toBe('Auth')
  expect(await call($, 'progress', { finished: true })).toMatch(/^ok/)
  expect(disk.has('run:s1')).toBe(false)
  await $.session.end({ reason: 'logout', sessionId: 's', resume: { id: 's' } } as never)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await flush()
  expect(stored.run).toBeNull()
})

test("a resume in this process brings back the resumed session's run on Main's first turn end, and another session's run stays out", async ($, on) => {
  const { tools, stored, session } = world(on)
  await started($, tools)
  await call($, 'progress', PLAN)
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } } as never)
  session.id = 's2'
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  await flush()
  expect(stored.run).toBeNull()
  await $.session.end({ reason: 'resume', sessionId: 's2', resume: { id: 's2' } } as never)
  session.id = 's1'
  await $.turn.complete({ turnId: 't2', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  await flush()
  expect(stored.run?.title).toBe('Auth')
})

test('/spider-agents clear forgets the run, the agents and their usage, and removes the saved run; the pane stays open', async ($, on) => {
  const { tools, stored, disk, opened } = world(on)
  await started($, tools)
  await call($, 'progress', PLAN)
  await spawn($, 'Find the router.', 'Explore')
  await flush()
  await run($, 'open')
  expect((await run($, 'clear')).text).toBe('Agents pane cleared: the run, the agents and their usage are forgotten.')
  expect(stored.run).toBeNull()
  expect(stored.agents).toEqual([])
  expect(stored.main).toEqual({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
  expect(disk.has('run:s1')).toBe(false)
  expect(opened).toContain('spider-agents')
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  await flush()
  expect(stored.run).toBeNull()
})
