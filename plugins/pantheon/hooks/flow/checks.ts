// Runs a task's approved checks as argv commands through an injected runner. Pure: no host access, no clock of its own.
//
// A check is an argv array (no shell). It runs from the repository root (or the check's relative `cwd`) with the
// judge's API keys removed from its environment (nothing else is: it inherits the rest), and the tail of its output is
// kept for the policy to quote.
//
// Three outcomes besides a pass or a fail:
// - `passed: null`, "could not run": the command timed out or `env` could not exec it (exit 126/127). The policy treats
//   it as not passed, with why.
// - `CheckUnrunnable`: the runner itself rejected for any other reason. That is the host's fault, not the plan's, so it is
//   thrown for the caller to fail open on instead of being counted against the task.
// - unverified: the check never got to run because the pass ran out of time. No result is produced for it, so it is never a
//   fail and never costs an attempt.
//
// A pass keeps a memo: a result is reused while the tree snapshot is the one it was produced on, so a Stop in a chat-only
// turn re-runs nothing.

import type { Check } from './plan'
import { OUTPUT_TAIL } from './policy'
import type { CheckResult } from './types'

export type RunInit = { cwd: string; timeoutMs: number; stdin?: string }
export type RunOutput = { exitCode: number; stdout: string; stderr: string }
/** Runs a command by argv. Rejects when it cannot start or outlives `timeoutMs`. */
export type Runner = (argv: string[], init: RunInit) => Promise<RunOutput>

/** Variables a check must not see: the judge's keys. */
export const SCRUBBED_ENV: readonly string[] = ['OPENROUTER_API_KEY', 'TYPESAFE_API_KEY']

/** Thrown when the runner rejects for a reason that is not the check's own timeout. */
export class CheckUnrunnable extends Error {
  constructor(readonly argv: readonly string[], reason: string) {
    super(`${argv.join(' ')}: ${reason}`)
    this.name = 'CheckUnrunnable'
  }
}

/**
 * The host can only set variables over its own environment, so the command runs under `env -u` to remove them. `--` ends
 * `env`'s own options (both the macOS and the GNU `env` accept it); the plan refuses a command that starts with `-` or
 * contains `=`, which `env` would otherwise read as its own.
 */
export function scrubbed(argv: readonly string[]): string[] {
  return ['env', ...SCRUBBED_ENV.flatMap(name => ['-u', name]), '--', ...argv]
}

export function checkLabel(check: Pick<Check, 'argv'>): string {
  return check.argv.join(' ')
}

export function checkCwd(root: string, check: Pick<Check, 'cwd'>): string {
  const base = root.replace(/\/+$/, '') || '/'
  const rel = (check.cwd ?? '').replace(/^\.\/+/, '').replace(/\/+$/, '')
  return rel && rel !== '.' ? `${base}/${rel}` : base
}

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL ? text : `...${text.slice(-(OUTPUT_TAIL - 3))}`
}

const TIMEOUT = /time(?:d)?[ -]?out|timeout|still running|killed/i

/** `env` could not exec the command: its own message names it, with the exit status 126 (not executable) or 127 (not found). */
function envFailure(argv: readonly string[], out: RunOutput): string | undefined {
  if (out.exitCode !== 126 && out.exitCode !== 127) return undefined
  const first = argv[0] ?? ''
  for (const line of out.stderr.split('\n')) {
    const found = /^env: ['"`‘]?(.+?)['"`’]?: (No such file or directory|Permission denied|not found)$/.exec(line.trim())
    if (found && found[1] === first) return `could not start ${first}: ${found[2]}`
  }
  return undefined
}

export type RunCheckOptions = {
  /** Replaces the check's own timeout when the pass has less time left. */
  timeoutMs?: number
}

/**
 * The check's result, or undefined when a timeout the pass imposed (less than the check's own) ran out: the check is then
 * unverified. Throws `CheckUnrunnable` when the runner rejects for anything but a timeout.
 */
export async function runCheck(run: Runner, root: string, check: Check, options: RunCheckOptions = {}): Promise<CheckResult | undefined> {
  const argv = [...check.argv]
  const limit = check.timeoutSec * 1000
  const timeoutMs = Math.max(1, Math.min(limit, options.timeoutMs ?? limit))
  let out: RunOutput
  try {
    out = await run(scrubbed(argv), { cwd: checkCwd(root, check), timeoutMs })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (!TIMEOUT.test(text)) throw new CheckUnrunnable(argv, text.slice(0, 300))
    if (timeoutMs < limit) return undefined
    return { argv, passed: null, output: `timed out after ${check.timeoutSec}s: ${checkLabel(check)}` }
  }
  const missing = envFailure(argv, out)
  if (missing) return { argv, passed: null, output: missing }
  const passed = out.exitCode === 0
  const text = [out.stdout.trim(), out.stderr.trim()].filter(Boolean).join('\n')
  return { argv, passed, output: tail(text) || (passed ? '' : `exit code ${out.exitCode}`) }
}

// --- passes ---

/** Results by check, each with the tree snapshot it was produced on. */
export type CheckMemo = Map<string, { snapshot: string; result: CheckResult }>
const MEMO_MAX = 200

export type PassOptions = {
  /** Keeps results between passes; omitted, every check runs. */
  memo?: CheckMemo
  /** Namespaces the memo (a plan id). */
  scope?: string
  /** The tree's snapshot now; undefined (git unavailable) means nothing is reused or remembered. */
  snapshot?: () => Promise<string | undefined>
  /** The pass stops starting checks at `endsAt` (epoch ms by `now`); a running one is cut to the time left. */
  deadline?: { now: () => Promise<number>; endsAt: number }
}

export type CheckPass = {
  /** The task's checks in order. A check that did not get to run ends the list there: what comes back is a prefix. */
  runTask: (checks: readonly Check[]) => Promise<CheckResult[]>
  /** Remembers what ran on the tree as the checks left it. */
  finish: () => Promise<{ ran: number; reused: number; unverified: number }>
}

export async function createCheckPass(run: Runner, root: string, options: PassOptions = {}): Promise<CheckPass> {
  const before = options.snapshot ? await options.snapshot() : undefined
  const sameTree = new Map<string, Promise<CheckResult | undefined>>()
  const executed: { key: string; result: CheckResult }[] = []
  let reused = 0
  let unverified = 0
  let exhausted = false
  const keyOf = (check: Check) => `${options.scope ?? ''}\0${checkCwd(root, check)}\0${check.timeoutSec}\0${check.argv.join('\0')}`

  const execute = async (check: Check, key: string): Promise<CheckResult | undefined> => {
    if (exhausted) return undefined
    let timeoutMs: number | undefined
    if (options.deadline) {
      const left = options.deadline.endsAt - (await options.deadline.now())
      if (left <= 0) { exhausted = true; return undefined }
      timeoutMs = left
    }
    const result = await runCheck(run, root, check, timeoutMs === undefined ? {} : { timeoutMs })
    if (!result) { exhausted = true; return undefined }
    if (result.passed !== null) executed.push({ key, result })
    return result
  }

  return {
    async runTask(checks) {
      const results: CheckResult[] = []
      for (const check of checks) {
        const key = keyOf(check)
        const hit = before !== undefined ? options.memo?.get(key) : undefined
        if (hit && hit.snapshot === before) { reused++; results.push(hit.result); continue }
        let pending = sameTree.get(key)
        if (!pending) { pending = execute(check, key); sameTree.set(key, pending) }
        const result = await pending
        if (!result) { unverified += checks.length - results.length; break }
        results.push(result)
      }
      return results
    },
    async finish() {
      const ran = executed.length
      if (ran > 0 && options.memo && options.snapshot) {
        const after = await options.snapshot()
        if (after !== undefined) {
          for (const { key, result } of executed) options.memo.set(key, { snapshot: after, result })
          while (options.memo.size > MEMO_MAX) options.memo.delete(options.memo.keys().next().value as string)
        }
      }
      return { ran, reused, unverified }
    },
  }
}

/** The task's checks in order, once, with no memo and no deadline (a task end). */
export async function runChecks(run: Runner, root: string, checks: readonly Check[]): Promise<CheckResult[]> {
  return (await createCheckPass(run, root)).runTask(checks)
}
