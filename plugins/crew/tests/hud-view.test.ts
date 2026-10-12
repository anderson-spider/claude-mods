import { expect, test } from 'claude-code/testing'
import { bandRows, type AgentRecord, type PlanProjection } from '../hooks/hud/view'
import { parsePlan } from '../hooks/hud/plan'

const now = Date.parse('2026-10-12T12:00:00Z')
const text = (rows: ReturnType<typeof bandRows>) => rows.rows.map(row => row.map(s => s.text).join('')).join('\n')
const plan: PlanProjection = {
  name: 'crew-hud', groups: [{ heading: 'PR 1 - HUD band', done: 2, running: 2, left: 3,
    runningSteps: [{ id: 'T3', owner: 'crew:developer' }, { id: 'T4', owner: 'crew:developer' }], unknownStates: false }],
}
const agent = (changes: Partial<AgentRecord> = {}): AgentRecord => ({ id: 'a', type: 'crew:developer', model: 'sonnet',
  effort: 'medium', startedAt: now - 187_000, status: 'running', ...changes })

test('band collapses idle sections, but represents loading and parse errors', () => {
  expect(bandRows([], [], now, 60).rows).toEqual([])
  expect(text(bandRows([{ state: 'loading' }, { state: 'unknown' }], [], now, 60))).toBe('Plan loading\nPlan unknown')
  expect(text(bandRows([], [agent({ status: 'ended' })], now, 60))).toBe('')
})

test('width-sensitive rows include every running step and agent without truncation', () => {
  const many = { ...plan, groups: [{ ...plan.groups[0]!, runningSteps: Array.from({ length: 40 }, (_, i) =>
    ({ id: `T${i}`, owner: 'crew:developer' })) }] }
  for (const width of [40, 60, 84, 120]) {
    const rows = bandRows([many], Array.from({ length: 20 }, (_, i) => agent({ id: `${i}`, type: 'crew:developer-codex', model: 'cx/gpt-6-sol-medium' })), now, width)
    const output = text(rows)
    for (let i = 0; i < 40; i++) expect(output).toContain(`T${i} crew:developer`)
    expect(output).not.toContain('more')
    expect(rows.rows.every(row => row.map(s => s.text).join('').length <= width)).toBe(true)
    expect(output.split('crew:developer-codex').length - 1).toBe(20)
  }
  expect(text(bandRows([plan], [], now, 120))).toContain('  |  T3 crew:developer  T4 crew:developer')
  expect(text(bandRows([plan], [], now, 60))).toContain('\n    T3 crew:developer')
})

test('agent model and elapsed are observed only with evidence; timestamps cross one hour', () => {
  const output = text(bandRows([], [agent({ startedAt: now - 3_599_000 }), agent({ id: 'b',
    observedModel: 'claude-opus-4-1-20260205', startedAt: now - 3_600_000 }),
    agent({ id: 'c', model: undefined, effort: undefined, startedAt: undefined, seenAt: now - 4_000 }),
    agent({ id: 'd', startedAt: now + 100_000 })], now, 120))
  expect(output).toContain('59:59')
  expect(output).toContain('1:00:00')
  expect(output).toContain('requested sonnet  observed claude-opus-4-1-20260205')
  expect(output).toContain('requested unknown  effort unknown  seen 0:04')
  expect(output).toContain('0:00')
})

test('parser owner lead survives the view while unknown owners remain hidden', () => {
  const parsed = parsePlan('hud.md', '## Steps\n### Delivery\n- T9 (lead, after: —) commit — state: implementing\n- T10 (untrusted, after: —) commit — state: implementing', { home: '', root: '' })
  const output = text(bandRows([parsed], [], now, 60))
  expect(output).toContain('T9 lead')
  expect(output).toContain('T10 ?')
})

test('untrusted projection and models never reach display', () => {
  const malicious = { ...plan, name: '/Users/private/token', groups: [{ ...plan.groups[0]!, heading: 'https://host/secret',
    runningSteps: [{ id: 'evil\u001b', owner: 'crew:unknown' }] }] }
  const output = text(bandRows([malicious], [agent({ model: 'sk-secret', observedModel: 'https://bad', effort: 'high\u001b' })], now, 120))
  for (const secret of ['/Users/', 'https:', 'sk-secret', '\u001b']) expect(output).not.toContain(secret)
  expect(output).toContain('Plan ?')
  expect(output).toContain('requested ?  observed ?  effort unknown')
})
