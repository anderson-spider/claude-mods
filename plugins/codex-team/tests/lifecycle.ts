// Mutable lifecycle fixture: no real clock, files, commands or sessions.
import { createAutoCloser } from '../hooks/auto-close'
import type { ReportStat } from '../hooks/auto-close'
import { autoFinish } from '../hooks/team'
import type { TeamIo } from '../hooks/team'
import type { Listed } from '../hooks/herdr'
import { createBreaker, createGate } from '../hooks/jev'
import { ok, fail, text } from './fake-run'

export const UUID = '12345678-1234-1234-1234-123456789abc'
export const COMPLETE = 'status: partial\nsummary: delivered\nfiles: none\nchecks: check fail\nblockers: none\nquestions: choose next step\ndrafts: none'
export const REVIEW = 'verdict: accept\nrisk: low\nfindings:\nchecks: reviewed pass'

export function lifecycle() {
  const calls: string[][] = [], writes: { path: string; text: string }[] = [], logs: string[] = [], tasks = new Map<string, unknown>()
  const files = new Map<string, { text: string; stat: ReportStat }>()
  const state = { agents: [] as Listed[], time: 1_000, archiveExit: 0, starts: 0, closeFail: false, startFail: false, beforeRead: undefined as (() => Promise<void>) | undefined, beforeGet: undefined as (() => Promise<void>) | undefined }
  const panes = new Map<string, { pane_id: string; terminal_id: string; workspace_id: string; tab_id: string }>()
  const io: TeamIo = {
    run: async argv => {
      calls.push([...argv])
      if (argv[0] === 'mkdir') return ok({})
      if (argv[0] === 'git') return text(`${argv[2]}\n`)
      if (argv[0] === 'codex') return { exitCode: state.archiveExit, stdout: '', stderr: '' }
      if (argv[1] === 'agent' && argv[2] === 'list') return ok({ agents: state.agents })
      if (argv[1] === 'agent' && argv[2] === 'get') { await state.beforeGet?.(); const agent = state.agents.find(agent => agent.name === argv[3]); return agent ? ok({ agent }) : fail('agent_not_found') }
      if (argv[2] === 'create' || argv[2] === 'split') {
        const id = `w1:p${++state.starts}`, pane = { pane_id: id, terminal_id: `t${state.starts}`, workspace_id: 'w1', tab_id: `tab${state.starts}` }
        panes.set(id, pane)
        return ok({ [argv[2] === 'create' ? 'root_pane' : 'pane']: pane })
      }
      if (argv[1] === 'pane' && argv[2] === 'get') return ok({ pane: { ...panes.get(argv[3]!), agent: state.agents.find(agent => agent.pane_id === argv[3])?.agent ?? null } })
      if (argv[1] === 'pane' && argv[2] === 'close') {
        if (state.closeFail) return fail('pane_close_failed')
        state.agents = state.agents.filter(agent => agent.pane_id !== argv[3]); panes.delete(argv[3]!); return ok({})
      }
      if (argv[2] === 'start') {
        if (state.startFail) return fail('start_failed')
        const pane = argv[argv.indexOf('--pane') + 1]!
        state.agents.push({ name: argv[3], pane_id: pane, workspace_id: 'w1', cwd: '/wt/fix', agent: 'codex', agent_status: 'idle' })
        return ok({})
      }
      if (argv[2] === 'prompt') {
        const agent = state.agents.find(agent => agent.name === argv[3])!
        agent.agent_status = 'working'
        agent.agent_session = { kind: 'id', source: 'herdr:codex', value: UUID }
        return ok({})
      }
      return fail('unexpected_command')
    },
    env: async () => ({ HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1', HERDR_PANE_ID: 'lead', HOME: '/home/u' }),
    root: async () => '/repo', now: async () => state.time, sleep: async ms => { state.time += ms },
    settings: async () => undefined, jev: { fetch: async () => { throw new Error('no HTTP') }, timer: () => () => {}, now: () => state.time },
    breaker: createBreaker(() => state.time), gate: createGate(),
    write: async (path, text) => { writes.push({ path, text }) }, log: line => { logs.push(line) },
    store: { get: async key => tasks.get(key), set: async (key, value) => { tasks.set(key, value) }, delete: async key => { tasks.delete(key) } },
    reports: { stat: async path => files.get(path)?.stat, read: async path => { await state.beforeRead?.(); return files.get(path)!.text } },
  }
  let tick: (() => void) | undefined, timers = 0, cancelled = 0
  const closer = io.autoCloser = createAutoCloser({ ...io.reports!, run: io.run, log: io.log,
    timer: (ms, fn) => { if (ms !== 2_000) throw new Error('wrong interval'); timers++; tick = fn; return () => { cancelled++; tick = undefined } },
    finish: (entry, current) => autoFinish(io, entry, current),
  })
  const put = (path: string, body = COMPLETE, mtimeMs = state.time + 1) => files.set(path, { text: body, stat: { kind: 'file', isLink: false, mtimeMs, size: body.length } })
  return { io, state, calls, writes, logs, tasks, files, panes, closer, put, timer: () => ({ tick, timers, cancelled }) }
}
