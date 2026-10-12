// The Quota card as data (UI spec 4.4): per provider a 5h and a 7d gauge, reset countdowns and threshold markers, the
// favored row from the router's last decision (never recomputed here), and the ages of the readings.
import { fmtAge, fmtCountdown } from './format'
import { MARKER, gaugeTone, thresholdOf, type Threshold, type Tone } from './glyphs'
import { ROUTING_OFF_REASON, STALE_MS, type Provider, type Quota, type Window } from '../quota'

export type GaugeRow = {
  /** `5h` or `7d`. */
  label: '5h' | '7d'
  /** Used share 0-100, or null when unknown or the window's reset has passed (shown as `—`). */
  pct: number | null
  /** The threshold of the figure shown (`ok` under 70%, `warn` from 70%, `bad` from 85%); `ok` when unknown. */
  threshold: Threshold
  /** '', `!` or `!!`. */
  marker: string
  tone: Tone
  /** `2h10m`, `3d4h`, `reset` (the reset passed), or '' (unknown) / `—` (no `resetsAt`). */
  resetText: string
  /** Last values shown dimmed (stale, or the proxy is down). */
  isDim: boolean
}

export type ProviderBlock = {
  provider: Provider
  /** `Claude`, `Codex`, `Codex · not known yet`, `Codex · 18m old`, `Codex · proxy down`, `Claude · no plan limits`. */
  header: string
  /** Whether the right-hand `resets` heading shows. */
  showResets: boolean
  /** The favored provider's name gets ` ◆`. */
  isFavored: boolean
  isDim: boolean
  gauges: GaugeRow[]
}

export type QuotaView = {
  claude: ProviderBlock
  /** Null when there are no twins and no proxy: Claude's gauges grow to 30 cells. */
  codex: ProviderBlock | null
  /** Gauge width in cells: 10 beside Codex, 30 alone. */
  gaugeWidth: 10 | 30
  /** `→ Codex favored: …`, or null when routing is off (no row, no mark). */
  favoredRow: string | null
  /** The hottest used share over every shown window (for the mini line and level 5 rules), or null. */
  hottest: number | null
}

export type QuotaOptions = {
  now: number
  /** The provider routing switch (`quotaRouting`). */
  routing: boolean
  /** Codex twins are registered. */
  twins: boolean
  /**
   * Whether the host has reported its rate limits at least once this session (false on a fresh session, before the
   * first reply). Absent counts as true. With no Claude reading yet, false shows a neutral waiting state instead of
   * "no plan limits", which would read as API billing.
   */
  claudeMeasured?: boolean
}

/** Cells of `width` to fill for a used share. */
export const filled = (pct: number, width: number): number => Math.min(width, Math.max(0, Math.round((pct / 100) * width)))

function gaugeRow(label: '5h' | '7d', window: Window | undefined, now: number, isDim: boolean): GaugeRow {
  const unknown: GaugeRow = { label, pct: null, threshold: 'ok', marker: '', tone: 'faint', resetText: '', isDim }
  if (!window) return unknown
  const resets = window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt)
  const hasResets = resets !== undefined && !Number.isNaN(resets)
  if (hasResets && (resets as number) <= now) return { ...unknown, resetText: 'reset' }
  const threshold = thresholdOf(window.percentUsed)
  return {
    label,
    pct: Math.round(window.percentUsed),
    threshold,
    marker: MARKER[threshold],
    tone: gaugeTone(window.percentUsed),
    resetText: hasResets ? fmtCountdown((resets as number) - now) : '—',
    isDim,
  }
}

const gaugesOf = (reading: { fiveHour?: Window; sevenDay?: Window } | null, now: number, isDim: boolean): GaugeRow[] => [
  gaugeRow('5h', reading?.fiveHour, now, isDim),
  gaugeRow('7d', reading?.sevenDay, now, isDim),
]

/** The favored row from the router's decision, with the HUD's own wording for the states without a Codex reading. */
function favoredRowOf(quota: Quota): { row: string; favored: Provider } | null {
  const { decision, codexState } = quota
  // The router's "no eligible call" reason has no provider to name.
  if (decision.reason === ROUTING_OFF_REASON) return null
  if (decision.provider === 'codex') return { row: `→ Codex favored: ${decision.reason}`, favored: 'codex' }
  return codexState === 'down'
    ? { row: `→ Claude only: ${decision.reason}`, favored: 'claude' }
    : { row: `→ Claude favored: ${decision.reason}`, favored: 'claude' }
}

/**
 * The Quota card from the `quota` atom. Claude's reading dims once older than 15 minutes (`Claude · 18m old`); Codex's
 * header names its state. A window whose reset has passed shows `—` and `reset` until the next reading.
 */
export function quotaView(quota: Quota, o: QuotaOptions): QuotaView {
  const showCodex = o.twins || quota.codexState !== 'off'
  const favored = o.routing ? favoredRowOf(quota) : null

  const claudeAge = quota.claudeAt === null ? null : Math.max(0, o.now - quota.claudeAt)
  const claudeOld = claudeAge !== null && claudeAge > STALE_MS
  const waiting = quota.claude === null && o.claudeMeasured === false
  const claude: ProviderBlock = {
    provider: 'claude',
    header: waiting ? 'Claude · waiting' : quota.claude === null ? 'Claude · no plan limits' : claudeOld ? `Claude · ${fmtAge(claudeAge as number)} old` : 'Claude',
    showResets: quota.claude !== null,
    isFavored: favored?.favored === 'claude',
    isDim: claudeOld,
    gauges: waiting ? gaugesOf(null, o.now, false) : quota.claude === null ? [] : gaugesOf(quota.claude, o.now, claudeOld),
  }

  let codex: ProviderBlock | null = null
  if (showCodex) {
    const state = quota.codexState === 'off' ? 'unknown' : quota.codexState
    const reading = state === 'unknown' ? null : quota.codex
    const seen = quota.codexObservedAt ?? quota.fetchedAt
    const isDim = state === 'stale' || state === 'down'
    const header =
      state === 'unknown'
        ? 'Codex · not known yet'
        : state === 'down'
          ? 'Codex · proxy down'
          : state === 'stale'
            ? seen === null
              ? 'Codex · stale'
              : `Codex · ${fmtAge(Math.max(0, o.now - seen))} old`
            : 'Codex'
    codex = {
      provider: 'codex',
      header,
      showResets: state !== 'down' && state !== 'unknown',
      isFavored: favored?.favored === 'codex',
      isDim,
      // A down proxy keeps its last values dimmed when it has any; otherwise the gauges read as unknown.
      gauges: gaugesOf(state === 'down' ? quota.codex : reading, o.now, isDim).map(g =>
        state === 'down' ? { ...g, resetText: '' } : g,
      ),
    }
  }

  const pcts = [...claude.gauges, ...(codex?.gauges ?? [])].map(g => g.pct).filter((p): p is number => p !== null)
  return {
    claude,
    codex,
    gaugeWidth: codex === null ? 30 : 10,
    favoredRow: favored?.row ?? null,
    hottest: pcts.length > 0 ? Math.max(...pcts) : null,
  }
}

/**
 * Whether the one-line quota form (mini and band) shows: a window is at 70% or more, the favored provider changed
 * recently, or Codex is unknown or down while twins exist.
 */
export function quotaNeedsLine(view: QuotaView, quota: Quota, twins: boolean, changedRecently: boolean): boolean {
  if (view.hottest !== null && view.hottest >= 70) return true
  if (changedRecently) return true
  return twins && (quota.codexState === 'unknown' || quota.codexState === 'down')
}
