import type { Answers, AskFn, Questions } from '../../hooks/jevflow/questions'

// A Jev that agrees with the checks: it reads the current phase from the state it is sent, calls that phase done and
// verifies it. A passing check then advances, a failing one holds (the policy's check outranks Jev).

export function faithfulAnswers(questions: Questions, state: string): Answers {
  if ('verify' in questions) return { verify: { type: 'noul', noul: 0.95 } }
  const cur = String((JSON.parse(state) as { current_phase?: string }).current_phase)
  const answers: Answers = {
    current_phase: { type: 'choice', choice: cur, confidence: 0.95, probabilities: { [cur]: 0.95, unclear: 0.05 } },
    next_action: { type: 'choice', choice: 'advance_phase', confidence: 0.9, probabilities: { advance_phase: 0.9, continue_phase: 0.1 } },
    stuck: { type: 'noul', noul: 0.05 },
    off_goal: { type: 'noul', noul: 0.05 },
    claims_done: { type: 'noul', noul: 0.6 },
  }
  for (const id of Object.keys(questions)) if (id.startsWith('phase_done__')) answers[id] = { type: 'noul', noul: id === `phase_done__${cur}` ? 0.95 : 0.05 }
  return answers
}

export const faithfulAsk: AskFn = async (questions, state) => faithfulAnswers(questions, state)

/** The 2xx body Jev's endpoint answers a request body with. */
export function faithfulBody(requestBody: string): string {
  const { questions, state } = JSON.parse(requestBody) as { questions: Questions; state: string }
  return JSON.stringify({ model: 'typesafe/jev-1.13', answers: faithfulAnswers(questions, state) })
}
