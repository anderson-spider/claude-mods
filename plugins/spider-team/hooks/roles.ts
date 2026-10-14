// Roles own permissions and instructions; routing changes only model and effort.
export const ROLES = ['analyst', 'developer', 'reviewer', 'architect'] as const
export type Role = typeof ROLES[number]
export const MODELS = ['opus', 'sonnet', 'haiku'] as const
export type Model = typeof MODELS[number]
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = typeof EFFORTS[number]
export type ForwardEffort = 'low' | 'medium' | 'high'
export type ProfilePair = { model: Model; effort: Effort }
export const REPORT = 'mcp__spider-team__report'
export const DIFF = 'mcp__spider-team__diff'
const readers = ['Read', 'Grep', 'Glob', 'LSP', 'Skill', REPORT]
const readerDenied = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'PowerShell', 'Monitor', 'Agent', 'ToolSearch', 'EnterWorktree', 'ExitWorktree', 'SendMessage']
const receipt = 'Put all findings, evidence, checks and details in the report body, using ## sections only at top level. Call mcp__spider-team__report. End your turn by copying the receipt returned by the tool verbatim and nothing else. Never restate findings, evidence or the report body in your final message. If report fails, return only a short BLOCKED error. The receipt is the entire handback.'
const common = 'Follow the project instructions and the authorized task. Work independently within this role. If CodeGraph is required but unavailable in your tools, ask the lead for exploration evidence. ' + receipt
export const SPECS = {
  analyst: { name: 'analyst', description: 'Investigate code and evidence.', model: 'haiku', effort: 'medium', tools: readers, disallowedTools: readerDenied, prompt: 'Investigate without implementing. Cite file:line evidence, uncertainties and open questions. ' + common },
  architect: { name: 'architect', description: 'Design scoped changes.', model: 'opus', effort: 'high', tools: readers, disallowedTools: readerDenied, prompt: 'Design the smallest sufficient change: files, order, alternatives and invariants including authentication, schema and API contracts. Investigate without implementing. ' + common },
  reviewer: { name: 'reviewer', description: 'Review a completed developer checkout.', model: 'sonnet', effort: 'high', tools: [...readers, DIFF], disallowedTools: readerDenied, prompt: 'Use the developer receipt with mcp__spider-team__diff. Read committed, staged, unstaged and untracked changes in that checkout. Report actionable findings and risk with verdict APPROVED, CHANGES or BLOCKED. Inspect without fixing or executing tests. Distinguish checks reported by the developer from evidence you inspected. ' + common },
  developer: { name: 'developer', description: 'Implement and test in a native worktree.', model: 'sonnet', effort: 'medium', isolation: 'worktree', tools: ['Read', 'Grep', 'Glob', 'LSP', 'Skill', 'Write', 'Edit', 'Bash', REPORT], disallowedTools: ['Agent', 'SendMessage', 'ToolSearch', 'EnterWorktree', 'ExitWorktree', 'PowerShell', 'Monitor'], prompt: 'Implement the authorized scope in your own native worktree. Preserve unrelated changes, run appropriate tests and review the complete diff. Leave changes uncommitted unless the task explicitly authorizes commits or push. Collect your absolute checkout path and branch for report. Tracked uncommitted lead changes are absent; if they are prerequisites, stop with BLOCKED and ask for an adequate base. ' + common },
} as const
export function roleOf(type: unknown): Role | undefined {
  return ROLES.find(role => type === `spider-team:${role}`)
}
export function capEffort(effort: Effort): ForwardEffort { return effort === 'max' || effort === 'xhigh' ? 'high' : effort }
/** Resolved native Anthropic IDs only; opaque provider spellings fail closed. */
export function family(value: unknown): Model | undefined {
  if (MODELS.includes(value as Model)) return value as Model
  if (typeof value !== 'string') return undefined
  return /^claude-(opus|sonnet|haiku)-\d+(?:[-.]\d+)*$/.exec(value)?.[1] as Model | undefined
}
