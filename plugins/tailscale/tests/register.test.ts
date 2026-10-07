import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const GET = 'mcp__tailscale__tailscale_get'
const WRITE = 'mcp__tailscale__tailscale_write'

type Sent = { url: string; method?: string; headers?: Record<string, string>; body?: string }

/** A host with a key in the environment and a fake Tailscale API behind `http.fetch`. */
function world(on: On, opts: { key?: string; text?: string } = {}) {
  const sent: Sent[] = []
  const registered: string[] = []

  on('env.get', () => ({ value: 'key' in opts ? opts.key : 'tskey-test' }))
  on('tool.register', (_$, e) => (registered.push(e.name), { value: { tool: `mcp__tailscale__${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_$, e) => {
    sent.push({ url: e.url, method: e.init?.method, headers: e.init?.headers, body: e.init?.body })

    return { value: { status: 200, ok: true, headers: {}, text: opts.text ?? '{}' } }
  })

  return { sent, registered }
}

const text = (result: { result?: unknown }) => String(result.result)

test('session start registers the get and write tools', async ($, on) => {
  const { registered } = world(on)

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(registered).toEqual(['tailscale_get', 'tailscale_write'])
})

test('get sends a GET with the key, redacts secrets and keeps only the asked fields', async ($, on) => {
  const { sent } = world(on, { text: JSON.stringify({ devices: [{ hostname: 'a', os: 'linux', nodeKey: 'nodekey:y' }] }) })

  const result = await $.tool.call({ tool: GET, path: '/tailnet/-/devices', fields: ['hostname', 99, 'nodeKey'] } as never)

  expect(sent).toHaveLength(1)
  expect(sent[0]?.url).toBe('https://api.tailscale.com/api/v2/tailnet/-/devices')
  expect(sent[0]?.method).toBe('GET')
  expect(sent[0]?.headers?.Authorization).toBe('Bearer tskey-test')
  expect(text(result)).toContain('"hostname":"a"')
  expect(text(result)).not.toContain('nodekey')
  expect(text(result)).not.toContain('linux')
})

test('get ignores a fields value that is not an array', async ($, on) => {
  world(on, { text: JSON.stringify({ hostname: 'a', os: 'linux' }) })

  const result = await $.tool.call({ tool: GET, path: '/device/1', fields: 'hostname' } as never)

  expect(text(result)).toContain('linux')
})

test('get refuses a path that leaves the API and a missing key without a request', async ($, on) => {
  const { sent } = world(on)

  const escaped = await $.tool.call({ tool: GET, path: '//evil.com/x' } as never)
  expect(escaped.isError).toBe(true)
  expect(text(escaped)).toMatch(/Invalid path/)
  expect(sent).toEqual([])
})

test('a missing TS_API_KEY is reported and nothing is sent', async ($, on) => {
  const { sent } = world(on, { key: undefined })

  const result = await $.tool.call({ tool: GET, path: '/tailnet/-/devices' } as never)

  expect(result.isError).toBe(true)
  expect(text(result)).toMatch(/TS_API_KEY is not set/)
  expect(sent).toEqual([])
})

test('write denies a method that is not a write and sends nothing', async ($, on) => {
  const { sent } = world(on)

  const denied = await $.tool.call({ tool: WRITE, method: 'GET', path: '/tailnet/-/devices' } as never)

  expect(denied.deny).toMatch(/Invalid method: GET/)
  expect(sent).toEqual([])
})

test('write upper-cases the method, passes If-Match and does not redact the response', async ($, on) => {
  const { sent } = world(on, { text: JSON.stringify({ key: 'tskey-new', secret: 'once' }) })

  const result = await $.tool.call({
    tool: WRITE,
    method: 'post',
    path: '/tailnet/-/acl',
    body: { acls: [] },
    ifMatch: '"etag-1"',
  } as never)

  expect(sent[0]?.method).toBe('POST')
  expect(sent[0]?.headers?.['If-Match']).toBe('"etag-1"')
  expect(sent[0]?.headers?.['Content-Type']).toBe('application/json')
  expect(sent[0]?.body).toBe('{"acls":[]}')
  expect(text(result)).toContain('"secret":"once"')
})

test('write ignores an ifMatch that is not a string', async ($, on) => {
  const { sent } = world(on)

  await $.tool.call({ tool: WRITE, method: 'PUT', path: '/device/1/tags', body: {}, ifMatch: 5 } as never)

  expect(sent[0]?.headers?.['If-Match']).toBeUndefined()
})

test('write refuses to delete the whole tailnet', async ($, on) => {
  const { sent } = world(on)

  const result = await $.tool.call({ tool: WRITE, method: 'DELETE', path: '/tailnet/example.com' } as never)

  expect(result.isError).toBe(true)
  expect(text(result)).toMatch(/entire tailnet/)
  expect(sent).toEqual([])
})
