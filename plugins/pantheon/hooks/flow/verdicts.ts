// Reads what a reviewer returned. Pure.
//
// QA answers `C<n>: pass|fail — <evidence>` per acceptance criterion and a final `QA: pass|fail|blocked`.
// The architect ends with one line `REVIEW: pass|fail`. A pass is only as good as its proof: QA's `pass`
// counts when every criterion line says pass, and anything the output does not settle is no receipt.

export type Parsed<V extends string> =
  | { ok: true; verdict: V; note?: string }
  | { ok: false; why: string }

// Bullets, quotes and emphasis around a line are tolerated; line breaks are not.
const LEAD = '[ \\t>*_#-]*'
const QA_LINE = new RegExp(`^${LEAD}QA[ \\t]*:[ \\t*_]*(pass|fail|blocked)\\b(.*)$`, 'gim')
const CRITERION = new RegExp(`^${LEAD}C(\\d+)[ \\t]*:[ \\t*_]*(pass|fail)\\b(.*)$`, 'gim')
const REVIEW_LINE = new RegExp(`^${LEAD}REVIEW[ \\t]*:[ \\t*_]*(pass|fail)\\b(.*)$`, 'gim')
const NOTE_MAX = 500

const clip = (text: string) => (text.length <= NOTE_MAX ? text : `...${text.slice(-(NOTE_MAX - 3))}`)
const afterDash = (rest: string) => rest.replace(/[*_\s]+$/g, '').replace(/^[\s*_]*[—–:-]*\s*/, '').trim()

function lastMatch(re: RegExp, text: string): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined
  for (const match of text.matchAll(re)) last = match
  return last
}

/** `criteria` is how many acceptance criteria the task has (C1..Cn). */
export function parseQa(output: string, criteria: number): Parsed<'pass' | 'fail' | 'blocked'> {
  const end = lastMatch(QA_LINE, output)
  if (!end) return { ok: false, why: 'no final `QA: pass|fail|blocked` line' }
  const verdict = end[1]!.toLowerCase() as 'pass' | 'fail' | 'blocked'
  const lines = new Map<number, { result: 'pass' | 'fail'; text: string }>()
  for (const match of output.matchAll(CRITERION)) lines.set(Number(match[1]), { result: match[2]!.toLowerCase() as 'pass' | 'fail', text: `C${match[1]}: ${match[2]!.toLowerCase()} ${afterDash(match[3] ?? '')}`.trim() })
  if (verdict === 'blocked') {
    const why = afterDash(end[2] ?? '')
    return { ok: true, verdict, ...(why ? { note: clip(why) } : {}) }
  }
  const failed = [...lines.values()].filter(line => line.result === 'fail')
  if (verdict === 'fail') {
    const detail = failed.length ? failed.map(line => line.text).join('; ') : afterDash(end[2] ?? '')
    return { ok: true, verdict, ...(detail ? { note: clip(detail) } : {}) }
  }
  // QA says pass: every criterion needs its own passing line, and none may say fail.
  const missing: number[] = []
  for (let n = 1; n <= criteria; n++) if (lines.get(n)?.result !== 'pass') missing.push(n)
  if (failed.length === 0 && missing.length === 0) return { ok: true, verdict: 'pass' }
  const parts: string[] = []
  if (failed.length) parts.push(`it also reported a failing criterion (${failed.map(line => line.text).join('; ')})`)
  const unproven = missing.filter(n => lines.get(n)?.result !== 'fail')
  if (unproven.length) parts.push(`criteria ${unproven.map(n => `C${n}`).join(', ')} have no passing line`)
  return { ok: true, verdict: 'fail', note: clip(`QA said pass but ${parts.join(' and ')}; partial coverage is a failure.`) }
}

export function parseArchitect(output: string): Parsed<'pass' | 'fail'> {
  const end = lastMatch(REVIEW_LINE, output)
  if (!end) return { ok: false, why: 'no final `REVIEW: pass|fail` line' }
  const verdict = end[1]!.toLowerCase() as 'pass' | 'fail'
  if (verdict === 'pass') return { ok: true, verdict }
  // The findings are what the review said before its last line.
  const body = output.slice(0, end.index).trim()
  const note = body || afterDash(end[2] ?? '')
  return { ok: true, verdict, ...(note ? { note: clip(note) } : {}) }
}
