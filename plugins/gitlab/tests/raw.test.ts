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

test('apiPath refuses subresources that answer with secrets, anywhere in the path and encoded or not', () => {
  for (const bad of ['projects/1/variables', 'projects/1/variables/KEY', 'groups/g/variables', 'projects/1/deploy_tokens', 'projects/1/triggers', 'projects/1/hooks', 'projects/1/integrations/slack', 'projects/1/access_tokens', 'users/1/impersonation_tokens', 'projects/1/secure_files', 'projects/1/runners', 'projects/1/Variables', 'projects/1%2Fvariables']) {
    expect(() => apiPath(bad), bad).toThrow('gitlab_api does not read variables, tokens, triggers, hooks, integrations or runners: their answers carry secrets.')
  }
  expect(apiPath('projects/1/merge_requests?search=variables')).toBe('projects/1/merge_requests?search=variables')
})
