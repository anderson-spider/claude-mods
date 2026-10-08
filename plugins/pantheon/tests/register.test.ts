import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, On, TurnStepInput } from 'claude-code'

import type { Job, Native, SessionInfo } from '../types'
import { createQueue } from '../hooks/register'
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
function trackingWorld(on: On, slowNativeWrite = false) {
  const fixture = world(on)
  on('agent.spawn', async () => ({ model: 'model-1', agentId: 'native-1' }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) { return { ...stepResult, turnId: e.turnId, index: e.index } })
  on('turn.complete', async () => ({ text: 'Completed' }))
  on('session.measure', async () => ({ changed: ['context'] }))
  on('tool.call', async () => ({ result: 'Tool result' }))
  const stored: Record<string, unknown> = {}
  const writes: number[] = []
  on('state.set', async (_$, e, next) => {
    const steps = e.key === 'natives' ? (e.value as Native[])[0]?.steps ?? 0 : undefined
    if (slowNativeWrite && steps === 1) await fixture.clock.sleep(10)
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
  return { ...fixture, writes }
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
  })

  test('the panel opens on session.start and /pantheon close closes it', async ($, on) => {
    const { seen } = world(on)
    await start($)
    expect(seen.opened).toEqual([{ id: 'pantheon', title: 'Pantheon', columns: 72, rows: 8 }])
    expect(await $.command.run({ command: 'pantheon', args: 'close' })).toEqual({ text: 'Pantheon panel closed.' })
    expect(seen.closed).toEqual(['pantheon'])
    await $.command.run({ command: 'pantheon', args: '' })
    expect(seen.opened.length).toBe(2)
  })

  test('session.start registers tools and native agents', async ($, on) => {
    const { seen } = world(on)
    await start($)
    expect(seen.tools).toEqual(['delegate', 'delegate_result', 'delegate_cancel'])
    expect(seen.agents).toEqual(['oracle', 'designer', 'councillor-beta'])
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

  test('delegate refuses while config is invalid', async ($, on) => {
    const { seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{ nope' } })
    await start($)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'x' } as never))
    expect(String(out.error)).toContain('inválida')
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
    expect(String(out.error)).toContain('fora')
    expect(seen.argv).toEqual([])
  })

  test('resume: unknown job and job without sessionId -> error', async ($, on) => {
    world(on, { stdout: '' , exitCode: 1 })
    await start($)
    const unknown = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x', resume: 'nope' } as never))
    expect(String(unknown.error)).toContain('desconhecido')
    const failed = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x' } as never))
    expect(failed.status).toBe('error')
    const again = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'y', resume: failed.jobId } as never))
    expect(String(again.error)).toContain('delegar de novo')
  })

  test('resume ignores a new cwd and reuses the stored one', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const first = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x', cwd: '/repo/sub' } as never))
    const moved = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'y', resume: first.jobId, cwd: '/repo/other' } as never))
    expect(String(moved.error)).toContain('cwd gravado')
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
    expect(String(out.error)).toContain('fora')
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
    files[`${HOME}/.claude/pantheon.json`] = JSON.stringify({ agents: { oracle: { model: 'sonnet' } } })
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
    expect(seen.agents).toEqual(['oracle', 'designer', 'councillor-beta'])
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
