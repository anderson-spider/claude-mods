import type { Hook, McpToolInputs, Register } from 'claude-code'
import type { SchemaFor } from './schema'
import { dispatch, finish } from './team'
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
    env: async () => ({ HERDR_ENV: await $.env.get('HERDR_ENV'), HERDR_PANE_ID: await $.env.get('HERDR_PANE_ID'), HERDR_WORKSPACE_ID: await $.env.get('HERDR_WORKSPACE_ID'), DAGR_BIN: await $.env.get('DAGR_BIN'), HOME: await $.env.get('HOME') }),
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
function teamIo($: Dollar, allowAstra: unknown, fast: unknown): TeamIo {
  return {
    allowAstra,
    fast,
    run: async (argv, init) => {
      const done = await $.process.run(argv, { timeoutMs: init?.timeoutMs })
      return { exitCode: done.exitCode, stdout: done.stdout, stderr: done.stderr, isStdoutTruncated: done.isStdoutTruncated, isStderrTruncated: done.isStderrTruncated }
    },
    env: async () => ({
      HERDR_ENV: await $.env.get('HERDR_ENV'),
      HERDR_WORKSPACE_ID: await $.env.get('HERDR_WORKSPACE_ID'),
      HERDR_PANE_ID: await $.env.get('HERDR_PANE_ID'),
      HOME: await $.env.get('HOME'),
      JEV_API_KEY: await $.env.get('JEV_API_KEY'),
    }),
    sleep: ms => $.clock.sleep(ms),
    settings: async source => {
      const settings = await $.settings.read({ source })
      return { env: settings?.env, pluginConfigs: settings?.pluginConfigs }
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

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'dispatch',
      description:
        'Hands a task to a Codex team agent in Herdr: developer, analyst, architect, or reviewer (reviews the recorded developer task; task is optional extra focus). ' +
        'Every dispatch starts a fresh session after safely finishing its idle/done predecessor in this workspace; working/blocked targets are refused. Jev chooses model and effort for every role, using the review brief for reviewer. Roles retain their instructions and write permissions. All tabs use codex - <slug>. Herdr names are workspace-specific; use the effective name returned for wait/get. A busy shared analyst falls back to analyst-<slug>. Delivery: confirmed, unknown (never resend), or not_sent. Publishes the active crew plan to Dagr when available. Only inside Herdr.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['developer', 'analyst', 'architect', 'reviewer'], description: 'Who does the task.' },
          task: { type: 'string', description: 'Required except for reviewer: a self-contained brief. For reviewer, optional extra focus. Accepts @profile and !dimension=value pins outside code and quotes. Each dispatch starts a fresh session; followup briefs must be self-contained.' },
          slug: { type: 'string', description: 'Required task id: lowercase letters, digits and hyphens, at most 22 characters. Never truncated.' },
          cwd: { type: 'string', description: 'Developer only: the absolute path of the task worktree, never the repository itself.' },
          model: { type: 'string', enum: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'], description: 'Pins model at a new session start for every role and skips Jev; omitted effort uses the role default. Astra pins require allowAstra permission.' },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Pins effort at a new session start for every role and skips Jev; omitted model uses the role default. Astra caps xhigh to high; each dispatch starts fresh.' },
          fast: { type: 'boolean', description: 'Fast mode (the priority service tier) for this dispatch: true turns it on, false off; omitted uses the fast plugin option (off by default).' },
        },
        required: ['role', 'slug'],
      } satisfies SchemaFor<McpToolInputs['mcp__codex-team__dispatch']>,
    })
    await $.tool.register({
      name: 'finish',
      description: 'Closes an idle or done Codex team agent in this workspace, then archives its session after it exits. Refuses busy, blocked, foreign agents and the lead pane. Finishing the last pane also removes its task tab.',
      inputSchema: {
        type: 'object',
        properties: { agent: { type: 'string', description: 'Logical team agent name (resolved in this workspace): analyst, architect, analyst-<slug>, architect-<slug> or dev-<slug>.' } },
        required: ['agent'],
      } satisfies SchemaFor<McpToolInputs['mcp__codex-team__finish']>,
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__codex-team__dispatch' }, async ($, e, next) => {
    if (!('tool' in e)) return next(e)
    const answer = await dispatch(teamIo($, options.allowAstra, options.fast), e).catch(() => ({ ok: false, text: 'codex-team: the dispatch failed unexpectedly; check `herdr agent list` before trying again.' }))
    return { result: answer.text }
  })

  on('tool.call', { tool: 'mcp__codex-team__finish' }, async ($, e, next) => {
    if (!('tool' in e)) return next(e)
    const answer = await finish(teamIo($, options.allowAstra, options.fast), e).catch(() => ({ ok: false, text: 'codex-team: finish failed unexpectedly; check `herdr agent list` before trying again.' }))
    return { result: answer.text }
  })

  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const result = await next(e)
    if (!result.isError && result.deny === undefined && 'file_path' in e) {
      const root = await $.session.root().catch(() => undefined)
      if (root && isPlanFile(e.file_path, root)) await publish(dagrIo($), root)
    }
    return result
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    try {
      const root = await $.session.root()
      await publish(dagrIo($), root, { ifChanged: true })
    } catch {
      try { $.ui.log('codex-team: dagr plan observation failed', { to: 'debug' }) } catch { /* Reporting cannot change the Bash result. */ }
    }
    return result
  })
}
