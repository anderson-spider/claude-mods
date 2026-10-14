// Roles own permissions and instructions; routing changes only model and effort.
import { defaultOf } from './router'
export const ROLES = ['analyst', 'developer', 'reviewer', 'architect'] as const
export type Role = typeof ROLES[number]
// Capacity order, weakest first. The router table in router.ts is typed against these lists.
export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
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
  architect: { name: 'architect', description: 'Design scoped changes and check invariants without changing anything.', ...defaultOf('architect'), tools: readers, disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash', ...noDelegation], prompt: 'Design the smallest sufficient change: files, order, alternatives and invariants including authentication, schema and API contracts. Investigate without implementing. ' + common },
  reviewer: { name: 'reviewer', description: 'Review a developer worktree without changing it.', ...defaultOf('reviewer'), tools: [...readers, 'Bash'], disallowedTools: ['Write', 'Edit', 'NotebookEdit', ...noDelegation], prompt: 'Review the worktree named in the brief: read its committed, staged, unstaged and untracked changes with read-only git commands (status, log, diff). Never edit, commit, stash, checkout or run tests. Report actionable findings and risk with a verdict APPROVED, CHANGES or BLOCKED. Distinguish checks reported by the developer from evidence you inspected. ' + common },
  developer: { name: 'developer', description: 'Implement and test in its own worktree.', ...defaultOf('developer'), isolation: 'worktree', tools: [...readers, 'Write', 'Edit', 'Bash'], disallowedTools: noDelegation, prompt: 'Implement the authorized scope in your own worktree. Preserve unrelated changes, run appropriate tests and review the complete diff. Leave changes uncommitted unless the task explicitly authorizes commits or push. Tracked uncommitted lead changes are absent; if they are prerequisites, stop and say so. Name your absolute worktree path and branch in the answer. ' + common },
} as const
export function roleOf(type: unknown): Role | undefined {
  return ROLES.find(role => type === `spider-team:${role}`)
}
