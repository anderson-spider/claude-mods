// Where Jev's key comes from. Pure: environment, settings and file reads are injected.
// Order: the environment, then ~/.jev-router.env, then the `jevKey` option. A key variable that the repository's own
// settings (project or local) declare is ignored, and so is `HOME` for the file (it must also be absolute): the prompts
// would go out under that repository's account. When those settings cannot be read there is no key at all. The key is
// never logged or put in a message.

export const KEY_NAMES = ['TYPESAFE_API_KEY', 'JEV_API_KEY'] as const
export const KEY_FILE = '.jev-router.env'

export type KeyIo = {
  env: (name: string) => Promise<string | undefined>
  /** The `env` block of one settings source; rejects when it cannot be read. */
  settingsEnv: (source: 'project' | 'local') => Promise<Record<string, unknown> | undefined>
  /** A file's text; rejects when it is missing or the host refuses it. */
  read: (path: string) => Promise<string>
  home: () => Promise<string | undefined>
}

export type KeySource = 'env' | 'file' | 'option'
export type ResolvedKey = {
  key?: string
  source?: KeySource
  /** The trusted home read in the same pass as the key (see `trustedHome`); undefined when there is none. */
  home?: string
}

/** `KEY=VALUE` lines of a dotenv file: `export` prefix, quotes and `#` comments handled; nothing else is read. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = (match[2] ?? '').trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) value = value.slice(1, value.lastIndexOf(quote))
    else value = value.replace(/\s+#.*$/, '')
    out[match[1] as string] = value.trim()
  }
  return out
}

/**
 * The names the repository's own settings (project or local) declare in their `env` block, among the key variables
 * and `HOME`; undefined when they cannot be read. Such a variable reaches the process environment, so its value is
 * the repository's, not the user's.
 */
async function declaredNames(io: KeyIo): Promise<Set<string> | undefined> {
  const declared = new Set<string>()
  try {
    for (const source of ['project', 'local'] as const) {
      const env = await io.settingsEnv(source)
      if (env && typeof env === 'object') for (const name of [...KEY_NAMES, 'HOME']) if (Object.hasOwn(env, name)) declared.add(name)
    }
  } catch {
    return undefined
  }
  return declared
}

/**
 * The user's home directory: absolute, and not declared by the repository's settings. Anything else is undefined, so
 * a repository cannot point `~/.jev-router.env` (or the `~` of redaction) at a folder of its own.
 */
export async function trustedHome(io: KeyIo, scanned?: Set<string>): Promise<string | undefined> {
  const declared = scanned ?? (await declaredNames(io))
  if (!declared || declared.has('HOME')) return undefined
  const home = (await io.home().catch(() => undefined))?.trim().replace(/\/+$/, '')
  return home && home.startsWith('/') ? home : undefined
}

async function fromEnv(io: KeyIo, declared: Set<string>): Promise<string | undefined> {
  for (const name of KEY_NAMES) {
    if (declared.has(name)) continue
    const value = (await io.env(name).catch(() => undefined))?.trim()
    if (value) return value
  }
  return undefined
}

async function fromFile(io: KeyIo, home: string | undefined): Promise<string | undefined> {
  try {
    if (!home) return undefined
    const values = parseEnvFile(await io.read(`${home}/${KEY_FILE}`))
    for (const name of KEY_NAMES) if (values[name]) return values[name]
  } catch {
    // Missing file, or a host that does not allow the read: the next source.
  }
  return undefined
}

/**
 * No key at all when the repository's settings cannot be read: nothing about the environment can be trusted. The
 * home comes out of the same scan, so one read of the settings serves the key file and the caller's redaction.
 */
export async function resolveKey(io: KeyIo, option?: unknown): Promise<ResolvedKey> {
  const declared = await declaredNames(io)
  if (!declared) return {}
  const home = await trustedHome(io, declared)
  const withHome = (resolved: ResolvedKey): ResolvedKey => (home ? { ...resolved, home } : resolved)
  const env = await fromEnv(io, declared)
  if (env) return withHome({ key: env, source: 'env' })
  const file = await fromFile(io, home)
  if (file) return withHome({ key: file, source: 'file' })
  const fallback = typeof option === 'string' ? option.trim() : ''
  return withHome(fallback ? { key: fallback, source: 'option' } : {})
}

/** Whether a settings source's `pluginConfigs` give this plugin a value for `option`. */
export function declaresOption(configs: unknown, plugin: string, option: string): boolean {
  if (!configs || typeof configs !== 'object') return false
  for (const [name, value] of Object.entries(configs)) {
    if (name !== plugin && !name.startsWith(`${plugin}@`)) continue
    const options = (value as { options?: unknown } | null | undefined)?.options
    if (options && typeof options === 'object' && Object.hasOwn(options, option)) return true
  }
  return false
}
