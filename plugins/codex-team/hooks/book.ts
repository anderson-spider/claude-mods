import { agentName, nextFreeId } from './names'
import { runJob } from './job'
import type { Deps, Job, Kind, Notify, Request, Status } from './model'

/** Runs `task` after the ones queued before it: execute jobs share the working directory, so they take turns. */
function taskQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return task => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}

const kinds: Record<Kind, { title: (request: Request) => string; queued: boolean }> = {
  execute: { title: request => request.task, queued: true },
  review: { title: request => `review of ${request.target ?? 'the current diff'}`, queued: false },
}

const FINISHED: Status[] = ['done', 'failed', 'cancelled']

/** The jobs of this session: ids, the execute queue, cancel and the lists the person and Claude read. */
export function createBook(deps: Deps) {
  const jobs: Job[] = []
  const queue = taskQueue()
  const completions = new Map<number, Promise<Job>>()
  const resolve = new Map<number, (job: Job) => void>()
  const runs = new Map<number, Promise<void>>()
  const running = new Set<number>()
  let counter = 1

  const live = async () => (await deps.herdr.list().catch(() => [])).map(agent => agent.name)
  const reserveId = async () => {
    const names = await live()
    const id = nextFreeId(counter, names)
    counter = id + 1
    return id
  }

  return {
    /** Registers the job and starts it (an execute one after the others); answers at once. */
    async start(request: Request, options: { quiet?: boolean; owned?: boolean } = {}): Promise<Job> {
      const id = await reserveId()
      const job: Job = { id, kind: request.kind, title: kinds[request.kind].title(request), status: 'queued', agent: agentName(id), startedAt: deps.now() }
      jobs.push(job)
      completions.set(id, new Promise<Job>(done => resolve.set(id, done)))
      const run = async () => {
        running.add(id)
        try {
          if (job.status !== 'cancelled') {
            const notify: Notify = (event, job) => {
              if (!options.quiet || event === 'blocked') deps.notify(event, job)
            }
            await runJob({ ...deps, notify }, job, request, { freshReport: options.quiet })
          }
        } finally {
          running.delete(id)
          resolve.get(id)?.(job)
          resolve.delete(id)
        }
      }
      runs.set(id, kinds[request.kind].queued && !options.owned ? queue(run) : run())
      return job
    },

    reserveId,
    exclusive: queue,
    done: (id: number): Promise<Job> => completions.get(id) ?? Promise.reject(new Error(`No job ${agentName(id)} in this session.`)),
    /** Unlike done, waits for the run to return even when the job is cancelled. */
    ended: (id: number): Promise<void> => runs.get(id) ?? Promise.reject(new Error(`No job ${agentName(id)} in this session.`)),

    async cancel(id: number): Promise<string> {
      const job = jobs.find(j => j.id === id)
      if (!job) return `No job ${agentName(id)} in this session.`
      if (FINISHED.includes(job.status) && !(job.status === 'cancelled' && running.has(id))) return `${job.agent} is ${job.status}: nothing to cancel.`
      if (job.status === 'queued' || !job.pane) {
        job.status = 'cancelled'
        job.endedAt = deps.now()
        resolve.get(id)?.(job)
        resolve.delete(id)
        return `${job.agent} had not started and is now cancelled.`
      }
      // Record the cancel before sending keys: the agent may still be registering.
      job.status = 'cancelled'
      job.endedAt = deps.now()
      try {
        await deps.herdr.sendKeys(job.agent, ['ctrl+c'])
      } catch (error) {
        return `Could not send ctrl+c to ${job.agent} (pane ${job.pane}): ${error instanceof Error ? error.message : String(error)}`
      } finally {
        resolve.get(id)?.(job)
        resolve.delete(id)
      }
      return `Sent ctrl+c to ${job.agent} (pane ${job.pane}) and marked it cancelled; the pane stays open.`
    },

    jobs: (): readonly Job[] => jobs,
    get: (id: number) => jobs.find(j => j.id === id),

    /** Live `ct-*` agents that no job of this session owns (left by a reload). */
    async orphans() {
      const owned = new Set(jobs.map(j => j.agent))
      return (await deps.herdr.list().catch(() => [])).filter(agent => !owned.has(agent.name))
    },
  }
}
