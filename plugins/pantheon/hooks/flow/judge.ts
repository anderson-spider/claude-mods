// The shared Jev client (decision 10): one request per checkpoint carrying every question, a deadline, one retry,
// a typed error table and one breaker for every caller. Pure: fetch, timer, clock and random are injected, nothing
// here touches `$`, and `judge` never throws. The judge informs and code decides, so every failure is a typed result
// the caller turns into "no judgment".

import { CALIBRATED_MODELS, DEFAULT_BASE_URL, ENDPOINT_PATH, JUDGE_TIMEOUT_MS, MODELS } from './questions'
import type { Battery, CheckpointKind, Prepared, Question, RouteKind } from './questions'
import { head, redactSecrets } from './redact'

// --- Injected host access ---

export type JudgeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: string; headers?: Record<string, string> }>
export type JudgeTimer = (ms: number, fn: () => void) => () => void
export type JudgeIo = {
  fetch: JudgeFetch
  /** Starts a timer and returns its cancellation. */
  timer: JudgeTimer
  /**
   * Epoch milliseconds, read synchronously: pass `() => Date.now()`. The epoch matters because an HTTP-date
   * `retry-after` is measured against it. A clock that throws or returns a non-number reads as 0 and cannot make
   * `judge` throw.
   */
  now: () => number
  /** In [0, 1); jitters the retry delay. */
  random: () => number
}

/**
 * `kind` picks the endpoint and the request model: `openrouter` posts to `<baseUrl>/alpha/decisions` (default
 * `https://openrouter.ai/api`), `typesafe` to `<baseUrl>/v1/systemone` (default `https://api.typesafe.ai`). The two
 * bodies and answers share one shape.
 */
export type Route = { kind: RouteKind; key: string; baseUrl?: string }

export type JudgeOptions = {
  /** For the whole call, retry included. Default 3000, clamped to 500..5000. */
  timeoutMs?: number
  /** Shared by every caller; absent means no circuit breaking. */
  breaker?: Breaker
}

// --- Results ---

export type Answer = {
  noul?: number
  choice?: string
  score?: number
  probabilities?: Record<string, number>
  confidence?: number
}
export type Answers = Record<string, Answer>

export type JudgeSuccess = {
  ok: true
  answers: Answers
  /** The model that answered, as the response reports it. */
  model?: string
  id?: string
  /** Numeric fields of the response's `usage`, as returned. */
  usage?: Record<string, number>
  /** True when the answering model is not one the thresholds were calibrated on (or the response did not say). */
  uncalibrated: boolean
  /** The model asked for. */
  requestModel: string
  /** The checkpoint this answers. */
  kind: CheckpointKind
  attempts: number
  ms: number
}

export type FailureReason =
  | 'off' // 401/402/403/404: the key or the endpoint is unusable; the caller switches the judge off for the session
  | 'rejected' // 400/422: this battery's request is wrong, and it will be wrong again; `detail` holds the provider's error code, never its message
  | 'http' // any other status, including a retryable one that failed twice or could not be retried in time
  | 'timeout'
  | 'network' // fetch itself failed
  | 'malformed' // a body that is not JSON or lacks, or garbles, an answer
  | 'breaker' // the breaker is open; nothing was sent
  | 'config' // no key or an unusable base URL; nothing was sent
  | 'error' // an unexpected exception in the client or in the host access it was given (an unserializable state, a throwing timer)

export type JudgeFailure = {
  ok: false
  reason: FailureReason
  /**
   * `true` for `off` (401/402/403/404): the whole judge is unusable, switch it off for the session. `'battery'` for
   * `rejected` (400/422): only this checkpoint's battery is, because the request is deterministic per battery.
   */
  off?: true | 'battery'
  status?: number
  /**
   * `rejected`: only the error code the provider named (a short identifier), never its message: an error message can echo the
   * request, which is the goal and the agent's words. `malformed` and `network`: what was wrong, in our words or the host's.
   */
  detail?: string
  /** A retryable status's `retry-after` in ms, no higher than the call's deadline. */
  retryAfterMs?: number
  kind: CheckpointKind
  attempts: number
  ms: number
}
export type JudgeResult = JudgeSuccess | JudgeFailure

// --- Breaker ---

export type Breaker = {
  /**
   * False while open. When the pause is over exactly one call is let through as a probe and the rest stay refused
   * until it reports: a failure reopens, a success closes.
   */
  allow(): boolean
  success(): void
  failure(): void
  /** An outcome that says nothing about the service (a rejected request): frees the probe without closing or reopening. */
  release?(): void
  status(): { open: boolean; failures: number; until?: number }
}

export const BREAKER_FAILURES = 3
export const BREAKER_PAUSE_MS = 5 * 60_000
/** Refused calls after which one is let through anyway; see `createBreaker`. */
export const BREAKER_MAX_REFUSALS = 50

/**
 * Three consecutive failures open it for five minutes; then one probe goes through (half-open): a failure reopens it
 * for another five minutes, a success closes it. `now` is the injected clock; share one breaker across callers.
 * Fail safe against a clock that stands still (stuck at 0, or not a clock at all) and against a probe that never
 * reports: every 50th refused call is let through anyway, so the breaker can never stay shut for good.
 */
export function createBreaker(now: () => number, opts: { failures?: number; pauseMs?: number } = {}): Breaker {
  const clock = safeClock(now)
  const limit = opts.failures ?? BREAKER_FAILURES
  const pause = opts.pauseMs ?? BREAKER_PAUSE_MS
  let failures = 0
  let refused = 0
  let probing = false
  let until: number | undefined
  const refuse = () => {
    refused += 1
    if (refused < BREAKER_MAX_REFUSALS) return false
    refused = 0
    return true
  }
  return {
    allow() {
      if (until === undefined) return true
      if (clock() < until) return refuse()
      // half-open: one probe at a time
      if (probing) return refuse()
      probing = true
      refused = 0
      return true
    },
    success() { failures = 0; refused = 0; probing = false; until = undefined },
    failure() {
      failures += 1
      refused = 0
      probing = false
      if (failures >= limit) until = clock() + pause
    },
    release() { probing = false },
    status: () => ({ open: until !== undefined && clock() < until, failures, ...(until === undefined ? {} : { until }) }),
  }
}

/** A clock that cannot throw or return a non-number: those read as 0. */
function safeClock(now: () => number): () => number {
  return () => {
    try {
      const value = Number(now())
      return Number.isFinite(value) ? value : 0
    } catch { return 0 }
  }
}

// --- Client ---

const RETRYABLE = (status: number) => status === 408 || status === 429 || (status >= 500 && status <= 599)
const OFF_STATUSES = new Set([401, 402, 403, 404])
const REJECTED_STATUSES = new Set([400, 422])
/** A retry must leave at least this much of the deadline for the second attempt. */
const MIN_ATTEMPT_MS = 100
const RETRY_JITTER_MS = { min: 200, span: 300 }
export const MIN_TIMEOUT_MS = 500
export const MAX_TIMEOUT_MS = 5_000
/** A provider error code is a short identifier; anything else is free text that may quote the request. */
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,40}$/
// Loose enough for the tolerances of rounding to two decimals.
const EPSILON = 1e-6

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -EPSILON && v <= 1 + EPSILON

function endpoint(route: Route): string | undefined {
  const base = (route.baseUrl ?? DEFAULT_BASE_URL[route.kind]).replace(/\/+$/, '')
  // The key travels in a header to this host: https only, or a loopback one for tests and local gateways.
  if (!/^https:\/\//i.test(base) && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(base)) return undefined
  return `${base}${ENDPOINT_PATH[route.kind]}`
}

function stripKey(text: string, key: string): string {
  return key.length >= 4 ? text.split(key).join('[key]') : text
}

function clean(text: string, key: string, cap: number): string {
  return head(redactSecrets(stripKey(text, key)), cap)
}

/** The code of an error body (`{ error: { code } }`, `{ code }`, `{ error: { type } }`, `{ type }`), or undefined: never its message. */
function errorCode(text: string): string | undefined {
  let body: unknown
  try { body = JSON.parse(text) } catch { return undefined }
  const inner = isObject(body) && isObject(body.error) ? body.error : undefined
  for (const candidate of [inner?.code, isObject(body) ? body.code : undefined, inner?.type, isObject(body) ? body.type : undefined]) {
    const code = typeof candidate === 'number' ? String(candidate) : candidate
    if (typeof code === 'string' && ERROR_CODE.test(code)) return code
  }
  return undefined
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!isObject(headers)) return undefined
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name && typeof v === 'string') return v
  return undefined
}

// A clock earlier than this is not an epoch clock (a stuck 0, a counter): an HTTP-date cannot be measured against it.
const PLAUSIBLE_EPOCH_MS = 1e12

/**
 * `retry-after` as a delay: seconds, or an HTTP-date measured against `nowMs`; undefined when absent, unusable,
 * already past, or a date with no epoch clock to measure it against.
 */
function retryAfterMs(headers: Record<string, string> | undefined, nowMs: number): number | undefined {
  const raw = headerValue(headers, 'retry-after')?.trim()
  if (!raw) return undefined
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const ms = Math.round(Number(raw) * 1000)
    return Number.isFinite(ms) ? ms : undefined
  }
  if (!/[A-Za-z]/.test(raw) || nowMs < PLAUSIBLE_EPOCH_MS) return undefined
  const at = Date.parse(raw)
  const delta = at - nowMs
  return Number.isFinite(delta) && delta > 0 ? Math.round(delta) : undefined
}

type Parsed = { ok: true; answers: Answers; model?: string; id?: string; usage?: Record<string, number> } | { ok: false; detail: string }

function parseAnswer(id: string, question: Question, entry: unknown): { ok: true; answer: Answer } | { ok: false; detail: string } {
  const bad = (why: string) => ({ ok: false as const, detail: `answer "${id}": ${why}` })
  if (!isObject(entry)) return bad('not an object')
  if (typeof entry.type === 'string' && entry.type !== question.type) return bad(`type "${head(entry.type, 40)}" is not "${question.type}"`)
  const answer: Answer = {}
  if (question.type === 'noul') {
    if (!unit(entry.noul)) return bad('noul is not a number from 0 to 1')
    answer.noul = Math.min(1, Math.max(0, entry.noul))
  } else if (question.type === 'choice') {
    if (typeof entry.choice !== 'string' || !Object.hasOwn(question.criteria, entry.choice)) return bad('choice is not one of the options')
    answer.choice = entry.choice
  } else {
    const top = question.criteria.length - 1
    if (typeof entry.score !== 'number' || !Number.isFinite(entry.score) || entry.score < -EPSILON || entry.score > top + EPSILON) {
      return bad(`score is not a number from 0 to ${top}`)
    }
    answer.score = Math.min(top, Math.max(0, entry.score))
  }
  if (question.type !== 'noul') {
    if (entry.confidence !== undefined) {
      if (!unit(entry.confidence)) return bad('confidence is not a number from 0 to 1')
      answer.confidence = Math.min(1, Math.max(0, entry.confidence))
    }
    if (entry.probabilities !== undefined) {
      if (!isObject(entry.probabilities)) return bad('probabilities is not an object')
      const probabilities: Record<string, number> = {}
      for (const [k, v] of Object.entries(entry.probabilities)) {
        if (!unit(v)) return bad(`probability of "${head(k, 40)}" is not a number from 0 to 1`)
        probabilities[k] = Math.min(1, Math.max(0, v))
      }
      answer.probabilities = probabilities
    }
  }
  return { ok: true, answer }
}

/** Both response shapes (System One and OpenRouter decisions) carry `answers` keyed by the caller's ids; only asked ids are kept. */
export function parseResponse(text: string, battery: Battery): Parsed {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, detail: 'body is not JSON' }
  }
  if (!isObject(body) || !isObject(body.answers)) return { ok: false, detail: 'body has no answers object' }
  const answers: Answers = {}
  for (const [id, question] of Object.entries(battery)) {
    if (!Object.hasOwn(body.answers, id)) return { ok: false, detail: `answer "${id}" is missing` }
    const parsed = parseAnswer(id, question, body.answers[id])
    if (!parsed.ok) return parsed
    answers[id] = parsed.answer
  }
  let usage: Record<string, number> | undefined
  if (isObject(body.usage)) {
    const numbers = Object.entries(body.usage).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]))
    if (numbers.length > 0) usage = Object.fromEntries(numbers)
  }
  return {
    ok: true,
    answers,
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    ...(typeof body.id === 'string' ? { id: body.id } : {}),
    ...(usage ? { usage } : {}),
  }
}

type Attempt =
  | { kind: 'response'; status: number; text: string; headers?: Record<string, string> }
  | { kind: 'network'; detail: string }

type Run = {
  io: JudgeIo
  route: Route
  url: string
  prepared: Prepared
  timeoutMs: number
  started: number
  clock: () => number
  random: () => number
  count: () => void
  fail: (reason: FailureReason, extra?: Partial<JudgeFailure>) => JudgeFailure
}

/**
 * Asks every question of one checkpoint (`checkpoint()` in questions.ts makes the battery and its redacted state
 * together) in one request. Never throws: success carries the normalized answers; every failure is a typed result.
 * Callers pass the same `breaker` so three failures anywhere pause everyone. A 400/422 is deterministic per battery,
 * so it does not count against the breaker: the result says `off: 'battery'` and the caller stops asking that battery.
 */
export async function judge(io: JudgeIo, route: Route, prepared: Prepared, opts: JudgeOptions = {}): Promise<JudgeResult> {
  const clock = safeClock(() => io.now())
  const started = clock()
  let attempts = 0
  const kind = prepared?.kind
  const key = typeof route?.key === 'string' ? route.key : ''
  const fail = (reason: FailureReason, extra: Partial<JudgeFailure> = {}): JudgeFailure => ({
    ok: false, reason, ...(reason === 'off' ? { off: true as const } : {}), ...extra, kind, attempts, ms: Math.max(0, clock() - started),
  })
  const report = (outcome: 'success' | 'failure' | 'release') => { try { opts.breaker?.[outcome]?.() } catch { /* a broken breaker never breaks the judge */ } }
  try {
    if (typeof route !== 'object' || route === null) return fail('config', { detail: 'no route' })
    const url = endpoint(route)
    if (!key || !url) return fail('config', { detail: key ? 'base URL must be https' : 'no key' })
    let allowed = true
    try { allowed = opts.breaker?.allow() ?? true } catch { /* fail open */ }
    if (!allowed) return fail('breaker')
    const requested = Number(opts.timeoutMs ?? JUDGE_TIMEOUT_MS)
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number.isNaN(requested) ? JUDGE_TIMEOUT_MS : requested))
    const random = () => {
      try {
        const value = Number(io.random())
        return Number.isFinite(value) ? Math.min(0.999999, Math.max(0, value)) : 0
      } catch { return 0 }
    }
    const result = await run({ io, route, url, prepared, timeoutMs, started, clock, random, count: () => { attempts += 1 }, fail })
    // Every outcome feeds the breaker except a rejected request (the fault is the battery's: it only frees a probe).
    if (result.ok) report('success')
    else if (result.reason === 'rejected') report('release')
    else report('failure')
    return result
  } catch (error) {
    report('failure')
    return fail('error', { detail: clean(String(error instanceof Error ? error.message : error), key, 200) })
  }
}

async function run(r: Run): Promise<JudgeResult> {
  const { io, route, url, prepared, timeoutMs, started, clock, random, fail } = r
  const requestModel = MODELS[route.kind]
  // The key is stripped from the body as well: the state is redacted already, but nothing the request holds may carry it.
  const body = stripKey(JSON.stringify({ model: requestModel, state: prepared.state, questions: prepared.battery }), route.key)
  const init = { method: 'POST', headers: { Authorization: `Bearer ${route.key}`, 'Content-Type': 'application/json' }, body }

  const TIMEOUT = Symbol('timeout')
  let expire: () => void = () => {}
  const deadline = new Promise<typeof TIMEOUT>(resolve => { expire = () => resolve(TIMEOUT) })
  const cancelDeadline = io.timer(timeoutMs, () => expire())
  const send = async (): Promise<Attempt> => {
    try {
      const response = await io.fetch(url, init)
      return { kind: 'response', status: response.status, text: String(response.text ?? ''), headers: response.headers }
    } catch (error) {
      return { kind: 'network', detail: clean(String(error instanceof Error ? error.message : error), route.key, 200) }
    }
  }
  const sleep = async (ms: number): Promise<boolean> => {
    let cancel: () => void = () => {}
    const slept = new Promise<true>(resolve => { cancel = io.timer(ms, () => resolve(true)) })
    try {
      return (await Promise.race([slept, deadline])) === true
    } finally { cancel() }
  }

  try {
    for (let n = 1; ; n++) {
      r.count()
      const attempt = await Promise.race([send(), deadline])
      if (attempt === TIMEOUT) return fail('timeout')

      let wait: number | undefined
      let failure: JudgeFailure
      if (attempt.kind === 'network') {
        failure = fail('network', { detail: attempt.detail })
      } else if (attempt.status >= 200 && attempt.status < 300) {
        const parsed = parseResponse(attempt.text, prepared.battery)
        if (!parsed.ok) return fail('malformed', { detail: parsed.detail })
        const calibrated = parsed.model !== undefined && CALIBRATED_MODELS[route.kind].includes(parsed.model)
        return {
          ok: true,
          answers: parsed.answers,
          ...(parsed.model === undefined ? {} : { model: parsed.model }),
          ...(parsed.id === undefined ? {} : { id: parsed.id }),
          ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
          uncalibrated: !calibrated,
          requestModel,
          kind: prepared.kind,
          attempts: n,
          ms: Math.max(0, clock() - started),
        }
      } else if (OFF_STATUSES.has(attempt.status)) {
        return fail('off', { status: attempt.status })
      } else if (REJECTED_STATUSES.has(attempt.status)) {
        {
          const code = errorCode(attempt.text)
          return fail('rejected', { off: 'battery', status: attempt.status, ...(code === undefined ? {} : { detail: stripKey(code, route.key) }) })
        }
      } else if (RETRYABLE(attempt.status)) {
        wait = retryAfterMs(attempt.headers, clock())
        // Reported no higher than the deadline: a longer ask cannot be waited out, and a bad clock must not invent days.
        failure = fail('http', { status: attempt.status, ...(wait === undefined ? {} : { retryAfterMs: Math.min(wait, timeoutMs) }) })
      } else {
        return fail('http', { status: attempt.status })
      }

      // Only a network error or a retryable status reaches here; one retry, if the pause and another attempt fit.
      if (n >= 2) return failure
      const delay = wait ?? Math.round(RETRY_JITTER_MS.min + random() * RETRY_JITTER_MS.span)
      if (Math.max(0, clock() - started) + delay + MIN_ATTEMPT_MS > timeoutMs) return failure
      if (!(await sleep(delay))) return fail('timeout')
    }
  } finally {
    cancelDeadline()
  }
}
