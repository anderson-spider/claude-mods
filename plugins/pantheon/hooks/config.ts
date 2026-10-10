import { DEFAULT_CONFIG, ROLES } from './defaults'
import { isClaudeModel } from './models'
import type { AgentConfig, ConfigResult, Origin, PantheonConfig, ReadFile, Role } from './types'

type Layer = {
  disabledAgents?: string[]
  agents?: Partial<Record<Role, AgentConfig>>
  council?: { seats?: Record<string, AgentConfig> }
}

const ENTRY_KEYS = ['model', 'effort', 'prompt'] as const
const NATIVE_ONLY = 'Pantheon runs only native Claude agents'
// Fields of the Codex and profile era: each fails with what to do instead.
const REMOVED_TOP: Record<string, string> = {
  profile: `profiles were removed (${NATIVE_ONLY}); set model and effort under agents.<role> and council.seats.<seat>, then delete \`profile\``,
  profiles: `profiles were removed (${NATIVE_ONLY}); move each role's model and effort from profiles.<name>.agents.<role> to agents.<role>, then delete \`profiles\``,
  sandboxCap: `removed with Codex (${NATIVE_ONLY}); delete it`,
  noNetwork: `removed with Codex (${NATIVE_ONLY}); delete it`,
  foregroundMinutes: `removed with Codex (${NATIVE_ONLY}); delete it`,
}
// Role names of earlier versions: each fails with the new name.
const RENAMED_ROLES: Record<string, Role> = {
  explorer: 'code-reader',
  librarian: 'docs-reader',
  executor: 'developer',
  designer: 'ux',
  oracle: 'architect',
  fixer: 'developer',
}
const REMOVED_ENTRY: Record<string, string> = {
  engine: `removed (${NATIVE_ONLY}); delete it`,
  sandbox: `removed with Codex (${NATIVE_ONLY}); delete it`,
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field}: expected object`)
  return value as Record<string, unknown>
}

function entry(raw: unknown, field: string): AgentConfig {
  const value = object(raw, field)
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(REMOVED_ENTRY, key)) throw new Error(`${field}.${key}: ${REMOVED_ENTRY[key]}`)
    if (!(ENTRY_KEYS as readonly string[]).includes(key)) throw new Error(`${field}.${key}: unknown field (${JSON.stringify(value[key])})`)
    if (typeof value[key] !== 'string') throw new Error(`${field}.${key}: expected string`)
  }
  if (typeof value.model === 'string' && !isClaudeModel(value.model)) {
    throw new Error(`${field}.model: "${value.model}" is not a Claude model (${NATIVE_ONLY})`)
  }
  return value as AgentConfig
}

/** Fails with every former role name found in `agents` and `disabledAgents`, each with its new name. */
function renamedRoles(config: Record<string, unknown>): void {
  const found: string[] = []
  const rename = (old: string, place: string) => found.push(place === 'agents'
    ? `agents.${old}: role \`${old}\` was renamed to \`${RENAMED_ROLES[old]}\`; use \`agents.${RENAMED_ROLES[old]}\``
    : `disabledAgents: role \`${old}\` was renamed to \`${RENAMED_ROLES[old]}\`; use \`${RENAMED_ROLES[old]}\` in \`disabledAgents\``)
  const agents = config.agents
  if (typeof agents === 'object' && agents !== null && !Array.isArray(agents)) {
    for (const name of new Set(Object.keys(agents))) if (Object.hasOwn(RENAMED_ROLES, name)) rename(name, 'agents')
  }
  if (Array.isArray(config.disabledAgents)) {
    for (const name of new Set(config.disabledAgents)) if (typeof name === 'string' && Object.hasOwn(RENAMED_ROLES, name)) rename(name, 'disabledAgents')
  }
  if (found.length) throw new Error(found.join('; '))
}

function validate(value: unknown): Layer {
  const config = object(value, 'config')
  for (const key of Object.keys(config)) {
    if (Object.hasOwn(REMOVED_TOP, key)) throw new Error(`${key}: ${REMOVED_TOP[key]}`)
    if (!['disabledAgents', 'agents', 'council'].includes(key)) throw new Error(`${key}: unknown field (${JSON.stringify(config[key])})`)
  }
  renamedRoles(config)
  const layer: Layer = {}
  if (Object.hasOwn(config, 'disabledAgents')) {
    const disabled = config.disabledAgents
    if (!Array.isArray(disabled) || disabled.some(name =>
      typeof name !== 'string' || !(
        (ROLES as readonly string[]).includes(name) || name === 'council' ||
        (name.startsWith('councillor:') && name.length > 'councillor:'.length)
      ),
    )) throw new Error('disabledAgents: expected list of roles, councillor:<seat> or council')
    layer.disabledAgents = disabled as string[]
  }
  if (Object.hasOwn(config, 'agents')) {
    const agents = object(config.agents, 'agents')
    layer.agents = {}
    for (const [name, raw] of Object.entries(agents)) {
      if (!(ROLES as readonly string[]).includes(name)) throw new Error(`agents.${name}: unknown field (${JSON.stringify(raw)})`)
      layer.agents[name as Role] = entry(raw, `agents.${name}`)
    }
  }
  if (Object.hasOwn(config, 'council')) {
    const council = object(config.council, 'council')
    for (const key of Object.keys(council)) if (key !== 'seats') throw new Error(`council.${key}: unknown field (${JSON.stringify(council[key])})`)
    if (Object.hasOwn(council, 'seats')) {
      const seats: Record<string, AgentConfig> = {}
      for (const [name, raw] of Object.entries(object(council.seats, 'council.seats'))) seats[name] = entry(raw, `council.seats.${name}`)
      layer.council = { seats }
    }
  }
  return layer
}

function copy(config: PantheonConfig): PantheonConfig {
  return {
    disabledAgents: [...config.disabledAgents],
    agents: Object.fromEntries(ROLES.map(role => [role, { ...config.agents[role] }])) as PantheonConfig['agents'],
    council: { seats: Object.fromEntries(Object.entries(config.council.seats).map(([name, seat]) => [name, { ...seat }])) },
  }
}

/** Defaults, then `~/.claude/pantheon.json`, then `<repo>/.claude/pantheon.json`, merged field by field. */
export async function loadConfig(
  read: ReadFile,
  paths: { user: string; project?: string },
  lastValid?: PantheonConfig,
): Promise<ConfigResult> {
  const config = copy(DEFAULT_CONFIG)
  const origins: Record<string, Origin> = {}
  const mark = (field: string, origin: Origin) => { origins[field] = origin }
  for (const role of ROLES) for (const key of Object.keys(config.agents[role])) mark(`agents.${role}.${key}`, 'default')
  for (const [seat, value] of Object.entries(config.council.seats)) for (const key of Object.keys(value)) mark(`council.seats.${seat}.${key}`, 'default')

  const sources: [string, Origin][] = [[paths.user, 'user']]
  if (paths.project !== undefined) sources.push([paths.project, 'project'])
  for (const [path, origin] of sources) {
    let layer: Layer
    try {
      const text = await read(path)
      if (text === undefined) continue
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { throw new Error('Invalid JSON') }
      layer = validate(parsed)
    } catch (error) {
      return { ok: false, error: `${path}: ${error instanceof Error ? error.message : String(error)}`, config: lastValid ?? DEFAULT_CONFIG }
    }
    if (layer.disabledAgents) {
      config.disabledAgents = [...new Set([...config.disabledAgents, ...layer.disabledAgents])]
      mark('disabledAgents', origin)
    }
    for (const [role, value] of Object.entries(layer.agents ?? {}) as [Role, AgentConfig][]) {
      config.agents[role] = { ...config.agents[role], ...value }
      for (const key of Object.keys(value)) mark(`agents.${role}.${key}`, origin)
    }
    for (const [seat, value] of Object.entries(layer.council?.seats ?? {})) {
      const previous = Object.hasOwn(config.council.seats, seat) ? config.council.seats[seat] : {}
      config.council.seats = { ...config.council.seats, [seat]: { ...previous, ...value } }
      mark(`council.seats.${seat}`, origin)
      for (const key of Object.keys(value)) mark(`council.seats.${seat}.${key}`, origin)
    }
  }
  return { ok: true, config, origins }
}
