import { expect, test } from 'claude-code/testing'
import { apiPath, rawGet } from '../hooks/raw'
import { fakeCtx, paged } from './fake-api'

test('apiPath keeps reads under the allowed prefixes, with encoded project paths and queries', () => {
  expect(apiPath('projects/luizalabs%2Fapp/merge_requests?state=opened&per_page=50')).toBe('projects/luizalabs%2Fapp/merge_requests?state=opened&per_page=50')
  expect(apiPath('/api/v4/merge_requests?scope=all')).toBe('merge_requests?scope=all')
  expect(apiPath('groups/luizalabs/projects')).toBe('groups/luizalabs/projects')
  expect(apiPath('users?username=ann')).toBe('users?username=ann')
  expect(apiPath('labels')).toBe('labels')
})

test('apiPath refuses other prefixes, hosts, dot segments (plain or encoded) and odd characters', () => {
  for (const bad of ['user', 'version', 'projectsx/1', 'https://evil.com/projects/1', '//evil.com/projects/1', 'projects/../user', 'projects/%2e%2e/user', 'projects/1/%2E%2E%2F..%2Fuser', 'projects/%252e%252e/user', 'projects/1#x', 'projects//1', 'projects/1\\..', 'projects/%zz']) {
    expect(() => apiPath(bad), bad).toThrow()
  }
  expect(() => apiPath('runners')).toThrow('gitlab_api reads only under /api/v4: path must start with projects, merge_requests, groups, users, labels.')
  expect(() => apiPath(undefined)).toThrow(/needs path/)
})

test('rawGet sends one GET of the checked path and says when there is a next page', async () => {
  const { ctx, calls } = fakeCtx({ 'GET RAW/projects/1/issues?per_page=2': paged('[{"iid":1},{"iid":2}]', 2) })
  expect(await rawGet(ctx, { path: 'projects/1/issues?per_page=2' })).toBe('[{"iid":1},{"iid":2}]\n(next page: 2; add page=2 to the query)')
  expect(calls.map((c) => c.method)).toEqual(['GET'])
})
