import { expect, test } from 'claude-code/testing'
import { decisionPath, decisionRecord, fnv1a, saveDecision } from '../hooks/decisions'

const input = {
  ts: '2026-10-11T12:30:45.123Z',
  agent: 'developer',
  requested: 'crew:developer',
  provider: 'claude',

  depth: 3.9,

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
    v: 4, agent: 'developer', requested: 'crew:developer', provider: 'claude', durationMs: 413, outcome: null,
    applied: { effort: true }, jevModel: 'jev-1.13.0', descriptionHash: fnv1a('audit auth'),
  })
  expect(JSON.stringify(rec)).not.toContain('audit auth')
  for (const field of ['tier', 'confidence', 'model', 'defaultModel']) expect(rec).not.toHaveProperty(field)
  expect(rec.applied).not.toHaveProperty('model')
})

test('absent answers are null and a kept decision applies nothing', () => {
  const rec = decisionRecord({ ...input, depth: undefined, bind: undefined, jevModel: 'bad id!', effortApplied: 'medium' })
  expect(rec).toMatchObject({ depth: null, bind: null, jevModel: null, applied: { effort: false } })
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
  expect(logs).toEqual(['crew jev: decision not logged (no trusted home)', 'crew jev: decision not logged (write failed)'])
  await saveDecision(io, undefined, 'a1', decisionRecord(input), 'crew')
  expect(logs.at(-1)).toBe('crew: decision not logged (no trusted home)')
  await saveDecision({ ...io, write: async () => { throw new Error('x') } }, '/home/u', 'a1', decisionRecord(input), 'crew')
  expect(logs.at(-1)).toBe('crew: decision not logged (write failed)')
})

test('a record keeps only effort choice, not model choice', () => {
  const rec = decisionRecord({ ...input, effortApplied: 'medium' })
  expect(rec).toMatchObject({ v: 4, applied: { effort: false } })
})

test('a call the codex mode moved records the type asked for and the provider, with no quota fields', () => {
  const rec = decisionRecord({ ...input, agent: 'developer-codex', provider: 'codex', effortApplied: 'medium' })
  expect(rec).toMatchObject({ v: 4, agent: 'developer-codex', requested: 'crew:developer', provider: 'codex' })
  expect(Object.keys(rec)).not.toContain('reason')
  expect(Object.keys(rec)).not.toContain('quota')
})

test('unknown applied configuration is null and not a claimed change from the default', () => {
  expect(decisionRecord({ ...input, effortApplied: null })).toMatchObject({ effortApplied: null, applied: { effort: false } })
})
