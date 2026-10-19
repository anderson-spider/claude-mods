// spider-team's agent roles as the host names them, and the two lines of a brief this plugin reads or adds.
import type { SpiderTier } from '../types'

/** The model each role runs and the effort spider-team asks for by default (Jev may replace it). */
export const TIERS: Record<SpiderTier, { model: string; effort: string }> = {
  planner: { model: 'claude-opus-5-5', effort: 'medium' },
  worker: { model: 'claude-sonnet-5-5', effort: 'medium' },
  researcher: { model: 'claude-haiku-5-5', effort: 'medium' },
  reviewer: { model: 'claude-opus-5-5', effort: 'medium' },
}

const TIER_TYPE = /^(?:spider-team:)?spider-(planner|worker|researcher|reviewer)$/

/** The role of a spawned agent type: spider-team's agents, namespaced by the plugin or not; anything else has none. */
export const tierOf = (type?: string): SpiderTier | undefined => (type ? (TIER_TYPE.exec(type)?.[1] as SpiderTier | undefined) : undefined)

/** The task a brief names on a line of its own, `spider-task: T3`. */
export const taskIdOf = (prompt: string): string | undefined => /^spider-task:\s*(T\d{1,3})\s*$/m.exec(prompt)?.[1]

export const STEP_BRIEF = '\n\nReport your progress with the mcp__spider-team__step tool (load it with ToolSearch if it is deferred): first { done: 0, total: <the steps you plan> }, then again after each step. If the tool does not exist, skip this.'

/** A role agent's prompt with the step brief appended once, unless it already names the step tool. */
export const briefed = (prompt: string, type?: string): string =>
  tierOf(type) && !prompt.includes('mcp__spider-team__step') ? `${prompt}${STEP_BRIEF}` : prompt
