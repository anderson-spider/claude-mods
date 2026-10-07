import type { Book, Kind, Loop, LoopDeps } from './model'
import { loopOf, requestOf } from './requests'
import { cancelLoop, loopStart } from './loop'
import { allJobs, jobDetail, loopReport } from './presentation'

export const NOT_READY = 'codex-team is not ready: the session has not started it yet.'

export const refusal = (text: string) => ({ result: text, isError: true as const })

// A tool handler never rejects: an error becomes a refusal the model can read.
export const failure = (error: unknown) => refusal(`codex-team failed: ${error instanceof Error ? error.message : String(error)}`)

export async function startJob({ book, unavailable }: { book?: Pick<Book, 'start'>; unavailable?: string }, kind: Kind, e: Record<string, unknown>, publish: () => Promise<void>) {
  if (!book) return refusal(unavailable ?? NOT_READY)
  const request = requestOf(kind, e)
  if (typeof request === 'string') return refusal(request)
  const job = await book.start(request)
  await publish()
  return { result: `Started job ${job.agent} (${kind}). A message arrives when it finishes; the jobs tool lists it meanwhile.` }
}

export async function startLoop({ book, loopDeps, unavailable }: { book?: Book; loopDeps?: LoopDeps; unavailable?: string }, e: Record<string, unknown>, addLoop: (loop: Loop) => void, publish: () => Promise<void>) {
  if (!book || !loopDeps) return refusal(unavailable ?? NOT_READY)
  const request = loopOf(e)
  if (typeof request === 'string') return refusal(request)
  const loop = await loopStart(loopDeps, book, request)
  addLoop(loop)
  await publish()
  return { result: `Started loop-${loop.id}. One message arrives at the end with the verdict and report path; the jobs tool lists it meanwhile.` }
}

function readJob(book: Pick<Book, 'get'>, loop: Loop | undefined, id: number) {
  if (loop) return { result: [loopReport(loop, book), loop.report ? `Report: ${loop.report}` : ''].filter(Boolean).join('\n') }
  const job = book.get(id)
  return job ? { result: jobDetail(job) } : refusal(`No job ct-${id} in this session.`)
}

export async function jobsTool({ book, loops, unavailable }: { book?: Pick<Book, 'get' | 'jobs' | 'cancel'>; loops: readonly Loop[]; unavailable?: string }, e: Record<string, unknown>, publish: () => Promise<void>, now: () => number) {
  if (!book) return refusal(unavailable ?? NOT_READY)
  const loop = typeof e.id === 'number' ? loops.find(loop => loop.id === e.id) : undefined
  if (e.action === 'cancel') {
    if (typeof e.id !== 'number') return refusal('Give the id of the job to cancel.')
    const answer = loop ? await cancelLoop({ now }, book, loop) : await book.cancel(e.id)
    await publish()
    return { result: answer }
  }
  if (typeof e.id === 'number') return readJob(book, loop, e.id)
  return { result: allJobs(loops, book.jobs(), now) }
}
