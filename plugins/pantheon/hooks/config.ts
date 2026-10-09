import { BASE_DEFAULTS, BUILTIN_PROFILES, DEFAULT_CONFIG, ROLES } from './defaults'
import type { ProfileEntries } from './defaults'
import { modelMismatch } from './models'
import type { ConfigResult, Origin, PantheonConfig, ReadFile, Role, RoleConfig, Seat } from './types'

type Entry = Partial<Pick<RoleConfig, 'engine' | 'model' | 'effort'>>
type ProfileLayer = { agents?: Partial<Record<Role, Entry>>; council?: { seats?: Record<string, Entry> } }
type TopConfig = Omit<PantheonConfig, 'agents' | 'council'> & {
  agents: Record<Role, Pick<RoleConfig, 'prompt' | 'sandbox'>>
  council: { seats: Record<string, Pick<Seat, 'prompt'>> }
}
type ConfigLayer = Partial<Omit<TopConfig, 'agents' | 'council'>> & {
  agents?: Partial<TopConfig['agents']>
  council?: { seats?: TopConfig['council']['seats'] }
  profiles?: Record<string, ProfileLayer>
}
type Layer = { config: ConfigLayer; path: string; origin: Origin }
type Provenance = { origins: Map<string, Origin>; paths: Map<string, string> }

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field}: expected object`)
  return value as Record<string, unknown>
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[], prefix = ''): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${prefix}${key}: unknown field (${JSON.stringify(value[key])})`)
  }
}

function sandbox(value: unknown, field: string): void {
  if (value !== 'read-only' && value !== 'workspace-write') {
    throw new Error(`${field}: sandbox refused (${JSON.stringify(value)}); use read-only or workspace-write`)
  }
}

function strings(value: Record<string, unknown>, prefix: string): void {
  for (const key of ['model', 'effort', 'prompt']) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'string') throw new Error(`${prefix}.${key}: expected string`)
  }
}

function entries(value: Record<string, unknown>, prefix: string, profile?: string): void {
  const check = (raw: unknown, field: string, role: boolean): void => {
    const entry = object(raw, field)
    if (profile !== undefined) {
      for (const key of ['engine', 'model', 'effort']) {
        if (Object.hasOwn(entry, key)) throw new Error(`${field}.${key}: moved to profiles.${profile}.${field}.${key}`)
      }
    }
    knownKeys(entry, profile === undefined ? ['engine', 'model', 'effort'] : role ? ['prompt', 'sandbox'] : ['prompt'], `${field}.`)
    strings(entry, field)
    if (Object.hasOwn(entry, 'sandbox')) sandbox(entry.sandbox, `${field}.sandbox`)
    if (Object.hasOwn(entry, 'engine') && entry.engine !== 'codex' && entry.engine !== 'claude') {
      throw new Error(`${field}.engine: expected codex or claude`)
    }
  }
  if (Object.hasOwn(value, 'agents')) {
    const agents = object(value.agents, `${prefix}agents`)
    knownKeys(agents, ROLES, `${prefix}agents.`)
    for (const [name, raw] of Object.entries(agents)) check(raw, `${prefix}agents.${name}`, true)
  }
  if (Object.hasOwn(value, 'council')) {
    const council = object(value.council, `${prefix}council`)
    knownKeys(council, ['seats'], `${prefix}council.`)
    if (Object.hasOwn(council, 'seats')) {
      const seats = object(council.seats, `${prefix}council.seats`)
      for (const [name, raw] of Object.entries(seats)) check(raw, `${prefix}council.seats.${name}`, false)
    }
  }
}

function validate(value: unknown): ConfigLayer {
  const config = object(value, 'config')
  knownKeys(config, ['profile', 'profiles', 'sandboxCap', 'noNetwork', 'foregroundMinutes', 'disabledAgents', 'agents', 'council'])
  if (Object.hasOwn(config, 'profile') && (typeof config.profile !== 'string' || !config.profile.trim())) {
    throw new Error('profile: expected non-empty string')
  }
  if (Object.hasOwn(config, 'sandboxCap')) sandbox(config.sandboxCap, 'sandboxCap')
  if (Object.hasOwn(config, 'noNetwork') && typeof config.noNetwork !== 'boolean') throw new Error('noNetwork: expected boolean')
  if (Object.hasOwn(config, 'foregroundMinutes')) {
    const minutes = config.foregroundMinutes
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
      throw new Error('foregroundMinutes: expected finite number greater than zero')
    }
  }
  if (Object.hasOwn(config, 'disabledAgents')) {
    const disabled = config.disabledAgents
    if (!Array.isArray(disabled) || disabled.some(name =>
      typeof name !== 'string' || !(
        (ROLES as readonly string[]).includes(name) || name === 'council' ||
        (name.startsWith('councillor:') && name.length > 'councillor:'.length)
      ),
    )) throw new Error('disabledAgents: expected list of roles, councillor:<seat> or council')
  }
  entries(config, '', typeof config.profile === 'string' ? config.profile : 'claude')
  if (Object.hasOwn(config, 'profiles')) {
    for (const [name, raw] of Object.entries(object(config.profiles, 'profiles'))) {
      const profile = object(raw, `profiles.${name}`)
      knownKeys(profile, ['agents', 'council'], `profiles.${name}.`)
      entries(profile, `profiles.${name}.`)
    }
  }
  return config as ConfigLayer
}

function leaves(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const field = prefix ? `${prefix}.${key}` : key
    return typeof child === 'object' && child !== null && !Array.isArray(child) ? leaves(child, field) : [field]
  })
}

function mark(meta: Provenance, key: string, origin: Origin, path?: string): void {
  meta.origins.set(key, origin)
  if (path !== undefined) meta.paths.set(key, path)
  else meta.paths.delete(key)
}

function fail(meta: Provenance, key: string, message: string): never {
  const path = meta.paths.get(key)
  throw new Error(path === undefined ? message : `${path}: ${message}`)
}

function mergeTop(config: TopConfig, layer: Layer, meta: Provenance): void {
  const { profiles: _profiles, ...top } = layer.config
  for (const field of leaves(top)) {
    // A weaker declaration is not the source of the effective policy.
    if (field === 'sandboxCap' && config.sandboxCap === 'read-only' && top.sandboxCap === 'workspace-write') continue
    if (field === 'noNetwork' && config.noNetwork && !top.noNetwork) continue
    mark(meta, field, layer.origin, layer.path)
  }
  if (top.profile !== undefined) config.profile = top.profile
  if (top.sandboxCap === 'read-only') config.sandboxCap = 'read-only'
  if (top.noNetwork) config.noNetwork = true
  if (top.foregroundMinutes !== undefined) config.foregroundMinutes = top.foregroundMinutes
  if (top.disabledAgents) config.disabledAgents = [...new Set([...config.disabledAgents, ...top.disabledAgents])]
  for (const role of ROLES) {
    if (top.agents && Object.hasOwn(top.agents, role)) config.agents[role] = { ...config.agents[role], ...top.agents[role] }
  }
  for (const [name, seat] of Object.entries(top.council?.seats ?? {})) {
    const previous = Object.hasOwn(config.council.seats, name) ? config.council.seats[name] : {}
    config.council.seats = { ...config.council.seats, [name]: { ...previous, ...seat } }
    mark(meta, `council.seats.${name}`, layer.origin, layer.path)
  }
}

function copyProfile(profile: ProfileEntries): ProfileEntries {
  return {
    agents: Object.fromEntries(ROLES.map(role => [role, { ...profile.agents[role] }])) as ProfileEntries['agents'],
    council: { seats: Object.fromEntries(Object.entries(profile.council.seats).map(([name, seat]) => [name, { ...seat }])) },
  }
}

function mergeProfile(profile: ProfileEntries, name: string, patch: ProfileLayer, layer: Layer, meta: Provenance): void {
  const merge = (previous: Entry, entry: Entry, field: string): Entry => {
    const result = { ...previous }
    // A newly declared entry has no engine yet; only an actual switch clears inherited choices.
    if (entry.engine !== undefined && previous.engine !== undefined && entry.engine !== previous.engine) {
      for (const key of ['model', 'effort'] as const) {
        delete result[key]
        meta.origins.delete(`${name}|${field}.${key}`)
        meta.paths.delete(`${name}|${field}.${key}`)
      }
    }
    for (const key of Object.keys(entry)) mark(meta, `${name}|${field}.${key}`, layer.origin, layer.path)
    mark(meta, `${name}|${field}`, layer.origin, layer.path)
    return { ...result, ...entry }
  }
  for (const role of ROLES) {
    if (patch.agents && Object.hasOwn(patch.agents, role)) {
      profile.agents[role] = merge(profile.agents[role], patch.agents[role]!, `agents.${role}`) as ProfileEntries['agents'][Role]
    }
  }
  for (const [seat, entry] of Object.entries(patch.council?.seats ?? {})) {
    const previous = Object.hasOwn(profile.council.seats, seat) ? profile.council.seats[seat]! : {}
    profile.council.seats = { ...profile.council.seats, [seat]: merge(previous, entry, `council.seats.${seat}`) }
  }
}

function validateProfile(name: string, profile: ProfileEntries, meta: Provenance): void {
  const check = (entry: Entry, field: string): void => {
    if (entry.engine === undefined) fail(meta, `${name}|${field}`, `profiles.${name}.${field}.engine: required`)
    const mismatch = modelMismatch(entry.engine, entry.model)
    if (mismatch) fail(meta, `${name}|${field}.model`, `profiles.${name}.${field}.model: ${mismatch}`)
  }
  for (const role of ROLES) check(profile.agents[role], `agents.${role}`)
  for (const [seat, entry] of Object.entries(profile.council.seats)) check(entry, `council.seats.${seat}`)
}

export async function loadConfig(
  read: ReadFile,
  paths: { user: string; project?: string },
  lastValid?: PantheonConfig,
): Promise<ConfigResult> {
  const rejected = (error: unknown): ConfigResult => ({
    ok: false, error: error instanceof Error ? error.message : String(error), config: lastValid ?? DEFAULT_CONFIG,
  })
  const layers: Layer[] = []
  const sources: [string, Origin][] = [[paths.user, 'user']]
  if (paths.project !== undefined) sources.push([paths.project, 'project'])
  for (const [path, origin] of sources) {
    try {
      const text = await read(path)
      if (text === undefined) continue
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { throw new Error('Invalid JSON') }
      layers.push({ config: validate(parsed), path, origin })
    } catch (error) {
      return rejected(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    const config: TopConfig = {
      ...BASE_DEFAULTS, profile: 'claude', disabledAgents: [],
      agents: Object.fromEntries(ROLES.map(role => [role, { ...BASE_DEFAULTS.agents[role] }])) as TopConfig['agents'],
      council: { seats: {} },
    }
    const meta: Provenance = { origins: new Map(), paths: new Map() }
    for (const field of leaves(config)) mark(meta, field, 'default')
    const profiles = new Map<string, ProfileEntries>(Object.entries(BUILTIN_PROFILES).map(([name, profile]) => [name, copyProfile(profile)]))
    for (const [name, profile] of profiles) for (const field of leaves(profile)) mark(meta, `${name}|${field}`, 'default')
    const custom = new Map<string, { patch: ProfileLayer; layer: Layer }[]>()
    for (const layer of layers) {
      mergeTop(config, layer, meta)
      for (const [name, patch] of Object.entries(layer.config.profiles ?? {})) {
        const builtin = profiles.get(name)
        if (builtin) mergeProfile(builtin, name, patch, layer, meta)
        else custom.set(name, [...(custom.get(name) ?? []), { patch, layer }])
      }
    }
    // Replay custom layers on the final Claude profile so switches and inherited origins survive.
    for (const [name, patches] of custom) {
      const inherited = copyProfile(profiles.get('claude')!)
      for (const field of leaves(inherited)) {
        mark(meta, `${name}|${field}`, meta.origins.get(`claude|${field}`) ?? 'default', meta.paths.get(`claude|${field}`))
      }
      for (const { patch, layer } of patches) mergeProfile(inherited, name, patch, layer, meta)
      profiles.set(name, inherited)
    }
    for (const [name, profile] of profiles) validateProfile(name, profile, meta)
    const active = profiles.get(config.profile)
    if (!active) fail(meta, 'profile', `profile: unknown profile "${config.profile}"; known: ${[...profiles.keys()].join(', ')}`)
    const seats: [string, Seat][] = Object.entries(active.council.seats).map(([name, seat]) => [name, { ...seat } as Seat])
    const effective: PantheonConfig = {
      ...config,
      agents: Object.fromEntries(ROLES.map(role => [role, { ...config.agents[role], ...active.agents[role] }])) as PantheonConfig['agents'],
      council: { seats: Object.fromEntries(seats) },
    }
    for (const [name, seat] of Object.entries(config.council.seats)) {
      if (!Object.hasOwn(effective.council.seats, name)) {
        fail(meta, `council.seats.${name}`, `council.seats.${name}.engine: required; declare it in profiles.${config.profile}.council.seats.${name}`)
      }
      effective.council.seats = { ...effective.council.seats, [name]: { ...effective.council.seats[name]!, ...seat } }
    }
    const profileFields = new Set(leaves(active))
    const origins: Record<string, Origin> = Object.fromEntries(leaves(effective).map(field => [
      field, meta.origins.get(profileFields.has(field) ? `${config.profile}|${field}` : field) ?? 'default',
    ]))
    return { ok: true, config: effective, origins }
  } catch (error) {
    return rejected(error)
  }
}
