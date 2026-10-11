// Where Jev's key comes from. Pure: the settings and environment reads are injected.
// The `jevKey` option is the only source and the only switch: filled in, Jev routes; empty, nothing happens. A `jevKey`
// that the repository's own settings (project or local) declare is ignored, and so is `HOME` when they declare it or it
// is not absolute: the prompts would go out under that repository's account. When those settings cannot be read there
// is no routing at all. The key is never logged or put in a message.

export type KeyIo = {
  /** One settings source's `env` block and `pluginConfigs`; rejects when it cannot be read. */
  settings: (source: 'project' | 'local') => Promise<{ env?: unknown; pluginConfigs?: unknown } | undefined>
  home: () => Promise<string | undefined>
}

/** Why routing is off. */
export type Off = 'no-key' | 'bad-key' | 'unreadable' | 'repo-key'

export type Access = {
  key?: string
  /** The trusted home read in the same pass as the key; undefined when there is none. */
  home?: string
  off?: Off
}

/** Printable ASCII with no space, so the `Authorization` header cannot be broken by what was pasted. */
const KEY_SHAPE = /^[\x21-\x7e]{1,512}$/

/** The option as a key: empty or absent is `no-key` (silently off), anything not shaped like a key is `bad-key`. */
export function checkKey(value: unknown): { key: string; off?: undefined } | { key?: undefined; off: 'no-key' | 'bad-key' } {
  if (value === undefined || value === null) return { off: 'no-key' }
  if (typeof value !== 'string') return { off: 'bad-key' }
  const key = value.trim()
  if (!key) return { off: 'no-key' }
  return KEY_SHAPE.test(key) ? { key } : { off: 'bad-key' }
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

/**
 * Whether routing may run, with the key and the home that redaction trusts. The settings are read once, and only for
 * a valid key; unreadable ones, or a `jevKey` the repository declares, turn routing off. The home is absolute and not
 * declared by the repository's settings, or there is none.
 */
export async function resolveAccess(io: KeyIo, option: unknown): Promise<Access> {
  const checked = checkKey(option)
  if (checked.key === undefined) return { off: checked.off }

  let declaresKey = false
  let declaresHome = false
  try {
    for (const source of ['project', 'local'] as const) {
      const settings = await io.settings(source)
      if (declaresOption(settings?.pluginConfigs, 'crew', 'jevKey')) declaresKey = true
      const env = settings?.env
      if (env && typeof env === 'object' && Object.hasOwn(env, 'HOME')) declaresHome = true
    }
  } catch {
    return { off: 'unreadable' }
  }
  if (declaresKey) return { off: 'repo-key' }

  const home = declaresHome ? undefined : (await io.home().catch(() => undefined))?.trim().replace(/\/+$/, '')
  return home && home.startsWith('/') ? { key: checked.key, home } : { key: checked.key }
}
