// The crew's session state under `crew`: the mode and the HUD snapshots. This self-contained contract mirrors the hook projections.

/** Which provider serves a plain `crew:<role>` call: `codex` sends it to the role's registered Codex twin. */
export type CrewMode = 'claude' | 'codex'

export type CrewStepState = 'queued' | 'implementing' | 'verified' | 'blocked' | 'committed' | 'skipped' | '?'
/** A plan step as the screen may know it: ids, an allowlisted owner, its dependencies and a known state. */
export type CrewPlanStep = { id: string; owner: string; after: string[]; state: CrewStepState }
export type CrewPlan = {
  name: string
  groups: {
    heading: string
    done: number
    running: number
    left: number
    steps: CrewPlanStep[]
    unknownStates: boolean
  }[]
}
export type CrewPlanDisplay = CrewPlan | { state: 'loading' | 'unknown' }
/** One tool call the HUD names: a name from a fixed set (`mcp` for a server's, `?` for any other) and whether it failed. */
export type CrewToolNote = { name: string; failed: boolean }
export type CrewAgent = {
  id: string
  type: string
  model: string | undefined
  observedModel?: string
  effort?: string
  startedAt?: number
  seenAt?: number
  status: 'running' | 'ended'
  /** Model requests whose usage was observed; none for a twin on the helper. */
  steps?: number
  /** The latest request's whole input, and the output of every request so far. */
  inTokens?: number
  outTokens?: number
  /** The last three tool calls, newest last, and the totals. */
  tools?: CrewToolNote[]
  toolCount?: number
  failures?: number
  /** The plan step the spawn's description started with, when it was a step id. */
  planStep?: string
  endedAt?: number
  stop?: 'max_tokens'
}

declare module 'claude-code' {
  interface PluginState {
    'crew': {
      /** The running session's crew mode: set from the `mode` option at session start, switched by `/crew-mode`. */
      mode: CrewMode
      /** The HUD's prepared plan rows (`hooks/hud/plan.ts`); the band renders from this snapshot only. */
      plans: CrewPlanDisplay[]
      /** The crew agents the HUD tracks, a separate observation from routing state. */
      agents: CrewAgent[]
      /** The clock reading, in epoch milliseconds, the band's elapsed times are drawn from. */
      now: number
      /** The pane's colours: `mockup` (the design's fixed colours) under a dark or automatic theme, `theme` (the theme's keys) under a light or ANSI one. */
      palette: 'mockup' | 'theme'
    }
  }
}
