import { test, expect } from 'claude-code/testing'
import { buildInit, buildUrl, call, checkedPath, forbidden, format, transform } from '../hooks/api'

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

test('buildUrl accepts only API paths', () => {
  expect(buildUrl('/tailnet/-/devices')).toBe('https://api.tailscale.com/api/v2/tailnet/-/devices')
  expect(buildUrl('//evil.com/x')).toBeUndefined()
  expect(buildUrl('/a/../b')).toBeUndefined()
  expect(buildUrl('https://evil.com')).toBeUndefined()
})

test('buildUrl rejects encoded dot, slash and backslash', () => {
  expect(buildUrl('/a/%2e%2e/b')).toBeUndefined()
  expect(buildUrl('/a/%2E%2E/b')).toBeUndefined()
  expect(buildUrl('/a%2Fb')).toBeUndefined()
  expect(buildUrl('/a%5cb')).toBeUndefined()
  expect(buildUrl('/tailnet/-/devices?x=%20')).toBeDefined()
})

test('forbidden refuses only deleting the entire tailnet', () => {
  expect(forbidden('DELETE', '/tailnet/-')).toBeDefined()
  expect(forbidden('DELETE', '/tailnet/T1234CNTRL/')).toBeDefined()
  expect(forbidden('DELETE', '/tailnet/-?x=1')).toBeDefined()
  expect(forbidden('DELETE', '/tailnet/-/keys/k1')).toBeUndefined()
  expect(forbidden('DELETE', '/device/1')).toBeUndefined()
  expect(forbidden('GET', '/tailnet/-')).toBeUndefined()
})

test('call does not reach the network when deleting the tailnet', async () => {
  const { fetch, seen } = fakeFetch('{}')
  const r = await call(fetch, 'k', { method: 'DELETE', path: '/tailnet/-' })
  expect(r.isError).toBe(true)
  expect(seen.last).toBeUndefined()
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

test('checkedPath returns the path only when buildUrl accepts it', () => {
  expect(checkedPath('/tailnet/-/devices')).toBe('/tailnet/-/devices')
  expect(checkedPath('//evil.com/x')).toBeUndefined()
  expect(checkedPath(42)).toBeUndefined()
})

test('buildUrl and checkedPath refuse a path with a blank, a backslash, a fragment or two dots anywhere', () => {
  for (const path of ['/a b', '/a\tb', '/a\nb', '/a\\b', '/a#b', '/a/..', '/a..b', 'devices', '', undefined, null, {}, ['/a']]) {
    expect(buildUrl(path)).toBeUndefined()
    expect(checkedPath(path)).toBeUndefined()
  }
})

test('buildUrl and checkedPath keep a query string and the root path as they are', () => {
  expect(buildUrl('/')).toBe('https://api.tailscale.com/api/v2/')
  expect(buildUrl('/tailnet/-/keys?all=true&x=1')).toBe('https://api.tailscale.com/api/v2/tailnet/-/keys?all=true&x=1')
  expect(buildUrl('/a?q=%20b')).toBe('https://api.tailscale.com/api/v2/a?q=%20b')
  expect(checkedPath('/')).toBe('/')
  expect(checkedPath('/tailnet/-/keys?all=true&x=1')).toBe('/tailnet/-/keys?all=true&x=1')
})

test('call fetches BASE plus the accepted path, with the query string untouched', async () => {
  const { fetch, seen } = fakeFetch('{}')
  await call(fetch, 'k', { method: 'GET', path: '/tailnet/-/keys?all=true&x=1' })
  expect(seen.last?.url).toBe('https://api.tailscale.com/api/v2/tailnet/-/keys?all=true&x=1')
})

test('call answers an invalid path with the value it received and sends nothing', async () => {
  const { fetch, seen } = fakeFetch('{}')

  for (const [path, shown] of [
    ['//evil.com/x', '//evil.com/x'],
    ['/a/../b', '/a/../b'],
    [42, '42'],
    [undefined, 'undefined'],
    [{ a: 1 }, '[object Object]'],
  ] as const) {
    const r = await call(fetch, 'k', { method: 'GET', path })
    expect(r).toEqual({ text: `Invalid path: ${shown}. Use something like /tailnet/-/devices.`, isError: true })
  }

  expect(seen.last).toBeUndefined()
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

const DOT_SEGMENT_PATHS = [
  '/.',
  '/./',
  '/./tailnet/-',
  '/tailnet/./-',
  '/tailnet/-/.',
  '/tailnet/-/./',
  '/tailnet/-/.?x=1',
  '/tailnet/./-?x=1',
  '/tailnet/-/devices/.',
  '/tailnet/././-',
]

test('buildUrl and checkedPath refuse a path with a lone dot segment at the start, middle, end or before the query', () => {
  for (const path of DOT_SEGMENT_PATHS) {
    expect(buildUrl(path), path).toBeUndefined()
    expect(checkedPath(path), path).toBeUndefined()
  }
})

test('buildUrl keeps accepting dots inside a segment', () => {
  expect(buildUrl('/tailnet/example.com/devices')).toBe('https://api.tailscale.com/api/v2/tailnet/example.com/devices')
  expect(buildUrl('/device/100.64.0.1')).toBe('https://api.tailscale.com/api/v2/device/100.64.0.1')
  expect(buildUrl('/tailnet/-/keys?host=a.b&v=1.2')).toBe('https://api.tailscale.com/api/v2/tailnet/-/keys?host=a.b&v=1.2')
  expect(buildUrl('/tailnet/.hidden/x')).toBe('https://api.tailscale.com/api/v2/tailnet/.hidden/x')
  expect(buildUrl('/tailnet/a./x')).toBe('https://api.tailscale.com/api/v2/tailnet/a./x')
  expect(buildUrl('/tailnet/user@example.com/keys')).toBe('https://api.tailscale.com/api/v2/tailnet/user@example.com/keys')
  expect(buildUrl('/device/abc123/routes')).toBe('https://api.tailscale.com/api/v2/device/abc123/routes')
  expect(buildUrl('/tailnet/-/devices/')).toBe('https://api.tailscale.com/api/v2/tailnet/-/devices/')
  expect(buildUrl('/tailnet/-/devices?fields=all&host=a.b')).toBe(
    'https://api.tailscale.com/api/v2/tailnet/-/devices?fields=all&host=a.b',
  )
})

test('call never reaches fetch with a dot segment, for the delete of the whole tailnet or any other call', async () => {
  const { fetch, seen } = fakeFetch('{}')

  for (const path of DOT_SEGMENT_PATHS) {
    for (const method of ['DELETE', 'GET', 'POST']) {
      const r = await call(fetch, 'k', { method, path })
      expect(r, `${method} ${path}`).toEqual({
        text: `Invalid path: ${path}. Use something like /tailnet/-/devices.`,
        isError: true,
      })
    }
  }

  expect(seen.last).toBeUndefined()
})

test('call sends a path whose dots are inside a segment', async () => {
  const { fetch, seen } = fakeFetch('{}')
  const r = await call(fetch, 'k', { method: 'GET', path: '/device/100.64.0.1' })
  expect(r.isError).toBe(false)
  expect(seen.last?.url).toBe('https://api.tailscale.com/api/v2/device/100.64.0.1')
})

// Paths that reach /tailnet/{tailnet} (or another path) on the server once the URL parser or the server normalizes them.
const SMUGGLED_PATHS = [
  '/tailnet/-/\x00',
  '/tailnet/-/\x01',
  '/tailnet/-/\x7f',
  '/tailnet/-/.\x00',
  '/tailnet/-/.\x01',
  '/tailnet/\x01-',
  '/tailnet/-\x7f/x',
  '/tailnet/-/devices?x=\x01',
  '/%74ailnet/-',
  '/tailne%74/-',
  '/tailnet/%2d',
  '/tailnet//-',
  '/tailnet/-//',
  '/tailnet///-',
  '//tailnet/-',
  '/tailnet//',
  '/TAILNET//-',
]

test('buildUrl and checkedPath refuse control characters, "%" in the path and empty segments', () => {
  for (const path of SMUGGLED_PATHS) {
    expect(buildUrl(path), JSON.stringify(path)).toBeUndefined()
    expect(checkedPath(path), JSON.stringify(path)).toBeUndefined()
  }
})

test('buildUrl allows "%" in the query and a single trailing slash', () => {
  expect(buildUrl('/tailnet/-/devices?x=%2f')).toBe('https://api.tailscale.com/api/v2/tailnet/-/devices?x=%2f')
  expect(buildUrl('/tailnet/-/')).toBe('https://api.tailscale.com/api/v2/tailnet/-/')
})

test('forbidden matches the tailnet delete in any case', () => {
  expect(forbidden('DELETE', '/TAILNET/-')).toBeDefined()
  expect(forbidden('DELETE', '/Tailnet/T1234CNTRL/')).toBeDefined()
})

test('call never reaches fetch with a smuggled path, for the delete of the whole tailnet or any other call', async () => {
  const { fetch, seen } = fakeFetch('{}')

  for (const path of [...SMUGGLED_PATHS, '/TAILNET/-/\x01']) {
    for (const method of ['DELETE', 'GET', 'POST']) {
      const r = await call(fetch, 'k', { method, path })
      expect(r.isError, `${method} ${JSON.stringify(path)}`).toBe(true)
    }
  }

  expect(seen.last).toBeUndefined()
})

test('call refuses DELETE /TAILNET/- without reaching fetch', async () => {
  const { fetch, seen } = fakeFetch('{}')
  const r = await call(fetch, 'k', { method: 'DELETE', path: '/TAILNET/-' })
  expect(r.isError).toBe(true)
  expect(r.text).toMatch(/^Deleting the entire tailnet/)
  expect(seen.last).toBeUndefined()
})

test('every URL buildUrl accepts keeps the requested path after the URL parser normalizes it', () => {
  const accepted = [
    '/tailnet/-/devices',
    '/device/100.64.0.1',
    '/device/abc123/routes',
    '/tailnet/example.com/devices',
    '/tailnet/user@example.com/keys',
    '/tailnet/-/keys?fields=all&host=a.b',
    '/',
  ]
  for (const path of [...DOT_SEGMENT_PATHS, ...SMUGGLED_PATHS, ...accepted]) {
    const url = buildUrl(path)
    if (url === undefined) continue
    expect(new URL(url).pathname, JSON.stringify(path)).toBe('/api/v2' + path.split('?')[0])
  }
  for (const path of accepted) expect(buildUrl(path), path).toBeDefined()
})
