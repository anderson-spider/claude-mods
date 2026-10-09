import type {
  CodexCall, DelegateArgs, PantheonConfig, Role, RoleConfig, RolePrompts, Sandbox,
} from './types'
import { ROLES, ROLE_SANDBOX } from './defaults'
import { modelMismatch } from './models'

function isRole(name: string): name is Role {
  return ROLES.some(role => role === name)
}

function isCodexRole(config: PantheonConfig, name: string): name is Role {
  return isRole(name) && config.agents[name].engine === 'codex'
}

function isNativeRole(config: PantheonConfig, name: string): name is Role {
  return isRole(name) && config.agents[name].engine === 'claude'
}

function seatDisabled(config: PantheonConfig, seat: string): boolean {
  return config.disabledAgents.includes('council') ||
    config.disabledAgents.includes(`councillor:${seat}`) ||
    config.disabledAgents.includes(`councillor-${seat}`)
}

/** Active council seats, including the council-wide switch, sorted by name. */
export function activeSeats(config: PantheonConfig): string[] {
  return Object.keys(config.council.seats).filter(name => !seatDisabled(config, name)).sort()
}

export function codexAgents(config: PantheonConfig): string[] {
  return [
    ...ROLES.filter(role => isCodexRole(config, role) && !config.disabledAgents.includes(role)),
    ...Object.entries(config.council.seats)
      .filter(([name, seat]) => seat.engine === 'codex' && !seatDisabled(config, name))
      .map(([name]) => `councillor:${name}`),
  ]
}

export function usesCodex(config: PantheonConfig): boolean {
  return codexAgents(config).length > 0
}

function appendPrompt(base: string, extra: string | undefined): string {
  return base + (extra ? `\n\n${extra}` : '')
}

function validSandbox(value: string): value is Sandbox {
  return value === 'read-only' || value === 'workspace-write'
}

export function resolveCodexCall(
  config: PantheonConfig,
  args: DelegateArgs,
  ctx: { cwd: string; skipGitRepoCheck: boolean; resumeSessionId?: string },
  prompts: RolePrompts,
): CodexCall | { error: string } {
  if (!validSandbox(config.sandboxCap)) {
    return { error: `Invalid sandboxCap: ${config.sandboxCap}` }
  }

  const unavailable = (): { error: string } => ({
    error: `Unknown or disabled agent: ${args.agent}. Valid agents: ${codexAgents(config).join(', ') || 'none'}.`,
  })
  let override: RoleConfig
  let key: Role | 'councillor'
  let sandbox: Sandbox

  if (isNativeRole(config, args.agent)) {
    if (config.disabledAgents.includes(args.agent)) return unavailable()
    return { error: `Use pantheon:${args.agent} through the Agent tool.` }
  }

  if (isCodexRole(config, args.agent)) {
    if (config.disabledAgents.includes(args.agent)) return unavailable()
    override = config.agents[args.agent]
    key = args.agent
    const requested = override.sandbox ?? ROLE_SANDBOX[args.agent]
    if (!validSandbox(requested)) return { error: `Invalid sandbox for ${args.agent}: ${requested}` }
    sandbox = [ROLE_SANDBOX[args.agent], requested, config.sandboxCap].includes('read-only')
      ? 'read-only' : 'workspace-write'
  } else if (args.agent.startsWith('councillor:')) {
    const name = args.agent.slice('councillor:'.length)
    if (!Object.hasOwn(config.council.seats, name) || seatDisabled(config, name)) return unavailable()
    const seat = config.council.seats[name]!
    if (seat.engine === 'claude') return { error: `Use pantheon:councillor-${name} through the Agent tool.` }
    override = seat
    key = 'councillor'
    sandbox = 'read-only'
  } else {
    return unavailable()
  }

  const model = args.model ?? override.model
  const mismatch = modelMismatch('codex', model)
  if (mismatch) return { error: mismatch }

  return {
    agent: args.agent,
    model,
    effort: args.effort ?? override.effort,
    sandbox,
    noNetwork: config.noNetwork,
    prompt: `${appendPrompt(prompts(key, 'codex'), override.prompt)}\n\n---\n\n${args.prompt}`,
    cwd: ctx.cwd,
    skipGitRepoCheck: ctx.skipGitRepoCheck,
    resumeSessionId: ctx.resumeSessionId,
  }
}

type NativeSpec = {
  name: string; description: string; prompt: string; model?: string; effort?: string; tools?: string[]
}

export function nativeAgentSpecs(config: PantheonConfig, prompts: RolePrompts): NativeSpec[] {
  const descriptions: Record<Role, string> = {
    explorer: 'Pantheon codebase recon that returns compressed context.',
    librarian: 'Pantheon research on external docs and APIs.',
    fixer: 'Pantheon bounded implementation from a complete specification.',
    oracle: 'Analyze architecture, debug difficult problems and review technical decisions.',
    designer: 'Design and implement interfaces and user experiences.',
  }
  const specs: NativeSpec[] = ROLES
    .filter(role => isOffered(config, `pantheon:${role}`))
    .map(role => {
      const override = config.agents[role]
      return {
        name: role,
        description: descriptions[role],
        prompt: appendPrompt(prompts(role, 'claude'), override.prompt),
        model: override.model,
        effort: override.effort,
        ...(['explorer', 'librarian', 'oracle'].includes(role)
          ? { tools: ['Read', 'Grep', 'Glob', ...(role === 'librarian' ? ['WebSearch', 'WebFetch'] : [])] } : {}),
      }
    })

  for (const [name, seat] of Object.entries(config.council.seats)) {
    if (seat.engine !== 'claude' || seatDisabled(config, name)) continue
    specs.push({
      name: `councillor-${name}`,
      description: `Give an independent read-only assessment as council seat ${name}.`,
      prompt: appendPrompt(prompts('councillor', 'claude'), seat.prompt),
      model: seat.model,
      effort: seat.effort,
      tools: ['Read', 'Grep', 'Glob'],
    })
  }
  return specs
}

export function isOffered(config: PantheonConfig, agentType: string): boolean {
  if (!agentType.startsWith('pantheon:')) return true
  const name = agentType.slice('pantheon:'.length)
  if (config.disabledAgents.includes(name)) return false
  if (isRole(name)) return isNativeRole(config, name)
  if (!name.startsWith('councillor-')) return false
  const seat = name.slice('councillor-'.length)
  return !seatDisabled(config, seat) && Object.hasOwn(config.council.seats, seat) &&
    config.council.seats[seat]?.engine === 'claude'
}
