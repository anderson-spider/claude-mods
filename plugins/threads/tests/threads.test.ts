import { expect, test } from 'claude-code/testing'

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
import { claudeAnswerAfter, claudeTranscriptPath, lineCount } from '../hooks/transcript'
import { branchFor, classify, currentCommit, repoParent } from '../hooks/worktree'
import { SETTLE_MS, adopt, advance, capError, emptyRegistry, liveOf, newId, reconcile } from '../hooks/registry'
import type { Registry, Thread } from '../hooks/registry'
import { readSettings } from '../hooks/settings'

const out = (stdout: string, exitCode = 0, stderr = ''): RunResult => ({ exitCode, stdout, stderr })
const json = (result: unknown) => out(JSON.stringify({ id: 'x', result }))
const failure = (code: string, message: string) => out(JSON.stringify({ error: { code, message }, id: 'x' }), 1)

/** A host that records argv and answers with `reply`. */
const probeOf = (reply: (argv: readonly string[]) => RunResult, calls: string[][] = []): Probe => ({
  run: async argv => {
    calls.push([...argv])

    return reply(argv)
  },
  read: async () => undefined,
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
  'git status --porcelain --ignored': out(''),
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
  expect(await classify(gitProbe({ ...ahead, 'git status --porcelain --ignored': out(' M a.ts\n') }), WORKTREE)).toEqual({ kind: 'commits', commits: 2, dirty: true })

  for (const line of [' M a.ts\n', '?? notes.txt\n', '!! dist/\n']) {
    expect(await classify(gitProbe({ ...CLEAN, 'git status --porcelain --ignored': out(line) }), WORKTREE)).toEqual({ kind: 'dirty' })
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

  const reason = await classify(gitProbe({ ...CLEAN, 'git status --porcelain --ignored': out('', 128, 'fatal: not a repo') }), WORKTREE)
  expect(reason.kind === 'unknown' && reason.reason).toMatch(/git status/)
})

const said = (blocks: unknown[], model = 'claude-sonnet-5-5') => JSON.stringify({ type: 'assistant', message: { model, content: blocks } })
const text = (value: string) => ({ type: 'text', text: value })
const tool = { type: 'tool_use', name: 'Bash', input: {} }
const asked = JSON.stringify({ type: 'user', message: { content: 'go' } })

test('claudeTranscriptPath turns the cwd into the project folder name', () => {
  expect(claudeTranscriptPath('/home/me', '/Users/a/.herdr/worktrees/x/y', 'sid')).toBe('/home/me/.claude/projects/-Users-a--herdr-worktrees-x-y/sid.jsonl')
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

test('claudeAnswerAfter skips tool-only messages and corrupt lines, and finds nothing when only tools ran', () => {
  const log = [asked, said([text('working on it')]), 'not json {', said([tool])].join('\n')

  expect(claudeAnswerAfter(log, 0)).toEqual({ text: 'working on it', model: 'claude-sonnet-5-5' })
  expect(claudeAnswerAfter([asked, said([tool])].join('\n'), 1)).toBeUndefined()
  expect(claudeAnswerAfter([asked, said([text('old')]), asked, said([tool])].join('\n'), 2)).toBeUndefined()
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

test('adopt moves a helper to another owner and refuses an unknown id', () => {
  const reg = registryOf(thread())

  expect(adopt(reg, 'abc123', 'lead-2')?.threads[0]?.owner).toBe('lead-2')
  expect(reg.threads[0]?.owner).toBe('lead-1')
  expect(adopt(reg, 'nope', 'lead-2')).toBeUndefined()
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
