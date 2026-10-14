import { expect, test } from 'claude-code/testing'
import { decision, fnv1a } from '../hooks/decisions'
import { complete } from '../hooks/dispatch'
import { runFixture } from './host'

test('decision projects deep allowlists and records counts without report or handback content', () => {
  const secret = '/private/task-and-token', run = runFixture({
    requested: { model: 'opus', effort: 'max', secret } as never,
    selected: { model: 'opus', effort: 'max', secret } as never,
    forwarded: { model: 'opus', effort: 'high', secret } as never,
    observed: [{ model: 'claude-opus-4-6', effort: 'high', secret } as never, { model: secret, effort: secret } as never],
    dimensions: { difficulty: 4, duration: 3, scope: 3, task_type: 'research', secret },
    root: secret, home: secret, agentId: secret, toolId: secret, jevReason: secret, profile: secret,
  })
  Object.assign(run, { report: { path: secret, receipt: secret }, task: secret, body: secret, error: secret, keyValue: secret })
  const event = { turnId: 't', answer: secret, isAborted: false, reason: 'answer' as const, durationMs: 5, usage: { model: 'opus', input_tokens: 3, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null } }
  complete(run, event, { receipt: secret, status: 'done' }); complete(run, event, { receipt: secret, status: 'done' })
  const log = decision(run, 1)
  expect(JSON.stringify(log)).not.toContain(secret)
  expect(log.callerRequested).toEqual({ model: 'opus', effort: 'max' })
  expect(log.forwarded).toEqual({ model: 'opus', effort: 'high' }); expect(log.observed).toEqual([{ model: 'opus', effort: 'high' }, { model: null, effort: null }, { model: 'opus', effort: null }])
  expect(log.usage).toEqual({ input: 3, output: 2, cacheRead: 0, cacheWrite: 0 })
  expect(log.handbackChars).toBe(secret.length); expect(log.receiptChars).toBe(secret.length)
  expect(log).not.toHaveProperty('report'); expect(log).not.toHaveProperty('handback'); expect(log).not.toHaveProperty('applied')
})
test('failed dispatch has no fabricated observation usage or receipt and hashes are stable', () => {
  const run = runFixture({ status: 'blocked', taskHash: '/bad', dimensions: { difficulty: NaN, task_type: '/private' } })
  const log = decision(run, 10)
  expect(log.observed).toEqual([]); expect(log.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  expect(log.receiptChars).toBeNull(); expect(log.handbackChars).toBeNull(); expect(log.taskHash).toBeNull()
  expect(log.dimensions).toEqual({ difficulty: null, task_type: null })
  expect(fnv1a('task')).toBe(fnv1a('task')); expect(fnv1a('task')).not.toBe(fnv1a('other'))
})
test('hostile metadata and coercible nested values cannot enter telemetry', () => {
  const secret = '/private/raw-metadata', value = { toString: () => 'high', secret }
  const run = runFixture({ source: secret as never, status: secret as never, jevAsked: secret as never, dimensionsUsed: secret as never, dimensions: { difficulty: 99, task_type: { ...value, toString: () => 'research' } as never }, observed: [{ model: 'opus', effort: value as never }] })
  run.role = secret as never
  const log = decision(run, NaN)
  expect(JSON.stringify(log)).not.toContain(secret); expect(log.role).toBeNull(); expect(log.source).toBeNull(); expect(log.status).toBeNull()
  expect(log.jevAsked).toBe(false); expect(log.dimensionsUsed).toBe(false); expect(log.timestamp).toBeNull()
  expect(log.dimensions).toEqual({ difficulty: null, task_type: null }); expect(log.observed).toEqual([{ model: 'opus', effort: null }])
})

test('safe divergent observations are explicit and report references stay outside telemetry', () => {
  const run = runFixture({ observed: [{ model: 'opus', effort: 'high' }] })
  expect(decision(run, 1).divergence).toBe(true)
  run.observed = [{ model: 'haiku', effort: 'medium' }]
  expect(decision(run, 1).divergence).toBe(false)
  expect(run).not.toHaveProperty('report')
})
