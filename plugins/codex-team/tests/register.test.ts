import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { agent, pause, loopHost, startSession } from './helpers'
import type { BandJob } from '../types'

test('the host shares the layout across execute, review and loop tools and resets it after each close', async ($, on) => {
  const host = loopHost(on)
  await startSession($)
  for (const [index, kind] of ['execute', 'review', 'loop', 'review'].entries()) {
    await $.tool.call({ tool: `mcp__codex-team__${kind}` as 'mcp__codex-team__execute', task: 'add X' })
    for (let i = 0; i < 100 && host.messages.length < index + 1; i++) await pause(1)
    expect(host.messages.length).toBe(index + 1)
    if (kind === 'loop') {
      for (let i = 0; i < 100 && host.argvs.filter(argv => argv[2] === 'close').length < 4; i++) await pause(1)
      expect(host.argvs.filter(argv => argv[2] === 'close')).toEqual([
        ['herdr', 'pane', 'close', 'w1:p2'],
        ['herdr', 'pane', 'close', 'w1:p3'],
        ['herdr', 'pane', 'close', 'w1:p4'],
        ['herdr', 'pane', 'close', 'w1:p5'],
      ])
    }
  }
  // Each finished standalone job closed its pane, so the next one opened below the lead again.
  expect(host.argvs.filter(argv => argv[2] === 'split')).toEqual([
    ['herdr', 'pane', 'split', 'w1:p1', '--direction', 'down', '--cwd', '/proj', '--no-focus'],
    ['herdr', 'pane', 'split', 'w1:p1', '--direction', 'down', '--cwd', '/proj', '--no-focus'],
    ['herdr', 'pane', 'split', 'w1:p1', '--direction', 'down', '--cwd', '/proj', '--no-focus'],
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

const isNotify = (argv: string[]) => argv[1] === 'notification' && argv[2] === 'show'
const isAnnotate = (argv: string[]) => argv[1] === 'pane' && argv[2] === 'report-metadata'

test('a blocked standalone job tells Herdr once and labels its pane, and a finished job tells Herdr nothing', async ($, on) => {
  const host = loopHost(on, undefined, { prompt: ['blocked'], wait: ['idle'] })
  await startSession($)
  await $.tool.call({ tool: 'mcp__codex-team__execute', task: 'add X' })
  for (let i = 0; i < 100 && host.messages.length < 2; i++) await pause(1)
  expect(host.messages.length).toBe(2)
  expect(host.argvs.filter(isNotify)).toEqual([
    ['herdr', 'notification', 'show', 'codex-team: ct-1 needs you', '--body', 'pane w1:p2', '--sound', 'request'],
  ])
  const annotations = host.argvs.filter(isAnnotate)
  expect(annotations.length).toBe(1)
  expect(annotations[0]).toEqual(expect.arrayContaining(['w1:p2', '--title', 'ct-1 execute', '--state-label', 'blocked=needs you', '--ttl-ms', '1800000']))
})

test('a job that finishes without blocking tells Herdr nothing', async ($, on) => {
  const host = loopHost(on)
  await startSession($)
  await $.tool.call({ tool: 'mcp__codex-team__execute', task: 'add X' })
  for (let i = 0; i < 100 && host.messages.length < 1; i++) await pause(1)
  expect(host.messages.length).toBe(1)
  expect(host.messages[0]).toContain('job ct-1 done')
  expect(host.argvs.filter(isNotify)).toEqual([])
  expect(host.argvs.filter(isAnnotate)).toEqual([])
})

test('each blocked loop phase tells Herdr once, titled by its loop pane', async ($, on) => {
  const host = loopHost(on, undefined, { prompt: ['blocked', 'blocked'], wait: ['working', 'blocked', 'idle', 'idle'] })
  await startSession($)
  await $.tool.call({ tool: 'mcp__codex-team__loop', task: 'add X' })
  for (let i = 0; i < 100 && !host.messages.some(text => text.includes('loop-1 approved')); i++) await pause(1)
  const notices = host.argvs.filter(isNotify)
  expect(notices.map(argv => argv[3])).toEqual([
    'codex-team: loop-1 ct-1-dev needs you',
    'codex-team: loop-1 ct-1-dev needs you',
    'codex-team: loop-1 ct-1-qa needs you',
  ])
  const annotations = host.argvs.filter(isAnnotate)
  expect(annotations.length).toBe(3)
  expect(annotations[0]).toEqual(expect.arrayContaining(['w1:p2', '--title', 'loop-1 dev']))
  expect(annotations[2]).toEqual(expect.arrayContaining(['w1:p3', '--title', 'loop-1 qa']))
})

// loopHost answers process.run itself, and the engine allows one handler per hook, so this host answers the herdr
// calls of one blocked standalone job and makes every notification fail.
function failingNotifyHost(on: On) {
  mock.clock(on)
  mock.env(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', TMPDIR: '/tmp' })
  const messages: string[] = []
  const argvs: string[][] = []
  const files: Record<string, string> = {}
  const agents: { name: string; pane_id: string }[] = []
  let rows: BandJob[] = []
  let version = 0
  let panes = 1
  let prompts = 0
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codex-team__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('state.get', () => ({ value: { value: rows, version } }))
  on('state.set', (_$, e) => { rows = e.value as BandJob[]; return { value: { isSet: true as const, version: ++version } } })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_$, e) => { messages.push(e.text); return { text: e.text } })
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$, e) => { files[e.path] = e.text; return { value: undefined } })
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    argvs.push(argv)
    if (argv[1] === 'notification') throw new Error('herdr notification failed')
    let stdout = '{}'
    if (argv[1] === '--version') stdout = 'installed'
    if (argv[1] === 'pane' && argv[2] === 'split') stdout = JSON.stringify({ result: { pane: { pane_id: `w1:p${++panes}` } } })
    if (argv[1] === 'agent' && argv[2] === 'start') agents.push({ name: argv[3]!, pane_id: argv[7]! })
    if (argv[1] === 'agent' && argv[2] === 'list') stdout = JSON.stringify({ result: { agents } })
    if (argv[1] === 'agent' && argv[2] === 'prompt' && argv[4] !== '/stop') {
      files[argv[4]!.match(/write your final report as Markdown to (.+) and answer/)![1]!] = 'question'
      stdout = agent(prompts++ === 0 ? 'blocked' : 'idle')
    }
    if (argv[1] === 'agent' && argv[2] === 'wait') stdout = agent('idle')
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  return { messages, argvs }
}

test('a failing Herdr notification leaves the toast and the lead notice in place', async ($, on) => {
  const host = failingNotifyHost(on)
  await startSession($)
  await $.tool.call({ tool: 'mcp__codex-team__execute', task: 'add X' })
  for (let i = 0; i < 100 && (host.messages.length < 2 || !host.argvs.some(isAnnotate)); i++) await pause(1)
  expect(host.argvs.some(isNotify)).toBe(true)
  expect(host.messages.length).toBe(2)
  expect(host.messages[0]).toContain('ct-1 blocked in pane w1:p2')
  expect(host.argvs.filter(isAnnotate).length).toBe(1)
})
