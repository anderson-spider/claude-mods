import { expect, test } from 'claude-code/testing'
import type { TurnStepInput } from 'claude-code'
import { acceptsSpawn, BLOCKED, complete, classify, policy, cacheType, prepare } from '../hooks/dispatch'
import type { IdentityCache } from '../types'
import { ports, row, runFixture } from './host'

test('prepare preserves frozen input and caps every role default pin and local profile', async () => {
  for (const role of ['analyst', 'developer', 'reviewer', 'architect'] as const) {
    for (const directive of ['', '@haiku-low ', '!difficulty=4 !duration=3 !scope=3 !task_type=research ']) {
      const h = ports(), e = Object.freeze({ tool: 'Agent', tool_use_id: 'native-tool', subagent_type: `spider-team:${role}`, prompt: directive + 'Task' })
      const p = (await prepare(h.io, e))!
      expect(p.run.role).toBe(role); expect(['low', 'medium', 'high']).toContain(p.run.forwarded.effort)
      expect(p.run.toolId).toBe(e.tool_use_id); expect(e.prompt).toBe(directive + 'Task')
      if (role === 'developer') expect(p.prompt).toContain('Tracked uncommitted changes from the lead are absent')
    }
    for (const effort of ['xhigh', 'max']) {
      const p = (await prepare(ports().io, { tool: 'Agent', tool_use_id: 'p', prompt: 'Task', subagent_type: `spider-team:${role}`, model: 'opus', effort }))!
      expect(p.run.selected.effort).toBe(effort); expect(p.run.forwarded.effort).toBe('high'); expect(p.run.cap).toBe(true)
    }
  }
})
test('invalid pins overrides versions and isolation fail before assessment or process effects', async () => {
  const e = { tool: 'Agent', tool_use_id: 'x', subagent_type: 'spider-team:analyst', prompt: 'Task' }
  for (const patch of [{ model: 'fable' }, { model: 'inherit' }, { model: 'opaque' }, { effort: 1000 }, { prompt: '@haiku-low' }, { isolation: 'worktree' }, { isolation: 'remote' }]) {
    const h = ports(); await expect(prepare(h.io, { ...e, ...patch })).rejects.toThrow()
    expect(h.requests).toHaveLength(0); expect(h.calls).toHaveLength(0)
  }
  for (const patch of [{ overrides: ['opus'] }, { overrides: ['max'] }, { version: '2.1.291' }, { version: 'unknown' }]) {
    const h = ports(); Object.assign(h.io, patch); await expect(prepare(h.io, e)).rejects.toThrow(BLOCKED); expect(h.requests).toHaveLength(0)
  }
  const h = ports(); h.io.baseRef = 'main'
  await expect(prepare(h.io, { ...e, subagent_type: 'spider-team:developer' })).rejects.toThrow(BLOCKED)
  expect(await prepare(ports().io, { ...e, subagent_type: 'fork' })).toBeUndefined()
})
test('identity policy covers four native roles and safe divergent pairs without a reservation', () => {
  for (const role of ['analyst', 'developer', 'reviewer', 'architect']) {
    const type = classify('child', [row('child', `spider-team:${role}`)])
    for (const model of ['opus', 'sonnet', 'haiku', 'claude-haiku-4-5']) for (const effort of ['low', 'medium', 'high']) {
      policy(type, { model, effort } as TurnStepInput)
    }
    for (const patch of [{ model: 'fable' }, { model: 'inherit' }, { model: 'opaque' }, { model: undefined }, { effort: undefined }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 1000 }]) {
      expect(() => policy(type, { model: 'haiku', effort: 'medium', ...patch } as TurnStepInput)).toThrow(BLOCKED)
    }
  }
  for (const type of ['general-purpose', 'fork']) policy(classify('external', [row('external', type)]), { model: 'fable', effort: 'max' })
})
test('identity requires one exact valid native row and cache bounds and contradictions fail closed', () => {
  for (const rows of [[], [row('other')], [row('child'), row('child')], [row('child', 'spider-team:unknown')], [row('child', '')], [row('child', ' bad ')], [{ id: 'child' }], [row('child', 9 as never)]]) {
    expect(() => classify('child', rows as never)).toThrow(BLOCKED)
  }
  const cache: IdentityCache = { version: 1, entries: [] }
  expect(cacheType(cache, 'first')).toBeUndefined()
  cacheType(cache, 'first', 'fork')
  for (let n = 0; n < 255; n++) cacheType(cache, String(n), 'spider-team:analyst')
  expect(cacheType(cache, 'first')).toBe('fork')
  cacheType(cache, 'new', 'fork')
  expect(cache.entries).toHaveLength(256); expect(cacheType(cache, '0')).toBeUndefined()
  expect(() => cacheType(cache, 'first', 'spider-team:developer')).toThrow(BLOCKED)
  expect(cacheType(cache, 'first')).toBe('')
})
test('spawn validates local Spider fields without requiring or consulting a reservation', () => {
  const event = { subagentType: 'spider-team:analyst', provider: { plugin: 'spider-team' }, model: 'haiku', fork: false }
  acceptsSpawn(event); acceptsSpawn({ ...event, model: 'opus' }); acceptsSpawn({ ...event, model: undefined })
  acceptsSpawn({ ...event, subagentType: 'fork', model: 'fable' })
  for (const patch of [{ provider: { plugin: 'other' } }, { subagentType: 'spider-team:unknown' }, { model: 'fable' }, { model: 'inherit' }, { fork: true }, { resume: 'old' }, { isTeammate: true as const }]) expect(() => acceptsSpawn({ ...event, ...patch })).toThrow(BLOCKED)
})
test('completion counts receipt only deduplicates usage and never approves cancellation or long handback', () => {
  const run = runFixture(), report = { receipt: 'receipt', status: 'done' as const }
  const event = { agentId: 'child-1', turnId: 'turn', answer: 'receipt', reason: 'answer' as const, isAborted: false, durationMs: 20, usage: { model: 'haiku', input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }
  complete(run, event, report); complete(run, event, report)
  expect(run.status).toBe('done'); expect(Object.keys(run.turns)).toHaveLength(1); expect(run.durationMs).toBe(20)
  expect(run.handbackChars).toBe(7); expect(run.receiptChars).toBe(7)
  const long = runFixture(); complete(long, { ...event, answer: 'receipt plus report body' }, report); expect(long.status).toBe('partial')
  const abort = runFixture(); complete(abort, { ...event, reason: 'aborted', isAborted: true }, report); expect(abort.status).toBe('blocked')
  expect(abort).not.toHaveProperty('answer')
})


test('bounded turn accounting cannot approve a later cancelled or unobserved completion', () => {
  const run = runFixture(), report = { receipt: 'receipt', status: 'done' as const }
  const event = { turnId: '', answer: 'receipt', reason: 'answer' as const, isAborted: false, durationMs: 1 }
  for (let n = 0; n < 256; n++) complete(run, { ...event, turnId: String(n) }, report)
  expect(run.status).toBe('done')
  complete(run, { ...event, turnId: 'over-limit' }, report)
  expect(run.status).toBe('partial'); expect(Object.keys(run.turns)).toHaveLength(256)
  complete(run, { ...event, turnId: 'cancelled', isAborted: true }, report)
  expect(run.status).toBe('blocked'); expect(Object.keys(run.turns)).toHaveLength(256)
})
