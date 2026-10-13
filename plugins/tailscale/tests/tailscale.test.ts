import { test, expect } from 'claude-code/testing'
import { buildInit, buildUrl, call, checkedPath, forbidden, format, transform } from '../hooks/api'
import { ACCEPTED, ALLOWED_DELETES, REJECTED, REJECTED_GROUPS, TAILNET_DELETES, invalidPathText, urlOf } from './paths'

type Seen = { url: string; init: { method: string; headers: Record<string, string>; body?: string } }

function fakeFetch(text: string, headers?: Record<string, string>) {
  const seen: { last?: Seen } = {}
  const fetch = async (url: string, init: Seen['init']) => {
    seen.last = { url, init }
    return { status: 200, ok: true, text, headers }
  }
  return { fetch, seen }
}

const devices = JSON.stringify({
  devices: [
    {
      id: '1',
      hostname: 'a',
      os: 'linux',
      addresses: ['100.1.1.1'],
      machineKey: 'mkey:x',
      nodeKey: 'nodekey:y',
      tailnetLockKey: 'nlpub:z',
      tags: ['tag:t'],
    },
  ],
})

test('call sends Bearer and JSON body', async () => {
  const { fetch, seen } = fakeFetch('{}')
  const r = await call(fetch, 'k', { method: 'POST', path: '/device/1/tags', body: { tags: ['tag:a'] } })
  expect(r.isError).toBe(false)
  expect(seen.last?.init.headers.Authorization).toBe('Bearer k')
  expect(seen.last?.init.headers['Content-Type']).toBe('application/json')
  expect(seen.last?.init.body).toBe('{"tags":["tag:a"]}')
})

test('call fails without a key', async () => {
  const { fetch } = fakeFetch('')
  const r = await call(fetch, undefined, { method: 'GET', path: '/x' })
  expect(r.isError).toBe(true)
})

test('call sends If-Match when ifMatch is set', async () => {
  const { fetch, seen } = fakeFetch('{}')
  await call(fetch, 'k', { method: 'POST', path: '/tailnet/-/acl', body: '{}', ifMatch: '"abc"' })
  expect(seen.last?.init.headers['If-Match']).toBe('"abc"')
})

test('call without ifMatch does not send If-Match', async () => {
  const { fetch, seen } = fakeFetch('{}')
  await call(fetch, 'k', { method: 'POST', path: '/tailnet/-/acl', body: '{}' })
  expect(seen.last?.init.headers['If-Match']).toBeUndefined()
})

test('string JSON body goes as application/json and HuJSON as application/hujson', async () => {
  const json = fakeFetch('{}')
  await call(json.fetch, 'k', { method: 'POST', path: '/tailnet/-/acl', body: '{"acls":[]}' })
  expect(json.seen.last?.init.headers['Content-Type']).toBe('application/json')

  const hujson = fakeFetch('{}')
  const policy = '{\n  // allow everything\n  "acls": [],\n}'
  await call(hujson.fetch, 'k', { method: 'POST', path: '/tailnet/-/acl', body: policy })
  expect(hujson.seen.last?.init.headers['Content-Type']).toBe('application/hujson')
  expect(hujson.seen.last?.init.body).toBe(policy)
})

test('call shows the response ETag', async () => {
  const { fetch } = fakeFetch('{"acls":[]}', { etag: '"e0b2816b418"' })
  const r = await call(fetch, 'k', { method: 'GET', path: '/tailnet/-/acl' })
  expect(r.text).toBe('HTTP 200\nETag: "e0b2816b418"\n{"acls":[]}')
})

test('call without ETag does not invent the line', async () => {
  const { fetch } = fakeFetch('{}')
  const r = await call(fetch, 'k', { method: 'GET', path: '/tailnet/-/devices' })
  expect(r.text).toBe('HTTP 200\n{}')
})

test('call returns an error on 412', async () => {
  const fetch = async () => ({ status: 412, ok: false, text: '{"message":"precondition failed"}' })
  const r = await call(fetch, 'k', { method: 'POST', path: '/tailnet/-/acl', body: '{}', ifMatch: '"x"' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('HTTP 412')
})

test('redact removes secret fields at any level', () => {
  const out = JSON.parse(transform(devices, { redact: true }))
  expect(out.devices[0]).toEqual({ id: '1', hostname: 'a', os: 'linux', addresses: ['100.1.1.1'], tags: ['tag:t'] })
})

test('redact removes secret, s3SecretAccessKey and token', () => {
  const out = JSON.parse(transform('{"a":{"secret":"s","s3SecretAccessKey":"k","token":"t","ok":1}}', { redact: true }))
  expect(out).toEqual({ a: { ok: 1 } })
})

test('redact also drops new fields named like a secret and keeps look-alikes', () => {
  const body = '{"authKey":"a","clientSecret":"c","accessToken":"t","keyExpiryDisabled":true,"sshHostKeys":["k"],"hostname":"h"}'
  const out = JSON.parse(transform(body, { redact: true }))
  expect(out).toEqual({ keyExpiryDisabled: true, sshHostKeys: ['k'], hostname: 'h' })
})

test('redact leaves non-JSON text intact', () => {
  expect(transform('not json', { redact: true })).toBe('not json')
})

test('call with redact:true filters the response', async () => {
  const { fetch } = fakeFetch(devices)
  const r = await call(fetch, 'k', { method: 'GET', path: '/tailnet/-/devices', redact: true })
  expect(r.text).not.toContain('machineKey')
  expect(r.text).not.toContain('nodeKey')
  expect(r.text).not.toContain('tailnetLockKey')
  expect(r.text).toContain('"hostname":"a"')
})

test('call without redact keeps the response as received', async () => {
  const { fetch } = fakeFetch(devices)
  const r = await call(fetch, 'k', { method: 'GET', path: '/tailnet/-/devices' })
  expect(r.text).toContain('machineKey')
})

test('fields keeps only the requested keys, inside a wrapping object', () => {
  const out = JSON.parse(transform(devices, { fields: ['hostname', 'addresses'] }))
  expect(out).toEqual({ devices: [{ hostname: 'a', addresses: ['100.1.1.1'] }] })
})

test('fields combines with redact and does not bring back what was removed', () => {
  const out = JSON.parse(transform(devices, { redact: true, fields: ['hostname', 'nodeKey'] }))
  expect(out).toEqual({ devices: [{ hostname: 'a' }] })
})

test('fields with no matching key returns an empty object', () => {
  expect(transform(devices, { fields: ['nothing'] })).toBe('{}')
})

test('empty fields leaves the response untouched', () => {
  expect(transform(devices, { fields: [] })).toBe(devices)
})

test('call truncates a huge response and suggests fields', async () => {
  const { fetch } = fakeFetch('x'.repeat(70_000))
  const r = await call(fetch, 'k', { method: 'GET', path: '/tailnet/-/devices' })
  expect(r.text).toContain('use "fields"')
  expect(r.text.length).toBeLessThan(61_000)
})

test('call checks the key before the path, and the path before forbidden', async () => {
  const { fetch, seen } = fakeFetch('{}')

  expect(await call(fetch, undefined, { method: 'GET', path: '//bad' })).toEqual({
    text: 'TS_API_KEY is not set in the Claude Code environment.',
    isError: true,
  })
  expect(await call(fetch, '', { method: 'GET', path: '/x' })).toEqual({
    text: 'TS_API_KEY is not set in the Claude Code environment.',
    isError: true,
  })
  expect((await call(fetch, 'k', { method: 'DELETE', path: '//tailnet/-' })).text).toMatch(/^Invalid path/)
  expect((await call(fetch, 'k', { method: 'DELETE', path: '/tailnet/-' })).text).toMatch(/^Deleting the entire tailnet/)
  expect(seen.last).toBeUndefined()
})

test('call turns a fetch that throws into a failed call, naming an Error message or the thrown value', async () => {
  const boom = async () => {
    throw new Error('connection reset')
  }
  const text = async () => {
    throw 'plain text'
  }

  expect(await call(boom, 'k', { method: 'GET', path: '/x' })).toEqual({ text: 'Call failed: connection reset', isError: true })
  expect(await call(text, 'k', { method: 'GET', path: '/x' })).toEqual({ text: 'Call failed: plain text', isError: true })
})

test('buildInit picks the content type from the body', () => {
  const json = buildInit({ method: 'POST', path: '/x', body: '{"a":1}' }, 'k')
  expect(json.headers['Content-Type']).toBe('application/json')
  expect(json.body).toBe('{"a":1}')
  const hujson = buildInit({ method: 'POST', path: '/x', body: '{"a":1,}' }, 'k')
  expect(hujson.headers['Content-Type']).toBe('application/hujson')
  const obj = buildInit({ method: 'POST', path: '/x', body: { a: 1 } }, 'k')
  expect(obj.headers['Content-Type']).toBe('application/json')
  expect(obj.body).toBe('{"a":1}')
})

test('buildInit sets auth, If-Match and no Content-Type without a body', () => {
  const init = buildInit({ method: 'GET', path: '/x', ifMatch: 'x' }, 'k')
  expect(init.method).toBe('GET')
  expect(init.headers.Authorization).toBe('Bearer k')
  expect(init.headers.Accept).toBe('application/json')
  expect(init.headers['If-Match']).toBe('x')
  expect(init.headers['Content-Type']).toBeUndefined()
  expect(init.body).toBeUndefined()
})

test('buildInit sends an object body as JSON together with If-Match', () => {
  const init = buildInit({ method: 'POST', path: '/x', body: { a: 1 }, ifMatch: 'etag' }, 'k')
  expect(init.headers['Content-Type']).toBe('application/json')
  expect(init.headers['If-Match']).toBe('etag')
  expect(init.body).toBe('{"a":1}')
})

test('format keeps the ETag line, the error flag and truncates long text', () => {
  const ok = format({ status: 200, ok: true, text: 'hi', headers: { etag: '"e"' } }, { method: 'GET', path: '/x' })
  expect(ok).toEqual({ text: 'HTTP 200\nETag: "e"\nhi', isError: false })
  const bad = format({ status: 404, ok: false, text: 'no' }, { method: 'GET', path: '/x' })
  expect(bad).toEqual({ text: 'HTTP 404\nno', isError: true })
  const long = format({ status: 200, ok: true, text: 'a'.repeat(60_001) }, { method: 'GET', path: '/x' })
  expect(long.text).toBe('HTTP 200\n' + 'a'.repeat(60_000) + '\n…(truncated; use "fields" to request less)')
})

for (const [group, paths] of Object.entries(REJECTED_GROUPS)) {
  test(`buildUrl and checkedPath refuse ${group}`, () => {
    for (const path of paths) {
      expect(buildUrl(path), JSON.stringify(path)).toBeUndefined()
      expect(checkedPath(path), JSON.stringify(path)).toBeUndefined()
    }
  })
}

test('buildUrl maps every accepted path to the API base plus the path, and checkedPath returns it as is', () => {
  for (const path of ACCEPTED) {
    expect(buildUrl(path), path).toBe(urlOf(path))
    expect(checkedPath(path), path).toBe(path)
  }
})

test('every URL buildUrl accepts keeps the requested path after the URL parser normalizes it', () => {
  for (const path of [...REJECTED, ...ACCEPTED]) {
    const url = buildUrl(path)
    if (url === undefined) continue
    expect(new URL(url).pathname, JSON.stringify(path)).toBe('/api/v2' + String(path).split('?')[0])
  }
})

test('call never reaches fetch with a rejected path, for any method, and answers with the value it received', async () => {
  const { fetch, seen } = fakeFetch('{}')

  for (const path of REJECTED) {
    for (const method of ['DELETE', 'GET', 'POST']) {
      const r = await call(fetch, 'k', { method, path })
      expect(r, `${method} ${JSON.stringify(path)}`).toEqual({ text: invalidPathText(path), isError: true })
    }
  }

  expect(seen.last).toBeUndefined()
})

test('call fetches BASE plus every accepted path, with the query string untouched', async () => {
  for (const path of ACCEPTED) {
    const { fetch, seen } = fakeFetch('{}')
    const r = await call(fetch, 'k', { method: 'GET', path })
    expect(r.isError, path).toBe(false)
    expect(seen.last?.url, path).toBe(urlOf(path))
  }
})

test('forbidden refuses only deleting the entire tailnet, in any case, with a trailing slash or a query string', () => {
  for (const path of TAILNET_DELETES) expect(forbidden('DELETE', path), path).toBeDefined()
  for (const path of ALLOWED_DELETES) expect(forbidden('DELETE', path), path).toBeUndefined()
  expect(forbidden('GET', '/tailnet/-')).toBeUndefined()
})

test('call does not reach the network when deleting the tailnet', async () => {
  const { fetch, seen } = fakeFetch('{}')

  for (const path of TAILNET_DELETES) {
    const r = await call(fetch, 'k', { method: 'DELETE', path })
    expect(r.isError, path).toBe(true)
    expect(r.text, path).toMatch(/^Deleting the entire tailnet/)
  }

  expect(seen.last).toBeUndefined()
})

test('call sends every allowed DELETE', async () => {
  for (const path of ALLOWED_DELETES) {
    const { fetch, seen } = fakeFetch('{}')
    const r = await call(fetch, 'k', { method: 'DELETE', path })
    expect(r.isError, path).toBe(false)
    expect(seen.last?.url, path).toBe(urlOf(path))
    expect(seen.last?.init.method, path).toBe('DELETE')
  }
})
