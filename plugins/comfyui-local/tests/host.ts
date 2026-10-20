// The host fake the plugin's tests share: records the tools the plugin registers and answers the events around them.
import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'

export type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }
export type Sent = { url: string; method?: string; body?: string }

/** The MCP name the host gives a tool this plugin registers. */
export const id = (name: string) => `mcp__comfyui-local__${name}`

export const URL_OPTION = 'http://192.168.0.10:8188'
/** The plugin's options with the url set: what a user stores in their plugin options. */
export const ON = { options: { url: URL_OPTION } }

type Settings = Record<string, unknown>

/** A host with a fake ComfyUI behind `http.fetch` (routes as "METHOD path"), curl behind `process.run`, files behind `fs.exists`, `fs.read` and `fs.write`, settings behind `settings.read` and a fixed `clock.now`. */
export function world(on: On, opts: { routes?: Record<string, { status?: number; body: unknown }>; user?: Settings; project?: Settings; local?: Settings; files?: string[]; texts?: Record<string, string> } = {}) {
  const tools: Tool[] = []
  const sent: Sent[] = []
  const processes: string[][] = []
  const written: Record<string, string> = {}
  const host = { ...opts, settingsFail: false }

  on('tool.register', (_$, e) => (tools.push(e as unknown as Tool), { value: { tool: id(e.name) } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('settings.read', (_$, e) => {
    if (host.settingsFail) throw new Error('settings unreadable')
    return { value: (e.source === 'user' ? host.user : e.source === 'project' ? host.project : e.source === 'local' ? host.local : undefined) ?? {} } as never
  })
  on('http.fetch', (_$, e) => {
    const method = e.init?.method ?? 'GET'
    sent.push({ url: e.url, method, body: e.init?.body })
    const path = e.url.startsWith(URL_OPTION) ? e.url.slice(URL_OPTION.length) : e.url
    const route = host.routes?.[`${method} ${path}`]
    if (!route) return { value: { status: 404, ok: false, headers: {}, text: 'not found' } }
    const status = route.status ?? 200
    return { value: { status, ok: status < 400, headers: {}, text: typeof route.body === 'string' ? route.body : JSON.stringify(route.body) } }
  })
  on('process.run', (_$, e) => {
    processes.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify({ name: 'up.png', subfolder: '', type: 'input' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('fs.exists', (_$, e) => ({ value: (host.files ?? []).includes(e.path) }) as never)
  on('fs.read', (_$, e) => {
    const text = host.texts?.[e.path] ?? written[e.path]
    if (text === undefined) throw new Error(`no file ${e.path}`)
    return { value: text } as never
  })
  on('fs.write', (_$, e) => ((written[e.path] = e.text), { value: undefined }) as never)
  on('clock.now', () => ({ value: 0 }) as never)

  return { tools, sent, processes, written, host }
}

/** Starts the session, so the plugin registers its tools, and returns their names. */
export async function started($: { session: { start: (e: never) => Promise<unknown> } }, tools: Tool[]): Promise<string[]> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(tools.length).toBeGreaterThan(0)

  return tools.map((tool) => tool.name)
}
