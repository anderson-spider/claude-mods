import type {
  CodexCall, DelegateArgs, PantheonConfig, Role, RoleConfig, RolePrompts, Sandbox,
} from './types'

export const CODEX_ROLES: Role[] = ['explorer', 'librarian', 'fixer']
export const NATIVE_ROLES: Role[] = ['oracle', 'designer']

function isCodexRole(name: string): name is Role {
  return CODEX_ROLES.includes(name as Role)
}

function isNativeRole(name: string): boolean {
  return NATIVE_ROLES.includes(name as Role)
}

function seatDisabled(config: PantheonConfig, seat: string): boolean {
  return config.disabledAgents.includes('council') ||
    config.disabledAgents.includes(`councillor:${seat}`) ||
    config.disabledAgents.includes(`councillor-${seat}`)
}

/** Seats que o council usa: não desligados (nem o council inteiro), em ordem de nome. */
export function activeSeats(config: PantheonConfig): string[] {
  return Object.keys(config.council.seats).filter(name => !seatDisabled(config, name)).sort()
}

function validCodexAgents(config: PantheonConfig): string[] {
  return [
    ...CODEX_ROLES.filter(role => !config.disabledAgents.includes(role)),
    ...Object.entries(config.council.seats)
      .filter(([name, seat]) => seat.engine === 'codex' && !seatDisabled(config, name))
      .map(([name]) => `councillor:${name}`),
  ]
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
    return { error: `sandboxCap inválido: ${config.sandboxCap}` }
  }

  const unavailable = (): { error: string } => ({
    error: `Agente desconhecido ou desativado: ${args.agent}. Agentes válidos: ${validCodexAgents(config).join(', ') || 'nenhum'}.`,
  })
  let override: RoleConfig
  let key: Role | 'councillor'
  let sandbox: Sandbox

  if (isNativeRole(args.agent)) {
    if (config.disabledAgents.includes(args.agent)) return unavailable()
    return { error: `Use pantheon:${args.agent} pela ferramenta Agent.` }
  }

  if (isCodexRole(args.agent)) {
    if (config.disabledAgents.includes(args.agent)) return unavailable()
    override = config.agents[args.agent]
    key = args.agent
    const requested = override.sandbox ?? (args.agent === 'fixer' ? 'workspace-write' : 'read-only')
    if (!validSandbox(requested)) return { error: `Sandbox inválido para ${args.agent}: ${requested}` }
    sandbox = requested === 'read-only' || config.sandboxCap === 'read-only' ? 'read-only' : 'workspace-write'
  } else if (args.agent.startsWith('councillor:')) {
    const name = args.agent.slice('councillor:'.length)
    if (!Object.hasOwn(config.council.seats, name) || seatDisabled(config, name)) return unavailable()
    const seat = config.council.seats[name]!
    if (seat.engine === 'claude') return { error: `Use pantheon:councillor-${name} pela ferramenta Agent.` }
    override = seat
    key = 'councillor'
    sandbox = 'read-only'
  } else {
    return unavailable()
  }

  return {
    agent: args.agent,
    model: args.model ?? override.model,
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
  const descriptions: Partial<Record<Role, string>> = {
    oracle: 'Analyze architecture, debug difficult problems and review technical decisions.',
    designer: 'Design and implement interfaces and user experiences.',
  }
  const specs: NativeSpec[] = NATIVE_ROLES
    .filter(role => isOffered(config, `pantheon:${role}`))
    .map(role => {
      const override = config.agents[role]
      return {
        name: role,
        description: descriptions[role]!,
        prompt: appendPrompt(prompts(role, 'claude'), override.prompt),
        model: override.model,
        effort: override.effort,
        ...(role === 'oracle' ? { tools: ['Read', 'Grep', 'Glob'] } : {}),
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
  if (isNativeRole(name)) return true
  if (!name.startsWith('councillor-')) return false
  const seat = name.slice('councillor-'.length)
  return !seatDisabled(config, seat) && Object.hasOwn(config.council.seats, seat) &&
    config.council.seats[seat]?.engine === 'claude'
}
