import { expect, test } from 'claude-code/testing'
import { decisionPath, decisionRecord, fnv1a, saveDecision } from '../hooks/decisions'

const input = {
  ts: '2026-10-11T12:30:45.123Z',
  agent: 'developer',
  tier: 'opus',
  confidence: 0.9,
  depth: 3.9,
  defaultModel: 'sonnet',
  model: 'opus',
  defaultEffort: 'medium',
  effortPlanned: 'high',
  effortApplied: 'high',
  bind: 'applied',
  jevModel: 'jev-1.13.0',
  durationMs: 412.6,
  description: 'audit auth',
} as const

test('fnv1a is the 32-bit FNV-1a in hex', () => {
  expect(fnv1a('')).toBe('811c9dc5')
  expect(fnv1a('a')).toBe('e40c292c')
  expect(fnv1a('audit auth')).toBe(fnv1a('audit auth'))
  expect(fnv1a('audit auth')).not.toBe(fnv1a('audit auth '))
})

test('the record is fixed in shape, has an empty outcome and never the description', () => {
  const rec = decisionRecord(input)
  expect(rec).toMatchObject({
    v: 1, agent: 'developer', tier: 'opus', model: 'opus', durationMs: 413, outcome: null,
    applied: { model: true, effort: true }, jevModel: 'jev-1.13.0', descriptionHash: fnv1a('audit auth'),
  })
  expect(JSON.stringify(rec)).not.toContain('audit auth')
})

test('absent answers are null and a kept decision applies nothing', () => {
  const rec = decisionRecord({ ...input, tier: undefined, confidence: undefined, depth: undefined, bind: undefined, jevModel: 'bad id!', model: 'sonnet', effortApplied: 'medium' })
  expect(rec).toMatchObject({ tier: null, confidence: null, depth: null, bind: null, jevModel: null, applied: { model: false, effort: false } })
})

test('the path is under the trusted home, the colons replaced and the id made safe', () => {
  expect(decisionPath('/home/u/', input.ts, 'a1')).toBe('/home/u/.claude/crew/decisions/2026-10-11T12-30-45.123Z-a1.json')
  expect(decisionPath('/home/u', input.ts, 'x y/z')).toBe('/home/u/.claude/crew/decisions/2026-10-11T12-30-45.123Z-x_y_z.json')
})

test('saveDecision never rejects and writes nothing without a home', async () => {
  const writes: string[] = []
  const logs: string[] = []
  const io = { write: async (path: string) => void writes.push(path), log: (text: string) => void logs.push(text) }
  await saveDecision(io, undefined, 'a1', decisionRecord(input))
  expect(writes).toEqual([])
  await saveDecision({ ...io, write: async () => { throw new Error('x') } }, '/home/u', 'a1', decisionRecord(input))
  expect(logs).toHaveLength(2)
})

test('a model id that is not an alias is kept as it is, and the record stays v 1', () => {
  const rec = decisionRecord({ ...input, tier: undefined, defaultModel: 'gpt-6-astra', model: 'gpt-6-astra', effortApplied: 'medium' })
  expect(rec).toMatchObject({ v: 1, defaultModel: 'gpt-6-astra', model: 'gpt-6-astra', applied: { model: false, effort: false } })
})
