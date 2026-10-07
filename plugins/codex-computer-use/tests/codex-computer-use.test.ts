import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { MAX_APPROVALS, serve } from '../hooks/bridge'
import type { BridgeDeps } from '../hooks/bridge'
import { callerOf, post } from '../hooks/helper'
import type { Reply } from '../hooks/helper'
import { approvalWaitText, isOwnDesktopTool, limitMs, parseCommand, statusReport, toAnswer } from '../hooks/routing'

declare const setTimeout: (fn: () => void, ms: number) => unknown
const pause = (ms: number) => new Promise<void>(done => setTimeout(() => done(), ms))
const ran = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

const TOOL = 'mcp__codex-computer-use__codex_cu'
const OWN = 'mcp__computer-use__left_click'
const BAND = {
  plugin: 'codex-computer-use',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never

type Posted = { route: string; body: Record<string, unknown>; socketPath?: string }

/**
 * A fake helper behind curl: TextEdit needs approval until the caller answers,
 * Calculator is approved, and `get n` reads back what `set n=` stored per caller.
 */
const world = (on: On) => {
  const posted: Posted[] = []
  const allowed = new Map<string, string>()
  const vars = new Map<string, string>()
  const store = new Map<string, unknown>()

  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', () => ({ value: '/home/me' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'sleep') {
      await pause(5)
    }

    return { value: ran('') }
  })
  on('http.fetch', async (_$, e) => {
    const route = e.url.replace('http://codex-cu', '')
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    posted.push({ route, body, socketPath: e.init?.socketPath })
    const caller = String(body.caller)
    const code = String(body.code ?? '')
    const reply = (value: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(value) } })

    if (route === '/forget') {
      return body.app === 'Nowhere'
        ? reply({ status: 'error', message: 'no app found for "Nowhere"' })
        : reply({ status: 'ok', bundleId: 'com.apple.grapher', helper: true, codex: 'removed' })
    }

    if (route === '/approve') {
      allowed.set(`${caller}:${String(body.bundleId)}`, String(body.choice))

      return reply({ status: 'ok' })
    }

    if (route === '/call' && code.includes('TextEdit')) {
      const answer = allowed.get(`${caller}:com.apple.TextEdit`)

      if (answer === undefined) {
        return reply({ status: 'needs_approval', app: { bundleId: 'com.apple.TextEdit', displayName: 'TextEdit', canAlways: true } })
      }

      if (answer === 'deny') {
        return reply({ status: 'denied', app: { bundleId: 'com.apple.TextEdit', displayName: 'TextEdit' } })
      }
    }

    if (route === '/call' && code.includes('Calculator') && caller !== 'sess-1') {
      return reply({ status: 'busy', app: { bundleId: 'com.apple.calculator', displayName: 'Calculator' }, owner: 'sess-1', idleSeconds: 12 })
    }

    if (route === '/call') {
      const set = /^set n=(.*)$/.exec(code)

      if (set !== null) {
        vars.set(caller, set[1] ?? '')
      }

      const text = code === 'get n' ? (vars.get(caller) ?? 'undefined') : `ran ${code}`

      return reply({ status: 'ok', isError: false, content: [{ type: 'text', text }] })
    }

    return reply({ status: 'ok', ended: [] })
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['idle'] }))
  on('tool.call', { tool: OWN }, () => ({ result: 'clicked' }))

  return posted
}

const textOf = (result: { result?: unknown }) => (typeof result.result === 'string' ? result.result : JSON.stringify(result.result))

test('routing pieces: commands, own desktop tools, callers and answers', () => {
  expect(parseCommand('on')).toEqual({ kind: 'on' })
  expect(parseCommand(' OFF ')).toEqual({ kind: 'off' })
  expect(parseCommand('')).toEqual({ kind: 'status' })
  expect(parseCommand('auto-approve on')).toEqual({ kind: 'auto-approve', isOn: true })
  expect(parseCommand('auto-approve maybe')).toEqual({ kind: 'help' })
  expect(parseCommand('forget')).toEqual({ kind: 'forget' })
  expect(parseCommand('forget TextEdit')).toEqual({ kind: 'forget-app', app: 'TextEdit' })
  expect(parseCommand(' FORGET  Foo Bar ')).toEqual({ kind: 'forget-app', app: 'Foo Bar' })

  expect(isOwnDesktopTool('mcp__computer-use__screenshot')).toBe(true)
  expect(isOwnDesktopTool('mcp__remote-devices__computer_click')).toBe(true)
  expect(isOwnDesktopTool('enable__mcp__remote-devices__computer')).toBe(true)
  expect(isOwnDesktopTool('mcp__remote-devices__Claude_Browser__navigate')).toBe(false)
  expect(isOwnDesktopTool('mcp__claude-in-chrome__computer')).toBe(false)
  expect(isOwnDesktopTool('Bash')).toBe(false)

  expect(callerOf('sess-1')).toBe('sess-1')
  expect(callerOf('sess-1', 'agent 7')).toBe('sess-1/agent_7')

  expect(toAnswer({ status: 'busy', app: { bundleId: 'b', displayName: 'Calculator' }, owner: 'sess-2' }).result).toMatch(/in use by another/)
  expect(toAnswer({ status: 'denied', app: { bundleId: 'b', displayName: 'TextEdit' } }).isError).toBe(true)
  expect(toAnswer({ status: 'ok', isError: false, content: [{ type: 'text', text: '100' }], notes: [] })).toEqual({ result: '100' })
})

test('post speaks to the helper over its Unix socket and reports a missing helper as unreachable', async () => {
  const seen: { url: string; socketPath?: string }[] = []
  const run = async () => ran('')
  const reply = await post(
    { fetch: async (url, init) => (seen.push({ url, socketPath: init.socketPath }), Promise.reject(new Error('ECONNREFUSED'))), run },
    '/s.sock',
    '/call',
    { caller: 'x' },
  )

  expect(reply.status).toBe('unreachable')
  expect(seen).toEqual([{ url: 'http://codex-cu/call', socketPath: '/s.sock' }])

  const answered = await post({ fetch: async () => ({ status: 200, ok: true, headers: {}, text: '{"status":"ok","ended":[]}' }), run }, '/s.sock', '/release', {})
  expect(answered.status).toBe('ok')
})

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

test('limitMs reads minutes, falls back and caps', () => {
  expect(limitMs(undefined, 5)).toBe(300_000)
  expect(limitMs('abc', 5)).toBe(300_000)
  expect(limitMs(0, 5)).toBe(300_000)
  expect(limitMs(-3, 5)).toBe(300_000)
  expect(limitMs(NaN, 5)).toBe(300_000)
  expect(limitMs(0.5, 5)).toBe(30_000)
  expect(limitMs('12', 5)).toBe(720_000)
  expect(limitMs(1e9, 5)).toBe(86_400_000)
})

test('the bridge timeout describes the configured approval wait', { options: { approvalMinutes: 0.001 } }, async ($, on) => {
  world(on)

  const answer = await $.tool.call({ tool: TOOL, code: 'let app = await cua.getApp("TextEdit");' } as never)
  expect(answer.isError).toBe(true)
  expect(textOf(answer)).toBe('The person did not answer whether Codex may use TextEdit within 0.1 seconds; nothing was done with it.')
})

test('statusReport preserves unreachable and error reports', () => {
  expect(statusReport(true, { status: 'unreachable', message: 'no socket' })).toBe(
    'Route: Codex computer use (on)\nHelper: not reachable (no socket)',
  )
  expect(statusReport(false, { status: 'error', message: 'bad reply' })).toBe(
    'Route: Claude\'s own computer use (off)\nHelper: not reachable (bad reply)',
  )
})

test('statusReport preserves running helper, callers and auto-approve text', () => {
  const reply = {
    status: 'ok' as const, isError: false, content: [], version: '0.4.1',
    callers: [{ caller: 'sess-1', apps: ['TextEdit', 'Calculator'] }, { caller: 'sess-2', apps: [] }],
    settings: { autoApprove: true, always: [] },
  }
  expect(statusReport(true, reply)).toBe([
    'Route: Codex computer use (on)',
    'Helper: 0.4.1 running, 2 Codex session(s)',
    'Auto-approve: on (no questions)',
    '  sess-1: TextEdit, Calculator',
    '  sess-2: no apps',
  ].join('\n'))
  expect(statusReport(false, { status: 'ok', isError: false, content: [] })).toBe([
    'Route: Claude\'s own computer use (off)',
    'Helper: ? running, 0 Codex session(s)',
    'Auto-approve: off (asks first)',
  ].join('\n'))
})

test('approval wait text uses the configured minutes, singular and fractional durations', () => {
  expect(approvalWaitText(limitMs(5, 5))).toBe(' within 5 minutes')
  expect(approvalWaitText(limitMs(1, 5))).toBe(' within 1 minute')
  expect(approvalWaitText(limitMs(1.25, 5))).toBe(' within 1.3 minutes')
  expect(approvalWaitText(limitMs(0.5, 5))).toBe(' within 30 seconds')
  expect(approvalWaitText(1000)).toBe(' within 1 second')
})

const signal = { aborted: false } as AbortSignal
const bridgeInput = { tool_use_id: 'tool-1', code: 'let app = await cua.getApp("TextEdit");', title: 'Open editor', timeout_ms: 1000 }
const approval: Reply = { status: 'needs_approval', app: { bundleId: 'com.apple.TextEdit', displayName: 'TextEdit', canAlways: true } }
const ok: Reply = { status: 'ok', isError: false, content: [{ type: 'text', text: 'done' }] }

const bridgeDeps = (overrides: Partial<BridgeDeps>): BridgeDeps => ({
  enabled: async () => true,
  sessionId: async () => 'sess-1',
  helper: async () => { throw new Error('unexpected helper call') },
  ask: async () => { throw new Error('unexpected approval question') },
  limitMs: limitMs(undefined, 5),
  ...overrides,
})

test('serve refuses disabled calls before reading the session or reaching the helper', async () => {
  const answer = await serve(bridgeDeps({
    enabled: async () => false,
    sessionId: async () => { throw new Error('unexpected session read') },
  }), bridgeInput, signal)
  expect(answer).toEqual({
    result: 'codex-computer-use is off (/codex-cu off): use the default desktop route, or ask the person to type /codex-cu on.',
    isError: true,
  })
})

test('serve resets the caller and preserves the helper message and reset fallback', async () => {
  const posted: { route: string; body: unknown }[] = []
  const deps = bridgeDeps({ helper: async (route, body) => (posted.push({ route, body }), { ...ok, message: 'cleared' }) })
  expect(await serve(deps, { ...bridgeInput, reset: true, agentId: 'agent a' }, signal)).toEqual({ result: 'cleared' })
  expect(posted).toEqual([{ route: '/reset', body: { caller: 'sess-1/agent_a' } }])
  expect(await serve(bridgeDeps({ helper: async () => ok }), { ...bridgeInput, reset: true }, signal)).toEqual({ result: 'reset' })
})

test('serve asks for approval, sends the choice and retries the same call', async () => {
  for (const choice of ['session', 'always'] as const) {
    const posted: { route: string; body: unknown }[] = []
    let calls = 0
    const deps = bridgeDeps({
      helper: async (route, body) => {
        posted.push({ route, body })
        return route === '/call' && calls++ === 0 ? approval : ok
      },
      ask: async (question, receivedSignal) => {
        expect(question).toEqual({ id: 'tool-1', bundleId: 'com.apple.TextEdit', displayName: 'TextEdit', canAlways: true, who: 'subagent agent-a' })
        expect(receivedSignal).toBe(signal)
        return choice
      },
    })
    expect(await serve(deps, { ...bridgeInput, agentId: 'agent-a' }, signal)).toEqual({ result: 'done' })
    const body = { caller: 'sess-1/agent-a', code: bridgeInput.code, title: bridgeInput.title, timeout_ms: bridgeInput.timeout_ms }
    expect(posted).toEqual([
      { route: '/call', body },
      { route: '/approve', body: { caller: 'sess-1/agent-a', bundleId: 'com.apple.TextEdit', choice } },
      { route: '/call', body },
    ])
  }
})

test('serve records denial without retrying the code', async () => {
  const posted: { route: string; body: unknown }[] = []
  const deps = bridgeDeps({
    helper: async (route, body) => (posted.push({ route, body }), approval),
    ask: async () => 'deny',
  })
  expect(await serve(deps, bridgeInput, signal)).toEqual({
    result: 'The person did not allow Codex computer use to use TextEdit in this session. Do not use TextEdit through any other route; tell the person.',
    isError: true,
  })
  expect(posted.map(item => item.route)).toEqual(['/call', '/approve'])
  expect(posted[1]?.body).toEqual({ caller: 'sess-1', bundleId: 'com.apple.TextEdit', choice: 'deny' })
})

test('serve stops on an aborted question without approving or retrying', async () => {
  const routes: string[] = []
  const deps = bridgeDeps({ helper: async route => (routes.push(route), approval), ask: async () => 'aborted' })
  expect(await serve(deps, bridgeInput, signal)).toEqual({
    result: 'The person did not answer whether Codex may use TextEdit; nothing was done with it.', isError: true,
  })
  expect(routes).toEqual(['/call'])
})

test('serve timeout uses the configured limit and stops without approving or retrying', async () => {
  const routes: string[] = []
  const deps = bridgeDeps({
    helper: async route => (routes.push(route), approval),
    ask: async question => {
      expect(question.who).toBe('main session')
      return 'timeout'
    },
    limitMs: limitMs('2.5', 5),
  })
  expect(await serve(deps, bridgeInput, signal)).toEqual({
    result: 'The person did not answer whether Codex may use TextEdit within 2.5 minutes; nothing was done with it.', isError: true,
  })
  expect(routes).toEqual(['/call'])
})

test('serve stops after the existing maximum approval rounds', async () => {
  const routes: string[] = []
  let questions = 0
  const deps = bridgeDeps({
    helper: async route => (routes.push(route), approval),
    ask: async () => { questions++; return 'session' },
  })
  expect(await serve(deps, bridgeInput, signal)).toEqual({ result: 'codex-cu: too many approval rounds for one call.', isError: true })
  expect(questions).toBe(MAX_APPROVALS + 1)
  expect(routes).toEqual(Array.from({ length: MAX_APPROVALS + 1 }, () => ['/call', '/approve']).flat())
})
