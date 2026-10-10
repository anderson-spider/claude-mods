import { expect, test } from 'claude-code/testing'
import type { FlowState } from '../hooks/flow/types'
import { flowHash, validateFlow } from '../hooks/flow/plan'
import type { Flow } from '../hooks/flow/plan'
import {
  JOURNAL_CAP, JOURNAL_MAX_BYTES, REASON_MAX, createSerial, appendJournal, appendLabel, approve, approvedPath, attestKey, attestOf, flowDir, isApproved,
  journalPath, labelsPath, loadApproved, loadState, ledgerPath, matchesAttest, parseAttest, readJournal, readLabels, readSideEffects, recordSideEffect,
  restoreFromLedger, saveApproved, saveState, statePath, unapprove,
  type FlowFs,
} from '../hooks/flow/store'

const ROOT = '/repo'
const PLAN = 'decision-flow'

const memFs = (seed: Record<string, string> = {}) => {
  const files = new Map(Object.entries(seed))
  const fs: FlowFs = {
    read: async path => files.get(path),
    write: async (path, text) => { files.set(path, text) },
  }
  return { fs, files }
}

const state = (patch: Partial<FlowState> = {}): FlowState => ({
  planId: PLAN, hash: 'h1', status: { T1: 'done', T2: 'active', T3: 'pending' }, attempts: { T2: 1 }, awaiting: [{ task: 'T2', by: 'architect' }], receipts: { T1: { architect: true } }, qaRequired: [], ends: {},
  sideEffectsDone: [], blocks: 3, consecutiveBlocks: 1, paused: false, stopped: false, done: false, ...patch,
})

test('paths live under .pantheon/flow/<planId>/', () => {
  expect(flowDir('/repo/', PLAN)).toBe('/repo/.pantheon/flow/decision-flow')
  expect(statePath(ROOT, PLAN)).toBe('/repo/.pantheon/flow/decision-flow/state.json')
  expect(journalPath(ROOT, PLAN)).toBe('/repo/.pantheon/flow/decision-flow/journal.jsonl')
  expect(ledgerPath(ROOT, PLAN)).toBe('/repo/.pantheon/flow/decision-flow/side-effects.jsonl')
  expect(labelsPath(ROOT, PLAN)).toBe('/repo/.pantheon/flow/decision-flow/labels.jsonl')
  expect(approvedPath(ROOT, PLAN)).toBe('/repo/.pantheon/flow/decision-flow/approved.json')
})

test('state survives a save and load round trip, including optional fields', async () => {
  const { fs, files } = memFs()
  const saved = state({ approvedHash: 'h1', lastFailure: { key: 'abc', count: 2 }, lastInstruction: 'fix T2', paused: true })
  await saveState(fs, ROOT, saved)
  expect(files.get(statePath(ROOT, PLAN))).toContain('\n  "planId"')
  expect(await loadState(fs, ROOT, PLAN)).toEqual(saved)
})

test('a missing state file loads as undefined', async () => {
  expect(await loadState(memFs().fs, ROOT, PLAN)).toBeUndefined()
})

test('corrupt JSON loads as undefined so the caller starts fresh', async () => {
  const path = statePath(ROOT, PLAN)
  for (const text of ['', '{"planId":', 'not json', 'null', '[]', '"x"']) {
    expect(await loadState(memFs({ [path]: text }).fs, ROOT, PLAN)).toBeUndefined()
  }
})

test('a state with the wrong shape loads as undefined', async () => {
  const path = statePath(ROOT, PLAN)
  const bad: unknown[] = [
    { ...state(), hash: 7 },
    { ...state(), planId: 'other-plan' },
    { ...state(), status: { T1: 'finished' } },
    { ...state(), status: ['done'] },
    { ...state(), attempts: { T1: -1 } },
    { ...state(), attempts: { T1: 1.5 } },
    { ...state(), reviewed: 'T1' },
    { ...state(), awaiting: 'T2' },
    { ...state(), awaiting: ['T2'] },
    { ...state(), awaiting: [{ task: 'T2', by: 'human' }] },
    { ...state(), awaiting: [{ task: 2, by: 'qa' }] },
    { ...state(), receipts: ['T1'] },
    { ...state(), qaRequired: 'T1' },
    { ...state(), qaRequired: [1] },
    { ...state(), ends: { T1: -1 } },
    { ...state(), ends: [1] },
    { ...state(), receipts: { T1: { architect: false } } },
    { ...state(), receipts: { T1: { qa: 'yes' } } },
    { ...state(), receipts: { T1: 'done' } },
    { ...state(), mode: 'loud' },
    { ...state(), mode: 1 },
    { ...state(), awaitingReview: 'T2' },
    { ...state(), awaitingReview: [1] },
    { ...state(), sideEffectsDone: [1] },
    { ...state(), blocks: '3' },
    { ...state(), consecutiveBlocks: undefined },
    { ...state(), paused: 'no' },
    { ...state(), done: 0 },
    { ...state(), approvedHash: 5 },
    { ...state(), lastFailure: { key: 'a' } },
    { ...state(), lastInstruction: 4 },
  ]
  for (const value of bad) expect(await loadState(memFs({ [path]: JSON.stringify(value) }).fs, ROOT, PLAN)).toBeUndefined()
})

test('unknown extra fields are dropped on load', async () => {
  const path = statePath(ROOT, PLAN)
  const loaded = await loadState(memFs({ [path]: JSON.stringify({ ...state(), future: true }) }).fs, ROOT, PLAN)
  expect(loaded).toEqual(state())
})

test('a bad planId is refused everywhere', async () => {
  const { fs } = memFs()
  for (const id of ['', '../x', 'A', '-a', 'a/b', 'a b', 'a'.repeat(65)]) {
    expect(() => flowDir(ROOT, id)).toThrow()
    await expect(loadState(fs, ROOT, id)).rejects.toThrow()
    await expect(saveState(fs, ROOT, state({ planId: id }))).rejects.toThrow()
    await expect(appendJournal(fs, ROOT, id, { at: 1, kind: 'note' })).rejects.toThrow()
    await expect(readJournal(fs, ROOT, id)).rejects.toThrow()
    await expect(recordSideEffect(fs, ROOT, id, 'T1', 1)).rejects.toThrow()
    await expect(readSideEffects(fs, ROOT, id)).rejects.toThrow()
    await expect(appendLabel(fs, ROOT, id, { journalId: 1, label: 'right', source: 'auto', at: 1 })).rejects.toThrow()
    await expect(readLabels(fs, ROOT, id)).rejects.toThrow()
  }
  expect(flowDir(ROOT, 'a'.repeat(64))).toBe(`/repo/.pantheon/flow/${'a'.repeat(64)}`)
})

test('journal ids are monotonic across calls and the caller supplies the time', async () => {
  const { fs } = memFs()
  const a = await appendJournal(fs, ROOT, PLAN, { at: 1000, kind: 'decision', event: 'stop', task: 'T2', action: 'block', condition: 'checks-failing', mode: 'shadow' })
  const b = await appendJournal(fs, ROOT, PLAN, { at: 1001, kind: 'note', detail: 'hello' })
  const c = await appendJournal(fs, ROOT, PLAN, { at: 1002, kind: 'approval' })
  expect([a.id, b.id, c.id]).toEqual([1, 2, 3])
  expect(a.at).toBe(1000)
  expect(await readJournal(fs, ROOT, PLAN)).toEqual([a, b, c])
})

test('a journal entry keeps shadow wouldBe, judgment scores and check outcomes without output text', async () => {
  const { fs, files } = memFs()
  const entry = await appendJournal(fs, ROOT, PLAN, {
    at: 5, kind: 'judgment', event: 'taskEnd', task: 'T1', action: 'allow', wouldBe: 'block', condition: 'judge-stuck', mode: 'shadow',
    scores: { claimsDone: 0.9, stuck: 0.1 }, checks: [{ label: 'claude plugin test', passed: true }, { label: 'lint', passed: null }],
    detail: 'free text',
  })
  expect(entry).toMatchObject({ id: 1, wouldBe: 'block', scores: { claimsDone: 0.9, stuck: 0.1 }, checks: [{ label: 'claude plugin test', passed: true }, { label: 'lint', passed: null }] })
  expect(files.get(journalPath(ROOT, PLAN))?.endsWith('\n')).toBe(true)
  expect((await readJournal(fs, ROOT, PLAN))[0]).toEqual(entry)
})

test('reason is truncated to 600 chars', async () => {
  const { fs } = memFs()
  const entry = await appendJournal(fs, ROOT, PLAN, { at: 1, kind: 'decision', reason: 'x'.repeat(5000) })
  expect(REASON_MAX).toBe(600)
  expect(entry.reason?.length).toBe(600)
  expect((await readJournal(fs, ROOT, PLAN))[0]?.reason?.length).toBe(600)
})

test('torn last line and junk lines are skipped on read', async () => {
  const good = (id: number) => JSON.stringify({ id, at: id, kind: 'note' })
  const text = [
    good(1), '', 'not json', '{"id":2}', '[1,2]', 'null',
    JSON.stringify({ id: 3, at: 3, kind: 'mystery' }),
    JSON.stringify({ id: 4, at: 4, kind: 'note', checks: 'bad' }),
    JSON.stringify({ id: 0, at: 4, kind: 'note' }),
    good(5), '{"id":6,"at":6,"kind":"no',
  ].join('\n')
  const { fs } = memFs({ [journalPath(ROOT, PLAN)]: text })
  expect((await readJournal(fs, ROOT, PLAN)).map(e => e.id)).toEqual([1, 5])
})

test('appending after a torn line drops it and continues the ids', async () => {
  const text = `${JSON.stringify({ id: 1, at: 1, kind: 'note' })}\n${JSON.stringify({ id: 2, at: 2, kind: 'note' })}\n{"id":3,"at":3,"ki`
  const { fs, files } = memFs({ [journalPath(ROOT, PLAN)]: text })
  const entry = await appendJournal(fs, ROOT, PLAN, { at: 9, kind: 'note' })
  expect(entry.id).toBe(3)
  const lines = (files.get(journalPath(ROOT, PLAN)) ?? '').split('\n')
  expect(lines.pop()).toBe('')
  expect(lines.map(l => JSON.parse(l).id)).toEqual([1, 2, 3])
})

test('the journal is capped, dropping the oldest and keeping ids climbing', async () => {
  const lines = Array.from({ length: JOURNAL_CAP }, (_, i) => JSON.stringify({ id: i + 1, at: i, kind: 'note' }))
  const { fs } = memFs({ [journalPath(ROOT, PLAN)]: `${lines.join('\n')}\n` })
  const entry = await appendJournal(fs, ROOT, PLAN, { at: 99999, kind: 'note' })
  expect(JOURNAL_CAP).toBe(2000)
  expect(entry.id).toBe(2001)
  const all = await readJournal(fs, ROOT, PLAN)
  expect(all.length).toBe(2000)
  expect(all[0]?.id).toBe(2)
  expect(all[all.length - 1]?.id).toBe(2001)
})

test('the ledger records side effects once and tolerates torn lines', async () => {
  const { fs, files } = memFs()
  await recordSideEffect(fs, ROOT, PLAN, 'T5', 10)
  await recordSideEffect(fs, ROOT, PLAN, 'T5', 11)
  await recordSideEffect(fs, ROOT, PLAN, 'T7', 12)
  expect(await readSideEffects(fs, ROOT, PLAN)).toEqual([{ taskId: 'T5', at: 10 }, { taskId: 'T7', at: 12 }])
  files.set(ledgerPath(ROOT, PLAN), `${files.get(ledgerPath(ROOT, PLAN))}junk\n{"taskId":"T9","at":`)
  expect(await readSideEffects(fs, ROOT, PLAN)).toEqual([{ taskId: 'T5', at: 10 }, { taskId: 'T7', at: 12 }])
  await recordSideEffect(fs, ROOT, PLAN, 'T9', 13)
  expect((await readSideEffects(fs, ROOT, PLAN)).map(e => e.taskId)).toEqual(['T5', 'T7', 'T9'])
})

test('the ledger restores done side-effect tasks after state loss', async () => {
  const { fs, files } = memFs()
  await saveState(fs, ROOT, state({ status: { T1: 'done', T5: 'done', T6: 'pending' }, sideEffectsDone: ['T5'] }))
  await recordSideEffect(fs, ROOT, PLAN, 'T5', 10)
  // State lost: the file is gone, the ledger survives.
  files.delete(statePath(ROOT, PLAN))
  expect(await loadState(fs, ROOT, PLAN)).toBeUndefined()
  const fresh = state({ status: { T1: 'pending', T5: 'pending', T6: 'pending' }, attempts: {}, receipts: {}, blocks: 6, consecutiveBlocks: 0 })
  const restored = restoreFromLedger(fresh, await readSideEffects(fs, ROOT, PLAN))
  expect(restored.status).toEqual({ T1: 'pending', T5: 'done', T6: 'pending' })
  expect(restored.sideEffectsDone).toEqual(['T5'])
  // The input is not mutated and a second restore changes nothing.
  expect(fresh.status.T5).toBe('pending')
  expect(restoreFromLedger(restored, [{ taskId: 'T5', at: 10 }])).toEqual(restored)
})

test('the ledger outranks a state that says the task failed or never ran', () => {
  const restored = restoreFromLedger(state({ status: { T5: 'failed' }, sideEffectsDone: [] }), [{ taskId: 'T5', at: 1 }, { taskId: 'T8', at: 2 }])
  expect(restored.status).toMatchObject({ T5: 'done', T8: 'done' })
  expect(restored.sideEffectsDone).toEqual(['T5', 'T8'])
})

test('approval holds only for the hash approved and the hash the state carries', () => {
  const s = state({ hash: 'h1' })
  expect(isApproved(s, 'h1')).toBe(false)
  const approved = approve(s, 'h1')
  expect(approved.approvedHash).toBe('h1')
  expect(s.approvedHash).toBeUndefined()
  expect(isApproved(approved, 'h1')).toBe(true)
  // The plan was edited: a different hash is not approved, and neither is a state built for the new hash.
  expect(isApproved(approved, 'h2')).toBe(false)
  expect(isApproved({ ...approved, hash: 'h2' }, 'h2')).toBe(false)
  // Approving a hash the state does not carry never counts.
  expect(isApproved(approve(s, 'h2'), 'h2')).toBe(false)
})

test('labels append and read back, skipping torn lines', async () => {
  const { fs, files } = memFs()
  await appendLabel(fs, ROOT, PLAN, { journalId: 4, label: 'wrong', source: 'person', at: 20, note: 'x'.repeat(1000) })
  await appendLabel(fs, ROOT, PLAN, { journalId: 5, label: 'right', source: 'auto', at: 21 })
  files.set(labelsPath(ROOT, PLAN), `${files.get(labelsPath(ROOT, PLAN))}{"journalId":6,"lab\n${JSON.stringify({ journalId: 7, label: 'maybe', source: 'auto', at: 1 })}\n`)
  const labels = await readLabels(fs, ROOT, PLAN)
  expect(labels.map(l => [l.journalId, l.label, l.source, l.at])).toEqual([[4, 'wrong', 'person', 20], [5, 'right', 'auto', 21]])
  expect(labels[0]?.note?.length).toBe(300)
  expect(labels[1]?.note).toBeUndefined()
})

test('a state saved with reviewed and awaitingReview loads as architect receipts and architect waits', async () => {
  const { awaiting: _a, receipts: _r, ...rest } = state()
  const old = { ...rest, reviewed: ['T1'], awaitingReview: ['T2'] }
  const loaded = await loadState(memFs({ [statePath(ROOT, PLAN)]: JSON.stringify(old) }).fs, ROOT, PLAN)
  expect(loaded).toEqual(state({ awaiting: [{ task: 'T2', by: 'architect' }], receipts: { T1: { architect: true } } }))
  expect(loaded).not.toHaveProperty('reviewed')
  expect(loaded).not.toHaveProperty('awaitingReview')
})

test('a state from before awaitingReview existed still loads, with nothing waiting', async () => {
  const { awaiting: _a, receipts: _r, ...rest } = state()
  const old = { ...rest, reviewed: ['T1'] }
  const loaded = await loadState(memFs({ [statePath(ROOT, PLAN)]: JSON.stringify(old) }).fs, ROOT, PLAN)
  expect(loaded).toEqual(state({ awaiting: [], receipts: { T1: { architect: true } } }))
})

test('old and new receipt fields merge, without duplicates, and a state with neither receipt form is refused', async () => {
  const path = statePath(ROOT, PLAN)
  const { awaiting: _a, receipts: _r, ...rest } = state()
  const both = { ...rest, reviewed: ['T1'], awaitingReview: ['T2'], awaiting: [{ task: 'T2', by: 'architect' }, { task: 'T2', by: 'qa' }], receipts: { T1: { qa: true }, T3: { architect: true } } }
  const loaded = await loadState(memFs({ [path]: JSON.stringify(both) }).fs, ROOT, PLAN)
  expect(loaded?.awaiting).toEqual([{ task: 'T2', by: 'architect' }, { task: 'T2', by: 'qa' }])
  expect(loaded?.receipts).toEqual({ T1: { architect: true, qa: true }, T3: { architect: true } })
  expect(await loadState(memFs({ [path]: JSON.stringify(rest) }).fs, ROOT, PLAN)).toBeUndefined()
})

test('qa receipts, waits, escalations and delivery counts survive a save and load round trip', async () => {
  const { fs } = memFs()
  const saved = state({ awaiting: [{ task: 'T2', by: 'qa' }, { task: 'T2', by: 'architect' }], receipts: { T1: { architect: true, qa: true } }, qaRequired: ['T2'], ends: { T1: 2, T2: 1 } })
  await saveState(fs, ROOT, saved)
  expect(await loadState(fs, ROOT, PLAN)).toEqual(saved)
})

test('createSerial runs interleaved read-modify-write appends one at a time so both land with distinct ids', async () => {
  const { fs, files } = memFs()
  // A slow read lets a second append read the same file before the first writes it.
  const slow: FlowFs = { read: async path => { for (let i = 0; i < 5; i++) await Promise.resolve(); return files.get(path) }, write: fs.write }
  const serial = createSerial()
  const [a, b, c] = await Promise.all([1, 2, 3].map(n => serial(() => appendJournal(slow, ROOT, PLAN, { at: n, kind: 'note' }))))
  expect([a?.id, b?.id, c?.id]).toEqual([1, 2, 3])
  expect((await readJournal(fs, ROOT, PLAN)).map(e => e.at)).toEqual([1, 2, 3])
})

test('createSerial keeps going after a rejected job and passes results and errors through', async () => {
  const serial = createSerial()
  const order: number[] = []
  const failing = serial(async () => { order.push(1); throw new Error('boom') })
  const next = serial(async () => { order.push(2); return 'ok' })
  await expect(failing).rejects.toThrow('boom')
  expect(await next).toBe('ok')
  expect(order).toEqual([1, 2])
})

test('the journal is also capped by bytes, dropping the oldest entries', async () => {
  const detail = 'd'.repeat(2000)
  const lines = Array.from({ length: 600 }, (_, i) => JSON.stringify({ id: i + 1, at: i, kind: 'note', detail }))
  const { fs, files } = memFs({ [journalPath(ROOT, PLAN)]: `${lines.join('\n')}\n` })
  expect(JOURNAL_MAX_BYTES).toBe(1024 * 1024)
  expect((files.get(journalPath(ROOT, PLAN)) ?? '').length).toBeGreaterThan(JOURNAL_MAX_BYTES)
  const entry = await appendJournal(fs, ROOT, PLAN, { at: 1, kind: 'note', detail })
  expect(entry.id).toBe(601)
  const text = files.get(journalPath(ROOT, PLAN)) ?? ''
  expect(text.length).toBeLessThan(JOURNAL_MAX_BYTES)
  const all = await readJournal(fs, ROOT, PLAN)
  expect(all[all.length - 1]?.id).toBe(601)
  expect(all[0]?.id).toBeGreaterThan(1)
  expect(all.length).toBeLessThan(600)
})

test('the byte cap counts UTF-8 bytes, not characters', async () => {
  const detail = 'ação✓'.repeat(400)
  const lines = Array.from({ length: 450 }, (_, i) => JSON.stringify({ id: i + 1, at: i, kind: 'note', detail }))
  const { fs, files } = memFs({ [journalPath(ROOT, PLAN)]: `${lines.join('\n')}\n` })
  await appendJournal(fs, ROOT, PLAN, { at: 1, kind: 'note' })
  const bytes = encodeURIComponent(files.get(journalPath(ROOT, PLAN)) ?? '').replace(/%[0-9A-F]{2}/g, 'x').length
  expect(bytes).toBeLessThan(JOURNAL_MAX_BYTES)
})

test('task, condition, check labels and the number of checks are bounded', async () => {
  const { fs } = memFs()
  const entry = await appendJournal(fs, ROOT, PLAN, {
    at: 1, kind: 'decision', task: 't'.repeat(200), condition: 'c'.repeat(200),
    checks: Array.from({ length: 30 }, () => ({ label: 'l'.repeat(500), passed: true })),
  })
  expect(entry.task?.length).toBe(64)
  expect(entry.condition?.length).toBe(64)
  expect(entry.checks?.length).toBe(20)
  expect(entry.checks?.[0]?.label.length).toBe(200)
  expect(await readJournal(fs, ROOT, PLAN)).toEqual([entry])
})

test('journal ids never repeat even when the journal was lost, because labels remember the highest id', async () => {
  const { fs } = memFs()
  for (let i = 0; i < 3; i++) await appendJournal(fs, ROOT, PLAN, { at: i, kind: 'note' })
  await appendLabel(fs, ROOT, PLAN, { journalId: 3, label: 'right', source: 'auto', at: 9 })
  // The journal is lost; the labels file stays.
  await fs.write(journalPath(ROOT, PLAN), '')
  expect((await appendJournal(fs, ROOT, PLAN, { at: 10, kind: 'note' })).id).toBe(4)
})

test('labels are capped by count and stay under the byte cap', async () => {
  const note = 'n'.repeat(300)
  const lines = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ journalId: i + 1, label: 'right', source: 'auto', at: i, note }))
  const { fs, files } = memFs({ [labelsPath(ROOT, PLAN)]: `${lines.join('\n')}\n` })
  await appendLabel(fs, ROOT, PLAN, { journalId: 5000, label: 'wrong', source: 'person', at: 1, note })
  expect((files.get(labelsPath(ROOT, PLAN)) ?? '').length).toBeLessThan(JOURNAL_MAX_BYTES)
  const labels = await readLabels(fs, ROOT, PLAN)
  expect(labels.length).toBe(2000)
  expect(labels[0]?.journalId).toBe(2)
  expect(labels[labels.length - 1]?.journalId).toBe(5000)
})

test('a failing read propagates and is never treated as a missing file', async () => {
  const broken: FlowFs = { read: async () => { throw new Error('EIO') }, write: async () => { throw new Error('must not write') } }
  await expect(loadState(broken, ROOT, PLAN)).rejects.toThrow('EIO')
  await expect(appendJournal(broken, ROOT, PLAN, { at: 1, kind: 'note' })).rejects.toThrow('EIO')
  await expect(recordSideEffect(broken, ROOT, PLAN, 'T1', 1)).rejects.toThrow('EIO')
  await expect(appendLabel(broken, ROOT, PLAN, { journalId: 1, label: 'skip', source: 'auto', at: 1 })).rejects.toThrow('EIO')
})

test('approving a rebased state (new hash, approval cleared) counts for the new hash only', () => {
  const approved = approve(state({ hash: 'h1' }), 'h1')
  // What the policy's rebase does when the plan was edited.
  const rebased: FlowState = { ...approved, hash: 'h2', approvedHash: undefined }
  expect(isApproved(rebased, 'h2')).toBe(false)
  const again = approve(rebased, 'h2')
  expect(isApproved(again, 'h2')).toBe(true)
  expect(isApproved(again, 'h1')).toBe(false)
})

test('restoreFromLedger ignores ledger entries for tasks that are not in the flow when the ids are given', () => {
  const s = state({ status: { T1: 'pending' }, sideEffectsDone: [] })
  const restored = restoreFromLedger(s, [{ taskId: 'T1', at: 1 }, { taskId: 'GONE', at: 2 }], ['T1', 'T2'])
  expect(restored.status).toEqual({ T1: 'done' })
  expect(restored.sideEffectsDone).toEqual(['T1'])
})

test('mode is kept when present and stays absent when missing', async () => {
  const { fs } = memFs()
  for (const mode of ['off', 'shadow', 'enforce'] as const) {
    await saveState(fs, ROOT, { ...state(), mode })
    expect((await loadState(fs, ROOT, PLAN))?.mode).toBe(mode)
  }
  await saveState(fs, ROOT, state())
  const loaded = await loadState(fs, ROOT, PLAN)
  expect(loaded).toBeDefined()
  expect('mode' in (loaded ?? {})).toBe(false)
})

test('a label and a journal append run concurrently through one queue keep the journal id above the label', async () => {
  const { fs, files } = memFs()
  const slow: FlowFs = { read: async path => { for (let i = 0; i < 5; i++) await Promise.resolve(); return files.get(path) }, write: fs.write }
  await appendJournal(slow, ROOT, PLAN, { at: 1, kind: 'note' })
  await appendJournal(slow, ROOT, PLAN, { at: 2, kind: 'note' })
  files.delete(journalPath(ROOT, PLAN))
  const serial = createSerial()
  const [, entry] = await Promise.all([
    serial(() => appendLabel(slow, ROOT, PLAN, { journalId: 7, label: 'right', source: 'auto', at: 3 })),
    serial(() => appendJournal(slow, ROOT, PLAN, { at: 4, kind: 'note' })),
  ])
  expect(entry.id).toBeGreaterThan(7)
  expect((await readLabels(fs, ROOT, PLAN)).map(l => l.journalId)).toEqual([7])
})

test('a state saved before qaRequired and ends existed loads with both empty', async () => {
  const { qaRequired: _q, ends: _e, ...old } = state()
  const loaded = await loadState(memFs({ [statePath(ROOT, PLAN)]: JSON.stringify(old) }).fs, ROOT, PLAN)
  expect(loaded).toEqual(state({ qaRequired: [], ends: {} }))
})

// --- amendments: approved snapshot, adoption, new journal kinds ---

const flowOf = (planId = PLAN): Flow => {
  const result = validateFlow({
    schemaVersion: 1, planId, goal: 'Ship it',
    tasks: [
      { id: 'T1', goal: 'first', files: ['src/a.ts'], acceptance: { checks: [{ argv: ['npm', 'test'] }] } },
      { id: 'T2', goal: 'second', files: ['src/b.ts'], dependsOn: ['T1'], acceptance: { criteria: ['it works'] } },
    ],
  })
  if (!result.ok) throw new Error(result.errors.join('; '))
  return result.flow
}

test('a state keeps adoptedHash, seenEdits and seenIds through a save and load, and an older state has none', async () => {
  const { fs } = memFs()
  const saved = state({ approvedHash: 'h1', adoptedHash: 'h2', hash: 'h2', seenEdits: ['edit-1', 'edit-2'], seenIds: ['T1', 'T9', 'T10'] })
  await saveState(fs, ROOT, saved)
  expect(await loadState(fs, ROOT, PLAN)).toEqual(saved)
  const plain = await loadState(memFs({ [statePath(ROOT, PLAN)]: JSON.stringify(state({ approvedHash: 'h1' })) }).fs, ROOT, PLAN)
  expect(plain).toEqual(state({ approvedHash: 'h1' }))
  for (const key of ['adoptedHash', 'seenEdits', 'seenIds']) expect(plain).not.toHaveProperty(key)
})

test('a state with a wrong adoptedHash, seenEdits or seenIds loads as undefined', async () => {
  const path = statePath(ROOT, PLAN)
  for (const bad of [{ adoptedHash: 4 }, { seenEdits: 'x' }, { seenEdits: [1] }, { seenIds: 'T1' }, { seenIds: [1] }]) {
    expect(await loadState(memFs({ [path]: JSON.stringify({ ...state(), ...bad }) }).fs, ROOT, PLAN)).toBeUndefined()
  }
})

test('an adopted flow is approved under its own hash; the approval alone no longer is once the state moved on', () => {
  const approved = approve(state({ hash: 'h1' }), 'h1')
  const adopted: FlowState = { ...approved, hash: 'h2', adoptedHash: 'h2' }
  expect(isApproved(adopted, 'h2')).toBe(true)
  // The person's hash is not the flow in force any more; a file that hashes to neither is not approved either.
  expect(isApproved(adopted, 'h1')).toBe(false)
  expect(isApproved(adopted, 'h3')).toBe(false)
  // An adoption without the person's approval never counts.
  expect(isApproved({ ...adopted, approvedHash: undefined }, 'h2')).toBe(false)
  // A state whose progress is for another hash is not approved for the adopted one.
  expect(isApproved({ ...adopted, hash: 'h1' }, 'h2')).toBe(false)
})

test('approve folds adoptions and a waiting edit into the new approval; unapprove drops every approval', () => {
  const adopted = state({ hash: 'h2', approvedHash: 'h1', adoptedHash: 'h2', seenEdits: ['edit-1'], seenIds: ['T9'] })
  const again = approve(adopted, 'h2')
  expect(again).toMatchObject({ approvedHash: 'h2', hash: 'h2', seenIds: ['T9'] })
  expect(again).not.toHaveProperty('adoptedHash')
  expect(again).not.toHaveProperty('seenEdits')
  expect(isApproved(again, 'h2')).toBe(true)
  expect(adopted.adoptedHash).toBe('h2')
  const none = unapprove(adopted)
  expect(none).not.toHaveProperty('approvedHash')
  expect(none).not.toHaveProperty('adoptedHash')
  expect(none).toMatchObject({ hash: 'h2', seenEdits: ['edit-1'] })
  expect(isApproved(none, 'h2')).toBe(false)
})

test('approved.json round trips as the approved flow, with or without an adoption', async () => {
  const { fs, files } = memFs()
  expect(await loadApproved(fs, ROOT, PLAN)).toEqual({ kind: 'missing' })
  const flow = flowOf()
  await saveApproved(fs, ROOT, PLAN, { approvedHash: flowHash(flow), flow })
  expect(files.get(approvedPath(ROOT, PLAN))?.endsWith('\n')).toBe(true)
  expect(await loadApproved(fs, ROOT, PLAN)).toEqual({ kind: 'ok', approved: { approvedHash: flowHash(flow), flow } })

  const bigger = validateFlow({ ...flow, tasks: [...flow.tasks, { id: 'T3', goal: 'third', files: ['docs/'], dependsOn: ['T2'], acceptance: { criteria: ['reads well'] } }] })
  if (!bigger.ok) throw new Error('fixture')
  await saveApproved(fs, ROOT, PLAN, { approvedHash: flowHash(flow), adoptedHash: bigger.hash, flow: bigger.flow })
  expect(await loadApproved(fs, ROOT, PLAN)).toEqual({ kind: 'ok', approved: { approvedHash: flowHash(flow), adoptedHash: bigger.hash, flow: bigger.flow } })
})

test('approved.json that is not trustworthy is invalid, never a flow', async () => {
  const flow = flowOf()
  const hash = flowHash(flow)
  const other = flowOf('another-plan')
  const cases: [string, unknown, string][] = [
    ['not an object', [1], 'not a JSON object'],
    ['no approvedHash', { flow }, 'no valid approvedHash'],
    ['a flow that does not validate', { approvedHash: hash, flow: { ...flow, tasks: [] } }, 'invalid flow'],
    ['another plan', { approvedHash: flowHash(other), flow: other }, 'another plan'],
    ['a flow edited by hand', { approvedHash: hash, flow: { ...flow, goal: 'Something else' } }, 'does not match its recorded hash'],
    ['an adoption equal to the approval', { approvedHash: hash, adoptedHash: hash, flow }, 'equal to the approval'],
    ['an adoption the flow does not hash to', { approvedHash: hash, adoptedHash: 'f'.repeat(64), flow }, 'does not match its recorded hash'],
  ]
  for (const [label, content, why] of cases) {
    const loaded = await loadApproved(memFs({ [approvedPath(ROOT, PLAN)]: JSON.stringify(content) }).fs, ROOT, PLAN)
    expect(loaded.kind, label).toBe('invalid')
    if (loaded.kind === 'invalid') expect(loaded.why, label).toContain(why)
  }
  const torn = await loadApproved(memFs({ [approvedPath(ROOT, PLAN)]: '{"approvedHash":' }).fs, ROOT, PLAN)
  expect(torn.kind).toBe('invalid')
  // A read that fails is a failure, not a missing snapshot.
  const broken: FlowFs = { read: async () => { throw new Error('EIO') }, write: async () => undefined }
  await expect(loadApproved(broken, ROOT, PLAN)).rejects.toThrow('EIO')
})

test('the journal keeps amendment and escalation entries and the hashes they carry', async () => {
  const { fs } = memFs()
  const adopted = await appendJournal(fs, ROOT, PLAN, {
    at: 1, kind: 'amendment', condition: 'amendment_adopted', approvedHash: 'a'.repeat(64), adoptedHash: 'b'.repeat(80), detail: 'new task T3',
  })
  const pending = await appendJournal(fs, ROOT, PLAN, { at: 2, kind: 'amendment', condition: 'amendment_pending', detail: 'T1: goal changed' })
  const escalation = await appendJournal(fs, ROOT, PLAN, { at: 3, kind: 'escalation', task: 'T1', condition: 'require_qa' })
  expect(adopted).toMatchObject({ kind: 'amendment', approvedHash: 'a'.repeat(64) })
  expect(adopted.adoptedHash?.length).toBe(64)
  expect((await readJournal(fs, ROOT, PLAN)).map(e => e.kind)).toEqual(['amendment', 'amendment', 'escalation'])
  expect(pending.approvedHash).toBeUndefined()
  expect(escalation.kind).toBe('escalation')
  // A hash that is not text is a malformed entry.
  const { fs: raw, files } = memFs({ [journalPath(ROOT, PLAN)]: JSON.stringify({ id: 1, at: 1, kind: 'amendment', adoptedHash: 5 }) })
  expect(await readJournal(raw, ROOT, PLAN)).toEqual([])
  expect(files.size).toBe(1)
})

// --- attestation: the host's record of an approval ---

test('the attestation key names the repository root and the plan, and is the same for the same pair', () => {
  const key = attestKey('/repo', PLAN)
  expect(key).toMatch(/^flow\.attest\.[0-9a-f]{32}\.decision-flow$/)
  expect(attestKey('/repo/', PLAN)).toBe(key)
  expect(attestKey('/other', PLAN)).not.toBe(key)
  expect(attestKey('/repo', 'another-plan')).not.toBe(key)
  expect(() => attestKey('/repo', '../escape')).toThrow()
})

test('an attestation is read back only with its shape, whatever the store hands over', () => {
  expect(parseAttest({ approvedHash: 'a', snapshotHash: 'a' })).toEqual({ approvedHash: 'a', snapshotHash: 'a' })
  expect(parseAttest({ approvedHash: 'a', adoptedHash: 'b', snapshotHash: 'b', adopted: ['T4'], extra: 1 })).toEqual({ approvedHash: 'a', adoptedHash: 'b', snapshotHash: 'b', adopted: ['T4'] })
  for (const bad of [undefined, null, 'a', [], {}, { approvedHash: 'a' }, { snapshotHash: 'a' }, { approvedHash: 1, snapshotHash: 'a' },
    { approvedHash: 'a', snapshotHash: 'a', adoptedHash: 2 }, { approvedHash: 'a', snapshotHash: 'a', adopted: 'T4' }, { approvedHash: 'a', snapshotHash: 'a', adopted: [4] }]) {
    expect(parseAttest(bad)).toBeUndefined()
  }
})

test('a snapshot matches its attestation only as a whole: both hashes and the flow itself', () => {
  const flow = flowOf()
  const hash = flowHash(flow)
  const bigger = validateFlow({ ...flow, tasks: [...flow.tasks, { id: 'T3', goal: 'third', files: ['docs/'], dependsOn: ['T2'], acceptance: { criteria: ['reads well'] } }] })
  if (!bigger.ok) throw new Error('fixture')
  const approved = { approvedHash: hash, flow }
  const record = attestOf(approved)
  expect(record).toEqual({ approvedHash: hash, snapshotHash: hash })
  expect(matchesAttest(approved, record)).toBe(true)
  // A forged adoption: the approved hash is the real one, the flow is another, and its own hash is consistent.
  expect(matchesAttest({ approvedHash: hash, adoptedHash: bigger.hash, flow: bigger.flow }, record)).toBe(false)
  // A different flow under the recorded hashes.
  expect(matchesAttest({ approvedHash: hash, flow: bigger.flow }, record)).toBe(false)
  expect(matchesAttest({ approvedHash: bigger.hash, flow: bigger.flow }, record)).toBe(false)
  // An adoption recorded by the host is matched, and so is only that one.
  const adopted = { approvedHash: hash, adoptedHash: bigger.hash, flow: bigger.flow }
  const adoptedRecord = attestOf(adopted, ['T3'])
  expect(adoptedRecord).toEqual({ approvedHash: hash, adoptedHash: bigger.hash, snapshotHash: bigger.hash, adopted: ['T3'] })
  expect(matchesAttest(adopted, adoptedRecord)).toBe(true)
  expect(matchesAttest(approved, adoptedRecord)).toBe(false)
})
