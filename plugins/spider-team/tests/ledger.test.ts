import { expect, test } from 'claude-code/testing'
import { afterAgentCall, afterTurn, appendLine, bucketOf, costOf, createPending, decisionLine, formatSummary, ledgerPath, modelFamily, parseLedger, readAll, ROTATE_AT, rotatedPath, summarize, verdictOf } from '../hooks/ledger'
import type { DecisionLine, FileIo, Line, OutcomeLine } from '../hooks/ledger'

const MARKER = 'SECRET-MARKER-7f3a'
const ctx = (role: 'analyst' | 'developer' | 'reviewer' | 'architect' = 'reviewer', id = 'toolu_1') => ({ toolUseId: id, role, pair: { model: 'opus' as const, effort: 'medium' as const } })
const completed = (text: string, patch = {}) => ({
  ref: 'r', text: MARKER, result: {
    agentId: 'a1', status: 'completed', prompt: MARKER, resolvedModel: 'claude-opus-5-5', modelsUsed: ['claude-opus-5-5'], totalToolUseCount: 3, totalDurationMs: 90_000, totalTokens: 13_500,
    worktreePath: `/private/${MARKER}`, worktreeBranch: MARKER,
    usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000, server_tool_use: null, service_tier: null, cache_creation: null },
    content: [{ type: 'text', text }], ...patch,
  },
})
const fakeFiles = () => {
  const files = new Map<string, string>(), faults = { read: false, write: false, order: [] as string[] }
  const io: FileIo = {
    exists: async path => files.has(path),
    read: async path => { if (faults.read) throw new Error('unreadable'); return files.get(path)! },
    write: async (path, text) => { if (faults.write) throw new Error('unwritable'); faults.order.push(path); files.set(path, text) },
  }
  return { files, faults, io }
}

test('a decision line projects only the allowed fields and rounds the probabilities to two decimals', () => {
  const choice = {
    source: 'jev' as const, jevReason: null, jevMs: 412, levels: { difficulty: 2, duration: 1 }, top: { difficulty: 0.8349, duration: 0.5 },
    cell: { model: 'haiku' as const, effort: 'xhigh' as const }, floorApplied: true, model: 'opus' as const, effort: 'low' as const,
    prompt: MARKER, task: MARKER, path: `/private/${MARKER}`,
  }
  const line = decisionLine({ ts: '2026-10-14T10:00:00.000Z', toolUseId: 'toolu_1', role: 'architect', choice })
  expect(line).toEqual({
    v: 1, kind: 'decision', ts: '2026-10-14T10:00:00.000Z', tool_use_id: 'toolu_1', role: 'architect', source: 'jev', jevReason: null, jevMs: 412,
    levels: { difficulty: 2, duration: 1 }, top: { difficulty: 0.83, duration: 0.5 }, cell: 'haiku/xhigh', floorApplied: true, model: 'opus', effort: 'low',
  })
  expect(JSON.stringify(line)).not.toContain(MARKER)
  const fallback = decisionLine({ ts: 't', toolUseId: undefined, role: 'analyst', choice: { source: 'default', jevReason: 'no-key', jevMs: null, levels: null, top: null, cell: null, floorApplied: false, model: 'haiku', effort: 'high' } })
  expect(fallback).toMatchObject({ tool_use_id: null, source: 'default', jevReason: 'no-key', jevMs: null, levels: null, top: null, cell: null })
})

test('only the verdict word of a reviewer answer is extracted', () => {
  expect(verdictOf('Findings...\nVerdict: CHANGES\nRisk: low')).toBe('CHANGES')
  expect(verdictOf('**Verdict:** APPROVED')).toBe('APPROVED')
  expect(verdictOf('verdict - blocked on the missing migration')).toBe('BLOCKED')
  expect(verdictOf('Verdict: CHANGES (earlier draft said APPROVED)')).toBe('CHANGES')
  expect(verdictOf('The change is BLOCKED by the lead.')).toBe('BLOCKED')
  expect(verdictOf('APPROVED or CHANGES, I cannot say')).toBeNull()
  expect(verdictOf('no verdict here')).toBeNull()
})

test('the estimated cost follows the list prices of the resolved model family', () => {
  const tokens = { input: 1000, output: 500, cacheCreation: 2000, cacheRead: 10_000 }
  expect(costOf('haiku', tokens)).toBe(0.0007)
  expect(costOf('sonnet', tokens)).toBe(0.013)
  expect(costOf('opus', tokens)).toBe(0.026)
  expect(costOf(null, tokens)).toBeNull()
  expect(modelFamily('claude-haiku-5-5')).toBe('haiku'); expect(modelFamily('Claude-Sonnet-5-5')).toBe('sonnet'); expect(modelFamily('gpt-x')).toBeNull(); expect(modelFamily(null)).toBeNull()
})

test('a finished foreground run becomes one outcome line with usage, cost and a reviewer verdict, and nothing else of the result', () => {
  const ended = afterAgentCall(ctx(), completed(`${MARKER}\nVerdict: CHANGES`), '2026-10-14T10:05:00.000Z')
  expect(ended).toEqual({ line: {
    v: 1, kind: 'outcome', ts: '2026-10-14T10:05:00.000Z', tool_use_id: 'toolu_1', role: 'reviewer', model: 'opus', effort: 'medium', mode: 'foreground',
    resolvedModel: 'claude-opus-5-5', modelsUsed: 1, status: 'completed', aborted: false, durationMs: 90_000,
    tokens: { input: 1000, output: 500, cacheCreation: 2000, cacheRead: 10_000 }, costUsd: 0.026, verdict: 'CHANGES',
  } })
  expect(JSON.stringify(ended)).not.toContain(MARKER)
  // Only a reviewer has a verdict; null cache counts are zero; an unknown resolved id costs by the routed family.
  const other = afterAgentCall(ctx('developer'), completed('Verdict: CHANGES', { resolvedModel: 'mystery', usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: null, cache_read_input_tokens: null } }), 't') as { line: OutcomeLine }
  expect(other.line).toMatchObject({ verdict: null, resolvedModel: 'mystery', tokens: { input: 1000, output: 500, cacheCreation: 0, cacheRead: 0 }, costUsd: 0.0140 })
  expect(afterAgentCall(ctx(), completed('x', { resolvedModel: `has space ${MARKER}` }), 't')).toMatchObject({ line: { resolvedModel: null } })
  // The handback report stands in for content.
  const handback = afterAgentCall(ctx(), completed('', { content: [], handbackReport: { text: 'Verdict: APPROVED' } }), 't') as { line: OutcomeLine }
  expect(handback.line.verdict).toBe('APPROVED')
})

test('a tool error is an error outcome, a background launch is awaited, and a refusal or unknown shape writes nothing', () => {
  expect(afterAgentCall(ctx('analyst'), { result: 'boom', isError: true, text: MARKER }, 't')).toMatchObject({ line: { status: 'error', tokens: null, costUsd: null, durationMs: null, verdict: null, mode: 'foreground' } })
  expect(afterAgentCall(ctx(), { result: { status: 'async_launched', agentId: 'bg-1', prompt: MARKER, description: MARKER, outputFile: `/tmp/${MARKER}` } }, 't')).toEqual({ launched: 'bg-1' })
  expect(afterAgentCall(ctx(), { result: { status: 'async_launched' } }, 't')).toBeNull()
  for (const value of [{ deny: 'no' }, { result: { status: 'remote_launched' } }, { result: 'text' }, 'text', null, undefined, 3]) expect(afterAgentCall(ctx(), value, 't')).toBeNull()
})

test('a background end becomes an outcome line from its turn: duration, usage, reason, abort and the reviewer verdict', () => {
  const turn = { answer: `${MARKER} Verdict: BLOCKED`, durationMs: 5000, isAborted: false, reason: 'answer', usage: { model: 'claude-haiku-5-5', input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000 } }
  const done = afterTurn(ctx(), turn, 't')
  expect(done).toMatchObject({ mode: 'background', status: 'completed', aborted: false, durationMs: 5000, resolvedModel: 'claude-haiku-5-5', modelsUsed: null, costUsd: 0.0007, verdict: 'BLOCKED' })
  expect(JSON.stringify(done)).not.toContain(MARKER)
  expect(afterTurn(ctx('analyst'), { ...turn, isAborted: true, reason: 'aborted' }, 't')).toMatchObject({ status: 'aborted', aborted: true, verdict: null })
  expect(afterTurn(ctx(), { answer: '', durationMs: 10, isAborted: false, reason: 'error' }, 't')).toMatchObject({ status: 'error', tokens: null, costUsd: null, verdict: null })
  expect(afterTurn(ctx(), { answer: '', durationMs: 10, isAborted: false, reason: 'refusal' }, 't').status).toBe('refusal')
})

test('the background map is bounded, drops the oldest and gives each agent once', () => {
  const pending = createPending(3)
  for (const id of ['a', 'b', 'c', 'd']) pending.add(id, ctx('analyst', id))
  expect(pending.size).toBe(3)
  expect(pending.take('a')).toBeUndefined()
  expect(pending.take('b')).toMatchObject({ toolUseId: 'b' })
  expect(pending.take('b')).toBeUndefined()
  expect(createPending().size).toBe(0)
})

test('appends are serialized so concurrent lines all survive in order, and one failed append does not stop the next', async () => {
  const { files, io, faults } = fakeFiles(), path = ledgerPath('/home/u/')
  expect(path).toBe('/home/u/.claude/spider-team/routes.jsonl')
  const line = (n: number): Line => ({ ...decisionLine({ ts: `t${n}`, toolUseId: `id${n}`, role: 'analyst', choice: { source: 'default', jevReason: null, jevMs: null, levels: null, top: null, cell: null, floorApplied: false, model: 'haiku', effort: 'high' } }) })
  await Promise.all([1, 2, 3, 4].map(n => appendLine(io, path, line(n))))
  expect(files.get(path)!.split('\n').filter(Boolean).map(l => JSON.parse(l).ts)).toEqual(['t1', 't2', 't3', 't4'])
  faults.write = true
  await expect(appendLine(io, path, line(5))).rejects.toThrow('unwritable')
  faults.write = false
  await appendLine(io, path, line(6))
  expect(files.get(path)!.split('\n').filter(Boolean).map(l => JSON.parse(l).ts)).toEqual(['t1', 't2', 't3', 't4', 't6'])
})

test('a ledger that cannot be read is never overwritten, and a full one moves to its rotated generation', async () => {
  const { files, io, faults } = fakeFiles(), path = ledgerPath('/home/u')
  files.set(path, '{"keep":"me"}\n')
  faults.read = true
  await expect(appendLine(io, path, decisionLine({ ts: 't', toolUseId: 'x', role: 'analyst', choice: { source: 'default', jevReason: null, jevMs: null, levels: null, top: null, cell: null, floorApplied: false, model: 'haiku', effort: 'high' } }))).rejects.toThrow('unreadable')
  expect(files.get(path)).toBe('{"keep":"me"}\n')
  faults.read = false
  const big = `${'x'.repeat(ROTATE_AT)}\n`
  files.set(path, big)
  await appendLine(io, path, decisionLine({ ts: 'new', toolUseId: 'y', role: 'analyst', choice: { source: 'default', jevReason: null, jevMs: null, levels: null, top: null, cell: null, floorApplied: false, model: 'haiku', effort: 'high' } }))
  expect(files.get(rotatedPath(path))).toBe(big)
  expect(files.get(path)!.split('\n').filter(Boolean)).toHaveLength(1)
  expect(await readAll(io, path)).toContain('"ts":"new"')
  expect(rotatedPath(path)).toBe('/home/u/.claude/spider-team/routes.1.jsonl')
})

test('parsing skips malformed and foreign lines and counts a repeated line once', () => {
  const decision = JSON.stringify({ v: 1, kind: 'decision', ts: 't', tool_use_id: 'a', role: 'analyst', model: 'haiku', effort: 'high', source: 'default' })
  const text = ['not json', '', decision, decision, JSON.stringify({ v: 2, kind: 'decision', role: 'analyst', model: 'haiku', effort: 'high' }), JSON.stringify({ v: 1, kind: 'other', role: 'analyst', model: 'haiku', effort: 'high' }), JSON.stringify({ v: 1, kind: 'outcome', role: 'nobody', model: 'haiku', effort: 'high' }), '[1]', '3'].join('\n')
  expect(parseLedger(text)).toHaveLength(1)
})

const decision = (id: string, role: DecisionLine['role'], patch: Partial<DecisionLine> = {}): DecisionLine => ({
  v: 1, kind: 'decision', ts: 't', tool_use_id: id, role, source: 'jev', jevReason: null, jevMs: 100, levels: { difficulty: 1, duration: 0 }, top: { difficulty: 0.95, duration: 0.6 },
  cell: 'haiku/high', floorApplied: false, model: 'haiku', effort: 'high', ...patch,
})
const outcome = (id: string, role: OutcomeLine['role'], patch: Partial<OutcomeLine> = {}): OutcomeLine => ({
  v: 1, kind: 'outcome', ts: 't', tool_use_id: id, role, model: 'haiku', effort: 'high', mode: 'foreground', resolvedModel: 'claude-haiku-5-5', modelsUsed: 1, status: 'completed', aborted: false, durationMs: 60_000,
  tokens: { input: 1000, output: 1000, cacheCreation: 0, cacheRead: 0 }, costUsd: 0.001, verdict: null, ...patch,
})
const MIN = 60_000
const fixture: Line[] = [
  decision('a1', 'analyst'), outcome('a1', 'analyst', { durationMs: 2 * MIN }),
  decision('a2', 'analyst', { levels: { difficulty: 1, duration: 3 }, top: { difficulty: 0.4, duration: 0.8 } }), outcome('a2', 'analyst', { durationMs: 10 * MIN, status: 'error', tokens: null, costUsd: null }),
  decision('d1', 'developer', { levels: { difficulty: 2, duration: 2 }, model: 'sonnet', effort: 'high' }), outcome('d1', 'developer', { model: 'sonnet', effort: 'high', durationMs: 31 * MIN, costUsd: 0.04, tokens: { input: 5000, output: 5000, cacheCreation: 0, cacheRead: 0 } }),
  decision('d2', 'developer', { source: 'default', jevReason: 'no-key', levels: null, top: null, cell: null, model: 'sonnet', effort: 'high' }), outcome('d2', 'developer', { model: 'sonnet', effort: 'high', mode: 'background', durationMs: 130 * MIN, costUsd: 0.06, tokens: { input: 5000, output: 5000, cacheCreation: 0, cacheRead: 0 } }),
  decision('r1', 'reviewer', { source: 'default', jevReason: 'http', levels: null, top: null, cell: null, model: 'opus', effort: 'medium' }), outcome('r1', 'reviewer', { model: 'opus', effort: 'medium', durationMs: 5 * MIN, verdict: 'CHANGES', costUsd: 0.1 }),
  decision('r2', 'reviewer', { source: 'default', jevReason: 'no-key', levels: null, top: null, cell: null, model: 'opus', effort: 'medium' }), outcome('r2', 'reviewer', { model: 'opus', effort: 'medium', durationMs: 3 * MIN, verdict: 'APPROVED', costUsd: 0.1 }),
  decision('x9', 'architect', { levels: { difficulty: 3, duration: 1 }, top: { difficulty: 0.5, duration: 0.7 }, model: 'opus', effort: 'low' }),
]

test('the summary counts runs, failures, medians, tokens, cost, fallbacks, confidence and the duration check', () => {
  const s = summarize(fixture)
  expect([s.decisions, s.outcomes]).toEqual([7, 6])
  const role = Object.fromEntries(s.byRole.map(r => [r.key, r.group]))
  expect(s.byRole.map(r => r.key)).toEqual(['analyst', 'developer', 'reviewer'])
  expect(role.analyst).toEqual({ count: 2, failures: 1, medianMs: 6 * MIN, tokens: 2000, costUsd: 0.001 })
  expect(role.developer).toEqual({ count: 2, failures: 0, medianMs: 80.5 * MIN, tokens: 20_000, costUsd: 0.1 })
  expect(role.reviewer).toMatchObject({ count: 2, failures: 1, medianMs: 4 * MIN, costUsd: 0.2 })
  expect(s.byPair.map(p => [p.key, p.group.count])).toEqual([['haiku/high', 2], ['sonnet/high', 2], ['opus/medium', 2]])
  expect(s.fallback).toEqual({ count: 3, reasons: { 'no-key': 2, http: 1 } })
  // Top probabilities: difficulty 0.95, 0.4, 0.5 and the jev decision of d1 (0.95); duration 0.6, 0.8, 0.6, 0.7.
  expect(s.confidence.difficulty).toEqual({ count: 4, median: 0.725, buckets: [1, 1, 0, 2] })
  expect(s.confidence.duration).toEqual({ count: 4, median: 0.65, buckets: [0, 2, 2, 0] })
  // Compared: a1 short->2m short, a2 long->10m short, d1 medium->31m medium; d2 and the reviewers have no levels, x9 has no outcome.
  expect(s.durationCheck).toEqual({ compared: 3, hits: 2, matrix: { short: { short: 1, medium: 0, long: 0 }, medium: { short: 0, medium: 1, long: 0 }, long: { short: 1, medium: 0, long: 0 } } })
  expect([bucketOf(29 * MIN), bucketOf(30 * MIN), bucketOf(120 * MIN), bucketOf(121 * MIN)]).toEqual(['short', 'medium', 'medium', 'long'])
})

test('the formatted summary is compact and names every part, and an empty ledger says so', () => {
  const text = formatSummary(summarize(fixture))
  for (const part of ['7 decisions, 6 outcomes', 'By role', 'analyst', 'fail=50%', 'By final pair', 'opus/medium', 'Default fallbacks: 3 of 7 (43%): http 1, no-key 2', 'Jev top confidence', 'difficulty', 'median=0.72', '[1 / 1 / 0 / 2]', 'Duration check', '2 of 3 in the predicted group (67%)', 'predicted long   -> short 1, medium 0, long 0']) expect(text).toContain(part)
  expect(text).not.toContain('/home')
  expect(formatSummary(summarize([]))).toBe('spider-team: no routing records yet in ~/.claude/spider-team/routes.jsonl.')
  expect(formatSummary(summarize([decision('only', 'analyst')]))).toContain('no outcomes yet')
})
