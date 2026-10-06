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
import { branchFor, classify, currentCommit, repoParent } from '../hooks/worktree'
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
