import { expect, test } from 'claude-code/testing'
import { pause, loopHost, startSession } from './helpers'

test('the host shares the layout across execute, review and loop tools and resets it after loop closes', async ($, on) => {
  const host = loopHost(on)
  await startSession($)
  for (const [index, kind] of ['execute', 'review', 'loop', 'review'].entries()) {
    await $.tool.call({ tool: `mcp__codex-team__${kind}` as 'mcp__codex-team__execute', task: 'add X' })
    for (let i = 0; i < 100 && host.messages.length < index + 1; i++) await pause(1)
    expect(host.messages.length).toBe(index + 1)
    if (kind === 'loop') {
      for (let i = 0; i < 100 && host.argvs.filter(argv => argv[2] === 'close').length < 2; i++) await pause(1)
      expect(host.argvs.filter(argv => argv[2] === 'close')).toEqual([
        ['herdr', 'pane', 'close', 'w1:p4'],
        ['herdr', 'pane', 'close', 'w1:p5'],
      ])
    }
  }
  expect(host.argvs.filter(argv => argv[2] === 'split')).toEqual([
    ['herdr', 'pane', 'split', 'w1:p1', '--direction', 'down', '--cwd', '/proj', '--no-focus'],
    ['herdr', 'pane', 'split', 'w1:p2', '--direction', 'right', '--cwd', '/proj', '--no-focus'],
    ['herdr', 'pane', 'split', 'w1:p3', '--direction', 'right', '--cwd', '/proj', '--no-focus'],
    ['herdr', 'pane', 'split', 'w1:p4', '--direction', 'right', '--cwd', '/proj', '--no-focus'],
    ['herdr', 'pane', 'split', 'w1:p1', '--direction', 'down', '--cwd', '/proj', '--no-focus'],
  ])
})

test('loop tool registers its schema, lists the parent and publishes one final report', async ($, on) => {
  const host = loopHost(on)
  await startSession($)
  expect(host.tools.loop).toEqual({
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The whole task, self-contained.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Optional files or folders Codex should start from.' },
      maxRounds: { type: 'integer', minimum: 1, default: 3, description: 'Maximum dev and QA rounds.' },
    },
    required: ['task'],
  })
  const answer = await $.tool.call({ tool: 'mcp__codex-team__loop', task: 'add X' })
  expect(answer.result).toContain('Started loop-1')
  for (let i = 0; i < 100 && !host.messages.length; i++) await pause(1)
  expect(host.messages.length).toBe(1)
  expect(host.messages[0]).toContain('loop-1 approved')
  expect(host.messages[0]).toContain('Rounds: 1/3')
  expect(host.messages[0]).toContain('/tmp/codex-team/loop-1.md')
  expect(host.files['/tmp/codex-team/loop-1.md']).toContain('Status: approved')
  expect((await $.tool.call({ tool: 'mcp__codex-team__jobs' })).result).toContain('loop-1 approved 1/3')
  expect((await $.tool.call({ tool: 'mcp__codex-team__jobs', id: 1 })).result).toContain('QA: ct-1-qa')
  expect((await $.command.run({ command: 'codex-team', args: '' })).text).toContain('loop-1 approved 1/3')
  expect((await $.tool.call({ tool: 'mcp__codex-team__jobs', id: 1, action: 'cancel' })).result).toContain('nothing to cancel')
})

test('jobs cancels an active loop by its shared id and the band includes its round', async ($, on) => {
  let release = () => {}
  const host = loopHost(on, new Promise<void>(done => (release = done)))
  await startSession($)
  await $.tool.call({ tool: 'mcp__codex-team__loop', task: 'add X', maxRounds: 2 })
  for (let i = 0; i < 100 && host.prompts() < 2; i++) await pause(1)
  await host.clock.advance(1000)
  expect(host.rows()).toContainEqual(expect.objectContaining({ id: 'loop-1', kind: 'loop', status: 'reviewing', round: 1, maxRounds: 2 }))
  const answer = await $.tool.call({ tool: 'mcp__codex-team__jobs', id: 1, action: 'cancel' })
  expect(answer.result).toContain('cancelled')
  expect(host.argvs.some(argv => argv[2] === 'send-keys' && argv[3] === 'ct-1-qa' && argv[4] === 'esc')).toBe(true)
  release()
  for (let i = 0; i < 100 && !host.messages.length; i++) await pause(1)
  expect(host.messages.length).toBe(1)
  expect(host.messages[0]).toContain('loop-1 cancelled')
  expect(host.prompts()).toBe(2)
})

test('loop tool rejects invalid inputs before starting a child', async ($, on) => {
  const host = loopHost(on)
  await startSession($)
  const answer = await $.tool.call({ tool: 'mcp__codex-team__loop', task: 'add X', maxRounds: 0 })
  expect(answer.isError).toBe(true)
  expect(answer.result).toContain('integer at least 1')
  expect(host.prompts()).toBe(0)
})

test('blocked standalone execute and review submit a message to the lead once per episode', async ($, on) => {
  const host = loopHost(on, undefined, { prompt: ['blocked', 'blocked'], wait: ['idle', 'idle'] })
  await startSession($)
  for (const kind of ['execute', 'review']) {
    await $.tool.call({ tool: `mcp__codex-team__${kind}` as 'mcp__codex-team__execute', task: 'add X' })
    for (let i = 0; i < 100 && host.messages.length < (kind === 'execute' ? 2 : 4); i++) await pause(1)
  }
  const blocked = host.messages.filter(message => message.includes('blocked'))
  expect(blocked.length).toBe(2)
  for (const [index, text] of blocked.entries()) {
    expect(text).toContain(`ct-${index + 1}`)
    expect(text).toContain(`pane w1:p${index + 2}`)
    expect(text).toContain('The person must answer in the pane')
    expect(text).toContain('The lead must NOT answer for them')
  }
})

test('blocked loop phases tell the lead the parent and pane once per blocked episode', async ($, on) => {
  const host = loopHost(on, undefined, { prompt: ['blocked', 'blocked'], wait: ['working', 'blocked', 'idle', 'idle'] })
  await startSession($)
  await $.tool.call({ tool: 'mcp__codex-team__loop', task: 'add X' })
  for (let i = 0; i < 100 && !host.messages.some(text => text.includes('loop-1 approved')); i++) await pause(1)
  const blocked = host.messages.filter(message => message.includes('blocked'))
  expect(blocked.length).toBe(3)
  expect(blocked[0]).toContain('ct-1-dev')
  expect(blocked[2]).toContain('ct-1-qa')
  for (const [index, text] of blocked.entries()) {
    expect(text).toContain('loop-1')
    expect(text).toContain(index === 2 ? 'pane w1:p3' : 'pane w1:p2')
    expect(text).toContain('The person must answer in the pane')
    expect(text).toContain('The lead must NOT answer for them')
  }
  expect(host.messages.filter(message => !message.includes('blocked')).length).toBe(1)
})
