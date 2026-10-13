import type { CodexAsking, CodexCuInput } from '../types'
import { callerOf } from './helper'
import { ROUTES } from './model'
import type { Choice, Route, RouteReplies } from './model'
import { BRIDGE_OFF, TOO_MANY_ROUNDS, askerText, refusal, resetText, toAnswer, unansweredText } from './presentation'
import type { ToolAnswer } from './presentation'

export type BridgeDeps = {
  enabled(): Promise<boolean>
  sessionId(): Promise<string>
  helper<R extends Route>(route: R, body: unknown): Promise<RouteReplies[R]>
  ask(question: CodexAsking, signal: AbortSignal): Promise<Choice | 'aborted' | 'timeout'>
  limitMs: number
}

// A call may need several apps approved, one after another.
export const MAX_APPROVALS = 5

/** The bridge tool's arguments (`types/index.d.ts`) with the event fields the call reads. */
export type BridgeInput = CodexCuInput & { tool_use_id: string; agentId?: string }

/** One bridge call: run the code, asking the person for each new app on the way. */
export const serve = async (deps: BridgeDeps, input: BridgeInput, signal: AbortSignal): Promise<ToolAnswer> => {
  if (!(await deps.enabled())) {
    return refusal(BRIDGE_OFF)
  }

  const caller = callerOf(await deps.sessionId(), input.agentId)

  if (input.reset === true) {
    const reply = await deps.helper(ROUTES.reset, { caller })

    return reply.status === 'ok' ? { result: resetText(reply) } : toAnswer(reply)
  }

  const body = { caller, code: input.code, title: input.title, timeout_ms: input.timeout_ms }

  for (let round = 0; round <= MAX_APPROVALS; round++) {
    const reply = await deps.helper(ROUTES.call, body)

    if (reply.status !== 'needs_approval') {
      return toAnswer(reply)
    }

    const question: CodexAsking = {
      id: input.tool_use_id,
      bundleId: reply.app.bundleId,
      displayName: reply.app.displayName,
      canAlways: reply.app.canAlways === true,
      who: askerText(input.agentId),
    }
    const choice = await deps.ask(question, signal)

    if (choice === 'aborted' || choice === 'timeout') {
      return refusal(unansweredText(reply.app.displayName, choice, deps.limitMs))
    }

    await deps.helper(ROUTES.approve, { caller, bundleId: reply.app.bundleId, choice })

    if (choice === 'deny') {
      return toAnswer({ status: 'denied', app: reply.app })
    }
  }

  return refusal(TOO_MANY_ROUNDS)
}
