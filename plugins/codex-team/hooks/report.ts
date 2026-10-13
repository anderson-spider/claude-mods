// The brief a team agent receives and the report it writes at the end. Pure.
import type { Role } from './roles'

/** The report's fields, in order: the lead reads only this file. */
export const REPORT_FIELDS = ['status', 'summary', 'files', 'checks', 'blockers', 'questions', 'drafts'] as const

/** `<reports root>/<repository name>/<slug>-<role>.md`. */
export function reportPath(root: string, repo: string, slug: string, role: Role): string {
  const name = repo.replace(/\/+$/, '').split('/').pop() || 'repo'
  return `${root.replace(/\/+$/, '')}/${name}/${slug}-${role}.md`
}

/** The prompt sent to the agent: the task, where it runs, and the report it must write. */
export function brief(input: { role: Role; slug: string; repo: string; cwd: string; task: string; report: string }): string {
  return [
    `Task \`${input.slug}\` for the ${input.role}.`,
    `Repository: ${input.repo}. Your working directory: ${input.cwd}.`,
    '',
    input.task.trim(),
    '',
    `When you finish, or if you are blocked, write ${input.report} (create its directory if needed) in exactly this Markdown format, keeping it short:`,
    '',
    '```',
    'status: done | blocked | partial',
    'summary: at most five lines',
    'files: the paths you changed, one per line, or none',
    'checks: each command you ran and its result (pass or fail), one per line',
    'blockers: what stops you, or none',
    'questions: what the lead must decide, or none',
    'drafts: text for the developer to apply (analyst only), or none',
    '```',
    '',
    'Then stop and wait for the next task.',
  ].join('\n')
}
