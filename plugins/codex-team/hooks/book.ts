import { agentName, nextFreeId } from './names'
import { runJob, type JobOptions } from './job'
import { waitForStop } from './stopping'
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
// Esc ends the Codex turn but keeps its background terminals (openai/codex#14602); /stop ends them once the turn has settled.
const STOP_WAIT_MS = 15_000

/** The jobs of this session: ids, the execute queue, cancel and the lists the person and Claude read. */
export function createBook(deps: Deps) {
  const jobs: Job[] = []
  const queue = taskQueue()
  const completions = new Map<number, Promise<Job>>()
  const resolve = new Map<number, (job: Job) => void>()
  const runs = new Map<number, Promise<void>>()
  const running = new Set<number>()
  // A cancelled run waits for its /stop, so a loop closes the pane and frees the slot only after it.
  const stops = new Map<number, Promise<void>>()
  let counter = 1

  /** Ends the background commands of a cancelled agent once its turn settles; a failure is noted on the job, never thrown. */
  const stopBackground = async (job: Job): Promise<void> => {
    try {
      await deps.herdr.wait(job.agent, STOP_WAIT_MS, ['idle', 'done', 'blocked'])
      await deps.herdr.submit(job.agent, '/stop')
    } catch (error) {
      const text = `Could not send /stop to end its background commands: ${error instanceof Error ? error.message : String(error)}`
      job.error = job.error ? `${job.error}\n${text}` : text
    }
  }

  const live = async () => (await deps.herdr.list().catch(() => [])).map(agent => agent.name)
  const reserveId = async () => {
    const names = await live()
    const id = nextFreeId(counter, names)
    counter = id + 1
    return id
  }

  return {
    /** Registers the job and starts it (an execute one after the others); answers at once. */
    async start(request: Request, options: JobOptions & { quiet?: boolean; owned?: boolean; notify?: Notify } = {}): Promise<Job> {
      const id = await reserveId()
      const job: Job = { id, kind: request.kind, title: kinds[request.kind].title(request), status: 'queued', agent: options.session?.agent ?? agentName(id), startedAt: deps.now() }
      jobs.push(job)
      completions.set(id, new Promise<Job>(done => resolve.set(id, done)))
      const run = async () => {
        running.add(id)
        const cancelled = () => job.status === 'cancelled'
        try {
          if (!cancelled()) {
            const notify: Notify = (event, job) => {
              if (!options.quiet || event === 'blocked') (options.notify ?? deps.notify)(event, job)
            }
            await runJob({ ...deps, notify }, job, request, { ...options, freshReport: options.freshReport ?? options.quiet })
            if (cancelled() && options.session?.active) await waitForStop(deps.herdr, options.session)
          }
          await stops.get(id)
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
      // Only an agent that got its task can have started background commands.
      const prompted = job.status === 'working' || job.status === 'blocked' || job.status === 'cancelled'
      // Record the cancel before sending keys: the agent may still be registering.
      job.status = 'cancelled'
      job.endedAt = deps.now()
      let release = () => {}
      stops.set(id, new Promise<void>(done => (release = done)))
      try {
        await deps.herdr.sendKeys(job.agent, ['esc'])
      } catch (error) {
        release()
        return `Could not send Esc to ${job.agent} (pane ${job.pane}): ${error instanceof Error ? error.message : String(error)}`
      } finally {
        resolve.get(id)?.(job)
        resolve.delete(id)
      }
      // The answer does not wait for /stop; the run does, before it frees the pane and the execute slot.
      if (!prompted) {
        release()
        return `Sent Esc to ${job.agent} (pane ${job.pane}) and marked it cancelled; ${job.agent === agentName(job.id) ? 'the pane stays open' : 'the loop closes its panes after the agents stop'}.`
      }
      void stopBackground(job).finally(release)
      return `Sent Esc to ${job.agent} (pane ${job.pane}) and marked it cancelled; /stop follows once it settles, to end its background commands; ${job.agent === agentName(job.id) ? 'the pane stays open' : 'the loop closes its panes after the agents stop'}.`
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
