// The outcome judge: asks Jev the router's three judge questions about an agent's final answer. Host access is injected;
// only the redacted, clipped answer leaves the machine, as `report.text`, the request's only state. Never throws: any
// failure is null, logged as one fixed line with a reason code.
import { clipped, JEV_MODEL } from './effort'
import type { EffortIo, JevReason } from './effort'
import { classifyFailure, createJev, nouls } from './jev'
import { resolveAccess } from './key'
import { JUDGE_FLAGS, JUDGE_QUESTIONS } from './router'
import type { Judge } from './router'

export async function judgeAnswer(io: EffortIo, call: { answer: string; key?: string; home: string; root: string }): Promise<Judge | null> {
  const off = (reason: JevReason) => {
    try { io.log(`spider-team: judge off (${reason})`) } catch { /* Logging cannot change the outcome line. */ }
    return null
  }
  try {
    const access = await resolveAccess(io, call.key)
    if (access.key === undefined) return off(access.off)
    const state = { report: { text: clipped(call.answer, access.key, call) } }
    const { answers } = await createJev(io.jev, access.key, { model: JEV_MODEL, breaker: io.breaker, gate: io.gate, answerIds: JUDGE_FLAGS })(JUDGE_QUESTIONS, state)
    return nouls(answers, JUDGE_FLAGS)
  } catch (error) { return off(classifyFailure(error).failure.reason) }
}
