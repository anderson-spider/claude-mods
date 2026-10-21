import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { USAGE, band, flush, listed, start, step, world } from './host'

test('the card draws the session as measured: model, effort, context, cache, both windows and the turn, and no money; the terminal draws no drawing and cuts what does not fit', async ($, on) => {
  world(on)
  await start($)
  await flush()
  await $.turn.start({ text: 'private prompt', turnId: 't1' } as never)
  await flush()
  await step($)
  await $.session.measure({ ...USAGE, cost: { usd: 4.59 }, changed: ['cost'] } as never)
  await $.turn.complete({ turnId: 't1', answer: 'private', durationMs: 5_000, isAborted: false, reason: 'answer' } as never)
  await flush()
  const ui = await $.ui.mount(band())
  const drawn = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('')
  expect(drawn).toContain('Opus 5.5')
  expect(drawn).toContain(' · medium')
  expect(drawn).toContain(' 20%')
  expect(drawn).toContain('cache 95%')
  expect(drawn).toContain('38m · ~85% at reset')
  expect(drawn).toContain('last turn 5s')
  expect(drawn).not.toContain('$')
  expect(drawn).not.toContain('private')
  expect((await ui.find({ type: 'Text', text: /^Opus 5\.5$/ }))?.props).toMatchObject({ color: '#d97757', bold: true })
  expect(drawn).toContain('▲ +5 in turn · 5 out')
  expect(drawn).not.toContain('sent')
  expect(await ui.findAll({ type: 'Svg' })).toEqual([])
  expect((await ui.find({ type: 'Text', text: /^Opus 5\.5$/ }))?.props).toMatchObject({ wrap: 'truncate-end' })
  await ui.unmount()
})

test('the head line names the workspace by repository, folder and branch, read again after a main turn and a directory change, never as a path', async ($, on) => {
  const { place } = world(on, { repo: { top: '/home/me/dev/mods', prefix: 'plugins/', gitDir: '/home/me/dev/mods/.git', common: '/home/me/dev/mods/.git', branch: 'main' } })
  place.cwd = '/home/me/dev/mods/plugins'
  await start($)
  await flush()
  const drawn = async () => {
    const ui = await $.ui.mount(band())
    const text = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('')
    await ui.unmount()
    return text
  }
  expect(await drawn()).toContain('Opus 5.5mods/plugins · ⎇ main')
  expect(await drawn()).not.toContain('/home/me')
  place.repo = { ...place.repo!, branch: 'me/feature' }
  await $.turn.start({ text: 'checkout', turnId: 't1' } as never)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1_000, isAborted: false, reason: 'answer' } as never)
  await flush()
  expect(await drawn()).toContain('mods/plugins · ⎇ me/feature')
  place.cwd = '/home/me/dev/mods-worktrees/feature'
  place.repo = { top: place.cwd, prefix: '', gitDir: '/home/me/dev/mods/.git/worktrees/feature', common: '/home/me/dev/mods/.git', branch: 'me/feature' }
  await $.classic.CwdChanged({ old_cwd: '/home/me/dev/mods/plugins', new_cwd: place.cwd } as never)
  await flush()
  expect(await drawn()).toContain('mods · ⎇ me/feature · worktree')
  place.cwd = '/home/me/notes'
  delete place.repo
  await $.classic.CwdChanged({ old_cwd: '/home/me/dev/mods-worktrees/feature', new_cwd: place.cwd } as never)
  await flush()
  const outside = await drawn()
  expect(outside).toContain('notes')
  expect(outside).not.toContain('⎇')
})

test('main-session edits and errors are counted after their result, which goes on unchanged; a subagent counts nothing', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => {
    const tool = (e as { tool?: string }).tool
    if (tool === 'Bash') return { result: 'failed', isError: true }
    if (tool === 'Write') return { deny: 'no' }
    return { result: 'ran' }
  })
  await start($)
  await flush()
  expect(await $.tool.call({ tool: 'Edit', file_path: '/proj/a.ts' } as never)).toEqual({ result: 'ran' })
  expect(await $.tool.call({ tool: 'Write', file_path: '/proj/b.ts' } as never)).toEqual({ deny: 'no' })
  expect(await $.tool.call({ tool: 'Bash', command: 'false' } as never)).toEqual({ result: 'failed', isError: true })
  expect(await $.tool.call({ tool: 'Edit', agentId: 'sub', file_path: '/proj/c.ts' } as never)).toEqual({ result: 'ran' })
  await flush()
  const ui = await $.ui.mount(band())
  const drawn = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('')
  expect(drawn).toContain('1 edit · 1 error')
  await ui.unmount()
})

test('the card reads only its own state and background work does not make its dot busy', async ($, on) => {
  world(on)
  const plugins: string[] = []
  on('state.get', (_$, e, next) => {
    plugins.push(e.plugin)
    if (e.plugin !== 'session-hud') throw new Error('unexpected foreign state')
    return next(e)
  })
  await start($)
  await flush()
  plugins.length = 0
  const ui = await $.ui.mount(band(110, false, true))
  const drawn = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('')
  expect(drawn).toContain('Opus 5.5')
  expect(drawn).toContain('0 edits · 0 errors')
  expect(drawn).not.toMatch(/agent|plan|working/u)
  expect((await ui.find({ type: 'Text', text: /^● $/u }))?.props).toMatchObject({ color: '#4fb383' })
  expect(plugins.length).toBeGreaterThan(0)
  expect(plugins.every(plugin => plugin === 'session-hud')).toBe(true)
  await ui.unmount()
})

test('a survey keeps the band, and a light theme paints with theme keys', async ($, on) => {
  world(on, { theme: 'light' })
  await start($)
  await flush()
  // Yielding to the survey leaves the band to what draws beneath.
  const survey = await $.ui.mount(band(110, true))
  expect((await survey.findAll({ type: 'Text' })).map(found => found.text)).toEqual(['beneath'])
  await survey.unmount()
  const ui = await $.ui.mount(band())
  expect((await ui.find({ type: 'Text', text: /^Opus 5\.5$/ }))?.props).toMatchObject({ color: 'claude', bold: true })
  await ui.unmount()
})

test('what draws beneath the band stays under the card', async ($, on) => {
  world(on)
  await start($)
  await flush()
  const ui = await $.ui.mount(band())
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.at(-1)).toBe('beneath')
  expect(texts.indexOf('Opus 5.5')).toBeLessThan(texts.length - 1)
  await ui.unmount()
})

test('the context is measured against the configured compaction window, read again after a setting changes', async ($, on) => {
  world(on, { window: 500_000 })
  await start($)
  await flush()
  const ui = await $.ui.mount(band())
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text).join('')).toContain('40%  200k / 500k')
  await ui.unmount()
})

test('a running turn shows its time, beating every second until it completes', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await flush()
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await flush()
  const running = await $.ui.mount(band(110, false, true))
  expect((await running.findAll({ type: 'Text' })).map(found => found.text).join('')).toContain('working 0s')
  await running.unmount()
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 3_000, isAborted: false, reason: 'answer' } as never)
  await flush()
  const idle = await $.ui.mount(band(110, false, true))
  const drawn = (await idle.findAll({ type: 'Text' })).map(found => found.text).join('')
  expect(drawn).not.toContain('working')
  expect(drawn).toContain('last turn 3s')
  await idle.unmount()
  void clock
})

test('a reload during a running turn keeps the turn and its time beating every second', async ($, on) => {
  const { clock } = world(on, { moving: true })
  await start($)
  await flush()
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await flush()
  // A reload loads a fresh module, holding none of the clocks the turn started, and `session.start` runs again.
  await $.session.end({ reason: 'other', sessionId: 's1' } as never)
  await start($)
  await flush()
  await clock.advance(2_000)
  const ui = await $.ui.mount(band(110, false, true))
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text).join('')).toContain('working 2s')
  await ui.unmount()
})

test('a turn the card holds shows as running only while the host says a turn runs', async ($, on) => {
  world(on)
  await start($)
  await flush()
  // A turn whose completion never reached the card: the card still holds it, and the host runs no turn.
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await flush()
  const idle = await $.ui.mount(band(110, false, false))
  expect((await idle.findAll({ type: 'Text' })).map(found => found.text).join('')).not.toContain('working')
  expect((await idle.find({ type: 'Text', text: /^● $/u }))?.props).toMatchObject({ color: '#4fb383' })
  await idle.unmount()
  const busy = await $.ui.mount(band(110, false, true))
  expect((await busy.findAll({ type: 'Text' })).map(found => found.text).join('')).toContain('working 0s')
  await busy.unmount()
})

const drawnOf = async ($: { ui: { mount: (e: never) => Promise<{ findAll: (q: object) => Promise<{ text: string }[]>; unmount: () => Promise<void> }> } }) => {
  const ui = await $.ui.mount(band(110, false, true))
  const drawn = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('')
  await ui.unmount()
  return drawn
}

test('a spawned subagent shows with its type, model and effort until its turn completes, and the spawn answer goes on unchanged', async ($, on) => {
  world(on)
  await start($)
  await flush()
  expect(await $.agent.spawn({ prompt: 'private task', description: 'private', subagentType: 'Explore', model: 'claude-haiku-4-5' } as never)).toEqual({ model: 'claude-haiku-4-5', agentId: 'agent-1' })
  expect(await $.agent.spawn({ prompt: 'private task' } as never)).toEqual({ model: 'claude-sonnet-4-5', agentId: 'agent-2' })
  await flush()
  const both = await drawnOf($)
  expect(both).toContain('2 agents: Explore Haiku 4.5, Sonnet 4.5')
  expect(both).not.toContain('private')
  await $.turn.start({ text: 'private task', turnId: 's1', agentId: 'agent-1' } as never)
  await step($, 'agent-1')
  await flush()
  expect(await drawnOf($)).toContain('2 agents: Explore Opus 5.5 · medium, Sonnet 4.5')
  await $.turn.complete({ turnId: 's1', agentId: 'agent-1', answer: 'private', durationMs: 1_000, isAborted: false, reason: 'answer' } as never)
  await flush()
  const one = await drawnOf($)
  expect(one).toContain('1 agent: Sonnet 4.5')
  expect(one).toContain('0 edits')
  expect(one).not.toContain('last turn')
})

test('a subagent turn does not start the main turn', async ($, on) => {
  world(on)
  await start($)
  await flush()
  await $.turn.start({ text: '', turnId: 's1', agentId: 'agent-9' } as never)
  await flush()
  const ui = await $.ui.mount(band())
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text).join('')).not.toContain('working')
  expect((await ui.find({ type: 'Text', text: /^● $/u }))?.props).toMatchObject({ color: '#4fb383' })
  await ui.unmount()
  expect(await drawnOf($)).toContain('1 agent: ?')
})

test('the agent list removes a subagent it shows completed, on the clock and after a main turn, and names the type it lists', async ($, on) => {
  const { clock, roster } = world(on)
  await start($)
  await flush()
  for (let i = 0; i < 3; i++) await $.agent.spawn({ prompt: 'task' } as never)
  await flush()
  expect(await drawnOf($)).toContain('3 agents: Sonnet 4.5 ×3')
  roster.push(listed('agent-1', 'completed'), listed('agent-2', 'running'))
  await clock.advance(30_000)
  await flush()
  expect(await drawnOf($)).toContain('2 agents: general-purpose Sonnet 4.5, Sonnet 4.5')
  roster.push(listed('agent-3', 'idle'))
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1_000, isAborted: false, reason: 'answer' } as never)
  await flush()
  const last = await drawnOf($)
  expect(last).toContain('1 agent: general-purpose Sonnet 4.5')
  expect(last).toContain('last turn 1s')
})

test('a subagent step answered by another model leaves the main session model, effort, cache and output as they were', async ($, on) => {
  world(on)
  await start($)
  await flush()
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await step($)
  await $.agent.spawn({ prompt: 'task', model: 'claude-haiku-4-5' } as never)
  await $.turn.start({ text: '', turnId: 's1', agentId: 'agent-1' } as never)
  await step($, 'agent-1', 'claude-haiku-4-5', 'low')
  await flush()
  const drawn = await drawnOf($)
  expect(drawn).toMatch(/^● Opus 5\.5 · medium · working/u)
  expect(drawn).toContain('cache 95%')
  expect(drawn).toContain('1 agent: Haiku 4.5 · low')
  expect(drawn).not.toMatch(/cache 0%/u)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1_000, isAborted: false, reason: 'answer' } as never)
  await flush()
  const done = await drawnOf($)
  expect(done).toContain('▲ +5 in turn · 5 out')
  expect(done).not.toContain('705')
})

test('the tokens every agent step processed add up on the head line, after the agent ends, and main-session steps add none', async ($, on) => {
  world(on)
  await start($)
  await flush()
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await step($)
  await flush()
  expect(await drawnOf($)).not.toContain('agents used')
  await $.agent.spawn({ prompt: 'task', model: 'claude-haiku-4-5' } as never)
  await $.turn.start({ text: '', turnId: 's1', agentId: 'agent-1' } as never)
  await step($, 'agent-1', 'claude-haiku-4-5')
  await step($, 'agent-1', 'claude-haiku-4-5')
  await flush()
  expect(await drawnOf($)).toContain('1 agent: Haiku 4.5 · mediumagents used 3k tokens')
  await $.turn.complete({ turnId: 's1', agentId: 'agent-1', answer: '', durationMs: 1_000, isAborted: false, reason: 'answer' } as never)
  await step($, 'agent-7', 'claude-sonnet-4-5')
  await flush()
  const after = await drawnOf($)
  expect(after).not.toContain('1 agent:')
  expect(after).toContain('agents used 5k tokens')
})

test('a refused spawn passes its deny unchanged and tracks nothing', async ($, on) => {
  world(on, { denySpawn: 'no agents here' })
  await start($)
  await flush()
  expect(await $.agent.spawn({ prompt: 'task' } as never)).toEqual({ deny: 'no agents here' })
  await flush()
  expect(await drawnOf($)).not.toContain('agent')
})

test('on the desktop the card is laid out as lines with short drawn bars, the last turn and the cache lifetime a model switch names', async ($, on) => {
  world(on)
  await start($)
  await flush()
  await $.classic.PostModelSwitch({ from_model: 'claude-sonnet-4-5', to_model: 'claude-opus-5-5', requested_model: 'opus', source: 'command',
    context_tokens: 0, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 0, pricing: 'catalog' } as never)
  await $.turn.start({ text: 'private prompt', turnId: 't1' } as never)
  await flush()
  await step($)
  await $.turn.complete({ turnId: 't1', answer: 'private', durationMs: 5_000, isAborted: false, reason: 'answer' } as never)
  await flush()
  const ui = await $.ui.mount({ ...(band() as object), surface: 'desktop' } as never)
  const drawn = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('')
  expect(drawn).toContain('Opus 5.5')
  expect(drawn).toContain('cache 95%')
  expect(drawn).toContain(' · used 0s ago')
  expect(drawn).toContain(' · 1h TTL, 1h 0m left')
  expect(drawn).toContain('▲ +5 in turn · 5 out')
  expect(drawn).toContain('last turn 5s · 1 turn')
  expect(drawn).not.toMatch(/private|\$/u)
  const drawings = await ui.findAll({ type: 'Svg' })
  expect(drawings.map(found => (found.props as { alt: string }).alt))
    .toEqual(['context 20% used', '5h 74% used', '7d 60% used'])
  expect(drawings.map(found => (found.props as { width: number }).width)).toEqual([96, 96, 96])
  await ui.unmount()
})

/** Two main-session turns, with `between` run after the first; the card as drawn after the second. */
const twoTurns = async ($: Engine, between: () => Promise<unknown>) => {
  for (const turnId of ['t1', 't2']) {
    await $.turn.start({ text: 'go', turnId } as never)
    await flush()
    await step($)
    await $.turn.complete({ turnId, answer: '', durationMs: 1_000, isAborted: false, reason: 'answer' } as never)
    await flush()
    if (turnId === 't1') await between()
  }
  return drawnOf($)
}

test("what was sent at a turn's start shows once the turn before it is known, and a switch to another model forgets the cache use", async ($, on) => {
  world(on)
  await start($)
  await flush()
  // The second turn begins at 1,100 tokens, 95 above where the first ended (1,005).
  expect(await twoTurns($, async () => undefined)).toContain('+95 sent · ▲ +5 in turn · 5 out')
  await $.classic.PostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-4-5', requested_model: 'sonnet', source: 'command',
    context_tokens: 0, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0, pricing: 'catalog' } as never)
  await flush()
  const drawn = await drawnOf($)
  expect(drawn).toContain('cache 95%')
  expect(drawn).not.toMatch(/used .* ago|TTL/u)
})

test("after a compaction the host reports, what was sent at the next turn's start is not known", async ($, on) => {
  world(on)
  await start($)
  await flush()
  const compacted = await twoTurns($, () => $.classic.PostCompact({ trigger: 'auto', compact_summary: 'private summary' } as never))
  expect(compacted).toContain('▲ +5 in turn · 5 out')
  expect(compacted).not.toMatch(/sent|private/u)
})

test('a subagent compaction leaves the main turns unmarked', async ($, on) => {
  world(on)
  await start($)
  await flush()
  expect(await twoTurns($, () => $.classic.PostCompact({ trigger: 'auto', compact_summary: '', agent_id: 'agent-9' } as never))).toContain('+95 sent')
})

test('with cacheTtl the card shows what is left of the cache from the first turn', { options: { cacheTtl: '1h' } }, async ($, on) => {
  world(on)
  await start($)
  await flush()
  await step($)
  await flush()
  const ui = await $.ui.mount(band())
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text).join('')).toContain(' · 1h TTL, 1h 0m left')
  await ui.unmount()
})

test("a model switch's lifetime replaces the cacheTtl option's", { options: { cacheTtl: '1h' } }, async ($, on) => {
  world(on)
  await start($)
  await flush()
  await $.classic.PostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-opus-5-5', requested_model: 'opus', source: 'command',
    context_tokens: 0, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0, pricing: 'catalog' } as never)
  await step($)
  await flush()
  const ui = await $.ui.mount(band())
  const drawn = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('')
  expect(drawn).toContain(' · 5m TTL, 5m left')
  expect(drawn).not.toContain('1h TTL')
  await ui.unmount()
})

test("a reload after a model switch keeps the host's lifetime and the cache's last use over the cacheTtl option", { options: { cacheTtl: '1h' } }, async ($, on) => {
  world(on)
  await start($)
  await flush()
  await $.classic.PostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-opus-5-5', requested_model: 'opus', source: 'command',
    context_tokens: 0, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0, pricing: 'catalog' } as never)
  await step($)
  await flush()
  // A changed option reloads the plugin, and `session.start` runs again.
  await start($)
  await flush()
  const ui = await $.ui.mount(band())
  const drawn = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('')
  expect(drawn).toContain(' · used 0s ago · 5m TTL, 5m left')
  expect(drawn).not.toContain('1h TTL')
  await ui.unmount()
})

test('without cacheTtl the lifetime waits for a model switch', async ($, on) => {
  world(on)
  await start($)
  await flush()
  await step($)
  await flush()
  const ui = await $.ui.mount(band())
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text).join('')).not.toContain('TTL')
  await ui.unmount()
})
