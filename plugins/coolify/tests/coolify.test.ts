import { expect, test } from 'claude-code/testing'
import { buildInit, buildUrl, call, deleteTarget, forbidden, format, transform } from '../hooks/api'
import { ACCEPTED, BASE, DELETES, FORBIDDEN_POSTS, REJECTED, REJECTED_GROUPS, invalidPathText, urlOf } from './paths'

type Seen = { url: string; init: { method: string; headers: Record<string, string>; body?: string } }

function fakeFetch(text: string) {
  const seen: { last?: Seen } = {}
  const fetch = async (url: string, init: Seen['init']) => {
    seen.last = { url, init }
    return { status: 200, ok: true, text }
  }
  return { fetch, seen }
}

const ACCESS = { key: 'k', base: BASE }

const database = JSON.stringify({
  uuid: 'db1',
  name: 'pg',
  postgres_user: 'app',
  postgres_password: 'p4ss',
  internal_db_url: 'postgres://app:p4ss@db1:5432/app',
  manual_webhook_secret_github: 'w',
  private_key: '-----BEGIN',
  api_token: 't',
  ssh_key: 's',
  envs: [{ uuid: 'e1', key: 'DATABASE_URL', value: 'postgres://x', real_value: 'postgres://x', is_build_time: false }],
})

test('call sends Bearer and a JSON body to the instance', async () => {
  const { fetch, seen } = fakeFetch('{}')
  const r = await call(fetch, ACCESS, { method: 'POST', path: '/projects', body: { name: 'web' } })
  expect(r.isError).toBe(false)
  expect(seen.last?.url).toBe('https://coolify.example.com/api/v1/projects')
  expect(seen.last?.init.headers.Authorization).toBe('Bearer k')
  expect(seen.last?.init.headers['Content-Type']).toBe('application/json')
  expect(seen.last?.init.body).toBe('{"name":"web"}')
})

test('call fails without a key or an instance, before the path', async () => {
  const { fetch, seen } = fakeFetch('')
  expect((await call(fetch, { base: BASE }, { method: 'GET', path: '//bad' })).text).toMatch(/apiKey option is not set/)
  expect((await call(fetch, { key: 'k' }, { method: 'GET', path: '/x' })).text).toMatch(/url option is not set/)
  expect(seen.last).toBeUndefined()
})

test('redact removes passwords, tokens, keys, webhook secrets and environment values, and keeps the rest', () => {
  const out = JSON.parse(transform(database, { redact: true }))
  expect(out).toEqual({
    uuid: 'db1',
    name: 'pg',
    postgres_user: 'app',
    internal_db_url: 'postgres://app:p4ss@db1:5432/app',
    envs: [{ uuid: 'e1', key: 'DATABASE_URL', is_build_time: false }],
  })
})

test('redact leaves a value outside an environment variable, and non-JSON text, intact', () => {
  expect(JSON.parse(transform('{"value":1,"key_count":2}', { redact: true }))).toEqual({ value: 1, key_count: 2 })
  expect(transform('not json', { redact: true })).toBe('not json')
})

test('fields keeps only the requested keys and does not bring back what redact removed', () => {
  expect(JSON.parse(transform(database, { fields: ['name', 'uuid'] }))).toEqual({ uuid: 'db1', name: 'pg', envs: [{ uuid: 'e1' }] })
  expect(JSON.parse(transform(database, { redact: true, fields: ['name', 'postgres_password'] }))).toEqual({ name: 'pg' })
  expect(transform(database, { fields: ['nothing'] })).toBe('{}')
  expect(transform(database, { fields: [] })).toBe(database)
})

test('call truncates a huge response and suggests fields', async () => {
  const { fetch } = fakeFetch('x'.repeat(70_000))
  const r = await call(fetch, ACCESS, { method: 'GET', path: '/projects' })
  expect(r.text).toContain('use "fields"')
  expect(r.text.length).toBeLessThan(61_000)
})

test('call turns a fetch that throws into a failed call', async () => {
  const boom = async () => {
    throw new Error('connection reset')
  }
  expect(await call(boom, ACCESS, { method: 'GET', path: '/x' })).toEqual({ text: 'Call failed: connection reset', isError: true })
})

test('buildInit sends a string body as is and none without a body', () => {
  const str = buildInit({ method: 'POST', path: '/x', body: '{"a":1}' }, 'k')
  expect(str.body).toBe('{"a":1}')
  expect(str.headers['Content-Type']).toBe('application/json')
  const none = buildInit({ method: 'GET', path: '/x' }, 'k')
  expect(none.headers).toEqual({ Authorization: 'Bearer k', Accept: 'application/json' })
  expect(none.body).toBeUndefined()
})

test('format sets the error flag from the status', () => {
  expect(format({ status: 200, ok: true, text: 'hi' }, { method: 'GET', path: '/x' })).toEqual({ text: 'HTTP 200\nhi', isError: false })
  expect(format({ status: 404, ok: false, text: 'no' }, { method: 'GET', path: '/x' })).toEqual({ text: 'HTTP 404\nno', isError: true })
})

for (const [group, paths] of Object.entries(REJECTED_GROUPS)) {
  test(`buildUrl refuses ${group}`, () => {
    for (const path of paths) expect(buildUrl(BASE, path), JSON.stringify(path)).toBeUndefined()
  })
}

test('buildUrl maps every accepted path to the API base plus the path, on the same host', () => {
  for (const path of ACCEPTED) {
    expect(buildUrl(BASE, path), path).toBe(urlOf(path))
    expect(new URL(urlOf(path)).host, path).toBe('coolify.example.com')
    expect(new URL(urlOf(path)).pathname, path).toBe('/api/v1' + path.split('?')[0])
  }
})

test('call never reaches fetch with a rejected path, for any method', async () => {
  const { fetch, seen } = fakeFetch('{}')
  for (const path of REJECTED) {
    for (const method of ['DELETE', 'GET', 'POST']) {
      expect(await call(fetch, ACCESS, { method, path }), `${method} ${JSON.stringify(path)}`).toEqual({ text: invalidPathText(path), isError: true })
    }
  }
  expect(seen.last).toBeUndefined()
})

test('forbidden refuses the API and MCP toggles and token creation, for POST only', async () => {
  const { fetch, seen } = fakeFetch('{}')
  for (const path of FORBIDDEN_POSTS) {
    expect(forbidden('POST', path), path).toBeDefined()
    expect((await call(fetch, ACCESS, { method: 'POST', path })).text, path).toMatch(/not done by this tool/)
  }
  expect(seen.last).toBeUndefined()
  expect(forbidden('GET', '/enable')).toBeUndefined()
  expect(forbidden('POST', '/projects')).toBeUndefined()
  expect(forbidden('POST', '/deploy')).toBeUndefined()
})

test('deleteTarget is the last segment of the path, without the query string or trailing slash', () => {
  for (const [path, target] of DELETES) expect(deleteTarget(path), path).toBe(target)
  expect(deleteTarget('/')).toBeUndefined()
  expect(deleteTarget(42)).toBeUndefined()
})
