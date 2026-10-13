// The team's roles as data: the model, effort, sandbox and instructions each Codex agent starts with. Pure.

export const ROLES = ['developer', 'analyst', 'architect'] as const
export type Role = (typeof ROLES)[number]

export const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
export type Effort = (typeof EFFORTS)[number]

export type RoleSpec = {
  model: string
  effort: Effort
  /** `true`: the agent works in a task worktree and may write there; `false`: it reads the repository and writes only reports. */
  writes: boolean
  instructions: string
}

const REPORT_RULE =
  'When the task is done, or when you are blocked, write the report file named in the task, in the format it gives, and nothing else outside the task. '

export const SPECS: Readonly<Record<Role, RoleSpec>> = {
  developer: {
    model: 'gpt-6.1-sol',
    effort: 'high',
    writes: true,
    instructions:
      'You are the developer of a team led by another agent. You implement the task in your working directory, a git worktree of its own: ' +
      "follow the repository's AGENTS.md, write and run the tests, and leave every change uncommitted in the worktree: the lead reviews the diff and git work belongs to the lead. Stay in your worktree. " +
      REPORT_RULE,
  },
  analyst: {
    model: 'gpt-6-luna',
    effort: 'medium',
    writes: false,
    instructions:
      'You are the systems analyst of a team led by another agent. You investigate code, git history, documentation and the web, and you draft documentation. ' +
      'You never change the repository: documentation you draft goes into the report, for the developer to apply. ' +
      REPORT_RULE,
  },
  architect: {
    model: 'gpt-6.1-sol',
    effort: 'high',
    writes: false,
    instructions:
      'You are the architect of a team led by another agent. You design changes and weigh trade-offs: return decisions with their reasons, the files involved, ordered steps and risks. ' +
      'You never change the repository. ' +
      REPORT_RULE,
  },
}

/** An agent name Herdr accepts (`[a-z][a-z0-9_-]{0,31}`): the role's own for the reusable roles, `dev-<slug>` per task for the developer. */
export function agentName(role: Role, slug: string): string {
  return role === 'developer' ? `dev-${slug}` : role
}

/** A task slug: lowercase letters, digits and hyphens, starting with a letter, at most 28 characters (so `dev-<slug>` fits Herdr's 32). */
export const SLUG = /^[a-z][a-z0-9-]{0,27}$/

/** A TOML basic string: JSON's escaping is valid TOML for the characters it emits. */
const toml = (value: string) => JSON.stringify(value)

/**
 * The `codex` arguments for a role: model, effort, a workspace-write sandbox with the network, no approvals, the role's
 * instructions. `writableRoots` adds directories beyond the working directory (the reports directory, for the developer).
 * Codex keeps every `.git` read-only under this sandbox, so no role can commit.
 */
export function codexArgs(spec: RoleSpec, effort: Effort, writableRoots: readonly string[]): string[] {
  return [
    '-m', spec.model,
    '-c', `model_reasoning_effort=${toml(effort)}`,
    '-s', 'workspace-write',
    '-a', 'never',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-c', `sandbox_workspace_write.writable_roots=[${writableRoots.map(toml).join(', ')}]`,
    '-c', `developer_instructions=${toml(spec.instructions)}`,
  ]
}
