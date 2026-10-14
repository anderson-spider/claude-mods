// Shared fake ports and host boundary. No model calls or network requests run.
import type { AgentSpec, On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { EffortIo } from '../hooks/effort'
import { createBreaker, createGate } from '../hooks/jev'

export function ports() {
  const requests: { url: string; body: string; headers: Record<string, string> }[] = [], logs: string[] = [], settingsReads: string[] = []
  const faults = { settings: false, http: 200 }
  const answers: Record<string, unknown> = { difficulty: { probabilities: { '0': 1 } }, duration: { probabilities: { '0': 1 } }, scope: { probabilities: { '0': 1 } }, task_type: { probabilities: { research: 1 } } }
  const io: EffortIo & { home: string; root: string; key?: string; baseRef?: string } = {
    home: '/home/u', root: '/repo', baseRef: 'head',
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
  const p = ports(), specs: AgentSpec[] = [], env: Record<string, string> = { HOME: '/home/u' }
  mock.clock(on)
  on('agent.register', (_$, e) => { specs.push(e); return { value: { agent: `spider-team:${e.name}` } } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: p.io.root }))
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('settings.read', async (_$, e) => ({ value: e.source ? await p.io.settings(e.source as 'project' | 'local') : { worktree: { baseRef: p.io.baseRef } } }) as never)
  on('http.fetch', async (_$, e) => ({ value: { ...await p.io.jev.fetch(e.url, e.init as never), ok: true, headers: {} } }))
  on('ui.log', (_$, e) => { p.io.log(e.text); return { value: undefined } })
  return { ...p, specs, env }
}
export async function started($: { session: { start: (e: never) => Promise<unknown> } }) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
}
export const call = (role = 'analyst', patch = {}) => ({ tool: 'Agent', tool_use_id: 'dispatch-1', description: 'Fixture', subagent_type: `spider-team:${role}`, prompt: 'Private task', ...patch })
