import { expect, test } from 'claude-code/testing'

import { callerOf, socketOf } from '../hooks/helper'
import { contract } from '../helper/test/contract.mjs'

// The plugin's half of the contract with helper/helper.mjs, over the examples in
// helper/test/contract.mjs. The helper's half (`isCaller`, where the installed
// helper listens) runs the same file in helper/test/contract.test.mjs.

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
