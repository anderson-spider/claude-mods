import { DEFAULT_CONFIG } from './defaults'
import type { ConfigResult, Origin, PantheonConfig, ReadFile, RoleOverride, Seat } from './types'

const roles = ['explorer', 'librarian', 'fixer', 'oracle', 'designer'] as const
type ConfigLayer = Partial<Omit<PantheonConfig, 'agents' | 'council'>> & {
  agents?: Partial<PantheonConfig['agents']>
  council?: { seats?: Record<string, Seat> }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field}: esperado objeto`)
  }
  return value as Record<string, unknown>
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[], prefix = ''): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new Error(`${prefix}${key}: campo desconhecido (${JSON.stringify(value[key])})`)
    }
  }
}

function sandbox(value: unknown, field: string): void {
  if (value !== 'read-only' && value !== 'workspace-write') {
    throw new Error(`${field}: sandbox recusado (${JSON.stringify(value)}); use read-only ou workspace-write`)
  }
}

function strings(value: Record<string, unknown>, prefix: string): void {
  for (const key of ['model', 'effort', 'prompt']) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'string') {
      throw new Error(`${prefix}.${key}: esperado texto`)
    }
  }
}

function validate(value: unknown): ConfigLayer {
  const config = object(value, 'config')
  knownKeys(config, ['sandboxCap', 'noNetwork', 'foregroundMinutes', 'disabledAgents', 'agents', 'council'])
  if (Object.hasOwn(config, 'sandboxCap')) sandbox(config.sandboxCap, 'sandboxCap')
  if (Object.hasOwn(config, 'noNetwork') && typeof config.noNetwork !== 'boolean') {
    throw new Error('noNetwork: esperado booleano')
  }
  if (Object.hasOwn(config, 'foregroundMinutes')) {
    const minutes = config.foregroundMinutes
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
      throw new Error('foregroundMinutes: esperado número finito maior que zero')
    }
  }
  if (Object.hasOwn(config, 'disabledAgents')) {
    const disabled = config.disabledAgents
    if (!Array.isArray(disabled) || disabled.some(name =>
      typeof name !== 'string' || !(
        (roles as readonly string[]).includes(name) || name === 'council' ||
        (name.startsWith('councillor:') && name.length > 'councillor:'.length)
      ),
    )) {
      throw new Error('disabledAgents: esperado lista de papéis, councillor:<seat> ou council')
    }
  }
  if (Object.hasOwn(config, 'agents')) {
    const agents = object(config.agents, 'agents')
    knownKeys(agents, roles, 'agents.')
    for (const [name, raw] of Object.entries(agents)) {
      const prefix = `agents.${name}`
      const role = object(raw, prefix)
      const codex = name === 'explorer' || name === 'librarian' || name === 'fixer'
      knownKeys(role, codex ? ['model', 'effort', 'prompt', 'sandbox'] : ['model', 'effort', 'prompt'], `${prefix}.`)
      strings(role, prefix)
      if (Object.hasOwn(role, 'sandbox')) sandbox(role.sandbox, `${prefix}.sandbox`)
    }
  }
  if (Object.hasOwn(config, 'council')) {
    const council = object(config.council, 'council')
    knownKeys(council, ['seats'], 'council.')
    if (Object.hasOwn(council, 'seats')) {
      const seats = object(council.seats, 'council.seats')
      for (const [name, raw] of Object.entries(seats)) {
        const prefix = `council.seats.${name}`
        const seat = object(raw, prefix)
        knownKeys(seat, ['engine', 'model', 'effort', 'prompt'], `${prefix}.`)
        // engine é opcional por camada (override parcial); o seat efetivo precisa de um.
        if (Object.hasOwn(seat, 'engine') && seat.engine !== 'codex' && seat.engine !== 'claude') {
          throw new Error(`${prefix}.engine: esperado codex ou claude`)
        }
        strings(seat, prefix)
      }
    }
  }
  return config as ConfigLayer
}

function freshDefaults(): PantheonConfig {
  return {
    ...DEFAULT_CONFIG,
    disabledAgents: [...DEFAULT_CONFIG.disabledAgents],
    agents: Object.fromEntries(roles.map(name => [name, { ...DEFAULT_CONFIG.agents[name] }])) as PantheonConfig['agents'],
    council: {
      seats: Object.fromEntries(Object.entries(DEFAULT_CONFIG.council.seats).map(([name, seat]) => [name, { ...seat }])),
    },
  }
}

function leaves(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const field = prefix ? `${prefix}.${key}` : key
    return typeof child === 'object' && child !== null && !Array.isArray(child)
      ? leaves(child, field) : [field]
  })
}

function merge(config: PantheonConfig, layer: ConfigLayer, origins: Record<string, Origin>, origin: Origin): void {
  for (const field of leaves(layer)) {
    // A declaração menos restritiva não passa a ser a origem da política efetiva.
    if (field === 'sandboxCap' && config.sandboxCap === 'read-only' && layer.sandboxCap === 'workspace-write') continue
    if (field === 'noNetwork' && config.noNetwork && !layer.noNetwork) continue
    origins[field] = origin
  }
  if (layer.sandboxCap === 'read-only') config.sandboxCap = 'read-only'
  if (layer.noNetwork) config.noNetwork = true
  if (layer.foregroundMinutes !== undefined) config.foregroundMinutes = layer.foregroundMinutes
  if (layer.disabledAgents) config.disabledAgents = [...new Set([...config.disabledAgents, ...layer.disabledAgents])]
  for (const name of roles) {
    if (layer.agents && Object.hasOwn(layer.agents, name)) {
      config.agents[name] = { ...config.agents[name], ...layer.agents[name] } as RoleOverride
    }
  }
  if (layer.council?.seats) {
    const seats = Object.entries(layer.council.seats).map(([name, seat]) => [
      name,
      { ...(Object.hasOwn(config.council.seats, name) ? config.council.seats[name] : {}), ...seat },
    ])
    config.council.seats = { ...config.council.seats, ...Object.fromEntries(seats) }
  }
}

export async function loadConfig(
  read: ReadFile,
  paths: { user: string; project?: string },
  lastValid?: PantheonConfig,
): Promise<ConfigResult> {
  const config = freshDefaults()
  const origins: Record<string, Origin> = Object.fromEntries(leaves(config).map(field => [field, 'default']))
  const sources: [string, Origin][] = [[paths.user, 'user']]
  if (paths.project !== undefined) sources.push([paths.project, 'project'])
  for (const [path, origin] of sources) {
    try {
      const text = await read(path)
      if (text === undefined) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('JSON inválido')
      }
      merge(config, validate(parsed), origins, origin)
      for (const [name, seat] of Object.entries(config.council.seats)) {
        if (seat.engine !== 'codex' && seat.engine !== 'claude') {
          throw new Error(`council.seats.${name}.engine: esperado codex ou claude`)
        }
      }
    } catch (error) {
      return {
        ok: false,
        error: `${path}: ${error instanceof Error ? error.message : String(error)}`,
        config: lastValid ?? DEFAULT_CONFIG,
      }
    }
  }
  return { ok: true, config, origins }
}
