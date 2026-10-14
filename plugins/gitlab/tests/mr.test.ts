import { expect, test } from 'claude-code/testing'
import { mr, statusView, summary, withDraft } from '../hooks/mr'
import { ME, MR, THEIRS, fakeCtx, paged } from './fake-api'

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
  await expect(mr(ctx, { action: 'get' })).rejects.toThrow('No open merge request has feature/x as its source branch. Pass iid, or open one with gitlab_mr create.')
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
    'GET /labels': (c) => [{ id: 1, name: String(c.query?.search) }],
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
      assignee_ids: [ME.id],
      reviewer_ids: [2],
      source_branch: 'feature/x',
      title: 'Draft: Add things',
    },
  })
})

test('create refuses a missing title and an unknown user', async () => {
  const { ctx } = fakeCtx({ 'GET ROOT/users': [] })
  await expect(mr(ctx, { action: 'create' })).rejects.toThrow('create needs a title.')
  await expect(mr(fakeCtx({}, 'x', true).ctx, { action: 'create', title: 't' })).rejects.toThrow('create needs sourceBranch when project names another project.')
  await expect(mr(ctx, { action: 'create', title: 't', targetBranch: 'main', assignees: ['ghost'] })).rejects.toThrow('No GitLab user named ghost on this host.')
})

test('update sends only what changed and toggles draft on the current title', async () => {
  const { ctx, calls } = fakeCtx({
    'GET /merge_requests/7': { ...MR, title: 'Draft: Add things' },
    'GET /labels': [{ id: 3, name: 'bug' }],
    'PUT /merge_requests/7': MR,
  })

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

test('diff and commits read the page asked for and say when there are more', async () => {
  const { ctx, calls } = fakeCtx({
    'GET /merge_requests/7/diffs': paged([{ old_path: 'a.ts', new_path: 'a.ts', diff: '+x\n' }], 3),
    'GET /merge_requests/7/commits': paged([{ short_id: 'abc', title: 'one', author_name: 'Ann' }], 2),
  })
  expect((await mr(ctx, { action: 'diff', iid: 7, page: 2 })).split('\n')[0]).toBe('MR !7: 1 of 1 files (more files: pass page 3)')
  expect(JSON.parse(await mr(ctx, { action: 'commits', iid: 7 }))).toEqual({ commits: [{ sha: 'abc', title: 'one', author: 'Ann' }], next: 2 })
  expect(calls.map((c) => c.query)).toEqual([
    { per_page: 100, page: 2 },
    { per_page: 100, page: 1 },
  ])
})

test('approve, unapprove and rebase call their endpoints on your own MR', async () => {
  const { ctx, writes } = fakeCtx({ 'GET /merge_requests/7': MR, 'POST /merge_requests/7/approve': {}, 'POST /merge_requests/7/unapprove': {}, 'PUT /merge_requests/7/rebase': {} })
  expect(await mr(ctx, { action: 'approve', iid: 7 })).toBe('MR !7 approved.')
  expect(await mr(ctx, { action: 'unapprove', iid: 7 })).toBe('MR !7 unapproved.')
  await mr(ctx, { action: 'rebase', iid: 7 })
  expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual(['POST /merge_requests/7/approve', 'POST /merge_requests/7/unapprove', 'PUT /merge_requests/7/rebase'])
  await expect(mr(ctx, { action: 'delete', iid: 7 })).rejects.toThrow('Unknown action: delete.')
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

test('list filters by people, labels, search and scope, resolves @me, and says when there is a next page', async () => {
  const { ctx, calls } = fakeCtx({ 'GET /merge_requests': paged([MR], 2) })

  const out = JSON.parse(await mr(ctx, { action: 'list', author: '@me', assignee: 'bob', reviewer: 'cid', labels: ['bug', 'fix-train'], search: 'login', scope: 'all', perPage: 50 }))

  expect(out.next).toBe(2)
  expect(out.mergeRequests[0]).toMatchObject({ iid: 7, author: 'ann' })
  expect(out.mergeRequests[0].ref).toBeUndefined()
  expect(calls.at(-1)).toEqual({
    method: 'GET',
    path: '/merge_requests',
    query: {
      state: 'opened',
      scope: 'all',
      author_username: 'ann',
      assignee_username: 'bob',
      reviewer_username: 'cid',
      labels: 'bug,fix-train',
      search: 'login',
      order_by: 'updated_at',
      per_page: 50,
      page: 1,
    },
  })
  await expect(mr(ctx, { action: 'list', scope: 'mine' })).rejects.toThrow('scope must be created_by_me, assigned_to_me or all.')
  await expect(mr(ctx, { action: 'list', perPage: 500 })).rejects.toThrow('perPage is at most 100.')
})

test('list with allProjects reads the global endpoint, names each project, and widens the scope for a people filter', async () => {
  const { ctx, calls } = fakeCtx({ 'GET ROOT/merge_requests': [{ ...MR, references: { full: 'luizalabs/app!7' } }] })

  const mine = JSON.parse(await mr(ctx, { action: 'list', allProjects: true }))
  await mr(ctx, { action: 'list', allProjects: true, reviewer: '@me' })

  expect(mine).toEqual({ mergeRequests: [expect.objectContaining({ iid: 7, ref: 'luizalabs/app!7' })] })
  expect(calls[0]?.query?.scope).toBeUndefined()
  expect(calls.at(-1)?.query).toMatchObject({ scope: 'all', reviewer_username: 'ann' })
  expect(calls.every((c) => c.path.startsWith('ROOT'))).toBe(true)
})

test('status reports the merge state, the head pipeline against the head sha, approvals, rules and the blockers', async () => {
  const { ctx } = fakeCtx({
    'GET /merge_requests/7': { ...MR, head_pipeline: { ...MR.head_pipeline, status: 'success', sha: 'b'.repeat(40) }, blocking_discussions_resolved: false },
    'GET /merge_requests/7/approvals': { approved: false, approvals_left: 1, approved_by: [{ user: { username: 'cid' } }] },
    'GET /merge_requests/7/approval_state': { rules: [{ name: 'Code owners', approved: false, approvals_required: 2, approved_by: [{ username: 'cid' }] }] },
  })

  const out = JSON.parse(await mr(ctx, { action: 'status', iid: 7 }))

  expect(out).toMatchObject({
    iid: 7,
    source: 'feature/x',
    target: 'main',
    sha: MR.sha,
    author: 'ann',
    assignees: ['bob'],
    labels: ['feature'],
    mergeStatus: 'mergeable',
    conflicts: false,
    discussionsResolved: false,
    draft: false,
    pipeline: { id: 90, status: 'success', url: MR.head_pipeline.web_url, sha: 'b'.repeat(40), current: false },
    approvals: { approved: false, left: 1, by: ['cid'] },
    rules: [{ name: 'Code owners', approved: false, required: 2, by: ['cid'] }],
    blockers: ['unresolved blocking discussions', '1 approvals missing'],
    url: MR.web_url,
  })
})

test('status leaves out approvals GitLab withholds (a free tier) and blocks on a pipeline only when the merge status says so', async () => {
  const { ctx } = fakeCtx({ 'GET /merge_requests/7': { ...MR, head_pipeline: null } })
  const out = JSON.parse(await mr(ctx, { action: 'status', iid: 7 }))
  expect(out.approvals).toBeUndefined()
  expect(out.rules).toBeUndefined()
  expect(out.pipeline).toBeNull()
  expect(out.blockers).toEqual([])
  expect(statusView({ ...MR, detailed_merge_status: 'ci_must_pass' } as never, undefined, undefined).blockers).toEqual(['merge status ci_must_pass'])
  expect(statusView({ ...MR, head_pipeline: { id: 1, status: 'success', sha: MR.sha } } as never, { approvals_left: 0 }, undefined).blockers).toEqual([])
})

const SHA = MR.sha
const merged = { ...MR, state: 'merged' }

test('merge sends the head sha and the chosen options for your own MR into main', async () => {
  const { ctx, writes } = fakeCtx({ 'GET /merge_requests/7': MR, 'PUT /merge_requests/7/merge': merged })

  const out = JSON.parse(await mr(ctx, { action: 'merge', iid: 7, sha: SHA.toUpperCase(), squash: true, removeSourceBranch: true, whenPipelineSucceeds: true }))

  expect(out.state).toBe('merged')
  expect(writes()).toEqual([
    { method: 'PUT', path: '/merge_requests/7/merge', body: { sha: SHA, squash: true, should_remove_source_branch: true, merge_when_pipeline_succeeds: true } },
  ])
})

test('merge needs an explicit iid and the full head sha, and refuses a head that moved', async () => {
  const { ctx, calls } = fakeCtx({ 'GET /merge_requests': [MR], 'GET /merge_requests/7': MR })
  await expect(mr(ctx, { action: 'merge', sha: SHA })).rejects.toThrow("merge needs iid: it never defaults to the current branch's MR.")
  await expect(mr(ctx, { action: 'merge', iid: 7 })).rejects.toThrow(/merge needs sha/)
  await expect(mr(ctx, { action: 'merge', iid: 7, sha: 'abc1234' })).rejects.toThrow('sha must be the full head commit sha from status.')
  expect(calls).toEqual([])
  await expect(mr(ctx, { action: 'merge', iid: 7, sha: 'c'.repeat(40) })).rejects.toThrow('The head of MR !7 is now aaaaaaaa, not cccccccc: read status again before merging.')
  expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
})

test("merge refuses someone else's MR without allowOthers and merges it with allowOthers", async () => {
  const { ctx, writes } = fakeCtx({ 'GET /merge_requests/7': THEIRS, 'PUT /merge_requests/7/merge': merged })
  await expect(mr(ctx, { action: 'merge', iid: 7, sha: SHA })).rejects.toThrow(/MR !7 is by bob, not by the token's user \(ann\)\. .*allowOthers: true/)
  expect(writes()).toEqual([])
  await mr(ctx, { action: 'merge', iid: 7, sha: SHA, allowOthers: true })
  expect(writes()).toHaveLength(1)
})

test('merge refuses a draft, conflicts, blocking discussions or a closed MR, whatever the allow flags', async () => {
  for (const [mrState, reason] of [
    [{ draft: true }, 'MR !7 cannot be merged: it is a draft.'],
    [{ has_conflicts: true, blocking_discussions_resolved: false }, 'MR !7 cannot be merged: it has conflicts, blocking discussions are unresolved.'],
    [{ state: 'closed' }, 'MR !7 is closed, not open.'],
  ] as const) {
    const { ctx, writes } = fakeCtx({ 'GET /merge_requests/7': { ...MR, ...mrState } })
    await expect(mr(ctx, { action: 'merge', iid: 7, sha: SHA, allowOthers: true, allowProtectedTarget: true })).rejects.toThrow(reason)
    expect(writes()).toEqual([])
  }
})

test('merge into a release or protected branch needs allowProtectedTarget; main, master, develop and unprotected targets do not', async () => {
  const branch = (name: string) => `GET /repository/branches/${encodeURIComponent(name)}`
  const routes = {
    'PUT /merge_requests/7/merge': merged,
    [branch('hotfix/x')]: { name: 'hotfix/x', protected: true },
    [branch('feature/base')]: { name: 'feature/base', protected: false },
  }
  const refused = (t: string) => `The target ${t} is a release or protected branch; merging into it needs allowProtectedTarget: true, only when the user asked for it.`

  for (const target of ['release', 'release/2026.10', 'hotfix/x']) {
    const { ctx, writes } = fakeCtx({ ...routes, 'GET /merge_requests/7': { ...MR, target_branch: target } })
    await expect(mr(ctx, { action: 'merge', iid: 7, sha: SHA })).rejects.toThrow(refused(target))
    expect(writes()).toEqual([])
    await mr(ctx, { action: 'merge', iid: 7, sha: SHA, allowProtectedTarget: true })
    expect(writes()).toHaveLength(1)
  }
  for (const target of ['main', 'master', 'develop', 'feature/base']) {
    const { ctx, writes } = fakeCtx({ ...routes, 'GET /merge_requests/7': { ...MR, target_branch: target } })
    await mr(ctx, { action: 'merge', iid: 7, sha: SHA })
    expect(writes(), target).toHaveLength(1)
  }
})

test('merge is refused when GitLab will not say whether the target is protected', async () => {
  const { ctx, writes } = fakeCtx({ 'GET /merge_requests/7': { ...MR, target_branch: 'staging' }, 'PUT /merge_requests/7/merge': merged })
  await expect(mr(ctx, { action: 'merge', iid: 7, sha: SHA })).rejects.toThrow(/^Could not tell whether staging is protected \(GitLab answered 404\), so the merge is refused\./)
  expect(writes()).toEqual([])
})

test("update, approve, unapprove and rebase on someone else's MR are refused without allowOthers", async () => {
  const { ctx, writes } = fakeCtx({ 'GET /merge_requests/7': THEIRS, 'POST /merge_requests/7/approve': {}, 'PUT /merge_requests/7': THEIRS })
  for (const action of ['update', 'approve', 'unapprove', 'rebase']) {
    await expect(mr(ctx, { action, iid: 7, title: 'x' }), action).rejects.toThrow(/allowOthers: true/)
  }
  expect(writes()).toEqual([])
  expect(await mr(ctx, { action: 'approve', iid: 7, allowOthers: true })).toBe('MR !7 approved.')
  await mr(ctx, { action: 'update', iid: 7, title: 'x', allowOthers: true })
  expect(writes().map((c) => c.path)).toEqual(['/merge_requests/7/approve', '/merge_requests/7'])
})

test('create and update refuse labels the project lacks, naming them, unless createMissingLabels creates them first', async () => {
  const { ctx, writes } = fakeCtx({
    'GET ': { default_branch: 'master' },
    'GET /labels': (c) => (c.query?.search === 'fix' ? [{ id: 1, name: 'fix' }, { id: 2, name: 'fix-train-old' }] : []),
    'POST /labels': (c) => ({ id: 9, name: c.body?.name, color: c.body?.color }),
    'POST /merge_requests': MR,
    'GET /merge_requests/7': MR,
    'PUT /merge_requests/7': MR,
  })

  await expect(mr(ctx, { action: 'create', title: 't', labels: ['fix', 'fix-train'] })).rejects.toThrow(
    'The project has no label fix-train. Pass createMissingLabels: true to create it, or create it with gitlab_label create.',
  )
  await expect(mr(ctx, { action: 'update', iid: 7, addLabels: ['a', 'b'] })).rejects.toThrow('The project has no label a, b.')
  expect(writes()).toEqual([])

  await mr(ctx, { action: 'create', title: 't', labels: ['fix', 'fix-train'], createMissingLabels: true })
  expect(writes().map((c) => [c.path, c.body?.name ?? c.body?.labels])).toEqual([
    ['/labels', 'fix-train'],
    ['/merge_requests', 'fix,fix-train'],
  ])
  expect(writes()[0]?.body).toEqual({ name: 'fix-train', color: '#428BCA' })
})

test('with project naming another project, an MR action needs iid instead of using the current branch', async () => {
  const { ctx, calls } = fakeCtx({}, 'feature/x', true)
  await expect(mr(ctx, { action: 'get' })).rejects.toThrow('Pass iid: project names another project, so the current branch is not used.')
  expect(calls).toEqual([])
})
