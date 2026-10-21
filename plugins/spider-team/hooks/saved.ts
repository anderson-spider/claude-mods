// The open run kept on disk through the plugin's store, one key per session, so a restarted app or a resumed session
// finds its plan again. Only the run: agents and usage stay in memory. A closed run is removed, and entries older than
// a week or past the newest few sessions are pruned. Pure: register.tsx reads and writes the store.
import type { SpiderRun } from '../types'
import { isOver } from './state'

/** The shape of the stored state, the atoms' and the saved run's: change it whenever a stored type changes. */
export const STATE_SHAPE = 'spider-team/2'

export type SavedRun = { shape: string; run: SpiderRun; savedAt: number }

const PREFIX = 'run:'
/** How long a session's run is kept after its last change, and how many sessions keep one. */
export const SAVED_TTL_MS = 7 * 24 * 60 * 60_000
export const SAVED_MAX = 20

export const savedKey = (sessionId: string): string => `${PREFIX}${sessionId}`

/** What to keep under a session's key: the open run and when, or nothing for no run or a closed one. */
export const toSave = (run: SpiderRun | null, now: number): SavedRun | undefined => (run && !isOver(run) ? { shape: STATE_SHAPE, run, savedAt: now } : undefined)

/** A stored value as a run to restore: one of this shape, saved within the TTL and still open; anything else is ignored. */
export function restorable(value: unknown, now: number): SpiderRun | undefined {
  const saved = value as Partial<SavedRun> | undefined
  if (saved?.shape !== STATE_SHAPE || typeof saved.savedAt !== 'number' || saved.savedAt < now - SAVED_TTL_MS) return undefined
  const run = saved.run
  if (!run || typeof run.runId !== 'string' || typeof run.title !== 'string' || !Array.isArray(run.tasks)) return undefined
  return isOver(run) ? undefined : run
}

/** The run keys to delete: those older than the TTL, a value that is no run, then all but the newest `SAVED_MAX`. */
export function pruned(entries: [string, unknown][], now: number): string[] {
  const runs = entries.filter(([key]) => key.startsWith(PREFIX))
  const savedAt = (value: unknown) => {
    const at = (value as Partial<SavedRun> | undefined)?.savedAt
    return typeof at === 'number' ? at : -Infinity
  }
  const stale = runs.filter(([, value]) => !restorable(value, now)).map(([key]) => key)
  const kept = runs.filter(([key]) => !stale.includes(key)).sort((a, b) => savedAt(b[1]) - savedAt(a[1]))
  return [...stale, ...kept.slice(SAVED_MAX).map(([key]) => key)]
}
