// Pure step builders and effort selection for twins on the crew Codex helper.

import type { TurnStepChunk, TurnStepResult } from 'claude-code'

/** The efforts the twins' fixed models take; any other request falls back to the twin's default. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
export type CodexEffort = (typeof EFFORTS)[number]

export function codexEffort(requested: string | undefined, fallback: CodexEffort): CodexEffort {
  return EFFORTS.find(effort => effort === requested) ?? fallback
}

/** One message as `$.session.messages({ as: 'api' })` gives it. */
export type ApiMessage = { role: string; content: readonly { type: string; [field: string]: unknown }[] }

/** The step as crew yields it: the chunks in order, then the result's fields. */
export type CodexStep = Omit<TurnStepResult, 'turnId' | 'index'> & { chunks: TurnStepChunk[] }

/** A step that answers with plain text: no tool and no usage. */
export function textStep(text: string): CodexStep {
  return {
    chunks: [{ kind: 'text', index: 0, text }, { kind: 'stop', stopReason: 'end_turn', usage: null }],
    answer: text,
    toolUses: [],
    stopReason: 'end_turn',
    usage: null,
  }
}

/** The tool a subagent's result reaches its caller through on hosts that run it as a subagent: plain text is not delivered. */
export const HANDBACK = 'SubagentHandback'

/** The same step, its answer handed back through `SubagentHandback({ message })` instead of as plain text. */
export function handbackStep(step: CodexStep, id: string): CodexStep {
  const message = step.answer
  return {
    chunks: [{ kind: 'tool', index: 0, id, name: HANDBACK }, { kind: 'input', index: 0, json: JSON.stringify({ message }) }, { kind: 'stop', stopReason: 'tool_use', usage: step.usage }],
    // The host's typing: `answer` is empty when the step only called tools.
    answer: '',
    toolUses: [{ name: HANDBACK, input: { message } }],
    stopReason: 'tool_use',
    usage: step.usage,
  }
}

/** A step that answers with why Codex was not asked or did not answer: never a throw, which would send the request to Anthropic. */
export function failedStep(reason: string): CodexStep {
  return textStep(`crew: this Codex twin could not run: ${reason}.`)
}
