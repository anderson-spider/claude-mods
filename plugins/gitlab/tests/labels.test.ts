import { expect, test } from 'claude-code/testing'
import { GitlabError } from '../hooks/api'
import { label, requireLabels } from '../hooks/labels'
import { fakeCtx, paged } from './fake-api'

const BUG = { id: 1, name: 'bug', color: '#d9534f', description: 'Something broke' }

test('list shows name, colour and description, filters by search and says when there is a next page', async () => {
  const { ctx, calls } = fakeCtx({ 'GET /labels': paged([BUG, { id: 2, name: 'chore', color: '#ccc', description: '' }], 2) })

  const out = JSON.parse(await label(ctx, { action: 'list', search: 'b', perPage: 2 }))

  expect(out).toEqual({ labels: [{ name: 'bug', color: '#d9534f', description: 'Something broke' }, { name: 'chore', color: '#ccc' }], next: 2 })
  expect(calls[0]?.query).toEqual({ search: 'b', per_page: 2, page: 1 })
})

test('create makes the label with the default colour, or the one given, and description', async () => {
  const { ctx, writes } = fakeCtx({ 'GET /labels': [{ id: 3, name: 'fix-train-old' }], 'POST /labels': (c) => ({ id: 4, ...c.body }) })

  expect(JSON.parse(await label(ctx, { action: 'create', name: 'fix-train' }))).toEqual({ name: 'fix-train', color: '#428BCA', existing: false })
  await label(ctx, { action: 'create', name: 'fix', color: '#FF0000', description: 'A fix' })

  expect(writes().map((c) => c.body)).toEqual([
    { name: 'fix-train', color: '#428BCA' },
    { name: 'fix', color: '#FF0000', description: 'A fix' },
  ])
})

test('create answers the existing label instead of an error, also when it appears meanwhile', async () => {
  const existing = fakeCtx({ 'GET /labels': [BUG] })
  expect(JSON.parse(await label(existing.ctx, { action: 'create', name: 'bug' }))).toEqual({ name: 'bug', color: '#d9534f', description: 'Something broke', existing: true })
  expect(existing.writes()).toEqual([])

  let reads = 0
  const raced = fakeCtx({
    'GET /labels': () => (reads++ === 0 ? [] : [BUG]),
    'POST /labels': () => {
      throw new GitlabError(409, 'Label already exists', 'POST')
    },
  })
  expect(JSON.parse(await label(raced.ctx, { action: 'create', name: 'bug' })).existing).toBe(true)
})

test('create refuses a missing name or a colour that is not hex, before any request', async () => {
  const { ctx, calls } = fakeCtx({})
  await expect(label(ctx, { action: 'create' })).rejects.toThrow('create needs a name.')
  await expect(label(ctx, { action: 'create', name: 'x', color: 'blue' })).rejects.toThrow('color must be a hex colour like #428BCA.')
  await expect(label(ctx, { action: 'delete', name: 'x' })).rejects.toThrow('Unknown action: delete.')
  expect(calls).toEqual([])
})

test('requireLabels matches exact names only: a search hit with a longer name does not count', async () => {
  const { ctx } = fakeCtx({ 'GET /labels': [{ id: 1, name: 'fix-train-old' }] })
  await expect(requireLabels(ctx, ['fix-train'], false)).rejects.toThrow('The project has no label fix-train.')
})
