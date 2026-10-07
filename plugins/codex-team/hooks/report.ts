import type { Checks, Verdict } from './model'

const lines = (report?: string) => report?.split('\n').map(line => line.trim()).filter(Boolean) ?? []

/** Only an exact verdict on the last non-empty line decides the QA result. */
export function verdictOf(report?: string): Verdict | undefined {
  const last = lines(report).at(-1)
  return last === 'VERDICT: APPROVED' ? 'approved' : last === 'VERDICT: CHANGES' ? 'changes' : undefined
}

/** A report whose first non-empty line is exactly `STATUS: WAITING` holds a question for the person. */
export const isWaiting = (report?: string): boolean => lines(report)[0] === 'STATUS: WAITING'

/** The first `CHECKS:` line of an execute report; anything else (or none) is `undefined`. */
export function checksOf(report?: string): Checks | undefined {
  const line = lines(report).find(text => text.startsWith('CHECKS:'))
  const match = line?.match(/^CHECKS: (PASS|FAIL|NOT RUN)(?:\s|$)/)
  return match ? (match[1].toLowerCase() as Checks) : undefined
}
