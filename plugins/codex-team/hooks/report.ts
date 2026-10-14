// The brief a team agent receives and the report it writes at the end. Pure.
import type { Role } from './roles'

/** The report's fields, in order: the lead reads only this file. */
export const REPORT_FIELDS = ['status', 'summary', 'files', 'checks', 'blockers', 'questions', 'drafts'] as const
export const REVIEW_FIELDS = ['verdict', 'risk', 'findings', 'checks'] as const

/** The reviewer gets the recorded developer task and worktree, never caller-supplied replacements. */
export function reviewTask(input: { cwd: string; task: string; report: string }, focus?: string): string {
  return [
    `Review the developer's worktree: ${input.cwd}.`,
    `Original task:\n${input.task}`,
    `Developer report: ${input.report}`,
    'Read the repository AGENTS.md and any applicable nested rules. Review `git status --short`, `git diff`, `git diff --staged` and every untracked file against the original task and those rules.',
    'Report concrete failure scenarios with file and line references and a fix. Use accept when there are no actionable findings and leave the findings list empty then. Write only the reviewer report; leave the worktree untouched.',
    ...(focus?.trim() ? [`Additional review focus:\n${focus.trim()}`] : []),
  ].join('\n\n')
}

/** `<reports root>/<repository name>/<workspace token>/<slug>-<role>.md`; token is validated by dispatch. */
export function reportPath(root: string, repo: string, token: string, slug: string, role: Role): string {
  const name = repo.replace(/\/+$/, '').split('/').pop() || 'repo'
  return `${root.replace(/\/+$/, '')}/${name}/${token}/${slug}-${role}.md`
}

/** The prompt sent to the agent: the task, where it runs, and the report it must write. */
export function brief(input: { role: Role; slug: string; repo: string; cwd: string; task: string; report: string; followup?: boolean }): string {
  return [
    `Task \`${input.slug}\` for the ${input.role}.`,
    `Repository: ${input.repo}. Your working directory: ${input.cwd}.`,
    '',
    ...(input.role === 'developer' && input.followup ? [`This is a fresh session for a previously dispatched task: read your previous report at ${input.report} and inspect the git diff in your worktree before continuing.`] : []),
    input.task.trim(),
    '',
    `When you finish, or if you are blocked, write ${input.report} (create its directory if needed) in exactly this Markdown format, keeping it short:`,
    '',
    '```',
    ...(input.role === 'reviewer' ? [
      'verdict: accept | changes_needed',
      'risk: low | high',
      'findings:',
      '- <severity> <file>:<line> <failure scenario> -> <fix>',
      'checks: each command you ran and its result (pass or fail), one per line',
    ] : [
      'status: done | blocked | partial',
      'summary: at most five lines',
      'files: the paths you changed, one per line, or none',
      'checks: each command you ran and its result (pass or fail), one per line',
      'blockers: what stops you, or none',
      'questions: what the lead must decide, or none',
      'drafts: text for the developer to apply (analyst only), or none',
    ]),
    '```',
    '',
    'Then stop and wait for the next task.',
  ].join('\n')
}
