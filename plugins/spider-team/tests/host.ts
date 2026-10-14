// Shared fake ports and native host boundary. No processes, model calls or network requests run.
import type { AgentInfo, AgentSpec, On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Run, Runtime, IdentityCache, Context } from '../types'
import type { DispatchIo } from '../hooks/dispatch'
import { createBreaker, createGate } from '../hooks/jev'
import { SPECS } from '../hooks/roles'

export const BASE = 'a'.repeat(40)
export const id = (name: string) => `mcp__spider-team__${name}`
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export const row = (id: string, type = 'spider-team:analyst', parentId?: string): AgentInfo => ({ id, type, parentId, description: 'fixture', status: 'running' })
export function runFixture(patch: Partial<Run> = {}): Run {
  const role = patch.role ?? 'analyst', spec = SPECS[role]
  return {
    key: 1, toolId: 'dispatch-1', agentId: 'child-1', role,
    taskHash: '12345678', requested: {}, selected: { model: spec.model, effort: spec.effort }, forwarded: { model: spec.model, effort: spec.effort },
    profile: null, source: 'default', cap: false, jevAsked: false, jevReason: 'no-key', dimensions: {}, dimensionsUsed: false, expected: null, taskType: null,
    root: '/repo', home: '/home/u', base: BASE, commonDir: '/repo/.git', status: 'running', finished: false,
    observed: [], turns: {}, durationMs: null, handbackChars: null, receiptChars: null, ...patch,
  }
}
export function ports() {
  const files = new Map<string, string>(), calls: string[][] = [], writes: string[] = [], reads: string[] = [], logs: string[] = []
  const requests: { url: string; body: string; headers: Record<string, string> }[] = []
  const settingsReads: string[] = [], agents: AgentInfo[] = []
  const faults = { write: false, list: false, settings: false, process: false, truncate: false, top: '', branch: '', common: '', link: '', ancestor: false, http: 200 }
  const changes = { committed: ['committed.ts'], staged: ['staged.ts'], unstaged: ['unstaged.ts'], untracked: ['new file.ts'], prior: 'committed patch', index: 'staged patch', edits: 'unstaged patch' }
  const answers: Record<string, unknown> = { difficulty: { probabilities: { '0': 1 } }, duration: { probabilities: { '0': 1 } }, scope: { probabilities: { '0': 1 } }, task_type: { probabilities: { research: 1 } } }
  const io: DispatchIo & {
    list: () => Promise<AgentInfo[]>
    stat: (path: string) => Promise<{ isLink: boolean; kind: string; realPath: string }>
    exists: (path: string) => Promise<boolean>; read: (path: string) => Promise<string>; write: (path: string, text: string) => Promise<void>
  } = {
    home: '/home/u', root: '/repo', baseRef: 'head', version: '2.1.299', overrides: [],
    list: async () => { if (faults.list) throw new Error('list unavailable'); return clone(agents) },
    settings: async source => { settingsReads.push(source); if (faults.settings) throw new Error('settings unavailable'); return {} },
    breaker: createBreaker(() => 0), gate: createGate(), log: text => { logs.push(text) },
    jev: {
      now: () => 0, timer: (ms, fn) => { let cancelled = false; if (ms < 3000) void Promise.resolve().then(() => { if (!cancelled) fn() }); return () => { cancelled = true } },
      fetch: async (url, init) => { requests.push({ url, ...init }); return { status: faults.http, text: JSON.stringify({ answers }) } },
    },
    stat: async path => {
      if (path === faults.link) return { isLink: true, kind: 'link', realPath: '/elsewhere' }
      if (files.has(path)) return { isLink: false, kind: 'file', realPath: path }
      if (/\.(md|json)$/.test(path)) throw new Error('file missing')
      return { isLink: false, kind: 'dir', realPath: path }
    },
    exists: async path => files.has(path) || path === faults.link,
    read: async path => { reads.push(path); if (!files.has(path)) throw new Error('file missing'); return files.get(path)! },
    write: async (path, text) => { if (faults.write) throw new Error('private raw failure'); files.set(path, text); writes.push(path) },
    run: async argv => {
      calls.push([...argv]); const at = argv.indexOf('-C'), cwd = argv[at + 1]!, args = argv.slice(at + 2)
      let stdout = ''
      if (args[0] === 'rev-parse') {
        if (args.includes('--verify')) stdout = BASE
        else if (args.includes('--show-toplevel')) stdout = faults.top || cwd
        else stdout = faults.common || '/repo/.git'
      } else if (args[0] === 'branch') stdout = faults.branch || 'feat/task'
      else if (args[0] === 'status') stdout = 'MM staged.ts\0?? new file.ts\0'
      else if (args[0] === 'ls-files') stdout = changes.untracked.join('\0') + '\0'
      else if (args[0] === 'diff') {
        const committed = args.includes(BASE)
        const staged = args.includes('--cached')
        stdout = args.includes('--name-only') ? (committed ? changes.committed : staged ? changes.staged : changes.unstaged).join('\0') + '\0' : committed ? changes.prior : staged ? changes.index : changes.edits
      }
      return { exitCode: faults.process || (args[0] === 'merge-base' && faults.ancestor) ? 1 : 0, stdout, isStdoutTruncated: faults.truncate }
    },
  }
  return { io, files, calls, writes, reads, logs, requests, settingsReads, agents, faults, changes, answers }
}

export function world(on: On) {
  const p = ports(), tools: { name: string; inputSchema: unknown }[] = [], specs: AgentSpec[] = [], env: Record<string, string> = { HOME: '/home/u' }
  const identities = { value: undefined as IdentityCache | undefined, version: 0 }
  const state = { value: undefined as Runtime | undefined, version: 0, conflicts: 0 }
  mock.clock(on)
  on('agent.register', (_$, e) => { specs.push(e); return { value: { agent: `spider-team:${e.name}` } } })
  on('tool.register', (_$, e) => { tools.push(e); return { value: { tool: id(e.name) } } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: p.io.root }))
  on('session.version', () => ({ value: { version: p.io.version } }) as never)
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('settings.read', async (_$, e) => ({ value: e.source ? await p.io.settings(e.source as 'project' | 'local') : { worktree: { baseRef: p.io.baseRef } } }) as never)
  on('agent.list', async () => ({ value: await p.io.list() }))
  on('state.get', (_$, e) => { const slot = e.key === 'identities' ? identities : state; return { value: { value: slot.value ? clone(slot.value) : undefined, version: slot.version } } })
  on('state.set', (_$, e) => {
    if (e.key === 'identities') {
      if (e.ifVersion !== identities.version) return { value: { isSet: false, version: identities.version } }
      identities.value = clone(e.value as IdentityCache); return { value: { isSet: true, version: ++identities.version } }
    }
    if (state.conflicts-- > 0 || e.ifVersion !== state.version) return { value: { isSet: false, version: state.version } }
    state.value = clone(e.value as Runtime); return { value: { isSet: true, version: ++state.version } }
  })
  on('fs.stat', async (_$, e) => ({ value: { ...await p.io.stat(e.path), size: 0, mtimeMs: 0 } }) as never)
  on('fs.exists', async (_$, e) => ({ value: await p.io.exists(e.path) }))
  on('fs.read', async (_$, e) => ({ value: await p.io.read(e.path) }))
  on('fs.write', async (_$, e) => { await p.io.write(e.path, e.text); return { value: undefined } })
  on('process.run', async (_$, e) => ({ value: { ...await p.io.run([...e.argv]), stderr: '', isStderrTruncated: false } }) as never)
  on('http.fetch', async (_$, e) => ({ value: { ...await p.io.jev.fetch(e.url, e.init as never), ok: true, headers: {} } }))
  on('ui.log', (_$, e) => { p.io.log(e.text); return { value: undefined } })
  return { ...p, tools, specs, env, state, identities }
}
export async function started($: { session: { start: (e: never) => Promise<unknown> } }) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
}

// Direct hook harness preserves thrown errors and allows cancellation/reload timing to be controlled.
export function direct(session = 'session-1', shared = ports()) {
  const handlers = new Map<string, (...args: any[]) => any>()
  const catches = new Map<string, (...args: any[]) => any>()
  const state = { value: undefined as Runtime | undefined, version: 0 }
  const identities = { value: undefined as IdentityCache | undefined, version: 0 }
  const host = {
    session: { id: async () => session, version: async () => ({ version: shared.io.version }), root: async () => shared.io.root },
    settings: { read: async () => ({ worktree: { baseRef: shared.io.baseRef } }) },
    env: { get: async (name: string) => name === 'HOME' ? shared.io.home : undefined },
    agent: { list: () => shared.io.list() }, clock: { now: async () => 0 },
    fs: { stat: shared.io.stat, exists: shared.io.exists, read: shared.io.read, write: shared.io.write },
    process: { run: shared.io.run }, ui: { log: shared.io.log },
    state: {
      get: async (key: { key: string }) => clone(key.key === 'identities' ? identities : state),
      set: async (key: { key: string }, value: Runtime | IdentityCache, options: { ifVersion: number }) => {
        const slot = key.key === 'identities' ? identities : state
        if (options.ifVersion !== slot.version) return { isSet: false }
        slot.value = clone(value) as never; slot.version++; return { isSet: true }
      },
    },
  }
  const on = ((event: string, ...args: unknown[]) => {
    const matcher = args.length === 2 ? args.shift() as { tool?: string } : undefined
    const key = event + (matcher?.tool ?? '')
    handlers.set(key, args[0] as never)
    return { catch: (fn: (...args: any[]) => any) => catches.set(key, fn) }
  }) as On
  return { ...shared, state, identities, host, on, handlers, catches }
}
export const call = (tool_use_id = 'dispatch-1', role = 'analyst') => ({ tool: 'Agent', tool_use_id, description: 'Fixture', subagent_type: `spider-team:${role}`, prompt: 'Private task' })
export const spawn = (tool_use_id = 'dispatch-1', extra = {}) => ({ tool_use_id, prompt: 'Private task', description: 'Fixture', subagentType: 'spider-team:analyst', provider: { plugin: 'spider-team', tier: 'user' }, model: 'haiku', parentModel: 'opus', background: false, fork: false, ...extra })
export const step = (agentId: string | undefined, model = 'haiku', effort: string | undefined = 'medium') => ({ agentId, turnId: agentId ?? 'main', index: 0, messageCount: 1, model, effort })
export const launched = (agentId: string) => ({ result: { status: 'async_launched', agentId, description: 'Fixture', prompt: 'Private task', outputFile: '/native/output' } })
export const usage = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, server_tool_use: null, service_tier: null, cache_creation: null }
export const completed = (agentId: string, text = 'ok', extra = {}) => ({ result: { status: 'completed', agentId, prompt: 'Private task', content: [{ type: 'text', text }], resolvedModel: 'haiku', modelsUsed: ['haiku'], totalToolUseCount: 1, totalDurationMs: 10, totalTokens: 14, usage, ...extra } })
export async function drain(stream: AsyncGenerator<any, any, any>) {
  for (;;) { const r = await stream.next(); if (r.done) return r.value }
}
export const inference = async function* (_$: unknown, e: { turnId: string; index: number }) {
  return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
}
export const receiptInput = (agentId: string, patch = {}) => ({ tool: id('report'), tool_use_id: `report-${agentId}`, agentId, status: 'done', summary: 'Done.', verdict: 'NONE', body: '## Checks\nPrivate report evidence.', ...patch })
export function persisted(h: ReturnType<typeof ports>, key: number) {
  const text = [...h.files].find(([path]) => path.endsWith(`-${key}.json`))?.[1]
  if (!text) throw new Error('Missing decision')
  return JSON.parse(text)
}

export function contextFixture(patch: Partial<Context> = {}): Context {
  const r = runFixture()
  return { toolId: r.toolId, key: r.key, agentId: r.agentId, role: r.role, home: r.home, root: r.root, base: r.base, commonDir: r.commonDir, status: r.status, finished: r.finished, ...patch }
}
