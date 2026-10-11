// A Codex job as a Flightdeck card, and the rules for writing it. Pure: the clock is passed in and nothing here touches
// `$`; crew's register writes the cards through `update($, { plugin: 'crew', key: 'agents' })`, the dashboard's list.
//
// The card's `type` is `codex:<role>`, which tells it from a native `crew:<role>` card. The dashboard files a type that
// matches `architectPattern` (default `advisor|architect`) under its ARCHITECT panel instead of drawing a card, but it
// applies that test in its own `agent.spawn` hook only. A Codex card is written straight to the atom, so
// `codex:architect` is drawn as a card, as v1 intends: the filter never sees it.

import type { AgentCard, ToolNote } from '../../types'
import { normalizeCard, shorten } from '../flightdeck/core'
import type { CodexJob, CodexStatus } from './types'

/** The dashboard's own cap on cards (`slice(-24)` in its `agent.spawn` hook). */
export const MAX_CARDS = 24

/** The dashboard keeps three tool notes per card. */
const MAX_NOTES = 3

/** The card statuses the dashboard draws: running, done, failed, stopped. */
const CARD_STATUS: Record<CodexStatus, string> = {
  running: 'running',
  background: 'running',
  done: 'done',
  error: 'failed',
  lost: 'failed',
  cancelled: 'stopped',
}

/** A job that will not change again: its card is always written. */
export const isTerminal = (status: CodexStatus) => CARD_STATUS[status] !== 'running'

export const codexCard = (job: CodexJob, now: number): AgentCard => {
  const status = CARD_STATUS[job.status] ?? 'failed'
  const tools: ToolNote[] = job.activity
    .slice(-MAX_NOTES)
    .map(text => ({ tool: 'codex', text: shorten(text, 64), isError: false }))
  return {
    ...normalizeCard({}),
    id: job.id,
    type: `codex:${job.agent}`,
    model: job.model ?? '',
    description: job.description,
    status,
    spawnedAt: job.startedAt,
    endedAt: status === 'running' ? null : (job.endedAt ?? now),
    ctx: job.usage?.input ?? 0,
    out: job.usage?.output ?? 0,
    steps: job.activity.length,
    answer: job.answer ? shorten(job.answer, 400) : '',
    tools,
  }
}

/** The list with the card added, or replaced in place when its id is already there; the oldest go past `max`. */
export const upsertCard = (cards: unknown, card: AgentCard, max = MAX_CARDS): AgentCard[] => {
  const list = (Array.isArray(cards) ? cards : []).map(normalizeCard)
  const at = list.findIndex(c => c.id === card.id)
  if (at >= 0) list[at] = card
  else list.push(card)
  return list.slice(-max)
}

/**
 * At most one write per job each `intervalMs`, and a terminal state always. A skipped update is not queued: the caller
 * offers the next one when its job moves again, and its end is always written.
 */
export const createThrottle = (intervalMs = 1000) => {
  const last = new Map<string, number>()
  return {
    allow(id: string, status: CodexStatus, now: number): boolean {
      if (isTerminal(status)) {
        last.delete(id)
        return true
      }
      const before = last.get(id)
      if (before !== undefined && now - before < intervalMs) return false
      last.set(id, now)
      return true
    },
    forget(id: string) {
      last.delete(id)
    },
  }
}
