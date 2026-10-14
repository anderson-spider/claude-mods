import { expect, test } from 'claude-code/testing'
import { USAGE, band, flush, start, step, world } from './host'

test('the card draws the session as measured: model, effort, context, cache, cost, both windows and the turn', async ($, on) => {
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
  const drawn = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('\n')
  expect(drawn).toContain('Opus 5.5')
  expect(drawn).toContain(' · medium')
  expect(drawn).toContain(' 20%')
  expect(drawn).toContain('cache 95%')
  expect(drawn).toContain('$4.59')
  expect(drawn).toContain('38m left')
  expect(drawn).toContain('last turn 5s')
  expect(drawn).toContain('+$0.16')
  expect(drawn).not.toContain('private')
  expect((await ui.find({ type: 'Text', text: /^Opus 5\.5$/ }))?.props).toMatchObject({ color: '#d97757', bold: true })
  await ui.unmount()
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
  const drawn = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('\n')
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
  const drawn = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('\n')
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
  // Yielding to the survey leaves the band to the engine beneath, which a test has none of.
  await expect($.ui.mount(band(110, true))).rejects.toThrow(/no implementation for ui.render/u)
  const ui = await $.ui.mount(band())
  expect((await ui.find({ type: 'Text', text: /^Opus 5\.5$/ }))?.props).toMatchObject({ color: 'claude', bold: true })
  await ui.unmount()
})

test('the context is measured against the configured compaction window, read again after a setting changes', async ($, on) => {
  world(on, { window: 500_000 })
  await start($)
  await flush()
  const ui = await $.ui.mount(band())
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text).join('\n')).toContain('40% · 200k/500k')
  await ui.unmount()
})

test('a running turn shows its time, beating every second until it completes', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await flush()
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await flush()
  const running = await $.ui.mount(band())
  expect((await running.findAll({ type: 'Text' })).map(found => found.text).join('\n')).toContain('working 0s')
  await running.unmount()
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 3_000, isAborted: false, reason: 'answer' } as never)
  await flush()
  const idle = await $.ui.mount(band(110, false, true))
  const drawn = (await idle.findAll({ type: 'Text' })).map(found => found.text).join('\n')
  expect(drawn).not.toContain('working')
  expect(drawn).toContain('last turn 3s')
  await idle.unmount()
  void clock
})
