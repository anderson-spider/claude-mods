// The plugin's options as the manifest's userConfig declares them, checked: a value of the wrong kind or outside its
// choices falls back to its default and is named, so the caller can log it once.

export const LANGUAGES = ['auto', 'pt-BR', 'en'] as const
export const AUTO_OPEN = ['team', 'any', 'off'] as const

export type SpiderConfig = {
  language: (typeof LANGUAGES)[number]
  autoOpen: (typeof AUTO_OPEN)[number]
  showCost: boolean
  showTokens: boolean
  showContext: boolean
  animations: boolean
  compactMode: boolean
  historyLimit: number
}

export const DEFAULTS: SpiderConfig = {
  language: 'auto',
  autoOpen: 'team',
  showCost: true,
  showTokens: true,
  showContext: true,
  animations: true,
  compactMode: false,
  historyLimit: 200,
}

const HISTORY_MIN = 20
const HISTORY_MAX = 1000

const oneOf = <T extends string>(choices: readonly T[]) => (v: unknown): v is T => choices.includes(v as T)
const bool = (v: unknown): v is boolean => typeof v === 'boolean'
const CHECKS: { [K in keyof SpiderConfig]: (v: unknown) => boolean } = {
  language: oneOf(LANGUAGES),
  autoOpen: oneOf(AUTO_OPEN),
  showCost: bool,
  showTokens: bool,
  showContext: bool,
  animations: bool,
  compactMode: bool,
  historyLimit: v => Number.isInteger(v) && (v as number) >= HISTORY_MIN && (v as number) <= HISTORY_MAX,
}

/** The options checked against their kinds and ranges; an absent option takes its default silently, an invalid one is named. */
export function configOf(options: Record<string, unknown>): { config: SpiderConfig; invalid: string[] } {
  const config = { ...DEFAULTS } as Record<keyof SpiderConfig, unknown>
  const invalid: string[] = []
  for (const key of Object.keys(CHECKS) as (keyof SpiderConfig)[]) {
    const value = options?.[key]
    if (value === undefined) continue
    if (CHECKS[key](value)) config[key] = value
    else invalid.push(key)
  }
  return { config: config as SpiderConfig, invalid }
}
