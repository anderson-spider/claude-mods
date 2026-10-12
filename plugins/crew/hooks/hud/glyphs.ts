// The HUD's glyphs and gauges (UI spec 3.3, 3.4). Every state has a glyph; color is never the only signal. All glyphs are
// single-cell, non-emoji code points. A `Tone` names a color class; the drawing maps it to a theme or palette color.
import type { RoundStatus } from './types'

/** Color classes. `section` is the card's own color; `role` is the agent's role color. */
export type Tone = 'section' | 'role' | 'text' | 'ok' | 'bad' | 'warn' | 'dim' | 'faint'

export type Cell = { glyph: string; tone: Tone }

/** An agent row's status. */
export const AGENT_GLYPH: Readonly<Record<RoundStatus, string>> = { running: '●', done: '✓', failed: '✗', stopped: '■' }
export const AGENT_TONE: Readonly<Record<RoundStatus, Tone>> = { running: 'role', done: 'ok', failed: 'bad', stopped: 'dim' }

/** One cell of a job strip. */
export const JOB_GLYPH: Readonly<Record<RoundStatus, string>> = { running: '▶', done: '▰', failed: '✗', stopped: '▪' }
export const JOB_TONE: Readonly<Record<RoundStatus, Tone>> = { running: 'role', done: 'ok', failed: 'bad', stopped: 'dim' }
/** A queued plan step owned by the agent's type. */
export const PLANNED_GLYPH = '▱'

/** What a plan step is, for its glyph and its bucket. */
export type StepKind = 'implementing' | 'qa' | 'fixes' | 'done' | 'next' | 'waits' | 'blocked'

export const STEP_GLYPH: Readonly<Record<StepKind, string>> = {
  implementing: '▶',
  qa: '◇',
  fixes: '↺',
  done: '▰',
  next: '▱',
  waits: '·',
  blocked: '⊘',
}
export const STEP_TONE: Readonly<Record<StepKind, Tone>> = {
  implementing: 'role',
  qa: 'text',
  fixes: 'warn',
  done: 'ok',
  next: 'text',
  waits: 'dim',
  blocked: 'bad',
}

export const stepCell = (kind: StepKind): Cell => ({ glyph: STEP_GLYPH[kind], tone: STEP_TONE[kind] })

export const CONSULTING_GLYPH = '●'
export const UNCLASSIFIED_GLYPH = '»'
export const VERDICT_GLYPH = { Approve: '✓', Fixes: '↺', Reject: '✗' } as const

export const GAUGE_FILLED = '▰'
export const GAUGE_EMPTY = '▱'
export const GAUGE_UNKNOWN = '╌'
export const ATTENTION_GLYPH = '!'
export const WORKING_GLYPH = '●'
export const IDLE_GLYPH = '○'
export const FAVORED_MARK = '◆'
export const LEGEND = '▶ run ▰ done ✗ fail ▪ stop ▱ planned ⊘ blocked'

export type Threshold = 'ok' | 'warn' | 'bad'

/** The threshold of a used percentage (3.4): under 70 ok, 70 to 84 warn (`!`), 85 and over bad (`!!`). Judged on the rounded figure shown. */
export function thresholdOf(pct: number): Threshold {
  const shown = Math.round(pct)
  return shown >= 85 ? 'bad' : shown >= 70 ? 'warn' : 'ok'
}

export const MARKER: Readonly<Record<Threshold, string>> = { ok: '', warn: '!', bad: '!!' }

/** The tone of a gauge that is `section`-colored under 70%, amber from 70% and red from 85%. */
export const gaugeTone = (pct: number): Tone => {
  const t = thresholdOf(pct)
  return t === 'ok' ? 'section' : t === 'warn' ? 'warn' : 'bad'
}

/** A gauge of `width` cells: filled `▰` for the used share, `▱` for the rest; null (unknown) draws `╌`. */
export function gauge(pct: number | null, width: number): string {
  if (width <= 0) return ''
  if (pct === null || !Number.isFinite(pct)) return GAUGE_UNKNOWN.repeat(width)
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)))
  return GAUGE_FILLED.repeat(filled) + GAUGE_EMPTY.repeat(width - filled)
}
