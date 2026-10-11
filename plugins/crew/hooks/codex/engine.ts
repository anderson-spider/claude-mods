// The Codex engine: starts jobs as detached workers, follows them with one shared poller, keeps the job list, writes
// the cards, delivers the end notices and answers the three tools. Host access is injected (`CodexHost`, built from a
// hook's `$` in register.tsx), never `$` itself.
//
// A job outlives the hook that started it, so the poller, the card writes and the notices run on after that hook
// returned, on the newest host a crew hook handed in (`useHost`): every Codex hook and the main loop's `turn.step`
// hand theirs. A poll that keeps failing waits for the next host; a card or notice that fails waits for the next flush.
import type { AgentCard } from '../../types'
import { createJsonlReader } from './events'
import { buildArgv } from './argv'
import { codexCard, createThrottle, upsertCard } from './card'
import { createJobs } from './jobs'
import type { CallBase, Job, Reply, SpawnChunk, SpawnEnd, Spawned } from './jobs'
import { CODEX_LANES, isCodexRole, isWriteRole, outputName } from './roles'
import type { CodexRole } from './types'
import {
  FOREGROUND_MS, IDLE_POLL_MS, JOB_DIR, POLL_BYTES, POLL_MS, RECENT_JOBS, cardJob, codexRolePrompt, dirname, exitEnd,
  isActive, isInside, jobOfRecord, jobPaths, lostEnd, newJobId, noteActivity, noticeText, parseExit, parsePid, parsePoll,
  parseRecord, pollArgv, recordCut, recordOf, resultOf, RESULT_MAX, summaryOf, takeLines, utf8Length, waitArgv, workerArgv,
} from './worker'
import type { JobExtra, JobPaths, JobRecord, JobSummary, PollReport } from './worker'

export type RunResult = { exitCode: number; stdout: string; stderr: string }

/** What the engine needs from the host; register.tsx builds it from a hook's `$`. */
export type CodexHost = {
  run(argv: string[], init?: { cwd?: string; stdin?: string; timeoutMs?: number }): Promise<RunResult>
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  /** File names in a folder. */
  list(path: string): Promise<string[]>
  /** Where the path lands, every link followed; undefined when it leads nowhere. */
  realPath(path: string): Promise<string | undefined>
  /** The session's working directory. */
  cwd(): Promise<string>
  /** The Claude session's id, which owns the jobs it starts. */
  sessionId(): Promise<string>
  /** A wait that does not use up a hook's clock budget (a host process). */
  sleep(ms: number): Promise<void>
  /** One debug log line. */
  log(text: string): void
  /** One short transcript line for the person: only a job id, role and status. */
  note(text: string): void
  /** A prompt for the lead: only a job id, role and status, never Codex's output. */
  submit(text: string): Promise<unknown>
  /** Writes the dashboard's cards. */
  writeCards(change: (cards: AgentCard[]) => AgentCard[]): Promise<unknown>
  /** Writes the `codexJobs` atom. */
  writeJobs(jobs: JobSummary[]): Promise<unknown>
}

export type CodexInput = {
  agent?: unknown
  prompt?: unknown
  description?: unknown
  cwd?: unknown
  background?: unknown
  resume?: unknown
}

type Call = CallBase & { agent: CodexRole; rolePrompt: string; output?: string; skipGitCheck: boolean }

export type EngineOptions = {
  /** The role prompts (SPECIALISTS), sent as `developer_instructions`. */
  prompts: Readonly<Record<string, string>>
  /** Per-role model from the `codexModels` option. */
  models: Partial<Record<CodexRole, string>>
  now: () => number
  random: () => number
  foregroundMs?: number
}

/** A tool's answer: text for the model, and whether it is an error. */
export type Answer = { text: string; isError: boolean }

const ok = (value: unknown): Answer => ({ text: JSON.stringify(value, null, 2), isError: false })
const fail = (text: string): Answer => ({ text, isError: true })
/** A call aborted before its job was created: nothing ran. */
const notStarted = (): Answer => ok({ status: 'cancelled', note: 'The call was cancelled before a job started; nothing ran.' })
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const trimLine = (text: string) => text.trim().split('\n')[0] ?? ''
/** A relative cwd is the session's, not the host process's: every check runs on the joined path. */
const against = (base: string, path: string) => (path.startsWith('/') ? path : `${base.replace(/\/+$/, '')}/${path}`)

/** Text chunks handed to jobs.ts as a spawn's `lines`, pushed by the poller. */
function createQueue() {
  const items: (string | SpawnChunk)[] = []
  let done = false
  let wake: (() => void) | undefined
  const iterator: AsyncIterator<string | SpawnChunk> = {
    async next() {
      while (!items.length && !done) await new Promise<void>(resolve => { wake = resolve })
      wake = undefined
      const value = items.shift()
      return value === undefined ? { value: undefined, done: true } : { value, done: false }
    },
    async return() {
      done = true
      items.length = 0
      wake?.()
      return { value: undefined, done: true }
    },
  }
  return {
    push(item: string | SpawnChunk) { items.push(item); wake?.() },
    end() { done = true; wake?.() },
    lines: { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<string | SpawnChunk>,
  }
}

/** A running job the poller follows. */
type Watch = {
  id: string
  paths: JobPaths
  /** Bytes of the JSONL already handed on. */
  offset: number
  /** Polls in a row that found Codex gone with no exit code. */
  dead: number
  push: (item: string | SpawnChunk) => void
  end: (how: SpawnEnd) => void
}

type Notice = { text: string; noted: boolean; sending: boolean }

export function createCodexEngine(options: EngineOptions) {
  const foregroundMs = options.foregroundMs ?? FOREGROUND_MS

  // --- the host: the newest one wins ---
  let host: CodexHost | undefined
  let hostWaiters: (() => void)[] = []
  const current = (): CodexHost => {
    if (!host) throw new Error('crew codex: no host yet')
    return host
  }
  const nextHost = () => new Promise<void>(resolve => { hostWaiters.push(resolve) })

  // --- state ---
  type Base = { sessionCwd: string; root?: string; outBase: string; dir: string; owner: string }
  type Jobs = ReturnType<typeof createJobs<Call>>
  let base: Promise<Base> | undefined
  let loaded: Promise<Jobs> | undefined
  let jobsRef: Jobs | undefined
  const extras = new Map<string, JobExtra>()
  const persisted = new Map<string, string>()
  const writes = new Map<string, Promise<void>>()
  const carded = new Map<string, string>()
  const throttle = createThrottle(1000)
  const pendingCards = new Map<string, AgentCard>()
  const notices: Notice[] = []
  const watches = new Map<string, Watch>()
  /** The foreground timers of jobs.ts, fired by the call that holds the job (`hold`). */
  const timers = new Map<string, () => void>()
  /** Codex sessions a resume has taken, from its check to its job being listed. */
  const resuming = new Set<string>()
  const interrupts = new Map<string, Promise<string | undefined>>()
  /** Jobs of another Claude session whose Codex was gone, followed here only to settle them: no card, no notice. */
  const adopted = new Set<string>()
  const claims = new Map<string, Promise<void>>()
  /** Whole answers (up to RESULT_MAX) re-read from the JSONL of jobs whose record kept a cut one. */
  const wholeAnswers = new Map<string, string>()
  let summaryKey = ''
  let jobsDirty = false
  let lastJobs: Job[] = []
  let flushing: Promise<void> = Promise.resolve()
  let flushFailed = false
  let holds = 0

  async function gitRoot(cwd: string, h: CodexHost): Promise<string | undefined> {
    const out = await h.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 10_000 }).catch(() => undefined)
    const top = out && out.exitCode === 0 ? trimLine(out.stdout) : ''
    return top ? ((await h.realPath(top)) ?? top) : undefined
  }

  function baseOf(): Promise<Base> {
    base ??= (async () => {
      const h = current()
      const cwd = await h.cwd()
      const sessionCwd = (await h.realPath(cwd)) ?? cwd
      const root = await gitRoot(sessionCwd, h)
      const outBase = root ?? sessionCwd
      const owner = await h.sessionId().catch(() => '')
      return { sessionCwd, root, outBase, dir: `${outBase}/${JOB_DIR}`, owner }
    })()
    base.catch(() => { base = undefined })
    return base
  }

  function extraOf(job: Job): JobExtra {
    let extra = extras.get(job.id)
    if (!extra) extras.set(job.id, (extra = { description: job.description ?? '', activity: [] }))
    return extra
  }

  const recordKey = (job: Pick<Job, 'status' | 'sessionId'>, extra: Pick<JobExtra, 'pid' | 'cancelRequested'>) =>
    `${job.status}|${job.sessionId ?? ''}|${extra.pid ?? ''}|${extra.cancelRequested ? 1 : 0}`
  const cardKey = (job: Job) =>
    `${job.status}|${job.lastActivity ?? ''}|${job.tokens?.output ?? ''}|${job.endedAt ?? ''}|${job.result?.length ?? ''}`
  const listKey = (jobs: readonly Job[]) => jobs.map(job => `${job.id}:${job.status}:${job.sessionId ?? ''}`).join(',')

  /** Writes the job's record when its status, session, pid or cancel changed; one write at a time per job, in order. */
  function persist(dir: string, job: Job): Promise<void> {
    const extra = extraOf(job)
    if (extra.foreign) return Promise.resolve()
    const key = recordKey(job, extra)
    if (persisted.get(job.id) === key) return writes.get(job.id) ?? Promise.resolve()
    persisted.set(job.id, key)
    const text = `${JSON.stringify(recordOf(job, extra))}\n`
    const write = (writes.get(job.id) ?? Promise.resolve()).then(async () => {
      try {
        await current().write(jobPaths(dir, job.id).json, text)
      } catch (error) {
        if (persisted.get(job.id) === key) persisted.delete(job.id)
        current().log(`crew codex: job ${job.id} record not written (${errorText(error)})`)
      }
    })
    writes.set(job.id, write)
    return write
  }

  /** Hands the pending notices on: a transcript line for the person, a prompt for the lead; a failure is retried. */
  function deliverNotices() {
    for (const notice of notices) {
      if (notice.sending) continue
      try {
        const h = current()
        if (!notice.noted) {
          h.note(notice.text)
          notice.noted = true
        }
        notice.sending = true
        // Not awaited: a prompt submitted inside a turn settles only once that turn ends.
        void h.submit(notice.text).then(
          () => { const at = notices.indexOf(notice); if (at >= 0) notices.splice(at, 1) },
          error => { notice.sending = false; host?.log(`crew codex: end notice not sent, retried on the next step (${errorText(error)})`) },
        )
      } catch (error) {
        notice.sending = false
        host?.log(`crew codex: end notice not sent, retried on the next step (${errorText(error)})`)
      }
    }
  }

  /** Writes the pending cards and the job list and sends the notices; a failure keeps them for the next flush. */
  function flush(): Promise<void> {
    flushing = flushing.then(async () => {
      if (!host) return
      deliverNotices()
      if (!pendingCards.size && !jobsDirty) return
      const cards = [...pendingCards.values()]
      pendingCards.clear()
      const dirty = jobsDirty
      jobsDirty = false
      try {
        if (cards.length) await current().writeCards(list => cards.reduce<AgentCard[]>((acc, card) => upsertCard(acc, card), list))
        if (dirty) await current().writeJobs(lastJobs.map(job => summaryOf(job, extras.get(job.id))))
        flushFailed = false
      } catch (error) {
        for (const card of cards) if (!pendingCards.has(card.id)) pendingCards.set(card.id, card)
        jobsDirty ||= dirty
        if (!flushFailed) current().log(`crew codex: panel write failed, retried on the next step (${errorText(error)})`)
        flushFailed = true
      }
    })
    return flushing
  }

  function onChange(dir: string, jobs: Job[]) {
    lastJobs = jobs
    // The list is written only when a job's status or session moved, not on every event.
    const key = listKey(jobs)
    if (key !== summaryKey) { summaryKey = key; jobsDirty = true }
    const now = options.now()
    for (const job of jobs) {
      const extra = extraOf(job)
      if (extra.foreign) continue
      void persist(dir, job)
      if (adopted.has(job.id)) continue
      // Only a job that moved: an ended job read back on load is listed, not drawn again.
      if (carded.get(job.id) === cardKey(job)) continue
      noteActivity(extra, job.lastActivity)
      offerCard(job, extra, now)
    }
    void flush()
  }

  /** Queues the job's card unless it is drawn as it stands or the throttle holds it (then a later poll offers it). */
  function offerCard(job: Job, extra: JobExtra, now: number): boolean {
    const card = cardKey(job)
    if (carded.get(job.id) === card) return false
    if (!throttle.allow(job.id, job.status, now)) return false
    carded.set(job.id, card)
    pendingCards.set(job.id, codexCard(cardJob(job, extra), now))
    return true
  }

  /** The trailing write: a card the throttle held is offered again on each poll, so it ends on the latest activity. */
  function offerHeldCards() {
    const now = options.now()
    let offered = false
    for (const job of lastJobs) {
      const extra = extras.get(job.id)
      if (!extra || extra.foreign || adopted.has(job.id) || !isActive(job.status)) continue
      offered = offerCard(job, extra, now) || offered
    }
    if (offered) void flush()
  }

  function notify(jobsText: string) {
    // jobs.ts names the job; the notice is rebuilt from checked parts only.
    const id = /Codex job (\S+) /.exec(jobsText)?.[1] ?? ''
    const job = jobsRef?.get(id)
    const text = job && !adopted.has(job.id) && noticeText(job.id, job.agent, job.status)
    if (!text) return
    notices.push({ text, noted: false, sending: false })
    void flush()
  }

  // --- the poller: one process per tick for every running job ---

  let polling = false
  let kick = false

  function poll() {
    kick = true
    if (!polling) void pollLoop()
  }

  async function pollLoop() {
    polling = true
    let failures = 0
    try {
      while (watches.size) {
        const sleepMs = kick ? 0 : holds > 0 ? POLL_MS : IDLE_POLL_MS
        kick = false
        const list = [...watches.values()]
        const marker = `@@crew-codex-${Math.floor(options.random() * 36 ** 8).toString(36)}@@`
        const cap = Math.max(64 * 1024, Math.floor(POLL_BYTES / list.length))
        const pids = list.flatMap(w => { const pid = extras.get(w.id)?.pid; return pid === undefined ? [] : [pid] })
        let report: PollReport
        try {
          const out = await current().run(pollArgv(list, { sleepMs, marker, cap, pids }), { timeoutMs: sleepMs + 30_000 })
          report = parsePoll(out.stdout, marker)
          failures = 0
        } catch (error) {
          failures++
          if (failures === 1) host?.log(`crew codex: poll failed (${errorText(error)})`)
          // The host the poller ran on may be gone: wait for the next hook's.
          if (failures >= 3) { failures = 0; await nextHost() }
          continue
        }
        for (const watch of list) {
          try { await settle(watch, report, cap) } catch (error) { host?.log(`crew codex: job ${watch.id} not read (${errorText(error)})`) }
        }
        offerHeldCards()
      }
    } finally {
      polling = false
    }
  }

  async function settle(watch: Watch, report: PollReport, cap: number) {
    const entry = report.jobs.get(watch.id)
    if (!entry) return
    const extra = extras.get(watch.id)
    if (extra && extra.pid === undefined) extra.pid = parsePid(entry.pid)
    const code = parseExit(entry.exit)
    if (code !== undefined && entry.size - watch.offset <= cap) {
      // Codex has ended and everything it wrote is here: the last line may lack its newline.
      if (entry.chunk) watch.push(entry.chunk)
      watch.offset = entry.size
      const err = await current().read(watch.paths.err).catch(() => '')
      if (err.trim()) watch.push({ stream: 'stderr', text: err.slice(-8000) })
      watch.end(exitEnd(code, extra?.cancelRequested === true))
      return
    }
    const { chunk } = takeLines(entry.chunk, 0)
    if (chunk) {
      watch.push(chunk)
      watch.offset += utf8Length(chunk)
    }
    if (code !== undefined || !report.complete) return
    const alive = extra?.pid !== undefined && report.alive?.has(extra.pid) === true
    watch.dead = alive ? 0 : watch.dead + 1
    // Codex is gone and, three polls later, still no exit code: the worker shell died with it.
    if (watch.dead >= 3) watch.end(lostEnd(extra?.cancelRequested === true))
  }

  /** Follows a worker's files through the poller: `lines` and `exit` for jobs.ts, `cancel` sends SIGINT once. */
  function follow(dir: string, id: string): Spawned {
    const queue = createQueue()
    let resolveExit!: (end: SpawnEnd) => void
    const exit = new Promise<SpawnEnd>(resolve => { resolveExit = resolve })
    watches.set(id, {
      id, paths: jobPaths(dir, id), offset: 0, dead: 0,
      push: queue.push,
      end: how => {
        watches.delete(id)
        resolveExit(how)
        queue.end()
      },
    })
    poll()
    return { lines: queue.lines, exit, cancel: () => { void interrupt(dir, id) } }
  }

  /** Sends SIGINT to the job's Codex once; resolves with why it could not, or undefined. */
  function interrupt(dir: string, id: string): Promise<string | undefined> {
    const known = interrupts.get(id)
    if (known) return known
    const sent = (async () => {
      const extra = extras.get(id)
      const job = jobsRef?.get(id)
      if (!extra || !job) return 'unknown job'
      extra.cancelRequested = true
      await persist(dir, job)
      const h = current()
      const pid = extra.pid ?? parsePid(await h.read(jobPaths(dir, id).pid).catch(() => ''))
      if (pid === undefined) return 'Codex has not recorded its pid yet'
      // The pid file lives in the job's writable workspace: signal it only while ps names it a running `codex exec`.
      const seen = await checkCodex(h, dir, id, pid)
      if (seen === 'ended') { poll(); return undefined }
      if (seen !== 'alive') return `pid ${pid} is not a running codex exec (${seen})`
      const out = await h.run(['kill', '-INT', String(pid)], { timeoutMs: 5000 })
      if (out.exitCode !== 0) return `kill -INT ${pid} failed: ${trimLine(out.stderr) || `exit ${out.exitCode}`}`
      poll()
      return undefined
    })().catch(error => errorText(error))
    void sent.then(reason => {
      const extra = extras.get(id)
      if (!reason || !extra) return
      extra.cancelError = reason
      host?.log(`crew codex: cancel of ${id} failed (${reason})`)
    })
    interrupts.set(id, sent)
    return sent
  }

  /**
   * One read-only look at a job's Codex, on host `h`: `ended` when its exit file is there, `alive` when `ps` names
   * `pid` a `codex exec`, else `gone`; `unknown` when the look itself failed.
   */
  async function checkCodex(h: CodexHost, dir: string, id: string, pid: number | undefined): Promise<'ended' | 'alive' | 'gone' | 'unknown'> {
    const marker = `@@crew-codex-${Math.floor(options.random() * 36 ** 8).toString(36)}@@`
    const target = { id, paths: jobPaths(dir, id), offset: 0 }
    const out = await h.run(pollArgv([target], { sleepMs: 0, marker, cap: 0, pids: pid === undefined ? [] : [pid] }), { timeoutMs: 30_000 })
      .catch(() => undefined)
    const report = out && parsePoll(out.stdout, marker)
    const entry = report?.jobs.get(id)
    if (!report?.complete || !entry) return 'unknown'
    if (parseExit(entry.exit) !== undefined) return 'ended'
    return pid !== undefined && report.alive?.has(pid) ? 'alive' : 'gone'
  }

  /**
   * A running job of another Claude session, looked at on demand: while its Codex runs it stays listed read-only;
   * once Codex has ended or is gone it is followed here from its files until it settles (done, error, cancelled or
   * lost), with no card and no notice, so codex_result and resume work on it. Waits about 3 s at most.
   */
  function claimForeign(id: string): Promise<void> {
    const known = claims.get(id)
    if (known) return known
    const claim = (async () => {
      const extra = extras.get(id)
      const jobs = jobsRef
      const job = jobs?.get(id)
      if (!extra?.foreign || !jobs || !job || !isActive(job.status)) return
      const { dir } = await baseOf()
      const h = current()
      const pid = extra.pid ?? parsePid(await h.read(jobPaths(dir, id).pid).catch(() => ''))
      const seen = await checkCodex(h, dir, id, pid)
      if (seen === 'alive' || seen === 'unknown') return
      delete extra.foreign
      if (pid !== undefined) extra.pid = pid
      adopted.add(id)
      const call: Call = {
        agent: job.agent, prompt: '', cwd: job.cwd, model: job.model, rolePrompt: '', skipGitCheck: false,
        ...(job.sessionId ? { resumeSessionId: job.sessionId } : {}),
      }
      void jobs.run(call, {
        foregroundMs, background: true, description: extra.description, id, startedAt: job.startedAt, gracefulCancel: true,
        spawn: () => follow(dir, id),
      })
      for (let i = 0; i < 12 && isActive(jobs.get(id)?.status ?? 'done'); i++) {
        poll()
        await h.sleep(250).catch(() => {})
      }
    })().catch(error => { host?.log(`crew codex: job ${id} of another session not read (${errorText(error)})`) })
      .finally(() => { claims.delete(id) })
    claims.set(id, claim)
    return claim
  }

  /** Starts a new worker for job `id`, then follows it. */
  function startWorker(dir: string, id: string, own: CodexHost) {
    return async ({ argv, cwd, input }: { argv: string[]; cwd: string; input: string }): Promise<Spawned> => {
      const out = await own.run(workerArgv(jobPaths(dir, id), argv), { cwd, stdin: input, timeoutMs: 20_000 })
      const pid = parsePid(out.stdout)
      if (out.exitCode !== 0 || pid === undefined) {
        throw new Error(`the Codex worker did not start (exit ${out.exitCode}${out.stderr.trim() ? `: ${trimLine(out.stderr)}` : ''})`)
      }
      const extra = extras.get(id)
      if (extra) extra.pid = pid
      const job = jobsRef?.get(id)
      if (job) await persist(dir, job)
      return follow(dir, id)
    }
  }

  /**
   * Holds a foreground call while its job runs, on the call's own host: a wait process that ends when the job's exit
   * file appears (or at the foreground limit, which sends the job to the background), so the hook's budget never runs
   * while it waits and the call returns as soon as the job ends.
   */
  async function hold(own: CodexHost, dir: string, id: string, startedAt: number, reply: Promise<Reply>, signal?: AbortSignal) {
    let settled = false
    const done = reply.then(() => { settled = true }, () => { settled = true })
    // Esc: jobs.ts asks Codex to stop (its own abort listener); the call returns at once with the job in the background.
    let onAbort: (() => void) | undefined
    const aborted = new Promise<'aborted'>(resolve => {
      onAbort = () => resolve('aborted')
      if (signal?.aborted) resolve('aborted')
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
    holds++
    try {
      while (!settled) {
        const left = startedAt + foregroundMs - options.now()
        const waited = left <= 0 ? 'timeout' : await Promise.race([
          own.run(waitArgv(jobPaths(dir, id).exit, left), { timeoutMs: left + 10_000 }).then(
            out => (out.exitCode === 0 ? 'ended' : 'timeout'),
            () => 'timeout',
          ),
          done.then(() => 'settled'),
          aborted,
        ])
        if (settled || waited === 'settled') break
        if (waited === 'timeout' || waited === 'aborted') {
          timers.get(id)?.()
          timers.delete(id)
          break
        }
        // The exit file is there: the poller reads it at once.
        poll()
        await Promise.race([own.sleep(250).catch(() => {}), done, aborted])
      }
    } finally {
      holds--
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
  }

  // --- loading ---

  function jobsOf(dir: string, initial: Job[]): Jobs {
    const jobs = createJobs<Call>({
      spawn: () => { throw new Error('no worker') },
      clock: {
        now: () => options.now(),
        // The foreground timer belongs to the job's `hold`, which fires it at the limit.
        after: (_ms, fn, id) => {
          const key = id ?? `timer-${options.random()}`
          timers.set(key, fn)
          return { cancel: () => { timers.delete(key) } }
        },
      },
      codec: {
        buildArgv: call => buildArgv({
          role: call.agent, rolePrompt: call.rolePrompt, model: call.model, output: call.output,
          resume: call.resumeSessionId, approvals: true, skipGitCheck: call.skipGitCheck,
        }),
        createJsonlReader,
      },
      newId: () => newJobId(options.now(), options.random),
      onChange: list => onChange(dir, list),
      notify,
      initial,
    })
    jobsRef = jobs
    return jobs
  }

  async function readRecords(dir: string): Promise<JobRecord[]> {
    const names = await current().list(dir).catch(() => [] as string[])
    const files = names.filter(name => /^cx-[a-z0-9-]+\.json$/.test(name))
    const records: JobRecord[] = []
    for (const name of files) {
      const record = parseRecord(await current().read(`${dir}/${name}`).catch(() => ''))
      if (record && `${record.id}.json` === name) records.push(record)
    }
    return records.sort((a, b) => a.startedAt - b.startedAt).slice(-RECENT_JOBS)
  }

  /**
   * Rebuilds the job list from `<dir>/*.json`: an ended job is listed as it is; one this session started that was
   * running is followed again from its files (still running, ended while nobody watched, or `lost` with no live worker
   * and no exit code). A running job of another Claude session is listed read-only.
   */
  function load(): Promise<Jobs> {
    loaded ??= (async () => {
      const { dir, owner } = await baseOf()
      const records = await readRecords(dir).catch(() => [] as JobRecord[])
      const mine = (r: JobRecord) => owner !== '' && r.owner === owner
      const toFollow = records.filter(r => isActive(r.status) && mine(r))
      for (const r of records) {
        const foreign = isActive(r.status) && !mine(r)
        extras.set(r.id, {
          description: r.description, output: r.output, pid: r.pid, cancelRequested: r.cancelRequested, owner: r.owner,
          activity: [], ...(foreign ? { foreign } : {}),
        })
        if (!toFollow.includes(r)) {
          persisted.set(r.id, recordKey(r, r))
          carded.set(r.id, cardKey(jobOfRecord(r)))
        }
      }
      const jobs = jobsOf(dir, records.filter(r => !toFollow.includes(r)).map(jobOfRecord))
      summaryKey = listKey(jobs.list())
      for (const r of toFollow) {
        const call: Call = {
          agent: r.agent, prompt: '', cwd: r.cwd, model: r.model, rolePrompt: '', skipGitCheck: false,
          ...(r.sessionId ? { resumeSessionId: r.sessionId } : {}),
        }
        void jobs.run(call, {
          foregroundMs, background: true, description: r.description, id: r.id, startedAt: r.startedAt, gracefulCancel: true,
          spawn: () => follow(dir, r.id),
        })
      }
      if (toFollow.length) current().log(`crew codex: following ${toFollow.length} job(s) found running`)
      return jobs
    })()
    loaded.catch(() => { loaded = undefined })
    return loaded
  }

  // --- the tools ---

  /**
   * The `-o` reviews and findings go under `.crew/`: when git does not ignore `.crew` (the brainstorm skill never ran
   * here), `.crew/.gitignore` gets `*`. The project's own `.gitignore` is never edited, nor a `.crew/.gitignore` there.
   */
  async function ignoreCrew(own: CodexHost, base: string) {
    const checked = await own.run(['git', 'check-ignore', '-q', '.crew'], { cwd: base, timeoutMs: 10_000 }).catch(() => undefined)
    if (checked?.exitCode === 0) return
    const path = `${base}/.crew/.gitignore`
    if (await own.read(path).then(() => true, () => false)) return
    await own.write(path, '*\n').catch(error => own.log(`crew codex: ${path} not written (${errorText(error)})`))
  }

  /** Starts a job on `own`, the calling hook's host. */
  async function start(input: CodexInput, own: CodexHost, signal?: AbortSignal): Promise<Answer> {
    const { agent, prompt } = input
    if (!isCodexRole(agent)) return fail(`Unknown agent ${JSON.stringify(agent)}; use one of ${Object.keys(CODEX_LANES).join(', ')}.`)
    if (typeof prompt !== 'string' || !prompt.trim()) return fail('prompt is required.')
    const description = typeof input.description === 'string' ? input.description.trim().slice(0, 200) : ''
    const background = input.background === true
    if (signal?.aborted) return notStarted()
    const jobs = await load()
    const where = await baseOf()

    let cwd: string
    let reserved: string | undefined
    if (input.resume !== undefined) {
      if (typeof input.resume !== 'string') return fail('resume takes a job id.')
      await claimForeign(input.resume)
      if (extras.get(input.resume)?.foreign) return fail(`Job ${input.resume} belongs to another Claude session.`)
      const target = jobs.resumeTarget(input.resume)
      if ('error' in target) return fail(target.error)
      if (target.agent !== agent) return fail(`Job ${input.resume} ran ${target.agent}; resume it as ${target.agent}.`)
      // Taken at once, before any await: two resumes of one session never both pass the check.
      if (resuming.has(target.sessionId)) return fail(`The Codex session of job ${input.resume} is already being resumed.`)
      resuming.add(target.sessionId)
      reserved = target.sessionId
      cwd = target.cwd
    } else {
      const asked = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : where.sessionCwd
      const real = await own.realPath(against(where.sessionCwd, asked))
      if (real === undefined) return fail(`cwd ${asked} does not exist.`)
      cwd = real
    }
    try {
      if (typeof input.cwd === 'string' && reserved !== undefined) {
        const real = await own.realPath(against(where.sessionCwd, input.cwd.trim()))
        if (real !== cwd) return fail(`Job ${String(input.resume)} ran in ${cwd}; a resume keeps that directory.`)
      }

      // A write role writes only inside the session's repository, where git can undo it.
      if (isWriteRole(agent)) {
        if (!where.root) return fail(`${agent} runs on Codex only inside a git repository; this session is not in one.`)
        if (!isInside(where.root, cwd)) return fail(`${agent} may only run inside the repository ${where.root}; ${cwd} is outside it.`)
      }
      const skipGitCheck = !isWriteRole(agent) && (await gitRoot(cwd, own)) === undefined

      const id = newJobId(options.now(), options.random)
      const lane = CODEX_LANES[agent]
      // Codex writes `-o` outside the sandbox, so the path is always the lane's, under the repository, never the input's.
      const relative = lane.output ? lane.output(outputName(description, id)) : undefined
      const output = relative ? `${where.outBase}/${relative}` : undefined
      const made = await own.run(['mkdir', '-p', where.dir, ...(output ? [dirname(output)] : [])], { timeoutMs: 10_000 })
      if (made.exitCode !== 0) return fail(`Could not create ${where.dir}: ${trimLine(made.stderr)}`)
      // The folder ignores itself: the JSONL holds what the job read, and a later `git add -A` must not take it.
      await own.write(`${where.dir}/.gitignore`, '*\n').catch(error => own.log(`crew codex: .gitignore not written (${errorText(error)})`))
      if (output) await ignoreCrew(own, where.outBase)

      // Esc during the awaits above: no job, no record, no worker.
      if (signal?.aborted) return notStarted()
      extras.set(id, { description, output, owner: where.owner, activity: [] })
      const call: Call = {
        agent, prompt, cwd, model: options.models[agent],
        rolePrompt: codexRolePrompt(agent, options.prompts[agent] ?? '', relative), output, skipGitCheck,
        ...(reserved ? { resumeSessionId: reserved } : {}),
      }
      const startedAt = options.now()
      const pending = jobs.run(call, {
        foregroundMs, background, signal, description, id, startedAt, gracefulCancel: true,
        spawn: startWorker(where.dir, id, own),
      })
      // The job is listed with its session from here on (run pushes it before its first await), so the busy check holds.
      if (reserved) resuming.delete(reserved)
      reserved = undefined
      // The record is on disk before the call returns: a reload right after it still finds the job.
      await (writes.get(id) ?? Promise.resolve())
      if (!background) await hold(own, where.dir, id, startedAt, pending, signal)
      let reply: Reply
      try {
        reply = await pending
      } catch (error) {
        return fail(`Codex job ${id} did not start: ${errorText(error)}`)
      }
      const answer = resultOf(reply.job, extras.get(id))
      return reply.job.status === 'error' || reply.job.status === 'lost' ? { text: JSON.stringify(answer, null, 2), isError: true } : ok(answer)
    } finally {
      if (reserved) resuming.delete(reserved)
    }
  }

  /**
   * A job read back from its record after a reload holds an answer cut to RECORD_RESULT_MAX: its last message is
   * read again from the JSONL so codex_result keeps the RESULT_MAX cap. Falls back to the record's copy.
   */
  async function wholeAnswer(job: Job): Promise<string | undefined> {
    if (isActive(job.status) || !recordCut(job.result)) return undefined
    const known = wholeAnswers.get(job.id)
    if (known !== undefined) return known
    const { dir } = await baseOf()
    const text = await current().read(jobPaths(dir, job.id).jsonl).catch(() => undefined)
    if (text === undefined) return undefined
    const reader = createJsonlReader()
    let last: string | undefined
    for (const event of [...reader.push(text), ...reader.end()]) if (event.kind === 'message') last = event.text
    if (last === undefined) return undefined
    // One character past the cap keeps the cut visible to resultOf.
    const kept = last.slice(0, RESULT_MAX + 1)
    wholeAnswers.set(job.id, kept)
    if (wholeAnswers.size > RECENT_JOBS) wholeAnswers.delete(wholeAnswers.keys().next().value as string)
    return kept
  }

  async function result(jobId: unknown): Promise<Answer> {
    if (typeof jobId !== 'string') return fail('jobId is required.')
    const jobs = await load()
    if (!jobs.get(jobId)) return fail(`Unknown job ${jobId}.`)
    await claimForeign(jobId)
    const job = jobs.get(jobId)!
    return ok(resultOf(job, extras.get(jobId), await wholeAnswer(job)))
  }

  /** Asks Codex to stop; the job stays active (`cancelling`) until Codex has, then ends `cancelled`. */
  async function cancel(jobId: unknown): Promise<Answer> {
    if (typeof jobId !== 'string') return fail('jobId is required.')
    const jobs = await load()
    if (!jobs.get(jobId)) return fail(`Unknown job ${jobId}.`)
    await claimForeign(jobId)
    const job = jobs.get(jobId)!
    if (extras.get(jobId)?.foreign) return fail(`Job ${jobId} belongs to another Claude session and its Codex is still running; it is listed here read-only.`)
    if (!isActive(job.status)) return ok({ jobId, status: job.status, note: 'The job had already ended.' })
    // A SIGINT that could not be sent is tried again by the next cancel; one that was sent is never repeated.
    const extra = extras.get(jobId)
    const retry = extra?.cancelError !== undefined
    if (retry) { interrupts.delete(jobId); delete extra!.cancelError }
    const asked = jobs.cancel(jobId)
    // A job carries `error` too, so it is told apart by its id.
    if (!('id' in asked)) return fail(asked.error)
    const reason = await (retry ? interrupt((await baseOf()).dir, jobId) : interrupts.get(jobId))
    if (reason) return fail(JSON.stringify({ jobId, status: 'running', cancelling: true, error: `SIGINT not sent: ${reason}` }, null, 2))
    const now = jobs.get(jobId)
    if (now && !isActive(now.status)) return ok({ jobId, status: now.status })
    return ok({
      jobId, status: 'cancelling',
      note: 'SIGINT sent; the job ends as cancelled once Codex stops (codex_result shows it). Files it already changed stay changed.',
    })
  }

  return {
    /** Hands the engine the newest host; a poller waiting on a dead one goes on with it. */
    useHost(next: CodexHost) {
      host = next
      const waiters = hostWaiters
      hostWaiters = []
      for (const wake of waiters) wake()
    },
    load: async () => { await load() },
    start,
    result,
    cancel,
    flush,
    /** For tests and the panel: the jobs as listed now. */
    list: async () => (await load()).list(),
  }
}

export type CodexEngine = ReturnType<typeof createCodexEngine>
