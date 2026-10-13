// Where the Tailscale API key comes from. Pure: the settings read is injected.
// The `apiKey` option is the only source. A key that the repository's own settings (project or local) declare is not
// used: the Authorization header would go out under an account the repository chose. Settings that cannot be read
// refuse the call as well. The key is never put in a message.

export type KeyIo = {
  /** One settings source's `pluginConfigs`; rejects when it cannot be read. */
  settings: (source: 'project' | 'local') => Promise<{ pluginConfigs?: unknown } | undefined>
}

export type Off = 'no-key' | 'bad-key' | 'unreadable' | 'repo-key'

/** What each refusal tells the user: where to set the option, never a value. */
export const OFF_TEXT: Record<Off, string> = {
  'no-key': 'The tailscale apiKey option is not set. Set it in the plugin options (/plugin, tailscale, configure).',
  'bad-key': 'The tailscale apiKey option is not a valid key. Set it again in the plugin options (/plugin, tailscale, configure).',
  unreadable: 'The project or local settings could not be read, so the tailscale apiKey option is not used.',
  'repo-key':
    'The repository settings declare the tailscale apiKey option, so it is not used. Set it in your user plugin options instead.',
}

/** Printable ASCII with no space, so the `Authorization` header cannot be broken by what was pasted. */
const KEY_SHAPE = /^[\x21-\x7e]{1,512}$/

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

/** The key to send, or why there is none. Settings are read only for a valid key. */
export async function resolveKey(io: KeyIo, option: unknown): Promise<{ key: string; off?: undefined } | { key?: undefined; off: Off }> {
  const checked = checkKey(option)
  if (checked.key === undefined) return { off: checked.off }
  let declared = false
  try {
    for (const source of ['project', 'local'] as const) {
      const settings = await io.settings(source)
      if (declaresOption(settings?.pluginConfigs, 'tailscale', 'apiKey')) declared = true
    }
  } catch {
    return { off: 'unreadable' }
  }
  return declared ? { off: 'repo-key' } : { key: checked.key }
}
