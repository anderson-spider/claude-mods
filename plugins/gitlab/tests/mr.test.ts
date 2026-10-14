import { expect, test } from 'claude-code/testing'
import { mr, summary, withDraft } from '../hooks/mr'
import { MR, fakeCtx } from './fake-api'

const OPEN_FOR_BRANCH = 'GET /merge_requests'

test('without iid every action works on the open MR of the current branch', async () => {
  const { ctx, calls } = fakeCtx({ [OPEN_FOR_BRANCH]: [MR], 'GET /merge_requests/7': MR })

  const out = JSON.parse(await mr(ctx, { action: 'get' }))

  expect(calls[0]).toEqual({ method: 'GET', path: '/merge_requests', query: { state: 'opened', source_branch: 'feature/x', per_page: 20 } })
  expect(out.iid).toBe(7)
  expect(out.description).toBe('Body')
  expect(out.pipeline).toEqual({ id: 90, status: 'failed' })
})

test('without iid a fork MR of the same branch is ignored, and two MRs of the branch are refused, not guessed', async () => {
  const fork = { ...MR, iid: 8, project_id: 1, source_project_id: 99 }
  const own = { ...MR, project_id: 1, source_project_id: 1 }
  const single = fakeCtx({ [OPEN_FOR_BRANCH]: [fork, own], 'GET /merge_requests/7': MR })
  expect(JSON.parse(await mr(single.ctx, { action: 'get' })).iid).toBe(7)

  const two = fakeCtx({ [OPEN_FOR_BRANCH]: [own, { ...own, iid: 9, target_branch: 'release' }] })
  await expect(mr(two.ctx, { action: 'approve' })).rejects.toThrow('Open merge requests !7, !9 all have feature/x as their source branch. Pass iid.')
  expect(two.calls.map((c) => c.method)).toEqual(['GET'])
})

test('without iid and without an open MR for the branch the call says to pass iid', async () => {
  const { ctx } = fakeCtx({ [OPEN_FOR_BRANCH]: [] })
  await expect(mr(ctx, { action: 'get' })).rejects.toThrow('No open merge request has feature/x as its source branch. Pass iid.')
  const detached = fakeCtx({}, null)
  await expect(mr(detached.ctx, { action: 'diff' })).rejects.toThrow(/detached HEAD/)
})

test('an iid that is not a positive integer is refused before any call', async () => {
  const { ctx, calls } = fakeCtx({})
  for (const iid of [0, -1, 1.5, 'x', '7/../../x']) await expect(mr(ctx, { action: 'get', iid })).rejects.toThrow('iid must be a positive integer.')
  expect(calls).toEqual([])
})

test('summary keeps the readable fields only, and the description only for get', () => {
  const short = summary(MR as never)
  expect(Object.keys(short)).not.toContain('description')
  expect(short).toMatchObject({ source: 'feature/x', target: 'main', author: 'ann', assignees: ['bob'], mergeStatus: 'mergeable' })
  expect(summary(MR as never, true).description).toBe('Body')
})

test('create defaults the source to the current branch and the target to the default branch, and resolves users', async () => {
  const { ctx, calls } = fakeCtx({
    'GET ': { default_branch: 'develop' },
    'GET ROOT/user': { id: 1 },
    'GET ROOT/users': (c) => (c.query?.username === 'bob' ? [{ id: 2 }] : []),
    'POST /merge_requests': MR,
  })

  await mr(ctx, { action: 'create', title: 'Add things', labels: ['feature', 'ci'], assignees: ['@me'], reviewers: ['bob'], draft: true })

  expect(calls.at(-1)).toEqual({
    method: 'POST',
    path: '/merge_requests',
    body: {
      target_branch: 'develop',
      labels: 'feature,ci',
      assignee_ids: [1],
      reviewer_ids: [2],
      source_branch: 'feature/x',
      title: 'Draft: Add things',
    },
  })
})

test('create refuses a missing title and an unknown user', async () => {
  const { ctx } = fakeCtx({ 'GET ROOT/users': [] })
  await expect(mr(ctx, { action: 'create' })).rejects.toThrow('create needs a title.')
  await expect(mr(ctx, { action: 'create', title: 't', targetBranch: 'main', assignees: ['ghost'] })).rejects.toThrow('No GitLab user named ghost on this host.')
})

test('update sends only what changed and toggles draft on the current title', async () => {
  const { ctx, calls } = fakeCtx({ 'GET /merge_requests/7': { ...MR, title: 'Draft: Add things' }, 'PUT /merge_requests/7': MR })

  await mr(ctx, { action: 'update', iid: 7, draft: false, addLabels: ['bug'], stateEvent: 'reopen' })

  expect(calls.at(-1)).toEqual({ method: 'PUT', path: '/merge_requests/7', body: { add_labels: 'bug', state_event: 'reopen', title: 'Add things' } })
  await expect(mr(ctx, { action: 'update', iid: 7 })).rejects.toThrow('update was given nothing to change.')
  await expect(mr(ctx, { action: 'update', iid: 7, stateEvent: 'merge' })).rejects.toThrow('stateEvent must be close or reopen.')
})

test('withDraft replaces any draft prefix GitLab knows', () => {
  expect(withDraft('[Draft] x', true)).toBe('Draft: x')
  expect(withDraft('WIP: x', false)).toBe('x')
  expect(withDraft('x', undefined)).toBe('x')
})

test('diff lists each file with its header and filters by path', async () => {
  const { ctx } = fakeCtx({
    'GET /merge_requests/7/diffs': [
      { old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { old_path: 'old.md', new_path: 'new.md', diff: '', renamed_file: true },
    ],
  })

  const text = await mr(ctx, { action: 'diff', iid: 7, files: ['new'] })

  expect(text).toBe('MR !7: 1 of 2 files\n=== old.md → new.md\n')
})

test('approve, unapprove and rebase call their endpoints, and merge is not an action', async () => {
  const { ctx, calls } = fakeCtx({ 'POST /merge_requests/7/approve': {}, 'POST /merge_requests/7/unapprove': {}, 'PUT /merge_requests/7/rebase': {} })
  expect(await mr(ctx, { action: 'approve', iid: 7 })).toBe('MR !7 approved.')
  expect(await mr(ctx, { action: 'unapprove', iid: 7 })).toBe('MR !7 unapproved.')
  await mr(ctx, { action: 'rebase', iid: 7 })
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /merge_requests/7/approve', 'POST /merge_requests/7/unapprove', 'PUT /merge_requests/7/rebase'])
  await expect(mr(ctx, { action: 'merge', iid: 7 })).rejects.toThrow('Unknown action: merge.')
})

test('diff falls back to /changes on a GitLab older than /diffs', async () => {
  const { ctx } = fakeCtx({ 'GET /merge_requests/7/changes': { changes: [{ old_path: 'a', new_path: 'a', diff: '+x\n', new_file: true }] } })
  expect(await mr(ctx, { action: 'diff', iid: 7 })).toBe('MR !7: 1 of 1 files\n=== a (new)\n+x\n')
})

test('diff says when GitLab omitted a file for being too large or collapsed instead of showing it blank', async () => {
  const { ctx } = fakeCtx({
    'GET /merge_requests/7/diffs': [
      { old_path: 'big.json', new_path: 'big.json', diff: '', too_large: true },
      { old_path: 'gen.ts', new_path: 'gen.ts', diff: '', collapsed: true },
    ],
  })
  const text = await mr(ctx, { action: 'diff', iid: 7 })
  expect(text).toContain('=== big.json\n(diff omitted by GitLab: too large; open the MR in the browser)')
  expect(text).toContain('=== gen.ts\n(diff omitted by GitLab: collapsed; open the MR in the browser)')
})
