import type { Instance, Roster, SlotName } from './roster'

export type LogEvent = { at: number; actor: SlotName | 'orchestrator'; kind: string; text: string }

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const END_KINDS: Record<string, { kind: string; verb: string; word: 'in' | 'after' }> = {
  done: { kind: 'done', verb: 'done', word: 'in' },
  error: { kind: 'failed', verb: 'failed', word: 'after' },
  cancelled: { kind: 'stopped', verb: 'stopped', word: 'after' },
  failed: { kind: 'failed', verb: 'failed', word: 'after' },
  stopped: { kind: 'stopped', verb: 'stopped', word: 'after' },
  lost: { kind: 'lost', verb: 'lost', word: 'after' },
}

/**
 * Session-log events derived from the roster alone: one `started` per round, one end event per
 * ended round (kind from its status, with the task last so parallel instances of a role differ and
 * cell truncation cuts the task first) and `disabled` for a role that is off, which carries `now`.
 * No `activity` events: the roster has no stamp for them and the Running row shows the last one.
 * Ascending by time; only the last `limit` are kept.
 */
export function logEvents(roster: Roster, now: number, limit: number): LogEvent[] {
  const events: LogEvent[] = []
  for (const slot of roster.slots) {
    const push = (at: number, kind: string, text: string, seat?: string) =>
      events.push({ at, actor: slot.name, kind, text: seat ? `${seat} ${text}` : text })
    for (const i of slot.history ?? slot.instances) {
      const rounds = i.rounds.length ? i.rounds : [{ startedAt: i.startedAt, endedAt: i.endedAt, status: i.status }]
      const task = squash(i.task)
      rounds.forEach((r, n) => {
        push(r.startedAt, 'started', `${n === 0 ? 'started' : 'resumed'}${task ? `: ${task}` : ''}`, i.seat)
        const end = END_KINDS[r.status]
        if (end && r.endedAt !== undefined) {
          push(r.endedAt, end.kind, `${end.verb} ${end.word} ${duration(r.endedAt - r.startedAt)}${task ? ` · ${task}` : ''}`, i.seat)
        }
      })
    }
    if (slot.state === 'off') push(now, 'disabled', 'disabled in config')
  }
  // Stable sort keeps a round's start before its end when they share a timestamp.
  events.sort((a, b) => a.at - b.at)
  return limit > 0 ? events.slice(-limit) : []
}
