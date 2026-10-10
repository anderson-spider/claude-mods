// The judge's host side, pure (decisions 10 and 18): what the plugin options say, what a failure means for the rest of the
// session, and the one `ask` the controller reaches the judge through. Fetch, timer, clock and random arrive injected
// (`JudgeIo`) and nothing here touches `$`, so a fake fetch tests all of it.
//
// Where the key comes from. The options of the plugin and nothing else: not `<repo>/.claude/pantheon.json`, not a file of the
// repository, not an environment variable. A cloned repository must not be able to switch the judge on, change its route or
// point the key at a host of its own. The plugin options live in settings, and a repository's own settings files
// (`.claude/settings.json`, `.claude/settings.local.json`) can carry `pluginConfigs` that outrank the person's user settings,
// so the options as the plugin API hands them over are not enough: `resolveJudge` tells, from the settings sources, which
// of them the person set. An option whose value the repository carries is replaced by the highest-precedence value of the
// person's own sources (user, flag, policy) or, with none, is unset; and when the sources cannot all be read, nothing can be
// attributed and the judge is off. Only the person's sources ever contribute a value.

import type { Prepared, RouteKind } from './questions'
import { createBreaker, judge } from './judge'
import type { Breaker, JudgeIo, JudgeResult, Route } from './judge'
import type { RedactContext } from './redact'
import type { Thresholds } from './questions'

export type JudgeMode = 'off' | 'shadow' | 'escalate'

/** `off` unless the person asked: nothing leaves the machine until they opt in, and a key is required as well. */
export function judgeModeOf(value: unknown): JudgeMode {
  return value === 'shadow' || value === 'escalate' ? value : 'off'
}

export function judgeRouteOf(value: unknown): RouteKind {
  return value === 'typesafe' ? 'typesafe' : 'openrouter'
}

// --- options ---

const OPTION_NAMES = ['judge', 'judgeKey', 'judgeRoute', 'judgeBaseUrl'] as const
type OptionName = (typeof OPTION_NAMES)[number]

/** The settings sources, as `$.settings.read({ source })` answers them. */
export type SettingsView = {
  /** The person's own, lowest precedence first: user, flag, policy. */
  trusted: readonly unknown[]
  /** What a cloned repository brings: project and local. */
  repo: readonly unknown[]
  /** True only when every source, the person's and the repository's, was read. One that failed leaves nothing attributable. */
  readable: boolean
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The `pluginConfigs` entries that are this plugin's: `pantheon`, `pantheon@inline`, `pantheon@<marketplace>`. */
const isOwnEntry = (key: string): boolean => key === 'pantheon' || key.startsWith('pantheon@')

/** What one source says for `name` (one value per own entry that sets it), in the order the entries are listed. */
function valuesIn(source: unknown, name: OptionName): unknown[] {
  const configs = isObject(source) ? source.pluginConfigs : undefined
  if (!isObject(configs)) return []
  const out: unknown[] = []
  for (const [key, entry] of Object.entries(configs)) {
    if (!isOwnEntry(key)) continue
    const options = isObject(entry) ? entry.options : undefined
    if (isObject(options) && options[name] !== undefined && options[name] !== '') out.push(options[name])
  }
  return out
}

const HTTPS = /^https:\/\/([^/?#@\s\\]+)(\/[^?#\s]*)?$/i
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/[^?#\s]*)?$/i

/** The base URL as it will be used (no trailing slash), its lower-case host, or undefined when it is not usable for a key. */
export function parseBaseUrl(raw: string): { base: string; host: string } | undefined {
  const text = raw.trim()
  const https = HTTPS.exec(text)
  if (https) return { base: text.replace(/\/+$/, ''), host: https[1]!.toLowerCase() }
  const loopback = LOOPBACK.exec(text)
  if (loopback) return { base: text.replace(/\/+$/, ''), host: `${loopback[1]!.toLowerCase()}${loopback[2] ?? ''}` }
  return undefined
}

export type JudgeSetup = {
  mode: JudgeMode
  /** Present only when the judge is on and a key is set. */
  route?: Route
  /** What the person should hear, once: an option ignored, a key missing, sources unreadable. Never a value. */
  notes: string[]
}

/**
 * The effective judge configuration from the plugin options. Pure.
 *
 * `options` are the merged values the plugin API hands over, whichever settings file they came from. `settings` is what each
 * source holds: with it, an option whose value a repository source carries is not the person's word and is replaced by the
 * person's own value for it (the highest-precedence of user, flag and policy) or unset. Without it, or with a source that
 * could not be read, an option cannot be attributed, and a judge that was asked for is off (with a note).
 */
export function resolveJudge(options: Readonly<Record<string, unknown>>, settings?: SettingsView): JudgeSetup {
  const asked = judgeModeOf(options.judge)
  // Off, with nothing to attribute: nothing is read and nothing is said.
  if (asked === 'off' && !settings) return { mode: 'off', notes: [] }
  // On with no key at all: there is nothing to send and nothing to attribute, so the settings are not needed (nor read).
  if (asked !== 'off' && !(typeof options.judgeKey === 'string' && options.judgeKey.trim() !== '')) {
    return { mode: asked, notes: [`the pantheon option judge is ${asked} but judgeKey is not set: no request is made`] }
  }
  const sources = settings ? [...settings.trusted, ...settings.repo] : []
  if (!settings || !settings.readable || !sources.every(isObject)) {
    // A flag or a key a repository set cannot be told from the person's: the judge is off rather than guessed.
    if (asked === 'off') return { mode: 'off', notes: [] }
    return { mode: 'off', notes: ['the pantheon judge is off for this session: the settings that say who set its options could not all be read'] }
  }

  const notes: string[] = []
  const attributed = (name: OptionName): unknown => {
    const merged = options[name]
    if (merged === undefined || merged === '') return undefined
    // The repository's word for this option; a value it does not carry came from somewhere else (the person's settings,
    // the secure store, the plugin's default), and a repository that carries another value did not win.
    if (!settings.repo.some(source => valuesIn(source, name).includes(merged))) return merged
    // The person's own value, from the highest-precedence source of theirs that sets it.
    let own: unknown
    for (const source of settings.trusted) {
      const values = valuesIn(source, name)
      if (values.length > 0) own = values[values.length - 1]
    }
    if (own === merged) return merged
    notes.push(`the repository's settings set the pantheon option ${name}, which is ignored${own === undefined ? '' : ' in favour of your own value'}: set it in your own settings`)
    return own
  }
  const given = Object.fromEntries(OPTION_NAMES.map(name => [name, attributed(name)])) as Record<OptionName, unknown>

  const mode = judgeModeOf(given.judge)
  if (mode === 'off') return { mode, notes }
  const key = typeof given.judgeKey === 'string' ? given.judgeKey.trim() : ''
  if (!key) {
    notes.push(`the pantheon option judge is ${mode} but judgeKey is not set: no request is made`)
    return { mode, notes }
  }
  const kind = judgeRouteOf(given.judgeRoute)
  let baseUrl: string | undefined
  if (typeof given.judgeBaseUrl === 'string' && given.judgeBaseUrl.trim() !== '') {
    const parsed = parseBaseUrl(given.judgeBaseUrl)
    if (!parsed) notes.push('the pantheon option judgeBaseUrl must be https (or a loopback address): it is ignored and the route\'s own address is used')
    else baseUrl = parsed.base
  }
  return { mode, route: { kind, key, ...(baseUrl ? { baseUrl } : {}) }, notes }
}

// --- the session ---

/** What the judge remembers across calls: shared by every caller of one module instance. */
export type JudgeSession = {
  breaker: Breaker
  /** Switched off for the rest of the session by a refused key or endpoint (401, 402, 403, 404). */
  off: boolean
  /** Batteries a 400 or 422 stopped for the session: the request is deterministic, so asking again is asking for the same error. */
  stopped: Set<string>
  /** What was already told to the person. */
  told: Set<string>
}

/** `now` is a synchronous epoch clock (`() => Date.now()`): the breaker's pause is measured against it. */
export function createJudgeSession(now: () => number): JudgeSession {
  return { breaker: createBreaker(now), off: false, stopped: new Set(), told: new Set() }
}

/** The battery by the ids of its questions: the retry battery with and without `same_failure` are two. */
export const batteryKey = (prepared: Prepared): string => `${prepared.kind}:${Object.keys(prepared.battery).sort().join(',')}`

// --- the access the controller asks through ---

export type JudgeAccess = {
  /** `shadow`: ask and journal only. `escalate`: also act, in the flow's enforce mode on an approved plan. */
  mode: 'shadow' | 'escalate'
  /** What leaves the machine is redacted against these (the home and the repository root). */
  redact: RedactContext
  /** The thresholds the answers are measured against; the provisional defaults when absent. */
  thresholds?: Thresholds
  /**
   * One request for one checkpoint. Never throws. Resolves undefined when nothing was asked (the judge is off for the
   * session, or this battery was stopped); otherwise the typed result, a failure included.
   */
  ask(prepared: Prepared): Promise<JudgeResult | undefined>
  /** What `/pantheon flow status` says: whether it is still on for the session and what has stopped it. */
  status(): { off: boolean; breakerOpen: boolean; stoppedBatteries: number }
}

export type JudgeAccessInit = {
  mode: 'shadow' | 'escalate'
  route: Route
  io: JudgeIo
  session: JudgeSession
  redact: RedactContext
  /** The person is told through this, at most once for the same thing. */
  toast: (text: string) => void
  timeoutMs?: number
  thresholds?: Thresholds
}

export function createJudgeAccess(init: JudgeAccessInit): JudgeAccess {
  const { session, route } = init
  const tell = (id: string, text: string) => {
    if (session.told.has(id)) return
    session.told.add(id)
    try { init.toast(text) } catch { /* A failed toast changes nothing. */ }
  }
  return {
    mode: init.mode,
    redact: init.redact,
    ...(init.thresholds ? { thresholds: init.thresholds } : {}),
    async ask(prepared) {
      if (session.off) return undefined
      const key = batteryKey(prepared)
      if (session.stopped.has(key)) return undefined
      let result: JudgeResult
      try {
        result = await judge(init.io, route, prepared, { breaker: session.breaker, ...(init.timeoutMs === undefined ? {} : { timeoutMs: init.timeoutMs }) })
      } catch {
        // `judge` does not throw; a host that does is a failed call, not a crash.
        return undefined
      }
      if (!result.ok) {
        if (result.off === true) {
          session.off = true
          tell('off', `pantheon: the judge's key or endpoint was refused (HTTP ${result.status ?? '?'}): the judge is off for this session. Check the judgeKey and judgeRoute options.`)
        } else if (result.off === 'battery') {
          session.stopped.add(key)
        }
      }
      return result
    },
    status() {
      let breakerOpen = false
      try { breakerOpen = session.breaker.status().open } catch { /* A broken breaker is not an open one. */ }
      return { off: session.off, breakerOpen, stoppedBatteries: session.stopped.size }
    },
  }
}
