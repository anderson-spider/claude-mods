import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, ConfigSetInput, On, TurnStepInput } from 'claude-code'

import type { Job, Native, SessionInfo } from '../types'
import { createQueue } from '../hooks/register'
import { PANE_ID } from '../hooks/pane'
import { DELEGATE, HOME, RESULT, ROOT, parse, start, world } from './fixtures/world'

const spawnInput = {
  tool_use_id: 'spawn-1', prompt: 'Review the change', description: 'Review',
  subagentType: 'pantheon:oracle', provider: { plugin: 'pantheon', tier: 'user' },
  parentModel: 'parent', permissionMode: 'default',
} as AgentSpawnInput
const stepInput = (index = 0, agentId: string | undefined = 'native-1'): TurnStepInput => ({
  turnId: 'turn-1', index, agentId, model: 'model-1', effort: 'high', messageCount: 1,
})
const completeInput = { turnId: 'turn-1', reason: 'answer' as const, answer: 'Answer', durationMs: 42, isAborted: false }
const measureInput = { context: { tokens: 100, window: 1000, percent: 10 }, rateLimits: [], changed: ['context'] as ['context'] }
const stepResult = {
  turnId: 'turn-1', index: 0, answer: 'Step answer', toolUses: [], stopReason: 'end_turn' as const,
  usage: { model: 'model-1', input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 },
}
const streamChunk = { kind: 'text' as const, index: 0, text: 'streaming' }
function trackingWorld(on: On, slowNativeWrite = false, opts: {
  chunk?: boolean; slowMs?: number
  /** While it returns a promise, every natives write waits for it. */
  hold?: () => Promise<void> | undefined
} = {}) {
  const fixture = world(on)
  const forwarded: string[] = []
  on('agent.spawn', async () => ({ model: 'model-1', agentId: 'native-1' }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    forwarded.push(e.turnId)
    if (opts.chunk) {
      yield streamChunk
      // The response takes time to finish streaming.
      if (opts.slowMs) await fixture.clock.sleep(opts.slowMs)
    }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  on('turn.complete', async () => ({ text: 'Completed' }))
  on('session.measure', async () => ({ changed: ['context'] }))
  on('tool.call', async () => ({ result: 'Tool result' }))
  const stored: Record<string, unknown> = {}
  const writes: number[] = []
  let slowed = false
  on('state.set', async (_$, e, next) => {
    const steps = e.key === 'natives' ? (e.value as Native[])[0]?.steps ?? 0 : undefined
    // Only the first write of one step is slow: the next steps' writes then wait behind it.
    if (slowNativeWrite && steps === 1 && !slowed) { slowed = true; await fixture.clock.sleep(10) }
    if (steps !== undefined) await opts.hold?.()
    const result = await next(e)
    if (result.value.isSet) {
      stored[e.key] = e.value
      if (steps !== undefined) writes.push(steps)
    }
    return result
  })
  on('command.run', { command: 'tracking-state' }, async (_$, e) => {
    return { text: JSON.stringify(stored[e.args] ?? null) }
  })
  return { ...fixture, writes, forwarded }
}
async function nativesOf($: Engine): Promise<Native[]> {
  return JSON.parse((await $.command.run({ command: 'tracking-state', args: 'natives' })).text ?? 'null') ?? []
}
async function sessionOf($: Engine): Promise<SessionInfo | undefined> {
  return JSON.parse((await $.command.run({ command: 'tracking-state', args: 'session' })).text ?? 'null')
}
async function step($: Engine, input = stepInput()) {
  const stream = $.turn.step(input)
  const chunks = []
  let item = await stream.next()
  while (!item.done) { chunks.push(item.value); item = await stream.next() }
  return { chunks, result: item.value }
}

describe('register', () => {
  const mountPanel = ($: Engine) => $.ui.mount({
    plugin: 'pantheon', surface: 'terminal', component: 'Pane', requestId: PANE_ID,
    props: { title: 'Pantheon', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } },
    viewport: { columns: 120, rows: 40 },
  })

  for (const layer of ['user', 'project'] as const) {
    test(`panel reloads the ${layer} JSON profile, names and lock between renders without a prompt`, async ($, on) => {
      const { files, seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{}' } })
      const first = await mountPanel($)
      try {
        expect((await first.find({ key: 'profile' }))?.props.value).toBe('claude')
      } finally { await first.unmount() }
      const path = layer === 'user' ? `${HOME}/.claude/pantheon.json` : `${ROOT}/.claude/pantheon.json`
      files[path] = JSON.stringify({ profile: 'personal', profiles: { personal: {} } })
      const second = await mountPanel($)
      try {
        expect(await second.find({ type: 'Text', text: '● personal' })).toBeDefined()
        expect(await second.find({ type: 'Text', text: `set by ${layer} pantheon.json` })).toBeDefined()
        expect(await second.find({ type: 'Select', key: 'profile' })).toBeUndefined()
      } finally { await second.unmount() }
      delete files[path]
      const third = await mountPanel($)
      try {
        const select = await third.find({ key: 'profile' })
        expect(select?.props.value).toBe('claude')
        expect((select?.props.options as { value: string }[]).map(option => option.value)).toEqual(['claude', 'codex', 'mixed'])
      } finally { await third.unmount() }
      expect(seen.agents.length).toBe(21)
    })
  }

  test('panel reads options.profile on the first render without session.start or a prompt', { options: { profile: 'codex' } }, async ($, on) => {
    world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{}' } })
    const ui = await mountPanel($)
    try {
      expect((await ui.find({ key: 'profile' }))?.props.value).toBe('codex')
      expect(await ui.find({ type: 'Text', text: /set by .* pantheon.json/ })).toBeUndefined()
    } finally { await ui.unmount() }
  })

  test('panel keeps the last valid profile and warns once across invalid JSON renders without invalidating itself', async ($, on) => {
    const { files, seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{"profile":"mixed"}' } })
    const invalidations: string[] = []
    on('ui.invalidate', async (_$, e) => { invalidations.push(e.event); return { value: undefined } })
    const first = await mountPanel($)
    try { expect(await first.find({ type: 'Text', text: '● mixed' })).toBeDefined() }
    finally { await first.unmount() }
    files[`${HOME}/.claude/pantheon.json`] = '{ broken'
    for (let i = 0; i < 2; i++) {
      const ui = await mountPanel($)
      try {
        const selected = await ui.find({ key: 'profile' })
        const locked = await ui.find({ type: 'Text', text: '● mixed' })
        expect(selected?.props.value === 'mixed' || locked !== undefined).toBe(true)
      } finally { await ui.unmount() }
    }
    expect(seen.toasts).toEqual([`pantheon: invalid config — ${HOME}/.claude/pantheon.json: Invalid JSON`])
    expect(seen.agents.length).toBe(3)
    expect(invalidations).toEqual([])
  })

  test('panel selection requests a redraw after a successful config.set', async ($, on) => {
    world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{}' } })
    const invalidations: string[] = []
    const writes: { key: string; value: unknown }[] = []
    on('config.set', async (_$, e) => { writes.push({ key: e.key, value: e.value }); return { value: e.value } })
    on('ui.invalidate', async (_$, e) => { invalidations.push(e.event); return { value: undefined } })
    await start($)
    const ui = await mountPanel($)
    try {
      await ui.select({ key: 'profile', value: 'codex' })
      expect(writes).toEqual([{ key: 'pantheon.profile', value: 'codex' }])
      expect(invalidations).toEqual(['ui.render'])
    } finally { await ui.unmount() }
  })

  test('panel selection denies user JSON that became invalid since the render without writing or invalidating', async ($, on) => {
    const { files, seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{}' } })
    const writes: ConfigSetInput[] = []
    const invalidations: string[] = []
    on('config.set', async (_$, e) => { writes.push(e); return { value: e.value } })
    on('ui.invalidate', async (_$, e) => { invalidations.push(e.event); return { value: undefined } })
    const ui = await mountPanel($)
    try {
      files[`${HOME}/.claude/pantheon.json`] = '{ broken'
      await ui.select({ key: 'profile', value: 'mixed' })
      expect(writes).toEqual([])
      expect(invalidations).toEqual([])
      expect(seen.toasts).toEqual([`pantheon: ${HOME}/.claude/pantheon.json: Invalid JSON`])
    } finally { await ui.unmount() }
  })

  test('panel selection denies a custom profile removed from project JSON since the render without writing or invalidating', async ($, on) => {
    const { files, seen } = world(on, { files: {
      [`${HOME}/.claude/pantheon.json`]: '{}',
      [`${ROOT}/.claude/pantheon.json`]: '{"profiles":{"personal":{}}}',
    } })
    const writes: ConfigSetInput[] = []
    const invalidations: string[] = []
    on('config.set', async (_$, e) => { writes.push(e); return { value: e.value } })
    on('ui.invalidate', async (_$, e) => { invalidations.push(e.event); return { value: undefined } })
    const ui = await mountPanel($)
    try {
      files[`${ROOT}/.claude/pantheon.json`] = '{}'
      await ui.select({ key: 'profile', value: 'personal' })
      expect(writes).toEqual([])
      expect(invalidations).toEqual([])
      expect(seen.toasts).toEqual(['pantheon: unknown profile "personal"; known: claude, codex, mixed'])
    } finally { await ui.unmount() }
  })

  const profileChange = (value: string): ConfigSetInput => ({
    key: 'pantheon.profile', value, previous: 'claude',
    provider: { plugin: 'pantheon', tier: 'user' }, origin: { kind: 'composer' },
  })

  test('config.set allows a built-in profile unchanged', async ($, on) => {
    world(on)
    const received: ConfigSetInput[] = []
    on('config.set', async (_$, e) => { received.push(e); return { value: e.value } })
    const input = profileChange('codex')
    expect(await $.config.set(input)).toEqual({ value: 'codex' })
    expect(received).toEqual([input])
  })

  for (const path of [`${HOME}/.claude/pantheon.json`, `${ROOT}/.claude/pantheon.json`]) {
    test(`config.set allows a custom profile freshly defined in ${path}`, async ($, on) => {
      const { files } = world(on)
      on('config.set', async (_$, e) => ({ value: e.value }))
      await start($)
      files[path] = JSON.stringify({ profiles: { custom: {} } })
      expect(await $.config.set(profileChange('custom'))).toEqual({ value: 'custom' })
    })
  }

  test('config.set denies an unknown profile with the merged known names even when JSON selects a profile', async ($, on) => {
    world(on, { files: {
      [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ profile: 'claude', profiles: { personal: {} } }),
      [`${ROOT}/.claude/pantheon.json`]: JSON.stringify({ profiles: { project: {} } }),
    } })
    const received: ConfigSetInput[] = []
    on('config.set', async (_$, e) => { received.push(e); return { value: e.value } })
    expect(await $.config.set(profileChange('missing'))).toEqual({
      deny: 'unknown profile "missing"; known: claude, codex, mixed, personal, project',
    })
    expect(received).toEqual([])
  })

  for (const cleared of ['', '  ']) {
    test(`config.set with ${JSON.stringify(cleared)} clears the selection and reaches next`, async ($, on) => {
      world(on)
      const received: ConfigSetInput[] = []
      on('config.set', async (_$, e) => { received.push(e); return { value: e.value } })
      const input = profileChange(cleared)
      expect(await $.config.set(input)).toEqual({ value: cleared })
      expect(received).toEqual([input])
    })
  }

  test('config.set denies malformed user JSON after a valid config without calling next', async ($, on) => {
    const { files } = world(on)
    const received: ConfigSetInput[] = []
    on('config.set', async (_$, e) => { received.push(e); return { value: e.value } })
    await start($)
    files[`${HOME}/.claude/pantheon.json`] = '{ broken'
    expect(await $.config.set(profileChange('mixed'))).toEqual({
      deny: `${HOME}/.claude/pantheon.json: Invalid JSON`,
    })
    expect(received).toEqual([])
  })

  test('config.set denies a custom profile with a mismatched model without calling next', async ($, on) => {
    const { files } = world(on)
    const received: ConfigSetInput[] = []
    on('config.set', async (_$, e) => { received.push(e); return { value: e.value } })
    await start($)
    files[`${HOME}/.claude/pantheon.json`] = JSON.stringify({
      profiles: { custom: { agents: { fixer: { engine: 'codex', model: 'sonnet' } } } },
    })
    expect(await $.config.set(profileChange('custom'))).toEqual({
      deny: `${HOME}/.claude/pantheon.json: profiles.custom.agents.fixer.model: "sonnet" is a Claude model (engine codex)`,
    })
    expect(received).toEqual([])
  })

  test('config.set passes another config row through unchanged', async ($, on) => {
    world(on)
    const received: ConfigSetInput[] = []
    on('config.set', async (_$, e) => { received.push(e); return { value: e.value } })
    const input: ConfigSetInput = {
      key: 'theme', value: 'light', previous: 'dark',
      provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' },
    }
    expect(await $.config.set(input)).toEqual({ value: 'light' })
    expect(received).toEqual([input])
  })

  for (const profile of ['codex', 'mixed']) {
    test(`options.profile selects ${profile} on load when JSON has no selection`, { options: { profile } }, async ($, on) => {
      world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{}' } })
      await start($)
      const report = await $.command.run({ command: 'pantheon', args: 'config' })
      expect(report.text).toContain(`Active profile: ${profile} (settings)`)
    })
  }

  for (const [path, origin] of [[`${HOME}/.claude/pantheon.json`, 'user'], [`${ROOT}/.claude/pantheon.json`, 'project']] as const) {
    test(`options.profile overrides the ${origin} JSON profile`, { options: { profile: 'codex' } }, async ($, on) => {
      world(on, { files: { [path]: JSON.stringify({ profile: 'claude' }) } })
      await start($)
      const report = await $.command.run({ command: 'pantheon', args: 'config' })
      expect(report.text).toContain('Active profile: codex (settings)')
    })
  }

  for (const failedKeys of [['natives'], ['session'], ['view'], ['natives', 'session', 'view']]) {
    test(`failed panel writes warn once and preserve hook results: ${failedKeys.join(', ')}`, async ($, on) => {
      const { seen } = world(on)
      const rejected: string[] = []
      on('state.set', async (_$, e, next) => {
        if (!failedKeys.includes(e.key)) return next(e)
        rejected.push(e.key)
        return { deny: 'panel storage unavailable' }
      })
      const spawned = { agentId: 'native-1', model: 'model-1' }
      const completed = { text: 'unchanged completion' }
      const called = { ref: 9, result: 'unchanged tool result', text: 'Tool text', isReadOnly: true as const }
      on('agent.spawn', async () => spawned)
      on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
      on('turn.complete', async () => completed)
      on('tool.call', async () => called)
      on('turn.step', async function* () { return stepResult })
      on('session.measure', async () => ({ changed: ['context'] }))
      expect(await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })).toEqual({ cwd: ROOT })
      expect(await $.turn.start({ text: 'Go', turnId: 'turn-1' })).toEqual({ turnId: 'turn-1' })
      expect(await $.agent.spawn(spawnInput)).toEqual(spawned)
      expect((await step($)).result).toEqual(stepResult)
      expect(await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'native-1' })).toEqual(called)
      expect(await $.turn.complete({ ...completeInput, agentId: 'native-1' })).toEqual(completed)
      expect(await $.turn.complete(completeInput)).toEqual(completed)
      expect(await $.session.measure(measureInput)).toEqual({ changed: ['context'] })
      // Repeat view writes as well as the queue writes: the warning stays session-wide.
      await start($)
      for (const key of failedKeys) expect(rejected.filter(value => value === key).length).toBeGreaterThan(1)
      expect(seen.toasts.length).toBe(1)
      expect(seen.toasts[0]).toContain('pantheon: could not save the panel state (the panel may be stale):')
      expect(seen.toasts[0]).toContain('panel storage unavailable')
    })
  }

  test('snapshot queues recover after a failed write and retain only the latest pending snapshot', async () => {
    const writes: number[] = []
    const errors: unknown[] = []
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const failure = new Error('write failed')
    const queue = createQueue<number>(async value => {
      writes.push(value)
      if (value === 1) { began(); await held; throw failure }
    }, error => { errors.push(error) })
    queue.push(1)
    await started
    queue.push(2)
    queue.push(3)
    release()
    await queue.flushed()
    expect(writes).toEqual([1, 3])
    expect(errors).toEqual([failure])
    queue.push(4)
    await queue.flushed()
    expect(writes).toEqual([1, 3, 4])
  })

  test('a queue with a merge keeps every waiting action, in order', async () => {
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    type Job = () => Promise<unknown>
    const queue = createQueue<Job>(write => write(), () => {}, (a, b) => async () => { await a(); await b() })
    queue.push(async () => { order.push('first'); began(); await held })
    await started
    queue.push(async () => { order.push('toggle') })
    queue.push(async () => { order.push('tab') })
    release()
    await queue.flushed()
    expect(order).toEqual(['first', 'toggle', 'tab'])
  })

  test('tracking initializes lazily without session.start and ignores unknown native ids', async ($, on) => {
    trackingWorld(on)
    await step($)
    await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'native-1' })
    await $.turn.complete({ ...completeInput, agentId: 'native-1' })
    expect(await nativesOf($)).toEqual([])
    await $.agent.spawn(spawnInput)
    await step($)
    expect((await nativesOf($))[0].steps).toBe(1)
    expect((await nativesOf($))[0].rounds[0].status).toBe('running')
  })

  test('every tracking hook returns the event result unchanged', async ($, on) => {
    world(on)
    const started = { turnId: 'sentinel-turn' }
    const spawned = { model: 'sentinel-model', agentId: 'native-1' }
    const completed = { text: 'sentinel-completed' }
    const measured = { changed: ['cost'] as ['cost'] }
    const called = { ref: 7, result: 'sentinel-tool', text: 'Tool text', isReadOnly: true as const }
    const chunk = { kind: 'text' as const, index: 0, text: 'stream sentinel' }
    on('turn.start', async () => started)
    on('agent.spawn', async () => spawned)
    on('turn.complete', async () => completed)
    on('session.measure', async () => measured)
    on('tool.call', async () => called)
    on('turn.step', async function* () { yield chunk; return stepResult })
    await start($)
    expect(await $.turn.start({ text: 'Go', turnId: 'turn-1' })).toEqual(started)
    expect(await $.agent.spawn(spawnInput)).toEqual(spawned)
    const { chunks, result } = await step($)
    expect(chunks).toEqual([chunk])
    expect(result).toEqual(stepResult)
    expect(await $.turn.complete({ ...completeInput, agentId: 'native-1' })).toEqual(completed)
    expect(await $.session.measure(measureInput)).toEqual(measured)
    expect(await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'native-1' })).toEqual(called)
  })

  test('agent.spawn of pantheon:oracle records a native through steps, tools and completion', async ($, on) => {
    trackingWorld(on)
    await start($)
    await $.agent.spawn(spawnInput)
    await step($)
    await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'native-1' })
    await $.turn.complete({ ...completeInput, agentId: 'native-1' })
    const [native] = await nativesOf($)
    expect(native.role).toBe('oracle')
    expect(native.rounds[0].status).toBe('done')
    expect(native.rounds[0].turnId).toBe('turn-1')
    expect(native.steps).toBe(1)
    expect(native.ctx).toBe(15)
    expect(native.out).toBe(4)
    expect(native.lastTool).toBe('Bash pwd')
    await step($, { ...stepInput(1), turnId: 'turn-2' })
    expect((await nativesOf($))[0].rounds.map(round => round.status)).toEqual(['done', 'running'])
  })

  test('a native continuation reads running while its step streams, and its usage counts once', async ($, on) => {
    const { clock } = trackingWorld(on, false, { chunk: true, slowMs: 500 })
    await start($)
    await $.agent.spawn(spawnInput)
    const firstStep = step($)
    await clock.settle()
    await clock.advance(500)
    await firstStep
    await $.turn.complete({ ...completeInput, agentId: 'native-1' })
    await clock.advance(1_000)
    const stream = $.turn.step({ ...stepInput(0), turnId: 'turn-2' })
    const first = await stream.next()
    expect(first.value).toEqual(streamChunk)
    const during = (await nativesOf($))[0]
    expect(during.rounds.map(round => round.status)).toEqual(['done', 'running'])
    expect(during.rounds[1].turnId).toBe('turn-2')
    // The step is not counted until its response is in.
    expect(during.steps).toBe(1)
    const pending = stream.next()
    await clock.settle()
    await clock.advance(500)
    const end = await pending
    expect(end.done).toBe(true)
    expect(end.value).toEqual({ ...stepResult, turnId: 'turn-2', index: 0 })
    const after = (await nativesOf($))[0]
    expect(after.rounds[1].startedAt).toBe(during.rounds[1].startedAt)
    expect(after.rounds[1].startedAt).toBeLessThan(clock.now())
    expect(after.rounds.length).toBe(2)
    expect(after.steps).toBe(2)
    expect(after.out).toBe(8)
  })

  test('a held natives write never holds the step: it is forwarded and streams before the write lands', async ($, on) => {
    let gate: Promise<void> | undefined
    let release!: () => void
    const { forwarded } = trackingWorld(on, false, { chunk: true, hold: () => gate })
    await start($)
    await $.agent.spawn(spawnInput)
    await step($)
    await $.turn.complete({ ...completeInput, agentId: 'native-1' })
    gate = new Promise<void>(resolve => { release = resolve })
    const stream = $.turn.step({ ...stepInput(0), turnId: 'turn-2' })
    let arrived = false
    const first = stream.next().then(item => { arrived = true; return item })
    // Let everything not waiting on the held write run.
    for (let k = 0; k < 20; k++) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(forwarded).toEqual(['turn-1', 'turn-2'])
    expect(arrived).toBe(true)
    expect((await first).value).toEqual(streamChunk)
    // Nothing of turn-2 is persisted while the write is held.
    expect((await nativesOf($))[0].rounds.map(round => round.status)).toEqual(['done'])
    gate = undefined
    release()
    const end = await stream.next()
    expect(end.done).toBe(true)
    expect(end.value).toEqual({ ...stepResult, turnId: 'turn-2', index: 0 })
    const [native] = await nativesOf($)
    expect(native.rounds.map(round => round.status)).toEqual(['done', 'running'])
    expect(native.rounds[1].turnId).toBe('turn-2')
    expect(native.steps).toBe(2)
  })

  test('queued writes land in order for three concurrent steps', async ($, on) => {
    const { clock, writes } = trackingWorld(on, true)
    await start($)
    await $.agent.spawn(spawnInput)
    const first = step($)
    await clock.settle()
    const pending = Promise.all([first, ...[1, 2].map(index => step($, stepInput(index)))])
    await clock.settle()
    await clock.advance(10)
    await pending
    expect((await nativesOf($))[0].steps).toBe(3)
    expect(writes[writes.length - 1]).toBe(3)
    expect(writes).toContain(1)
    expect(writes).toEqual([...writes].sort((a, b) => a - b))
  })

  test('reload marks running native rounds lost and resets the session', async ($, on) => {
    trackingWorld(on)
    const saved: Native[] = [{ id: 'old', role: 'oracle', type: 'pantheon:oracle', task: 'Old', model: 'm',
      rounds: [{ startedAt: 1, status: 'done' }, { startedAt: 2, status: 'running' }], ctx: 0, out: 0, steps: 2 }]
    const served = new Set<string>()
    on('state.get', async (_$, e, next) => {
      if (served.has(e.key) || !['natives', 'session'].includes(e.key)) return next(e)
      served.add(e.key)
      return { value: { value: e.key === 'natives' ? saved : { isRunning: true, model: 'saved-model' }, version: 1 } } as never
    })
    await start($)
    expect((await nativesOf($))[0].rounds.map(round => round.status)).toEqual(['done', 'lost'])
    expect(await sessionOf($)).toEqual({ isRunning: false, model: 'saved-model' })
  })

  test('main session tracks start, model, effort, measurement and completion independently', async ($, on) => {
    trackingWorld(on)
    await start($)
    await $.turn.start({ text: 'Go', turnId: 'turn-1' })
    expect((await sessionOf($))?.isRunning).toBe(true)
    const startedAt = (await sessionOf($))!.turnStartedAt!
    await step($, { ...stepInput(), agentId: undefined, effort: 3 })
    await $.session.measure(measureInput)
    await $.agent.spawn(spawnInput)
    await $.turn.complete({ ...completeInput, agentId: 'native-1' })
    expect((await sessionOf($))?.isRunning).toBe(true)
    await $.turn.complete(completeInput)
    const session = await sessionOf($)
    expect(session?.model).toBe('model-1')
    expect(session?.effort).toBe('3')
    expect(session?.context).toEqual(measureInput.context)
    expect(session?.isRunning).toBe(false)
    expect(session?.lastTurnMs).toBe(42)
    expect(session?.turns).toEqual([{ startedAt, endedAt: startedAt + 42 }])
  })

  test('the panel opens on session.start and /pantheon close closes it', async ($, on) => {
    const { seen } = world(on)
    await start($)
    // The footer says "esc close": both opens close on Escape, and the manual one also focuses.
    expect(seen.opened).toEqual([{ id: 'pantheon', title: 'Pantheon', columns: 72, rows: 8, closeOnEscape: true }])
    expect(await $.command.run({ command: 'pantheon', args: 'close' })).toEqual({ text: 'Pantheon panel closed.' })
    expect(seen.closed).toEqual(['pantheon'])
    await $.command.run({ command: 'pantheon', args: '' })
    expect(seen.opened[1]).toEqual({ id: 'pantheon', title: 'Pantheon', focus: true, closeOnEscape: true })
  })

  test('session.start registers tools and native agents', async ($, on) => {
    const { seen } = world(on)
    await start($)
    expect(seen.tools).toEqual(['delegate', 'delegate_result', 'delegate_cancel'])
    expect(seen.agents).toEqual(['oracle', 'designer', 'councillor-beta'])
    const oracle = seen.registered.find(spec => spec.name === 'oracle')
    expect(oracle?.tools).toBeUndefined()
    expect(oracle?.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit', 'Agent', 'mcp__pantheon__delegate', 'mcp__pantheon__delegate_cancel'])
    expect(seen.registered.find(spec => spec.name === 'designer')?.disallowedTools).toBeUndefined()
  })

  test('delegate runs codex through process.spawn hook and returns final message', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'find x' } as never))
    expect(out.status).toBe('done')
    expect(typeof out.result).toBe('string')
    expect(seen.argv[0]?.slice(0, 5)).toEqual(['codex', 'exec', '--json', '-s', 'read-only'])
    expect(seen.cwds[0]).toBe(ROOT)
  })

  test('absent user config registers default Claude roles and refuses Codex delegation', async ($, on) => {
    const { seen, files } = world(on)
    on('agent.offer', async () => ({ isOffered: true }))
    delete files[`${HOME}/.claude/pantheon.json`]
    await start($)
    expect(seen.agents).toEqual(['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'councillor-alpha', 'councillor-beta'])
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'find x' } as never))
    expect(out.error).toBe('Use pantheon:explorer through the Agent tool.')
    expect(seen.argv).toEqual([])
    expect((await $.agent.offer({ agent: 'pantheon:explorer', description: '', source: 'plugin', provider: { plugin: 'pantheon', tier: 'user' } } as never)).isOffered).toBe(true)
  })

  test('codex profile delegates oracle without registering it natively', async ($, on) => {
    const { seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{"profile":"codex"}' } })
    await start($)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'oracle', prompt: 'review x' } as never))
    expect(out.status).toBe('done')
    expect(seen.argv.length).toBe(1)
    expect(seen.argv[0].slice(0, 5)).toEqual(['codex', 'exec', '--json', '-s', 'read-only'])
    expect(seen.agents).not.toContain('oracle')
  })

  test('profile switches hide native explorer, delegate it on Codex and re-register it on Claude', async ($, on) => {
    const { seen, files } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{"profile":"claude"}' } })
    on('agent.offer', async () => ({ isOffered: true }))
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
    on('prompt.compose', async () => ({ sections: [] }))
    const offer = () => $.agent.offer({ agent: 'pantheon:explorer', description: '', source: 'plugin', provider: { plugin: 'pantheon', tier: 'user' } } as never)
    const turn = async (turnId: string) => {
      await $.turn.start({ text: 'Go', turnId })
      await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    }
    await start($)
    expect((await offer()).isOffered).toBe(true)
    expect(seen.agents.filter(agent => agent === 'explorer').length).toBe(1)
    files[`${HOME}/.claude/pantheon.json`] = '{"profile":"codex"}'
    await turn('codex-turn')
    expect((await offer()).isOffered).toBe(false)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'find x' } as never))
    expect(out.status).toBe('done')
    expect(seen.argv.length).toBe(1)
    expect(seen.argv[0].slice(0, 5)).toEqual(['codex', 'exec', '--json', '-s', 'read-only'])
    files[`${HOME}/.claude/pantheon.json`] = '{"profile":"claude"}'
    await turn('claude-turn')
    expect((await offer()).isOffered).toBe(true)
    expect(seen.agents.filter(agent => agent === 'explorer').length).toBe(2)
  })

  test('resume refuses a finished fixer job after its engine changes to Claude', async ($, on) => {
    const { seen, files } = world(on)
    await start($)
    const first = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x' } as never))
    expect(first.status).toBe('done')
    files[`${HOME}/.claude/pantheon.json`] = '{"profile":"claude"}'
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', resume: first.jobId, prompt: 'x' } as never))
    expect(out.error).toBe('Use pantheon:fixer through the Agent tool.')
    expect(seen.argv.length).toBe(1)
  })

  test('tool descriptions are generic across profiles', async ($, on) => {
    // Replace the fixture's terminal tool.register handler so the registration payload is observable.
    world(new Proxy(on, {
      apply(target, thisArg, args) {
        if (args[0] !== 'tool.register') return Reflect.apply(target, thisArg, args)
      },
    }))
    const descriptions: Record<string, string> = {}
    let agentDescription: unknown
    on('tool.register', async (_$, e) => {
      descriptions[e.name] = e.description
      if (e.name === 'delegate') agentDescription = (e.inputSchema as { properties: { agent: { description: string } } }).properties.agent.description
      return { value: { tool: `mcp__pantheon__${e.name}` } }
    })
    await start($)
    expect(descriptions.delegate).not.toContain('explorer, librarian, fixer')
    expect(descriptions.delegate).toContain('Run a Pantheon role or council seat currently on Codex on a task')
    expect(descriptions.delegate_result).toContain('a Pantheon role or council seat currently on Codex')
    expect(descriptions.delegate_cancel).toContain('a Pantheon role or council seat currently on Codex')
    expect(agentDescription).toBe('A role or councillor:<seat> currently on Codex.')
  })

  test('doctor under Claude without Codex reports it is not needed', async ($, on) => {
    world(on, {
      files: { [`${HOME}/.claude/pantheon.json`]: '{"profile":"claude"}' },
      runs: { 'codex --version': { exitCode: 127, stderr: 'codex: command not found' } },
    })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(out.text).toContain('not needed by profile claude')
    expect(out.text).not.toContain('fail')
  })

  const PING_ORDER = ['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'councillor:alpha', 'councillor:beta']
  const agentMessage = (text: string) => `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`

  /** world() with its process.run replaced: Codex ping runs (`codex exec`) answer through `exec`; the rest is canned. */
  function pingWorld(on: On, opts: { profile: string; codex?: boolean; file?: string; exec?: (argv: string[], asked: string) => { exitCode: number; stdout?: string; stderr?: string } | Error | 'hang' }) {
    const execs: string[][] = []
    const inits: unknown[] = []
    const submits: string[] = []
    const fixture = world(new Proxy(on, {
      apply(target, thisArg, args) {
        if (args[0] !== 'process.run') return Reflect.apply(target, thisArg, args)
      },
    }), { files: { [`${HOME}/.claude/pantheon.json`]: opts.file ?? `{"profile":"${opts.profile}"}` } })
    const result = (r: { exitCode: number; stdout?: string; stderr?: string }) => ({
      value: { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    on('process.run', async (_$, e) => {
      const key = e.argv.join(' ')
      if (key === 'codex --version') return result(opts.codex === false ? { exitCode: 127, stderr: 'not found' } : { exitCode: 0, stdout: 'codex-cli 1.0\n' })
      if (key === 'codex login status') return result({ exitCode: 0, stdout: 'Logged in\n' })
      if (e.argv[0] === 'codex' && e.argv[1] === 'exec') {
        execs.push(e.argv)
        inits.push((e as { init?: unknown }).init)
        // The mock sees no stdin, so a ping's target is told by call order, which follows pingTargets order.
        const asked = PING_ORDER[execs.length - 1] ?? 'unknown'
        const out = opts.exec ? opts.exec(e.argv, asked) : { exitCode: 0, stdout: agentMessage(PING_ORDER.map(n => `pong ${n}`).join(' ')) }
        if (out === 'hang') return new Promise<never>(() => {})
        if (out instanceof Error) throw out
        return result(out)
      }
      return result({ exitCode: 0, stdout: `${ROOT}\n` })
    })
    on('prompt.submit', async (_$, e) => { submits.push(e.text); return { text: e.text } })
    return { ...fixture, execs, inits, submits }
  }

  test('doctor pings Codex targets, leaves native ones pending and submits one prompt', async ($, on) => {
    const { execs, submits, clock } = pingWorld(on, { profile: 'mixed' })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(execs.length).toBeGreaterThan(0)
    expect(out.text).toContain('\nping\n')
    expect(out.text).toMatch(/^ok {3}\S+ \(codex/m)
    expect(out.text).toMatch(/^pending \S+ \(claude/m)
    expect(out.text).not.toMatch(/^fail \S+ \(codex/m)
    await clock.settle()
    expect(submits.length).toBe(1)
    expect(submits[0]).toContain('pantheon:')
  })

  test('doctor under Claude without Codex pings nothing and submits once', async ($, on) => {
    const { execs, submits, clock } = pingWorld(on, { profile: 'claude', codex: false })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(execs).toEqual([])
    expect(out.text).toMatch(/^pending /m)
    expect(out.text).not.toMatch(/^ok {3}\S+ \(/m)
    await clock.settle()
    expect(submits.length).toBe(1)
  })

  test('a failing Codex ping becomes a fail line with the first stderr line', async ($, on) => {
    const { execs } = pingWorld(on, { profile: 'codex', exec: () => ({ exitCode: 3, stderr: 'bad auth\nmore' }) })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(execs.length).toBeGreaterThan(0)
    expect(out.text).toMatch(/^fail explorer \(codex .*\): exit 3: bad auth$/m)
    expect(out.text).not.toContain('more')
  })

  test('a Codex ping sends its prompt on stdin and lets the host kill it at the timeout', async ($, on) => {
    const { inits } = pingWorld(on, { profile: 'mixed' })
    await start($)
    await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(inits.length).toBeGreaterThan(0)
    for (const init of inits as { stdin?: string; timeoutMs?: number }[]) {
      expect(init.stdin).toContain('pong ')
      expect(init.timeoutMs).toBe(60_000)
    }
  })

  test('every Codex ping runs read-only, even for roles that default to workspace-write', async ($, on) => {
    const { execs } = pingWorld(on, { profile: 'codex' })
    await start($)
    await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(execs.length).toBeGreaterThan(5)
    for (const argv of execs) expect(argv.slice(argv.indexOf('-s'), argv.indexOf('-s') + 2)).toEqual(['-s', 'read-only'])
  })

  test('a Codex ping that never answers becomes fail timeout', async ($, on) => {
    const { clock } = pingWorld(on, { profile: 'codex', exec: () => 'hang' })
    await start($)
    const run = $.command.run({ command: 'pantheon', args: 'doctor' })
    await clock.settle()
    await clock.advance(60_000)
    const out = await run
    expect(out.text).toMatch(/^fail explorer \(codex .*\): timeout$/m)
  })

  test('a ping needs exit 0 and the pong inside an agent message', async ($, on) => {
    pingWorld(on, { profile: 'codex', exec: (_argv, asked) => {
      if (asked === 'explorer') return { exitCode: 1, stdout: agentMessage('pong explorer') }
      if (asked === 'librarian') return { exitCode: 0, stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: `say pong ${asked}` } })}\n` }
      return { exitCode: 0, stdout: agentMessage(`pong ${asked}`) }
    } })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(out.text).toMatch(/^fail explorer /m)
    expect(out.text).toMatch(/^fail librarian /m)
    expect(out.text).toMatch(/^ok {3}fixer /m)
  })

  test('a throwing Codex ping does not throw out of doctor', async ($, on) => {
    pingWorld(on, { profile: 'codex', exec: () => new Error('boom') })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(out.text).toMatch(/^fail explorer \(codex /m)
  })

  test('doctor skips the ping section and the submit when the config is invalid', async ($, on) => {
    const { execs, submits, clock } = pingWorld(on, { profile: 'mixed', file: '{ nope' })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(out.text).not.toContain('ping')
    await clock.settle()
    expect(execs).toEqual([])
    expect(submits).toEqual([])
  })

  test('doctor does not submit when no target is native', async ($, on) => {
    const { submits, clock } = pingWorld(on, { profile: 'codex' })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    await clock.settle()
    expect(out.text).not.toMatch(/^pending /m)
    expect(submits).toEqual([])
  })

  test('delegate refuses while config is invalid', async ($, on) => {
    const { seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{ nope' } })
    await start($)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'x' } as never))
    expect(String(out.error)).toContain('Invalid Pantheon config')
    expect(seen.argv).toEqual([])
    expect(seen.toasts.length).toBe(1)
  })

  test('skipGitRepoCheck is true only when git rev-parse fails', async ($, on) => {
    const { seen } = world(on, { isRepo: false })
    await start($)
    await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'x' } as never)
    expect(seen.argv[0]).toContain('--skip-git-repo-check')
  })

  test('skipGitRepoCheck is absent inside a repository', async ($, on) => {
    const { seen } = world(on)
    await start($)
    await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'x' } as never)
    expect(seen.argv[0]).not.toContain('--skip-git-repo-check')
  })

  test('cwd resolving outside the root is refused', async ($, on) => {
    const { seen } = world(on, { realPaths: { '/repo/link': '/etc' } })
    await start($)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x', cwd: '/repo/link' } as never))
    expect(String(out.error)).toContain('outside')
    expect(seen.argv).toEqual([])
  })

  test('resume: unknown job and job without sessionId -> error', async ($, on) => {
    world(on, { stdout: '' , exitCode: 1 })
    await start($)
    const unknown = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x', resume: 'nope' } as never))
    expect(String(unknown.error)).toContain('Unknown job')
    const failed = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x' } as never))
    expect(failed.status).toBe('error')
    const again = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'y', resume: failed.jobId } as never))
    expect(String(again.error)).toContain('delegate it again')
  })

  test('resume ignores a new cwd and reuses the stored one', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const first = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x', cwd: '/repo/sub' } as never))
    const moved = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'y', resume: first.jobId, cwd: '/repo/other' } as never))
    expect(String(moved.error)).toContain('recorded cwd')
    const ok = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'y', resume: first.jobId } as never))
    expect(ok.status).toBe('done')
    expect(seen.cwds).toEqual(['/repo/sub', '/repo/sub'])
    expect(seen.argv[1]).toContain('resume')
  })

  test('resume recomputes sandbox with a stricter current policy', async ($, on) => {
    const { seen, files } = world(on)
    await start($)
    const first = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x' } as never))
    expect(seen.argv[0]).toContain('workspace-write')
    files[`${ROOT}/.claude/pantheon.json`] = JSON.stringify({ sandboxCap: 'read-only' })
    await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'y', resume: first.jobId } as never)
    expect(seen.argv[1]?.[4]).toBe('read-only')
  })

  test('resume revalidates the stored cwd before spawning', async ($, on) => {
    const realPaths: Record<string, string> = {}
    const { seen } = world(on, { realPaths })
    await start($)
    const first = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x', cwd: '/repo/sub' } as never))
    realPaths['/repo/sub'] = '/elsewhere'
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'y', resume: first.jobId } as never))
    expect(String(out.error)).toContain('outside')
    expect(seen.argv.length).toBe(1)
  })

  test('delegate_result reads a finished job', async ($, on) => {
    world(on)
    await start($)
    const first = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'x' } as never))
    const read = parse(await $.tool.call({ tool: RESULT, jobId: first.jobId } as never))
    expect(read.status).toBe('done')
    expect(read.result).toBe(first.result)
  })

  test('session.start marks leftover running/background jobs as lost', async ($, on) => {
    world(on)
    const saved: Job[] = [
      { id: 'a', agent: 'fixer', status: 'running', startedAt: 0, cwd: ROOT, sessionId: 's1' },
      { id: 'b', agent: 'explorer', status: 'background', startedAt: 0, cwd: ROOT },
      { id: 'c', agent: 'explorer', status: 'done', startedAt: 0, cwd: ROOT },
    ]
    let served = false
    on('state.get', async (_$, e, next) => {
      if (served || e.key !== 'jobs') return next(e)
      served = true
      return { value: { value: saved, version: 1 } }
    })
    await start($)
    const read = parse(await $.tool.call({ tool: RESULT, jobId: 'a' } as never))
    expect(read.status).toBe('lost')
    expect(read.isResumable).toBe(true)
    expect(parse(await $.tool.call({ tool: RESULT, jobId: 'b' } as never)).status).toBe('lost')
    expect(parse(await $.tool.call({ tool: RESULT, jobId: 'c' } as never)).status).toBe('done')
  })

  test('prompt.compose appends the orchestrator section last', async ($, on) => {
    world(on)
    on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
    await start($)
    const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    const last = out.sections[out.sections.length - 1]
    expect(last?.id).toBe('pantheon:orchestrator')
    expect(last?.scope).toBe('session')
    expect(last?.text).toContain('delegate')
  })

  test('valid config change re-registers native agents; invalid change does not', async ($, on) => {
    const { seen, files } = world(on)
    on('prompt.compose', async () => ({ sections: [] }))
    await start($)
    expect(seen.agents.length).toBe(3)
    files[`${HOME}/.claude/pantheon.json`] = JSON.stringify({ profile: 'mixed', profiles: { mixed: { agents: { oracle: { model: 'sonnet' } } } } })
    await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    expect(seen.agents.length).toBe(6)
    files[`${HOME}/.claude/pantheon.json`] = '{ broken'
    await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    expect(seen.agents.length).toBe(6)
  })

  test('prompt.submit injects council block only for composer/bridge with trigger', async ($, on) => {
    world(on)
    const contexts: (readonly string[] | undefined)[] = []
    on('prompt.submit', async (_$, e) => { contexts.push(e.context); return { text: e.text, context: e.context } })
    await start($)
    await $.prompt.submit({ text: 'run a council on this', origin: { kind: 'composer' } } as never)
    await $.prompt.submit({ text: 'run a council on this', origin: { kind: 'sdk' } } as never)
    await $.prompt.submit({ text: 'fix the bug', origin: { kind: 'composer' } } as never)
    expect(String(contexts[0]?.join('\n'))).toContain('Council Mode')
    expect(contexts[1] ?? []).toEqual([])
    expect(contexts[2] ?? []).toEqual([])
  })

  test('agent.offer hides disabled pantheon agents', async ($, on) => {
    world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['oracle'] }) } })
    on('agent.offer', async () => ({ isOffered: true }))
    await start($)
    const offer = (agent: string) => $.agent.offer({ agent, description: '', source: 'plugin', provider: { plugin: 'pantheon', tier: 'user' } } as never)
    expect((await offer('pantheon:oracle')).isOffered).toBe(false)
    expect((await offer('pantheon:designer')).isOffered).toBe(true)
    expect((await offer('Explore')).isOffered).toBe(true)
  })

  test('background delegate returns at once and wakes the session when done', async ($, on) => {
    const { clock } = world(on)
    const texts: string[] = []
    on('prompt.submit', async (_$, e) => { texts.push(e.text); return { text: e.text } })
    await start($)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'x', background: true } as never))
    expect(out.status).toBe('background')
    await clock.settle()
    const done = parse(await $.tool.call({ tool: RESULT, jobId: out.jobId } as never))
    expect(done.status).toBe('done')
    expect(texts.some(text => text.includes(String(out.jobId)) && text.includes('delegate_result'))).toBe(true)
  })

  test('invalid first config still registers the default native agents', async ($, on) => {
    const { seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{ nope' } })
    await start($)
    expect(seen.agents).toEqual(['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'councillor-alpha', 'councillor-beta'])
  })

  test('a failed native registration is retried on the next turn', async ($, on) => {
    const { seen } = world(on, { failFirstRegister: true })
    on('prompt.compose', async () => ({ sections: [] }))
    await start($)
    expect(seen.tools).toEqual(['delegate', 'delegate_result', 'delegate_cancel'])
    await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    expect(seen.agents).toEqual(['oracle', 'designer', 'councillor-beta'])
  })
})
