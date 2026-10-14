import { expect, test } from 'claude-code/testing'
import { comment, discussionView } from '../hooks/comments'
import { MR, fakeCtx } from './fake-api'

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

  const all = JSON.parse(await comment(ctx, { action: 'list', iid: 7 }))
  const open = JSON.parse(await comment(ctx, { action: 'list', iid: 7, unresolvedOnly: true }))

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

test('comment, reply, edit, resolve and unresolve call their endpoints with the body', async () => {
  const { ctx, calls } = fakeCtx({
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

  expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
    ['POST', '/merge_requests/7/notes', { body: 'LGTM' }],
    ['POST', '/merge_requests/7/discussions/aa/notes', { body: 'Fixed' }],
    ['PUT', '/merge_requests/7/notes/11', { body: 'Fixed in abc' }],
    ['PUT', '/merge_requests/7/discussions/aa', { resolved: true }],
    ['PUT', '/merge_requests/7/discussions/aa', { resolved: false }],
  ])
})

test('line comments on the diff at the MR head, with the new line, the old line or both', async () => {
  const { ctx, calls } = fakeCtx({
    'GET /merge_requests/7': MR,
    'POST /merge_requests/7/discussions': (c) => ({ id: 'ee', notes: [{ id: 12, body: c.body?.body, position: c.body?.position }] }),
  })

  await comment(ctx, { action: 'line', iid: 7, path: 'src/a.ts', line: 12, oldLine: 10, body: 'Why?' })

  expect(calls.at(-1)?.body).toEqual({
    body: 'Why?',
    position: { position_type: 'text', base_sha: 'b', start_sha: 's', head_sha: 'h', new_path: 'src/a.ts', old_path: 'src/a.ts', new_line: 12, old_line: 10 },
  })
  await expect(comment(ctx, { action: 'line', iid: 7, path: 'a.ts', body: 'x' })).rejects.toThrow(/needs line/)
})

test('a discussion id that is not hex, a missing body and an unknown action are refused before any write', async () => {
  const { ctx, calls } = fakeCtx({})
  await expect(comment(ctx, { action: 'resolve', iid: 7, discussionId: '../../x' })).rejects.toThrow('discussionId is not a GitLab discussion id.')
  await expect(comment(ctx, { action: 'comment', iid: 7 })).rejects.toThrow('This action needs a body.')
  await expect(comment(ctx, { action: 'delete', iid: 7 })).rejects.toThrow('Unknown action: delete.')
  expect(calls).toEqual([])
})
