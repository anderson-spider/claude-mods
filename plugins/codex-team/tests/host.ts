// The host fake the plugin's tests share: records the tools the plugin registers and answers the events around them.
import type { On } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { agents, fakeRun, ok, text } from './fake-run'

export type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }

/** The MCP name the host gives a tool this plugin registers. */
export const id = (name: string) => `mcp__codex-team__${name}`

/** A host that records each registered tool. Add handlers here for the other events the plugin uses (`env.get`, `http.fetch`). */
export function world(on: On) {
  const tools: Tool[] = []

  on('tool.register', (_$, e) => (tools.push(e as unknown as Tool), { value: { tool: id(e.name) } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  return { tools }
}

/** Starts the session, so the plugin registers its tools, and returns their names. */
export async function started($: { session: { start: (e: never) => Promise<unknown> } }, tools: Tool[]): Promise<string[]> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(tools.length).toBeGreaterThan(0)

  return tools.map((tool) => tool.name)
}

/** A dispatch's host boundary, including environment, settings, HTTP, clock and runner. No real requests or commands. */
export function dispatchWorld(on: On, key: string, declared?: 'project' | 'local') {
  const { tools } = world(on)
  const settings: string[] = []
  const envReads: string[] = []
  const requests: { url: string; body?: string; headers?: Record<string, string> }[] = []
  const writes: string[] = []
  const logs: string[] = []
  const { run, calls } = fakeRun([
    [['mkdir'], text('')], agents([]),
    [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'w1:p1' } })],
    [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})],
  ])
  mock.clock(on)
  on('env.get', (_$, e) => {
    envReads.push(e.name)
    const env: Record<string, string> = { HOME: '/home/u', HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1', JEV_API_KEY: key }
    return { value: env[e.name] }
  })
  on('session.root', () => ({ value: '/repo' }))
  on('settings.read', (_$, e) => {
    settings.push(e.source ?? 'merged')
    return { value: e.source === declared ? { env: { JEV_API_KEY: key } } : {} } as never
  })
  on('http.fetch', (_$, e) => {
    requests.push({ url: e.url, body: e.init?.body, headers: e.init?.headers })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: {
      difficulty: { probabilities: { '0': 1 } }, duration: { probabilities: { '0': 1 } }, scope: { probabilities: { '0': 1 } },
    } }) } }
  })
  on('process.run', async (_$, e) => ({ value: { ...await run(e.argv), isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.write', (_$, e) => { writes.push(e.text); return { value: undefined } })
  on('ui.log', (_$, e) => { logs.push(e.text); return { value: undefined } })
  return { tools, calls, envReads, settings, requests, writes, logs }
}
