import type { EngineInterface, McpToolInputs, Register } from 'claude-code'
import { GitlabError, gitlab } from './api'
import { comment } from './comments'
import { InputError, makeCtx, type Ctx } from './context'
import { errorText } from './errors'
import { jobLog } from './joblog'
import { label } from './labels'
import { mr } from './mr'
import { pipeline } from './pipelines'
import { rawGet } from './raw'
import { currentBranch, locate, projectPath, sshHostname, type Git, type Ssh } from './remote'
import { allOf, type SchemaFor } from './schema'
import { offText, resolveToken, type TokenIo } from './tokens'

type Inputs = McpToolInputs

const MR_ACTIONS = allOf<Inputs['mcp__gitlab__gitlab_mr']['action']>()(
  'list', 'get', 'status', 'create', 'update', 'diff', 'commits', 'approve', 'unapprove', 'rebase', 'merge',
)
const COMMENT_ACTIONS = allOf<Inputs['mcp__gitlab__gitlab_mr_comment']['action']>()(
  'list', 'comment', 'reply', 'line', 'edit', 'resolve', 'unresolve',
)
const PIPELINE_ACTIONS = allOf<Inputs['mcp__gitlab__gitlab_pipeline']['action']>()('list', 'jobs', 'run', 'retry', 'cancel', 'play', 'artifacts')

const IID = { type: 'integer', description: 'MR !iid. Default: the open MR of the current branch.' } as const
const NAMES = { type: 'array', items: { type: 'string' } } as const
const PROJECT = { type: 'string', description: 'Another project path on the same host (group/project).' } as const
const PAGE = { type: 'integer' } as const
const PER_PAGE = { type: 'integer', description: 'Max 100.' } as const
const ALLOW_OTHERS = { type: 'boolean', description: "Write on someone else's MR; only when the user asked." } as const

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

/**
 * The host wiring every tool shares: finds the project from the git remote (an SSH alias resolved through `ssh -G`),
 * picks that host's token, switches to `project` when given (same host only) and runs the tool.
 */
async function run(
  $: EngineInterface,
  tool: (ctx: Ctx, input: Record<string, unknown>) => Promise<string>,
  input: Record<string, unknown>,
  option: unknown,
): Promise<ReturnType<typeof reply>> {
  const git: Git = (args) => $.process.run(['git', ...args], { timeoutMs: 10_000 })
  const ssh: Ssh = (args) => $.process.run(['ssh', ...args], { timeoutMs: 5_000 })
  const where = await locate(git)
  if ('error' in where) return reply(where.error, true)
  const io = tokenIo($)
  let host = where.host
  let access = await resolveToken(io, option, host)
  if (access.off === 'no-host' && where.ssh) {
    // an SSH remote may name a ~/.ssh/config alias (`git@work:group/app.git`): its token is the real host's
    const real = await sshHostname(ssh, host)
    if (real && real !== host) {
      access = await resolveToken(io, option, real)
      if (access.off === 'no-host') return reply(`The remote's host ${host} is an SSH alias for ${real}. ${offText('no-host', real)}`, true)
      host = real
    } else if (!host.includes('.')) {
      return reply(`${offText('no-host', host)} If ${host} is an SSH alias from ~/.ssh/config, ssh -G could not resolve it: give the remote the real host name.`, true)
    }
  }
  if (access.off !== undefined) return reply(offText(access.off, host), true)
  let project = where.project
  if (input.project !== undefined) {
    const named = typeof input.project === 'string' ? projectPath(input.project) : undefined
    if (!named) return reply(`project must be a project path on ${host} (group/project), not a URL: the token goes only to the remote's host.`, true)
    project = named
  }
  // $.http.fetch is wrapped, not passed as a value: the engine's validate rejects the latter.
  const api = gitlab((url, init) => $.http.fetch(url, init), host, project, access.token)
  // an answer can echo what the request carried (a proxy's error page, a fetch error), so the token is masked in every output
  const masked = (text: string, isError = false) => reply(text.split(access.token).join('[token]'), isError)
  const foreign = project.toLowerCase() !== where.project.toLowerCase()
  try {
    return masked(await tool(makeCtx(api, () => currentBranch(git), foreign), input))
  } catch (err) {
    if (err instanceof InputError) return masked(err.message, true)
    if (err instanceof GitlabError) return masked(errorText(err, project, host), true)
    return masked(`Call to ${host} failed: ${err instanceof Error ? err.message : String(err)}`, true)
  }
}

/** A hook that threw (a bug, not an API answer) still ends the call with an error instead of leaving it unanswered. */
const failed = () => reply('The gitlab tool failed before it could answer. Try again; if it repeats, run claude --debug.', true)

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'gitlab_mr',
      description:
        "Merge requests of the current repo's GitLab project. list (filters; allProjects: every project; next = more " +
        'pages), get, status (pipeline, approvals, discussions, conflicts, blockers), diff, commits, create, update, ' +
        'approve, unapprove, rebase, merge (only when the user asks; iid and head sha required; refused for drafts, ' +
        'conflicts, blocking discussions, protected targets other than main/master/develop). Labels must exist unless ' +
        'createMissingLabels. Writes on MRs by others are refused without allowOthers.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: MR_ACTIONS },
          project: PROJECT,
          iid: IID,
          state: { type: 'string', enum: allOf<'opened' | 'merged' | 'closed' | 'all'>()('opened', 'merged', 'closed', 'all') },
          scope: { type: 'string', enum: allOf<'created_by_me' | 'assigned_to_me' | 'all'>()('created_by_me', 'assigned_to_me', 'all') },
          author: { type: 'string', description: 'list: username or @me.' },
          assignee: { type: 'string' },
          reviewer: { type: 'string' },
          search: { type: 'string' },
          allProjects: { type: 'boolean' },
          page: PAGE,
          perPage: PER_PAGE,
          title: { type: 'string' },
          description: { type: 'string' },
          sourceBranch: { type: 'string' },
          targetBranch: { type: 'string' },
          labels: { ...NAMES, description: 'list filter; create/update: all labels.' },
          addLabels: NAMES,
          removeLabels: NAMES,
          createMissingLabels: { type: 'boolean' },
          assignees: { ...NAMES, description: '@me is the token owner.' },
          reviewers: NAMES,
          draft: { type: 'boolean' },
          stateEvent: { type: 'string', enum: allOf<'close' | 'reopen'>()('close', 'reopen') },
          removeSourceBranch: { type: 'boolean' },
          squash: { type: 'boolean' },
          files: { ...NAMES, description: 'diff: paths containing these.' },
          sha: { type: 'string', description: 'merge: full head sha from status.' },
          whenPipelineSucceeds: { type: 'boolean' },
          allowOthers: ALLOW_OTHERS,
          allowProtectedTarget: { type: 'boolean' },
        },
        required: ['action'],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_mr']>,
    })
    await $.tool.register({
      name: 'gitlab_mr_comment',
      description:
        'Discussions of a merge request: list (ids, authors, file/line, resolved; next = more pages), comment, reply ' +
        'to a discussion, line (a diff comment on path at line, or oldLine for a removed line), edit a note, resolve, ' +
        'unresolve. Writes on MRs by others are refused without allowOthers.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: COMMENT_ACTIONS },
          project: PROJECT,
          iid: IID,
          body: { type: 'string', description: 'Markdown text.' },
          discussionId: { type: 'string' },
          noteId: { type: 'integer' },
          path: { type: 'string', description: 'line: file path as in the diff.' },
          line: { type: 'integer', description: 'line: new-side line number.' },
          oldLine: { type: 'integer', description: 'line: old-side line number (both for an unchanged line).' },
          unresolvedOnly: { type: 'boolean' },
          page: PAGE,
          perPage: PER_PAGE,
          allowOthers: ALLOW_OTHERS,
        },
        required: ['action'],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_mr_comment']>,
    })
    await $.tool.register({
      name: 'gitlab_pipeline',
      description:
        "Pipelines of a merge request (iid, or the current branch's MR) or of a ref: list; jobs of a pipeline " +
        '(default the latest) with downstream pipelines; run (an MR pipeline, or a ref pipeline with variables); ' +
        'retry or cancel a job or pipeline; play a manual job; artifacts of a job (names, sizes, URL). ' +
        'Read a failed job with gitlab_job_log.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: PIPELINE_ACTIONS },
          project: PROJECT,
          iid: IID,
          ref: { type: 'string', description: 'Branch or tag instead of an MR.' },
          pipelineId: { type: 'integer' },
          jobId: { type: 'integer' },
          failedOnly: { type: 'boolean', description: 'jobs: only failed jobs.' },
          variables: { ...NAMES, description: 'run with ref: KEY=value.' },
          page: PAGE,
          perPage: PER_PAGE,
          allowOthers: ALLOW_OTHERS,
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
          project: PROJECT,
          mode: { type: 'string', enum: allOf<'errors' | 'tail' | 'full'>()('errors', 'tail', 'full') },
          lines: { type: 'integer', description: 'tail: how many lines (default 100).' },
          pattern: { type: 'string', description: 'errors: a case-insensitive regex instead of the error words.' },
        },
        required: ['jobId'],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_job_log']>,
    })
    await $.tool.register({
      name: 'gitlab_label',
      description:
        "Labels of the current repo's GitLab project (its own and its groups'): list (name, colour, description; " +
        'search; next = more pages); create (name, color default #428BCA, description), which answers the existing ' +
        'label when the name is taken.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: allOf<Inputs['mcp__gitlab__gitlab_label']['action']>()('list', 'create') },
          project: PROJECT,
          name: { type: 'string' },
          color: { type: 'string', description: 'Hex, like #428BCA.' },
          description: { type: 'string' },
          search: { type: 'string' },
          page: PAGE,
          perPage: PER_PAGE,
        },
        required: ['action'],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_label']>,
    })
    await $.tool.register({
      name: 'gitlab_api',
      description:
        "Read-only GitLab API on the current repo's host, for reads the other gitlab tools lack: one GET of a path " +
        'relative to /api/v4 starting with projects, merge_requests, groups, users or labels (project paths ' +
        'URL-encoded, query allowed). The answer is cut at 60k characters.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Like projects/group%2Fapp/merge_requests?state=opened.' },
        },
        required: ['path'],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_api']>,
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__gitlab__gitlab_mr' }, async ($, e) => run($, mr, e, options.tokens)).catch(failed)
  on('tool.call', { tool: 'mcp__gitlab__gitlab_mr_comment' }, async ($, e) => run($, comment, e, options.tokens)).catch(failed)
  on('tool.call', { tool: 'mcp__gitlab__gitlab_pipeline' }, async ($, e) => run($, pipeline, e, options.tokens)).catch(failed)
  on('tool.call', { tool: 'mcp__gitlab__gitlab_job_log' }, async ($, e) => run($, jobLog, e, options.tokens)).catch(failed)
  on('tool.call', { tool: 'mcp__gitlab__gitlab_label' }, async ($, e) => run($, label, e, options.tokens)).catch(failed)
  on('tool.call', { tool: 'mcp__gitlab__gitlab_api' }, async ($, e) => run($, rawGet, e, options.tokens)).catch(failed)
}
