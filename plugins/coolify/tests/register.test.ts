import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { ACCEPTED, DELETES, REJECTED, invalidPathText, urlOf } from './paths'

type Sent = { url: string; method?: string; headers?: Record<string, string>; body?: string }
type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }
type Input = Record<string, unknown>

const id = (name: string) => `mcp__coolify__${name}`
const GET = id('coolify_get')
const WRITE = id('coolify_write')

/** Per registered tool: a valid call for a given path. A new tool adds one entry here and its own tests. */
const CALLS: Record<string, { method: string; input: (path: unknown) => Input }> = {
  coolify_get: { method: 'GET', input: (path) => ({ tool: GET, path }) },
  coolify_write: { method: 'PATCH', input: (path) => ({ tool: WRITE, method: 'patch', path, body: {} }) },
}

const KEY = '1|coolify-test-token'
const URL_OPTION = 'https://coolify.example.com'
/** The plugin's options with both set: what a user stores in their plugin options. */
const ON = { options: { url: URL_OPTION, apiKey: KEY } }
const NO_KEY = { options: { url: URL_OPTION } }

type Settings = Record<string, unknown>

/** A host with a fake Coolify API behind `http.fetch` and the user's and repository's settings (`user`, `project`, `local`) behind `settings.read`; `settingsFail` makes them unreadable. */
function world(on: On, opts: { user?: Settings; project?: Settings; local?: Settings; text?: string; status?: number; fetchError?: string } = {}) {
  const sent: Sent[] = []
  const tools: Tool[] = []
  /** Mutable, so one test can change the repository's settings or the API's answer between calls. */
  const host = { ...opts, settingsFail: false }

  on('settings.read', (_$, e) => {
    if (host.settingsFail) throw new Error('settings unreadable')
    return { value: (e.source === 'user' ? host.user : e.source === 'project' ? host.project : e.source === 'local' ? host.local : undefined) ?? {} } as never
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
async function started($: { session: { start: (e: never) => Promise<unknown> } }, tools: Tool[]): Promise<string[]> {
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

test('the tool descriptions state their rules', ON, async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

  expect(byName.coolify_get!.description).toContain('environment variable values are filtered')
  const write = byName.coolify_write!
  expect(write.description).toContain('after user confirmation')
  expect(write.description).toContain('POST /deploy?uuid=')
  expect(write.description).toContain('DELETE /projects/{uuid}')
  expect(write.inputSchema.properties.confirm!.description).toContain('user has agreed to delete it')
  expect(write.inputSchema.properties.path!.description).toBe(byName.coolify_get!.inputSchema.properties.path!.description)
})

test('get sends a GET with the key, redacts secrets and keeps only the asked fields', ON, async ($, on) => {
  const { sent } = world(on, { text: JSON.stringify([{ name: 'web', uuid: 'p1', postgres_password: 'p4ss' }]) })

  const result = await $.tool.call({ tool: GET, path: '/projects', fields: ['name', 99, 'postgres_password'] } as never)

  expect(sent).toEqual([{ url: 'https://coolify.example.com/api/v1/projects', method: 'GET', headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' }, body: undefined }])
  expect(text(result)).toBe('HTTP 200\n[{"name":"web"}]')
})

test('write creates a project with a JSON body and returns the answer whole', ON, async ($, on) => {
  const { sent } = world(on, { status: 201, text: '{"uuid":"p1"}' })

  const result = await $.tool.call({ tool: WRITE, method: 'post', path: '/projects', body: { name: 'web' } } as never)

  expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([['POST', 'https://coolify.example.com/api/v1/projects', '{"name":"web"}']])
  expect(text(result)).toBe('HTTP 201\n{"uuid":"p1"}')
})

test('write deploys through POST /deploy with its query string', ON, async ($, on) => {
  const { sent } = world(on)

  await $.tool.call({ tool: WRITE, method: 'POST', path: '/deploy?uuid=app1&force=true' } as never)

  expect(sent.map((s) => [s.method, s.url])).toEqual([['POST', 'https://coolify.example.com/api/v1/deploy?uuid=app1&force=true']])
})

test('write denies a method that is not a write, before the key, and sends nothing', NO_KEY, async ($, on) => {
  const { sent } = world(on)

  const denied = await $.tool.call({ tool: WRITE, method: 'get', path: '/projects' } as never)

  expect(denied.deny).toBe('Invalid method: GET. Use POST, PUT, PATCH, DELETE.')
  expect(sent).toEqual([])
})

test('write sends a DELETE only when confirm repeats the id at the end of the path', ON, async ($, on) => {
  const { sent } = world(on)

  for (const [path, target] of DELETES) {
    for (const confirm of [undefined, '', 'other', target.toUpperCase() === target ? target.toLowerCase() : target.toUpperCase(), 5]) {
      const denied = await $.tool.call({ tool: WRITE, method: 'delete', path, confirm } as never)
      expect(denied.deny, `${path} ${String(confirm)}`).toBe(`DELETE needs confirm set to the id at the end of the path ("${target}"), after the user agrees to delete it.`)
    }
  }
  expect(sent).toEqual([])

  for (const [path, target] of DELETES) {
    const result = await $.tool.call({ tool: WRITE, method: 'DELETE', path, confirm: target } as never)
    expect(result.isError, path).toBeUndefined()
  }
  expect(sent.map((s) => [s.method, s.url])).toEqual(DELETES.map(([p]) => ['DELETE', urlOf(p)]))
})

test('write denies a DELETE whose path names no id, even without a key', NO_KEY, async ($, on) => {
  const { sent } = world(on)

  for (const path of ['/', 42]) {
    const denied = await $.tool.call({ tool: WRITE, method: 'DELETE', path, confirm: '' } as never)
    expect(denied.deny).toBe('DELETE needs confirm set to the id at the end of the path, after the user agrees to delete it.')
  }
  expect(sent).toEqual([])
})

test('write refuses the API and MCP toggles and token creation', ON, async ($, on) => {
  const { sent } = world(on)

  for (const path of ['/disable', '/mcp/enable', '/security/integration-tokens']) {
    const result = await $.tool.call({ tool: WRITE, method: 'POST', path } as never)
    expect(result.isError, path).toBe(true)
    expect(text(result), path).toMatch(/not done by this tool/)
  }
  expect(sent).toEqual([])
})

// The tests below run once per registered tool: a new tool adds its entry to CALLS and nothing else.

const MISSING_KEY = 'The coolify apiKey option is not set. Set it in the plugin options (/plugin, coolify, configure).'

test('every tool reports a missing apiKey option, tells where to set it and sends nothing', NO_KEY, async ($, on) => {
  const { sent, tools } = world(on)

  for (const name of await started($, tools)) {
    const result = await $.tool.call(CALLS[name]!.input('/projects') as never)

    expect(result.isError, name).toBe(true)
    expect(text(result), name).toBe(MISSING_KEY)
  }
  expect(sent).toEqual([])
})

test('every tool reports a missing url option and sends nothing', { options: { apiKey: KEY } }, async ($, on) => {
  const { sent, tools } = world(on)
  for (const name of await started($, tools)) {
    expect(text(await $.tool.call(CALLS[name]!.input('/projects') as never)), name).toMatch(/url option is not set/)
  }
  expect(sent).toEqual([])
})

test('every tool refuses a plain-http url, so the token never travels in clear text', { options: { apiKey: KEY, url: 'http://coolify.example.com' } }, async ($, on) => {
  const { sent, tools } = world(on)
  for (const name of await started($, tools)) {
    const result = await $.tool.call(CALLS[name]!.input('/projects') as never)
    expect(result.isError, name).toBe(true)
    expect(text(result), name).toMatch(/must be an https address/)
  }
  expect(sent).toEqual([])
})

const BAD = 'bad token\nvalue'
test('an apiKey that is not printable ASCII without spaces is refused and never echoed', { options: { apiKey: BAD, url: URL_OPTION } }, async ($, on) => {
  const { sent, tools } = world(on)
  for (const name of await started($, tools)) {
    const result = await $.tool.call(CALLS[name]!.input('/projects') as never)
    expect(result.isError, name).toBe(true)
    expect(text(result), name).toMatch(/not a valid token/)
    expect(text(result), name).not.toContain('bad')
  }
  expect(sent).toEqual([])
})

test('the options are checked against the repository settings on every call', ON, async ($, on) => {
  const { sent, tools, host } = world(on)
  const declared = { pluginConfigs: { 'coolify@spider-claude-mods': { options: { url: 'https://evil.example' } } } }

  for (const name of await started($, tools)) {
    sent.length = 0
    host.project = undefined
    const first = await $.tool.call(CALLS[name]!.input('/projects') as never)
    host.project = declared
    const second = await $.tool.call(CALLS[name]!.input('/projects') as never)

    expect(first.isError, name).toBeUndefined()
    expect(second.isError, name).toBe(true)
    expect(text(second), name).toMatch(/repository settings declare/)
    expect(sent.map((s) => s.url), name).toEqual(['https://coolify.example.com/api/v1/projects'])
  }
})

test('a url or apiKey that the project or local settings declare is refused, and nothing is sent', ON, async ($, on) => {
  const declared = (plugin: string, option: string) => ({ pluginConfigs: { [plugin]: { options: { [option]: 'repo-value-123' } } } })
  const { sent, tools, host } = world(on)
  for (const [project, local] of [
    [declared('coolify', 'apiKey'), undefined],
    [declared('coolify@spider-claude-mods', 'url'), undefined],
    [undefined, declared('coolify@inline', 'url')],
  ]) {
    host.project = project
    host.local = local
    for (const name of await started($, tools)) {
      const result = await $.tool.call(CALLS[name]!.input('/projects') as never)
      expect(result.isError, name).toBe(true)
      expect(text(result), name).toMatch(/repository settings declare/)
      expect(text(result), name).not.toContain('repo-value-123')
    }
  }
  expect(sent).toEqual([])
})

test('project settings that repeat the user settings, as with Claude opened in the home folder, do not refuse the call', ON, async ($, on) => {
  const home = { pluginConfigs: { 'coolify@spider-claude-mods': { options: { url: URL_OPTION } } } }
  const { sent, tools } = world(on, { user: home, project: home })
  for (const name of await started($, tools)) {
    sent.length = 0
    expect((await $.tool.call(CALLS[name]!.input('/projects') as never)).isError, name).toBeUndefined()
    expect(sent.map((s) => s.url), name).toEqual(['https://coolify.example.com/api/v1/projects'])
  }
})

test('options of another plugin or another name in the repository settings do not refuse the call', ON, async ($, on) => {
  const { sent, tools } = world(on, {
    project: { pluginConfigs: { coolify: { options: { other: 1 } }, 'other-plugin': { options: { url: 'x' } }, coolifyx: { options: { apiKey: 'x' } } } },
  })
  for (const name of await started($, tools)) {
    sent.length = 0
    expect((await $.tool.call(CALLS[name]!.input('/projects') as never)).isError, name).toBeUndefined()
    expect(sent, name).toHaveLength(1)
  }
})

test('settings that cannot be read refuse the call and send nothing', ON, async ($, on) => {
  const { sent, tools, host } = world(on)
  host.settingsFail = true
  for (const name of await started($, tools)) {
    const result = await $.tool.call(CALLS[name]!.input('/projects') as never)
    expect(result.isError, name).toBe(true)
    expect(text(result), name).toMatch(/could not be read/)
  }
  expect(sent).toEqual([])
})

test('no output carries the key: success, API error, failed fetch, refusals', ON, async ($, on) => {
  const { tools, host } = world(on)
  const results: string[] = []
  for (const answer of [{}, { status: 401, text: '{"message":"Unauthenticated."}' }, { fetchError: 'connection reset' }]) {
    Object.assign(host, { status: undefined, text: undefined, fetchError: undefined }, answer)
    for (const name of await started($, tools)) {
      results.push(text(await $.tool.call(CALLS[name]!.input('/projects') as never)))
      results.push(text(await $.tool.call(CALLS[name]!.input('//bad') as never)))
    }
  }
  Object.assign(host, { status: undefined, text: undefined, fetchError: undefined })
  host.project = { pluginConfigs: { coolify: { options: { apiKey: KEY } } } }
  for (const name of await started($, tools)) results.push(text(await $.tool.call(CALLS[name]!.input('/projects') as never)))
  host.project = undefined
  host.settingsFail = true
  for (const name of await started($, tools)) results.push(text(await $.tool.call(CALLS[name]!.input('/projects') as never)))

  expect(results.filter((r) => r.startsWith('Call failed'))).not.toEqual([])
  for (const out of results) expect(out).not.toContain(KEY)
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

test('every tool sends an accepted path under the instance API, query string included', ON, async ($, on) => {
  const { sent, tools } = world(on)

  for (const name of await started($, tools)) {
    sent.length = 0
    for (const path of ACCEPTED) await $.tool.call(CALLS[name]!.input(path) as never)

    expect(sent.map((s) => s.url), name).toEqual(ACCEPTED.map(urlOf))
    expect(new Set(sent.map((s) => s.method)), name).toEqual(new Set([CALLS[name]!.method]))
  }
})

test('every tool sends the apiKey option as the bearer token, and nowhere else', ON, async ($, on) => {
  const { sent, tools } = world(on)

  for (const name of await started($, tools)) {
    sent.length = 0
    await $.tool.call(CALLS[name]!.input('/projects') as never)

    expect(sent.map((s) => s.headers?.Authorization), name).toEqual([`Bearer ${KEY}`])
    for (const s of sent) {
      expect(s.url, name).not.toContain(KEY)
      expect(s.body ?? '', name).not.toContain(KEY)
      expect(Object.entries(s.headers ?? {}).filter(([, v]) => v.includes(KEY)).map(([k]) => k), name).toEqual(['Authorization'])
    }
  }
})

test('every tool leaves isError unset on success and returns an error status as an error result', ON, async ($, on) => {
  const { tools, host } = world(on, { text: '{"ok":true}' })
  for (const name of await started($, tools)) {
    host.status = undefined
    const ok = await $.tool.call(CALLS[name]!.input('/projects') as never)
    expect(ok.isError, name).toBeUndefined()
    expect(text(ok), name).toBe('HTTP 200\n{"ok":true}')

    host.status = 403
    const failed = await $.tool.call(CALLS[name]!.input('/projects') as never)
    expect(failed.isError, name).toBe(true)
    expect(text(failed), name).toBe('HTTP 403\n{"ok":true}')
  }
})
