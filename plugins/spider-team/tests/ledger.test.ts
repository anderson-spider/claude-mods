import { expect, test } from 'claude-code/testing'
import { afterAgentCall, afterTurn, appendLine, costOf, createPending, decisionLine, formatSummary, judgeOf, ledgerPath, modelFamily, parseLedger, readAll, ROTATE_AT, rotatedPath, summarize, verdictOf, withJudge } from '../hooks/ledger'
import type { DecisionLine, FileIo, Line, OutcomeLine } from '../hooks/ledger'
import type { Distributions } from '../hooks/effort'
import { CALIBRATION } from '../hooks/router'

const MARKER = 'SECRET-MARKER-7f3a'
const ctx = (role: 'analyst' | 'planner' | 'reviewer' = 'reviewer', id = 'toolu_1') => ({ toolUseId: id, role, pair: { model: 'opus' as const, effort: 'medium' as const } })
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
    dist: { difficulty: { '0': 0, '1': 0.0551, '2': 0.8349, '3': 0.11, '4': 0 }, duration: { '0': 0.25, '1': 0.5, '2': 0.25, '3': 0 } },
    cell: { model: 'haiku' as const, effort: 'xhigh' as const }, floorApplied: true, model: 'opus' as const, effort: 'low' as const,
    prompt: MARKER, task: MARKER, path: `/private/${MARKER}`,
  }
  const line = decisionLine({ ts: '2026-10-14T10:00:00.000Z', toolUseId: 'toolu_1', role: 'planner', choice })
  expect(line).toEqual({
    v: 1, kind: 'decision', calibration: CALIBRATION, ts: '2026-10-14T10:00:00.000Z', tool_use_id: 'toolu_1', role: 'planner', source: 'jev', jevReason: null, jevMs: 412,
    levels: { difficulty: 2, duration: 1 }, top: { difficulty: 0.83, duration: 0.5 },
    dist: { difficulty: { '0': 0, '1': 0.06, '2': 0.83, '3': 0.11, '4': 0 }, duration: { '0': 0.25, '1': 0.5, '2': 0.25, '3': 0 } },
    cell: 'haiku/xhigh', floorApplied: true, model: 'opus', effort: 'low',
  })
  expect(JSON.stringify(line)).not.toContain(MARKER)
  const fallback = decisionLine({ ts: 't', toolUseId: undefined, role: 'analyst', choice: { source: 'default', jevReason: 'no-key', jevMs: null, levels: null, top: null, dist: null, cell: null, floorApplied: false, model: 'haiku', effort: 'high' } })
  expect(fallback).toMatchObject({ tool_use_id: null, source: 'default', jevReason: 'no-key', jevMs: null, levels: null, top: null, dist: null, cell: null })
})

test('a decision line keeps each full distribution with only its level keys and finite probabilities', () => {
  // Hostile input: a foreign dimension, keys that are not levels of the question, and values that are not finite probabilities.
  const dist = {
    difficulty: { '0': 0.004, '1': 0.006, '2': 0.57, '3': 0.42, '4': 0, '5': 0.3, '-1': 0.2, '1.5': 0.1, ' 2': 0.1, [MARKER]: 0.5, secret: 0.4 },
    duration: { '0': NaN, '1': Infinity, '2': 1.5, '3': -0.1, x: 1, '01': 0.2 },
    [MARKER]: { '0': 1 },
  } as unknown as Distributions
  const choice = { source: 'jev' as const, jevReason: null, jevMs: 5, levels: { difficulty: 2, duration: 0 }, top: { difficulty: 0.57, duration: 1 }, dist, cell: null, floorApplied: false, model: 'haiku' as const, effort: 'xhigh' as const }
  const line = decisionLine({ ts: 't', toolUseId: 'toolu_d', role: 'analyst', choice })
  expect(line.dist).toEqual({ difficulty: { '0': 0, '1': 0.01, '2': 0.57, '3': 0.42, '4': 0 }, duration: {} })
  expect(Object.keys(line.dist!)).toEqual(['difficulty', 'duration'])
  expect(JSON.stringify(line)).not.toContain(MARKER); expect(JSON.stringify(line)).not.toContain('secret')
  // A distribution that is not an object projects to nothing; Jev not used is null.
  expect(decisionLine({ ts: 't', toolUseId: 'x', role: 'analyst', choice: { ...choice, dist: { difficulty: MARKER, duration: [1] } as unknown as Distributions } }).dist).toEqual({ difficulty: {}, duration: {} })
  expect(decisionLine({ ts: 't', toolUseId: 'x', role: 'analyst', choice: { ...choice, dist: null } }).dist).toBeNull()
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
    tokens: { input: 1000, output: 500, cacheCreation: 2000, cacheRead: 10_000 }, costUsd: 0.026, verdict: 'CHANGES', judge: null,
  }, answer: `${MARKER}\nVerdict: CHANGES` })
  // The answer is handed back for the judge only; the line holds none of it.
  expect(JSON.stringify((ended as { line: OutcomeLine }).line)).not.toContain(MARKER)
  // Only a reviewer has a verdict; null cache counts are zero; an unknown resolved id costs by the routed family.
  const other = afterAgentCall(ctx('planner'), completed('Verdict: CHANGES', { resolvedModel: 'mystery', usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: null, cache_read_input_tokens: null } }), 't') as { line: OutcomeLine }
  expect(other.line).toMatchObject({ verdict: null, resolvedModel: 'mystery', tokens: { input: 1000, output: 500, cacheCreation: 0, cacheRead: 0 }, costUsd: 0.0140 })
  expect(afterAgentCall(ctx(), completed('x', { resolvedModel: `has space ${MARKER}` }), 't')).toMatchObject({ line: { resolvedModel: null } })
  // The handback report stands in for content.
  const handback = afterAgentCall(ctx(), completed('', { content: [], handbackReport: { text: 'Verdict: APPROVED' } }), 't') as { line: OutcomeLine }
  expect(handback.line.verdict).toBe('APPROVED')
})

test('a tool error is an error outcome, a background launch is awaited, and a refusal or unknown shape writes nothing', () => {
  expect(afterAgentCall(ctx('analyst'), { result: 'boom', isError: true, text: MARKER }, 't')).toEqual({ line: expect.objectContaining({ status: 'error', tokens: null, costUsd: null, durationMs: null, verdict: null, judge: null, mode: 'foreground' }), answer: '' })
  expect(afterAgentCall(ctx(), { result: { status: 'async_launched', agentId: 'bg-1', prompt: MARKER, description: MARKER, outputFile: `/tmp/${MARKER}` } }, 't')).toEqual({ launched: 'bg-1' })
  expect(afterAgentCall(ctx(), { result: { status: 'async_launched' } }, 't')).toBeNull()
  for (const value of [{ deny: 'no' }, { result: { status: 'remote_launched' } }, { result: 'text' }, 'text', null, undefined, 3]) expect(afterAgentCall(ctx(), value, 't')).toBeNull()
})

test('a background end becomes an outcome line from its turn: duration, usage, reason, abort and the reviewer verdict', () => {
  const turn = { answer: `${MARKER} Verdict: BLOCKED`, durationMs: 5000, isAborted: false, reason: 'answer', usage: { model: 'claude-haiku-5-5', input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000 } }
  const done = afterTurn(ctx(), turn, 't')
  expect(done.line).toMatchObject({ mode: 'background', status: 'completed', aborted: false, durationMs: 5000, resolvedModel: 'claude-haiku-5-5', modelsUsed: null, costUsd: 0.0007, verdict: 'BLOCKED', judge: null })
  expect(done.answer).toBe(turn.answer)
  expect(JSON.stringify(done.line)).not.toContain(MARKER)
  // A run that did not complete hands back no answer to judge.
  expect(afterTurn(ctx('analyst'), { ...turn, isAborted: true, reason: 'aborted' }, 't')).toEqual({ line: expect.objectContaining({ status: 'aborted', aborted: true, verdict: null }), answer: '' })
  expect(afterTurn(ctx('analyst'), { ...turn, isAborted: true }, 't').answer).toBe('')
  expect(afterTurn(ctx(), { answer: MARKER, durationMs: 10, isAborted: false, reason: 'error' }, 't')).toEqual({ line: expect.objectContaining({ status: 'error', tokens: null, costUsd: null, verdict: null }), answer: '' })
  expect(afterTurn(ctx(), { answer: MARKER, durationMs: 10, isAborted: false, reason: 'refusal' }, 't')).toEqual({ line: expect.objectContaining({ status: 'refusal' }), answer: '' })
})

test('the judge projects its three flags only, each a finite probability rounded to two decimals, and only a completed run keeps one', () => {
  expect(judgeOf({ finished: 0.914, failingChecks: 0.005, blocked: 1, extra: 0.5, [MARKER]: 1, note: MARKER })).toEqual({ finished: 0.91, failingChecks: 0.01, blocked: 1 })
  // One hostile, missing or out-of-range flag drops the whole judge: a partial judge cannot apply the short rule.
  for (const bad of [{ finished: NaN, failingChecks: 0, blocked: 0 }, { finished: 1, failingChecks: Infinity, blocked: 0 }, { finished: 1, failingChecks: 0, blocked: 1.01 }, { finished: -0.1, failingChecks: 0, blocked: 0 },
    { finished: '0.9', failingChecks: 0, blocked: 0 }, { finished: 1, failingChecks: 0 }, [0.9, 0, 0], MARKER, null, undefined, 1]) expect(judgeOf(bad)).toBeNull()
  const completedLine = (afterAgentCall(ctx('planner'), completed('Done.'), 't') as { line: OutcomeLine }).line
  const judgedLine = withJudge(completedLine, { finished: 0.876, failingChecks: 0.02, blocked: 0.1, text: MARKER })
  expect(judgedLine.judge).toEqual({ finished: 0.88, failingChecks: 0.02, blocked: 0.1 })
  expect(JSON.stringify(judgedLine)).not.toContain(MARKER)
  expect(withJudge(completedLine, { finished: NaN, failingChecks: 0, blocked: 0 }).judge).toBeNull()
  expect(withJudge(completedLine, null).judge).toBeNull()
  // Error, refused and aborted runs are never judged, whatever is passed.
  const judge = { finished: 1, failingChecks: 0, blocked: 0 }
  for (const status of ['error', 'refusal', 'aborted'] as const) expect(withJudge({ ...completedLine, status, aborted: status === 'aborted' }, judge).judge).toBeNull()
  expect(withJudge({ ...completedLine, aborted: true }, judge).judge).toBeNull()
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
  const line = (n: number): Line => ({ ...decisionLine({ ts: `t${n}`, toolUseId: `id${n}`, role: 'analyst', choice: { source: 'default', jevReason: null, jevMs: null, levels: null, top: null, dist: null, cell: null, floorApplied: false, model: 'haiku', effort: 'high' } }) })
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
  await expect(appendLine(io, path, decisionLine({ ts: 't', toolUseId: 'x', role: 'analyst', choice: { source: 'default', jevReason: null, jevMs: null, levels: null, top: null, dist: null, cell: null, floorApplied: false, model: 'haiku', effort: 'high' } }))).rejects.toThrow('unreadable')
  expect(files.get(path)).toBe('{"keep":"me"}\n')
  faults.read = false
  const big = `${'x'.repeat(ROTATE_AT)}\n`
  files.set(path, big)
  await appendLine(io, path, decisionLine({ ts: 'new', toolUseId: 'y', role: 'analyst', choice: { source: 'default', jevReason: null, jevMs: null, levels: null, top: null, dist: null, cell: null, floorApplied: false, model: 'haiku', effort: 'high' } }))
  expect(files.get(rotatedPath(path))).toBe(big)
  expect(files.get(path)!.split('\n').filter(Boolean)).toHaveLength(1)
  expect(await readAll(io, path)).toContain('"ts":"new"')
  expect(rotatedPath(path)).toBe('/home/u/.claude/spider-team/routes.1.jsonl')
})

test('parsing skips malformed and foreign lines, counts a repeated line once and keeps the retired developer and architect lines', () => {
  const decision = JSON.stringify({ v: 1, kind: 'decision', ts: 't', tool_use_id: 'a', role: 'analyst', model: 'haiku', effort: 'high', source: 'default' })
  const retired = ['developer', 'architect'].map(role => JSON.stringify({ v: 1, kind: 'outcome', ts: 't', tool_use_id: role, role, model: 'opus', effort: 'medium' }))
  expect(parseLedger(retired.join('\n')).map(l => l.role)).toEqual(['developer', 'architect'])
  // Each retired role is its own stats group: an old architect outcome is not counted as the planner.
  expect(summarize(parseLedger(retired.join('\n'))).byRole.map(r => [r.key, r.group.count])).toEqual([['developer', 1], ['architect', 1]])
  const text = ['not json', '', decision, decision, JSON.stringify({ v: 2, kind: 'decision', role: 'analyst', model: 'haiku', effort: 'high' }), JSON.stringify({ v: 1, kind: 'other', role: 'analyst', model: 'haiku', effort: 'high' }), JSON.stringify({ v: 1, kind: 'outcome', role: 'nobody', model: 'haiku', effort: 'high' }), '[1]', '3'].join('\n')
  expect(parseLedger(text)).toHaveLength(1)
})

const decision = (id: string, role: DecisionLine['role'], patch: Partial<DecisionLine> = {}): DecisionLine => ({
  v: 1, kind: 'decision', calibration: CALIBRATION, ts: 't', tool_use_id: id, role, source: 'jev', jevReason: null, jevMs: 100, levels: { difficulty: 1, duration: 0 }, top: { difficulty: 0.95, duration: 0.6 }, dist: null,
  cell: 'haiku/high', floorApplied: false, model: 'haiku', effort: 'high', ...patch,
})
const outcome = (id: string, role: OutcomeLine['role'], patch: Partial<OutcomeLine> = {}): OutcomeLine => ({
  v: 1, kind: 'outcome', ts: 't', tool_use_id: id, role, model: 'haiku', effort: 'high', mode: 'foreground', resolvedModel: 'claude-haiku-5-5', modelsUsed: 1, status: 'completed', aborted: false, durationMs: 60_000,
  tokens: { input: 1000, output: 1000, cacheCreation: 0, cacheRead: 0 }, costUsd: 0.001, verdict: null, ...patch,
})
const MIN = 60_000
const OK = { finished: 0.95, failingChecks: 0.02, blocked: 0.03 }
const fixture: Line[] = [
  decision('a1', 'analyst'), outcome('a1', 'analyst', { durationMs: 2 * MIN, judge: OK }),
  decision('a2', 'analyst', { levels: { difficulty: 1, duration: 3 }, top: { difficulty: 0.4, duration: 0.8 } }), outcome('a2', 'analyst', { durationMs: 5 * MIN, status: 'error', tokens: null, costUsd: null }),
  decision('d1', 'developer', { levels: { difficulty: 2, duration: 2 }, model: 'sonnet', effort: 'high' }), outcome('d1', 'developer', { model: 'sonnet', effort: 'high', durationMs: 12 * MIN, costUsd: 0.04, tokens: { input: 5000, output: 5000, cacheCreation: 0, cacheRead: 0 }, judge: { ...OK, failingChecks: 0.9 } }),
  decision('d2', 'developer', { source: 'default', jevReason: 'no-key', levels: null, top: null, cell: null, model: 'sonnet', effort: 'high' }), outcome('d2', 'developer', { model: 'sonnet', effort: 'high', mode: 'background', durationMs: 130 * MIN, costUsd: 0.06, tokens: { input: 5000, output: 5000, cacheCreation: 0, cacheRead: 0 }, judge: OK }),
  decision('r1', 'reviewer', { source: 'default', jevReason: 'http', levels: null, top: null, cell: null, model: 'opus', effort: 'medium' }), outcome('r1', 'reviewer', { model: 'opus', effort: 'medium', durationMs: 5 * MIN, verdict: 'CHANGES', costUsd: 0.1 }),
  decision('r2', 'reviewer', { source: 'default', jevReason: 'no-key', levels: null, top: null, cell: null, model: 'opus', effort: 'medium' }), outcome('r2', 'reviewer', { model: 'opus', effort: 'medium', durationMs: 3 * MIN, verdict: 'APPROVED', costUsd: 0.1 }),
  decision('x9', 'architect', { levels: { difficulty: 3, duration: 1 }, top: { difficulty: 0.5, duration: 0.7 }, model: 'opus', effort: 'low' }),
]

test('the summary counts runs, failures, medians, tokens, cost, fallbacks, confidence and the real time per predicted level', () => {
  const s = summarize(fixture)
  expect([s.decisions, s.outcomes, s.olderCalibration]).toEqual([7, 6, 0])
  const role = Object.fromEntries(s.byRole.map(r => [r.key, r.group]))
  // The retired developer's lines keep their own group, after the current roles.
  expect(s.byRole.map(r => r.key)).toEqual(['analyst', 'reviewer', 'developer'])
  expect(role.analyst).toEqual({ count: 2, failures: 1, medianMs: 3.5 * MIN, tokens: 2000, costUsd: 0.001, judged: 1, short: 0 })
  expect(role.developer).toEqual({ count: 2, failures: 0, medianMs: 71 * MIN, tokens: 20_000, costUsd: 0.1, judged: 2, short: 1 })
  expect(role.reviewer).toMatchObject({ count: 2, failures: 1, medianMs: 4 * MIN, costUsd: 0.2, judged: 0, short: 0 })
  expect(s.byPair.map(p => [p.key, p.group.count])).toEqual([['haiku/high', 2], ['sonnet/high', 2], ['opus/medium', 2]])
  expect(s.fallback).toEqual({ count: 3, reasons: { 'no-key': 2, http: 1 } })
  // Top probabilities: difficulty 0.95, 0.4, 0.5 and the jev decision of d1 (0.95); duration 0.6, 0.8, 0.6, 0.7.
  expect(s.confidence.difficulty).toEqual({ count: 4, median: 0.725, buckets: [1, 1, 0, 2] })
  expect(s.confidence.duration).toEqual({ count: 4, median: 0.65, buckets: [0, 2, 2, 0] })
  // Joined to an outcome: a1 level 0 -> 2m, d1 level 2 -> 12m, a2 level 3 -> 5m; d2 and the reviewers have no levels, x9 has no outcome.
  expect(s.byPredictedTime).toEqual([{ count: 1, medianMs: 2 * MIN }, { count: 0, medianMs: null }, { count: 1, medianMs: 12 * MIN }, { count: 1, medianMs: 5 * MIN }])
})

test('each predicted human-time level takes the median real duration of its outcomes, ignoring runs without a duration', () => {
  const lines: Line[] = [
    decision('p1', 'analyst'), outcome('p1', 'analyst', { durationMs: 2 * MIN }),
    decision('p2', 'analyst'), outcome('p2', 'analyst', { durationMs: 4 * MIN }),
    decision('p3', 'analyst'), outcome('p3', 'analyst', { durationMs: null }),
    decision('p4', 'developer', { levels: { difficulty: 3, duration: 1 } }), outcome('p4', 'developer', { durationMs: 90 * MIN }),
    decision('p5', 'developer', { levels: { difficulty: 3, duration: 3 } }), outcome('p5', 'developer', { durationMs: 20 * 1000 }),
    outcome('orphan', 'developer', { durationMs: 9 * MIN }),
  ]
  expect(summarize(lines).byPredictedTime).toEqual([{ count: 2, medianMs: 3 * MIN }, { count: 1, medianMs: 90 * MIN }, { count: 0, medianMs: null }, { count: 1, medianMs: 20_000 }])
  expect(formatSummary(summarize(lines))).toContain([
    'Real agent time by predicted human time (current calibration)',
    '  under 15 min   n=2 median=3m',
    '  15 min to 1 h  n=1 median=1.5h',
    '  1 to 4 h       n=0 median=-',
    '  over 4 h       n=1 median=20s',
  ].join('\n'))
})

test('the formatted summary is compact and names every part, and an empty ledger says so', () => {
  const text = formatSummary(summarize(fixture))
  for (const part of ['7 decisions, 6 outcomes', 'By role', 'analyst', 'fail=50%', 'short=50% judged=2', 'short=- judged=0', 'By final pair', 'opus/medium', 'Default fallbacks: 3 of 7 (43%): http 1, no-key 2', 'Jev top confidence', 'difficulty', 'median=0.72', '[1 / 1 / 0 / 2]', 'Real agent time by predicted human time (current calibration)', '  under 15 min   n=1 median=2m', '  15 min to 1 h  n=0 median=-', '  1 to 4 h       n=1 median=12m', '  over 4 h       n=1 median=5m']) expect(text).toContain(part)
  expect(text).not.toContain('/home')
  // The host prefixes command output with the plugin name; the summary does not repeat it.
  expect(text.startsWith('7 decisions, 6 outcomes (~/.claude/spider-team/routes.jsonl;')).toBe(true); expect(text).not.toContain('spider-team stats')
  expect(formatSummary(summarize([]))).toBe('no routing records yet in ~/.claude/spider-team/routes.jsonl.')
  expect(formatSummary(summarize([decision('only', 'analyst')]))).toContain('no outcomes yet')
  expect(text).not.toContain('older calibrations')
})

test('the routed pairs are priced against the role default on the same tokens, per current role and in total', () => {
  const M = { input: 1_000_000, output: 0, cacheCreation: 0, cacheRead: 0 }
  const lines: Line[] = [
    outcome('v1', 'analyst', { model: 'sonnet', effort: 'high', tokens: M }), outcome('v2', 'analyst', { model: 'haiku', effort: 'medium', tokens: M }),
    outcome('v3', 'analyst', { model: 'opus', effort: 'low', tokens: null, costUsd: null, status: 'error' }),
    outcome('v4', 'planner', { model: 'opus', effort: 'high', tokens: M }),
    outcome('v5', 'reviewer', { model: 'opus', effort: 'medium', tokens: M }), outcome('v6', 'reviewer', { model: 'sonnet', effort: 'high', tokens: M }),
    // A retired role has no default to compare with.
    outcome('v7', 'developer', { model: 'opus', effort: 'high', tokens: M }),
  ]
  const s = summarize(lines)
  // Defaults: analyst haiku/high, planner and reviewer opus/medium. An effort change on the same model prices as no difference.
  expect(s.vsDefault).toEqual([
    { key: 'analyst', versus: { count: 2, below: 1, same: 0, above: 1, routedUsd: 2.1, defaultUsd: 0.2 } },
    { key: 'planner', versus: { count: 1, below: 0, same: 0, above: 1, routedUsd: 4, defaultUsd: 4 } },
    { key: 'reviewer', versus: { count: 2, below: 1, same: 1, above: 0, routedUsd: 6, defaultUsd: 8 } },
    { key: 'total', versus: { count: 5, below: 2, same: 1, above: 2, routedUsd: 12.1, defaultUsd: 12.2 } },
  ])
  expect(formatSummary(s)).toContain([
    'Jev vs role default (a price comparison, not measured savings: the same tokens priced at each model; an effort change alone prices as no difference)',
    '  analyst    n=2 below=1 same=0 above=1 routed=$2.1000 default=$0.2000 extra=$1.9000 (950%)',
    '  planner    n=1 below=0 same=0 above=1 routed=$4.0000 default=$4.0000 saved=$0.0000 (0%)',
    '  reviewer   n=2 below=1 same=1 above=0 routed=$6.0000 default=$8.0000 saved=$2.0000 (25%)',
    '  total      n=5 below=2 same=1 above=2 routed=$12.1000 default=$12.2000 saved=$0.1000 (1%)',
  ].join('\n'))
  expect(formatSummary(summarize([decision('only', 'analyst')]))).toContain('  total      n=0 below=0 same=0 above=0 routed=$0.0000 default=$0.0000 saved=$0.0000 (-)')
})

test('the Jev confidence and the real time per predicted level use only current-calibration decisions, and a line without one is calibration 1', () => {
  // Older decisions: one written before the field existed (calibration 1) and one tagged with an older number, each with its outcome.
  const { calibration: _, ...untagged } = decision('o1', 'analyst', { levels: { difficulty: 1, duration: 3 }, top: { difficulty: 0.1, duration: 0.1 } })
  const older: Line[] = [
    untagged as DecisionLine, outcome('o1', 'analyst', { durationMs: 2 * MIN }),
    decision('o2', 'developer', { calibration: CALIBRATION - 1, levels: { difficulty: 2, duration: 3 }, top: { difficulty: 0.3, duration: 0.2 }, model: 'sonnet', effort: 'high' }),
    outcome('o2', 'developer', { model: 'sonnet', effort: 'high', durationMs: 4 * MIN, status: 'error' }),
    decision('o3', 'reviewer', { calibration: CALIBRATION - 1, source: 'default', jevReason: 'timeout', levels: null, top: null, cell: null, model: 'opus', effort: 'medium' }),
  ]
  const base = summarize(fixture), mixed = summarize([...older, ...fixture])
  expect(mixed.olderCalibration).toBe(3)
  // Only the current decisions count in Jev's confidence and the real time per predicted level.
  expect(mixed.confidence).toEqual(base.confidence)
  expect(mixed.byPredictedTime).toEqual(base.byPredictedTime)
  // Runs, the role and pair groups and the fallback share count every line, whatever its calibration.
  expect([mixed.decisions, mixed.outcomes]).toEqual([10, 8])
  expect(Object.fromEntries(mixed.byRole.map(r => [r.key, r.group.count]))).toEqual({ analyst: 3, developer: 3, reviewer: 2 })
  expect(Object.fromEntries(mixed.byRole.map(r => [r.key, r.group.failures]))).toMatchObject({ developer: 1 })
  expect(mixed.fallback).toEqual({ count: 4, reasons: { 'no-key': 2, http: 1, timeout: 1 } })
  const text = formatSummary(mixed)
  expect(text).toContain('Default fallbacks: 4 of 10 (40%)')
  expect(text).toContain('Left out of the Jev confidence and the real time per predicted level: 3 decisions from older calibrations')
  expect(text.indexOf('older calibrations')).toBeLessThan(text.indexOf('Jev top confidence'))
  // Only older decisions: nothing to judge, every one named as left out.
  const onlyOld = summarize(older)
  expect([onlyOld.olderCalibration, onlyOld.confidence.difficulty.count, onlyOld.byPredictedTime.reduce((n, t) => n + t.count, 0)]).toEqual([3, 0, 0])
})

test('a run is judged short when not finished or a failing check or a block fires, and each row shows the short share of judged runs', () => {
  const line = (id: string, judge: unknown, patch: Partial<OutcomeLine> = {}) => outcome(id, 'developer', { model: 'sonnet', effort: 'high', judge: judge as OutcomeLine['judge'], ...patch })
  const lines: Line[] = [
    line('ok', { finished: 0.9, failingChecks: 0.5, blocked: 0.5 }), // at the threshold nothing fires
    line('unfinished', { finished: 0.49, failingChecks: 0, blocked: 0 }),
    line('failing', { finished: 1, failingChecks: 0.51, blocked: 0 }),
    line('blocked', { finished: 1, failingChecks: 0, blocked: 0.6 }),
    line('finishedAtFire', { finished: 0.5, failingChecks: 0, blocked: 0 }),
    // Not judged: no judge, a line from before the field, and a hand-edited one with a hostile value.
    line('unjudged', null), line('old', undefined), line('edited', { finished: NaN, failingChecks: 0, blocked: 0 }),
    line('errored', null, { status: 'error' }),
  ]
  const s = summarize(lines)
  expect(s.byRole).toEqual([{ key: 'developer', group: expect.objectContaining({ count: 9, judged: 5, short: 3 }) }])
  expect(s.byPair).toEqual([{ key: 'sonnet/high', group: expect.objectContaining({ judged: 5, short: 3 }) }])
  // The failure rate is the status and the verdict only, as before.
  expect(s.byRole[0]!.group.failures).toBe(1)
  const text = formatSummary(s)
  expect(text).toContain('  developer        n=9 fail=11% short=60% judged=5 median=1m')
  expect(text).toContain('  sonnet/high      n=9 fail=11% short=60% judged=5 median=1m')
  // A row with no judged run says so.
  expect(formatSummary(summarize([line('none', null)]))).toContain('short=- judged=0')
})
