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

// Oracle and the councillors inherit the session's tools minus the ones that change files.
// Explorer and librarian keep file tools (told by prompt not to use them).
const NO_FILE_EDITS = ['Edit', 'Write', 'NotebookEdit'] as const
// Read-only roles also cannot spawn agents.
const NO_DELEGATION = ['Agent'] as const
const READ_ONLY_DENY = [...NO_FILE_EDITS, ...NO_DELEGATION]
const RESEARCH_DENY = [...NO_DELEGATION]

export function nativeAgentSpecs(config: PantheonConfig, prompts: RolePrompts): NativeSpec[] {
  const descriptions: Record<Role, string> = {
    explorer: 'Pantheon codebase recon that returns compressed context.',
    librarian: 'Pantheon research on external docs and APIs.',
    executor: 'Pantheon bounded implementation from a complete specification.',
    oracle: 'Analyze architecture, debug difficult problems and review technical decisions.',
    designer: 'Design and implement interfaces and user experiences.',
    git: 'Perform git operations (commit, squash, push, PR/MR, checkout, worktree, stash) from the orchestrator brief.',
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
        ...(role === 'oracle' ? { disallowedTools: READ_ONLY_DENY }
          : role === 'explorer' || role === 'librarian' || role === 'git' ? { disallowedTools: RESEARCH_DENY } : {}),
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
