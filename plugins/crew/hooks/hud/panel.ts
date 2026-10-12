// `/crew:panel`: its grammar, its replies and the panel choice kept in `$.store`. Pure; hooks/hud/register.tsx runs the
// command and owns every `$` call.
import type { PanelChoice } from './compose'

export type { PanelChoice }

/** The layouts the side pane takes: `auto` (full when docked, the summary inline) or `mini` (the summary always). */
export type Layout = 'auto' | 'mini'

export const PANEL_USAGE = 'Usage: /crew:panel [on|off|side|prompt|reset|layout auto|mini|plan <name>|plan auto]'

export type PanelCommand =
  | { kind: 'toggle' | 'on' | 'off' | 'side' | 'prompt' | 'reset' | 'usage' | 'removed-layout' }
  | { kind: 'layout'; layout: Layout }
  | { kind: 'plan'; name: string }
  | { kind: 'plan-auto' }

/** A plan name: a file name under `.crew/plans/` without its `.md`, no path and no dots of its own at the start. */
const PLAN_NAME = /^[A-Za-z0-9_][\w.-]{0,127}$/

/** `/crew:panel`'s arguments: case and spacing are free (a plan name keeps its case), anything else is `usage`. */
export function parsePanelArgs(args: unknown): PanelCommand {
  const words = String(args ?? '').trim().split(/\s+/).filter(Boolean)
  const [verbRaw, argRaw, ...rest] = words
  const verb = verbRaw?.toLowerCase()
  const arg = argRaw?.toLowerCase()
  if (verb === undefined) return { kind: 'toggle' }
  if (rest.length > 0) return { kind: 'usage' }
  if (verb === 'layout') {
    if (arg === 'auto' || arg === 'mini') return { kind: 'layout', layout: arg }
    return arg === 'compact' || arg === 'wide' ? { kind: 'removed-layout' } : { kind: 'usage' }
  }
  if (verb === 'plan') {
    if (argRaw === undefined) return { kind: 'usage' }
    if (arg === 'auto') return { kind: 'plan-auto' }
    const name = argRaw.replace(/\.md$/i, '')
    return PLAN_NAME.test(name) ? { kind: 'plan', name } : { kind: 'usage' }
  }
  const isVerb = verb === 'on' || verb === 'off' || verb === 'side' || verb === 'prompt' || verb === 'reset'
  return isVerb && arg === undefined ? { kind: verb } : { kind: 'usage' }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A panel choice read leniently: null unless both fields are valid. */
export const choiceOf = (raw: unknown): PanelChoice | null =>
  isObject(raw) && typeof raw.isVisible === 'boolean' && (raw.placement === 'side' || raw.placement === 'prompt')
    ? { isVisible: raw.isVisible, placement: raw.placement }
    : null

/** What `$.store` holds under `panel` (`{ v: 1, isVisible, placement }`), or null for anything else. */
export const storedChoice = (raw: unknown): PanelChoice | null => (isObject(raw) && raw.v === 1 ? choiceOf(raw) : null)

/** The pick a pane's close leaves: hidden when the person closed it, nothing for the plugin's own close or an unload. */
export const choiceAfterClose = (origin: { kind: string }): PanelChoice | null =>
  origin.kind === 'person' ? { isVisible: false, placement: 'side' } : null

/** The options the HUD reads: `placement`, `openOnStart`, `motion` and `colors`; anything else stored is ignored. */
export type HudOptions = { placement: 'side' | 'prompt'; openOnStart: boolean; motion: boolean }

export function hudOptions(options: Record<string, unknown> | undefined): HudOptions {
  const o = options ?? {}
  return {
    placement: o.placement === 'prompt' ? 'prompt' : 'side',
    openOnStart: o.openOnStart !== false,
    motion: o.motion !== 'off',
  }
}

// ------------------------------------------------------------------ replies (UI spec 9)

export const PANEL_FAILED = 'The panel could not run this command; see the debug log.'
export const HIDDEN_REPLY = 'Panel hidden. /crew:panel shows it again.'
export const PROMPT_REPLY = "Panel shown in the band above the prompt; another plugin's band takes its place while it shows."
export const RESET_REPLY = 'Panel reset. The plan file is untouched.'
export const LAYOUT_IN_PROMPT = 'Layout applies to the side pane; the band always shows the summary.'
export const REMOVED_LAYOUT = `Layouts compact and wide were removed; auto picks the form. ${PANEL_USAGE}`
export const PLAN_AUTO_REPLY = 'Panel follows the plan last written in this session.'
export const NO_PLAN_AUTO_REPLY = 'No plan was written in this session or has steps left from the last 7 days; the panel shows a plan once one is written.'
export const DOCKED_REPLY = "Panel docked beside the transcript. Focus it with ctrl+x tab; 1-9 open an agent's details."
export const INLINE_REPLY = 'Panel shown above the prompt (it docks in fullscreen from 110 columns). Focus it with ctrl+x tab.'

export const layoutReply = (layout: Layout): string => `Panel layout: ${layout}.`
export const planReply = (name: string): string => `Panel follows plan ${name}.`
export const recentPlanReply = (name: string): string => `Panel follows plan ${name}, the newest with steps left; a plan written in this session takes over.`
export const noPlanReply = (name: string): string => `No plan named ${name} in .crew/plans/.`

/** The terminal docks a pane in fullscreen from this many columns. */
export const DOCK_COLUMNS = 110

/** The reply to a side pane being shown: docked or inline by the room the command has, or why it is not shown yet. */
export function sideReply(opened: { isPlaced: boolean; reason?: string }, presentation: { isFullscreen: boolean; columns: number } | undefined): string {
  if (!opened.isPlaced) return `Panel set to the side, not shown yet: ${opened.reason ?? 'no reason given'}`
  return presentation?.isFullscreen === true && presentation.columns >= DOCK_COLUMNS ? DOCKED_REPLY : INLINE_REPLY
}
