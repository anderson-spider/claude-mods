// Where the Coolify instance and its API token come from. Pure: the settings read is injected.
// The `url` and `apiKey` options are the only sources. Either one declared by the repository's own settings (project or
// local) with a value the user's settings do not give it refuses the call: a repository that set the url could send the
// user's token to a host it controls, and one that set the key would choose the account. The same value as the user's is
// not a choice of the repository: with Claude opened in the home folder, the project settings are the user's own
// ~/.claude/settings.json. Settings that cannot be read refuse the call as well. No message carries a value.

export type AccessIo = {
  /** One settings source's `pluginConfigs`; rejects when it cannot be read. */
  settings: (source: 'user' | 'project' | 'local') => Promise<{ pluginConfigs?: unknown } | undefined>
}

export type Off = 'no-key' | 'bad-key' | 'no-url' | 'bad-url' | 'unreadable' | 'repo-option'

/** What each refusal tells the user: where to set the option, never a value. */
export const OFF_TEXT: Record<Off, string> = {
  'no-key': 'The coolify apiKey option is not set. Set it in the plugin options (/plugin, coolify, configure).',
  'bad-key': 'The coolify apiKey option is not a valid token. Set it again in the plugin options (/plugin, coolify, configure).',
  'no-url': 'The coolify url option is not set. Set it to your instance, such as https://coolify.example.com, in the plugin options (/plugin, coolify, configure).',
  'bad-url':
    'The coolify url option must be an https address with no user, path, query or fragment, such as https://coolify.example.com. Set it again in the plugin options (/plugin, coolify, configure).',
  unreadable: 'The project or local settings could not be read, so the coolify url and apiKey options are not used.',
  'repo-option':
    'The repository settings declare the coolify url or apiKey option, so neither is used. Set them in your user plugin options instead.',
}

/** The path every Coolify API call goes under. */
export const API_PATH = '/api/v1'

/** Printable ASCII with no space, so the `Authorization` header cannot be broken by what was pasted. */
const KEY_SHAPE = /^[\x21-\x7e]{1,512}$/

export function checkKey(value: unknown): { key: string; off?: undefined } | { key?: undefined; off: 'no-key' | 'bad-key' } {
  if (value === undefined || value === null) return { off: 'no-key' }
  if (typeof value !== 'string') return { off: 'bad-key' }
  const key = value.trim()
  if (!key) return { off: 'no-key' }
  return KEY_SHAPE.test(key) ? { key } : { off: 'bad-key' }
}

/**
 * The API base (`https://host[:port]/api/v1`) of the `url` option, or why there is none. Only https, so the token
 * never travels in clear text; no credentials, query or fragment; the path may be empty or already `/api/v1`.
 */
export function checkUrl(value: unknown): { base: string; off?: undefined } | { base?: undefined; off: 'no-url' | 'bad-url' } {
  if (value === undefined || value === null) return { off: 'no-url' }
  if (typeof value !== 'string') return { off: 'bad-url' }
  const text = value.trim()
  if (!text) return { off: 'no-url' }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { off: 'bad-url' }
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || text.includes('?') || text.includes('#')) {
    return { off: 'bad-url' }
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (path !== '' && path !== API_PATH) return { off: 'bad-url' }
  return { base: url.origin + API_PATH }
}

/** The values a settings source's `pluginConfigs` give this plugin for `options`, under its name or name@marketplace. */
export function declaredOptions(configs: unknown, plugin: string, options: readonly string[]): Map<string, unknown[]> {
  const found = new Map<string, unknown[]>()
  if (!configs || typeof configs !== 'object') return found
  for (const [name, value] of Object.entries(configs)) {
    if (name !== plugin && !name.startsWith(`${plugin}@`)) continue
    const declared = (value as { options?: unknown } | null | undefined)?.options
    if (!declared || typeof declared !== 'object') continue
    for (const option of options) {
      if (Object.hasOwn(declared, option)) found.set(option, [...(found.get(option) ?? []), (declared as Record<string, unknown>)[option]])
    }
  }
  return found
}

/** Whether `repo` declares an option value that `user` does not declare: a value only the repository chose. */
export function repoChose(repo: Map<string, unknown[]>, user: Map<string, unknown[]>): boolean {
  for (const [option, values] of repo) {
    const own = new Set((user.get(option) ?? []).map((v) => JSON.stringify(v)))
    if (values.some((v) => !own.has(JSON.stringify(v)))) return true
  }
  return false
}

export type Access = { key: string; base: string; off?: undefined } | { key?: undefined; base?: undefined; off: Off }

/** The token and API base to use, or why there are none. Settings are read only when both options are valid. */
export async function resolveAccess(io: AccessIo, options: { url?: unknown; apiKey?: unknown }): Promise<Access> {
  const key = checkKey(options.apiKey)
  if (key.key === undefined) return { off: key.off }
  const url = checkUrl(options.url)
  if (url.base === undefined) return { off: url.off }
  const OPTION_NAMES = ['url', 'apiKey'] as const
  let declared = false
  try {
    const user = declaredOptions((await io.settings('user'))?.pluginConfigs, 'coolify', OPTION_NAMES)
    for (const source of ['project', 'local'] as const) {
      const settings = await io.settings(source)
      if (repoChose(declaredOptions(settings?.pluginConfigs, 'coolify', OPTION_NAMES), user)) declared = true
    }
  } catch {
    return { off: 'unreadable' }
  }
  return declared ? { off: 'repo-option' } : { key: key.key, base: url.base }
}
