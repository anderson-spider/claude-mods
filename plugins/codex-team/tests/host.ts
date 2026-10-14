// The host fake the plugin's tests share: records the tools the plugin registers and answers the events around them.
import type { On } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { agents, fakeRun, ok, text } from './fake-run'
import type { Run } from '../hooks/herdr'

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
export function dispatchWorld(on: On, key: string, declared?: 'project' | 'local', runner?: Run) {
  const { tools } = world(on)
  const settings: string[] = []
  const envReads: string[] = []
  const requests: { url: string; body?: string; headers?: Record<string, string> }[] = []
  const writes: string[] = []
  const logs: string[] = []
  const { run, calls } = fakeRun([
    [['mkdir'], text('')], [['dagr', '--version'], text('dagr 0.3.1')], agents([]),
    [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'w1:p1' } })],
    [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})],
  ])
  mock.clock(on)
  const tasks = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: tasks.get(e.key) }))
  on('store.delete', (_$, e) => { tasks.delete(e.key); return { value: undefined } })
  on('store.set', (_$, e) => { tasks.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_$, e) => {
    envReads.push(e.name)
    const env: Record<string, string> = { HOME: '/home/u', HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1', HERDR_PANE_ID: 'lead', JEV_API_KEY: key }
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
  on('process.run', async (_$, e) => ({ value: { ...await (runner ?? run)(e.argv), isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_$, e) => { writes.push(e.text); return { value: undefined } })
  on('ui.log', (_$, e) => { logs.push(e.text); return { value: undefined } })
  return { tools, calls, envReads, settings, requests, writes, logs }
}

/** Mutable plan metadata and publication failures for post-result observation tests. */
export function planWorld(on: On) {
  world(on)
  const entry = { name: 'feature.md', kind: 'file' as const, mtimeMs: 1, size: 1, isLink: false }
  const files = new Map<string, string>([['/repo/.crew/plans/feature.md', '## Steps\n### Feature\n- feature (main, after: —) Ship — state: implementing']])
  const writes: string[] = [], calls: string[][] = [], lists: string[] = [], reads: string[] = [], logs: string[] = []
  const faults: { at?: 'root' | 'list' | 'write' | 'check' | 'move'; log?: boolean } = {}
  mock.clock(on)
  on('env.get', (_$, e) => ({ value: e.name === 'HERDR_ENV' ? '1' : e.name === 'HERDR_PANE_ID' ? 'lead' : undefined }))
  on('session.root', () => { if (faults.at === 'root') throw new Error('root failed'); return { value: '/repo' } })
  on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.crew/plans' || files.has(e.path) }))
  on('fs.list', (_$, e) => { lists.push(e.path); if (faults.at === 'list') throw new Error('list failed'); return { value: [entry] } })
  on('fs.read', (_$, e) => { reads.push(e.path); return { value: files.get(e.path)! } })
  on('fs.write', (_$, e) => { if (faults.at === 'write') throw new Error('write failed'); writes.push(e.path); files.set(e.path, e.text); return { value: undefined } })
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    const failed = faults.at === 'check' && e.argv[1] === 'check' || faults.at === 'move' && e.argv[0] === 'mv'
    if (e.argv[0] === 'mv' && !failed) files.set(e.argv[2]!, files.get(e.argv[1]!)!)
    const stdout = e.argv[0] === 'herdr' ? '{"result":{"agents":[]}}' : e.argv[1] === 'check' ? '[]' : ''
    return { value: { exitCode: failed ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.log', (_$, e) => { logs.push(e.text); if (faults.log) throw new Error('log failed'); return { value: undefined } })
  on('tool.call', { tool: 'Write' }, () => ({ result: 'saved' }))
  return { entry, files, writes, calls, lists, reads, logs, faults }
}
