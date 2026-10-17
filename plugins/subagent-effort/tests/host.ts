// Shared fake ports and host boundary. No model calls or network requests run.
import type { CommandSpec, On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { EffortIo } from '../hooks/effort'
import { createBreaker, createGate } from '../hooks/jev'

export function ports() {
  const requests: { url: string; body: string; headers: Record<string, string> }[] = [], logs: string[] = [], settingsReads: string[] = []
  const faults = { settings: false, http: 200 }
  const answers: Record<string, unknown> = { reasoning: { probabilities: { '0': 1 } } }
  // The usage Jev reports with its answers; `usage.value = undefined` drops it from the response.
  const usage: { value?: unknown } = { value: { input_tokens: 300, output_tokens: 20 } }
  const io: EffortIo & { home: string; root: string; key?: string } = {
    home: '/home/u', root: '/repo',
    settings: async source => { settingsReads.push(source); if (faults.settings) throw new Error('settings unavailable'); return {} },
    breaker: createBreaker(() => 0), gate: createGate(), log: text => { logs.push(text) },
    jev: {
      now: () => 0, timer: (ms, fn) => { let cancelled = false; if (ms < 3000) void Promise.resolve().then(() => { if (!cancelled) fn() }); return () => { cancelled = true } },
      fetch: async (url, init) => { requests.push({ url, ...init }); return { status: faults.http, text: JSON.stringify({ answers, usage: usage.value }) } },
    },
  }
  return { io, requests, logs, settingsReads, faults, answers, usage }
}

export function world(on: On) {
  const p = ports(), commands: CommandSpec[] = [], env: Record<string, string> = { HOME: '/home/u' }
  // The local file system: every file the plugin writes, whole, by path.
  const files = new Map<string, string>(), fsFaults = { read: false, write: false }, written: string[] = []
  mock.clock(on)
  on('command.register', (_$, e) => { commands.push(e); return { value: { command: e.name } } })
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => { if (fsFaults.read || !files.has(e.path)) throw new Error('read failed'); return { value: files.get(e.path)! } })
  on('fs.write', (_$, e) => { if (fsFaults.write) throw new Error('write failed'); written.push(e.text); files.set(e.path, e.text); return { value: undefined } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: p.io.root }))
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('settings.read', async (_$, e) => ({ value: e.source ? await p.io.settings(e.source as 'project' | 'local') : {} }) as never)
  on('http.fetch', async (_$, e) => ({ value: { ...await p.io.jev.fetch(e.url, e.init as never), ok: true, headers: {} } }))
  on('ui.log', (_$, e) => { p.io.log(e.text); return { value: undefined } })
  // Each toast's text, in the order shown.
  const toasts: string[] = []
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  /** The ledger's lines in the order written: `files` holds the current text, `ledger()` parses it. */
  const ledger = () => (files.get(LEDGER) ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>)
  return { ...p, commands, env, files, fsFaults, written, ledger, toasts }
}
export const LEDGER = '/home/u/.claude/subagent-effort/routes.jsonl'
export async function started($: { session: { start: (e: never) => Promise<unknown> } }) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
}
export const call = (patch = {}) => ({ tool: 'Agent', tool_use_id: 'dispatch-1', description: 'Fixture', subagent_type: 'Explore', prompt: 'Private task', ...patch })
const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
const pause = () => new Promise<void>(resolve => timers.setTimeout(resolve, 0))
/** A host call, then time for the outcome work it left running, so a test reads the ledger whole. */
export async function settle<T>(call: Promise<T>): Promise<T> {
  const result = await call
  for (let i = 0; i < 20; i++) await pause()
  return result
}
