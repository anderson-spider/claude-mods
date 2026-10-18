// The plugin's options as the manifest's userConfig declares them, checked: a value of the wrong kind or outside its
// choices falls back to the default, so a hand-edited settings file never breaks the pane.

export const SORTS = ['name', 'type', 'modified'] as const
export const ENTER_ACTIONS = ['preview', 'editor'] as const
export const ICON_SETS = ['unicode', 'nerd'] as const
export const THEMES = ['auto', 'dark', 'light'] as const
export const GIT_MODES = ['full', 'status', 'off'] as const
export const SEARCH_MODES = ['fuzzy', 'substring'] as const

export type Config = {
  autoOpen: boolean
  follow: boolean
  animations: boolean
  showHidden: boolean
  ignore: readonly string[]
  sort: (typeof SORTS)[number]
  enterAction: (typeof ENTER_ACTIONS)[number]
  editor: string
  icons: (typeof ICON_SETS)[number]
  theme: (typeof THEMES)[number]
  git: (typeof GIT_MODES)[number]
  search: (typeof SEARCH_MODES)[number]
  refreshSeconds: number
}

export const DEFAULT_IGNORE = ['.git', 'node_modules', 'dist', 'build', 'target', '.next', '.venv', '__pycache__', 'coverage']

export const DEFAULTS: Config = {
  autoOpen: true,
  follow: true,
  animations: true,
  showHidden: false,
  ignore: DEFAULT_IGNORE,
  sort: 'name',
  enterAction: 'preview',
  editor: '',
  icons: 'unicode',
  theme: 'auto',
  git: 'full',
  search: 'fuzzy',
  refreshSeconds: 5,
}

const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
const pick = <T extends string>(choices: readonly T[], value: unknown, fallback: T): T =>
  choices.includes(value as T) ? (value as T) : fallback

/** The options as given, each checked against its kind and choices; anything else is the default. */
export function configOf(options: Record<string, unknown> | undefined): Config {
  const o = options ?? {}
  const ignore = typeof o.ignore === 'string'
    ? o.ignore.split(',').map(name => name.trim()).filter(name => name !== '' && !name.includes('/'))
    : DEFAULTS.ignore
  const seconds = typeof o.refreshSeconds === 'number' && Number.isFinite(o.refreshSeconds) ? o.refreshSeconds : DEFAULTS.refreshSeconds
  return {
    autoOpen: bool(o.autoOpen, DEFAULTS.autoOpen),
    follow: bool(o.follow, DEFAULTS.follow),
    animations: bool(o.animations, DEFAULTS.animations),
    showHidden: bool(o.showHidden, DEFAULTS.showHidden),
    ignore,
    sort: pick(SORTS, o.sort, DEFAULTS.sort),
    enterAction: pick(ENTER_ACTIONS, o.enterAction, DEFAULTS.enterAction),
    editor: typeof o.editor === 'string' ? o.editor.trim() : DEFAULTS.editor,
    icons: pick(ICON_SETS, o.icons, DEFAULTS.icons),
    theme: pick(THEMES, o.theme, DEFAULTS.theme),
    git: pick(GIT_MODES, o.git, DEFAULTS.git),
    search: pick(SEARCH_MODES, o.search, DEFAULTS.search),
    // 0 turns the background check off; anything else is held between 2 seconds and 10 minutes.
    refreshSeconds: seconds <= 0 ? 0 : Math.min(600, Math.max(2, Math.round(seconds))),
  }
}
