import type { PantheonConfig, Role, RolePrompts } from './types'
import { ROLES } from './defaults'

function isRole(name: string): name is Role {
  return ROLES.some(role => role === name)
}

export function seatDisabled(config: PantheonConfig, seat: string): boolean {
  return config.disabledAgents.includes('council') ||
    config.disabledAgents.includes(`councillor:${seat}`) ||
    config.disabledAgents.includes(`councillor-${seat}`)
}

/** Active council seats, including the council-wide switch, sorted by name. */
export function activeSeats(config: PantheonConfig): string[] {
  return Object.keys(config.council.seats).filter(name => !seatDisabled(config, name)).sort()
}

function appendPrompt(base: string, extra: string | undefined): string {
  return base + (extra ? `\n\n${extra}` : '')
}

type NativeSpec = {
  name: string; description: string; prompt: string; model?: string; effort?: string
  disallowedTools?: readonly string[]
}

// Architect, qa and the councillors inherit the session's tools minus the ones that change files (qa writes only in the scratchpad, through Bash).
// Code-reader and docs-reader keep file tools (told by prompt not to use them).
const NO_FILE_EDITS = ['Edit', 'Write', 'NotebookEdit'] as const
// Read-only roles also cannot spawn agents.
const NO_DELEGATION = ['Agent'] as const
const READ_ONLY_DENY = [...NO_FILE_EDITS, ...NO_DELEGATION]
const RESEARCH_DENY = [...NO_DELEGATION]

export function nativeAgentSpecs(config: PantheonConfig, prompts: RolePrompts): NativeSpec[] {
  const descriptions: Record<Role, string> = {
    'code-reader': 'Pantheon codebase recon that returns compressed context.',
    'docs-reader': 'Pantheon research on external docs and APIs.',
    developer: 'Pantheon implementation of all code (backend, scripts, tests, hooks, CLI, UI logic) from a complete specification.',
    architect: 'Analyze architecture, debug difficult problems and review technical decisions.',
    qa: 'Runs what was built and returns a pass/fail verdict per acceptance criterion, with evidence.',
    ux: 'Owns look and feel (layout, hierarchy, color, spacing, motion, UI copy) and implements it.',
    git: 'Perform git operations (squash, PR/MR, checkout, switch, worktree, stash) from the lead brief; does not push.',
  }
  const specs: NativeSpec[] = ROLES
    .filter(role => isOffered(config, `pantheon:${role}`))
    .map(role => {
      const override = config.agents[role]
      return {
        name: role,
        description: descriptions[role],
        prompt: appendPrompt(prompts(role), override.prompt),
        model: override.model,
        effort: override.effort,
        ...(role === 'architect' || role === 'qa' ? { disallowedTools: READ_ONLY_DENY }
          : role === 'code-reader' || role === 'docs-reader' || role === 'git' ? { disallowedTools: RESEARCH_DENY } : {}),
      }
    })

  for (const [name, seat] of Object.entries(config.council.seats)) {
    if (seatDisabled(config, name)) continue
    specs.push({
      name: `councillor-${name}`,
      description: `Give an independent read-only assessment as council seat ${name}.`,
      prompt: appendPrompt(prompts('councillor'), seat.prompt),
      model: seat.model,
      effort: seat.effort,
      disallowedTools: READ_ONLY_DENY,
    })
  }
  return specs
}

export function isOffered(config: PantheonConfig, agentType: string): boolean {
  if (!agentType.startsWith('pantheon:')) return true
  const name = agentType.slice('pantheon:'.length)
  if (config.disabledAgents.includes(name)) return false
  if (isRole(name)) return true
  if (!name.startsWith('councillor-')) return false
  const seat = name.slice('councillor-'.length)
  return !seatDisabled(config, seat) && Object.hasOwn(config.council.seats, seat)
}
