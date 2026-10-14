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
const handback = 'End with a short answer for the lead: the outcome first, then findings with file:line evidence, open questions and checks. No preamble or repeated context.'
const common = 'Follow the project instructions and the authorized task. Work independently within this role. ' + handback
export const SPECS = {
  analyst: { name: 'analyst', description: 'Investigate code and evidence without changing anything.', ...defaultOf('analyst'), tools: readers, disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash', ...noDelegation], prompt: 'Investigate without implementing. Cite file:line evidence, uncertainties and open questions. ' + common },
  planner: { name: 'planner', description: 'Plan a change as Markdown steps and acceptance checks without changing anything.', ...defaultOf('planner'), tools: readers, disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash', ...noDelegation], prompt: 'Plan the smallest sufficient change without implementing it or writing any file. Answer with one Markdown plan: goal and scope; ordered steps, each with the files it touches; the invariants to preserve, including authentication, schema and API contracts; an acceptance checklist of commands to run with their expected results; and assumptions or blockers. Name only paths, commands and host features you verified, and mark anything you could not verify. ' + common },
  reviewer: { name: 'reviewer', description: 'Review the lead\'s branch and uncommitted changes without changing anything.', ...defaultOf('reviewer'), tools: [...readers, 'Bash'], disallowedTools: ['Write', 'Edit', 'NotebookEdit', ...noDelegation], prompt: 'Review the lead\'s checkout named in the brief: the commits from the merge base with the target branch named in the brief (git merge-base <target> HEAD) to HEAD, the staged and unstaged changes, and every untracked file listed by git status, read in full. Use read-only git commands only (status, log, diff, show, merge-base, ls-files). Never edit, commit, stash, checkout or run tests. Judge the complete resulting diff, not only the latest fixes. If you cannot inspect any of these parts, answer BLOCKED and say which. Report actionable findings and risk with a verdict APPROVED, CHANGES or BLOCKED. Distinguish checks reported by the lead from evidence you inspected. ' + common },
} as const
export function roleOf(type: unknown): Role | undefined {
  return ROLES.find(role => type === `spider-team:${role}`)
}
