import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

export const HOME = '/home/u'
export const ROOT = '/repo'

export type World = {
  files?: Record<string, string>
  realPaths?: Record<string, string>
  /** O primeiro agent.register falha. */
  failFirstRegister?: boolean
  /** While it returns true, clock.now rejects (this replaces the mock clock, so nothing can sleep). */
  clockDown?: () => boolean
}

export function world(on: On, opts: World = {}) {
  const seen = {
    agents: [] as string[],
    registered: [] as Array<{ name: string; tools?: readonly string[]; disallowedTools?: readonly string[] }>,
    tools: [] as string[],
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    submits: [] as string[],
    opened: [] as { id: string; title?: string; columns?: number; rows?: number; focus?: true; closeOnEscape?: true }[],
    closed: [] as string[],
    copied: [] as string[],
  }
  const files = { [`${HOME}/.claude/pantheon.json`]: '{}', ...(opts.files ?? {}) }
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
    return { value: { exitCode: 0, stdout: `${ROOT}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
    seen.registered.push(e)
    return { value: { agent: `pantheon:${e.name}` } }
  })
  on('tool.register', async (_$, e) => { seen.tools.push(e.name); return { value: { tool: `mcp__pantheon__${e.name}` } } })
  on('ui.toast', async (_$, e) => { seen.toasts.push(e.text); return { value: undefined } })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', async (_$, e) => { seen.statuses.push(e.text); return { value: undefined } })
  on('ui.open', async (_$, e) => { seen.opened.push(e); return { value: undefined } })
  on('ui.close', async (_$, e) => { seen.closed.push(e.id); return { value: undefined } })
  on('ui.copy', async (_$, e) => { seen.copied.push(e.text); return { value: undefined } })
  return { seen, files, clock }
}

export async function start($: Engine) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

export function parse(out: unknown): Record<string, unknown> {
  const text = (out as { result?: unknown }).result
  return JSON.parse(typeof text === 'string' ? text : JSON.stringify(text))
}

