// The session panel kept on disk through the plugin's store, one key per session, so a restarted app or a resumed
// session finds its agents and turns again. Entries older than a week or past the newest few sessions are pruned. Pure:
// register.tsx reads and writes the store.
import type { SessionHudPanel } from '../../types'

/** The shape of the saved panel: change it whenever a stored type changes, and older entries are dropped. */
export const PANEL_SHAPE = 'session-hud/panel/1'

export type SavedPanel = { shape: string; panel: SessionHudPanel; savedAt: number }

const PREFIX = 'panel:'
/** How long a session's panel is kept after its last change, and how many sessions keep one. */
export const SAVED_TTL_MS = 7 * 24 * 60 * 60_000
export const SAVED_MAX = 20

export const savedKey = (sessionId: string): string => `${PREFIX}${sessionId}`

/** What to keep under a session's key: the panel and when, or nothing for an empty one. */
export const toSave = (panel: SessionHudPanel, now: number): SavedPanel | undefined =>
  (panel.agents.length || panel.main.turns.length ? { shape: PANEL_SHAPE, panel, savedAt: now } : undefined)

const isUsage = (u: unknown) => !!u && typeof u === 'object' && ['input', 'output', 'cacheRead', 'cacheWrite'].every(k => typeof (u as Record<string, unknown>)[k] === 'number')

/** A stored value as a panel to restore: one of this shape, saved within the TTL, with agents and the main session's figures; anything else is ignored. */
export function restorable(value: unknown, now: number): SessionHudPanel | undefined {
  const saved = value as Partial<SavedPanel> | undefined
  if (saved?.shape !== PANEL_SHAPE || typeof saved.savedAt !== 'number' || saved.savedAt < now - SAVED_TTL_MS) return undefined
  const panel = saved.panel
  if (!panel || !Array.isArray(panel.agents) || !panel.main || !isUsage(panel.main.usage) || !Array.isArray(panel.main.turns)) return undefined
  const agents = panel.agents.filter(a => a && typeof a.id === 'string' && typeof a.status === 'string' && typeof a.startedAt === 'number' && isUsage(a.usage))
  return { agents, main: panel.main }
}

/** The panel keys to delete: those older than the TTL, a value that is no panel, then all but the newest `SAVED_MAX`. */
export function pruned(entries: [string, unknown][], now: number): string[] {
  const panels = entries.filter(([key]) => key.startsWith(PREFIX))
  const savedAt = (value: unknown) => {
    const at = (value as Partial<SavedPanel> | undefined)?.savedAt
    return typeof at === 'number' ? at : -Infinity
  }
  const stale = panels.filter(([, value]) => !restorable(value, now)).map(([key]) => key)
  const kept = panels.filter(([key]) => !stale.includes(key)).sort((a, b) => savedAt(b[1]) - savedAt(a[1]))
  return [...stale, ...kept.slice(SAVED_MAX).map(([key]) => key)]
}
