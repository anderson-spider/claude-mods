import { expect, test } from 'claude-code/testing'
import { decisionData, fnv1a, saveDecision } from '../hooks/decisions'
import type { DecisionRecord, FinishRecord } from '../hooks/decisions'
import { distributions } from '../hooks/effort'

const record: DecisionRecord = {
  v: 3, ts: '2026-10-13T20:00:00Z', role: 'analyst', agent: 'analyst', effectiveAgent: 'n1r',
  selection: { model: 'gpt-6.1-sol', effort: 'high', profileId: 'sol-high', source: 'jev', penalty: 0.5 },
  jevModel: 'jev-1.13.0', jevAsked: true, taskTypePrior: false, jevReason: null,
  pins: { dimensions: { difficulty: 3 } }, pinsUsed: { model: false, effort: false, profile: false, dimensions: true }, dimensionsIgnored: false,
  expected: { difficulty: 3, duration: 1, scope: 2 }, taskType: distributions({}, { difficulty: 3, duration: 1, scope: 2, task_type: 'docs' }).task_type,
  taskHash: fnv1a('cleaned task'), modelApplied: true, effortApplied: true,
  started: true, promptStatus: 'confirmed', reason: null, durationMs: 100,
}

test('dispatch v3 projection and finish v2 retain only allowed metadata and distinct filenames', async () => {
  const secret = 'private-task /absolute/path key response-body @raw-directive'
  const hostile = { ...record, startup: { secret }, raw: secret,
    selection: { ...record.selection!, secret }, expected: { ...record.expected!, secret }, taskType: { ...record.taskType!, secret },
    pins: { ...record.pins, secret, dimensions: { ...record.pins.dimensions, secret } }, pinsUsed: { ...record.pinsUsed, secret },
  } as DecisionRecord
  expect(decisionData(hostile)).toEqual(record)
  expect(JSON.stringify(decisionData(hostile))).not.toContain(secret)
  const ended = { v: 2, action: 'finish', trigger: 'report', ts: record.ts, agent: record.agent, effectiveAgent: record.effectiveAgent, uuid: 'uuid', closed: true, archived: false, reason: 'archive exit 9' } as const
  expect(decisionData({ ...ended, secret } as FinishRecord)).toEqual(ended)
  expect(decisionData({ ...ended, trigger: secret } as unknown as FinishRecord)).not.toHaveProperty('trigger')
  const paths: string[] = [], bodies: string[] = []
  const io = { write: async (path: string, body: string) => { paths.push(path); bodies.push(body) }, log: () => {} }
  await saveDecision(io, '/home/u', hostile)
  await saveDecision(io, '/home/u', { ...ended, secret } as FinishRecord)
  expect(paths[1]).toBe(paths[0]!.replace(/\.json$/, '.finish.json'))
  expect(bodies.join('')).not.toContain(secret)
  expect(decisionData({ ...record, selection: null, started: false, modelApplied: false, effortApplied: false })).toMatchObject({ selection: null })
})
