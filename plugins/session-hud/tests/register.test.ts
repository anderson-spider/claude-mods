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

test('the crew row reads the crew atoms: running helpers, the plans totals and the running steps', async ($, on) => {
  world(on, { crew: {
    plans: [{ name: 'p', groups: [{ heading: 'h', done: 7, running: 1, left: 1, unknownStates: false,
      steps: [{ id: 'L1', owner: 'main', after: [], state: 'implementing' }, { id: 'T1', owner: 'main', after: [], state: 'verified' }] }] }],
    agents: [{ id: 'a', type: 'crew:digger', model: 'haiku', status: 'running' }, { id: 'b', type: 'general-purpose', model: 'x', status: 'running' }],
  } })
  await start($)
  await flush()
  const ui = await $.ui.mount(band())
  const drawn = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('\n')
  expect(drawn).toContain('1 agent')
  expect(drawn).toContain('plan 7 done · 1 running · 1 left')
  expect(drawn).toContain('L1 main')
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
