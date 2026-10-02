import { expect, test } from 'claude-code/testing'

import { foldGithub, foldGitlab, parseDiff, parseRemote, platformOf, readAll } from '../hooks/panel'
import type { Probe } from '../hooks/panel'

const ran = (stdout: string, exitCode = 0, stderr = '') => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  'diff --git a/b.md b/b.md',
  '--- a/b.md',
  '+++ b/b.md',
  '@@ -1 +1,2 @@',
  ' x',
  '+y',
  '',
].join('\n')

test('parseRemote reads scp, https and ssh spellings', () => {
  expect(parseRemote('git@github.com:anderson-spider/spider-marketplace.git')).toEqual({
    host: 'github.com',
    path: 'anderson-spider/spider-marketplace',
  })
  expect(parseRemote('https://gitlab.luizalabs.com/group/sub/repo.git\n')).toEqual({
    host: 'gitlab.luizalabs.com',
    path: 'group/sub/repo',
  })
  expect(parseRemote('ssh://git@gitlab.com:2222/a/b')).toEqual({ host: 'gitlab.com', path: 'a/b' })
  expect(parseRemote('not a remote')).toBeUndefined()
  expect(platformOf('github.com')).toBe('github')
  expect(platformOf('gitlab.luizalabs.com')).toBe('gitlab')
})

test('parseDiff counts changed lines per file and keeps the hunks', () => {
  const files = parseDiff(DIFF)

  expect(files.map(file => [file.path, file.added, file.removed])).toEqual([
    ['src/a.ts', 1, 1],
    ['b.md', 1, 0],
  ])
  expect(files[0].lines).toEqual(['@@ -1,2 +1,2 @@', ' keep', '-old', '+new'])
})

test('foldGithub maps checks, comments and merge state', () => {
  const pr = foldGithub(
    {
      number: 7,
      title: 'feat: x',
      url: 'https://github.com/o/r/pull/7',
      body: 'desc',
      state: 'OPEN',
      isDraft: true,
      headRefName: 'f',
      baseRefName: 'main',
      mergeable: 'CONFLICTING',
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
        { __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING' },
      ],
      comments: [{ author: { login: 'a' }, body: 'hi', createdAt: '2026-01-02T00:00:00Z' }],
      reviews: [
        { author: { login: 'b' }, body: '', state: 'COMMENTED', submittedAt: '2026-01-01T00:00:00Z' },
        { author: { login: 'c' }, body: '', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-03T00:00:00Z' },
      ],
    },
    [{ user: { login: 'd' }, path: 'src/a.ts', line: 4, body: 'nit', created_at: '2026-01-04T00:00:00Z' }],
  )

  expect(pr.state).toBe('open')
  expect(pr.isDraft).toBe(true)
  expect(pr.merge).toBe('conflicting')
  expect(pr.checks.map(check => check.status)).toEqual(['success', 'failure', 'running', 'pending'])
  // An empty COMMENTED review is noise; the rest come newest first.
  expect(pr.comments.map(comment => [comment.author, comment.anchor])).toEqual([
    ['d', 'src/a.ts:4'],
    ['c', 'review (changes requested)'],
    ['a', 'comment'],
  ])
})

test('foldGitlab skips system notes and maps jobs', () => {
  const pr = foldGitlab(
    {
      iid: 3,
      title: 't',
      web_url: 'u',
      description: 'd',
      state: 'opened',
      draft: false,
      source_branch: 's',
      target_branch: 'main',
      has_conflicts: false,
      detailed_merge_status: 'discussions_not_resolved',
    },
    [
      { notes: [{ system: true, body: 'added 1 commit', author: { username: 'x' }, created_at: '2026-01-01' }] },
      {
        notes: [
          {
            system: false,
            type: 'DiffNote',
            resolved: true,
            body: 'fix this',
            author: { username: 'rev' },
            created_at: '2026-01-02',
            position: { new_path: 'a.py', new_line: 9 },
          },
        ],
      },
      { notes: [{ system: false, type: null, body: 'ok', author: { username: 'me' }, created_at: '2026-01-03' }] },
    ],
    [
      { name: 'test', status: 'success' },
      { name: 'deploy', status: 'manual' },
      { name: 'flaky', status: 'failed', allow_failure: true },
      { name: 'build', status: 'failed' },
    ],
  )

  expect(pr.merge).toBe('blocked')
  expect(pr.comments.map(comment => [comment.author, comment.anchor, comment.isResolved])).toEqual([
    ['me', 'comment', false],
    ['rev', 'a.py:9', true],
  ])
  expect(pr.checks.map(check => check.status)).toEqual(['success', 'skipped', 'skipped', 'failure'])
})

const probeOf = (remote: string, branch: string, answers: Record<string, string>): Probe => ({
  run: async argv => {
    const line = argv.join(' ')

    if (line.includes('branch --show-current')) {
      return ran(`${branch}\n`)
    }

    if (line.includes('remote get-url')) {
      return ran(`${remote}\n`)
    }

    if (line.includes('diff HEAD')) {
      return ran(DIFF)
    }

    if (line.includes('ls-files')) {
      return ran('new.txt\n')
    }

    for (const [needle, out] of Object.entries(answers)) {
      if (line.includes(needle)) {
        return ran(out)
      }
    }

    return ran('', 1, 'no pull requests found for branch')
  },
})

test('readAll reads the diff, untracked files and a GitHub pull request', async () => {
  const found = await readAll(
    probeOf('git@github.com:o/r.git', 'f', {
      'pr view': JSON.stringify({ number: 5, title: 'T', state: 'OPEN' }),
      'repos/o/r/pulls/5/comments': '[]',
    }),
    '/proj',
  )

  expect(found.branch).toBe('f')
  expect(found.diff.map(file => file.path)).toEqual(['src/a.ts', 'b.md', 'new.txt'])
  expect(found.diff[2].isUntracked).toBe(true)
  expect(found.pr.kind).toBe('pr')
})

test('readAll says so when the branch has no pull request', async () => {
  const found = await readAll(probeOf('git@github.com:o/r.git', 'f', {}), '/proj')

  expect(found.pr).toEqual({ kind: 'none', message: 'No pull request for this branch.' })
})

test('readAll reads a GitLab merge request through glab api on the remote host', async () => {
  const calls: string[] = []
  const inner = probeOf('git@gitlab.luizalabs.com:g/p.git', 'f', {
    'merge_requests?source_branch=f': '[{"iid":9}]',
    'merge_requests/9/discussions': '[]',
    'merge_requests/9': JSON.stringify({ iid: 9, title: 'M', state: 'opened', head_pipeline: { id: 4 } }),
    'pipelines/4/jobs': '[{"name":"j","status":"success"}]',
  })
  const found = await readAll(
    {
      run: async (argv, init) => {
        calls.push(argv.join(' '))

        return inner.run(argv, init)
      },
    },
    '/proj',
  )

  expect(found.pr.kind).toBe('pr')
  expect(calls.some(call => call.startsWith('glab api --hostname gitlab.luizalabs.com projects/g%2Fp/'))).toBe(true)
  expect(calls.every(call => !call.includes(' -X '))).toBe(true)
})

test('readAll never rejects when a command throws', async () => {
  const found = await readAll(
    {
      run: async () => {
        throw new Error('boom')
      },
    },
    '/proj',
  )

  expect(found.diffError).toBe('boom')
  expect(found.pr).toEqual({ kind: 'error', message: 'boom' })
})
