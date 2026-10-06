export type PermissionMode = 'acceptEdits' | 'default' | 'plan' | 'auto' | 'bypassPermissions'

export type Settings = {
  maxThreads: number
  /** A Claude alias or full name; empty means the model of the chat that starts the helper. */
  defaultModel: string
  defaultPermissionMode: PermissionMode
  pollMs: number
}

const MODES: readonly PermissionMode[] = ['acceptEdits', 'default', 'plan', 'auto', 'bypassPermissions']

const numberOf = (raw: unknown): number | undefined => {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw

  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** The `userConfig` values from `register(on, options)`, clamped; anything unusable falls back to its default. */
export const readSettings = (options: Record<string, unknown> | undefined): Settings => {
  const max = numberOf(options?.maxThreads)
  const poll = numberOf(options?.pollSeconds)
  const model = options?.defaultModel
  const mode = options?.defaultPermissionMode

  return {
    maxThreads: max === undefined ? 3 : Math.min(Math.max(Math.floor(max), 1), 10),
    defaultModel: typeof model === 'string' ? model.trim() : 'sonnet',
    defaultPermissionMode: MODES.find(known => known === mode) ?? 'acceptEdits',
    pollMs: Math.round(Math.min(Math.max(poll ?? 3, 1), 60) * 1000),
  }
}
