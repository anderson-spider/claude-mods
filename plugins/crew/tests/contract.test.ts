import { expect, test } from 'claude-code/testing'

import { HELPER_ROLES, LABEL, ROUTES, callerOf, helperReady, postStarting, runTurn, socketOf } from '../hooks/appserver'
import type { Probe, TurnRequest } from '../hooks/appserver'
import { contract } from '../helper/test/contract.mjs'

// The plugin's half of the contract with helper/helper.mjs, over the routes, roles, label and examples in
// helper/test/contract.mjs. The helper's half (`isCaller`, where the installed helper listens, the route table, the
// install scripts) runs the same file in helper/test/contract.test.mjs.

const isCaller = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)

test('callerOf produces the caller each shared example names, and never a shape marked as refused', () => {
  for (const example of contract.callers) expect(callerOf(example.agent)).toBe(example.caller)
  for (const input of [...contract.notCallers, ...contract.callers.map(example => example.agent)]) {
    expect(contract.notCallers).not.toContain(callerOf(input))
    expect(isCaller(callerOf(input))).toBe(true)
  }
  expect(callerOf('a'.repeat(contract.maxPart + 50))).toBe('a'.repeat(contract.maxPart))
})

test('socketOf points under the home where the helper is installed', () => {
  for (const home of contract.home) expect(socketOf(home)).toBe(`${home}/${contract.socketUnderHome}`)
})

test('ROUTES, the roles and the label are the ones the shared contract names', () => {
  expect(ROUTES).toEqual(contract.routes)
  expect([...HELPER_ROLES].sort()).toEqual([...contract.roles].sort())
  expect(LABEL).toBe(contract.label)
})

test('a /start body carries exactly the keys the helper reads', () => {
  const request: TurnRequest = { caller: 'a1', role: 'developer', repo: '/r', model: 'm', effort: 'low', instructions: 'i', prompt: 'p' }
  expect(Object.keys(request).sort()).toEqual([...contract.startRequest].sort())
})

test('the helper\'s shared examples are consumed: a finished poll is the answer text and a status makes the helper ready', async () => {
  const probe = (reply: (route: string) => unknown): Probe => ({
    fetch: async url => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(reply(url.replace('http://crew-codex', ''))) }),
    run: async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
  })
  const request: TurnRequest = { caller: 'a1', role: 'developer', repo: '/r', model: 'm', effort: 'low', instructions: 'i', prompt: 'p' }
  const turn = probe(route => (route === '/start' ? { status: 'started' } : contract.examples.pollOk))

  expect(await runTurn(turn, socketOf('/h'), request, () => false)).toEqual({ kind: 'text', text: 'done\n\n(crew: files changed: /r/a.ts)' })
  expect(await helperReady(probe(() => contract.examples.status), socketOf('/h'))).toEqual({ ready: true })
  expect(await postStarting(turn, socketOf('/h'), '/start', request)).toEqual({ status: 'started' })
})
