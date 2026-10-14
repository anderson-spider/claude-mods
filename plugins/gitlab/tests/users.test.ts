import { expect, test } from 'claude-code/testing'
import { user } from '../hooks/users'
import { fakeCtx } from './fake-api'

const ANN = { id: 1, username: 'ann', name: 'Ann Lee', state: 'active', web_url: 'https://gitlab.example.com/ann', email: 'ann@example.com' }

test('without a username, or with @me, it answers the token owner; with one, that user', async () => {
  const { ctx, calls } = fakeCtx({ 'GET ROOT/user': ANN, 'GET ROOT/users': (c) => (c.query?.username === 'bob' ? [{ id: 2, username: 'bob', name: 'Bob', state: 'active', web_url: 'u/bob', bot: true }] : []) })

  expect(JSON.parse(await user(ctx, {}))).toEqual({ id: 1, username: 'ann', name: 'Ann Lee', state: 'active', url: 'https://gitlab.example.com/ann' })
  expect(JSON.parse(await user(ctx, { username: '@me' })).username).toBe('ann')
  expect(JSON.parse(await user(ctx, { username: '@bob' }))).toEqual({ id: 2, username: 'bob', name: 'Bob', state: 'active', bot: true, url: 'u/bob' })
  expect(calls.map((c) => c.path)).toEqual(['ROOT/user', 'ROOT/user', 'ROOT/users'])
})

test('an unknown or malformed username is refused', async () => {
  const { ctx, calls } = fakeCtx({ 'GET ROOT/users': [] })
  await expect(user(ctx, { username: 'ghost' })).rejects.toThrow('No GitLab user named ghost on this host.')
  await expect(user(ctx, { username: 'a/b' })).rejects.toThrow(/username is a GitLab username/)
  expect(calls).toHaveLength(1)
})
