import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { ACCEPTED, ALLOWED_DELETES, REJECTED, invalidPathText, urlOf } from './paths'

type Sent = { url: string; method?: string; headers?: Record<string, string>; body?: string }
type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }
type Input = Record<string, unknown>

const id = (name: string) => `mcp__tailscale__${name}`
const GET = id('tailscale_get')
const WRITE = id('tailscale_write')

/** Per registered tool: a valid call for a given path. A new tool adds one entry here and its own tests. */
const CALLS: Record<string, { method: string; input: (path: unknown) => Input }> = {
  tailscale_get: { method: 'GET', input: (path) => ({ tool: GET, path }) },
  tailscale_write: { method: 'PATCH', input: (path) => ({ tool: WRITE, method: 'patch', path, body: {} }) },
}

/** A host with a key in the environment and a fake Tailscale API behind `http.fetch`. */
function world(on: On, opts: { key?: string | (() => string | undefined); text?: string; status?: number } = {}) {
  const sent: Sent[] = []
  const tools: Tool[] = []
  const readKey = () => ('key' in opts ? (typeof opts.key === 'function' ? opts.key() : opts.key) : 'tskey-test')
  const status = opts.status ?? 200

  on('env.get', (_$, e) => ({ value: e.name === 'TS_API_KEY' ? readKey() : undefined }))
  on('tool.register', (_$, e) => (tools.push(e as unknown as Tool), { value: { tool: id(e.name) } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_$, e) => {
    sent.push({ url: e.url, method: e.init?.method, headers: e.init?.headers, body: e.init?.body })

    return { value: { status, ok: status < 400, headers: {}, text: opts.text ?? '{}' } }
  })

  return { sent, tools }
}

const text = (result: { result?: unknown }) => String(result.result)

/** Starts the session and returns the registered tools that have a case in `CALLS`. */
async function started(
  $: { session: { start: (e: never) => Promise<unknown> } },
  tools: Tool[],
): Promise<string[]> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  // a tool of CALLS that failed to register must fail the test, not be skipped
  const registered = tools.map((t) => t.name)
  expect(registered).toEqual(expect.arrayContaining(Object.keys(CALLS)))

  return registered.filter((name) => name in CALLS)
}

for (const name of Object.keys(CALLS)) {
  test(`session start registers ${name}`, async ($, on) => {
    const { tools } = world(on)
    await started($, tools)

    expect(tools.map((t) => t.name)).toContain(name)
  })
}

test('every registered tool has a host case in CALLS', async ($, on) => {
  const { tools } = world(on)
  await started($, tools)

  expect(tools.map((t) => t.name).filter((name) => !(name in CALLS))).toEqual([])
})

/** Sums every description string (tool and schema properties) in a registered tool. */
function descriptionChars(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, v) => n + descriptionChars(v), 0)
  if (node === null || typeof node !== 'object') return 0
  return Object.entries(node).reduce(
    (n, [k, v]) => n + (k === 'description' && typeof v === 'string' ? v.length : descriptionChars(v)),
    0,
  )
}

// every tool's descriptions ride in each request's prompt, so the budget is per tool
const TOOL_BUDGET = 650

test('each tool keeps its tool and schema descriptions within the prompt budget', async ($, on) => {
  const { tools } = world(on)
  await started($, tools)

  for (const tool of tools) expect(descriptionChars(tool), tool.name).toBeLessThanOrEqual(TOOL_BUDGET)
})

test('every tool that takes a path describes it the same way', async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  const paths = tools.map((t) => t.inputSchema.properties.path?.description).filter((d) => d !== undefined)

  expect(paths.length).toBeGreaterThan(0)
  for (const description of paths) {
    expect(description).toBe(paths[0])
    expect(description).toContain('https://api.tailscale.com/api/v2')
  }
})

test('the tool descriptions state their rules', async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

  expect(byName.tailscale_get!.description).toContain('Secret fields (*Key, *Secret, *Token) are filtered')
  const write = byName.tailscale_write!
  expect(write.description).toContain('after user confirmation')
  expect(write.description).toContain('Whole-tailnet deletion is refused')
  expect(write.description).toContain('GET first and pass its ETag in ifMatch')
  expect(write.description).toContain('Write responses retain new-key secrets')
  expect(write.inputSchema.properties.body!.description).toContain('non-JSON strings are sent as HuJSON')
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

test('write denies a method that is not a write and sends nothing', async ($, on) => {
  const { sent } = world(on)

  const denied = await $.tool.call({ tool: WRITE, method: 'GET', path: '/tailnet/-/devices' } as never)

  expect(denied.deny).toMatch(/Invalid method: GET/)
  expect(sent).toEqual([])
})

test('write checks the method before the key: a bad method is denied even without a key', async ($, on) => {
  const { sent } = world(on, { key: undefined })

  const denied = await $.tool.call({ tool: WRITE, method: 'get', path: '/tailnet/-/devices' } as never)

  expect(denied.deny).toMatch(/Invalid method: GET\. Use POST, PUT, PATCH, DELETE\./)
  expect(denied.isError).toBeUndefined()
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

test('write sends every allowed DELETE, whatever the case of the method', async ($, on) => {
  const { sent } = world(on)

  for (const path of ALLOWED_DELETES) {
    const result = await $.tool.call({ tool: WRITE, method: 'delete', path } as never)
    expect(result.isError, path).toBeUndefined()
  }

  expect(sent.map((s) => [s.method, s.url])).toEqual(ALLOWED_DELETES.map((p) => ['DELETE', urlOf(p)]))
})

test('write refuses to delete the whole tailnet', async ($, on) => {
  const { sent } = world(on)

  const result = await $.tool.call({ tool: WRITE, method: 'DELETE', path: '/tailnet/example.com' } as never)

  expect(result.isError).toBe(true)
  expect(text(result)).toMatch(/entire tailnet/)
  expect(sent).toEqual([])
})

test('write refuses every rejected path for DELETE too, so no smuggled path deletes the whole tailnet', async ($, on) => {
  const { sent } = world(on)

  for (const path of REJECTED) {
    const result = await $.tool.call({ tool: WRITE, method: 'DELETE', path } as never)

    expect(result.isError, JSON.stringify(path)).toBe(true)
    expect(text(result), JSON.stringify(path)).toBe(invalidPathText(path))
  }

  expect(sent).toEqual([])
})

// The tests below run once per registered tool: a new tool adds its entry to CALLS and nothing else.

test('every tool reports a missing TS_API_KEY and sends nothing', async ($, on) => {
  const { sent, tools } = world(on, { key: undefined })

  for (const name of await started($, tools)) {
    const result = await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never)

    expect(result.isError, name).toBe(true)
    expect(text(result), name).toBe('TS_API_KEY is not set in the Claude Code environment.')
  }

  expect(sent).toEqual([])
})

test('every tool refuses a rejected path and sends nothing', async ($, on) => {
  const { sent, tools } = world(on)

  for (const name of await started($, tools)) {
    for (const path of REJECTED) {
      const result = await $.tool.call(CALLS[name]!.input(path) as never)

      expect(result.isError, `${name} ${JSON.stringify(path)}`).toBe(true)
      expect(text(result), `${name} ${JSON.stringify(path)}`).toBe(invalidPathText(path))
    }
  }

  expect(sent).toEqual([])
})

test('every tool sends an accepted path under the API, query string included', async ($, on) => {
  const { sent, tools } = world(on)

  for (const name of await started($, tools)) {
    sent.length = 0
    for (const path of ACCEPTED) await $.tool.call(CALLS[name]!.input(path) as never)

    expect(sent.map((s) => s.url), name).toEqual(ACCEPTED.map(urlOf))
    expect(new Set(sent.map((s) => s.method)), name).toEqual(new Set([CALLS[name]!.method]))
  }
})

test('every tool reads the key on every call', async ($, on) => {
  let key: string | undefined
  const { sent, tools } = world(on, { key: () => key })

  for (const name of await started($, tools)) {
    sent.length = 0
    const method = CALLS[name]!.method
    key = `tskey-${name}-one`
    await $.tool.call(CALLS[name]!.input('/tailnet/-/keys?all=true') as never)
    key = `tskey-${name}-two`
    await $.tool.call(CALLS[name]!.input('/tailnet/-/keys/k1?x=1') as never)

    expect(
      sent.map((s) => ({ url: s.url, auth: s.headers?.Authorization, method: s.method })),
      name,
    ).toEqual([
      { url: 'https://api.tailscale.com/api/v2/tailnet/-/keys?all=true', auth: `Bearer tskey-${name}-one`, method },
      { url: 'https://api.tailscale.com/api/v2/tailnet/-/keys/k1?x=1', auth: `Bearer tskey-${name}-two`, method },
    ])
  }
})

test('every tool leaves isError unset on success and sets it on an error status', async ($, on) => {
  const ok = world(on, { text: '{"ok":true}' })
  for (const name of await started($, ok.tools)) {
    const result = await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never)

    expect(result.isError, name).toBeUndefined()
    expect(text(result), name).toBe('HTTP 200\n{"ok":true}')
  }
})

test('every tool returns an error status from the API as an error result', async ($, on) => {
  const failing = world(on, { status: 403, text: '{"message":"forbidden"}' })
  for (const name of await started($, failing.tools)) {
    const result = await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never)

    expect(result.isError, name).toBe(true)
    expect(text(result), name).toBe('HTTP 403\n{"message":"forbidden"}')
  }
})
