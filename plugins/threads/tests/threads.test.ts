import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  ALIASES,
  agentFocus,
  agentGet,
  agentList,
  agentPrompt,
  agentStart,
  effortError,
  modelError,
  nativeArgs,
  paneClose,
  readScreen,
  sendKeys,
  worktreeCreate,
  worktreeRemove,
} from '../hooks/herdr'
import type { Probe, RunResult } from '../hooks/probe'
import { PROMPT, startPolling } from '../hooks/register'
import { claudeAnswerAfter, claudeTranscriptPath, lineCount } from '../hooks/transcript'
import { branchFor, classify, currentCommit, repoParent } from '../hooks/worktree'
import { SETTLE_MS, advance, capError, emptyRegistry, liveOf, newId, reconcile } from '../hooks/registry'
import type { Registry, Thread } from '../hooks/registry'
import { readSettings } from '../hooks/settings'
import { answer, briefing, clip, close, overview, poll, revalidate, start, status, takeOver } from '../hooks/threads'
import type { Ports } from '../hooks/threads'

const out = (stdout: string, exitCode = 0, stderr = ''): RunResult => ({ exitCode, stdout, stderr })
const json = (result: unknown) => out(JSON.stringify({ id: 'x', result }))
const failure = (code: string, message: string) => out(JSON.stringify({ error: { code, message }, id: 'x' }), 1)

/** A host that records argv and answers with `reply`. */
const probeOf = (reply: (argv: readonly string[]) => RunResult, calls: string[][] = [], files: Record<string, string> = {}): Probe => ({
  run: async argv => {
    calls.push([...argv])

    return reply(argv)
  },
  read: async path => files[path],
  list: async () => [],
  home: async () => '/home/me',
})

const AGENT = {
  agent: 'claude',
  agent_status: 'idle',
  pane_id: 'w1:p2',
  workspace_id: 'w1',
  cwd: '/wt',
  name: 't-abc123',
  agent_session: { value: 'sess-1' },
  completion_seq: 4,
  state_change_seq: 9,
}

test('readSettings reads, clamps and falls back', () => {
  expect(readSettings(undefined)).toEqual({ maxThreads: 3, defaultModel: 'sonnet', defaultPermissionMode: 'acceptEdits', pollMs: 3000 })
  expect(readSettings({ maxThreads: 0 }).maxThreads).toBe(3)
  expect(readSettings({ maxThreads: '4' }).maxThreads).toBe(4)
  expect(readSettings({ maxThreads: 99 }).maxThreads).toBe(10)
  expect(readSettings({ maxThreads: 2.7 }).maxThreads).toBe(2)
  expect(readSettings({ defaultModel: '' }).defaultModel).toBe('')
  expect(readSettings({ defaultModel: '  opus ' }).defaultModel).toBe('opus')
  expect(readSettings({ defaultPermissionMode: 'nope' }).defaultPermissionMode).toBe('acceptEdits')
  expect(readSettings({ defaultPermissionMode: 'plan' }).defaultPermissionMode).toBe('plan')
  expect(readSettings({ pollSeconds: 0.2 }).pollMs).toBe(1000)
  expect(readSettings({ pollSeconds: 500 }).pollMs).toBe(60_000)
  expect(readSettings({ pollSeconds: '5' }).pollMs).toBe(5000)
})

test('herdr commands build the exact argv', async () => {
  const calls: string[][] = []
  const probe = probeOf(() => json({ type: 'ok', agent: AGENT, agents: [AGENT] }), calls)

  await worktreeCreate(probe, { cwd: '/repo', branch: 'threads/abc123', base: 'deadbeef', label: 'Fix "it" 🚀' })
  await worktreeRemove(probe, 'w9')
  await agentStart(probe, { name: 't-abc123', kind: 'claude', paneId: 'w1:p2', args: ['--model', 'sonnet'] })
  await agentStart(probe, { name: 't-abc124', kind: 'codex', paneId: 'w1:p3', args: [] })
  await agentGet(probe, 't-abc123')
  await agentList(probe)
  await agentPrompt(probe, 't-abc123', 'do it')
  await sendKeys(probe, 't-abc123', ['1', 'enter'])
  await readScreen(probe, 't-abc123')
  await paneClose(probe, 'w1:p2')
  await agentFocus(probe, 't-abc123')

  expect(calls).toEqual([
    ['herdr', 'worktree', 'create', '--cwd', '/repo', '--branch', 'threads/abc123', '--base', 'deadbeef', '--label', 'Fix "it" 🚀', '--no-focus'],
    ['herdr', 'worktree', 'remove', '--workspace', 'w9'],
    ['herdr', 'agent', 'start', 't-abc123', '--kind', 'claude', '--pane', 'w1:p2', '--timeout', '60000', '--', '--model', 'sonnet'],
    ['herdr', 'agent', 'start', 't-abc124', '--kind', 'codex', '--pane', 'w1:p3', '--timeout', '60000'],
    ['herdr', 'agent', 'get', 't-abc123'],
    ['herdr', 'agent', 'list'],
    ['herdr', 'agent', 'prompt', 't-abc123', 'do it'],
    ['herdr', 'agent', 'send-keys', 't-abc123', '1', 'enter'],
    ['herdr', 'agent', 'read', 't-abc123', '--source', 'visible', '--lines', '20'],
    ['herdr', 'pane', 'close', 'w1:p2'],
    ['herdr', 'agent', 'focus', 't-abc123'],
  ])
})

test('nativeArgs builds each agent kind\'s own arguments', () => {
  expect(nativeArgs({ kind: 'claude', model: 'sonnet', mode: 'acceptEdits' })).toEqual(['--model', 'sonnet', '--permission-mode', 'acceptEdits'])
  expect(nativeArgs({ kind: 'claude', model: 'opus', mode: 'plan', effort: 'high' })).toEqual(['--model', 'opus', '--permission-mode', 'plan', '--effort', 'high'])
  expect(nativeArgs({ kind: 'codex' })).toEqual([])
  expect(nativeArgs({ kind: 'codex', model: 'x-1', effort: 'high' })).toEqual(['-m', 'x-1'])
})

test('modelError validates Claude models only', () => {
  expect(ALIASES).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
  for (const good of ['sonnet', 'claude-opus-5-5', 'claude-sonnet-4-6[1m]', 'claude-haiku-4-5-20251001']) expect(modelError('claude', good)).toBeUndefined()
  for (const bad of ['gpt-5', '', 'sonnet; rm']) expect(modelError('claude', bad)).toMatch(/model/i)
  expect(modelError('codex', 'anything at all')).toBeUndefined()
  expect(effortError('xhigh')).toBeUndefined()
  expect(effortError('ultra')).toMatch(/effort/i)
})

test('herdr results are parsed from success and error JSON', async () => {
  const agent = await agentGet(probeOf(() => json({ agent: AGENT })), 't-abc123')
  expect(agent).toEqual({
    ok: true,
    value: { name: 't-abc123', kind: 'claude', status: 'idle', paneId: 'w1:p2', workspaceId: 'w1', cwd: '/wt', sessionId: 'sess-1', completionSeq: 4, stateChangeSeq: 9 },
  })

  const none = await agentGet(probeOf(() => json({ agent: { ...AGENT, agent_session: null } })), 't')
  expect(none.ok && none.value.sessionId).toBeUndefined()

  const list = await agentList(probeOf(() => json({ agents: [AGENT, { ...AGENT, name: 'other' }] })))
  expect(list.ok && list.value.map(one => one.name)).toEqual(['t-abc123', 'other'])

  const created = await worktreeCreate(
    probeOf(() =>
      json({
        type: 'worktree_created',
        root_pane: { pane_id: 'w2:p1' },
        workspace: { workspace_id: 'w2' },
        worktree: { path: '/home/me/.herdr/worktrees/r/b', branch: 'threads/abc123' },
      }),
    ),
    { cwd: '/repo', branch: 'threads/abc123', base: 'x', label: 'l' },
  )
  expect(created).toEqual({ ok: true, value: { workspaceId: 'w2', paneId: 'w2:p1', path: '/home/me/.herdr/worktrees/r/b', branch: 'threads/abc123' } })

  const refused = await worktreeCreate(probeOf(() => failure('linked_worktree_source', 'start from the parent')), { cwd: '/wt', branch: 'b', base: 'x', label: 'l' })
  expect(refused).toEqual({ ok: false, error: { code: 'linked_worktree_source', message: 'start from the parent' } })

  const onStderr = await sendKeys(probeOf(() => out('', 1, JSON.stringify({ error: { code: 'agent_blocked', message: 'blocked' } }))), 't', ['1'])
  expect(onStderr).toEqual({ ok: false, error: { code: 'agent_blocked', message: 'blocked' } })

  const broken = await paneClose(probeOf(() => out('', 2, 'x'.repeat(500))), 'w1:p2')
  expect(broken.ok).toBe(false)
  expect(!broken.ok && broken.error.code).toBe('cli')
  expect(!broken.ok && broken.error.message.length).toBeLessThanOrEqual(300)

  expect(await readScreen(probeOf(() => out('line one\nline two\n')), 't')).toEqual({ ok: true, value: 'line one\nline two\n' })
})

/** Answers `git` by its full command line; anything not listed fails like a broken repository. */
const gitProbe = (answers: Record<string, RunResult>): Probe => probeOf(argv => answers[argv.join(' ')] ?? out('', 128, 'fatal'))

const CLEAN: Record<string, RunResult> = {
  'git --no-optional-locks status --porcelain --ignored': out(''),
  'git rev-parse HEAD': out('aaa\n'),
  'git rev-parse --abbrev-ref HEAD': out('threads/abc123\n'),
  'git rev-list --count aaa..HEAD': out('0\n'),
  'git submodule status': out(''),
}
const WORKTREE = { path: '/wt', base: 'aaa', branch: 'threads/abc123' }

test('repoParent finds the main checkout, also from a linked worktree', async () => {
  const at = (stdout: string, exitCode = 0) => gitProbe({ 'git rev-parse --path-format=absolute --git-common-dir': out(stdout, exitCode) })

  expect(await repoParent(at('/r/proj/.git\n'), '/r/proj')).toBe('/r/proj')
  expect(await repoParent(at('/r/proj/.git\n'), '/home/me/.herdr/worktrees/proj/wt')).toBe('/r/proj')
  expect(await repoParent(at('', 128), '/tmp')).toBeUndefined()
  expect(await repoParent(at('/r/proj.git\n'), '/r')).toBeUndefined()
  expect(await currentCommit(gitProbe({ 'git rev-parse HEAD': out('abc123\n') }), '/r')).toBe('abc123')
  expect(await currentCommit(gitProbe({}), '/r')).toBeUndefined()
  expect(branchFor('abc123')).toBe('threads/abc123')
})

test('classify says a worktree is empty only with nothing at all in it', async () => {
  expect(await classify(gitProbe(CLEAN), WORKTREE)).toEqual({ kind: 'empty' })

  const ahead = { ...CLEAN, 'git rev-parse HEAD': out('bbb\n'), 'git rev-list --count aaa..HEAD': out('2\n') }
  expect(await classify(gitProbe(ahead), WORKTREE)).toEqual({ kind: 'commits', commits: 2, dirty: false })
  expect(await classify(gitProbe({ ...ahead, 'git --no-optional-locks status --porcelain --ignored': out(' M a.ts\n') }), WORKTREE)).toEqual({ kind: 'commits', commits: 2, dirty: true })

  for (const line of [' M a.ts\n', '?? notes.txt\n', '!! dist/\n']) {
    expect(await classify(gitProbe({ ...CLEAN, 'git --no-optional-locks status --porcelain --ignored': out(line) }), WORKTREE)).toEqual({ kind: 'dirty' })
  }

  expect(await classify(gitProbe({ ...CLEAN, 'git submodule status': out(' 1a2b3c sub (heads/main)\n') }), WORKTREE)).toEqual({ kind: 'dirty' })
})

test('classify keeps the worktree when anything is off or fails', async () => {
  const kind = async (answers: Record<string, RunResult>) => (await classify(gitProbe(answers), WORKTREE)).kind

  expect(await kind({ ...CLEAN, 'git rev-parse --abbrev-ref HEAD': out('main\n') })).toBe('unknown')
  expect(await kind({ ...CLEAN, 'git rev-parse HEAD': out('bbb\n') })).toBe('unknown')
  for (const command of Object.keys(CLEAN)) {
    expect(await kind({ ...CLEAN, [command]: out('', 128, 'fatal') })).toBe('unknown')
  }

  const reason = await classify(gitProbe({ ...CLEAN, 'git --no-optional-locks status --porcelain --ignored': out('', 128, 'fatal: not a repo') }), WORKTREE)
  expect(reason.kind === 'unknown' && reason.reason).toMatch(/git status/)
})

const said = (blocks: unknown[], model = 'claude-sonnet-5-5') => JSON.stringify({ type: 'assistant', message: { model, content: blocks } })
const text = (value: string) => ({ type: 'text', text: value })
const tool = { type: 'tool_use', name: 'Bash', input: {} }
const asked = JSON.stringify({ type: 'user', message: { content: 'go' } })

test('claudeTranscriptPath turns the cwd into the project folder name', () => {
  expect(claudeTranscriptPath('/home/me', '/Users/a/.herdr/worktrees/x/y', 'sid')).toBe('/home/me/.claude/projects/-Users-a--herdr-worktrees-x-y/sid.jsonl')
  expect(claudeTranscriptPath('/home/me', '/Users/a b/my_repo@x/.wt', 'sid')).toBe('/home/me/.claude/projects/-Users-a-b-my-repo-x--wt/sid.jsonl')
})

test('lineCount counts non-empty lines', () => {
  expect(lineCount('')).toBe(0)
  expect(lineCount(`${asked}\n\n${said([text('a')])}\n`)).toBe(2)
})

test('claudeAnswerAfter returns the last answer after the marker, never an older one', () => {
  const log = [asked, said([text('first task answer')]), asked, said([text('part one'), text('part two')], 'claude-opus-5-5')].join('\n')

  expect(claudeAnswerAfter(log, 2)).toEqual({ text: 'part one\n\npart two', model: 'claude-opus-5-5' })
  expect(claudeAnswerAfter(log, 0)?.text).toBe('part one\n\npart two')
  expect(claudeAnswerAfter(log, 4)).toBeUndefined()
})

test('claudeAnswerAfter answers only from the last assistant message, and finds nothing when that one has no text', () => {
  const corrupt = [asked, said([text('working on it')]), 'not json {', said([tool])].join('\n')

  expect(claudeAnswerAfter(corrupt, 0)).toBeUndefined()
  expect(claudeAnswerAfter([asked, said([tool]), said([text('the real answer')])].join('\n'), 0)).toEqual({ text: 'the real answer', model: 'claude-sonnet-5-5' })
  expect(claudeAnswerAfter([asked, said([text('old')]), asked, said([tool])].join('\n'), 2)).toBeUndefined()
  expect(claudeAnswerAfter([asked, said([text('done')]), 'not json {'].join('\n'), 0)?.text).toBe('done')
})

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: 'abc123',
  owner: 'lead-1',
  title: 'Fix it',
  agent: 'claude',
  stage: 'prompted',
  status: 'working',
  workspaceId: 'w2',
  paneId: 'w2:p1',
  agentName: 't-abc123',
  path: '/wt',
  branch: 'threads/abc123',
  base: 'aaa',
  createdAt: 1000,
  ...over,
})
const registryOf = (...threads: Thread[]): Registry => ({ ...emptyRegistry(), threads })
const agentNamed = (name: string) => ({ name, kind: 'claude', status: 'idle', paneId: 'p', workspaceId: 'w', cwd: '/wt' })

test('liveOf and capError count only the owner\'s live helpers', () => {
  const reg = registryOf(
    thread({ id: 'a', status: 'working' }),
    thread({ id: 'b', status: 'idle' }),
    thread({ id: 'c', status: 'exited' }),
    thread({ id: 'd', status: 'closed' }),
    thread({ id: 'e', status: 'orphan' }),
    thread({ id: 'f', status: 'branch-left' }),
    thread({ id: 'g', owner: 'lead-2', status: 'working' }),
  )

  expect(liveOf(reg, 'lead-1').map(one => one.id)).toEqual(['a', 'b'])
  expect(capError(reg, 'lead-1', 3)).toBeUndefined()
  expect(capError(reg, 'lead-1', 2)).toMatch(/a, b.*threads_close/s)
})

test('reconcile marks lost helpers and leaves everything else alone', () => {
  const reg = registryOf(
    thread({ id: 'a', agentName: 't-a', stage: 'prompted', status: 'working' }),
    thread({ id: 'b', agentName: 't-b', stage: 'creating', status: 'starting' }),
    thread({ id: 'c', agentName: 't-c', stage: 'worktree', status: 'starting' }),
    thread({ id: 'd', agentName: 't-d', stage: 'agent', status: 'starting' }),
    thread({ id: 'e', agentName: 't-e', owner: 'lead-2', status: 'working' }),
    thread({ id: 'f', agentName: 't-f', status: 'working' }),
    thread({ id: 'g', agentName: 't-g', status: 'closed' }),
  )
  const next = reconcile(reg, 'lead-1', [agentNamed('t-f'), agentNamed('stranger')])
  const statuses = Object.fromEntries(next.threads.map(one => [one.id, one.status]))

  expect(statuses).toEqual({ a: 'exited', b: 'orphan', c: 'orphan', d: 'exited', e: 'working', f: 'working', g: 'closed' })
  expect(next.threads.some(one => one.agentName === 'stranger')).toBe(false)
  expect(reconcile(reg, 'lead-1', undefined)).toBe(reg)
})

test('newId gives 6 base36 characters that are not taken', () => {
  const picks = [...Array(6).fill(10), ...Array(6).fill(11)]
  const random = () => ((picks.shift() ?? 0) + 0.5) / 36

  expect(newId(new Set(['aaaaaa']), random)).toBe('bbbbbb')
  expect(newId(new Set())).toMatch(/^[0-9a-z]{6}$/)
})

const watched = (over: Partial<Thread> = {}): Thread =>
  thread({ status: 'starting', marker: { at: 0, completionSeq: 4, transcriptLines: 0, seenWorking: false }, ...over })
const seen = (status: string, over: Record<string, unknown> = {}) => ({ ...agentNamed('t-abc123'), status, completionSeq: 4, ...over })

test('advance leaves unwatched and finished-with records alone', () => {
  const lost = advance(thread({ marker: undefined }), undefined, 5, false)
  expect(lost.events).toEqual([])
  expect(lost.thread.status).toBe('working')

  for (const status of ['exited', 'closed', 'orphan', 'branch-left'] as const) {
    expect(advance(watched({ status }), undefined, 5, false)).toEqual({ thread: watched({ status }), events: [] })
  }
})

test('advance: a helper that vanished has exited, once', () => {
  const first = advance(watched({ status: 'working' }), undefined, 5, false)
  expect(first.thread.status).toBe('exited')
  expect(first.events).toEqual([{ threadId: 'abc123', kind: 'exited' }])
  expect(advance(first.thread, undefined, 6, false).events).toEqual([])
})

test('advance: finished means idle after work, or a newer completion, or a settled idle with an answer', () => {
  const started = advance(watched(), seen('idle'), 100, false)
  expect(started.events).toEqual([])
  expect(started.thread.idleSince).toBe(100)

  const working = advance(started.thread, seen('working'), 200, false)
  expect(working.thread.status).toBe('working')
  expect(working.thread.marker?.seenWorking).toBe(true)
  expect(working.thread.idleSince).toBeUndefined()

  const done = advance(working.thread, seen('idle', { completionSeq: 5 }), 300, false)
  expect(done.events).toEqual([{ threadId: 'abc123', kind: 'finished' }])
  expect(done.thread.status).toBe('idle')
  expect(advance(done.thread, seen('done', { completionSeq: 5 }), 400, false).events).toEqual([])

  // Finished between two ticks: working was never seen, but the completion counter moved.
  const quick = advance(watched(), seen('done', { completionSeq: 5 }), 100, false)
  expect(quick.events).toEqual([{ threadId: 'abc123', kind: 'finished' }])

  // Neither signal: only a settled idle with an answer on disk counts.
  const waiting = watched({ idleSince: 1000 })
  expect(advance(waiting, seen('idle'), 1000 + SETTLE_MS, false).events).toEqual([])
  expect(advance(waiting, seen('idle'), 1000 + SETTLE_MS - 1, true).events).toEqual([])
  expect(advance(waiting, seen('idle'), 1000 + SETTLE_MS, true).events).toEqual([{ threadId: 'abc123', kind: 'finished' }])
})

test('advance: blocked is announced once per episode and unknown changes nothing', () => {
  const first = advance(watched({ status: 'working' }), seen('blocked'), 10, false)
  expect(first.events).toEqual([{ threadId: 'abc123', kind: 'blocked' }])
  expect(first.thread.status).toBe('blocked')
  expect(advance(first.thread, seen('blocked'), 11, false).events).toEqual([])

  const resumed = advance(first.thread, seen('working'), 12, false)
  expect(advance(resumed.thread, seen('blocked'), 13, false).events).toEqual([{ threadId: 'abc123', kind: 'blocked' }])

  const odd = watched({ status: 'working' })
  expect(advance(odd, seen('unknown'), 14, false)).toEqual({ thread: odd, events: [] })
})

const CREATED = json({
  type: 'worktree_created',
  root_pane: { pane_id: 'w2:p1' },
  workspace: { workspace_id: 'w2' },
  worktree: { path: '/wt', branch: 'threads/012345' },
})
const STARTED = { ...AGENT, agent_status: 'idle', pane_id: 'w2:p1', workspace_id: 'w2', cwd: '/wt', name: 't-012345', completion_seq: 2, state_change_seq: 3 }

/** What git and herdr answer, by command line; `over` replaces one answer by a short key. */
const route = (argv: readonly string[], over: Record<string, RunResult> = {}): RunResult => {
  const [tool, a, b] = argv
  const line = argv.join(' ')

  if (tool === 'git') {
    if (line === 'git rev-parse --path-format=absolute --git-common-dir') return over.common ?? out('/repo/.git\n')
    if (line === 'git rev-parse HEAD') return over.head ?? out('base123\n')
    if (line === 'git rev-parse --abbrev-ref HEAD') return out('threads/012345\n')
    if (a === 'branch') return over.branch ?? out('')

    if (a === '--no-optional-locks') return over.status ?? out('')

    return a === 'rev-list' ? (over.count ?? out('0\n')) : out('')
  }

  if (a === 'worktree' && b === 'create') return over.create ?? CREATED
  if (a === 'worktree' && b === 'list') return over.wtlist ?? json({ worktrees: [{ path: '/wt', branch: 'threads/012345', open_workspace_id: 'w2' }] })
  if (a === 'worktree' && b === 'remove') return over.remove ?? json({ type: 'worktree_removed' })
  if (a === 'agent' && b === 'start') return over.start ?? json({ agent: STARTED })
  if (a === 'agent' && b === 'prompt') return over.prompt ?? json({ agent: STARTED })
  if (a === 'agent' && b === 'read') return out('Do you want to proceed?\n')
  if (a === 'agent' && b === 'get') return over.get ?? json({ agent: STARTED })
  if (a === 'agent' && b === 'list') return over.list ?? json({ agents: [STARTED] })

  return json({ type: 'ok', agents: [STARTED] })
}

/** Ports over an in-memory registry, a step counter for ids, and a log of what ran and what was saved. */
const harness = (over: Record<string, RunResult> = {}, registry: Registry = emptyRegistry()) => {
  const calls: string[][] = []
  const files: Record<string, string> = {}
  let counter = 0
  const state = { registry, others: [] as Thread[] }
  const ports: Ports = {
    probe: probeOf(argv => route(argv, over), calls, files),
    load: async () => state.registry,
    save: async next => {
      state.registry = next
      calls.push(['save', next.threads[0]?.stage ?? 'none'])
    },
    owner: async () => 'lead-1',
    others: async () => state.others,
    take: async id => {
      const found = state.others.find(one => one.id === id)
      state.others = state.others.filter(one => one.id !== id)

      return found
    },
    cwd: async () => '/lead',
    leadModel: async () => 'claude-opus-5-5',
    now: () => 1000,
    random: () => ((counter++ % 36) + 0.5) / 36,
    sleep: async () => {},
  }
  const ran = () => calls.filter(call => call[0] !== 'save').map(call => call.join(' '))

  return { ports, calls, state, files, over, ran, herdr: () => calls.filter(call => call[0] === 'herdr') }
}
const SETTINGS = readSettings(undefined)

test('threads_start creates the worktree, starts the helper and sends the briefing, in that order', async () => {
  const { ports, calls, state, herdr } = harness()
  const result = await start(ports, SETTINGS, { task: 'Fix the bug', title: 'Fix it' })
  const prompt = calls.find(call => call.slice(0, 3).join(' ') === 'herdr agent prompt')?.[4] ?? ''

  expect(result.isError).toBeUndefined()
  expect(result.text).toMatch(/012345/)
  expect(result.text).toMatch(/threads\/012345/)
  expect(result.text).toMatch(/\/wt/)
  expect(calls.filter(call => call[0] !== 'save')).toEqual([
    ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    ['git', 'rev-parse', 'HEAD'],
    ['herdr', 'worktree', 'create', '--cwd', '/repo', '--branch', 'threads/012345', '--base', 'base123', '--label', 'Fix it', '--no-focus'],
    ['herdr', 'agent', 'start', 't-012345', '--kind', 'claude', '--pane', 'w2:p1', '--timeout', '60000', '--', '--model', 'sonnet', '--permission-mode', 'acceptEdits'],
    ['herdr', 'agent', 'prompt', 't-012345', prompt],
  ])
  expect(prompt).toBe(briefing({ branch: 'threads/012345', base: 'base123', task: 'Fix the bug' }))
  expect(prompt.startsWith('-')).toBe(false)
  expect(prompt).toMatch(/own git worktree/)
  expect(prompt).toMatch(/never push/i)
  expect(prompt).toMatch(/short summary/)
  expect(prompt).toMatch(/base123/)
  expect(prompt).toMatch(/Fix the bug$/)

  const saved = calls.filter(call => call[0] === 'save')
  expect(saved[0]).toEqual(['save', 'creating'])
  expect(calls.findIndex(call => call[0] === 'save')).toBeLessThan(calls.findIndex(call => call[0] === 'herdr'))
  expect(herdr().length).toBe(3)

  expect(state.registry.threads[0]).toMatchObject({
    id: '012345',
    owner: 'lead-1',
    stage: 'prompted',
    status: 'starting',
    base: 'base123',
    branch: 'threads/012345',
    path: '/wt',
    workspaceId: 'w2',
    paneId: 'w2:p1',
    agentName: 't-012345',
    sessionId: 'sess-1',
    marker: { completionSeq: 2, seenWorking: false },
  })
})

test('threads_start resolves the model and keeps the title out of the branch', async () => {
  const modelArgs = (calls: string[][]) => calls.find(call => call[1] === 'agent' && call[2] === 'start')?.slice(11) ?? []

  const given = harness()
  await start(given.ports, SETTINGS, { task: 't', model: 'opus', effort: 'high' })
  expect(modelArgs(given.calls)).toEqual(['--model', 'opus', '--permission-mode', 'acceptEdits', '--effort', 'high'])

  const inherited = harness()
  await start(inherited.ports, readSettings({ defaultModel: '' }), { task: 't' })
  expect(modelArgs(inherited.calls).slice(0, 2)).toEqual(['--model', 'claude-opus-5-5'])

  const odd = harness()
  await start(odd.ports, SETTINGS, { task: 't', title: 'Fix "it" 🚀 now' })
  const create = odd.calls.find(call => call[2] === 'create') ?? []
  expect(create[create.indexOf('--label') + 1]).toBe('Fix "it" 🚀 now')
  expect(create[create.indexOf('--branch') + 1]).toBe('threads/012345')
})

test('threads_start refuses before any side effect', async () => {
  const live = { ...emptyRegistry(), threads: [thread({ id: 'old111', status: 'idle' })] }
  const cases: Array<[string, ReturnType<typeof harness>, Parameters<typeof start>[2], Parameters<typeof start>[1]?]> = [
    ['empty task', harness(), { task: '   ' }, undefined],
    ['bad model', harness(), { task: 't', model: 'gpt-5' }, undefined],
    ['bad effort', harness(), { task: 't', effort: 'ultra' }, undefined],
    ['cap reached', harness({}, live), { task: 't' }, readSettings({ maxThreads: 1 })],
    ['not a git repository', harness({ common: out('', 128, 'fatal') }), { task: 't' }, undefined],
  ]

  for (const [label, world, input, settings] of cases) {
    const result = await start(world.ports, settings ?? SETTINGS, input)
    expect(result.isError, label).toBe(true)
    expect(world.herdr(), label).toEqual([])
  }

  expect((await start(cases[3]![1].ports, readSettings({ maxThreads: 1 }), { task: 't' })).text).toMatch(/old111.*limit 1/s)
})

test('two simultaneous starts cannot exceed the cap', async () => {
  const world = harness()
  const settings = readSettings({ maxThreads: 1 })
  const results = await Promise.all([start(world.ports, settings, { task: 'a' }), start(world.ports, settings, { task: 'b' })])

  expect(results.filter(one => one.isError).length).toBe(1)
  expect(results.find(one => one.isError)?.text).toMatch(/limit 1/)
  expect(world.herdr().filter(call => call[2] === 'create').length).toBe(1)
})

test('threads_start rolls back an empty worktree when the helper cannot start', async () => {
  const world = harness({ start: failure('boom', 'could not start'), list: json({ agents: [] }) })
  const result = await start(world.ports, SETTINGS, { task: 't' })

  expect(result.isError).toBe(true)
  expect(result.text).toMatch(/rolled back/)
  expect(world.ran()).toContain('herdr worktree remove --workspace w2')
  expect(world.ran()).toContain('git branch -d threads/012345')
  expect(world.state.registry.threads).toEqual([])

  const stuck = harness({ start: failure('boom', 'could not start'), remove: failure('busy', 'in use'), list: json({ agents: [] }) })
  const left = await start(stuck.ports, SETTINGS, { task: 't' })
  expect(left.isError).toBe(true)
  expect(left.text).toMatch(/\/wt/)
  expect(stuck.state.registry.threads[0]?.status).toBe('orphan')
})

test('threads_start keeps a helper that is stuck at startup, and one whose prompt is unconfirmed', async () => {
  const stuck = harness({ start: failure('agent_not_ready', 'blocked at startup') })
  const waiting = await start(stuck.ports, SETTINGS, { task: 't' })

  expect(waiting.text).toMatch(/Do you want to proceed/)
  expect(stuck.state.registry.threads[0]?.status).toBe('blocked')
  expect(stuck.ran().some(line => line.startsWith('herdr worktree remove'))).toBe(false)

  for (const code of ['agent_prompt_stalled', 'agent_blocked', 'timeout']) {
    const world = harness({ prompt: failure(code, 'no') })
    const result = await start(world.ports, SETTINGS, { task: 't' })

    expect(result.isError, code).toBe(true)
    expect(result.text).toMatch(/unconfirmed/)
    expect(world.state.registry.threads.length).toBe(1)
    expect(world.herdr().filter(call => call[2] === 'prompt').length).toBe(1)
  }
})

const owned = (over: Partial<Thread> = {}): Thread =>
  thread({
    id: '012345',
    agentName: 't-012345',
    branch: 'threads/012345',
    base: 'base123',
    sessionId: 'sess-1',
    marker: { at: 0, completionSeq: 2, transcriptLines: 0, seenWorking: true },
    ...over,
  })
const holding = (t: Thread, over: Record<string, RunResult> = {}) => harness(over, registryOf(t))
const GONE = json({ agents: [] })

test('revalidate refuses a pane, an agent or a folder that is not the helper that was started', async () => {
  const check = (over: Record<string, RunResult> = {}) => revalidate(holding(owned(), over).ports, owned())

  expect((await check()).ok).toBe(true)

  const elsewhere = await check({ get: json({ agent: { ...STARTED, pane_id: 'w9:p9' } }) })
  expect(!elsewhere.ok && elsewhere.reason).toMatch(/pane/)
  const other = await check({ get: json({ agent: { ...STARTED, agent: 'codex' } }) })
  expect(!other.ok && other.reason).toMatch(/agent/)
  const foreign = await check({ get: json({ agent: { ...STARTED, cwd: '/somewhere/else' } }) })
  expect(!foreign.ok && foreign.reason).toMatch(/folder/)
  expect((await check({ get: failure('not_found', 'no such agent') })).ok).toBe(false)
})

test('threads_status lists the owner\'s helpers and details one, with the screen of a blocked one', async () => {
  const world = holding(owned({ status: 'blocked' }))
  world.state.registry = registryOf(owned({ status: 'blocked' }), thread({ id: 'zzz999', owner: 'lead-2', agentName: 't-zzz999' }))

  const all = await status(world.ports)
  expect(all.text).toMatch(/012345.*blocked.*claude.*threads\/012345/)
  expect(all.text).not.toMatch(/zzz999/)

  const one = await status(world.ports, '012345')
  expect(one.text).toMatch(/Do you want to proceed/)
  expect(one.text).toMatch(/no commits/)

  const missing = harness()
  const nope = await status(missing.ports, 'nope00')
  expect(nope.isError).toBe(true)
  expect(missing.herdr()).toEqual([])
})

test('threads_answer sends keys only to a blocked helper and text only to an idle one', async () => {
  const blocked = holding(owned({ status: 'blocked' }), { get: json({ agent: { ...STARTED, agent_status: 'blocked' } }) })
  const approved = await answer(blocked.ports, { id: '012345', keys: ['1', 'enter'] })
  expect(approved.isError).toBeUndefined()
  expect(blocked.ran()).toContain('herdr agent send-keys t-012345 1 enter')

  const notBlocked = holding(owned())
  expect((await answer(notBlocked.ports, { id: '012345', keys: ['1'] })).isError).toBe(true)
  expect(notBlocked.ran().some(line => line.includes('send-keys'))).toBe(false)

  const idle = holding(owned({ status: 'idle' }))
  const sent = await answer(idle.ports, { id: '012345', text: 'now add tests' })
  expect(sent.isError).toBeUndefined()
  expect(idle.ran()).toContain('herdr agent prompt t-012345 now add tests')
  expect(idle.state.registry.threads[0]).toMatchObject({ status: 'working', marker: { completionSeq: 2, seenWorking: false } })

  const busy = holding(owned({ status: 'working' }), { get: json({ agent: { ...STARTED, agent_status: 'working' } }) })
  expect((await answer(busy.ports, { id: '012345', text: 'x' })).isError).toBe(true)

  for (const input of [{ id: '012345' }, { id: '012345', keys: ['1'], text: 'x' }]) {
    expect((await answer(holding(owned()).ports, input)).isError).toBe(true)
  }

  const moved = holding(owned({ status: 'blocked' }), { get: json({ agent: { ...STARTED, pane_id: 'w9:p9', agent_status: 'blocked' } }) })
  expect((await answer(moved.ports, { id: '012345', keys: ['1'] })).isError).toBe(true)
  expect(moved.ran().some(line => line.includes('send-keys'))).toBe(false)
})

test('threads_close removes only a provably empty worktree', async () => {
  const empty = holding(owned(), { list: GONE })
  const removed = await close(empty.ports, '012345')

  expect(removed.isError).toBeUndefined()
  expect(removed.text).toMatch(/removed/)
  expect(empty.ran()).toEqual(expect.arrayContaining(['herdr pane close w2:p1', 'herdr worktree remove --workspace w2', 'git branch -d threads/012345']))
  expect(empty.state.registry.threads).toEqual([])

  const ahead = holding(owned(), { list: GONE, head: out('bbb\n'), count: out('2\n') })
  const kept = await close(ahead.ports, '012345')
  expect(kept.text).toMatch(/\/wt/)
  expect(kept.text).toMatch(/threads\/012345/)
  expect(kept.text).toMatch(/2 commits/)
  expect(kept.text).toMatch(/git merge/)
  expect(ahead.ran().some(line => line.startsWith('herdr worktree remove'))).toBe(false)
  expect(ahead.state.registry.threads[0]).toMatchObject({ status: 'closed', kept: { commits: 2, dirty: false } })

  const before = ahead.herdr().length
  const again = await close(ahead.ports, '012345')
  expect(again.text).toMatch(/2 commits/)
  expect(ahead.herdr().length).toBe(before)

  for (const over of [{ status: out(' M a.ts\n') }, { status: out('', 128, 'fatal') }]) {
    const world = holding(owned(), { list: GONE, ...over })
    await close(world.ports, '012345')
    expect(world.ran().some(line => line.startsWith('herdr worktree remove'))).toBe(false)
    expect(world.state.registry.threads[0]?.status).toBe('closed')
  }
})

test('threads_close refuses and removes nothing when the helper cannot be vouched for or stopped', async () => {
  const wrong = holding(owned(), { list: GONE, get: json({ agent: { ...STARTED, pane_id: 'w9:p9' } }) })
  expect((await close(wrong.ports, '012345')).isError).toBe(true)
  expect(wrong.ran().some(line => line.includes('pane close') || line.includes('worktree remove'))).toBe(false)

  const running = holding(owned())
  expect((await close(running.ports, '012345')).isError).toBe(true)
  expect(running.ran().some(line => line.startsWith('herdr worktree remove'))).toBe(false)

  const unknown = harness()
  expect((await close(unknown.ports, 'nope00')).isError).toBe(true)
  expect(unknown.herdr()).toEqual([])
})

test('threads_close reports a branch it could not delete and a worktree it could not remove', async () => {
  const left = holding(owned(), { list: GONE, branch: out('', 1, 'error: not fully merged') })
  const result = await close(left.ports, '012345')
  expect(result.text).toMatch(/branch/)
  expect(left.state.registry.threads[0]?.status).toBe('branch-left')

  const stuck = holding(owned(), { list: GONE, remove: failure('busy', 'in use') })
  expect((await close(stuck.ports, '012345')).isError).toBe(true)
  expect(stuck.state.registry.threads[0]?.status).toBe('exited')

  const orphan = holding(owned({ status: 'orphan', path: undefined, workspaceId: undefined, stage: 'creating' }))
  expect((await close(orphan.ports, '012345')).isError).toBeUndefined()
  expect(orphan.state.registry.threads).toEqual([])
  expect(orphan.herdr()).toEqual([])
})

const TRANSCRIPT = '/home/me/.claude/projects/-wt/sess-1.jsonl'
const watching = (over: Partial<Thread> = {}) =>
  owned({ status: 'starting', requestedModel: 'sonnet', marker: { at: 0, completionSeq: 2, transcriptLines: 0, seenWorking: false }, ...over })
const listing = (...agents: Array<Record<string, unknown>>) => json({ agents: agents.map(one => ({ ...STARTED, ...one })) })

/** Ports for `poll`, with what was announced and toasted, and what the registry held when each announcement went out. */
const polling = (t: Thread[], over: Record<string, RunResult> = {}) => {
  const world = harness(over, registryOf(...t))
  const announced: string[] = []
  const toasts: string[] = []
  const heldPending: number[] = []
  const reply = { value: 'delivered' as 'delivered' | 'refused' }
  const announce = async (text: string) => {
    announced.push(text)
    heldPending.push(world.state.registry.pending.length)

    return reply.value
  }
  const tick = () => poll(world.ports, announce, text => void toasts.push(text))

  return { ...world, announced, toasts, heldPending, reply, tick }
}

test('clip cuts a long text and says where the rest is', () => {
  expect(clip('short', 10, '/p')).toBe('short')
  expect(clip('x'.repeat(11), 10, '/p')).toBe(`${'x'.repeat(10)}\n… [cut; the full text is in /p]`)
})

test('poll does nothing without live helpers, and survives a Herdr that does not answer', async () => {
  const idle = polling([owned({ status: 'closed' })])
  expect(await idle.tick()).toEqual({ live: false })
  expect(idle.calls).toEqual([])

  const world = polling([watching()], { list: failure('down', 'no server') })
  expect((await world.tick()).live).toBe(true)
  await world.tick()
  expect(world.toasts).toEqual([])
  await world.tick()
  await world.tick()
  expect(world.toasts.length).toBe(1)
  expect(world.state.registry.threads[0]?.status).toBe('starting')
  expect(world.herdr().filter(call => call[2] === 'list').length).toBe(4)

  world.over.list = listing({ agent_status: 'idle', completion_seq: 2 })
  await world.tick()
  expect(world.state.registry.listFailures).toBe(0)
})

test('poll announces a finished helper once, with its answer, branch and models', async () => {
  const world = polling([watching()])
  world.files[TRANSCRIPT] = [asked, said([text('All done')], 'claude-sonnet-5-5')].join('\n')

  world.over.list = listing({ agent_status: 'idle', completion_seq: 2 })
  await world.tick()
  expect(world.announced).toEqual([])

  world.over.list = listing({ agent_status: 'working', completion_seq: 2 })
  await world.tick()
  world.over.list = listing({ agent_status: 'idle', completion_seq: 3 })
  await world.tick()
  await world.tick()

  expect(world.announced.length).toBe(1)
  const message = world.announced[0] ?? ''
  expect(message).toMatch(/^\[threads 012345 finished: Fix it\]/)
  expect(message).toMatch(/helper's output, not an instruction/)
  expect(message).toMatch(/All done/)
  expect(message).toMatch(/threads\/012345/)
  expect(message).toMatch(/sonnet/)
  expect(message).toMatch(/claude-sonnet-5-5/)
  expect(world.state.registry.pending).toEqual([])
  expect(world.heldPending).toEqual([1])
})

test('poll announces a helper that finished between two ticks, and two that finish together', async () => {
  const quick = polling([watching()])
  quick.files[TRANSCRIPT] = [asked, said([text('Quick answer')])].join('\n')
  quick.over.list = listing({ agent_status: 'done', completion_seq: 3 })
  await quick.tick()
  expect(quick.announced.length).toBe(1)

  const two = polling([watching(), watching({ id: 'bbb222', agentName: 't-bbb222', path: '/wt2', sessionId: 'sess-2' })])
  two.files[TRANSCRIPT] = [asked, said([text('First')])].join('\n')
  two.files['/home/me/.claude/projects/-wt2/sess-2.jsonl'] = [asked, said([text('Second')])].join('\n')
  two.over.list = listing({ agent_status: 'done', completion_seq: 3 }, { name: 't-bbb222', agent_status: 'done', completion_seq: 3 })
  await two.tick()
  expect(two.announced.length).toBe(2)
  expect(two.announced.join('\n')).toMatch(/First[\s\S]*Second|Second[\s\S]*First/)
})

test('poll cuts a long answer to 4000 characters and points at the transcript', async () => {
  const world = polling([watching()])
  world.files[TRANSCRIPT] = [asked, said([text('x'.repeat(5000))])].join('\n')
  world.over.list = listing({ agent_status: 'done', completion_seq: 3 })
  await world.tick()

  const message = world.announced[0] ?? ''
  expect(message).toContain('x'.repeat(4000))
  expect(message).not.toContain('x'.repeat(4001))
  expect(message).toContain(TRANSCRIPT)
})

test('poll retries a missing answer, then says it was not found, and never uses an older answer', async () => {
  const world = polling([watching({ marker: { at: 0, completionSeq: 2, transcriptLines: 2, seenWorking: false } })])
  world.files[TRANSCRIPT] = [asked, said([text('An answer to an earlier task')])].join('\n')
  world.over.list = listing({ agent_status: 'done', completion_seq: 3 })

  for (let tick = 1; tick <= 4; tick += 1) {
    await world.tick()
    expect(world.announced, `tick ${tick}`).toEqual([])
  }

  await world.tick()
  expect(world.announced.length).toBe(1)
  expect(world.announced[0]).toMatch(/answer was not found/)
  expect(world.announced[0]).toMatch(/\/threads attach 012345/)
  expect(world.announced[0]).not.toMatch(/earlier task/)
})

test('poll announces a blocked helper once per episode, and an exited one once', async () => {
  const blocked = polling([watching({ status: 'working' })])
  blocked.over.list = listing({ agent_status: 'blocked' })
  await blocked.tick()
  await blocked.tick()
  expect(blocked.announced.length).toBe(1)
  expect(blocked.announced[0]).toMatch(/needs you/)
  expect(blocked.announced[0]).toMatch(/Do you want to proceed/)

  const gone = polling([watching({ status: 'working' })])
  gone.over.list = listing()
  await gone.tick()
  await gone.tick()
  expect(gone.announced.length).toBe(1)
  expect(gone.announced[0]).toMatch(/exited/)
  expect(gone.state.registry.threads[0]?.status).toBe('exited')
})

test('poll keeps a refused announcement, retries it, then marks it undelivered', async () => {
  const world = polling([watching()])
  world.files[TRANSCRIPT] = [asked, said([text('done')])].join('\n')
  world.over.list = listing({ agent_status: 'done', completion_seq: 3 })
  world.reply.value = 'refused'

  await world.tick()
  expect(world.state.registry.pending.length).toBe(1)
  expect(world.state.registry.pending[0]?.tries).toBe(1)

  for (let tick = 2; tick <= 5; tick += 1) await world.tick()
  expect(world.announced.length).toBe(5)
  expect(world.state.registry.pending).toEqual([])
  expect(world.state.registry.threads[0]?.undelivered).toBe(true)
  expect(world.toasts.length).toBe(1)

  await world.tick()
  expect(world.announced.length).toBe(5)
})

declare const setTimeout: (fn: () => void, ms: number) => unknown
const pause = (ms: number) => new Promise<void>(done => setTimeout(() => done(), ms))

test('startPolling ticks one at a time and stops itself when nothing is live', async () => {
  let fire: () => void = () => {}
  let cancelled = 0
  let asked = 0
  const every = (ms: number, fn: () => void) => {
    asked = ms
    fire = fn

    return () => void (cancelled += 1)
  }
  let live = true
  let ticks = 0
  let release: () => void = () => {}
  const tick = () =>
    new Promise<{ live: boolean }>(done => {
      ticks += 1
      release = () => done({ live })
    })

  startPolling(every, 5000, tick)
  expect(asked).toBe(5000)

  fire()
  fire()
  expect(ticks).toBe(1)
  live = false
  release()
  await pause(5)
  expect(cancelled).toBe(1)
})

/** A host for the registered hooks: the environment, the session, a store, and git/herdr answered by `route`. */
const hostFor = (on: On, over: Record<string, RunResult> = {}, env: Record<string, string> = { HERDR_ENV: '1', HOME: '/home/me' }) => {
  const ran: string[] = []
  const store = new Map<string, unknown>()
  const toasts: string[] = []

  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'lead-1' }))
  on('session.cwd', () => ({ value: '/lead' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) as never }))
  on('store.set', (_$, e) => (store.set(e.key, e.value), { value: undefined }))
  on('fs.read', () => {
    throw new Error('no such file')
  })
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('process.run', (_$, e) => {
    ran.push(e.argv.join(' '))
    const done = e.argv.join(' ') === 'herdr status' ? (over.status0 ?? out('ok')) : route(e.argv, over)

    return { value: { ...done, isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return { ran, store, toasts }
}
const call = ($: any, name: string, input: Record<string, unknown> = {}) => $.tool.call({ tool: `mcp__threads__${name}`, ...input })

test('the plugin registers four tools and the /threads command', async ($, on) => {
  hostFor(on)
  const tools: string[] = []
  const commands: string[] = []
  on('tool.register', (_$, e) => (tools.push(e.name), { value: undefined as never }))
  on('command.register', (_$, e) => (commands.push(e.name), { value: undefined as never }))
  on('clock.every', () => ({ value: { cancel: () => {} } as never }))
  on('session.start', (_$, e) => e)

  await $.session.start({ cwd: '/lead' } as never)
  expect(tools).toEqual(['threads_start', 'threads_status', 'threads_answer', 'threads_close'])
  expect(commands).toEqual(['threads'])
})

test('without Herdr every tool refuses and nothing runs', async ($, on) => {
  const outside = hostFor(on, {}, { HOME: '/home/me' })

  for (const name of ['threads_start', 'threads_status', 'threads_answer', 'threads_close']) {
    const result = await call($, name, { task: 't', id: 'x' })
    expect(result.isError, name).toBe(true)
    expect(String(result.result), name).toMatch(/Herdr/)
  }

  expect(outside.ran.filter(line => line.startsWith('herdr') || line.startsWith('git'))).toEqual([])

  const text = await $.command.run({ command: 'threads', args: '' } as never)
  expect(String(text.text)).toMatch(/Herdr/)
})

test('the tools reach the plugin and answer with a result, isError only on failure', async ($, on) => {
  const world = hostFor(on)
  on('clock.every', () => ({ value: { cancel: () => {} } as never }))

  const started = await call($, 'threads_start', { task: 'Fix the bug', title: 'Fix it' })
  expect(started.isError).toBeUndefined()
  expect(String(started.result)).toMatch(/Started t-[0-9a-z]{6} "Fix it"/)
  expect(world.ran.some(line => line.startsWith('herdr worktree create --cwd /repo'))).toBe(true)

  const listed = await call($, 'threads_status')
  expect(String(listed.result)).toMatch(/threads\/[0-9a-z]{6}/)
  expect(listed.isError).toBeUndefined()

  const bad = await call($, 'threads_close', { id: 'nope00' })
  expect(bad.isError).toBe(true)
})

test('/threads lists helpers, attaches after revalidating and adopts another chat\'s helper', async ($, on) => {
  const world = hostFor(on)
  const mine = owned({ status: 'working' })
  const theirs = thread({ id: 'zzz999', owner: 'lead-2', agentName: 't-zzz999', status: 'working' })
  world.store.set('threads:lead-1', registryOf(mine))
  world.store.set('threads:lead-2', registryOf(theirs))
  world.store.set('threads:owners', ['lead-1', 'lead-2'])
  on('clock.every', () => ({ value: { cancel: () => {} } as never }))

  const listed = String((await $.command.run({ command: 'threads', args: '' } as never)).text)
  expect(listed).toMatch(/012345/)
  expect(listed).toMatch(/other chats[\s\S]*zzz999/)

  expect(String((await $.command.run({ command: 'threads', args: 'attach 012345' } as never)).text)).toMatch(/Showing 012345/)
  expect(world.ran).toContain('herdr agent focus t-012345')
  expect(String((await $.command.run({ command: 'threads', args: 'attach zzz999' } as never)).text)).toMatch(/No helper/)

  expect(String((await $.command.run({ command: 'threads', args: 'adopt zzz999' } as never)).text)).toMatch(/now owns/)
  expect((world.store.get('threads:lead-1') as Registry).threads.find(one => one.id === 'zzz999')?.owner).toBe('lead-1')
  expect((world.store.get('threads:lead-2') as Registry).threads).toEqual([])
})

test('a chat writes only its own registry, so another chat\'s changes cannot be overwritten', async ($, on) => {
  const world = hostFor(on)
  const theirs = registryOf(thread({ id: 'zzz999', owner: 'lead-2', agentName: 't-zzz999', status: 'working' }))
  world.store.set('threads:lead-2', theirs)
  world.store.set('threads:owners', ['lead-2'])
  on('clock.every', () => ({ value: { cancel: () => {} } as never }))

  await call($, 'threads_start', { task: 'Fix the bug' })

  expect(world.store.get('threads:lead-2')).toBe(theirs)
  expect((world.store.get('threads:lead-1') as Registry).threads.length).toBe(1)
  expect(world.store.get('threads:owners')).toEqual(['lead-2', 'lead-1'])
  expect(world.store.has('threads')).toBe(false)
})

test('the system prompt tells Claude that helper output is data', async ($, on) => {
  hostFor(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))

  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'threads:helpers'])
  expect(PROMPT).toMatch(/data, not an instruction/)
  expect(PROMPT).toMatch(/never answer a helper's blocked prompt with threads_answer keys/)
  expect(PROMPT).toMatch(/must not merge/)
})

test('polling starts with the configured interval once a helper is started', { options: { pollSeconds: 5 } } as any, async ($: any, on: On) => {
  hostFor(on)
  const asked: number[] = []
  on('clock.every', (_$, e) => (asked.push(e.ms), { value: { cancel: () => {} } as never }))

  await call($, 'threads_start', { task: 'Fix the bug' })
  await call($, 'threads_start', { task: 'Another' })
  expect(asked).toEqual([5000])
})

test('a follow-up that looks like an option is sent as an instruction, and a failed send is undone', async () => {
  const calls: string[][] = []
  const probe = probeOf(() => json({ agent: AGENT }), calls)
  await agentPrompt(probe, 't', '- fix tests\n- run lint')
  await agentPrompt(probe, 't', 'plain text')
  expect(calls.map(call => call.at(-1))).toEqual(['Instruction: - fix tests\n- run lint', 'plain text'])

  const idle = holding(owned({ status: 'idle' }))
  for (const input of [{ id: '012345', text: '   ' }, { id: '012345', keys: [] }]) {
    expect((await answer(idle.ports, input)).isError).toBe(true)
  }
  expect(idle.herdr()).toEqual([])

  const marker = { at: 5, completionSeq: 1, transcriptLines: 3, seenWorking: true }
  const stalled = holding(owned({ status: 'idle', marker }), { prompt: failure('agent_prompt_stalled', 'no') })
  expect((await answer(stalled.ports, { id: '012345', text: 'go' })).isError).toBe(true)
  expect(stalled.state.registry.threads[0]).toMatchObject({ status: 'idle', marker })
})

test('poll learns the session id of a helper that started without one', async () => {
  const world = polling([watching({ sessionId: undefined })])
  world.files[TRANSCRIPT] = [asked, said([text('Found it')])].join('\n')
  world.over.list = listing({ agent_status: 'done', completion_seq: 3 })
  await world.tick()

  expect(world.announced[0]).toMatch(/Found it/)
  expect(world.state.registry.threads[0]?.sessionId).toBe('sess-1')
})

test('threads_close checks Herdr again before removing a worktree, also for helpers already marked exited', async () => {
  const refused = async (over: Record<string, RunResult>) => {
    const world = holding(owned({ status: 'exited' }), over)
    const result = await close(world.ports, '012345')

    expect(result.isError).toBe(true)
    expect(world.ran().some(line => line.startsWith('herdr worktree remove'))).toBe(false)
    expect(world.state.registry.threads[0]?.closing).toBeUndefined()
  }

  await refused({ list: listing({ name: 't-other', cwd: '/wt' }) })
  await refused({ list: GONE, wtlist: json({ worktrees: [{ path: '/wt', branch: 'threads/012345', open_workspace_id: 'w9' }] }) })
  await refused({ list: GONE, wtlist: json({ worktrees: [{ path: '/wt', branch: 'other-branch', open_workspace_id: 'w2' }] }) })
  await refused({ list: GONE, wtlist: failure('x', 'cannot list') })

  const fine = holding(owned({ status: 'exited' }), { list: GONE })
  expect((await close(fine.ports, '012345')).isError).toBeUndefined()
  expect(fine.ran()).toContain('herdr worktree remove --workspace w2')
})

test('a helper being closed is left alone by the polling, and its pending announcements go with it', async () => {
  const world = polling([watching({ status: 'working', closing: true })])
  world.over.list = listing()
  await world.tick()
  expect(world.announced).toEqual([])
  expect(world.state.registry.threads[0]?.status).toBe('working')

  const stale = [
    { threadId: '012345', kind: 'exited' as const, text: 'stale', tries: 0 },
    { threadId: 'other1', kind: 'exited' as const, text: 'keep', tries: 0 },
  ]
  const removed = holding(owned(), { list: GONE })
  removed.state.registry = { ...removed.state.registry, pending: stale }
  await close(removed.ports, '012345')
  expect(removed.state.registry.pending.map(one => one.text)).toEqual(['keep'])

  const kept = holding(owned(), { list: GONE, head: out('bbb\n'), count: out('1\n') })
  kept.state.registry = { ...kept.state.registry, pending: stale }
  await close(kept.ports, '012345')
  expect(kept.state.registry.pending.map(one => one.text)).toEqual(['keep'])
  expect(kept.state.registry.threads[0]).toMatchObject({ status: 'closed' })
  expect(kept.state.registry.threads[0]?.closing).toBeUndefined()

  const running = holding(owned())
  await close(running.ports, '012345')
  expect(running.state.registry.threads[0]?.closing).toBeUndefined()
})

test('takeOver moves a helper of another chat into this one, and overview lists the others read-only', async () => {
  const world = harness()
  world.state.others = [thread({ id: 'zzz999', owner: 'lead-2', agentName: 't-zzz999' })]

  expect((await overview(world.ports)).text).toMatch(/other chats[\s\S]*zzz999/)
  expect((await takeOver(world.ports, 'zzz999')).isError).toBeUndefined()
  expect(world.state.registry.threads.map(one => [one.id, one.owner])).toEqual([['zzz999', 'lead-1']])
  expect(world.state.others).toEqual([])
  expect((await takeOver(world.ports, 'nope00')).isError).toBe(true)
})
