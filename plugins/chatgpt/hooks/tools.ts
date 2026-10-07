import type { Job, Outcome, Request } from './model'
import { answerOf } from './presentation'
import { requestOf } from './input'

export async function serve(kind: 'ask' | 'image', e: Record<string, unknown>, handlers: { startJob: (request: Request) => Job; runNow: (request: Request) => Promise<Outcome> }) {
  const request = requestOf(kind, e)
  if (typeof request === 'string') return { result: request, isError: true as const }
  if (e.wait === false) {
    const job = handlers.startJob(request)
    return { result: `Started job #${job.id}. A message arrives when it is saved; the jobs tool lists it meanwhile.` }
  }
  return answerOf(await handlers.runNow(request))
}

