import type { CodexAsking } from '../types'
import { callerOf } from './helper'
import { ROUTES } from './model'
import type { CallResult, Choice, Failure, ResetReply } from './model'
import { approvalWaitText, toAnswer } from './presentation'
import type { ToolAnswer } from './presentation'

export type BridgeDeps = {
  enabled(): Promise<boolean>
  sessionId(): Promise<string>
  helper(route: string, body: unknown): Promise<Reply>
  ask(question: CodexAsking, signal: AbortSignal): Promise<Choice | 'aborted' | 'timeout'>
  limitMs: number
}

// A call may need several apps approved, one after another.
export const MAX_APPROVALS = 5

export type BridgeInput = { tool_use_id: string; code?: string; title?: string; timeout_ms?: number; reset?: boolean; agentId?: string }

/** One bridge call: run the code, asking the person for each new app on the way. */
export const serve = async (deps: BridgeDeps, input: BridgeInput, signal: AbortSignal): Promise<ToolAnswer> => {
  if (!(await deps.enabled())) {
    return { result: 'codex-computer-use is off (/codex-cu off): use the default desktop route, or ask the person to type /codex-cu on.', isError: true as const }
  }

  const caller = callerOf(await deps.sessionId(), input.agentId)

  if (input.reset === true) {
    // `/reset` answers its message, or a failure.
    const reply = (await deps.helper(ROUTES.reset, { caller })) as ResetReply | Failure

    return reply.status === 'ok' ? { result: reply.message ?? 'reset' } : toAnswer(reply)
  }

  const body = { caller, code: input.code, title: input.title, timeout_ms: input.timeout_ms }

  for (let round = 0; round <= MAX_APPROVALS; round++) {
    // `/call` answers a result, a held call or a failure.
    const reply = (await deps.helper(ROUTES.call, body)) as CallResult

    if (reply.status !== 'needs_approval') {
      return toAnswer(reply)
    }

    const question: CodexAsking = {
      id: input.tool_use_id,
      bundleId: reply.app.bundleId,
      displayName: reply.app.displayName,
      canAlways: reply.app.canAlways === true,
      who: input.agentId === undefined ? 'main session' : `subagent ${input.agentId}`,
    }
    const choice = await deps.ask(question, signal)

    if (choice === 'aborted' || choice === 'timeout') {
      return {
        result: `The person did not answer whether Codex may use ${reply.app.displayName}${choice === 'timeout' ? approvalWaitText(deps.limitMs) : ''}; nothing was done with it.`,
        isError: true as const,
      }
    }

    await deps.helper(ROUTES.approve, { caller, bundleId: reply.app.bundleId, choice })

    if (choice === 'deny') {
      return toAnswer({ status: 'denied', app: reply.app })
    }
  }

  return { result: 'codex-cu: too many approval rounds for one call.', isError: true as const }
}
