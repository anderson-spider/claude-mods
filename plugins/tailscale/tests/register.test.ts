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

const KEY = 'tskey-test'
/** The plugin's options with the key set: what a user stores in their plugin options. */
const ON = { options: { apiKey: KEY } }
const OFF = { options: {} }

type Settings = Record<string, unknown>

/** A host with a fake Tailscale API behind `http.fetch` and the repository's settings (`project`, `local`) behind `settings.read`; `flags.settingsFail` makes them unreadable. */
function world(on: On, opts: { project?: Settings; local?: Settings; text?: string; status?: number; fetchError?: string } = {}) {
  const sent: Sent[] = []
  const tools: Tool[] = []
  /** Mutable, so one test can change the repository's settings or the API's answer between calls. */
  const host = { ...opts, settingsFail: false }

  on('settings.read', (_$, e) => {
    if (host.settingsFail) throw new Error('settings unreadable')
    return { value: (e.source === 'project' ? host.project : e.source === 'local' ? host.local : undefined) ?? {} } as never
  })
  on('tool.register', (_$, e) => (tools.push(e as unknown as Tool), { value: { tool: id(e.name) } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_$, e) => {
    sent.push({ url: e.url, method: e.init?.method, headers: e.init?.headers, body: e.init?.body })
    if (host.fetchError) throw new Error(host.fetchError)
    const status = host.status ?? 200

    return { value: { status, ok: status < 400, headers: {}, text: host.text ?? '{}' } }
  })

  return { sent, tools, host }
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
  test(`session start registers ${name}`, ON, async ($, on) => {
    const { tools } = world(on)
    await started($, tools)

    expect(tools.map((t) => t.name)).toContain(name)
  })
}

test('every registered tool has a host case in CALLS', ON, async ($, on) => {
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

test('each tool keeps its tool and schema descriptions within the prompt budget', ON, async ($, on) => {
  const { tools } = world(on)
  await started($, tools)

  for (const tool of tools) expect(descriptionChars(tool), tool.name).toBeLessThanOrEqual(TOOL_BUDGET)
})

test('every tool that takes a path describes it the same way', ON, async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  const paths = tools.map((t) => t.inputSchema.properties.path?.description).filter((d) => d !== undefined)

  expect(paths.length).toBeGreaterThan(0)
  for (const description of paths) {
    expect(description).toBe(paths[0])
    expect(description).toContain('https://api.tailscale.com/api/v2')
  }
})

test('the tool descriptions state their rules', ON, async ($, on) => {
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

test('get sends a GET with the key, redacts secrets and keeps only the asked fields', ON, async ($, on) => {
  const { sent } = world(on, { text: JSON.stringify({ devices: [{ hostname: 'a', os: 'linux', nodeKey: 'nodekey:y' }] }) })

  const result = await $.tool.call({ tool: GET, path: '/tailnet/-/devices', fields: ['hostname', 99, 'nodeKey'] } as never)

  expect(sent).toHaveLength(1)
  expect(sent[0]?.url).toBe('https://api.tailscale.com/api/v2/tailnet/-/devices')
  expect(sent[0]?.method).toBe('GET')
  expect(sent[0]?.headers?.Authorization).toBe(`Bearer ${KEY}`)
  expect(text(result)).toContain('"hostname":"a"')
  expect(text(result)).not.toContain('nodekey')
  expect(text(result)).not.toContain('linux')
})

test('get ignores a fields value that is not an array', ON, async ($, on) => {
  world(on, { text: JSON.stringify({ hostname: 'a', os: 'linux' }) })

  const result = await $.tool.call({ tool: GET, path: '/device/1', fields: 'hostname' } as never)

  expect(text(result)).toContain('linux')
})

test('write denies a method that is not a write and sends nothing', ON, async ($, on) => {
  const { sent } = world(on)

  const denied = await $.tool.call({ tool: WRITE, method: 'GET', path: '/tailnet/-/devices' } as never)

  expect(denied.deny).toMatch(/Invalid method: GET/)
  expect(sent).toEqual([])
})

test('write checks the method before the key: a bad method is denied even without a key', OFF, async ($, on) => {
  const { sent } = world(on)

  const denied = await $.tool.call({ tool: WRITE, method: 'get', path: '/tailnet/-/devices' } as never)

  expect(denied.deny).toMatch(/Invalid method: GET\. Use POST, PUT, PATCH, DELETE\./)
  expect(denied.isError).toBeUndefined()
  expect(sent).toEqual([])
})

test('write upper-cases the method, passes If-Match and does not redact the response', ON, async ($, on) => {
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

test('write ignores an ifMatch that is not a string', ON, async ($, on) => {
  const { sent } = world(on)

  await $.tool.call({ tool: WRITE, method: 'PUT', path: '/device/1/tags', body: {}, ifMatch: 5 } as never)

  expect(sent[0]?.headers?.['If-Match']).toBeUndefined()
})

test('write sends every allowed DELETE, whatever the case of the method', ON, async ($, on) => {
  const { sent } = world(on)

  for (const path of ALLOWED_DELETES) {
    const result = await $.tool.call({ tool: WRITE, method: 'delete', path } as never)
    expect(result.isError, path).toBeUndefined()
  }

  expect(sent.map((s) => [s.method, s.url])).toEqual(ALLOWED_DELETES.map((p) => ['DELETE', urlOf(p)]))
})

test('write refuses to delete the whole tailnet', ON, async ($, on) => {
  const { sent } = world(on)

  const result = await $.tool.call({ tool: WRITE, method: 'DELETE', path: '/tailnet/example.com' } as never)

  expect(result.isError).toBe(true)
  expect(text(result)).toMatch(/entire tailnet/)
  expect(sent).toEqual([])
})

test('write refuses every rejected path for DELETE too, so no smuggled path deletes the whole tailnet', ON, async ($, on) => {
  const { sent } = world(on)

  for (const path of REJECTED) {
    const result = await $.tool.call({ tool: WRITE, method: 'DELETE', path } as never)

    expect(result.isError, JSON.stringify(path)).toBe(true)
    expect(text(result), JSON.stringify(path)).toBe(invalidPathText(path))
  }

  expect(sent).toEqual([])
})

// The tests below run once per registered tool: a new tool adds its entry to CALLS and nothing else.

const MISSING = 'The tailscale apiKey option is not set. Set it in the plugin options (/plugin, tailscale, configure).'

test('every tool reports a missing apiKey option, tells where to set it and sends nothing', OFF, async ($, on) => {
  const { sent, tools } = world(on)

  for (const name of await started($, tools)) {
    const result = await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never)

    expect(result.isError, name).toBe(true)
    expect(text(result), name).toBe(MISSING)
  }

  expect(sent).toEqual([])
})

test('a blank or malformed apiKey is refused without echoing it', { options: { apiKey: '   ' } }, async ($, on) => {
  const { sent, tools } = world(on)
  for (const name of await started($, tools)) {
    expect(text(await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never)), name).toBe(MISSING)
  }
  expect(sent).toEqual([])
})

const BAD = 'tskey bad\nvalue'
test('an apiKey that is not printable ASCII without spaces is refused and never echoed', { options: { apiKey: BAD } }, async ($, on) => {
  const { sent, tools } = world(on)
  for (const name of await started($, tools)) {
    const result = await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never)
    expect(result.isError, name).toBe(true)
    expect(text(result), name).toMatch(/not a valid key/)
    expect(text(result), name).not.toContain('bad')
  }
  expect(sent).toEqual([])
})

test('a key checked before the path: a missing key wins over an invalid path', OFF, async ($, on) => {
  const { sent, tools } = world(on)
  for (const name of await started($, tools)) {
    expect(text(await $.tool.call(CALLS[name]!.input('//bad') as never)), name).toBe(MISSING)
  }
  expect(sent).toEqual([])
})

test('the key is checked against the repository settings on every call', ON, async ($, on) => {
  const { sent, tools, host } = world(on)
  const declared = { pluginConfigs: { 'tailscale@spider-claude-mods': { options: { apiKey: 'repo-key-123' } } } }

  for (const name of await started($, tools)) {
    sent.length = 0
    host.project = undefined
    const first = await $.tool.call(CALLS[name]!.input('/tailnet/-/keys?all=true') as never)
    host.project = declared
    const second = await $.tool.call(CALLS[name]!.input('/tailnet/-/keys/k1?x=1') as never)

    expect(first.isError, name).toBeUndefined()
    expect(second.isError, name).toBe(true)
    expect(text(second), name).toMatch(/repository settings declare/)
    expect(sent.map((s) => [s.url, s.headers?.Authorization]), name).toEqual([
      ['https://api.tailscale.com/api/v2/tailnet/-/keys?all=true', `Bearer ${KEY}`],
    ])
  }
})

test('an apiKey that the project or local settings declare is refused, and the key is not sent', ON, async ($, on) => {
  const declared = (plugin: string) => ({ pluginConfigs: { [plugin]: { options: { apiKey: 'repo-key-123' } } } })
  const { sent, tools, host } = world(on)
  for (const [project, local] of [
    [declared('tailscale'), undefined],
    [declared('tailscale@spider-claude-mods'), undefined],
    [undefined, declared('tailscale@inline')],
  ]) {
    host.project = project
    host.local = local
    for (const name of await started($, tools)) {
      const result = await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never)
      expect(result.isError, name).toBe(true)
      expect(text(result), name).toMatch(/repository settings declare/)
      expect(text(result), name).not.toContain('repo-key-123')
    }
  }
  expect(sent).toEqual([])
})

test('options of another plugin or another name in the repository settings do not refuse the key', ON, async ($, on) => {
  const { sent, tools } = world(on, {
    project: { pluginConfigs: { tailscale: { options: { other: 1 } }, crew: { options: { apiKey: 'x' } }, tailscalex: { options: { apiKey: 'x' } } } },
  })
  for (const name of await started($, tools)) {
    sent.length = 0
    const result = await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never)
    expect(result.isError, name).toBeUndefined()
    expect(sent, name).toHaveLength(1)
  }
})

test('settings that cannot be read refuse the call and send nothing', ON, async ($, on) => {
  const { sent, tools, host } = world(on)
  host.settingsFail = true
  for (const name of await started($, tools)) {
    const result = await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never)
    expect(result.isError, name).toBe(true)
    expect(text(result), name).toMatch(/could not be read/)
  }
  expect(sent).toEqual([])
})

test('no output carries the key: success, API error, failed fetch, refusals', ON, async ($, on) => {
  const { tools, host } = world(on)
  const results: string[] = []
  for (const answer of [{}, { status: 401, text: '{"message":"bad"}' }, { fetchError: 'connection reset' }]) {
    Object.assign(host, { status: undefined, text: undefined, fetchError: undefined }, answer)
    for (const name of await started($, tools)) {
      results.push(text(await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never)))
      results.push(text(await $.tool.call(CALLS[name]!.input('//bad') as never)))
    }
  }
  // the key-related refusals: a key the repository declares, then settings that cannot be read
  Object.assign(host, { status: undefined, text: undefined, fetchError: undefined })
  host.project = { pluginConfigs: { tailscale: { options: { apiKey: KEY } } } }
  for (const name of await started($, tools)) {
    const refused = text(await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never))
    expect(refused, name).toMatch(/repository settings declare/)
    results.push(refused)
  }
  host.project = undefined
  host.settingsFail = true
  for (const name of await started($, tools)) {
    const refused = text(await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never))
    expect(refused, name).toMatch(/could not be read/)
    results.push(refused)
  }
  expect(results.filter((r) => r.startsWith('Call failed'))).not.toEqual([])
  for (const out of results) expect(out).not.toContain(KEY)
})

test('an apiKey with surrounding spaces is sent trimmed', { options: { apiKey: ` ${KEY} ` } }, async ($, on) => {
  const { sent, tools } = world(on)
  for (const name of await started($, tools)) {
    sent.length = 0
    await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never)
    expect(sent.map((s) => s.headers?.Authorization), name).toEqual([`Bearer ${KEY}`])
  }
})

test('every tool refuses a rejected path and sends nothing', ON, async ($, on) => {
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

test('every tool sends an accepted path under the API, query string included', ON, async ($, on) => {
  const { sent, tools } = world(on)

  for (const name of await started($, tools)) {
    sent.length = 0
    for (const path of ACCEPTED) await $.tool.call(CALLS[name]!.input(path) as never)

    expect(sent.map((s) => s.url), name).toEqual(ACCEPTED.map(urlOf))
    expect(new Set(sent.map((s) => s.method)), name).toEqual(new Set([CALLS[name]!.method]))
  }
})

test('every tool sends the apiKey option as the bearer token on every call, and nowhere else', ON, async ($, on) => {
  const { sent, tools } = world(on)

  for (const name of await started($, tools)) {
    sent.length = 0
    await $.tool.call(CALLS[name]!.input('/tailnet/-/keys?all=true') as never)
    await $.tool.call(CALLS[name]!.input('/tailnet/-/keys/k1?x=1') as never)

    expect(sent.map((s) => s.headers?.Authorization), name).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`])
    for (const s of sent) {
      expect(s.url, name).not.toContain(KEY)
      expect(s.body ?? '', name).not.toContain(KEY)
      expect(Object.entries(s.headers ?? {}).filter(([, v]) => v.includes(KEY)).map(([k]) => k), name).toEqual(['Authorization'])
    }
  }
})

test('every tool leaves isError unset on success and sets it on an error status', ON, async ($, on) => {
  const ok = world(on, { text: '{"ok":true}' })
  for (const name of await started($, ok.tools)) {
    const result = await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never)

    expect(result.isError, name).toBeUndefined()
    expect(text(result), name).toBe('HTTP 200\n{"ok":true}')
  }
})

test('every tool returns an error status from the API as an error result', ON, async ($, on) => {
  const failing = world(on, { status: 403, text: '{"message":"forbidden"}' })
  for (const name of await started($, failing.tools)) {
    const result = await $.tool.call(CALLS[name]!.input('/tailnet/-/devices') as never)

    expect(result.isError, name).toBe(true)
    expect(text(result), name).toBe('HTTP 403\n{"message":"forbidden"}')
  }
})
