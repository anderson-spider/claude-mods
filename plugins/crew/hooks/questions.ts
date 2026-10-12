// What Jev is asked about one Agent call. Constants only. The wording follows TypeSafe's Jev guidance for
// reasoning depth: one score whose levels are concrete situations.
// Jev never sees the question ids.

/** The pinned Jev model; its id is logged with every decision, so a change of the pin shows in the data. */
export const JEV_MODEL = 'jev-1.13.0'

export const QUESTIONS = {
  reasoning_depth: {
    type: 'score',
    instructions: 'How much step-by-step reasoning does the task in `task.prompt` need before its answer is correct?',
    criteria: [
      'Look something up or copy it: no reasoning beyond finding it.',
      'Apply one known pattern to a clearly specified, local change.',
      'Combine several files or constraints; a few dependent steps.',
      'Weigh trade-offs or find an unknown cause across modules.',
      'Design or audit something where a wrong step has wide consequences.',
    ],
  },
} as const

/**
 * `reasoning_depth` (Jev's 0-4 scale) from this value is `high`, below it `medium`: a declared policy, not a fit. Every
 * agent's effort floor is `medium`, so there is no `low` bound. 3.0 keeps `high` for the top band: about 30% of the 126
 * decisions logged when it was set, against about half at 2.5 (a snapshot, not a live figure).
 */
export const DEPTH_HIGH = 3.0

/** A depth within this distance of the bound is a tie: the agent keeps its default effort. */
export const DEPTH_TIE = 0.01

/** The prompt is cut to this many characters after redaction; the description to the second. */
export const PROMPT_CHARS = 4000
export const DESCRIPTION_CHARS = 200
