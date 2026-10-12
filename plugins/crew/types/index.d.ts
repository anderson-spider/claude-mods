// The crew's session state under `crew`: the mode and the HUD snapshots. This self-contained contract mirrors the hook projections.

/** Which provider serves a plain `crew:<role>` call: `codex` sends it to the role's registered Codex twin. */
export type CrewMode = 'claude' | 'codex'

export type CrewPlan = {
  name: string
  groups: {
    heading: string
    done: number
    running: number
    left: number
    runningSteps: { id: string; owner: string }[]
    unknownStates: boolean
  }[]
}
export type CrewPlanDisplay = CrewPlan | { state: 'loading' | 'unknown' }
export type CrewAgent = {
  id: string
  type: string
  model: string | undefined
  observedModel?: string
  effort?: string
  startedAt?: number
  seenAt?: number
  status: 'running' | 'ended'
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
    }
  }
}
