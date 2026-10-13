import { expect, test } from 'claude-code/testing'

import { LABEL, callerOf, socketOf } from '../hooks/helper'
import { CHOICES, ROUTES } from '../hooks/model'
import { BRIDGE, LEASE_MINUTES, TOOL } from '../hooks/routing'
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
