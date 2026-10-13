import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { OFF, ON, ROOT, compose, flush, hudBand, hudCapture, hudExists, hudPane, hudStat, hudText, jevWorld, pause, record, spawnInput, step } from './host'

// --- HUD host integration ---

test('HUD observes bypass, routed and twin spawns separately from decision records', ON, async ($, on) => {
  const { seen } = jevWorld(on, { stepModel: 'claude-sonnet-5-5' })
  const values = hudCapture(on)
  await $.agent.spawn(spawnInput({ model: 'sonnet' }))
  await pause()
  expect(values.agents).toMatchObject([{ type: 'crew:digger', model: 'sonnet', status: 'running' }])
  await step($, 'a1', 'high')
  await pause()
  expect(values.agents).toMatchObject([{ effort: 'high', observedModel: 'claude-sonnet-5-5' }])
  expect(seen.writes).toHaveLength(0)
})

test('HUD preserves completion before late spawn, then a new step restarts the job', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  jevWorld(on, { spawn: async () => { await held; return { agentId: 'a1', model: 'sonnet' } } })
  const values = hudCapture(on)
  on('turn.complete', () => ({ text: 'completed' }))
  const spawning = $.agent.spawn(spawnInput())
  await pause()
  await $.turn.complete({ agentId: 'a1', answer: 'private', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  release()
  await spawning
  expect(values.agents).toEqual([])
  await step($, 'a1', 'high')
  expect(values.agents).toMatchObject([{ status: 'running', effort: 'high' }])
  await $.turn.complete({ agentId: 'a1', answer: 'private', reason: 'aborted', turnId: 't1', durationMs: 1, isAborted: true } as never)
  expect(values.agents).toMatchObject([{ status: 'ended' }])
  await step($, 'a1', 'medium')
  expect(values.agents).toMatchObject([{ status: 'running', effort: 'medium' }])
})

test('HUD refreshes plans after successful in-scope Write and never for denies, errors or foreign paths', OFF, async ($, on) => {
  const files: Record<string, string> = { '/repo/.crew/plans/live.md': hudText }
  jevWorld(on, { files })
  const values = hudCapture(on)
  on('tool.call', (_$, e) => 'file_path' in e && e.file_path === 'error' ? { result: 'failed', isError: true } : { result: 'written' })
  const write = (file_path: string) => $.tool.call({ tool: 'Write', file_path, content: hudText } as never)
  await write('src/file.ts')
  await write('../other/.crew/plans/out.md')
  expect(values.plans).toBeUndefined()
  expect(await write('.crew/plans/live.md')).toEqual({ result: 'written' })
  expect(values.plans).toMatchObject([{ name: 'live' }])
  await write('error')
  expect(values.plans).toMatchObject([{ name: 'live' }])
})

test('HUD keeps the plans after a shell cd into a subdirectory: they are read under the session root', OFF, async ($, on) => {
  jevWorld(on, { files: { '/repo/.crew/plans/live.md': hudText }, cwd: '/repo/plugins/app', root: '/repo' })
  const values = hudCapture(on)
  on('tool.call', () => ({ result: 'written' }))
  // A relative path resolves from the shell's directory; the plans themselves are read under the root.
  await $.tool.call({ tool: 'Write', file_path: '../../.crew/plans/live.md', content: hudText } as never)
  expect(values.plans).toMatchObject([{ name: 'live' }])
})

test('HUD render reads atoms only, and the crew draws nothing above the prompt', OFF, async ($, on) => {
  const { seen } = jevWorld(on)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['idle'] }))
  await $.agent.spawn(spawnInput())
  await pause()
  const pane = await $.ui.mount(hudPane())
  expect(await pane.find({ type: 'Text', text: /Agents · running 1/ })).toBeDefined()
  await pane.unmount()
  const band = await $.ui.mount(hudBand())
  expect((await band.find({ type: 'Text' }))?.text).toBe('idle')
  await band.unmount()
  expect(seen.fetches).toEqual([])
  expect(seen.writes).toEqual([])
})

test('HUD pane draws the plan tree and the agents from the same atoms, and /crew-hud opens it', ON, async ($, on) => {
  jevWorld(on, { files: { '/repo/.crew/plans/live.md': hudText } })
  on('tool.call', () => ({ result: 'written' }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  await $.agent.spawn(spawnInput())
  await $.tool.call({ tool: 'Write', file_path: '.crew/plans/live.md', content: hudText } as never)
  await pause()
  const pane = await $.ui.mount(hudPane())
  expect(await pane.find({ type: 'Text', text: /live/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /T1 crew:digger {2}working/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Agents · running 1/ })).toBeDefined()
  await pane.unmount()
  expect(await $.command.run({ command: 'crew-hud', args: '' } as never)).toEqual({ text: 'the pane is open.' })
})

test('HUD pane paints with the design palette under a dark theme and with theme keys after the theme turns light', ON, async ($, on) => {
  jevWorld(on, { files: { '/repo/.crew/plans/live.md': hudText }, register: true })
  let theme = 'dark'
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: theme }] }) as never)
  on('config.set', (_$, e) => { theme = String(e.value); return { value: e.value } })
  on('fs.list', () => ({ value: ['live.md'] }) as never)
  on('tool.call', () => ({ result: 'written' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '.crew/plans/live.md', content: hudText } as never)
  await flush()
  const dark = await $.ui.mount(hudPane())
  expect((await dark.find({ type: 'Text', text: /^Plan$/ }))?.props).toMatchObject({ color: '#61afef', bold: true })
  expect((await dark.findAll({ type: 'Box' })).some(box => box.props.borderColor === '#61afef')).toBe(true)
  await dark.unmount()
  await $.config.set({ key: 'theme', value: 'light' } as never)
  await flush()
  const light = await $.ui.mount(hudPane())
  expect((await light.find({ type: 'Text', text: /^Plan$/ }))?.props).toMatchObject({ color: 'permission', bold: true })
  await light.unmount()
})

test('HUD notes a crew agent tool call by name and leaves its result, deny and error exactly as they came', ON, async ($, on) => {
  jevWorld(on, { stepModel: 'claude-sonnet-5-5' })
  const values = hudCapture(on)
  on('tool.call', (_$, e) => {
    const tool = (e as { tool?: string }).tool
    if (tool === 'Bash') return { deny: 'no' }
    if (tool === 'Grep') return { result: 'failed', isError: true }
    return { result: 'ran' }
  })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high')
  await pause()
  expect(await $.tool.call({ tool: 'Read', agentId: 'a1', file_path: '/Users/private/secret.ts' } as never)).toEqual({ result: 'ran' })
  expect(await $.tool.call({ tool: 'Bash', agentId: 'a1', command: 'cat ~/.ssh/id_rsa' } as never)).toEqual({ deny: 'no' })
  expect(await $.tool.call({ tool: 'Grep', agentId: 'a1', pattern: 'token' } as never)).toEqual({ result: 'failed', isError: true })
  expect(await $.tool.call({ tool: 'Read', file_path: 'main-loop.ts' } as never)).toEqual({ result: 'ran' })
  await pause()
  expect(values.agents).toMatchObject([{ id: 'a1', toolCount: 3, failures: 2,
    tools: [{ name: 'Read', failed: false }, { name: 'Bash', failed: true }, { name: 'Grep', failed: true }] }])
  expect(JSON.stringify(values.agents)).not.toMatch(/private|ssh|token|main-loop/)
})

test('HUD keeps the prompt sections byte-identical after observation and plan refresh', ON, async ($, on) => {
  const { clock } = jevWorld(on, { files: { '/repo/.crew/plans/live.md': hudText }, stepModel: 'claude-sonnet-5-5' })
  on('tool.call', () => ({ result: 'written' }))
  on('turn.complete', () => ({ text: 'done' }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const before = JSON.stringify((await compose($, ['Agent'])).sections)
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high')
  await $.turn.complete({ agentId: 'a1', answer: 'private', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await $.tool.call({ tool: 'Write', file_path: '.crew/plans/live.md', content: hudText } as never)
  await clock.advance(5_000)
  expect(JSON.stringify((await compose($, ['Agent'])).sections)).toBe(before)
})

test('HUD reconciles a running listed agent as seen, ends it, and ticks once across repeated hooks', OFF, async ($, on) => {
  let listed = [{ id: 'unseen', type: 'crew:challenger', status: 'running', description: 'private' }]
  const clock = mock.clock(on)
  on('agent.list', () => ({ value: listed }) as never)
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('fs.list', () => ({ value: [] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('turn.complete', () => ({ text: 'done' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.compose', () => ({ sections: [] }))
  const values = hudCapture(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.prompt.compose({ tools: [], traits: [], model: 'm', promptModel: 'm', surfaces: [], outputStyle: null } as never)
  await clock.advance(1_000)
  expect(values.agents).toMatchObject([{ type: 'crew:challenger', seenAt: 1_000, status: 'running' }])
  expect(values.now).toBe(1_000)
  listed = [{ ...listed[0]!, status: 'completed' }]
  await clock.advance(1_000)
  expect(values.agents).toMatchObject([{ status: 'ended' }])
  await $.turn.complete({ agentId: 'unseen', answer: 'private', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await clock.advance(1_000)
  expect(values.agents).toMatchObject([{ status: 'ended' }])
  await $.session.end({ reason: 'exit', sessionId: 'test-session' } as never)
})

test('HUD state write failure never changes spawn result or routed decision records', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  on('state.set', (_$, e, next) => e.key === 'agents' ? { deny: 'state refused' } : next(e))
  const result = await $.agent.spawn(spawnInput())
  expect(result).toMatchObject({ agentId: 'a1', model: 'default' })
  expect(seen.writes).toHaveLength(1)
  expect(record(seen)).toMatchObject({ v: 4, agent: 'digger', ran: null })
})

test('HUD lists several active plans in filename order, hides closed plans and drops a removed file on reread', OFF, async ($, on) => {
  const files: Record<string, string> = {
    '/repo/.crew/plans/z.md': hudText,
    '/repo/.crew/plans/a.md': hudText,
    '/repo/.crew/plans/closed.md': hudText.replace('implementing', 'skipped'),
  }
  let entries = ['z.md', 'closed.md', 'a.md']
  mock.clock(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('fs.stat', (_$, e) => ({ value: hudStat(e.path, files) }) as never)
  on('fs.exists', (_$, e) => ({ value: hudExists(e.path, files) }) as never)
  on('fs.list', () => ({ value: entries.map(name => ({ name, kind: 'file', isLink: false, size: 1, mtimeMs: 1 })) }) as never)
  on('fs.read', (_$, e) => {
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: files[e.path]! }
  })
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'written' }))
  const values = hudCapture(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await flush()
  expect(values.plans).toMatchObject([{ name: 'a' }, { name: 'z' }])
  delete files['/repo/.crew/plans/a.md']
  entries = ['a.md', 'z.md']
  const result = await $.tool.call({ tool: 'Write', file_path: '.crew/plans/z.md', content: hudText } as never)
  expect(result).toEqual({ result: 'written' })
  expect(values.plans).toMatchObject([{ name: 'z' }])
})

for (const tool of ['Write', 'Edit'] as const) {
  test(`HUD ${tool} denied or errored inside plans returns its exact result without refresh`, OFF, async ($, on) => {
    let calls = 0
    mock.clock(on)
    on('session.cwd', () => ({ value: '/repo' }))
    on('session.root', () => ({ value: '/repo' }))
    on('fs.list', () => (calls++, { value: [] }))
    on('agent.list', () => ({ value: [{ id: 'helper', type: 'general-purpose' }] }) as never)
    const denied = { deny: 'permission denied' }
    const failed = { result: 'IO failure', isError: true as const }
    on('tool.call', (_$, e) => 'file_path' in e && String(e.file_path).includes('failed') ? failed : denied)
    const invoke = (path: string, agentId?: string) => $.tool.call({ tool, file_path: path, agentId, content: hudText,
      old_string: 'a', new_string: 'b' } as never)
    expect(await invoke('.crew/plans/denied.md', 'helper')).toEqual(denied)
    expect(calls).toBe(0)
    expect(await invoke('.crew/plans/failed.md')).toEqual(failed)
    expect(calls).toBe(0)
  })
}

test('HUD ticker updates running time each second, idle time each thirtieth, plans each fifth, and is singleton without session.start', OFF, async ($, on) => {
  const clock = mock.clock(on)
  let listings = 0
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('agent.list', () => ({ value: [] }) as never)
  on('fs.stat', (_$, e) => ({ value: hudStat(e.path) }) as never)
  on('fs.exists', (_$, e) => ({ value: hudExists(e.path) }) as never)
  on('fs.list', () => (listings++, { value: [] }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('prompt.compose', () => ({ sections: [] }))
  on('turn.complete', () => ({ text: 'done' }))
  const values = hudCapture(on)
  const prompt = { tools: [], traits: [], model: 'm', promptModel: 'm', surfaces: [], outputStyle: null } as never
  await $.prompt.compose(prompt)
  await $.prompt.compose(prompt)
  await $.agent.spawn(spawnInput())
  await clock.advance(1_000)
  expect(values.now).toBe(1_000)
  expect(listings).toBe(0)
  await clock.advance(4_000)
  expect(values.now).toBe(5_000)
  expect(listings).toBe(1)
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await clock.advance(24_000)
  expect(values.now).toBe(5_000)
  expect(listings).toBe(5)
  await clock.advance(1_000)
  expect(values.now).toBe(30_000)
  expect(listings).toBe(6)
})

test('HUD late step after completion starts a new timed job, and a delayed spawn cannot reopen an ended job', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const clock = mock.clock(on)
  on('agent.spawn', async () => { await held; return { agentId: 'a1', model: 'sonnet' } })
  on('turn.step', async function* (_$, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as never })
  on('turn.complete', () => ({ text: 'done' }))
  const values = hudCapture(on)
  const spawning = $.agent.spawn(spawnInput())
  await pause()
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'error', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await clock.advance(2_000)
  release()
  await spawning
  expect(values.agents).toEqual([])
  await clock.advance(3_000)
  await step($, 'a1', 'high')
  expect(values.agents).toMatchObject([{ startedAt: 5_000, status: 'running' }])
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'aborted', turnId: 't1', durationMs: 1, isAborted: true } as never)
  await clock.advance(2_000)
  await step($, 'a1', 'medium')
  expect(values.agents).toMatchObject([{ startedAt: 7_000, effort: 'medium', status: 'running' }])
})

test('HUD answer arriving after completion never reactivates the finished job', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('turn.step', async function* (_$, e) {
    await held
    return { turnId: e.turnId, index: e.index, answer: 'private', toolUses: [], stopReason: null,
      usage: { model: 'claude-sonnet-5-5' } } as never
  })
  on('turn.complete', () => ({ text: 'done' }))
  const values = hudCapture(on)
  await $.agent.spawn(spawnInput())
  const ongoing = step($, 'a1', 'high')
  await pause()
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'error', turnId: 't1', durationMs: 1, isAborted: false } as never)
  release()
  await ongoing
  expect(values.agents).toMatchObject([{ status: 'ended' }])
})

for (const twin of [false, true]) {
  test(`HUD retains a first step and answer before ${twin ? 'twin' : 'bypass'} spawn resolves`, OFF, async ($, on) => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const { seen } = jevWorld(on, { stepModel: twin ? 'gpt-6-luna' : 'claude-sonnet-5-5',
      spawn: async () => { await held; return { agentId: 'a1', model: twin ? 'cx/gpt-6-luna-medium' : 'sonnet' } } })
    const values = hudCapture(on)
    const spawning = $.agent.spawn(spawnInput({ subagentType: twin ? 'crew:digger-codex' : 'crew:digger', model: twin ? undefined : 'sonnet' }))
    await pause()
    await step($, 'a1', 'medium', twin ? 'cx/gpt-6-luna-medium' : 'sonnet')
    release()
    await spawning
    await pause()
    expect(values.agents).toMatchObject([{ type: twin ? 'crew:digger-codex' : 'crew:digger', effort: 'medium',
      observedModel: twin ? 'gpt-6-luna' : 'claude-sonnet-5-5' }])
    expect(seen.fetches).toEqual([])
  })
}

test('HUD ignores an answer from job A after completion and restart of job B', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('turn.step', async function* (_$, e) {
    if (e.model === 'sonnet') await held
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null,
      usage: { model: e.model === 'sonnet' ? 'claude-sonnet-5-5' : 'claude-opus-5-5' } } as never
  })
  on('turn.complete', () => ({ text: 'done' }))
  const values = hudCapture(on)
  await $.agent.spawn(spawnInput())
  const first = step($, 'a1', 'high', 'sonnet')
  await pause()
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await step($, 'a1', 'medium', 'opus')
  await pause()
  release()
  await first
  await pause()
  expect(values.agents).toMatchObject([{ model: 'opus', effort: 'medium', observedModel: 'claude-opus-5-5', status: 'running' }])
})

test('HUD checks real destinations for listing, touched names, directory links, cwd aliases and link traversal', OFF, async ($, on) => {
  const files: Record<string, string> = { '/repo/.crew/plans/live.md': hudText, '/repo/.crew/plans/outside.md': hudText }
  let directoryLink = false
  const read: string[] = []
  mock.clock(on)
  on('session.cwd', () => ({ value: '/alias' }))
  on('session.root', () => ({ value: '/alias' }))
  on('fs.stat', (_$, e) => {
    const path = e.path as string
    if (path === '/alias') return { value: { kind: 'dir', isLink: true, realPath: '/repo' } } as never
    if (path === '/alias/.crew/plans') return { value: { kind: 'dir', isLink: directoryLink, realPath: '/repo/.crew/plans' } } as never
    if (path === '/alias/.crew/plans/live.md') return { value: { kind: 'file', isLink: false, realPath: '/repo/.crew/plans/live.md' } } as never
    if (path === '/alias/.crew/plans/outside.md') return { value: { kind: 'file', isLink: true, realPath: '/outside/secret.md' } } as never
    if (path.includes('bridge/../')) return { value: { kind: 'file', isLink: false, realPath: '/outside/secret.md' } } as never
    throw new Error('ENOENT')
  })
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.list', () => ({ value: [
    { name: 'outside.md', kind: 'other', isLink: true }, { name: 'live.md', kind: 'file', isLink: false },
  ] }) as never)
  on('fs.read', (_$, e) => { read.push(e.path); return { value: files[e.path.replace('/alias/', '/repo/')]! } })
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'written' }))
  const values = hudCapture(on)
  await $.session.start({ cwd: '/alias', surface: 'terminal', isInteractive: true } as never)
  await flush()
  expect(values.plans).toMatchObject([{ name: 'live' }])
  const edit = (file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' } as never)
  await edit('.crew/plans/outside.md')
  await edit('/alias/.crew/plans/bridge/../outside.md')
  expect(read).toEqual(['/alias/.crew/plans/live.md'])
  directoryLink = true
  await edit('.crew/plans/live.md')
  expect(read).toEqual(['/alias/.crew/plans/live.md'])
})

test('HUD publishes loading for a pending first read, unknown on read failure, and clears a proven removal', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  let present = true
  let fail = true
  let listings = 0
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.root', () => ({ value: ROOT }))
  on('agent.list', () => ({ value: [] }) as never)
  // A removed plan rejects its stat without a usable code: only `exists` says it is gone.
  const files = (): Record<string, string> => present ? { [`${ROOT}/.crew/plans/live.md`]: hudText } : {}
  on('fs.stat', (_$, e) => ({ value: hudStat(e.path, files()) }) as never)
  on('fs.exists', (_$, e) => ({ value: e.path === `${ROOT}/.crew/plans/live.md` ? present : hudExists(e.path) }) as never)
  on('fs.list', () => (listings++, { value: present ? [{ name: 'live.md', kind: 'file', isLink: false }] : [] }) as never)
  on('fs.read', async () => { await held; if (fail) throw new Error('private error'); return { value: hudText } })
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'written' }))
  const values = hudCapture(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  for (let i = 0; i < 10 && !values.plans; i++) await pause()
  expect(values.plans).toEqual([{ state: 'loading' }])
  release()
  await flush()
  expect(values.plans).toEqual([{ state: 'unknown' }])
  fail = false
  await $.tool.call({ tool: 'Write', file_path: '.crew/plans/live.md', content: hudText } as never)
  expect(values.plans).toMatchObject([{ name: 'live' }])
  present = false
  await $.tool.call({ tool: 'Write', file_path: '.crew/plans/live.md', content: hudText } as never)
  // The periodic snapshot detects the disappearance without a new write.
  await clock.advance(5_000)
  await pause()
  expect({ listings, plans: values.plans }).toEqual({ listings: 3, plans: [] })
})

test('HUD initializes a nonzero clock at session start and again after session restart', OFF, async ($, on) => {
  let time = 1_800_000_000_000
  const clock = mock.clock(((name: string, ...rest: unknown[]) => (name === 'clock.now'
    ? undefined : (on as (...a: unknown[]) => unknown)(name, ...rest))) as On)
  on('clock.now', () => ({ value: time }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.stat', (_$, e) => ({ value: hudStat(e.path) }) as never)
  on('fs.exists', (_$, e) => ({ value: hudExists(e.path) }) as never)
  on('fs.list', () => ({ value: [] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  const values = hudCapture(on)
  const start = async () => { await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never); await flush() }
  await start()
  expect(values.now).toBe(time)
  await $.session.end({ reason: 'exit', sessionId: 'test-session' } as never)
  time += 3_600_000
  await start()
  expect(values.now).toBe(time)
  await clock.settle()
})

test('HUD session end forgets which agents ended, so the same ID spawned in the next session shows running', OFF, async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('turn.complete', () => ({ text: 'done' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  const values = hudCapture(on)
  await $.agent.spawn(spawnInput())
  await pause()
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  expect(values.agents).toMatchObject([{ id: 'a1', status: 'ended' }])
  await $.session.end({ reason: 'exit', sessionId: 'test-session' } as never)
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
  await pause()
  expect(values.agents).toMatchObject([{ id: 'a1', status: 'running' }])
})

test('HUD a clock reading that arrives after session end is not written', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const clock = mock.clock(((name: string, ...rest: unknown[]) => (name === 'clock.now'
    ? undefined : (on as (...a: unknown[]) => unknown)(name, ...rest))) as On)
  on('clock.now', async () => { await held; return { value: 1_800_000_000_000 } })
  on('session.cwd', () => ({ value: ROOT }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.stat', (_$, e) => ({ value: hudStat(e.path) }) as never)
  on('fs.exists', (_$, e) => ({ value: hudExists(e.path) }) as never)
  on('fs.list', () => ({ value: [] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  const values = hudCapture(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await flush()
  await $.session.end({ reason: 'exit', sessionId: 'test-session' } as never)
  release()
  await flush()
  expect(values.now).toBeUndefined()
  await clock.settle()
})

test('HUD asks the host for the real destination of every path it stats', OFF, async ($, on) => {
  const asked: boolean[] = []
  mock.clock(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.stat', (_$, e) => (asked.push(e.resolve), { value: hudStat(e.path, { [`${ROOT}/.crew/plans/live.md`]: hudText }) }) as never)
  on('fs.exists', (_$, e) => ({ value: hudExists(e.path, { [`${ROOT}/.crew/plans/live.md`]: hudText }) }) as never)
  on('fs.list', () => ({ value: [{ name: 'live.md', kind: 'file', isLink: false }] }) as never)
  on('fs.read', () => ({ value: hudText }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  const values = hudCapture(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await flush()
  expect(asked.length).toBeGreaterThan(0)
  expect(asked.every(resolve => resolve)).toBe(true)
  expect(values.plans).toMatchObject([{ name: 'live' }])
})

test('HUD redacts a plan name with the home taken from the session directory', OFF, async ($, on) => {
  const cwd = '/Users/jane/app'
  const file = `${cwd}/.crew/plans/jane.md`
  mock.clock(on)
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: cwd }))
  on('fs.stat', (_$, e) => ({ value: e.path === file ? { kind: 'file', isLink: false, realPath: file, size: 1, mtimeMs: 0 }
    : { kind: 'dir', isLink: false, realPath: e.path, size: 0, mtimeMs: 0 } }) as never)
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [{ name: 'jane.md', kind: 'file', isLink: false }] }) as never)
  on('fs.read', () => ({ value: hudText }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  const values = hudCapture(on)
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true } as never)
  await flush()
  expect(JSON.stringify(values.plans)).toContain('Delivery')
  expect(JSON.stringify(values.plans)).not.toContain('jane')
})

test('HUD held agent state and clock never delay routing bind, decision or confirmation', ON, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const { seen } = jevWorld(on, { stepModel: 'claude-sonnet-5-5' })
  on('state.set', (_$, e, next) => e.key === 'agents' ? held.then(() => next(e)) : next(e))
  const result = await $.agent.spawn(spawnInput())
  expect(result).toMatchObject({ agentId: 'a1' })
  expect(record(seen)).toMatchObject({ bind: 'applied' })
  await step($, 'a1', 'high')
  expect(seen.transcript).toHaveLength(1)
  expect(record(seen, 1)).toMatchObject({ ran: { model: 'claude-sonnet-5-5' } })
  release()
})

test('HUD held clock does not delay the spawn decision or API confirmation', ON, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const { seen } = jevWorld(on, { stepModel: 'claude-sonnet-5-5', now: () => 1_800_000_000_000 })
  // Replace the registered mock only for subsequent HUD calls with a held clock result.
  on('state.set', (_$, e, next) => e.key === 'now' ? held.then(() => next(e)) : next(e))
  await $.agent.spawn(spawnInput())
  expect(record(seen)).toMatchObject({ bind: 'applied' })
  await step($, 'a1', 'high')
  expect(seen.transcript).toHaveLength(1)
  release()
})

test('HUD old spawn cannot replace a restarted job with the same ID', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  let count = 0
  mock.clock(on)
  on('agent.spawn', async () => { if (++count === 1) await held; return { agentId: 'a1', model: count === 1 ? 'sonnet' : 'opus' } })
  on('turn.complete', () => ({ text: 'done' }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as never
  })
  const values = hudCapture(on)
  const old = $.agent.spawn(spawnInput())
  await pause()
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2', subagentType: 'crew:challenger' }))
  await step($, 'a1', 'medium', 'opus')
  release()
  await old
  await pause()
  expect(values.agents).toMatchObject([{ type: 'crew:challenger', model: 'opus', effort: 'medium', status: 'running' }])
})

const fsFailure = (code: string, message: string) => Object.assign(new Error(message), { code })

test('HUD treats a plans directory that does not exist as no plan, silently, on start and after removal; other failures are unknown', OFF, async ($, on) => {
  let state: 'missing' | 'ok' | 'denied' = 'missing'
  const logs: string[] = []
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.root', () => ({ value: ROOT }))
  on('agent.list', () => ({ value: [] }) as never)
  on('ui.log', (_$, e) => (logs.push(e.text), { value: undefined }))
  // The host rejects a missing path, and a hook sees that rejection without its `code`: only `exists` says it is absent.
  on('fs.exists', (_$, e) => ({ value: e.path === `${ROOT}/.crew/plans` ? state !== 'missing' : hudExists(e.path, { [`${ROOT}/.crew/plans/live.md`]: hudText }) }) as never)
  on('fs.stat', (_$, e) => {
    if (e.path === `${ROOT}/.crew/plans`) {
      if (state === 'missing') throw fsFailure('ENOENT', `ENOENT: no such file or directory, stat '${e.path}'`)
      if (state === 'denied') throw fsFailure('EACCES', `EACCES: permission denied, stat '${e.path}'`)
    }
    return { value: hudStat(e.path, { [`${ROOT}/.crew/plans/live.md`]: hudText }) } as never
  })
  on('fs.list', () => ({ value: [{ name: 'live.md', kind: 'file', isLink: false }] }) as never)
  on('fs.read', () => ({ value: hudText }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('tool.call', () => ({ result: 'written' }))
  const values = hudCapture(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await flush()
  expect(values.plans ?? []).toEqual([])
  state = 'ok'
  await $.tool.call({ tool: 'Write', file_path: '.crew/plans/live.md', content: hudText } as never)
  expect(values.plans).toMatchObject([{ name: 'live' }])
  state = 'missing'
  await clock.advance(5_000)
  expect(values.plans).toEqual([])
  state = 'denied'
  await clock.advance(5_000)
  expect(values.plans).toEqual([{ state: 'unknown' }])
  state = 'missing'
  await clock.advance(5_000)
  expect(values.plans).toEqual([])
  expect(logs.filter(line => line.startsWith('crew HUD:'))).toEqual(['crew HUD: plan refresh failed'])
})

test('HUD recovers unchanged plan bytes after directory and context failures', OFF, async ($, on) => {
  let fail = ''
  mock.clock(on)
  on('session.cwd', () => { if (fail === 'context') throw new Error('context failure'); return { value: ROOT } })
  on('session.root', () => { if (fail === 'context') throw new Error('context failure'); return { value: ROOT } })
  on('fs.stat', (_$, e) => {
    if (fail === 'directory' && e.path === `${ROOT}/.crew/plans`) throw fsFailure('EACCES', 'not readable')
    return { value: hudStat(e.path, { [`${ROOT}/.crew/plans/live.md`]: hudText }) } as never
  })
  on('fs.exists', (_$, e) => ({ value: hudExists(e.path, { [`${ROOT}/.crew/plans/live.md`]: hudText }) }) as never)
  on('fs.list', () => ({ value: [{ name: 'live.md', kind: 'file', isLink: false }] }) as never)
  on('fs.read', () => ({ value: hudText }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('tool.call', () => ({ result: 'written' }))
  const values = hudCapture(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await flush()
  const refresh = () => $.tool.call({ tool: 'Write', file_path: '.crew/plans/live.md', content: hudText } as never)
  for (const failure of ['directory', 'context']) {
    fail = failure
    // A second session.start refreshes without going through the Write observer's path validation.
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
    await flush()
    expect(values.plans).toEqual([{ state: 'unknown' }])
    fail = ''
    await refresh()
    expect(values.plans).toMatchObject([{ name: 'live' }])
  }
})

test('HUD proves a plan gone by its code or by exists, never by ENOENT appearing in a message or filename', OFF, async ($, on) => {
  let failure: string | undefined
  mock.clock(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.root', () => ({ value: ROOT }))
  const file = `${ROOT}/.crew/plans/ENOENT.md`
  on('fs.stat', (_$, e) => {
    if (failure && e.path === file) throw fsFailure(failure, `${failure}: cannot stat '${e.path}'`)
    return { value: hudStat(e.path, { [file]: hudText }) } as never
  })
  on('fs.exists', (_$, e) => ({ value: e.path === file ? failure !== 'ENOENT' && failure !== 'ENOTDIR' : hudExists(e.path) }) as never)
  on('fs.list', () => ({ value: [{ name: 'ENOENT.md', kind: 'file', isLink: false }] }) as never)
  on('fs.read', () => ({ value: hudText }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  const values = hudCapture(on)
  const refresh = async () => { await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never); await flush() }
  await refresh()
  expect(values.plans).toMatchObject([{ name: 'ENOENT' }])
  for (const code of ['EACCES', 'EHOSTREFUSED']) {
    failure = code
    await refresh()
    expect(values.plans).toEqual([{ state: 'unknown' }])
  }
  for (const code of ['ENOENT', 'ENOTDIR']) {
    failure = code
    await refresh()
    expect(values.plans).toEqual([])
  }
})

test('HUD bounds queued observations and drops them at completion and session end', OFF, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const clock = mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null,
      usage: { model: 'claude-sonnet-5-5' } } as never
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  let calls = 0
  const values: unknown[] = []
  on('state.set', (_$, e, next) => e.key === 'agents' ? (calls++, held.then(() => {
    values.push(e.value)
    return next(e)
  })) : next(e))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['idle'] }))
  await $.agent.spawn(spawnInput())
  for (let i = 0; i < 40; i++) await step($, 'a1', 'high')
  expect(calls).toBe(1)
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await $.session.end({ reason: 'exit', sessionId: 'test-session' } as never)
  release()
  await pause()
  expect(calls).toBeLessThan(4)
  expect(values.length).toBeLessThan(4)
  await clock.settle()
})

/**
 * An ended agent whose job observed `claude-sonnet-5-5`, then the hook's own state wiped as a reload wipes it
 * (session end resets it; the atom stays). `hold` delays agents writes from the call it names on; `gate` holds
 * the API answer of the steps after the first.
 */

async function endedThenReset($: Engine, on: On, hold?: { from: number; until: Promise<void> }, gate?: Promise<void>) {
  const values: Record<string, unknown> = {}
  let writes = 0
  on('state.set', (_$, e, next) => {
    values[e.key] = e.value
    return hold && e.key === 'agents' && writes++ >= hold.from ? hold.until.then(() => next(e)) : next(e)
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  let steps = 0
  const world = jevWorld(on, { stepModel: () => (steps++ === 0 ? 'claude-sonnet-5-5' : 'claude-opus-5-5'),
    stepWait: async () => { if (steps > 0) await gate } })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'low', 'sonnet')
  await pause()
  await $.turn.complete({ agentId: 'a1', answer: '', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await pause()
  expect(values.agents).toMatchObject([{ model: 'sonnet', effort: 'low', observedModel: 'claude-sonnet-5-5', status: 'ended' }])
  await $.session.end({ reason: 'exit', sessionId: 'test-session' } as never)
  return { values, ...world }
}

test('HUD restarts a persisted ended agent on its first step after a reload: new model and effort, no old observation, new clock', OFF, async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const { values, clock } = await endedThenReset($, on, undefined, gate)
  const first = (values.agents as { startedAt: number }[])[0]!.startedAt
  await clock.advance(100_000)
  const stepping = step($, 'a1', 'medium', 'opus')
  await pause()
  const [record] = values.agents as Record<string, unknown>[]
  expect(record).toMatchObject({ id: 'a1', type: 'crew:digger', model: 'opus', effort: 'medium', status: 'running' })
  expect(record).not.toHaveProperty('observedModel')
  expect(record?.startedAt).toBeGreaterThanOrEqual(first + 100_000)
  release()
  await stepping
  await pause()
  expect(values.agents).toMatchObject([{ model: 'opus', observedModel: 'claude-opus-5-5' }])
})

test('HUD keeps the restart when two steps of the new job coalesce behind a held write, with no model from the old job', OFF, async ($, on) => {
  let release: () => void = () => {}
  const until = new Promise<void>(resolve => { release = resolve })
  // The writes of the first job (spawn, step, answer, complete) pass; the new job's first write is held.
  const { values, clock } = await endedThenReset($, on, { from: 4, until })
  const first = (values.agents as { startedAt: number }[])[0]!.startedAt
  await clock.advance(100_000)
  await step($, 'a1', 'medium', 'opus')
  await step($, 'a1', 'medium', 'opus')
  release()
  await pause()
  await pause()
  const [record] = values.agents as Record<string, unknown>[]
  expect(record).toMatchObject({ model: 'opus', effort: 'medium', status: 'running' })
  expect(record).not.toHaveProperty('observedModel', 'claude-sonnet-5-5')
  expect(record?.startedAt).toBeGreaterThanOrEqual(first + 100_000)
})
