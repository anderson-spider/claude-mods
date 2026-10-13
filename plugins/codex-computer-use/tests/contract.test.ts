import { expect, test } from 'claude-code/testing'

import { LABEL, callerOf, socketOf } from '../hooks/helper'
import { CHOICES, ROUTES } from '../hooks/model'
import type { ApproveReply, CallReply, ForgetReply, Held, ReleaseReply, ResetReply, SettingsReply, StatusReply } from '../hooks/model'
import { serve } from '../hooks/bridge'
import type { BridgeDeps } from '../hooks/bridge'
import { toAnswer } from '../hooks/presentation'
import { APPROVAL_MS, BRIDGE, LEASE_MINUTES, TOOL } from '../hooks/routing'
import { contract } from '../helper/test/contract.mjs'

import { TOOL as HOST_TOOL } from './helpers'

// The plugin's half of the contract with helper/helper.mjs, over the routes,
// choices, lease, label and examples in helper/test/contract.mjs. The helper's
// half (`isCaller`, where the installed helper listens, the route table, the
// install scripts) runs the same file in helper/test/contract.test.mjs.

test('callerOf produces the caller each shared example names', () => {
  for (const example of contract.callers) {
    const agent = example.agent

    expect(callerOf(example.session, agent)).toBe(example.caller)
  }
})

test('callerOf never exceeds the helper limit per part and keeps the agent part within it', () => {
  const long = 'a'.repeat(contract.maxPart + 50)

  expect(callerOf(long)).toBe('a'.repeat(contract.maxPart))
  expect(callerOf(long, long)).toBe(`${'a'.repeat(contract.maxPart)}/${'a'.repeat(contract.maxPart)}`)
})

test('callerOf never yields a shape the shared examples mark as refused', () => {
  const inputs = [...contract.notCallers, ...contract.callers.map(example => example.session)]

  for (const input of inputs) {
    expect(contract.notCallers).not.toContain(callerOf(input))
    expect(contract.notCallers).not.toContain(callerOf('s', input))
  }
})

test('socketOf points under the home where the helper is installed', () => {
  for (const home of contract.home) {
    expect(socketOf(home)).toBe(`${home}/${contract.socketUnderHome}`)
  }
})

test('ROUTES lists exactly the routes the shared contract names, by name and path', () => {
  expect(ROUTES).toEqual(contract.routes)
})

test('CHOICES lists exactly the choices the shared contract names, in order', () => {
  expect([...CHOICES]).toEqual([...contract.choices])
})

test('the lease the model is told is the lease the shared contract names', () => {
  expect(LEASE_MINUTES).toBe(contract.leaseMinutes)
})

test('the label hooks kickstart is the label the install scripts declare', () => {
  expect(LABEL).toBe(contract.label)
})

test('TOOL is the bridge as the engine names it, and the host tests use the same name the literal matcher spells', () => {
  expect(TOOL).toBe(`mcp__codex-computer-use__${BRIDGE}`)
  expect(HOST_TOOL).toBe(TOOL)
})

// `satisfies Keys<T>` fails to compile when a reply type has a field the sample lacks or the sample names one it lacks
// (tsc, not `claude plugin test`); the sample's keys are then compared with the key sets the helper's tests check its real replies against.
type Keys<T> = { [K in keyof T]-?: true }
type HeldBy<S extends Held['status']> = Extract<Held, { status: S }>

test('the reply types in model.ts have exactly the key sets the shared contract lists', () => {
  const ok = {
    call: { status: true, isError: true, content: true, notes: true } satisfies Keys<CallReply>,
    reset: { status: true, message: true } satisfies Keys<ResetReply>,
    approve: { status: true } satisfies Keys<ApproveReply>,
    release: { status: true, ended: true } satisfies Keys<ReleaseReply>,
    settings: { status: true, settings: true } satisfies Keys<SettingsReply>,
    forget: { status: true, bundleId: true, helper: true, codex: true } satisfies Keys<ForgetReply>,
    // The status report has no `status` field: the type only declares it undefined so a Failure narrows.
    status: { version: true, pid: true, callers: true, owners: true, settings: true } satisfies Keys<Omit<StatusReply, 'status'>>,
  } satisfies Record<keyof typeof ROUTES, object>
  const held = {
    needs_approval: { status: true, app: true } satisfies Keys<HeldBy<'needs_approval'>>,
    denied: { status: true, app: true } satisfies Keys<HeldBy<'denied'>>,
    busy: { status: true, app: true, owner: true, idleSeconds: true } satisfies Keys<HeldBy<'busy'>>,
    full: { status: true, message: true } satisfies Keys<HeldBy<'full'>>,
  } satisfies Record<Held['status'], object>
  const sorted = (sample: object) => Object.keys(sample).sort()

  expect(Object.keys(ok).sort()).toEqual(Object.keys(contract.routes).sort())
  expect(Object.fromEntries(Object.entries(ok).map(([route, sample]) => [route, sorted(sample)]))).toEqual(contract.replies.ok)
  expect(Object.fromEntries(Object.entries(held).map(([status, sample]) => [status, sorted(sample)]))).toEqual(contract.replies.held)
})

// What hooks reads of the `app` in a held reply is measured, not declared: each app below is a proxy that records the
// properties touched while the bridge and `toAnswer` handle the reply. A field the helper sends and nothing reads is
// in the contract's `sent` sets and not in `read`, so a later trim has the evidence in one place.
const recorded = (keys: readonly string[]) => {
  const reads = new Set<string>()
  const app = new Proxy(Object.fromEntries(keys.map(key => [key, key === 'canAlways' ? true : `${key}-value`])), {
    get: (target, key, receiver) => (typeof key === 'string' && reads.add(key), Reflect.get(target, key, receiver)),
  })

  return { app, reads: () => [...reads].sort() }
}

const sentKeys = (status: keyof typeof contract.replies.app) => [...contract.replies.app[status].always, ...contract.replies.app[status].sometimes]
const signal = { aborted: false } as AbortSignal

test('the bridge reads of the app a needs_approval reply names are the keys the shared contract lists as read', async () => {
  const approval = recorded(sentKeys('needs_approval'))
  const calls = [{ status: 'needs_approval', app: approval.app }, { status: 'ok', isError: false, content: [] }]
  const deps: BridgeDeps = {
    enabled: async () => true,
    sessionId: async () => 'sess-1',
    helper: (async (route: string) => (route === ROUTES.call ? calls.shift() : { status: 'ok' })) as unknown as BridgeDeps['helper'],
    ask: async () => 'session',
    limitMs: APPROVAL_MS,
  }

  // The bridge asks about the app (bundle id, name, whether "Always" is offered), approves it and runs the call again.
  await serve(deps, { tool_use_id: 't', code: 'x' }, signal)
  toAnswer({ status: 'needs_approval', app: approval.app as never })

  expect(approval.reads()).toEqual(contract.replies.app.needs_approval.read)
})

test('the answer to a denied or busy reply reads the displayName of its app and nothing else', () => {
  const denied = recorded(sentKeys('denied'))
  const busy = recorded(sentKeys('busy'))

  toAnswer({ status: 'denied', app: denied.app as never })
  toAnswer({ status: 'busy', app: busy.app as never, owner: 's2' })

  expect(denied.reads()).toEqual(contract.replies.app.denied.read)
  expect(busy.reads()).toEqual(contract.replies.app.busy.read)
})
