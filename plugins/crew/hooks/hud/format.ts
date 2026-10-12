// Text formats of the HUD (UI spec 3.5). Pure: times come in as ms since epoch, local time through `Date`'s getters.

const two = (n: number): string => String(n).padStart(2, '0')

/** `0:42`, `12:34` under an hour, `1h02` from an hour. Negative counts as zero. */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours >= 1) return `${hours}h${two(minutes)}`
  return `${minutes}:${two(total % 60)}`
}

/** Session uptime as `up 1:12` (h:mm). */
export function fmtUptime(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return `up ${Math.floor(minutes / 60)}:${two(minutes % 60)}`
}

/** A reset countdown at minute resolution: `45m`, `2h10m`, `4h05m` (minutes padded), `3d4h`; `<1m` under a minute, `0m` at or past zero. */
export function fmtCountdown(ms: number): string {
  if (!(ms > 0)) return '0m'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h${two(minutes % 60)}m`
  const days = Math.floor(minutes / 1440)
  return `${days}d${Math.floor((minutes % 1440) / 60)}h`
}

/** How old a reading is: `18m`, `3h`, `2d`; `<1m` under a minute. */
export function fmtAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 1440)}d`
}

/** Token counts: `840`, `2.1k`, `12k`, `1.2M`. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${trim1(n / 1000)}k`
  const k = Math.round(n / 1000)
  if (k < 1000) return `${k}k`
  const m = n / 1_000_000
  return m < 10 ? `${trim1(m)}M` : `${Math.round(m)}M`
}

const trim1 = (v: number): string => {
  const text = v.toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/** Cost: `$4.12`. */
export const fmtCost = (usd: number): string => `$${Math.max(0, usd).toFixed(2)}`

/** A cost delta: `+$0.18`. */
export const fmtDelta = (usd: number): string => `+$${Math.max(0, usd).toFixed(2)}`

/** `HH:MM` in local time. */
export function fmtClock(ms: number): string {
  const d = new Date(ms)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

/** `HH:MM:SS` in local time. */
export function fmtClockSeconds(ms: number): string {
  const d = new Date(ms)
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** `2 steps`, `1 step`. */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const title = (word: string): string => (word === '' ? word : word[0]!.toUpperCase() + word.slice(1))

/**
 * A model id for people: `Opus 5.5`, `Sonnet 5.5`, `Haiku 5.5`, `GPT-6 Astra`. An alias reads as its family (`Opus`); an
 * id it cannot read comes back as given. The `[1m]` marker, a dated release and a trailing effort are dropped.
 */
export function prettyModel(id: string): string {
  const base = id
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-(?:19|20)\d{2}-?\d{2}-?\d{2}$/, '')
    .replace(/[-:](?:low|medium|high|xhigh)$/, '')
  if (base === '') return ''
  const claude = /^(?:claude-)?(opus|sonnet|haiku)(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(base)
  if (claude) {
    const version = claude[2] ? (claude[3] ? `${claude[2]}.${claude[3]}` : claude[2]) : ''
    return `${title(claude[1] as string)}${version ? ` ${version}` : ''}`
  }
  const legacy = /^claude-(\d{1,2})(?:-(\d{1,2}))?-(opus|sonnet|haiku)$/.exec(base)
  if (legacy) {
    const version = legacy[2] ? `${legacy[1]}.${legacy[2]}` : (legacy[1] as string)
    return `${title(legacy[3] as string)} ${version}`
  }
  const gpt = /^gpt-([\w.]+?)(?:-([\w.-]+))?$/.exec(base)
  if (gpt) {
    const words = (gpt[2] ?? '').split('-').filter(word => word !== '').map(title)
    return `GPT-${gpt[1]}${words.length > 0 ? ` ${words.join(' ')}` : ''}`
  }
  return id.trim()
}
