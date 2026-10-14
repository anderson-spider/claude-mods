import { expect, test } from 'claude-code/testing'
import { comment, discussionView } from '../hooks/comments'
import { MR, THEIRS, fakeCtx, paged } from './fake-api'

const thread = (id: string, resolved: boolean) => ({
  id,
  notes: [
    { id: 1, body: 'Rename this', resolvable: true, resolved, author: { username: 'ann' }, position: { new_path: 'a.ts', new_line: 4, old_line: null } },
    { id: 2, body: 'Done', resolvable: true, resolved, author: { username: 'bob' } },
  ],
})

test('list shows each discussion with its place, authors and resolved state, without system notes', async () => {
  const { ctx } = fakeCtx({
    'GET /merge_requests/7/discussions': [thread('aa', false), thread('bb', true), { id: 'cc', notes: [{ id: 3, body: 'added 1 commit', system: true }] }],
  })

  const all = JSON.parse(await comment(ctx, { action: 'list', iid: 7 })).discussions
  const open = JSON.parse(await comment(ctx, { action: 'list', iid: 7, unresolvedOnly: true })).discussions

  expect(all.map((d: { id: string }) => d.id)).toEqual(['aa', 'bb'])
  expect(all[0]).toEqual({
    id: 'aa',
    resolved: false,
    at: { path: 'a.ts', line: 4 },
    notes: [
      { id: 1, author: 'ann', body: 'Rename this' },
      { id: 2, author: 'bob', body: 'Done' },
    ],
  })
  expect(open.map((d: { id: string }) => d.id)).toEqual(['aa'])
})

test('a general discussion has no place and no resolved state when it is not resolvable', () => {
  expect(discussionView({ id: 'dd', notes: [{ id: 4, body: 'hi' }] })).toEqual({ id: 'dd', notes: [{ id: 4, body: 'hi' }] })
})

test('list reads the page asked for and says when GitLab has more', async () => {
  const { ctx, calls } = fakeCtx({ 'GET /merge_requests/7/discussions': paged([thread('aa', false)], 3) })
  expect(JSON.parse(await comment(ctx, { action: 'list', iid: 7, page: 2, perPage: 50 })).next).toBe(3)
  expect(calls[0]?.query).toEqual({ per_page: 50, page: 2 })
  await expect(comment(ctx, { action: 'list', iid: 7, perPage: 101 })).rejects.toThrow('perPage is at most 100.')
})

test('comment, reply, edit, resolve and unresolve call their endpoints with the body', async () => {
  const { ctx, writes } = fakeCtx({
    'GET /merge_requests/7': MR,
    'POST /merge_requests/7/notes': { id: 10 },
    'POST /merge_requests/7/discussions/aa/notes': { id: 11 },
    'PUT /merge_requests/7/notes/11': {},
    'PUT /merge_requests/7/discussions/aa': {},
  })

  await comment(ctx, { action: 'comment', iid: 7, body: 'LGTM' })
  await comment(ctx, { action: 'reply', iid: 7, discussionId: 'aa', body: 'Fixed' })
  await comment(ctx, { action: 'edit', iid: 7, noteId: 11, body: 'Fixed in abc' })
  expect(await comment(ctx, { action: 'resolve', iid: 7, discussionId: 'aa' })).toBe('Discussion aa resolved.')
  await comment(ctx, { action: 'unresolve', iid: 7, discussionId: 'aa' })

  expect(writes().map((c) => [c.method, c.path, c.body])).toEqual([
    ['POST', '/merge_requests/7/notes', { body: 'LGTM' }],
    ['POST', '/merge_requests/7/discussions/aa/notes', { body: 'Fixed' }],
    ['PUT', '/merge_requests/7/notes/11', { body: 'Fixed in abc' }],
    ['PUT', '/merge_requests/7/discussions/aa', { resolved: true }],
    ['PUT', '/merge_requests/7/discussions/aa', { resolved: false }],
  ])
})

test('line comments on the diff at the MR head, with both paths of a renamed file and the new line, the old line or both', async () => {
  const { ctx, calls } = fakeCtx({
    'GET /merge_requests/7': MR,
    'GET /merge_requests/7/diffs': [{ old_path: 'src/old.ts', new_path: 'src/a.ts' }],
    'POST /merge_requests/7/discussions': (c) => ({ id: 'ee', notes: [{ id: 12, body: c.body?.body, position: c.body?.position }] }),
  })

  await comment(ctx, { action: 'line', iid: 7, path: 'src/a.ts', line: 12, oldLine: 10, body: 'Why?' })

  expect(calls.at(-1)?.body).toEqual({
    body: 'Why?',
    position: { position_type: 'text', base_sha: 'b', start_sha: 's', head_sha: 'h', new_path: 'src/a.ts', old_path: 'src/old.ts', new_line: 12, old_line: 10 },
  })
  await expect(comment(ctx, { action: 'line', iid: 7, path: 'a.ts', body: 'x' })).rejects.toThrow(/needs line/)
})

test('line finds a renamed file past the first page of the diff', async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ old_path: `f${i}.ts`, new_path: `f${i}.ts` }))
  const { ctx, calls } = fakeCtx({
    'GET /merge_requests/7': MR,
    'GET /merge_requests/7/diffs': (c) => (c.query?.page === 1 ? filler : [{ old_path: 'src/old.ts', new_path: 'src/a.ts' }]),
    'POST /merge_requests/7/discussions': { id: 'ee', notes: [{ id: 12, body: 'x' }] },
  })

  await comment(ctx, { action: 'line', iid: 7, path: 'src/a.ts', line: 3, body: 'x' })

  expect(calls.filter((c) => c.path.endsWith('/diffs')).map((c) => c.query?.page)).toEqual([1, 2])
  expect((calls.at(-1)?.body?.position as { old_path: string }).old_path).toBe('src/old.ts')
})

test("every write on someone else's MR is refused without allowOthers, and goes through with it", async () => {
  const { ctx, writes } = fakeCtx({
    'GET /merge_requests/7': THEIRS,
    'POST /merge_requests/7/notes': { id: 10 },
    'PUT /merge_requests/7/discussions/aa': {},
  })
  const refused = "MR !7 is by bob, not by the token's user (ann). Writing on someone else's MR needs allowOthers: true; pass it only when the user asked for it."

  for (const input of [
    { action: 'comment', body: 'x' },
    { action: 'reply', discussionId: 'aa', body: 'x' },
    { action: 'line', path: 'a.ts', line: 1, body: 'x' },
    { action: 'edit', noteId: 3, body: 'x' },
    { action: 'resolve', discussionId: 'aa' },
    { action: 'unresolve', discussionId: 'aa' },
  ]) {
    await expect(comment(ctx, { iid: 7, ...input }), input.action).rejects.toThrow(refused)
  }
  expect(writes()).toEqual([])

  expect(await comment(ctx, { action: 'comment', iid: 7, body: 'x', allowOthers: true })).toBe('{"note":10}')
  await comment(ctx, { action: 'resolve', iid: 7, discussionId: 'aa', allowOthers: true })
  expect(writes().map((c) => c.path)).toEqual(['/merge_requests/7/notes', '/merge_requests/7/discussions/aa'])
})

test('a discussion id that is not hex, a missing body and an unknown action are refused before any write', async () => {
  const { ctx, calls } = fakeCtx({})
  await expect(comment(ctx, { action: 'resolve', iid: 7, discussionId: '../../x' })).rejects.toThrow('discussionId is not a GitLab discussion id.')
  await expect(comment(ctx, { action: 'comment', iid: 7 })).rejects.toThrow('This action needs a body.')
  await expect(comment(ctx, { action: 'delete', iid: 7 })).rejects.toThrow('Unknown action: delete.')
  expect(calls).toEqual([])
})
