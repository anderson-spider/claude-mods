import type { Hook, McpToolInputs, Register } from 'claude-code'
import type { SchemaFor } from './schema'
import { dispatch } from './team'
import type { TeamIo } from './team'
import { createBreaker, createGate } from './jev'
import { createPublisher, isPlanFile } from './publish'
import type { PublishIo } from './publish'

type Dollar = Parameters<Hook<'session.start'>>[0]
const breaker = createBreaker(() => Date.now())
const gate = createGate()
const publish = createPublisher()

/** All DAG host calls stay visible to the engine in this entry module. */
function dagrIo($: Dollar): PublishIo {
  return {
    env: async () => ({ HERDR_ENV: await $.env.get('HERDR_ENV'), HERDR_PANE_ID: await $.env.get('HERDR_PANE_ID'), DAGR_BIN: await $.env.get('DAGR_BIN'), HOME: await $.env.get('HOME') }),
    run: (argv, init) => $.process.run(argv, { timeoutMs: init?.timeoutMs }),
    list: path => $.fs.list(path),
    exists: path => $.fs.exists(path),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    now: () => $.clock.now(),
    log: text => $.ui.log(text, { to: 'debug' }),
  }
}

/** The host access the team needs, built from one hook's `$`. */
function teamIo($: Dollar): TeamIo {
  return {
    run: async (argv, init) => {
      const done = await $.process.run(argv, { timeoutMs: init?.timeoutMs })
      return { exitCode: done.exitCode, stdout: done.stdout, stderr: done.stderr, isStdoutTruncated: done.isStdoutTruncated, isStderrTruncated: done.isStderrTruncated }
    },
    env: async () => ({
      HERDR_ENV: await $.env.get('HERDR_ENV'),
      HERDR_WORKSPACE_ID: await $.env.get('HERDR_WORKSPACE_ID'),
      HOME: await $.env.get('HOME'),
      JEV_API_KEY: await $.env.get('JEV_API_KEY'),
    }),
    settings: async source => {
      const settings = await $.settings.read({ source })
      return { env: settings?.env }
    },
    jev: {
      fetch: async (url, init) => {
        const response = await $.http.fetch(url, init)
        return { status: response.status, text: response.text, headers: response.headers }
      },
      timer: (ms, fn) => {
        const handle = $.clock.after(ms, fn)
        return () => handle.cancel()
      },
      now: () => Date.now(),
    },
    breaker,
    gate,
    root: () => $.session.root(),
    now: () => $.clock.now(),
    write: (path, text) => $.fs.write(path, text),
    log: text => $.ui.log(text, { to: 'debug' }),
    store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key) },
    publish: root => publish(dagrIo($), root),
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'dispatch',
      description:
        'Hands a task to a Codex team agent in Herdr: developer, analyst, architect, or reviewer (reviews the recorded developer task; task is optional extra focus). ' +
        'Task agents use a codex · <slug> tab; shared analyst/architect use codex team. A busy shared analyst falls back to analyst-<slug>. Delivery: confirmed, unknown (never resend), or not_sent. Publishes the active crew plan to Dagr when available. Only inside Herdr.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['developer', 'analyst', 'architect', 'reviewer'], description: 'Who does the task.' },
          task: { type: 'string', description: 'Required except for reviewer: a self-contained brief. For reviewer, optional extra focus.' },
          slug: { type: 'string', description: 'Required task id: lowercase letters, digits and hyphens, at most 22 characters. Never truncated.' },
          cwd: { type: 'string', description: 'Developer only: the absolute path of the task worktree, never the repository itself.' },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Pins effort and skips Jev, except reviewer always chooses xhigh (Astra caps to high).' },
        },
        required: ['role', 'slug'],
      } satisfies SchemaFor<McpToolInputs['mcp__codex-team__dispatch']>,
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__codex-team__dispatch' }, async ($, e) => {
    const answer = await dispatch(teamIo($), e).catch(() => ({ ok: false, text: 'codex-team: the dispatch failed unexpectedly; check `herdr agent list` before trying again.' }))
    return { result: answer.text }
  })

  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const result = await next(e)
    if (!result.isError && result.deny === undefined) {
      const root = await $.session.root().catch(() => undefined)
      if (root && isPlanFile(e.file_path, root)) await publish(dagrIo($), root)
    }
    return result
  })
}
