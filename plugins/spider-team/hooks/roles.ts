// Roles own permissions and instructions; routing changes only model and effort.
import { defaultOf } from './router'
export const ROLES = ['analyst', 'planner', 'reviewer'] as const
export type Role = typeof ROLES[number]
/** Roles the plugin no longer registers: their ledger lines still parse and keep their own stats groups. */
export const RETIRED_ROLES = ['developer', 'architect'] as const
export type LedgerRole = Role | typeof RETIRED_ROLES[number]
// The ladder in router.ts is typed against these lists. Fable is out of the routing policy.
export const MODELS = ['haiku', 'sonnet', 'opus'] as const
export type Model = typeof MODELS[number]
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = typeof EFFORTS[number]
export type Pair = { model: Model; effort: Effort }
const readers = ['Read', 'Grep', 'Glob', 'LSP', 'Skill']
const noDelegation = ['Agent', 'SendMessage', 'ToolSearch', 'EnterWorktree', 'ExitWorktree']
const handback = 'End with a short answer for the lead: the outcome first, then findings with file:line evidence, limitations and open questions, the checks you ran and the next steps the lead needs. No preamble, process narrative or repeated context.'
// The plugin's Bash guard (`hooks/guard.ts`) refuses any other command these roles run; the prompt names the same list.
const git = 'Run only read-only git commands (git status, log, diff, show, merge-base, ls-files, blame, rev-parse; git -C <dir> for another checkout), one at a time, without pipes, redirection or unquoted wildcards; any other command is refused.'
const common = 'Follow the project instructions and the authorized task. Work independently within this role and the brief\'s scope; when the brief is unclear or the task is out of reach, say so instead of guessing. ' + handback
export const SPECS = {
  analyst: { name: 'analyst', description: 'Investigate code, git history and evidence without changing anything.', ...defaultOf('analyst'), tools: [...readers, 'Bash'], disallowedTools: ['Write', 'Edit', 'NotebookEdit', ...noDelegation], prompt: 'Investigate without implementing. For history, read the git log, blame and diffs. ' + git + ' Cite file:line or commit evidence, uncertainties and open questions. Lead with the finding, then its evidence and open questions, unless the brief asks for another format. ' + common },
  planner: { name: 'planner', description: 'Plan a change as Markdown steps and acceptance checks without changing anything.', ...defaultOf('planner'), tools: readers, disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash', ...noDelegation], prompt: 'Plan the smallest sufficient change without implementing it or writing any file. Answer with one Markdown plan: goal and scope; ordered steps, one line each with the files it touches; the invariants to preserve, including authentication, schema and API contracts; an acceptance checklist of commands to run with their expected results; and assumptions or blockers. Name only paths, commands and host features you verified, and mark anything you could not verify. ' + common },
  reviewer: { name: 'reviewer', description: 'Review the lead\'s branch and uncommitted changes without changing anything.', ...defaultOf('reviewer'), tools: [...readers, 'Bash'], disallowedTools: ['Write', 'Edit', 'NotebookEdit', ...noDelegation], prompt: 'Review the lead\'s checkout named in the brief: the commits from the merge base with the target branch named in the brief (git merge-base <target> HEAD) to HEAD, the staged and unstaged changes, and every untracked file listed by git ls-files --others --exclude-standard, read in full. ' + git + ' Never edit, commit, stash, checkout or run tests. Judge the complete resulting diff, not only the latest fixes. If you cannot inspect any of these parts, answer BLOCKED and say which. Report actionable findings, one per line with its file:line, and risk with a verdict APPROVED, CHANGES or BLOCKED. Distinguish checks reported by the lead from evidence you inspected. ' + common },
} as const
export function roleOf(type: unknown): Role | undefined {
  return ROLES.find(role => type === `spider-team:${role}`)
}
