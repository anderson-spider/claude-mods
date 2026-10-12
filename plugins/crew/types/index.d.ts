// The router's quota state under `crew`. This self-contained contract mirrors `hooks/quota.ts`.

/** One rate-limit window: how much is used (0-100) and when it resets (ISO 8601). */
export type QuotaWindow = { percentUsed: number; resetsAt?: string }

/** What a provider reports; a window it does not report is absent. */
export type QuotaReading = { fiveHour?: QuotaWindow; sevenDay?: QuotaWindow }

/** Both providers' limits and the provider they favor, kept by the router. */
export type QuotaState = {
  claude: QuotaReading | null
  codex: QuotaReading | null
  /** `ok` fresh; `unknown` none yet or none usable; `stale` too old; `down` the status request failed; `off` not asked. */
  codexState: 'ok' | 'unknown' | 'stale' | 'down' | 'off'
  /** When the Codex status was fetched (ms since epoch), or null before the first fetch. */
  fetchedAt: number | null
  /** When the Codex limits were observed (ms; the oldest window's), or null. */
  codexObservedAt: number | null
  /** When the last non-empty Claude reading was taken (ms), or null. */
  claudeAt: number | null
  /** The decision for these readings; `reason` has no provider prefix. */
  decision: { provider: 'claude' | 'codex'; reason: string }
}

declare module 'claude-code' {
  interface PluginState {
    'crew': {
      /** Claude's and Codex's limits and the provider they favor (`hooks/quota.ts`). */
      quota: QuotaState
    }
  }
}
