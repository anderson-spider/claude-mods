// The host fake the plugin's tests share: records the tools the plugin registers and answers the events around them.
import type { Hook, On, Register } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { agents, fakeRun, ok, text } from './fake-run'
import type { Run } from '../hooks/herdr'
import type { ReportStat } from '../hooks/auto-close'
import type { TeamIo } from '../hooks/team'

export type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }

/** The MCP name the host gives a tool this plugin registers. */
export const id = (name: string) => `mcp__codex-team__${name}`

/** Each hook gets its own expiring host; only its own timer callbacks extend its access. */
export function scopedHost(register: Register, io: TeamIo) {
  type Dollar = Parameters<Hook<'session.start'>>[0]
  const tools: Tool[] = [], scheduled: { fn: () => unknown; active: boolean; repeat: boolean }[] = []
  const schedule = (repeat: boolean) => (ms: number, fn: () => unknown) => {
    if (ms !== 2_000) throw new Error('wrong report interval')
    const timer = { fn, active: true, repeat }; scheduled.push(timer)
    return { cancel: () => { timer.active = false } }
  }
  const base = {
    tool: { register: async (tool: Tool) => { tools.push(tool) } },
    process: { run: io.run }, env: { get: async (name: string) => (await io.env() as Record<string, string | undefined>)[name] },
    clock: { every: schedule(true), after: schedule(false), now: io.now, sleep: io.sleep },
    session: { root: io.root }, settings: { read: ({ source }: { source: 'project' | 'local' }) => io.settings(source) },
    http: { fetch: io.jev.fetch }, store: io.store, ui: { log: io.log },
    fs: { stat: io.reports!.stat, read: io.reports!.read, write: io.write, list: async () => [], exists: async (path: string) => !!await io.reports!.stat(path) },
  } as unknown as Dollar
  type Handler = ($: Dollar, e: never, next: (e: never) => Promise<unknown>) => unknown
  const hooks: { event: string; matcher?: { tool?: string | readonly string[] }; handler: Handler }[] = []
  const invalid: string[] = [], armed: string[] = []
  let activeTimers = 0, maxTimers = 0
  const scopedOn = ((event: string, matcher: unknown, handler?: Handler) => {
    hooks.push({ event, matcher: handler ? matcher as { tool?: string } : undefined, handler: handler ?? matcher as Handler })
  }) as unknown as On
  register(scopedOn, {} as never)
  const call = async (event: string, input: Record<string, unknown>) => {
    const hook = hooks.find(hook => hook.event === event && (!hook.matcher?.tool || [hook.matcher.tool].flat().includes(input.tool as string)))!
    let live = true, callbacks = 0
    const dollar = new Proxy({} as Dollar, {
      get(_target, noun: string) {
        const target = (base as unknown as Record<string, unknown>)[noun]
        return new Proxy({}, {
          get(_target, method: string) {
            const fn = (target as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!
            if (!fn) throw new Error(`host method missing: ${noun}.${method}`)
            return (...args: unknown[]) => {
              if (!live && !callbacks) { invalid.push(`${event}:${String(noun)}.${method}`); throw new Error('expired hook host') }
              if (noun === 'clock' && (method === 'every' || method === 'after')) {
                const callback = args[1] as () => unknown
                armed.push(event)
                activeTimers++; maxTimers = Math.max(maxTimers, activeTimers)
                let active = true
                const handle = fn(args[0], async () => {
                  callbacks++
                  try { return await callback() } finally { callbacks--; if (method === 'after' && active) { active = false; activeTimers-- } }
                }) as { cancel: () => void }
                return { cancel: () => { handle.cancel(); if (active) { active = false; activeTimers-- } } }
              }
              return fn(...args)
            }
          },
        })
      },
    })
    try { return await hook.handler(dollar, input as never, async () => event === 'session.start' ? { cwd: input.cwd } : { sessionId: input.sessionId }) }
    finally { live = false }
  }
  const tick = async () => {
    await Promise.all(scheduled.filter(timer => timer.active).map(async timer => {
      if (!timer.repeat) timer.active = false
      await timer.fn()
    }))
  }
  return { call, tick, tools, invalid, armed, timers: () => ({ active: activeTimers, max: maxTimers }) }
}

/** A host that records each registered tool. Add handlers here for the other events the plugin uses (`env.get`, `http.fetch`). */
export function world(on: On) {
  const tools: Tool[] = []

  on('tool.register', (_$, e) => (tools.push(e as unknown as Tool), { value: { tool: id(e.name) } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))

  return { tools }
}

/** Starts the session, so the plugin registers its tools, and returns their names. */
export async function started($: { session: { start: (e: never) => Promise<unknown> } }, tools: Tool[]): Promise<string[]> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(tools.length).toBeGreaterThan(0)

  return tools.map((tool) => tool.name)
}

/** A dispatch's host boundary, including environment, settings, HTTP, clock and runner. No real requests or commands. */
export function dispatchWorld(on: On, key: string, declared?: 'project' | 'local', runner?: Run, over: { settings?: (source?: string) => unknown; body?: string } = {}) {
  const { tools } = world(on)
  const settings: string[] = []
  const envReads: string[] = []
  const requests: { url: string; body?: string; headers?: Record<string, string> }[] = []
  const writes: string[] = []
  const logs: string[] = []
  let accepted = false
  const { run, calls } = fakeRun([
    [['mkdir'], text('')], [['dagr', '--version'], text('dagr 0.3.1')], agents([]),
    [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'w1:p1' } })],
    [['herdr', 'agent', 'start'], () => { accepted = false; return ok({}) }], [['herdr', 'agent', 'prompt'], () => { accepted = true; return ok({}) }],
    [['herdr', 'agent', 'get'], argv => ok({ agent: { name: argv[3], workspace_id: 'w1', pane_id: 'w1:p1', agent: 'codex', ...(accepted ? { agent_session: { kind: 'id', source: 'herdr:codex', value: '12345678-1234-1234-1234-123456789abc' } } : {}) } })],
  ])
  const clock = mock.clock(on)
  const files = new Map<string, { text: string; stat: ReportStat }>()
  const faults: { stat?: boolean; read?: boolean; beforeRead?: () => Promise<void> } = {}
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
    return { value: over.settings ? over.settings(e.source) : e.source === declared ? { env: { JEV_API_KEY: key } } : {} } as never
  })
  on('http.fetch', (_$, e) => {
    requests.push({ url: e.url, body: e.init?.body, headers: e.init?.headers })
    return { value: { status: 200, ok: true, headers: {}, text: over.body ?? JSON.stringify({ answers: {
      difficulty: { probabilities: { '0': 1 } }, duration: { probabilities: { '0': 1 } }, scope: { probabilities: { '0': 1 } }, task_type: { probabilities: { research: 1 } },
    } }) } }
  })
  on('process.run', async (_$, e) => ({ value: { ...await (runner ?? run)(e.argv), isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.stat', (_$, e) => { if (faults.stat || !files.has(e.path)) throw new Error('stat failed'); return { value: files.get(e.path)!.stat } })
  on('fs.read', async (_$, e) => { await faults.beforeRead?.(); if (faults.read || !files.has(e.path)) throw new Error('read failed'); return { value: files.get(e.path)!.text } })
  on('fs.write', (_$, e) => { writes.push(e.text); return { value: undefined } })
  on('ui.log', (_$, e) => { logs.push(e.text); return { value: undefined } })
  return { tools, calls, envReads, settings, requests, writes, logs, tasks, clock, files, faults }
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
