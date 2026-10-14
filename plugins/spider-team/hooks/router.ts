// The cost-benefit table: Jev's difficulty and duration levels select one model and effort. Pure data.
// A new model means editing MODELS in roles.ts and the cells here; tsc fails on an unknown model or effort and on a missing cell.
import type { Pair, Role } from './roles'

/** Difficulty levels 0..4, in the order of the difficulty question's criteria. */
export const DIFFICULTIES = ['trivial', 'easy', 'moderate', 'hard', 'expert'] as const
export type Difficulty = (typeof DIFFICULTIES)[number]
export const DURATION_GROUPS = ['short', 'medium', 'long'] as const
export type DurationGroup = (typeof DURATION_GROUPS)[number]
/** The group of each duration level 0..3 of the duration question: 0 and 1 are short, 2 medium, 3 long. */
export const GROUP_OF_DURATION: readonly DurationGroup[] = ['short', 'short', 'medium', 'long']

export const ROUTES: Readonly<Record<Difficulty, Readonly<Record<DurationGroup, Pair>>>> = {
  trivial: { short: { model: 'haiku', effort: 'low' }, medium: { model: 'haiku', effort: 'low' }, long: { model: 'haiku', effort: 'medium' } },
  easy: { short: { model: 'sonnet', effort: 'low' }, medium: { model: 'sonnet', effort: 'medium' }, long: { model: 'sonnet', effort: 'medium' } },
  moderate: { short: { model: 'sonnet', effort: 'medium' }, medium: { model: 'sonnet', effort: 'high' }, long: { model: 'sonnet', effort: 'high' } },
  hard: { short: { model: 'opus', effort: 'low' }, medium: { model: 'opus', effort: 'medium' }, long: { model: 'opus', effort: 'high' } },
  expert: { short: { model: 'opus', effort: 'high' }, medium: { model: 'fable', effort: 'high' }, long: { model: 'fable', effort: 'high' } },
}

/** Each role's typical task as a cell of the table: its default pair, used when no pin or Jev answer applies, moves with the table. */
export const ROLE_CELLS: Readonly<Record<Role, { difficulty: Difficulty; group: DurationGroup }>> = {
  analyst: { difficulty: 'easy', group: 'medium' },
  developer: { difficulty: 'moderate', group: 'medium' },
  reviewer: { difficulty: 'hard', group: 'short' },
  architect: { difficulty: 'hard', group: 'medium' },
}
export const defaultOf = (role: Role): Pair => ROUTES[ROLE_CELLS[role].difficulty][ROLE_CELLS[role].group]

/** The pair for a difficulty level 0..4 and a duration level 0..3. */
export function routeOf(difficulty: number, duration: number): Pair {
  const label = DIFFICULTIES[difficulty], group = GROUP_OF_DURATION[duration]
  if (!label || !group) throw new Error('level out of range')
  return ROUTES[label][group]
}
