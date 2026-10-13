import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { agents } from './register-world'

test('a write outside the agent\'s lane is denied, the main loop and other agents pass', async ($, on) => {
  on('agent.list', () => ({ value: agents }) as never)
  on('tool.call', () => ({ result: 'written' }))

  const call = (agentId: string | undefined, file_path: string) => $.tool.call({ tool: 'Write', agentId, file_path } as never)

  expect(await call('a1', 'src/app.ts')).toHaveProperty('deny')
  expect(await call('a1', '.crew/plans/plan.md')).not.toHaveProperty('deny')
  expect(await call('t1', 'src/app.ts')).toHaveProperty('deny')
  expect(await call('t1', 'tests/app.test.ts')).toHaveProperty('deny')
  expect(await call('d1', 'src/app.ts')).not.toHaveProperty('deny')
  expect(await call(undefined, 'src/app.ts')).not.toHaveProperty('deny')
})

// The write guard through the host, for both tools: a subagent is held by its type's rule, the main loop never.

for (const tool of ['Write', 'Edit'] as const) {
  const reads = { count: 0 }
  const guardHost = (on: On) => {
    reads.count = 0
    on('agent.list', () => (reads.count++, { value: agents }) as never)
    on('tool.call', () => ({ result: 'written' }))
  }
  const call = ($: Engine, agentId: string | undefined, file_path?: string) =>
    $.tool.call({ tool, ...(agentId ? { agentId } : {}), ...(file_path === undefined ? {} : { file_path }) } as never)

  test(`${tool}: the architect is held to Markdown under .crew, with the reason and the path`, async ($, on) => {
    guardHost(on)

    expect(await call($, 'a1', 'src/app.ts')).toEqual({
      deny: 'the architect writes plan and review documents under .crew/ (.md) only, not src/app.ts; hand the finding to the developer',
    })
    expect(await call($, 'a1', '.crew/plans/plan.md')).toEqual({ result: 'written' })
    expect(await call($, 'a1', '.crew/app.ts')).toHaveProperty('deny')
    // A call without a path is read as an empty path.
    expect(await call($, 'a1')).toEqual({
      deny: 'the architect writes plan and review documents under .crew/ (.md) only, not ; hand the finding to the developer',
    })
  })

  test(`${tool}: a removed role has no lane, even for former test and review paths`, async ($, on) => {
    guardHost(on)
    for (const path of ['src/app.ts', 'tests/app.test.ts', '.crew/reviews/check.md', '.crew/reviews/../plans/a.md']) {
      expect(await call($, 't1', path)).toEqual({
        deny: `crew:tester is not a crew agent with a known lane, so its write to ${path} was not made`,
      })
    }
  })

  test(`${tool}: other agents, ids the list does not name and the main loop pass; the main loop never reads the list`, async ($, on) => {
    guardHost(on)

    expect(await call($, 'd1', 'src/app.ts')).toEqual({ result: 'written' })
    expect(await call($, 'ghost', 'src/app.ts')).toEqual({ result: 'written' })
    expect(reads.count).toBe(2)

    expect(await call($, undefined, 'src/app.ts')).toEqual({ result: 'written' })
    expect(reads.count).toBe(2)
  })

  for (const failure of ['denied', 'throwing'] as const) {
    test(`${tool}: a ${failure} agent-list check holds subagent writes, while the main loop still passes`, async ($, on) => {
      const written: string[] = []
      on('agent.list', () => {
        if (failure === 'throwing') throw new Error('list unavailable')
        return { deny: 'list unavailable' } as never
      })
      on('tool.call', (_$, e) => (written.push(String((e as { file_path?: unknown }).file_path)), { result: 'written' }))

      expect(await call($, 'a1', 'src/app.ts')).toEqual({ deny: 'crew could not check this write, so it was not made' })
      expect(await call($, 'd1', '.crew/plans/plan.md')).toEqual({ deny: 'crew could not check this write, so it was not made' })
      expect(written).toEqual([])
      expect(await call($, undefined, 'src/app.ts')).toEqual({ result: 'written' })
      expect(written).toEqual(['src/app.ts'])
    })
  }

  test(`${tool}: a failure below a passed write reaches the caller as it came, never as the guard's deny`, async ($, on) => {
    on('agent.list', () => ({ value: agents }) as never)
    on('tool.call', () => { throw new Error('disk full') })

    // The hook below failed, so the host has no answer for the call: the guard does not answer in its place.
    await expect(call($, 'd1', 'src/app.ts')).rejects.toThrow()
    await expect(call($, undefined, 'src/app.ts')).rejects.toThrow()
  })
}

test('the guard answers only Write and Edit: another tool of a subagent passes without reading the list', async ($, on) => {
  let reads = 0
  on('agent.list', () => (reads++, { value: agents }) as never)
  on('tool.call', () => ({ result: 'ran' }))

  expect(await $.tool.call({ tool: 'Bash', agentId: 'a1', command: 'ls' } as never)).toEqual({ result: 'ran' })
  expect(await $.tool.call({ tool: 'Read', agentId: 'a1', file_path: 'src/app.ts' } as never)).toEqual({ result: 'ran' })
  expect(reads).toBe(0)
})

const codexAgents = [
  { id: 'ar1', type: 'crew:architect-codex' },
  { id: 'de1', type: 'crew:developer-codex' },
  { id: 'xx1', type: 'crew:mystery-codex' },
]

for (const tool of ['Write', 'Edit'] as const) {
  test(`${tool}: each -codex twin is held to its base role's lane, and an unknown crew -codex type is held`, async ($, on) => {
    on('agent.list', () => ({ value: codexAgents }) as never)
    on('tool.call', () => ({ result: 'written' }))
    const call = (agentId: string, file_path: string) => $.tool.call({ tool, agentId, file_path } as never)

    expect(await call('ar1', 'src/app.ts')).toHaveProperty('deny')
    expect(await call('ar1', '.crew/plans/plan.md')).toEqual({ result: 'written' })
    expect(await call('de1', 'src/app.ts')).toEqual({ result: 'written' })
    expect(await call('xx1', 'src/app.ts')).toHaveProperty('deny')
    expect(await call('xx1', '.crew/plans/plan.md')).toHaveProperty('deny')
  })
}
