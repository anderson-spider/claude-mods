import { isChatUrl } from './tab'
import { FLOWS } from './flows'
import { readAttachments } from './input'
import type { AskOptions, BackgroundStart, Job, JobDeps, Outcome, Request, RequestDeps, RequestRunner } from './model'
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

  // Queues `request` as a background job (the list is lost on a reload); a message arrives when it ends.
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
      // A submitted prompt is a new turn that reaches the model like the person's words: send only the
      // automated notice, with paths and the chat link, never the answer (unverified ChatGPT output).
      await notifications.submit(jobMessage(job, outcome)).catch(() => undefined)
    })()
    return job
  }

  return { start, report: () => jobsReport(jobs, Date.now()) }
}

// Request execution

export async function performRequest(deps: RequestDeps, request: Request, options: AskOptions): Promise<Outcome> {
  // Attachments are checked before a browser is opened, so an invalid path opens nothing.
  const files = await readAttachments(deps.attachments, request.filePaths)
  if (typeof files === 'string') return { ok: false, text: files, error: files }
  const browser = await deps.browser()
  if (typeof browser === 'string') return { ok: false, text: browser, error: browser }
  const input = { ...request.input, files }
  // The row runs the flow and saves its result; the row's save takes the result its run gives (see FLOWS).
  const flow = FLOWS[request.kind]
  const result = await flow.run(browser, input, options)
  // A page nobody can clear in this backend held the run before anything was sent: the request moves on, once.
  if (result.ok || !result.held) return await flow.save(deps.output, result as never, request)
  options.progress?.(`ChatGPT is not ready in ${browser.name}; trying the other browsers`)
  const next = await deps.browser(browser.name)
  if (typeof next === 'string') {
    const text = `${result.error}\nThe other browsers: ${next}`
    return { ok: false, text, error: text, chatUrl: result.url }
  }
  const outcome = await flow.save(deps.output, (await flow.run(next, input, options)) as never, request)
  const at = result.url ? ` (at ${result.url})` : ''
  const note = `Note: ChatGPT was not ready in ${browser.name}${at}, so this request ran in ${next.name}; /chatgpt-doctor shows what holds it.`
  return { ...outcome, text: `${note}\n${outcome.text}`, note }
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
