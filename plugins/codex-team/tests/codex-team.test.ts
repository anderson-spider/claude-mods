import { expect, test } from 'claude-code/testing'

import { agentName, buildPrompt, codexArgs, nextFreeId, reportPath, requestOf, splitDirection } from '../hooks/team'

test('agentName prefixes the job id', () => {
  expect(agentName(3)).toBe('ct-3')
})

test('nextFreeId skips the names that are still live agents', () => {
  expect(nextFreeId(1, ['ct-1', 'ct-2', 'other'])).toBe(3)
  expect(nextFreeId(1, [])).toBe(1)
})

test('codexArgs sandboxes execute to the workspace and review to read-only', () => {
  expect(codexArgs('execute')).toEqual(['-s', 'workspace-write', '-a', 'on-request'])
  expect(codexArgs('review')).toEqual(['-s', 'read-only', '-a', 'on-request'])
})

test('splitDirection goes right on a wide pane and down otherwise', () => {
  expect(splitDirection({ width: 286, height: 71 })).toBe('right')
  expect(splitDirection({ width: 80, height: 60 })).toBe('down')
})

test('reportPath lives in a codex-team folder of TMPDIR, falling back to /tmp', () => {
  expect(reportPath('/var/tmp', 4)).toBe('/var/tmp/codex-team/4.md')
  expect(reportPath('/var/tmp/', 4)).toBe('/var/tmp/codex-team/4.md')
  expect(reportPath(undefined, 4)).toBe('/tmp/codex-team/4.md')
})

test('buildPrompt for execute carries the task, the files, the report path and the no-commit rule', () => {
  const prompt = buildPrompt('execute', { task: 'add X', files: ['a.ts'] }, '/tmp/codex-team/1.md')
  expect(prompt).toContain('add X')
  expect(prompt).toContain('a.ts')
  expect(prompt).toContain('/tmp/codex-team/1.md')
  expect(prompt).toContain('Do not commit')
  expect(prompt).toContain('answer with only that path')
})

test('buildPrompt for review carries the target and focus and forbids edits', () => {
  const prompt = buildPrompt('review', { target: 'main', focus: 'races' }, '/tmp/codex-team/2.md')
  expect(prompt).toContain('main')
  expect(prompt).toContain('races')
  expect(prompt).toContain('Do not edit any file')
  expect(prompt).toContain('/tmp/codex-team/2.md')
  expect(prompt).toContain('answer with only that path')
})

test('requestOf rejects an empty task and trims the valid ones', () => {
  expect(typeof requestOf('execute', {})).toBe('string')
  expect(typeof requestOf('execute', { task: '  ' })).toBe('string')
  expect(requestOf('execute', { task: ' t ', files: ['a', 3, ''] })).toEqual({ kind: 'execute', task: 't', files: ['a'] })
  expect(requestOf('review', {})).toEqual({ kind: 'review', task: '', files: [] })
})

// --- Job lifecycle, against a scripted Herdr ---

import { HerdrError, runJob } from '../hooks/team'
import type { AgentState, Deps, Herdr, Job, Request, Settled } from '../hooks/team'

type Script = { prompt?: (Settled | Error)[]; wait?: (AgentState | Error)[]; start?: Error; read?: string; onPrompt?: () => void }

function fakeHerdr(script: Script) {
  const calls: string[] = []
  const prompts = [...(script.prompt ?? [])]
  const waits = [...(script.wait ?? [])]
  const pop = <T>(queue: (T | Error)[], fallback: T): T => {
    const next = queue.length ? queue.shift()! : fallback
    if (next instanceof Error) throw next
    return next
  }
  const herdr: Herdr = {
    size: async () => {
      calls.push('size')
      return { width: 286, height: 71 }
    },
    split: async direction => {
      calls.push(`split ${direction}`)
      return 'w1:p2'
    },
    start: async (name, pane, args) => {
      calls.push(`start ${name} ${pane} ${args.join(' ')}`)
      if (script.start) throw script.start
    },
    prompt: async (name, text) => {
      calls.push(`prompt ${name}`)
      script.onPrompt?.()
      return pop<Settled>(prompts, 'idle')
    },
    wait: async (name, _timeoutMs, until) => {
      calls.push(`wait ${name}${until ? ` until ${until.join('|')}` : ''}`)
      return pop<AgentState>(waits, 'idle')
    },
    read: async () => {
      calls.push('read')
      return script.read ?? 'pane text'
    },
    sendKeys: async (name, keys) => {
      calls.push(`keys ${name} ${keys.join(' ')}`)
    },
    list: async () => [],
  }
  return { herdr, calls }
}

const job = (kind: 'execute' | 'review' = 'execute', id = 1): Job => ({ id, kind, title: 't', status: 'queued', agent: `ct-${id}`, startedAt: 0 })
const request = (kind: 'execute' | 'review' = 'execute'): Request => ({ kind, task: 'do it', files: [] })

function setup(script: Script, files: Record<string, string> = { '/tmp/codex-team/1.md': '# Report\nall done' }) {
  const { herdr, calls } = fakeHerdr(script)
  const events: string[] = []
  let clock = 0
  const deps: Deps = {
    herdr,
    files: { read: async path => files[path] },
    tmpdir: undefined,
    now: () => clock,
    notify: (event, j) => events.push(`${event} ${j.status}`),
  }
  return { deps, calls, events, advance: (ms: number) => (clock += ms) }
}

test('runJob runs an execute job to done with its report', async () => {
  const { deps, calls, events } = setup({})
  const j = job()
  await runJob(deps, j, request())
  expect(calls).toEqual(['size', 'split right', 'start ct-1 w1:p2 -s workspace-write -a on-request', 'prompt ct-1'])
  expect(j.status).toBe('done')
  expect(j.pane).toBe('w1:p2')
  expect(j.report).toBe('/tmp/codex-team/1.md')
  expect(j.summary).toContain('all done')
  expect(events).toEqual(['finished done'])
})

test('runJob starts a review job read-only', async () => {
  const { deps, calls } = setup({}, { '/tmp/codex-team/1.md': 'findings' })
  await runJob(deps, job('review'), request('review'))
  expect(calls[2]).toBe('start ct-1 w1:p2 -s read-only -a on-request')
})

test('runJob goes blocked and back to working when the person answers, notifying once', async () => {
  const { deps, calls, events } = setup({ prompt: ['blocked'], wait: ['working', 'idle'] })
  const j = job()
  const seen: string[] = []
  const track = new Proxy(j, {
    set(target, key, value) {
      if (key === 'status') seen.push(value)
      return Reflect.set(target, key, value)
    },
  })
  await runJob(deps, track, request())
  expect(seen).toEqual(['starting', 'working', 'blocked', 'working', 'done'])
  expect(events).toEqual(['blocked blocked', 'finished done'])
  expect(calls.slice(-3)).toEqual(['prompt ct-1', 'wait ct-1 until working|idle|done', 'wait ct-1'])
})

test('runJob treats agent_not_ready at start as blocked and then prompts', async () => {
  const { deps, calls, events } = setup({ start: new HerdrError('agent_not_ready', 'blocked at startup'), wait: ['idle'] })
  const j = job()
  await runJob(deps, j, request())
  expect(events[0]).toBe('blocked blocked')
  expect(calls).toContain('wait ct-1 until working|idle|done')
  expect(calls.at(-1)).toBe('prompt ct-1')
  expect(j.status).toBe('done')
})

test('runJob falls back to the pane text when Codex wrote no report', async () => {
  const { deps } = setup({ read: 'what the pane shows' }, {})
  const j = job()
  await runJob(deps, j, request())
  expect(j.status).toBe('done')
  expect(j.summary).toBe('what the pane shows')
  expect(j.error).toContain('no report')
})

test('runJob fails on agent_prompt_stalled without sending the prompt again', async () => {
  const { deps, calls } = setup({ prompt: [new HerdrError('agent_prompt_stalled', 'no activity')] })
  const j = job()
  await runJob(deps, j, request())
  expect(j.status).toBe('failed')
  expect(j.error).toContain('w1:p2')
  expect(calls.filter(c => c.startsWith('prompt')).length).toBe(1)
})

test('runJob keeps waiting after a chunk timeout and finishes when Codex settles', async () => {
  const { deps, calls } = setup({ prompt: [new HerdrError('timeout', 'chunk')], wait: ['idle'] })
  const j = job()
  await runJob(deps, j, request())
  expect(j.status).toBe('done')
  expect(calls.slice(-2)).toEqual(['prompt ct-1', 'wait ct-1'])
})

test('runJob fails with a timeout once the job limit has passed', async () => {
  const state = setup({ prompt: [new HerdrError('timeout', 'chunk')], onPrompt: () => state.advance(10_000) })
  const j = job()
  await runJob(state.deps, j, request(), { limitMs: 1000 })
  expect(j.status).toBe('failed')
  expect(j.error).toContain('timeout')
  expect(j.error).toContain('w1:p2')
})

test('runJob fails naming the pane when it vanishes mid-job, and still resolves', async () => {
  const { deps } = setup({ prompt: ['blocked'], wait: [new HerdrError('pane_not_found', 'pane gone')] })
  const j = job()
  await runJob(deps, j, request())
  expect(j.status).toBe('failed')
  expect(j.error).toContain('w1:p2')
  expect(j.error).toContain('pane gone')
})
