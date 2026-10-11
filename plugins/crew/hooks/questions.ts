// What Jev is asked about one Agent call. Constants only. The wording follows TypeSafe's Jev guidance: one choice over
// the model tiers (each option an object with the same keys) and one score whose levels are concrete situations.
// Jev never sees the question ids.

/** The pinned Jev model; its id is logged with every decision, so a change of the pin shows in the data. */
export const JEV_MODEL = 'jev-1.13.0'

export const QUESTIONS = {
  tier: {
    type: 'choice',
    instructions: [
      'Pick the cheapest model tier that can fully complete the task `task.prompt` in one pass, without retrying on a stronger one.',
      'Judge the reasoning the task needs, not the length of the reply. Consider `agent.type`: it is the role the task runs in.',
    ],
    criteria: {
      haiku: {
        what: 'Trivial, mechanical or purely factual work.',
        examples: ['Find where a symbol is defined', 'Rename or reformat', 'Summarize one file'],
        not_for: 'Design judgement or multi-file reasoning.',
      },
      sonnet: {
        what: 'Ordinary engineering with a clear, bounded shape.',
        examples: ['Implement a specified function', 'Write tests for existing behaviour', 'Fix an understood local bug'],
        not_for: 'Open-ended architecture or unknown-cause debugging.',
      },
      opus: {
        what: 'Hard reasoning, ambiguity or high blast radius.',
        examples: ['Unknown-cause debugging', 'Cross-module design, security, auth or migrations', 'Audit a diff for regressions'],
        not_for: 'Routine work with a clear implementation.',
      },
    },
  },
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

/** The tier answer applies from this confidence; below it the agent keeps its default model. */
export const TIER_MIN_CONFIDENCE = 0.5

/** `reasoning_depth` below the first bound is `low`, below the second `medium`, else `high`. Untuned defaults. */
export const DEPTH_BOUNDS = [1.0, 2.5] as const

/** A depth within this distance of a bound is a tie: the agent keeps its default effort. */
export const DEPTH_TIE = 0.01

/** The prompt is cut to this many characters after redaction; the description to the second. */
export const PROMPT_CHARS = 4000
export const DESCRIPTION_CHARS = 200
