// The detached worker of a Codex job and the files it leaves under `<repo>/.crew/codex/`. Pure: no host access.
//
// A job is `codex exec` started by `/bin/sh` through `nohup` (and `setsid` through perl when perl is there, so it is
// in a session of its own), with every fd redirected so the host's one-shot `process.run` returns at once. It writes:
//   <id>.jsonl  Codex's stdout (`--json`), tailed for progress and the outcome
//   <id>.err    Codex's stderr, read once at the end for diagnostics
//   <id>.pid    Codex's own pid (SIGINT goes there; the worker shell ignores it)
//   <id>.exit   Codex's exit code, written by the worker shell when Codex ends
//   <id>.json   the job record, written by the crew (`JobRecord`)
//   .gitignore  `*`, so the folder never reaches a commit (the JSONL holds what the job read)
// The prompt is written by the worker shell to `<id>.prompt` with umask 077, opened as Codex's stdin and removed
// before Codex starts, so it is never in argv and never left on disk (a worker that fails to start removes it too).
//
// One poller reads every running job per tick (`pollArgv`): new JSONL bytes from each job's offset, its exit code and
// pid files, and one batched `ps` for the pids.
import type { CodexJobSummary } from '../../types'
import { isThreadId } from './events'
import type { Tokens } from './events'
import type { Job, JobStatus, SpawnEnd } from './jobs'
import { isCodexRole } from './roles'
import type { CodexJob, CodexRole } from './types'

/** Where the job files live, relative to the repository (or the session's directory outside git). */
export const JOB_DIR = '.crew/codex'

/** How often running jobs are read: while a call waits in the foreground, and otherwise. */
export const POLL_MS = 500
export const IDLE_POLL_MS = 1500

/** How long a call waits in the foreground before the job goes on in the background. */
export const FOREGROUND_MS = 20_000

/** Records read back on load, the most recent first: older jobs stay on disk but are not listed. */
export const RECENT_JOBS = 50

/** The answer kept in a job record; the full one stays in the JSONL. */
export const RECORD_RESULT_MAX = 20_000

/** The answer a tool result carries. */
export const RESULT_MAX = 50_000

/** Activity lines kept per job for its card. */
export const ACTIVITY_KEEP = 8

/** What one poll reads at most, for all jobs together (the host keeps 4 MiB of a command's output). */
export const POLL_BYTES = 3 * 1024 * 1024

export type JobPaths = { json: string; jsonl: string; err: string; exit: string; pid: string; prompt: string }

export function jobPaths(dir: string, id: string): JobPaths {
  const base = `${dir}/${id}`
  return { json: `${base}.json`, jsonl: `${base}.jsonl`, err: `${base}.err`, exit: `${base}.exit`, pid: `${base}.pid`, prompt: `${base}.prompt` }
}

/** `cx-<time base36>-<random>`: lower case, digits and `-`, so it is a safe file name and output slug. */
export const JOB_ID = /^cx-[a-z0-9]{1,16}-[a-z0-9]{1,8}$/

export function newJobId(now: number, random: () => number): string {
  const tail = Math.floor(random() * 36 ** 5).toString(36).padStart(5, '0').slice(-5)
  return `cx-${Math.max(0, Math.floor(now)).toString(36)}-${tail}`
}

// The inner shell starts Codex in the background (its stdin the prompt file, opened then removed), records Codex's
// pid, waits for it and records its exit code. An asynchronous command in a non-interactive shell ignores SIGINT, but
// Codex installs its own handler (T0: `kill -INT` ends the turn and its children).
const INNER = [
  'p=$1; o=$2; e=$3; x=$4; f=$5; shift 5',
  // The outer shell gave up waiting: never start Codex late, untracked.
  '[ -e "$f.abandoned" ] && { rm -f "$p" "$f.abandoned"; exit 93; }',
  'exec 3<"$p" || exit 91',
  'rm -f "$p"',
  // A command put in the background by a shell without job control starts with SIGINT ignored, and an ignored signal
  // stays ignored across exec, so codex_cancel's SIGINT would never reach Codex. Perl (shipped with macOS) sets it back
  // to the default before it execs Codex; without perl Codex runs as it is and only a Codex that sets its own handler
  // can be cancelled. This text sits inside single quotes in OUTER, hence the double quotes and q().
  'command -v perl >/dev/null 2>&1 && set -- perl -e "\\$SIG{INT}=q(DEFAULT); exec @ARGV or exit 127" "$@"',
  '"$@" <&3 >"$o" 2>"$e" 3<&- &',
  'c=$!',
  'exec 3<&-',
  'echo "$c" >"$f.tmp" && mv "$f.tmp" "$f"',
  'wait "$c"',
  'echo "$?" >"$x.tmp" && mv "$x.tmp" "$x"',
].join('\n')

// The outer shell, run by `process.run` with the prompt on stdin: writes the prompt file, detaches the inner shell
// with every fd redirected (else `run` waits for the pipe), waits up to 10 s for Codex's pid and prints it. On every
// failure it removes the prompt file; on the time-out it also leaves a mark so a late inner shell does not start Codex.
const OUTER = [
  'p=$1; f=$5',
  'umask 077',
  'cat >"$p" || { rm -f "$p"; exit 90; }',
  `set -- /bin/sh -c '${INNER}' crew-codex-worker "$@"`,
  `if command -v perl >/dev/null 2>&1; then set -- perl -e 'use POSIX (); POSIX::setsid(); exec @ARGV or exit 127' "$@"; fi`,
  'nohup "$@" </dev/null >/dev/null 2>&1 &',
  'i=0',
  'while [ ! -s "$f" ]; do',
  '  i=$((i+1))',
  '  if [ "$i" -gt 200 ]; then : >"$f.abandoned"; rm -f "$p"; echo "the Codex worker did not start" >&2; exit 92; fi',
  '  sleep 0.05',
  'done',
  'cat "$f"',
].join('\n')

// One poll of every running job: sleeps first (0 for a tick asked at once), then per job its size, the bytes from its
// offset (at most `cap`), its exit code and its pid file, framed by a marker line the JSONL cannot hold; then one `ps`
// of the pids known so far.
const POLL = [
  's=$1; m=$2; cap=$3; pids=$4; shift 4',
  '[ "$s" = 0 ] || sleep "$s"',
  'while [ $# -ge 5 ]; do',
  '  id=$1; j=$2; o=$3; x=$4; f=$5; shift 5',
  '  n=0; [ -f "$j" ] && n=$(($(wc -c <"$j")))',
  `  printf '%s J %s %s\\n' "$m" "$id" "$n"`,
  '  if [ "$n" -gt "$o" ]; then tail -c +$((o+1)) "$j" | head -c "$cap"; fi',
  `  printf '\\n%s X %s %s %s\\n' "$m" "$id" "$(head -c 8 "$x" 2>/dev/null)" "$(head -c 16 "$f" 2>/dev/null)"`,
  'done',
  `if [ -n "$pids" ]; then printf '%s P\\n' "$m"; ps -o pid=,command= -p "$pids" 2>/dev/null; fi`,
  `printf '%s E\\n' "$m"`,
].join('\n')

// Holds a foreground call while its job runs, as the call's own host process (a hook's budget does not run during
// one): returns 0 as soon as the exit file appears, 3 when `n` quarter seconds have passed.
const WAIT = [
  'x=$1; n=$2; i=0',
  'while [ ! -e "$x" ]; do',
  '  [ "$i" -ge "$n" ] && exit 3',
  '  sleep 0.25; i=$((i+1))',
  'done',
].join('\n')

/** What one poll asks per job: the JSONL from `offset`, the exit and pid files. */
export type PollJob = { id: string; paths: JobPaths; offset: number }

export function pollArgv(jobs: readonly PollJob[], opts: { sleepMs: number; marker: string; cap: number; pids: readonly number[] }): string[] {
  const seconds = opts.sleepMs <= 0 ? '0' : (opts.sleepMs / 1000).toFixed(2)
  return [
    '/bin/sh', '-c', POLL, 'crew-codex-poll', seconds, opts.marker, String(opts.cap), opts.pids.join(','),
    ...jobs.flatMap(job => [job.id, job.paths.jsonl, String(job.offset), job.paths.exit, job.paths.pid]),
  ]
}

export type PollEntry = { size: number; chunk: string; exit: string; pid: string }
export type PollReport = { jobs: Map<string, PollEntry>; alive: Set<number> | undefined; complete: boolean }

/** Reads a poll's output; `alive` is undefined when the poll asked about no pid or its `ps` part is missing. */
export function parsePoll(text: string, marker: string): PollReport {
  const jobs = new Map<string, PollEntry>()
  const head = (kind: string) => new RegExp(`(^|\\n)${marker.replace(/[^\w]/g, '\\$&')} ${kind} `, 'g')
  const lineAt = (at: number) => text.slice(at, text.indexOf('\n', at) === -1 ? text.length : text.indexOf('\n', at))
  for (const match of text.matchAll(head('J'))) {
    const start = (match.index ?? 0) + match[1]!.length
    const [, , id = '', size = ''] = lineAt(start).split(' ')
    const body = start + lineAt(start).length + 1
    const end = text.indexOf(`\n${marker} X ${id} `, body - 1)
    if (end === -1) continue
    const [, , , exit = '', pid = ''] = lineAt(end + 1).split(' ')
    jobs.set(id, { size: Number(size) || 0, chunk: end >= body ? text.slice(body, end) : '', exit, pid })
  }
  const complete = text.includes(`${marker} E`)
  const p = text.indexOf(`${marker} P\n`)
  let alive: Set<number> | undefined
  if (p !== -1) {
    alive = new Set()
    const stop = text.indexOf(`${marker} E`, p)
    for (const row of text.slice(p, stop === -1 ? text.length : stop).split('\n').slice(1)) {
      const found = /^\s*(\d+)\s+(.*)$/.exec(row)
      if (found && isCodexProcess(found[2]!)) alive.add(Number(found[1]))
    }
  }
  return { jobs, alive, complete }
}

/** The argv that holds a foreground call until the job's exit file appears or `ms` have passed. */
export function waitArgv(exitPath: string, ms: number): string[] {
  return ['/bin/sh', '-c', WAIT, 'crew-codex-wait', exitPath, String(Math.max(1, Math.ceil(ms / 250)))]
}

/** The `process.run` argv that starts a job's worker; the prompt goes on its stdin. */
export function workerArgv(paths: JobPaths, codexArgv: readonly string[]): string[] {
  return ['/bin/sh', '-c', OUTER, 'crew-codex', paths.prompt, paths.jsonl, paths.err, paths.exit, paths.pid, ...codexArgv]
}

/** A pid as the worker prints it. */
export function parsePid(text: string): number | undefined {
  const match = /^\s*(\d{1,10})\s*$/.exec(text)
  const pid = match ? Number(match[1]) : NaN
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined
}

/** The exit code the worker wrote. */
export function parseExit(text: string): number | undefined {
  const match = /^\s*(\d{1,3})\s*$/.exec(text)
  return match ? Number(match[1]) : undefined
}

/**
 * How a job ended, for jobs.ts. Codex exits 1 on SIGINT with no terminal event, the same code as a failure (T0): the
 * job counts as interrupted only when the crew sent that SIGINT, so a crash after turn.started is an error. A cancel
 * keeps the job followed until this exit, so it is what ends a cancelled job.
 */
export function exitEnd(code: number, cancelRequested: boolean): SpawnEnd {
  return { code, signal: null, interrupted: cancelRequested && code !== 0 }
}

/** The end of a job whose Codex is gone without an exit code. */
export function lostEnd(cancelRequested: boolean): SpawnEnd {
  return { code: null, signal: null, lost: true, interrupted: cancelRequested }
}

/** `ps -o command= -p <pid>` names a Codex exec: the pid was not reused by another program. */
export function isCodexProcess(command: string): boolean {
  return /(^|\/)codex(\s|$)/.test(command.trim().split('\n')[0] ?? '') && /\bexec\b/.test(command)
}

/** Whether `path` is `root` or under it; both absolute real paths. */
export function isInside(root: string, path: string): boolean {
  const base = root.replace(/\/+$/, '')
  return base !== '' && (path === base || path.startsWith(`${base}/`))
}

/** The folder of a path (`/a/b/c.md` -> `/a/b`). */
export function dirname(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

/** UTF-8 byte length, to move a job's JSONL offset by what was consumed. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/**
 * The whole lines of `text` after the first `from` characters: a line still being written waits for its newline,
 * so the part already consumed decodes the same on every read and slicing by length is safe.
 */
export function takeLines(text: string, from: number): { chunk: string; next: number } {
  const end = text.lastIndexOf('\n')
  if (end < from) return { chunk: '', next: from }
  return { chunk: text.slice(from, end + 1), next: end + 1 }
}

/** The job record the crew keeps in `<id>.json`. */
export type JobRecord = {
  v: 1
  id: string
  agent: CodexRole
  description: string
  cwd: string
  status: JobStatus
  startedAt: number
  endedAt?: number
  model?: string
  /** The `-o` file of architect and research. */
  output?: string
  /** Codex's pid, once the worker printed it. */
  pid?: number
  /** The crew sent SIGINT: an exit 1 with no terminal event is a cancel, not a failure. */
  cancelRequested?: boolean
  /** The Claude session that started the job; only that session follows, cancels or draws it while it runs. */
  owner?: string
  sessionId?: string
  result?: string
  error?: string
  tokens?: Tokens
  files?: string[]
}

/** What the crew knows of a job beside jobs.ts's record. */
export type JobExtra = {
  description: string
  output?: string
  pid?: number
  cancelRequested?: boolean
  /** Why the SIGINT could not be sent, when it could not. */
  cancelError?: string
  owner?: string
  /** A running job of another Claude session: listed, never followed, cancelled or resumed here. */
  foreign?: boolean
  /** Activity lines, oldest first, for the card. */
  activity: string[]
}

const STATUSES: readonly JobStatus[] = ['running', 'background', 'done', 'error', 'cancelled', 'lost']

const cap = (text: string | undefined, max: number) =>
  text === undefined || text.length <= max ? text : `${text.slice(0, max)}\n[... cut at ${max} characters]`

/** Whether an answer read back from a record was cut to RECORD_RESULT_MAX; the whole one is still in the JSONL. */
export const recordCut = (text: string | undefined) => text !== undefined && text.endsWith(`\n[... cut at ${RECORD_RESULT_MAX} characters]`)

export function recordOf(job: Job, extra: JobExtra): JobRecord {
  const record: JobRecord = {
    v: 1, id: job.id, agent: job.agent, description: extra.description, cwd: job.cwd, status: job.status, startedAt: job.startedAt,
  }
  if (job.endedAt !== undefined) record.endedAt = job.endedAt
  if (job.model !== undefined) record.model = job.model
  if (extra.output !== undefined) record.output = extra.output
  if (extra.pid !== undefined) record.pid = extra.pid
  if (extra.cancelRequested) record.cancelRequested = true
  if (extra.owner) record.owner = extra.owner
  if (job.sessionId !== undefined && isThreadId(job.sessionId)) record.sessionId = job.sessionId
  if (job.result !== undefined) record.result = cap(job.result, RECORD_RESULT_MAX)
  if (job.error !== undefined) record.error = cap(job.error, 4000)
  if (job.tokens !== undefined) record.tokens = { ...job.tokens }
  if (job.files?.length) record.files = [...job.files]
  return record
}

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const optString = (value: unknown) => (typeof value === 'string' ? value : undefined)
const optNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** A record read back from disk; anything that is not one (a foreign file, a half write) is undefined. */
export function parseRecord(text: string): JobRecord | undefined {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return undefined }
  if (!isRecordObject(raw) || raw.v !== 1) return undefined
  const { id, agent, cwd, status, startedAt } = raw
  if (typeof id !== 'string' || !JOB_ID.test(id) || !isCodexRole(agent) || typeof cwd !== 'string') return undefined
  if (!STATUSES.includes(status as JobStatus) || optNumber(startedAt) === undefined) return undefined
  const record: JobRecord = {
    v: 1, id, agent, description: optString(raw.description) ?? '', cwd, status: status as JobStatus, startedAt: startedAt as number,
  }
  const endedAt = optNumber(raw.endedAt)
  if (endedAt !== undefined) record.endedAt = endedAt
  for (const key of ['model', 'output', 'result', 'error'] as const) {
    const value = optString(raw[key])
    if (value !== undefined) record[key] = value
  }
  // The record sits in the repository a write job can edit: a session id goes to `resume` only as a UUID.
  if (isThreadId(raw.sessionId)) record.sessionId = raw.sessionId
  if (typeof raw.owner === 'string' && /^[\w-]{1,128}$/.test(raw.owner)) record.owner = raw.owner
  const pid = optNumber(raw.pid)
  if (pid !== undefined && Number.isSafeInteger(pid) && pid > 1) record.pid = pid
  if (raw.cancelRequested === true) record.cancelRequested = true
  if (isRecordObject(raw.tokens)) {
    const t = raw.tokens
    const input = optNumber(t.input), cached = optNumber(t.cached), output = optNumber(t.output)
    if (input !== undefined && cached !== undefined && output !== undefined) record.tokens = { input, cached, output }
  }
  if (Array.isArray(raw.files)) record.files = raw.files.filter((f): f is string => typeof f === 'string')
  return record
}

export function jobOfRecord(record: JobRecord): Job {
  const job: Job = { id: record.id, agent: record.agent, status: record.status, startedAt: record.startedAt, cwd: record.cwd }
  if (record.description) job.description = record.description
  if (record.endedAt !== undefined) job.endedAt = record.endedAt
  if (record.model !== undefined) job.model = record.model
  if (record.sessionId !== undefined) job.sessionId = record.sessionId
  if (record.result !== undefined) job.result = record.result
  if (record.error !== undefined) job.error = record.error
  if (record.tokens !== undefined) job.tokens = { ...record.tokens }
  if (record.files !== undefined) job.files = [...record.files]
  return job
}

export const isActive = (status: JobStatus) => status === 'running' || status === 'background'

/** Adds the job's latest activity to its list when it is new. */
export function noteActivity(extra: JobExtra, text: string | undefined): void {
  if (!text || extra.activity[extra.activity.length - 1] === text) return
  extra.activity = [...extra.activity, text].slice(-ACTIVITY_KEEP)
}

/** The job as the card takes it. */
export function cardJob(job: Job, extra: JobExtra): CodexJob {
  const card: CodexJob = {
    id: job.id, agent: job.agent, description: extra.description, status: job.status, startedAt: job.startedAt, activity: [...extra.activity],
  }
  if (job.model !== undefined) card.model = job.model
  if (job.endedAt !== undefined) card.endedAt = job.endedAt
  if (job.tokens) card.usage = { input: job.tokens.input, cached: job.tokens.cached, output: job.tokens.output }
  if (job.result !== undefined) card.answer = job.result
  return card
}

/** What `codex` and `codex_result` answer for a job: status first, Codex's own text only as a tool result. */
/** What codex_result answers; `whole` is the answer re-read from the JSONL when the record kept a cut one. */
export function resultOf(job: Job, extra: JobExtra | undefined, whole?: string): Record<string, unknown> {
  const ended = !isActive(job.status)
  const out: Record<string, unknown> = { jobId: job.id, status: job.status, agent: job.agent }
  if (extra?.description) out.description = extra.description
  const answer = ended ? whole ?? job.result : undefined
  if (answer !== undefined) out.answer = cap(answer, RESULT_MAX)
  if (!ended && job.lastActivity) out.lastActivity = job.lastActivity
  if (job.error !== undefined) out.error = job.error
  if (job.tokens) out.usage = { ...job.tokens }
  out.files = job.files ?? []
  if (extra?.output !== undefined) out.output = job.status === 'done' ? extra.output : `${extra.output} (written only when the turn completes)`
  if (job.sessionId !== undefined && ended) out.resumable = true
  if (job.cancelling && !ended) out.cancelling = true
  if (extra?.cancelError) out.cancelError = extra.cancelError
  if (extra?.foreign) out.note = 'Started by another Claude session: listed here read-only.'
  else if (!ended) out.next = `Running in the background; collect it with codex_result({ jobId: '${job.id}' }) or stop it with codex_cancel.`
  return out
}

/** The end notice: fixed words, an id, a role and a status, all checked; never anything Codex wrote. */
export function noticeText(id: string, role: string, status: string): string | undefined {
  if (!JOB_ID.test(id) || !isCodexRole(role) || !STATUSES.includes(status as JobStatus)) return undefined
  return `Codex job ${id} (${role}) ended with ${status}; use codex_result({ jobId: '${id}' }).`
}

/**
 * The role prompt as Codex gets it. Architect and research run read-only with `-o`: Codex saves their final message
 * to the lane's file, so they are told to put the whole answer there and not to write files.
 */
export function codexRolePrompt(role: CodexRole, prompt: string, output: string | undefined): string {
  if (output === undefined) return prompt
  const what = role === 'research'
    ? 'the whole findings, each claim with its source, and what you could not confirm (search with your own web search; there is no browser)'
    : 'the whole review, the one-line verdict first, then each finding with path:line, the failing scenario and its severity'
  return `${prompt}\n\nOn Codex you run read-only and cannot write files: do not try to, and do not ask to. ` +
    `Codex saves your final message verbatim to ${output}, so make that message ${what}, not a pointer to a file.`
}

/** The jobs as the `codexJobs` atom keeps them. */
export type JobSummary = CodexJobSummary

export function summaryOf(job: Job, extra: JobExtra | undefined): JobSummary {
  const summary: JobSummary = { id: job.id, agent: job.agent, description: extra?.description ?? job.description ?? '', status: job.status, startedAt: job.startedAt }
  if (job.endedAt !== undefined) summary.endedAt = job.endedAt
  if (job.sessionId !== undefined) summary.sessionId = job.sessionId
  return summary
}
