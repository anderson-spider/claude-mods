import { ask } from './ask'
import { isChatUrl } from './browser'
import { generateImage } from './image'
import { readAttachments } from './input'
import type { AskOptions, BackgroundStart, Job, JobDeps, Outcome, Request, RequestDeps, RequestRunner } from './model'
import { saveAnswer, saveImages } from './output'
import { jobMessage, jobsReport } from './presentation'

// Request queue

/**
 * Runs `task` after the ones queued before it: requests share the plugin's
 * tab, so they take turns. `ahead` says how many wait in front.
 */
export function taskQueue(): <T>(task: () => Promise<T>, ahead?: (count: number) => void) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  let pending = 0
  return (task, ahead) => {
    ahead?.(pending)
    pending++
    const run = tail.then(task, task).finally(() => {
      pending--
    })
    tail = run.catch(() => undefined)
    return run
  }
}

// Background jobs

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
      // A submitted prompt is a new turn: send only the automated notice.
      await notifications.submit(jobMessage(job, outcome)).catch(() => undefined)
    })()
    return job
  }

  return { start, report: () => jobsReport(jobs, Date.now()) }
}

// Request execution

export async function performRequest(deps: RequestDeps, request: Request, options: AskOptions): Promise<Outcome> {
  const browser = await deps.browser()
  if (typeof browser === 'string') return { ok: false, text: browser, error: browser }
  const files = await readAttachments(deps.attachments, request.filePaths)
  if (typeof files === 'string') return { ok: false, text: files, error: files }
  const input = { ...request.input, files }
  if (request.kind === 'ask') return await saveAnswer(deps.output, await ask(browser, input, options), request)
  const result = await generateImage(browser, input, options)
  return await saveImages(deps.output, result, request)
}

// A foreground request; past its wait, a chat that is still going is saved in the background.
export async function runNow(perform: RequestRunner, startJob: BackgroundStart, request: Request, timeoutMs: number): Promise<Outcome> {
  const outcome = await perform(request, timeoutMs)
  if (!outcome.timedOut || !outcome.chatUrl || !isChatUrl(outcome.chatUrl)) return outcome
  const follow = startJob({
    ...request,
    filePaths: [],
    input: { prompt: request.input.prompt, chatUrl: outcome.chatUrl, saveOnly: true },
  })
  return {
    ...outcome,
    text: `${outcome.text}\nStill going: job #${follow.id} saves it in the background when it finishes; a message will arrive (the jobs tool shows it meanwhile).`,
  }
}
