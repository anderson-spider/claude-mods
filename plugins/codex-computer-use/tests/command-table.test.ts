import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { HELP, parseCommand } from '../hooks/commands'
import { ran } from './helpers'

// Characterization of `/codex-cu`: how every input parses, the exact HELP text,
// the registered command description and how a command reaches a helper that is
// not running yet (kickstart, then up to twenty polls).

const HELP_TEXT = [
  '/codex-cu on            use Codex for native apps (default)',
  '/codex-cu off           restore Claude\'s desktop tools',
  '/codex-cu status        show route, helper and app owners',
  '/codex-cu auto-approve on|off   skip (on) or ask (off) for new apps',
  '/codex-cu forget        clear this session\'s app answers',
  '/codex-cu forget <app>  remove always-allow from helper and Codex; ask again',
].join('\n')

const DESCRIPTION_TEXT = 'Codex computer use: on | off | status | auto-approve on|off | forget [app]'

const run = ($: Engine, args: string) => $.command.run({ command: 'codex-cu', args } as never)

test('parse: every subcommand, its case and spacing, and what falls back to help', () => {
  const cases: [string, unknown][] = [
    ['', { kind: 'status' }],
    ['   ', { kind: 'status' }],
    ['status', { kind: 'status' }],
    [' STATUS ', { kind: 'status' }],
    ['status now', { kind: 'help' }],
    ['on', { kind: 'on' }],
    ['On', { kind: 'on' }],
    ['\ton\n', { kind: 'on' }],
    ['on now', { kind: 'help' }],
    ['off', { kind: 'off' }],
    [' OFF ', { kind: 'off' }],
    ['off  please', { kind: 'help' }],
    ['on off', { kind: 'help' }],
    ['auto-approve on', { kind: 'auto-approve', isOn: true }],
    ['auto-approve off', { kind: 'auto-approve', isOn: false }],
    ['  AUTO-APPROVE   ON ', { kind: 'auto-approve', isOn: true }],
    ['auto-approve On now', { kind: 'auto-approve', isOn: true }],
    ['auto-approve', { kind: 'help' }],
    ['auto-approve maybe', { kind: 'help' }],
    ['auto-approve 1', { kind: 'help' }],
    ['autoapprove on', { kind: 'help' }],
    ['forget', { kind: 'forget' }],
    ['  forget  ', { kind: 'forget' }],
    ['FORGET', { kind: 'forget' }],
    ['forget TextEdit', { kind: 'forget-app', app: 'TextEdit' }],
    ['forget\tTextEdit', { kind: 'forget-app', app: 'TextEdit' }],
    [' FORGET  Foo Bar ', { kind: 'forget-app', app: 'Foo Bar' }],
    ['Forget Foo   Bar', { kind: 'forget-app', app: 'Foo   Bar' }],
    ['forget /Applications/Foo Bar.app', { kind: 'forget-app', app: '/Applications/Foo Bar.app' }],
    ['forget com.apple.grapher', { kind: 'forget-app', app: 'com.apple.grapher' }],
    ['forget on', { kind: 'forget-app', app: 'on' }],
    ['forgetful', { kind: 'help' }],
    ['forget-app TextEdit', { kind: 'help' }],
    ['help', { kind: 'help' }],
    ['HELP me', { kind: 'help' }],
    ['bogus', { kind: 'help' }],
    ['/codex-cu on', { kind: 'help' }],
    ['--help', { kind: 'help' }],
  ]

  for (const [args, expected] of cases) {
    expect([args, parseCommand(args)]).toEqual([args, expected])
  }
})

test('HELP is the fixed six-line text and every unknown or malformed input answers it', async ($, on) => {
  commandWorld(on)

  expect(HELP).toBe(HELP_TEXT)

  for (const args of ['help', 'HELP', 'bogus', 'on now', 'off now', 'status now', 'auto-approve', 'auto-approve maybe', 'forget-app x']) {
    expect([args, (await run($, args)).text]).toEqual([args, HELP_TEXT])
  }
})

test('every subcommand reaches its own helper route with its own body', async ($, on) => {
  const { posted } = commandWorld(on)
  const last = () => posted.at(-1)?.slice(0, 2)

  await run($, 'status')
  expect(last()).toEqual(['/status', {}])
  await run($, '')
  expect(last()).toEqual(['/status', {}])
  await run($, 'auto-approve ON')
  expect(last()).toEqual(['/settings', { autoApprove: true }])
  await run($, 'Auto-Approve off')
  expect(last()).toEqual(['/settings', { autoApprove: false }])
  await run($, 'forget')
  expect(last()).toEqual(['/release', { caller: 'sess-1' }])
  await run($, 'FORGET  Text Edit')
  expect(last()).toEqual(['/forget', { app: 'Text Edit' }])

  const count = posted.length
  await run($, 'on')
  await run($, 'off')
  await run($, 'help')
  await run($, 'bogus')
  expect(posted).toHaveLength(count)
})

test('session start registers /codex-cu with the one-line command synopsis', async ($, on) => {
  const commands: { name: string; description: string }[] = []

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codex-computer-use__${e.name}` } }))
  on('command.register', (_$, e) => (commands.push(e as never), { value: { command: e.name } }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(commands).toEqual([{ name: 'codex-cu', description: DESCRIPTION_TEXT }])
})

// The helper's socket is not there yet: `post` answers unreachable, `launchctl`
// is asked to start it and the call is retried after each `sleep 0.25`.

test('a helper that answers needs no start: nothing is run', async ($, on) => {
  const { fetches, runs } = commandWorld(on, { reachableAt: 0 })

  expect((await run($, 'status')).text).toContain('Helper: 0.4.1 running')
  expect(fetches()).toBe(1)
  expect(runs).toEqual([])
})

test('an answer that is not JSON is an error, not an absent helper: no start is attempted', async ($, on) => {
  const { fetches, runs } = commandWorld(on, { badGateway: true })

  expect((await run($, 'status')).text).toContain('Helper: not reachable (the helper answered 502 with something that is not JSON: bad gateway)')
  expect(fetches()).toBe(1)
  expect(runs).toEqual([])
})

test('a kickstart that fails returns the first reply without polling', async ($, on) => {
  const { fetches, runs } = commandWorld(on, { reachableAt: -1, kickstartExit: 1 })

  expect((await run($, 'status')).text).toBe('Route: Codex computer use (on)\nHelper: not reachable (codex-computer-use: $.http.fetch: attempt 1)')
  expect(fetches()).toBe(1)
  expect(runs).toEqual([['/usr/bin/id', '-u'], ['/bin/launchctl', 'kickstart', 'gui/501/com.anderson-spider.codex-cu']])
})

for (const n of [1, 2, 7, 20]) {
  test(`a started helper that answers at poll ${n} gives that reply after ${n} polls`, async ($, on) => {
    const { fetches, runs } = commandWorld(on, { reachableAt: n })

    expect((await run($, 'status')).text).toContain('Helper: 0.4.1 running')
    expect(fetches()).toBe(n + 1)
    expect(runs.slice(2)).toEqual(Array.from({ length: n }, () => ['sleep', '0.25']))
    expect(runs.slice(0, 2)).toEqual([['/usr/bin/id', '-u'], ['/bin/launchctl', 'kickstart', 'gui/501/com.anderson-spider.codex-cu']])
  })
}

test('a helper that never starts gives the first reply after twenty polls', async ($, on) => {
  const { fetches, runs } = commandWorld(on, { reachableAt: -1 })

  expect((await run($, 'status')).text).toBe('Route: Codex computer use (on)\nHelper: not reachable (codex-computer-use: $.http.fetch: attempt 1)')
  expect(fetches()).toBe(21)
  expect(runs.filter(argv => argv[0] === 'sleep')).toEqual(Array.from({ length: 20 }, () => ['sleep', '0.25']))
  expect(runs).toHaveLength(22)
})

test('a start that rejects rejects the command: only session end swallows it', async ($, on) => {
  commandWorld(on, { reachableAt: -1, runFails: true })

  let failure: unknown
  try {
    await run($, 'status')
  } catch (error) {
    failure = error
  }

  expect(failure).toBeDefined()
})

/**
 * A helper that is unreachable until the `reachableAt`-th poll (0: always up,
 * -1: never up), with `launchctl` ending in `kickstartExit`.
 */
function commandWorld(
  on: On,
  options: { reachableAt?: number; kickstartExit?: number; runFails?: boolean; badGateway?: boolean } = {},
) {
  const posted: [string, Record<string, unknown>, string | undefined][] = []
  const runs: string[][] = []
  const reachableAt = options.reachableAt ?? 0
  let attempts = 0

  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/me' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', (_$, e) => {
    runs.push([...e.argv])

    if (options.runFails === true) {
      throw new Error('launchctl is gone')
    }

    if (e.argv[0] === '/usr/bin/id') {
      return { value: ran('501\n') }
    }

    return { value: ran('', e.argv[0] === '/bin/launchctl' ? (options.kickstartExit ?? 0) : 0) }
  })
  on('http.fetch', (_$, e) => {
    attempts++
    const route = e.url.replace('http://codex-cu', '')
    posted.push([route, JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>, e.init?.socketPath])

    if (options.badGateway === true) {
      return { value: { status: 502, ok: false, headers: {}, text: 'bad gateway' } }
    }

    if (reachableAt < 0 || attempts <= reachableAt) {
      return { deny: `attempt ${attempts}` }
    }

    const body = route === '/status' ? { version: '0.4.1', callers: [], settings: { autoApprove: false, always: [] } } : { status: 'ok', ended: [] }

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })

  return { posted, runs, fetches: () => attempts }
}
