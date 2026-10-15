// Shared fake ports and host boundary. No model calls or network requests run.
import type { AgentInfo, AgentSpec, CommandSpec, On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { EffortIo } from '../hooks/effort'
import { createBreaker, createGate } from '../hooks/jev'

export function ports() {
  const requests: { url: string; body: string; headers: Record<string, string> }[] = [], logs: string[] = [], settingsReads: string[] = []
  const faults = { settings: false, http: 200 }
  // One answer set serves both requests: routing reads difficulty and duration, the outcome judge its three Nouls.
  const answers: Record<string, unknown> = {
    difficulty: { probabilities: { '0': 1 } }, duration: { probabilities: { '0': 1 } },
    finished: { type: 'noul', noul: 0.95 }, failingChecks: { type: 'noul', noul: 0.02 }, blocked: { type: 'noul', noul: 0.01 },
  }
  const io: EffortIo & { home: string; root: string; key?: string } = {
    home: '/home/u', root: '/repo',
    settings: async source => { settingsReads.push(source); if (faults.settings) throw new Error('settings unavailable'); return {} },
    breaker: createBreaker(() => 0), gate: createGate(), log: text => { logs.push(text) },
    jev: {
      now: () => 0, timer: (ms, fn) => { let cancelled = false; if (ms < 3000) void Promise.resolve().then(() => { if (!cancelled) fn() }); return () => { cancelled = true } },
      fetch: async (url, init) => { requests.push({ url, ...init }); return { status: faults.http, text: JSON.stringify({ answers }) } },
    },
  }
  return { io, requests, logs, settingsReads, faults, answers }
}

export function world(on: On) {
  const p = ports(), specs: AgentSpec[] = [], commands: CommandSpec[] = [], env: Record<string, string> = { HOME: '/home/u' }
  // The local file system: every file the plugin writes, whole, by path.
  const files = new Map<string, string>(), fsFaults = { read: false, write: false }, written: string[] = []
  // What `$.agent.list()` answers, and how many times it was asked; `agents.fail` makes it throw.
  const agents = { roster: [] as AgentInfo[], lists: 0, fail: false }
  mock.clock(on)
  on('command.register', (_$, e) => { commands.push(e); return { value: { command: e.name } } })
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => { if (fsFaults.read || !files.has(e.path)) throw new Error('read failed'); return { value: files.get(e.path)! } })
  on('fs.write', (_$, e) => { if (fsFaults.write) throw new Error('write failed'); written.push(e.text); files.set(e.path, e.text); return { value: undefined } })
  on('agent.register', (_$, e) => { specs.push(e); return { value: { agent: `spider-team:${e.name}` } } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: p.io.root }))
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('settings.read', async (_$, e) => ({ value: e.source ? await p.io.settings(e.source as 'project' | 'local') : {} }) as never)
  on('http.fetch', async (_$, e) => ({ value: { ...await p.io.jev.fetch(e.url, e.init as never), ok: true, headers: {} } }))
  on('ui.log', (_$, e) => { p.io.log(e.text); return { value: undefined } })
  on('agent.list', () => { agents.lists++; if (agents.fail) throw new Error('list failed'); return { value: agents.roster } })
  /** The ledger's lines in the order written: `files` holds the current text, `ledger()` parses it. */
  const ledger = () => (files.get(LEDGER) ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>)
  return { ...p, specs, commands, env, files, fsFaults, written, ledger, agents }
}
/** An agent as `$.agent.list()` lists it. */
export const listed = (id: string, type: string): AgentInfo => ({ id, type, status: 'running', description: 'Fixture' })
export const LEDGER = '/home/u/.claude/spider-team/routes.jsonl'
export async function started($: { session: { start: (e: never) => Promise<unknown> } }) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
}
export const call = (role = 'analyst', patch = {}) => ({ tool: 'Agent', tool_use_id: 'dispatch-1', description: 'Fixture', subagent_type: `spider-team:${role}`, prompt: 'Private task', ...patch })
// The native path after dispatch: the host spawns the subagent under its provider, then runs its turns.
export const MARKETPLACE = { plugin: 'spider-team@spider-claude-mods', tier: 'user' }
export const spawn = (tool_use_id: string, subagentType: string, model: string, provider = MARKETPLACE) => ({ tool_use_id, prompt: 'Private task', description: 'Fixture', subagentType, provider, model, parentModel: 'opus', background: false, fork: false })
export const step = (agentId: string, model: string, effort: string) => ({ agentId, turnId: agentId, index: 0, messageCount: 1, model, effort })
export const inference = async function* (_$: unknown, e: { turnId: string; index: number }) {
  return { turnId: e.turnId, index: e.index, answer: 'native answer', toolUses: [], stopReason: 'end_turn' as const, usage: null }
}
export async function drain(stream: AsyncGenerator<unknown, { answer: string }, unknown>) {
  for (;;) { const r = await stream.next(); if (r.done) return r.value }
}
const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
const pause = () => new Promise<void>(resolve => timers.setTimeout(resolve, 0))
/** A host call, then time for the outcome work it left running (the judge and the outcome line), so a test reads the ledger whole. */
export async function settle<T>(call: Promise<T>): Promise<T> {
  const result = await call
  for (let i = 0; i < 20; i++) await pause()
  return result
}
