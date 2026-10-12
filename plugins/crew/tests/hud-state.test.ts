import { expect, test } from 'claude-code/testing'
import {
  ADVISOR,
  displayName,
  idsIn,
  isConsultType,
  laneRank,
  leadingStepId,
  providerOfType,
  shortLabel,
  stepIdIn,
  stripTag,
  typeInfo,
  withoutStepId,
} from '../hooks/hud/roles'
import {
  LOOP_ACTIVE_MS,
  MAX_AGENTS,
  MAX_ASKS,
  MAX_LOG,
  MAX_LOOPS,
  MAX_TURNS,
  agentCompleted,
  agentContextPct,
  agentDenied,
  agentSpawned,
  agentStepped,
  agentTool,
  agentsStopped,
  askClosed,
  askOpened,
  cachedShare,
  compactLine,
  consultEnded,
  consultLine,
  consultStarted,
  consulting,
  defaultSession,
  denyLine,
  endLine,
  favoredChangedRecently,
  inputOf,
  isLoopActive,
  isRunning,
  knownAgent,
  lastEndedAt,
  logged,
  loopEnded,
  loopStepped,
  loopSummary,
  modeChanged,
  parseVerdict,
  promptLine,
  runningAgents,
  sessionCompacted,
  sessionMeasured,
  sessionStarted,
  sessionStepped,
  spawnLine,
  statusOfCard,
  statusOf,
  trackFavored,
  turnEnded,
  turnSpawned,
  turnStarted,
  verdictLine,
} from '../hooks/hud/state'
import {
  LANE_CELLS,
  busyText,
  hasTimeline,
  laneStats,
  laneText,
  timelineAxis,
  timelineLanes,
} from '../hooks/hud/timeline'
import type { AgentCard, Consult, LogLine, Loop } from '../hooks/hud/types'
import { cellWidth } from '../hooks/hud/width'

const T0 = Date.parse('2026-10-12T12:00:00Z')
const MIN = 60_000

// ------------------------------------------------------------------ roles

test('typeInfo reads crew roles and twins; anything else is other', () => {
  expect(typeInfo('crew:developer')).toEqual({ role: 'developer', isCodex: false, short: 'developer' })
  expect(typeInfo('crew:developer-codex')).toEqual({ role: 'developer', isCodex: true, short: 'developer-codex' })
  expect(typeInfo('crew:code-reader-codex')).toMatchObject({ role: 'code-reader', isCodex: true })
  expect(typeInfo('crew:architect')).toMatchObject({ role: 'architect', isCodex: false })
  expect(typeInfo('crew:lead')).toMatchObject({ role: 'other' })
  expect(typeInfo('crew:mystery-codex')).toMatchObject({ role: 'other', isCodex: false })
  expect(typeInfo('general-purpose')).toEqual({ role: 'other', isCodex: false, short: 'general-purpose' })
  // another plugin's tester is not the crew's tester
  expect(typeInfo('other:tester')).toMatchObject({ role: 'other', short: 'tester' })
})

test('displayName fits 12 cells: twins get ·cx, the reader is shortened, other types lose their plugin', () => {
  expect(displayName('crew:developer')).toBe('developer')
  expect(displayName('crew:developer-codex')).toBe('developer·cx')
  expect(displayName('crew:tester-codex')).toBe('tester·cx')
  expect(displayName('crew:architect-codex')).toBe('architect·cx')
  expect(displayName('crew:code-reader')).toBe('code-reader')
  expect(displayName('crew:code-reader-codex')).toBe('reader·cx')
  expect(displayName('general-purpose')).toBe('general-pur…')
  expect(displayName('other:Explore')).toBe('Explore')
  expect(displayName('lead')).toBe('lead')
  for (const type of ['crew:designer-codex', 'crew:research-codex', 'crew:code-reader-codex', 'a:very-long-agent-name-indeed']) {
    expect(cellWidth(displayName(type))).toBeLessThanOrEqual(12)
  }
})

test('consults and providers by type', () => {
  expect(isConsultType('crew:architect')).toBe(true)
  expect(isConsultType('crew:architect-codex')).toBe(true)
  expect(isConsultType(ADVISOR)).toBe(true)
  expect(isConsultType('crew:developer')).toBe(false)
  expect(isConsultType('other:architect')).toBe(false)
  expect(providerOfType('crew:tester-codex')).toBe('codex')
  expect(providerOfType('crew:tester')).toBe('claude')
  expect(providerOfType('general-purpose')).toBe('claude')
})

test('lane order follows the role table, a twin right after its base, other types last', () => {
  const types = ['general-purpose', 'crew:architect', 'crew:tester-codex', 'crew:developer-codex', 'crew:developer', 'crew:code-reader', 'crew:research', 'crew:designer']
  expect(types.sort((a, b) => laneRank(a) - laneRank(b))).toEqual([
    'crew:code-reader',
    'crew:research',
    'crew:designer',
    'crew:developer',
    'crew:developer-codex',
    'crew:tester-codex',
    'crew:architect',
    'general-purpose',
  ])
})

test('the leading step id of a description: T3, T3b, R12, with the colon optional', () => {
  expect(leadingStepId('T3: contract suite')).toBe('T3')
  expect(leadingStepId('T3b close the gaps')).toBe('T3b')
  expect(leadingStepId('  R12 — rewrite')).toBe('R12')
  expect(leadingStepId('T3')).toBe('T3')
  expect(leadingStepId('T3branch is not an id')).toBeNull()
  expect(leadingStepId('Fix T3 later')).toBeNull()
  expect(leadingStepId('t3: lower case')).toBeNull()
  expect(leadingStepId('T: no digits')).toBeNull()
  expect(leadingStepId('')).toBeNull()
})

test('step ids as whole words anywhere, against the plan\'s ids', () => {
  const known = new Set(['T3', 'T3b', 'R1'])
  expect(stepIdIn('work on T3b now', known)).toBe('T3b')
  expect(stepIdIn('T3 and R1', known)).toBe('T3')
  expect(stepIdIn('XT3 or T33', known)).toBeNull()
  expect(stepIdIn('T9 only', known)).toBeNull()
  expect(idsIn('R1, T3b (after T3); R1')).toEqual(['R1', 'T3b', 'T3'])
})

test('stripTag removes only the tag Jev writes', () => {
  expect(stripTag('T2: inject · sonnet/high')).toBe('T2: inject')
  expect(stripTag('check · haiku/medium')).toBe('check')
  expect(stripTag('T2: inject · gpt-6-astra/high')).toBe('T2: inject')
  expect(stripTag('T2: inject · claude-opus-5-5/medium')).toBe('T2: inject')
  expect(stripTag('docs · v2/high')).toBe('docs · v2/high')
  expect(stripTag('compare · old/low')).toBe('compare · old/low')
  expect(stripTag('no tag')).toBe('no tag')
  expect(stripTag('  spaced · opus/high ')).toBe('spaced')
})

test('withoutStepId drops the id and its separator; shortLabel cuts at the first mark', () => {
  expect(withoutStepId('T3: contract suite')).toBe('contract suite')
  expect(withoutStepId('T3 — contract suite')).toBe('contract suite')
  expect(withoutStepId('contract suite')).toBe('contract suite')
  expect(withoutStepId('T3')).toBe('T3')
  expect(shortLabel('`plugins/crew/hooks/quota.ts` (Claude and Codex readings)')).toBe('plugins/crew/hooks/quota.ts')
  expect(shortLabel('fix the step grammar; add S3')).toBe('fix the step grammar')
  expect(shortLabel('provider choice in agent.spawn — and more')).toBe('provider choice in agent.spawn')
  expect(shortLabel('contract suite: httptest fakes')).toBe('contract suite')
  expect(shortLabel('plain text')).toBe('plain text')
  expect(shortLabel('(odd) start')).toBe('(odd) start')
  expect(shortLabel('')).toBe('')
})

// ------------------------------------------------------------------ session

test('a fresh session', () => {
  const s = defaultSession(T0)
  expect(s).toMatchObject({ isWorking: false, contextPct: null, costUsd: null, startedAt: T0, tokens: { input: 0, cacheRead: 0, output: 0 }, lastTurn: null, turn: null, asks: [], turns: [] })
  expect(cachedShare(s)).toBeNull()
})

test('sessionStarted resets the counters and keeps what it is given', () => {
  let s = sessionStepped(defaultSession(T0), { isMain: true, model: 'm', usage: { input_tokens: 5 } })
  s = sessionStarted(s, { now: T0 + 9, model: 'claude-opus-5-5', mode: 'auto' })
  expect(s).toMatchObject({ startedAt: T0 + 9, model: 'claude-opus-5-5', mode: 'auto', tokens: { input: 0, cacheRead: 0, output: 0 } })
  expect(sessionStarted(s, { now: 1 })).toMatchObject({ model: 'claude-opus-5-5', mode: 'auto' })
  expect(modeChanged(s, 'plan').mode).toBe('plan')
  expect(modeChanged(s, 'auto')).toBe(s)
})

test('sessionMeasured: percent from the host, or tokens over the window; a missing figure keeps the old one', () => {
  let s = sessionMeasured(defaultSession(T0), { tokens: 128_000, window: 200_000, costUsd: 4.12 })
  expect(s).toMatchObject({ contextTokens: 128_000, contextWindow: 200_000, contextPct: 64, costUsd: 4.12 })
  s = sessionMeasured(s, { percent: 70.4 })
  expect(s).toMatchObject({ contextPct: 70.4, contextTokens: 128_000, costUsd: 4.12 })
  s = sessionMeasured(s, { costUsd: 4.5 })
  expect(s).toMatchObject({ contextPct: 70.4, costUsd: 4.5 })
  expect(sessionMeasured(s, { percent: 250 }).contextPct).toBe(100)
  expect(sessionMeasured(s, { percent: -3 }).contextPct).toBe(0)
  // no window known yet: tokens alone give no percent
  expect(sessionMeasured(defaultSession(T0), { tokens: 10 }).contextPct).toBeNull()
})

test('tokens are summed over every step, main loop and agents: in is input plus cache reads and writes', () => {
  let s = defaultSession(T0)
  s = sessionStepped(s, { isMain: true, model: 'claude-opus-5-5', effort: 'high', usage: { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, output_tokens: 50 } })
  s = sessionStepped(s, { isMain: false, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } })
  expect(s.tokens).toEqual({ input: 1100, cacheRead: 890, output: 55 })
  expect(cachedShare(s)).toBe(81)
  expect(s).toMatchObject({ isWorking: true, model: 'claude-opus-5-5', effort: 'high' })
  // an agent's step does not change the model or the working flag
  const idle = sessionStepped(defaultSession(T0), { isMain: false, model: 'other', usage: { input_tokens: 1 } })
  expect(idle).toMatchObject({ isWorking: false, model: '' })
  // missing or odd usage counts as zero
  expect(sessionStepped(s, { isMain: true }).tokens).toEqual(s.tokens)
  expect(inputOf({ input_tokens: Number.NaN, cache_read_input_tokens: 4 })).toBe(4)
  expect(inputOf(undefined)).toBe(0)
})

test('a turn: tokens and agents count toward its receipt; the receipt and the lead lane close it', () => {
  let s = sessionMeasured(defaultSession(T0), { costUsd: 4 })
  s = turnStarted(s, { now: T0 + 1000 })
  expect(s.isWorking).toBe(true)
  s = sessionStepped(s, { isMain: true, usage: { input_tokens: 12_000, output_tokens: 2100 } })
  s = turnSpawned(turnSpawned(s))
  s = sessionStepped(s, { isMain: false, usage: { input_tokens: 500, output_tokens: 100 } })
  s = sessionMeasured(s, { costUsd: 4.18 })
  s = turnEnded(s, { now: T0 + 43_000, reason: 'answer' })
  expect(s.isWorking).toBe(false)
  expect(s.turn).toBeNull()
  expect(s.lastTurn).toMatchObject({ outcome: 'done', reason: 'answer', durationMs: 42_000, input: 12_500, output: 2200, agents: 2 })
  expect(Math.round((s.lastTurn?.costUsd ?? 0) * 100)).toBe(18)
  expect(s.turns).toEqual([{ startedAt: T0 + 1000, endedAt: T0 + 43_000 }])
  // a spawn outside a turn is not counted
  expect(turnSpawned(defaultSession(T0)).turn).toBeNull()
})

test('receipt outcomes: aborted is stopped, refusal and error are failed; no cost ledger gives null', () => {
  const run = (reason: string) => turnEnded(turnStarted(defaultSession(T0), { now: T0 }), { now: T0 + 1000, reason }).lastTurn
  expect(run('answer')).toMatchObject({ outcome: 'done', costUsd: null })
  expect(run('aborted')?.outcome).toBe('stopped')
  expect(run('refusal')?.outcome).toBe('failed')
  expect(run('error')?.outcome).toBe('failed')
  expect(statusOf('weird')).toBe('failed')
  // a turn that ends without a start event uses the host's duration
  expect(turnEnded(defaultSession(T0), { now: T0 + 5000, reason: 'answer', durationMs: 2000 }).lastTurn?.durationMs).toBe(2000)
  expect(turnEnded(defaultSession(T0), { now: T0 + 5000, reason: 'answer', durationMs: 2000 }).turns).toEqual([{ startedAt: T0 + 3000, endedAt: T0 + 5000 }])
})

test('turns are bounded and compactions counted', () => {
  let s = defaultSession(T0)
  for (let i = 0; i < MAX_TURNS + 5; i++) s = turnEnded(turnStarted(s, { now: T0 + i * 10 }), { now: T0 + i * 10 + 5, reason: 'answer' })
  expect(s.turns).toHaveLength(MAX_TURNS)
  expect(s.turns[MAX_TURNS - 1]?.endedAt).toBe(T0 + (MAX_TURNS + 4) * 10 + 5)
  expect(sessionCompacted(sessionCompacted(s)).compactions).toBe(2)
})

test('permission asks: opened, replaced by id, closed, bounded', () => {
  let s = askOpened(defaultSession(T0), { id: 'a', who: 'developer', tool: 'Bash' })
  s = askOpened(s, { id: 'a', who: 'developer', tool: 'Edit' })
  expect(s.asks).toEqual([{ id: 'a', who: 'developer', tool: 'Edit' }])
  expect(askClosed(s, 'zzz')).toBe(s)
  expect(askClosed(s, 'a').asks).toEqual([])
  for (let i = 0; i < MAX_ASKS + 3; i++) s = askOpened(s, { id: `k${i}`, who: 'w', tool: 't' })
  expect(s.asks).toHaveLength(MAX_ASKS)
})

// ------------------------------------------------------------------ agents

const spawn = (list: AgentCard[], id: string, over: Partial<Parameters<typeof agentSpawned>[1]> = {}) =>
  agentSpawned(list, { id, type: 'crew:developer', description: `T2: task ${id}`, model: 'sonnet', now: T0, ...over })

test('a spawn opens a card with one running round; the Jev tag is stripped and the step id parsed', () => {
  const [a] = spawn([], 'a1', { description: 'T2: contract injection point · sonnet/high', effort: 'high' })
  expect(a).toMatchObject({
    id: 'a1',
    type: 'crew:developer',
    provider: 'claude',
    description: 'T2: contract injection point',
    stepId: 'T2',
    model: 'sonnet',
    effort: 'high',
    spawnedAt: T0,
    rounds: [{ startedAt: T0, status: 'running' }],
    steps: 0,
    ctx: 0,
    lastTool: '',
    denied: '',
  })
  expect(isRunning(a as AgentCard)).toBe(true)
})

test('provider comes from the shared info, else from the type', () => {
  expect(spawn([], 'a', { type: 'crew:tester-codex' })[0]?.provider).toBe('codex')
  expect(spawn([], 'a', { type: 'crew:tester' })[0]?.provider).toBe('claude')
  expect(spawn([], 'a', { type: 'crew:tester', provider: 'codex' })[0]?.provider).toBe('codex')
  expect(spawn([], 'a', { type: 'crew:tester-codex', provider: 'claude' })[0]?.provider).toBe('claude')
})

test('a spawn of a known id replaces its card', () => {
  const list = spawn(spawn([], 'a1'), 'a1', { description: 'again' })
  expect(list).toHaveLength(1)
  expect(list[0]?.description).toBe('again')
})

test('steps count usage, take the model the API reported and the effort the host sent', () => {
  let list = spawn([], 'a1', { model: 'sonnet' })
  list = agentStepped(list, { id: 'a1', model: 'claude-sonnet-5-5', effort: 'high', usage: { input_tokens: 100, cache_read_input_tokens: 4000, output_tokens: 300 }, stopReason: 'tool_use', now: T0 + 1 })
  list = agentStepped(list, { id: 'a1', usage: { input_tokens: 200, cache_read_input_tokens: 4100, output_tokens: 20 }, stopReason: 'end_turn', now: T0 + 2 })
  expect(list[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', steps: 2, ctx: 4300, output: 320, lastStop: 'end_turn' })
  expect(list[0]?.rounds).toHaveLength(1)
  // a numeric effort is kept as text; a missing one keeps the old
  list = agentStepped(list, { id: 'a1', effort: 8000, now: T0 + 3 })
  expect(list[0]?.effort).toBe('8000')
  list = agentStepped(list, { id: 'a1', now: T0 + 4 })
  expect(list[0]?.effort).toBe('8000')
  // an unknown id changes nothing
  expect(agentStepped(list, { id: 'zz', now: T0 })).toEqual(list)
})

test('a step before usage arrives opens no step count', () => {
  const list = agentStepped(spawn([], 'a1'), { id: 'a1', model: 'm', now: T0 })
  expect(list[0]?.steps).toBe(0)
})

test('tools and denials: a denial shows until the next tool', () => {
  let list = agentTool(spawn([], 'a1'), 'a1', 'Edit internal/config/contract_on.go')
  expect(list[0]?.lastTool).toBe('Edit internal/config/contract_on.go')
  list = agentDenied(list, 'a1', 'Bash git push')
  expect(list[0]).toMatchObject({ denied: 'Bash git push', lastTool: 'Edit internal/config/contract_on.go' })
  list = agentTool(list, 'a1', 'Read x')
  expect(list[0]).toMatchObject({ denied: '', lastTool: 'Read x' })
})

test('completion by reason: answer is done, aborted is stopped, anything else failed, with max_tokens named', () => {
  const finish = (reason: string, lastStop: string | null = null) => {
    let list = spawn([], 'a1')
    list = agentStepped(list, { id: 'a1', usage: { input_tokens: 1 }, stopReason: lastStop, now: T0 + 1 })
    return agentCompleted(list, { id: 'a1', reason, now: T0 + 500 })[0] as AgentCard
  }
  expect(finish('answer').rounds[0]).toEqual({ startedAt: T0, endedAt: T0 + 500, status: 'done' })
  expect(finish('aborted').rounds[0]).toMatchObject({ status: 'stopped', endedAt: T0 + 500 })
  expect(finish('error').rounds[0]).toMatchObject({ status: 'failed', failure: 'error' })
  expect(finish('error', 'max_tokens').rounds[0]).toMatchObject({ status: 'failed', failure: 'max_tokens' })
  expect(finish('refusal').rounds[0]).toMatchObject({ status: 'failed', failure: 'refusal' })
  expect(statusOfCard(finish('answer'))).toBe('done')
  expect(isRunning(finish('answer'))).toBe(false)
  // a second completion changes nothing
  const done = finish('answer')
  expect(agentCompleted([done], { id: 'a1', reason: 'error', now: T0 + 900 })[0]).toEqual(done)
})

test('a step after the round ended starts a new round (a resumed subagent)', () => {
  let list = agentCompleted(spawn([], 'a1'), { id: 'a1', reason: 'answer', now: T0 + 100 })
  list = agentStepped(list, { id: 'a1', usage: { input_tokens: 1 }, now: T0 + 200 })
  expect(list[0]?.rounds).toEqual([
    { startedAt: T0, endedAt: T0 + 100, status: 'done' },
    { startedAt: T0 + 200, status: 'running' },
  ])
  list = agentCompleted(list, { id: 'a1', reason: 'error', now: T0 + 300 })
  expect(list[0]?.rounds.map(r => r.status)).toEqual(['done', 'failed'])
})

test('running agents are listed oldest first; stopping marks the running ones', () => {
  let list = spawn([], 'b', { now: T0 + 10 })
  list = spawn(list, 'a', { now: T0 })
  list = spawn(list, 'c', { now: T0 + 20 })
  list = agentCompleted(list, { id: 'c', reason: 'answer', now: T0 + 30 })
  expect(runningAgents(list).map(c => c.id)).toEqual(['a', 'b'])
  const stopped = agentsStopped(list, T0 + 99)
  expect(runningAgents(stopped)).toEqual([])
  expect(stopped.find(c => c.id === 'a')?.rounds[0]).toEqual({ startedAt: T0, endedAt: T0 + 99, status: 'stopped' })
  expect(stopped.find(c => c.id === 'c')?.rounds[0]?.status).toBe('done')
})

test('at most 24 agents: the oldest ended go first, then the oldest of all', () => {
  let list: AgentCard[] = []
  for (let i = 0; i < MAX_AGENTS; i++) list = spawn(list, `a${i}`, { now: T0 + i })
  list = agentCompleted(list, { id: 'a3', reason: 'answer', now: T0 + 100 })
  list = agentCompleted(list, { id: 'a5', reason: 'answer', now: T0 + 100 })
  list = spawn(list, 'new1', { now: T0 + 200 })
  expect(list).toHaveLength(MAX_AGENTS)
  expect(list.some(c => c.id === 'a3')).toBe(false) // oldest ended
  expect(list.some(c => c.id === 'a5')).toBe(true)
  list = spawn(list, 'new2', { now: T0 + 201 })
  expect(list.some(c => c.id === 'a5')).toBe(false)
  // all running: the oldest goes
  list = spawn(list, 'new3', { now: T0 + 202 })
  expect(list).toHaveLength(MAX_AGENTS)
  expect(list.some(c => c.id === 'a0')).toBe(false)
  expect(list[list.length - 1]?.id).toBe('new3')
})

test('agent context over the session window; the last ended time', () => {
  let list = agentStepped(spawn([], 'a1'), { id: 'a1', usage: { input_tokens: 82_000 }, now: T0 })
  expect(agentContextPct(list[0] as AgentCard, 200_000)).toBe(41)
  expect(agentContextPct(list[0] as AgentCard, 0)).toBeNull()
  expect(agentContextPct(spawn([], 'x')[0] as AgentCard, 200_000)).toBeNull()
  expect(agentContextPct({ ...(list[0] as AgentCard), ctx: 900_000 }, 200_000)).toBe(100)
  expect(lastEndedAt(list)).toBeNull()
  list = agentCompleted(list, { id: 'a1', reason: 'answer', now: T0 + 7 })
  expect(lastEndedAt(list)).toBe(T0 + 7)
})

test('knownAgent says whether a step belongs to a card or a consult', () => {
  const agents = spawn([], 'a1')
  const consults = consultStarted([], { id: 'c1', type: 'crew:architect', description: 'x', now: T0 })
  expect(knownAgent(agents, consults, 'a1')).toBe(true)
  expect(knownAgent(agents, consults, 'c1')).toBe(true)
  expect(knownAgent(agents, consults, 'fork-1')).toBe(false)
})

// ------------------------------------------------------------------ consults

test('parseVerdict reads the first non-empty line, strips Markdown and splits the verdict word', () => {
  expect(parseVerdict('Approve: T1 module path is clean')).toEqual({ line: 'Approve: T1 module path is clean', verdict: 'Approve', reason: 'T1 module path is clean' })
  expect(parseVerdict('**Fixes** — keepalive test races on stop')).toEqual({ line: 'Fixes — keepalive test races on stop', verdict: 'Fixes', reason: 'keepalive test races on stop' })
  expect(parseVerdict('\n\n# Reject: the plan breaks the contract\nmore')).toMatchObject({ verdict: 'Reject', reason: 'the plan breaks the contract' })
  expect(parseVerdict('> - `Approve` the order is fine')).toMatchObject({ verdict: 'Approve', reason: 'the order is fine' })
  expect(parseVerdict('approved: ok')).toMatchObject({ verdict: 'Approve', reason: 'ok' })
  expect(parseVerdict('Fixes needed in two places')).toMatchObject({ verdict: 'Fixes', reason: 'needed in two places' })
  expect(parseVerdict('Approve')).toEqual({ line: 'Approve', verdict: 'Approve', reason: '' })
})

test('a line without a verdict word is unclassified and keeps the whole line as the reason', () => {
  expect(parseVerdict('The plan looks fine overall')).toEqual({ line: 'The plan looks fine overall', verdict: null, reason: 'The plan looks fine overall' })
  expect(parseVerdict('Approvals are pending')).toMatchObject({ verdict: null })
  expect(parseVerdict('Fixed it myself')).toMatchObject({ verdict: null })
  expect(parseVerdict('')).toEqual({ line: '', verdict: null, reason: '' })
  expect(parseVerdict('\n  \n')).toEqual({ line: '', verdict: null, reason: '' })
  const long = parseVerdict(`Fixes: ${'x'.repeat(400)}`)
  expect(cellWidth(long.line)).toBeLessThanOrEqual(160)
  expect(long.line.endsWith('…')).toBe(true)
})

test('consults run, end with their verdict, and are told apart: architect, twin, advisor', () => {
  let list = consultStarted([], { id: 'c1', type: 'crew:architect', description: 'T2 approach · opus/high', now: T0 })
  list = consultStarted(list, { id: 'c2', type: 'crew:architect-codex', description: 'T3: audit', now: T0 + 5 })
  list = consultStarted(list, { id: 'c3', type: ADVISOR, description: 'second opinion', now: T0 + 6 })
  expect(list.map(c => [c.id, c.who, c.stepId, c.endAt])).toEqual([
    ['c1', 'architect', 'T2', null],
    ['c2', 'architect·cx', 'T3', null],
    ['c3', 'advisor', null, null],
  ])
  expect(list[0]?.description).toBe('T2 approach')
  expect(consulting(list)).toHaveLength(3)
  list = consultEnded(list, { id: 'c1', now: T0 + 72_000, answer: 'Approve: T1 module path is clean\n\nDetails…' })
  expect(list[0]).toMatchObject({ endAt: T0 + 72_000, verdict: 'Approve', reason: 'T1 module path is clean', line: 'Approve: T1 module path is clean' })
  expect(consulting(list).map(c => c.id)).toEqual(['c2', 'c3'])
  // a consult stopped without an answer ends with no verdict
  list = consultEnded(list, { id: 'c2', now: T0 + 9 })
  expect(list[1]).toMatchObject({ endAt: T0 + 9, verdict: null, line: '' })
  // ending twice changes nothing
  expect(consultEnded(list, { id: 'c1', now: T0 + 999, answer: 'Reject: no' })[0]?.verdict).toBe('Approve')
})

// ------------------------------------------------------------------ log

test('the log keeps the newest 60 lines', () => {
  let log: LogLine[] = []
  for (let i = 0; i < MAX_LOG + 7; i++) log = logged(log, { at: i, who: 'lead', kind: 'plan', text: `l${i}` })
  expect(log).toHaveLength(MAX_LOG)
  expect(log[0]?.text).toBe('l7')
  expect(log[MAX_LOG - 1]?.text).toBe(`l${MAX_LOG + 6}`)
})

test('log lines: prompts, spawns, ends, denials, consults, compaction', () => {
  expect(promptLine('\n  split the proxy   rewrite into\nsteps', T0)).toEqual({ at: T0, who: 'you', kind: 'prompt', text: 'split the proxy rewrite into' })
  expect(promptLine('use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 please', T0).text).not.toContain('sk-ant')
  expect(promptLine('', T0).text).toBe('')

  const [card] = spawn([], 'a1', { type: 'crew:code-reader', description: 'where does the router read codex.base_url?' })
  expect(spawnLine(card as AgentCard, T0)).toEqual({ at: T0, who: 'code-reader', kind: 'spawn', text: 'spawned · where does the router read codex.base_url?', type: 'crew:code-reader' })

  const done = agentCompleted([card as AgentCard], { id: 'a1', reason: 'answer', now: T0 + 1 })[0] as AgentCard
  expect(endLine(done, T0 + 1)).toMatchObject({ kind: 'done', text: 'done · where does the router read codex.base_url?' })
  const failed = agentCompleted([agentStepped([card as AgentCard], { id: 'a1', stopReason: 'max_tokens', now: T0 })[0] as AgentCard], { id: 'a1', reason: 'error', now: T0 + 1 })[0] as AgentCard
  expect(endLine(failed, T0 + 1)).toMatchObject({ who: 'code-reader', kind: 'failed', text: '✗ failed · max_tokens' })
  const stopped = agentCompleted([card as AgentCard], { id: 'a1', reason: 'aborted', now: T0 + 1 })[0] as AgentCard
  expect(endLine(stopped, T0 + 1)).toMatchObject({ kind: 'stopped', text: 'stopped · where does the router read codex.base_url?' })
  expect(endLine(card as AgentCard, T0)).toBeNull()

  expect(denyLine('developer', 'Bash git push', T0, 'crew:developer')).toEqual({ at: T0, who: 'developer', kind: 'deny', text: '✗ denied Bash git push', type: 'crew:developer' })
  expect(compactLine(T0)).toEqual({ at: T0, who: 'lead', kind: 'compact', text: 'context compacted' })

  let consults = consultStarted([], { id: 'c1', type: 'crew:architect', description: 'T2 approach', now: T0 })
  expect(consultLine(consults[0] as Consult)).toMatchObject({ who: 'architect', kind: 'consult', text: 'consult · T2 approach' })
  consults = consultEnded(consults, { id: 'c1', now: T0 + 9, answer: 'Fixes: keepalive test races' })
  expect(verdictLine(consults[0] as Consult)).toMatchObject({ at: T0 + 9, kind: 'verdict', text: 'Fixes: keepalive test races' })
  const none = consultEnded(consultStarted([], { id: 'c2', type: ADVISOR, description: 'x', now: T0 }), { id: 'c2', now: T0 + 1 })
  expect(verdictLine(none[0] as Consult).text).toBe('ended without an answer')
})

// ------------------------------------------------------------------ loops

test('loops: steps of an agent no card holds; active for 15 s; bounded; summary', () => {
  let loops: Loop[] = []
  loops = loopStepped(loops, 'wf1', T0)
  loops = loopStepped(loops, 'wf1', T0 + 1000)
  loops = loopStepped(loops, 'fork1', T0 + 2000)
  expect(loops.find(l => l.id === 'wf1')).toEqual({ id: 'wf1', firstAt: T0, lastAt: T0 + 1000, steps: 2, isDone: false })
  expect(loopSummary(loops, T0 + 3000)).toEqual({ total: 2, active: 2 })
  expect(loopSummary(loops, T0 + 1000 + LOOP_ACTIVE_MS)).toEqual({ total: 2, active: 1 }) // wf1 quiet for 15 s
  loops = loopEnded(loops, 'fork1')
  expect(loopSummary(loops, T0 + 3000)).toEqual({ total: 2, active: 1 })
  expect(isLoopActive(loops.find(l => l.id === 'fork1') as Loop, T0 + 3000)).toBe(false)
  // stepping again revives it
  expect(isLoopActive(loopStepped(loops, 'fork1', T0 + 4000).find(l => l.id === 'fork1') as Loop, T0 + 4001)).toBe(true)
  expect(loopSummary([], T0)).toBeNull()
  for (let i = 0; i < MAX_LOOPS + 5; i++) loops = loopStepped(loops, `l${i}`, T0 + 10_000 + i)
  expect(loops).toHaveLength(MAX_LOOPS)
})

// ------------------------------------------------------------------ favored provider

test('the favored provider: the first reading is not a change; a switch is, for ten minutes', () => {
  let f = trackFavored(null, 'claude', T0)
  expect(f).toEqual({ provider: 'claude', since: T0, isChange: false })
  expect(favoredChangedRecently(f, T0 + 1000)).toBe(false)
  expect(trackFavored(f, 'claude', T0 + 5000)).toBe(f)
  f = trackFavored(f, 'codex', T0 + 5000)
  expect(f).toEqual({ provider: 'codex', since: T0 + 5000, isChange: true })
  expect(favoredChangedRecently(f, T0 + 5000 + 9 * MIN)).toBe(true)
  expect(favoredChangedRecently(f, T0 + 5000 + 10 * MIN)).toBe(false)
  expect(favoredChangedRecently(null, T0)).toBe(false)
  // switching back is a change too
  expect(trackFavored(f, 'claude', T0 + 6000)).toEqual({ provider: 'claude', since: T0 + 6000, isChange: true })
})

// ------------------------------------------------------------------ timeline

test('timeline: the lead lane comes from turns, an agent lane from rounds, 30 cells for 15 minutes', () => {
  const now = T0 + 20 * MIN
  let s = defaultSession(T0)
  s = turnEnded(turnStarted(s, { now: now - 14 * MIN }), { now: now - 10 * MIN, reason: 'answer' })
  s = turnStarted(s, { now: now - 2 * MIN })
  let agents = spawn([], 'd1', { now: now - 9 * MIN })
  agents = agentCompleted(agents, { id: 'd1', reason: 'answer', now: now - 5 * MIN })
  agents = spawn(agents, 'd2', { now: now - 1 * MIN })
  const lanes = timelineLanes(agents, [], s, now)
  expect(lanes.map(l => l.name)).toEqual(['lead', 'developer'])
  const [lead, dev] = lanes
  expect(lead?.cells).toHaveLength(LANE_CELLS)
  // lead: busy -14..-10 min (cells 2..9), running -2..now (cells 26..29)
  expect(laneText(lead as never)).toBe('··' + '━'.repeat(8) + '·'.repeat(16) + '━━━━')
  expect(lead?.cells.slice(26)).toEqual(['running', 'running', 'running', 'running'])
  expect(lead?.cells[2]).toBe('busy')
  expect(lead?.jobs).toBeNull()
  expect(busyText(lead?.busyMs ?? 0)).toBe('6m')
  // developer: -9..-5 min done (cells 12..19), -1..now running (cells 28..29)
  expect(laneText(dev as never)).toBe('·'.repeat(12) + '━'.repeat(8) + '·'.repeat(8) + '━━')
  expect(dev?.cells[28]).toBe('running')
  expect(dev?.cells[12]).toBe('busy')
  expect(dev?.jobs).toBe(2)
  expect(busyText(dev?.busyMs ?? 0)).toBe('5m')
})

test('timeline: failed jobs mark their last minute; lanes sort by role, twins apart; idle types are left out', () => {
  const now = T0 + 30 * MIN
  let agents = spawn([], 'r1', { type: 'crew:research', now: now - 6 * MIN })
  agents = agentCompleted(agents, { id: 'r1', reason: 'error', now: now - 5 * MIN })
  agents = spawn(agents, 't1', { type: 'crew:tester-codex', now: now - 3 * MIN })
  agents = spawn(agents, 'x1', { type: 'general-purpose', now: now - 2 * MIN })
  agents = spawn(agents, 'old', { type: 'crew:designer', now: now - 40 * MIN })
  agents = agentCompleted(agents, { id: 'old', reason: 'answer', now: now - 39 * MIN })
  const lanes = timelineLanes(agents, [], defaultSession(T0), now)
  expect(lanes.map(l => l.name)).toEqual(['lead', 'research', 'tester·cx', 'general-pur…'])
  const research = lanes[1]
  expect(research?.cells.filter(c => c === 'failed')).toHaveLength(1)
  expect(research?.cells[19]).toBe('failed') // its last cell: ends at -5 min = the boundary of cell 20
  expect(laneText(research as never)).toContain('✗')
  expect(lanes[0]?.cells.every(c => c === 'idle')).toBe(true)
})

test('timeline: consults count for the architect lane, the advisor too, a twin in its own', () => {
  const now = T0 + 10 * MIN
  let consults = consultStarted([], { id: 'c1', type: 'crew:architect', description: 'a', now: now - 4 * MIN })
  consults = consultEnded(consults, { id: 'c1', now: now - 3 * MIN, answer: 'Approve: ok' })
  consults = consultStarted(consults, { id: 'c2', type: ADVISOR, description: 'b', now: now - 2 * MIN })
  consults = consultStarted(consults, { id: 'c3', type: 'crew:architect-codex', description: 'c', now: now - 1 * MIN })
  const lanes = timelineLanes([], consults, defaultSession(T0), now)
  expect(lanes.map(l => [l.name, l.jobs])).toEqual([['lead', null], ['architect', 2], ['architect·cx', 1]])
  expect(lanes[1]?.cells[28]).toBe('running') // the advisor, still going
})

test('timeline: a job entirely before the window is out; one crossing the edge is clipped', () => {
  const now = T0 + 30 * MIN
  let agents = spawn([], 'a', { now: now - 20 * MIN })
  agents = agentCompleted(agents, { id: 'a', reason: 'answer', now: now - 14 * MIN })
  const [, lane] = timelineLanes(agents, [], defaultSession(T0), now)
  expect(lane?.name).toBe('developer')
  expect(laneText(lane as never)).toBe('━━'.repeat(1) + '·'.repeat(28))
  expect(lane?.busyMs).toBe(MIN)
  // a zero-length job at "now" fits in the last cell
  const edge = timelineLanes(spawn([], 'z', { now }), [], defaultSession(T0), now)
  expect(edge[1]?.cells[29]).toBe('running')
})

test('timeline stats, axis and the section gate', () => {
  expect(busyText(0)).toBe('0m')
  expect(busyText(20_000)).toBe('<1m')
  expect(busyText(9 * MIN)).toBe('9m')
  const lead = { key: 'lead', name: 'lead', isLead: true, cells: [], jobs: null, busyMs: 11 * MIN }
  const dev = { ...lead, key: 'crew:developer', name: 'developer', isLead: false, jobs: 2, busyMs: 9 * MIN }
  expect(laneStats(lead)).toBe('     11m')
  expect(laneStats(dev)).toBe('×2    9m')
  expect(laneStats({ ...dev, busyMs: 20_000 })).toBe('×2   <1m')
  expect(timelineAxis()).toBe('-15m      -10m      -5m    now')
  expect(cellWidth(timelineAxis())).toBe(LANE_CELLS)
  expect(hasTimeline([], [])).toBe(false)
  expect(hasTimeline(spawn([], 'a'), [])).toBe(true)
  expect(hasTimeline([], consultStarted([], { id: 'c', type: 'crew:architect', description: '', now: T0 }))).toBe(true)
})
