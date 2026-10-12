// The Session card's texts (UI spec 4.4): the header profile, the model line, the token row and the turn receipt.
import { fmtCost, fmtDelta, fmtDuration, fmtTokens, fmtUptime, plural, prettyModel } from './format'
import { gaugeTone, thresholdOf, MARKER, type Threshold, type Tone } from './glyphs'
import { cachedShare } from './state'
import type { Session } from './types'
import { cellWidth, truncate } from './width'

/** The header's profile: only what is on, joined by ` · `: a non-default permission mode, `jev`, `cx`. */
export function headerProfile(o: { mode: string; jev: boolean; cx: boolean }): string {
  const parts: string[] = []
  if (o.mode !== '' && o.mode !== 'default') parts.push(o.mode)
  if (o.jev) parts.push('jev')
  if (o.cx) parts.push('cx')
  return truncate(parts.join(' · '), 30)
}

/** `Opus 5.5 · high effort`; with no effort sent, `Opus 5.5` (never a dash). */
export function modelLine(s: Session): string {
  const model = prettyModel(s.model)
  const name = model === '' ? 'model unknown' : model
  return s.effort === '' ? name : `${name} · ${s.effort} effort`
}

export type ContextView = {
  /** Rounded used share, or null (`ctx —`). */
  pct: number | null
  threshold: Threshold
  marker: string
  tone: Tone
  /** `128k/200k`, or '' when unknown. */
  tokens: string
}

export function contextView(s: Session): ContextView {
  if (s.contextPct === null) return { pct: null, threshold: 'ok', marker: '', tone: 'faint', tokens: '' }
  const threshold = thresholdOf(s.contextPct)
  return {
    pct: Math.round(s.contextPct),
    threshold,
    marker: MARKER[threshold],
    tone: gaugeTone(s.contextPct),
    tokens: s.contextTokens !== null && s.contextWindow > 0 ? `${fmtTokens(s.contextTokens)}/${fmtTokens(s.contextWindow)}` : '',
  }
}

/** The token row's text: `$4.12  in 1.2M 92% cached  out 84k`; `$0.00  in 0  out 0` before any step. */
export function tokenRow(s: Session): { cost: string; flow: string; compacted: string; uptime: (now: number) => string } {
  const share = cachedShare(s)
  return {
    cost: fmtCost(s.costUsd ?? 0),
    flow: `in ${fmtTokens(s.tokens.input)}${share === null ? '' : ` ${share}% cached`}  out ${fmtTokens(s.tokens.output)}`,
    compacted: s.compactions > 0 ? `⟲${s.compactions}` : '',
    uptime: now => fmtUptime(now - s.startedAt),
  }
}

/**
 * The receipt row. Working: `turn 0:42 · +$0.18 · in 12k · out 2.1k · 3 agents`. Idle: `✓ last turn 2:13 · …`, `✗ …
 * · failed` or `· stopped` when the turn did not end with an answer. Too long for `width`: the agents go first, then
 * out, then in; duration and cost stay.
 */
export function receiptLine(s: Session, now: number, width: number): string {
  if (s.turn === null && s.lastTurn === null) return 'no turn finished yet'
  let head: string
  let cost: number | null
  let input: number
  let output: number
  let agents: number
  if (s.turn !== null) {
    head = `turn ${fmtDuration(now - s.turn.startedAt)}`
    cost = s.costUsd !== null && s.turn.costAtStart !== null ? Math.max(0, s.costUsd - s.turn.costAtStart) : null
    ;({ input, output, agents } = s.turn)
  } else {
    const last = s.lastTurn as NonNullable<Session['lastTurn']>
    const glyph = last.outcome === 'done' ? '✓' : '✗'
    const word = last.outcome === 'done' ? '' : last.outcome === 'stopped' ? ' · stopped' : ' · failed'
    head = `${glyph} last turn ${fmtDuration(last.durationMs)}${word}`
    ;({ costUsd: cost, input, output, agents } = last)
  }
  const parts = {
    head,
    cost: cost === null ? null : fmtDelta(cost),
    input: `in ${fmtTokens(input)}`,
    output: `out ${fmtTokens(output)}`,
    agents: agents > 0 ? plural(agents, 'agent') : null,
  }
  const drop: ('agents' | 'output' | 'input')[] = ['agents', 'output', 'input']
  const build = () => [parts.head, parts.cost, parts.input, parts.output, parts.agents].filter(p => p !== null && p !== '').join(' · ')
  for (const key of drop) {
    if (cellWidth(build()) <= width) break
    ;(parts as Record<string, string | null>)[key] = null
  }
  return truncate(build(), width)
}
