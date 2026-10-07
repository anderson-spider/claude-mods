import type { Job, JobDeps, Request } from './model'
import { jobMessage, jobsReport } from './presentation'

export function createJobs() {
  const jobs: Job[] = []
  let nextJob = 1

  // Queues `request` as a background job; a message arrives when it ends.
  function start({ perform, notifications }: JobDeps, request: Request, timeoutMs: number): Job {
    const job: Job = { id: nextJob++, kind: request.kind, prompt: request.input.prompt, status: 'queued', startedAt: Date.now() }
    jobs.push(job)
    void (async () => {
      const outcome = await perform(request, timeoutMs, () => {
        job.status = 'running'
      })
      job.status = outcome.ok ? 'done' : 'failed'
      job.endedAt = Date.now()
      job.chatUrl = outcome.chatUrl
      job.paths = outcome.paths
      notifications.toast(`ChatGPT job #${job.id} ${job.status}`)
      // A submitted prompt carries text only, so the previews stay behind.
      await notifications.submit(jobMessage(job, outcome)).catch(() => undefined)
    })()
    return job
  }

  return { start, report: () => jobsReport(jobs, Date.now()) }
}
