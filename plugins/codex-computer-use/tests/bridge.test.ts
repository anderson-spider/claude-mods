import { expect, test } from 'claude-code/testing'

import { MAX_APPROVALS, serve } from '../hooks/bridge'
import type { BridgeDeps } from '../hooks/bridge'
import type { Reply } from '../hooks/model'
import { limitMs } from '../hooks/routing'

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
