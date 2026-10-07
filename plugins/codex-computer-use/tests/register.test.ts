import { expect, test } from 'claude-code/testing'

import { BAND, COMPOSE, OWN, TOOL, pause, textOf, world } from './helpers'

test('a busy app names its holder and when it is freed', async ($, on) => {
  const posted = world(on)

  const busy = await $.tool.call({ tool: TOOL, code: 'let app = await cua.getApp("Calculator");', agentId: 'agent-c' } as never)
  expect(textOf(busy)).toMatch(/in use by another Claude session or subagent \(sess-1, last call 12s ago\)/)
  expect(textOf(busy)).toMatch(/freed 2 minutes after/)
  expect(posted[0]?.socketPath).toBe('/home/me/.claude/mcp/codex-cu/run/helper.sock')
})

test('while on, Claude’s own desktop tools are refused; /codex-cu off restores them', async ($, on) => {
  world(on)

  const refused = await $.tool.call({ tool: OWN })
  expect(refused.deny).toMatch(/codex-computer-use is on/)

  await $.command.run({ command: 'codex-cu', args: 'off' } as never)
  const allowed = await $.tool.call({ tool: OWN })
  expect(allowed.deny).toBeUndefined()

  const bridge = await $.tool.call({ tool: TOOL, code: 'await cua.getState();' } as never)
  expect(textOf(bridge)).toMatch(/is off/)

  await $.command.run({ command: 'codex-cu', args: 'on' } as never)
  expect((await $.tool.call({ tool: OWN })).deny).toMatch(/codex-computer-use is on/)
})

test('the bridge keeps state per caller and gives each subagent its own session', async ($, on) => {
  const posted = world(on)

  await $.tool.call({ tool: TOOL, code: 'set n=100' } as never)
  expect(textOf(await $.tool.call({ tool: TOOL, code: 'get n' } as never))).toBe('100')
  expect(textOf(await $.tool.call({ tool: TOOL, code: 'get n', agentId: 'agent-a' } as never))).toBe('undefined')
  expect(posted.filter(item => item.route === '/call').map(item => item.body.caller)).toEqual(['sess-1', 'sess-1', 'sess-1/agent-a'])
})

test('a new app asks first: "This session" retries the call, "No" is respected', async ($, on) => {
  const posted = world(on)

  const allowed = $.tool.call({ tool: TOOL, code: 'let app = await cua.getApp("TextEdit");' } as never)
  await pause(50)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Codex computer use · Allow “TextEdit”?' })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(3)
  await ui.press({ key: 'session' })
  expect(textOf(await allowed)).toMatch(/ran let app/)
  expect(posted.find(item => item.route === '/approve')?.body).toEqual({ caller: 'sess-1', bundleId: 'com.apple.TextEdit', choice: 'session' })

  const refused = $.tool.call({ tool: TOOL, code: 'let app = await cua.getApp("TextEdit");', agentId: 'agent-b' } as never)
  await pause(50)
  await ui.press({ key: 'deny' })
  const answer = await refused
  expect(textOf(answer)).toMatch(/did not allow/)
  expect(posted.filter(item => item.route === '/call' && item.body.caller === 'sess-1/agent-b')).toHaveLength(1)
  await ui.unmount()
})

test('the system prompt explains the bridge only while the mod is on', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))

  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'codex-computer-use:route'])
  const route = composed.sections.at(-1)?.text ?? ''
  expect(route).toMatch(/performSecondaryAction\(<window index>, "Raise"\)/)
  expect(route).toMatch(/emit: false/)
  expect(route).toMatch(/least-change option/)

  await $.command.run({ command: 'codex-cu', args: 'off' } as never)
  const plain = await $.prompt.compose(COMPOSE)
  expect(plain.sections.map(section => section.id)).toEqual(['intro'])
})

test('/codex-cu forget <app> asks the helper to drop it from both always-allow lists and says what happened', async ($, on) => {
  const posted = world(on)

  const done = await $.command.run({ command: 'codex-cu', args: 'forget Grapher' } as never)
  expect(posted.at(-1)).toEqual({ route: '/forget', body: { app: 'Grapher' }, socketPath: '/home/me/.claude/mcp/codex-cu/run/helper.sock' })
  expect(done.text).toMatch(/Grapher \(com\.apple\.grapher\) is no longer always allowed/)
  expect(done.text).toMatch(/helper list: removed/)
  expect(done.text).toMatch(/Codex ComputerUseAppApprovals\.json: removed/)

  const failed = await $.command.run({ command: 'codex-cu', args: 'forget Nowhere' } as never)
  expect(failed.text).toMatch(/could not forget Nowhere: no app found/)
})

test('the bridge timeout describes the configured approval wait', { options: { approvalMinutes: 0.001 } }, async ($, on) => {
  world(on)

  const answer = await $.tool.call({ tool: TOOL, code: 'let app = await cua.getApp("TextEdit");' } as never)
  expect(answer.isError).toBe(true)
  expect(textOf(answer)).toBe('The person did not answer whether Codex may use TextEdit within 0.1 seconds; nothing was done with it.')
})
