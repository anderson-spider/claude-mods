import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { CODEX_EXEC_SAMPLE } from './codex-exec-sample'

export const DELEGATE = 'mcp__pantheon__delegate'
export const RESULT = 'mcp__pantheon__delegate_result'
export const HOME = '/home/u'
export const ROOT = '/repo'

export type World = {
  files?: Record<string, string>
  realPaths?: Record<string, string>
  isRepo?: boolean
  stdout?: string
  exitCode?: number
  /** O processo do Codex não termina até ser encerrado. */
  hang?: boolean
  /** O primeiro agent.register falha. */
  failFirstRegister?: boolean
  /** Respostas de process.run por comando (argv unido por espaço). */
  runs?: Record<string, { exitCode: number; stdout?: string; stderr?: string }>
  /** While it returns true, clock.now rejects (this replaces the mock clock, so nothing can sleep). */
  clockDown?: () => boolean
}

export function world(on: On, opts: World = {}) {
  const seen = {
    argv: [] as string[][],
    cwds: [] as string[],
    agents: [] as string[],
    tools: [] as string[],
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    submits: [] as string[],
    opened: [] as { id: string; title?: string; columns?: number; rows?: number }[],
    closed: [] as string[],
    copied: [] as string[],
    gitRuns: 0,
  }
  const files = { ...(opts.files ?? {}) }
  const clock = opts.clockDown ? (undefined as never) : mock.clock(on)
  if (opts.clockDown) {
    on('clock.now', async () => {
      if (opts.clockDown!()) throw new Error('clock gone')
      return { value: 0 }
    })
  }
  mock.env(on, { HOME })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: ROOT }))
  on('process.run', async (_$, e) => {
    const canned = opts.runs?.[e.argv.join(' ')]
    if (canned) {
      return { value: { exitCode: canned.exitCode, stdout: canned.stdout ?? '', stderr: canned.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    seen.gitRuns++
    return opts.isRepo === false
      ? { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 0, stdout: `${ROOT}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', async (_$, e) => ({ value: Object.hasOwn(files, e.path) }))
  on('fs.read', async (_$, e) => ({ value: files[e.path] ?? '' }))
  on('fs.stat', async (_$, e) => ({
    value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: opts.realPaths?.[e.path] ?? e.path },
  }))
  let failRegister = opts.failFirstRegister === true
  on('agent.register', async (_$, e) => {
    if (failRegister) { failRegister = false; throw new Error('transient') }
    seen.agents.push(e.name)
    return { value: { agent: `pantheon:${e.name}` } }
  })
  on('tool.register', async (_$, e) => { seen.tools.push(e.name); return { value: { tool: `mcp__pantheon__${e.name}` } } })
  on('ui.toast', async (_$, e) => { seen.toasts.push(e.text); return { value: undefined } })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', async (_$, e) => { seen.statuses.push(e.text); return { value: undefined } })
  on('ui.open', async (_$, e) => { seen.opened.push(e); return { value: undefined } })
  on('ui.close', async (_$, e) => { seen.closed.push(e.id); return { value: undefined } })
  on('ui.copy', async (_$, e) => { seen.copied.push(e.text); return { value: undefined } })
  on('process.spawn', async function* (_$, e) {
    seen.argv.push([...e.argv])
    seen.cwds.push(e.cwd ?? '')
    const text = opts.stdout ?? CODEX_EXEC_SAMPLE
    if (opts.hang) {
      yield { stream: 'stdout' as const, text: '{"type":"thread.started","thread_id":"hang-1"}\n' }
      await clock.sleep(1e12)
    }
    if (text) yield { stream: 'stdout' as const, text }
    return { value: { code: opts.exitCode ?? 0, signal: null } }
  })
  return { seen, files, clock }
}

export async function start($: Engine) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

export function parse(out: unknown): Record<string, unknown> {
  const text = (out as { result?: unknown }).result
  return JSON.parse(typeof text === 'string' ? text : JSON.stringify(text))
}

