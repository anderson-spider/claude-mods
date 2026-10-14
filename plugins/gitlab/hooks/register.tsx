import type { EngineInterface, McpToolInputs, Register } from 'claude-code'
import { GitlabError, gitlab } from './api'
import { comment } from './comments'
import { InputError, type Ctx } from './context'
import { jobLog } from './joblog'
import { mr } from './mr'
import { pipeline } from './pipelines'
import { currentBranch, locate, type Git } from './remote'
import { allOf, type SchemaFor } from './schema'
import { offText, resolveToken, type TokenIo } from './tokens'

type Inputs = McpToolInputs

const MR_ACTIONS = allOf<Inputs['mcp__gitlab__gitlab_mr']['action']>()(
  'list', 'get', 'create', 'update', 'diff', 'commits', 'approve', 'unapprove', 'rebase',
)
const COMMENT_ACTIONS = allOf<Inputs['mcp__gitlab__gitlab_mr_comment']['action']>()(
  'list', 'comment', 'reply', 'line', 'edit', 'resolve', 'unresolve',
)
const PIPELINE_ACTIONS = allOf<Inputs['mcp__gitlab__gitlab_pipeline']['action']>()('list', 'jobs', 'retry', 'cancel', 'play')

const IID = { type: 'integer', description: 'MR number (!iid). Default: the open MR of the current branch.' } as const
const NAMES = { type: 'array', items: { type: 'string' } } as const

/** Shapes a call's output for the host: `isError` is set only when true (the host rejects `false`). */
function reply(text: string, isError = false): { result: string } | { result: string; isError: true } {
  return isError ? { result: text, isError: true as const } : { result: text }
}

/** The repository's settings, which decide whether the tokens option may be used. */
function tokenIo($: EngineInterface): TokenIo {
  return {
    settings: async (source) => {
      const settings = await $.settings.read({ source })
      return { pluginConfigs: settings?.pluginConfigs }
    },
  }
}

/** The host wiring every tool shares: finds the project from the git remote, picks that host's token and runs the tool. */
async function run(
  $: EngineInterface,
  tool: (ctx: Ctx, input: Record<string, unknown>) => Promise<string>,
  input: Record<string, unknown>,
  option: unknown,
): Promise<ReturnType<typeof reply>> {
  const git: Git = (args) => $.process.run(['git', ...args], { timeoutMs: 10_000 })
  const where = await locate(git)
  if ('error' in where) return reply(where.error, true)
  const access = await resolveToken(tokenIo($), option, where.host)
  if (access.off !== undefined) return reply(offText(access.off, where.host), true)
  // $.http.fetch is wrapped, not passed as a value: the engine's validate rejects the latter.
  const api = gitlab((url, init) => $.http.fetch(url, init), where.host, where.project, access.token)
  // an answer can echo what the request carried (a proxy's error page, a fetch error), so the token is masked in every output
  const masked = (text: string, isError = false) => reply(text.split(access.token).join('[token]'), isError)
  try {
    return masked(await tool({ api, branch: () => currentBranch(git) }, input))
  } catch (err) {
    if (err instanceof InputError) return masked(err.message, true)
    if (err instanceof GitlabError) return masked(`GitLab answered ${err.status} for ${where.project}: ${err.message}`, true)
    return masked(`Call to ${where.host} failed: ${err instanceof Error ? err.message : String(err)}`, true)
  }
}

/** A hook that threw (a bug, not an API answer) still ends the call with an error instead of leaving it unanswered. */
const failed = () => reply('The gitlab tool failed before it could answer. Try again; if it repeats, run claude --debug.', true)

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'gitlab_mr',
      description:
        "Merge requests of the current repository's GitLab project (host and token from its git remote). " +
        'list (by state/branches), get, diff (files filter), commits; create (title; source defaults to the current ' +
        'branch, target to the default branch), update, approve, unapprove, rebase. Merging is not offered.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: MR_ACTIONS },
          iid: IID,
          state: { type: 'string', enum: allOf<'opened' | 'merged' | 'closed' | 'all'>()('opened', 'merged', 'closed', 'all'), description: 'list filter; default opened.' },
          title: { type: 'string' },
          description: { type: 'string', description: 'Markdown body.' },
          sourceBranch: { type: 'string' },
          targetBranch: { type: 'string' },
          labels: { ...NAMES, description: 'Replaces all labels.' },
          addLabels: NAMES,
          removeLabels: NAMES,
          assignees: { ...NAMES, description: 'Usernames; @me is the token owner.' },
          reviewers: { ...NAMES, description: 'Usernames; @me is the token owner.' },
          draft: { type: 'boolean', description: 'Adds or removes the Draft: prefix.' },
          stateEvent: { type: 'string', enum: allOf<'close' | 'reopen'>()('close', 'reopen') },
          removeSourceBranch: { type: 'boolean' },
          squash: { type: 'boolean' },
          files: { ...NAMES, description: 'diff: only files whose path contains one of these.' },
        },
        required: ['action'],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_mr']>,
    })
    await $.tool.register({
      name: 'gitlab_mr_comment',
      description:
        'Discussions of a merge request: list (ids, authors, file/line, resolved), comment, reply to a discussion, ' +
        'line (a diff comment on path at line, or oldLine for a removed line), edit a note, resolve, unresolve.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: COMMENT_ACTIONS },
          iid: IID,
          body: { type: 'string', description: 'Markdown text.' },
          discussionId: { type: 'string' },
          noteId: { type: 'integer' },
          path: { type: 'string', description: 'line: file path as in the diff.' },
          line: { type: 'integer', description: 'line: new-side line number.' },
          oldLine: { type: 'integer', description: 'line: old-side line number (both for an unchanged line).' },
          unresolvedOnly: { type: 'boolean' },
        },
        required: ['action'],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_mr_comment']>,
    })
    await $.tool.register({
      name: 'gitlab_pipeline',
      description:
        'Pipelines of a merge request (iid, or the current branch\'s MR) or of a ref: list; jobs of a pipeline ' +
        '(default the latest) with downstream pipelines; retry or cancel a job or pipeline; play a manual job. ' +
        'Read a failed job with gitlab_job_log.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: PIPELINE_ACTIONS },
          iid: IID,
          ref: { type: 'string', description: 'Branch or tag instead of an MR.' },
          pipelineId: { type: 'integer' },
          jobId: { type: 'integer' },
          failedOnly: { type: 'boolean', description: 'jobs: only failed jobs.' },
        },
        required: ['action'],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_pipeline']>,
    })
    await $.tool.register({
      name: 'gitlab_job_log',
      description:
        "A CI job's log without terminal codes. errors (default): lines matching error words or pattern, with " +
        'context, then the last 30 lines; tail: the last lines; full: everything, cut at 60k characters.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'integer' },
          mode: { type: 'string', enum: allOf<'errors' | 'tail' | 'full'>()('errors', 'tail', 'full') },
          lines: { type: 'integer', description: 'tail: how many lines (default 100).' },
          pattern: { type: 'string', description: 'errors: a case-insensitive regex instead of the error words.' },
        },
        required: ['jobId'],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_job_log']>,
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__gitlab__gitlab_mr' }, async ($, e) => run($, mr, e, options.tokens)).catch(failed)
  on('tool.call', { tool: 'mcp__gitlab__gitlab_mr_comment' }, async ($, e) => run($, comment, e, options.tokens)).catch(failed)
  on('tool.call', { tool: 'mcp__gitlab__gitlab_pipeline' }, async ($, e) => run($, pipeline, e, options.tokens)).catch(failed)
  on('tool.call', { tool: 'mcp__gitlab__gitlab_job_log' }, async ($, e) => run($, jobLog, e, options.tokens)).catch(failed)
}
