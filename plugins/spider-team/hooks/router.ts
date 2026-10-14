// The whole routing policy in one place, pure data: the questions Jev answers, how its answers become levels, the
// cost-benefit table those levels select, the capacity ladder, each role's floor and default, and the prices behind the
// cost estimate. A new model means editing MODELS in roles.ts, the ladder and the cells here; tsc fails on a cell, floor
// or default that is not a ladder entry and on a missing cell. effort.ts only carries it out.
//
// Policy note, not a measurement: Haiku 5.5 costs about 1/20 of Sonnet 5.5 per token and beats Sonnet medium on
// merge-quality coding, so Sonnet low and medium are dominated by Haiku high and xhigh. Opus low costs about what Sonnet
// high does, and Opus above high does not improve. Haiku never runs at low effort because it skips search and
// verification on long agentic prompts. Fable is out for lack of data.
import type { Effort, Model, Pair, Role } from './roles'

// Tags each decision line so the stats compare Jev only under one policy: bump it whenever QUESTIONS, POLICY or the table change.
export const CALIBRATION = 3

export const DIMENSIONS = ['difficulty', 'duration'] as const
export type Dimension = (typeof DIMENSIONS)[number]
/** One request carries both questions; each criterion list is the level scale its answers use. */
export const QUESTIONS = {
  difficulty: {
    type: 'score',
    instructions: 'How hard is this task for a capable coding agent? Judge the work itself, not the length or detail of the brief: a long list of constraints, checks or acceptance criteria does not make a task harder.',
    criteria: ['Trivial: a one-line or purely mechanical change, such as a rename, a typo, a constant or a version bump', 'Easy: small, well-understood change in one place, such as adjusting one layout line or adding a field to an output, with its test', 'Moderate: needs some understanding of the surrounding code, such as a small feature across two or three files or a bug whose cause is known', 'Hard: subtle logic across several interacting parts, or a root cause still to be found, such as an ordering or race bug or a refactor that must keep several contracts', 'Expert: architecture, concurrency, security, or deep domain reasoning, such as a new protocol, a security boundary or a redesign across modules'],
  },
  // Human-expert time, the standard scale (the SWE-bench Verified buckets): Jev cannot estimate a coding agent's own time.
  duration: {
    type: 'score', instructions: 'How long would an experienced engineer who already knows this codebase need to finish this task?',
    criteria: ['Under 15 minutes: a mechanical edit or a one-line fix', '15 minutes to 1 hour: a small change in one or two files with its tests', '1 to 4 hours: a feature or fix across several files, with tests and docs', 'More than 4 hours: a new subsystem, a migration, or an investigation with no known cause'],
  },
} as const

// Policy, not a measurement: a task that needs more than the pair gives costs 1.25 times what spare capacity does, so the
// lower of two adjacent levels wins once it holds at least 5/9 (about 56%) of their weight.
export const POLICY = { under: 1.25, over: 1 } as const

/** Difficulty levels 0..4, in the order of the difficulty question's criteria. */
export const DIFFICULTIES = ['trivial', 'easy', 'moderate', 'hard', 'expert'] as const
export type Difficulty = (typeof DIFFICULTIES)[number]
export const DURATION_GROUPS = ['short', 'medium', 'long'] as const
export type DurationGroup = (typeof DURATION_GROUPS)[number]
/** The group of each human-time level 0..3 of the duration question: 0 and 1 are short, 2 medium, 3 long. */
export const GROUP_OF_DURATION: readonly DurationGroup[] = ['short', 'short', 'medium', 'long']

/**
 * Capacity order, weakest first. The only pairs the router may pick: every table cell, floor and default is a rung, so
 * tsc fails on anything else.
 */
export const LADDER = ['haiku/medium', 'haiku/high', 'haiku/xhigh', 'sonnet/high', 'opus/low', 'opus/medium', 'opus/high'] as const satisfies readonly `${Model}/${Effort}`[]
export type Rung = (typeof LADDER)[number]
export const pairOf = (rung: Rung): Pair => {
  const [model, effort] = rung.split('/') as [Model, Effort]
  return { model, effort }
}
/** The stronger of two rungs; on equal capacity the first. */
export const higher = (a: Rung, b: Rung): Rung => LADDER.indexOf(b) > LADDER.indexOf(a) ? b : a

export const ROUTES: Readonly<Record<Difficulty, Readonly<Record<DurationGroup, Rung>>>> = {
  trivial: { short: 'haiku/medium', medium: 'haiku/medium', long: 'haiku/high' },
  easy: { short: 'haiku/high', medium: 'haiku/high', long: 'haiku/xhigh' },
  moderate: { short: 'haiku/xhigh', medium: 'sonnet/high', long: 'sonnet/high' },
  hard: { short: 'opus/low', medium: 'opus/medium', long: 'opus/high' },
  expert: { short: 'opus/high', medium: 'opus/high', long: 'opus/high' },
}

/**
 * A role's floor (the routed pair is never weaker than it) and its default (used when Jev is off or fails, and by the
 * registered definition; it need not be a table cell).
 */
export const ROLE_POLICY: Readonly<Record<Role, { floor: Rung; default: Rung }>> = {
  analyst: { floor: 'haiku/medium', default: 'haiku/high' },
  developer: { floor: 'haiku/high', default: 'sonnet/high' },
  architect: { floor: 'opus/low', default: 'opus/medium' },
  reviewer: { floor: 'opus/low', default: 'opus/medium' },
}
export const defaultOf = (role: Role): Pair => pairOf(ROLE_POLICY[role].default)

/** What a difficulty level 0..4 and a duration level 0..3 select for a role: the table's cell and the pair after the floor. */
export function routeOf(role: Role, difficulty: number, duration: number): { cell: Pair; pair: Pair; floorApplied: boolean } {
  const label = DIFFICULTIES[difficulty], group = GROUP_OF_DURATION[duration]
  if (!label || !group) throw new Error('level out of range')
  const cell = ROUTES[label][group], final = higher(cell, ROLE_POLICY[role].floor)
  return { cell: pairOf(cell), pair: pairOf(final), floorApplied: final !== cell }
}

/** USD per million tokens, list prices as of October 2026 (Haiku prices are for prompts up to 100k tokens). */
export type Price = { input: number; output: number; cacheWrite: number; cacheRead: number }
export const PRICES: Readonly<Record<Model, Price>> = {
  haiku: { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.50, cacheRead: 0.10 },
  opus: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.20 },
}
