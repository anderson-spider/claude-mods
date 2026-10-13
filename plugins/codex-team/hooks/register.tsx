import type { Hook, McpToolInputs, Register } from 'claude-code'
import type { SchemaFor } from './schema'
import { dispatch } from './team'
import type { TeamIo } from './team'

type Dollar = Parameters<Hook<'session.start'>>[0]

/** The host access the team needs, built from one hook's `$`. */
function teamIo($: Dollar): TeamIo {
  return {
    run: async (argv, init) => {
      const done = await $.process.run(argv, { timeoutMs: init?.timeoutMs })
      return { exitCode: done.exitCode, stdout: done.stdout, stderr: done.stderr }
    },
    env: async () => ({
      HERDR_ENV: await $.env.get('HERDR_ENV'),
      HERDR_WORKSPACE_ID: await $.env.get('HERDR_WORKSPACE_ID'),
      HOME: await $.env.get('HOME'),
    }),
    root: () => $.session.root(),
    now: () => $.clock.now(),
    write: (path, text) => $.fs.write(path, text),
    log: text => $.ui.log(text, { to: 'debug' }),
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'dispatch',
      description:
        'Hands a task to a Codex team agent in Herdr: the developer (implements and commits in a task worktree), the analyst (investigates and drafts docs) or the architect (designs). ' +
        'Starts the agent in the team tab, or reuses it, and reports delivery: confirmed, unknown (never resend) or not_sent. The agent writes a short report at the path given. Only inside Herdr.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['developer', 'analyst', 'architect'], description: 'Who does the task.' },
          task: { type: 'string', description: 'A self-contained brief: the agent has none of this conversation.' },
          slug: { type: 'string', description: 'A short task id: lowercase letters, digits and hyphens, at most 28 characters. Names the developer (dev-<slug>) and the report.' },
          cwd: { type: 'string', description: 'Developer only: the absolute path of the task worktree, never the repository itself.' },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: "Overrides the role's default effort." },
        },
        required: ['role', 'task', 'slug'],
      } satisfies SchemaFor<McpToolInputs['mcp__codex-team__dispatch']>,
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__codex-team__dispatch' }, async ($, e) => {
    const answer = await dispatch(teamIo($), e).catch(() => ({ ok: false, text: 'codex-team: the dispatch failed unexpectedly; check `herdr agent list` before trying again.' }))
    return { result: answer.text }
  })
}
