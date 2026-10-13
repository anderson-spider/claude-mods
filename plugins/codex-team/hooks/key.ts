// Adapted from crew's key check. Repository settings cannot choose the account receiving the user's task.
export type KeyIo = {
  /** Missing settings are undefined; unreadable settings reject. */
  settings: (source: 'project' | 'local') => Promise<{ env?: unknown } | undefined>
}

export type Off = 'no-key' | 'bad-key' | 'unreadable-settings' | 'repo-declared-key'
export type Access = { key: string; off?: undefined } | { key?: undefined; off: Off }
const KEY_SHAPE = /^[\x21-\x7e]{1,512}$/

/** Printable ASCII without spaces, so the Authorization header cannot be broken by a pasted key. */
export function checkKey(value: unknown): Access {
  if (value === undefined || value === null) return { off: 'no-key' }
  if (typeof value !== 'string') return { off: 'bad-key' }
  const key = value.trim()
  if (!key) return { off: 'no-key' }
  return KEY_SHAPE.test(key) ? { key } : { off: 'bad-key' }
}

/** Any own declaration counts, including empty, null and a value equal to the user's key. */
export async function repoDeclares(io: KeyIo): Promise<boolean> {
  let declared = false
  for (const source of ['project', 'local'] as const) {
    const env = (await io.settings(source))?.env
    if (env && typeof env === 'object' && Object.hasOwn(env, 'JEV_API_KEY')) declared = true
  }
  return declared
}

export async function resolveAccess(io: KeyIo, value: unknown): Promise<Access> {
  const checked = checkKey(value)
  if (checked.key === undefined) return checked
  try {
    if (await repoDeclares(io)) return { off: 'repo-declared-key' }
  } catch {
    return { off: 'unreadable-settings' }
  }
  return checked
}
