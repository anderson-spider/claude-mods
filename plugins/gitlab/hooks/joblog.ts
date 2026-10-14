// gitlab_job_log: a job's log, cleaned of terminal codes and cut to what explains a failure.
import type { McpToolInputs } from 'claude-code'
import { InputError, MAX_CHARS, clip, id, need, str, type Ctx } from './context'

export type LogInput = { [K in keyof McpToolInputs['mcp__gitlab__gitlab_job_log']]?: unknown }

/** Lines that usually say why a job failed. */
export const ERROR_LINE =
  /\b(error|errors|err!|failed|failure|failing|fatal|exception|traceback|panic|denied|cannot|could not|unable to|not found|undefined reference|segmentation fault|timed out|killed)\b|exit (code|status) [1-9]|✗|✘|\bFAIL\b/i

const CONTEXT = 3
const MAX_MATCH_LINES = 300
const TAIL_WITH_ERRORS = 30
const DEFAULT_TAIL = 100

/** The log as plain lines: ANSI codes and GitLab's collapsible-section markers removed; a line rewritten with `\r` keeps its last state. */
export function cleanLog(raw: string): string[] {
  return raw
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/section_(start|end):\d+:[\w.-]+(\[[^\]\n]*\])?\r?/g, '')
    .split('\n')
    .map((line) => {
      const parts = line.split('\r').filter((p) => p !== '')
      return parts.at(-1) ?? ''
    })
}

const numbered = (lines: string[], from: number) => lines.map((l, i) => `${String(from + i + 1).padStart(5)}| ${l}`)

/** The lines from `from`, numbered only until just past `MAX_CHARS`, so a huge log is not formatted whole only to be clipped. */
function numberedWithin(lines: string[], from: number): string {
  const out: string[] = []
  let size = 0
  for (let i = from; i < lines.length && size <= MAX_CHARS; i++) {
    const line = `${String(i + 1).padStart(5)}| ${lines[i]}`
    out.push(line)
    size += line.length + 1
  }
  return out.join('\n')
}

/** The matching lines with `CONTEXT` lines around each (ranges merged, gaps marked), then the log's last lines. */
export function errorExcerpt(lines: string[], match: RegExp): { text: string; matches: number } {
  const ranges: [number, number][] = []
  let matches = 0
  lines.forEach((line, i) => {
    if (!match.test(line)) return
    matches++
    const start = Math.max(0, i - CONTEXT)
    const end = Math.min(lines.length, i + CONTEXT + 1)
    const last = ranges.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  })
  const tailStart = Math.max(0, lines.length - TAIL_WITH_ERRORS)
  const out: string[] = []
  let shown = 0
  for (const [start, end] of ranges) {
    if (start >= tailStart) break
    if (shown >= MAX_MATCH_LINES) {
      out.push('  …(more matches; pass pattern to narrow them)')
      break
    }
    // merged ranges can span most of a noisy log, so the budget bounds each slice, not only the next range
    const stop = Math.min(end, tailStart, start + MAX_MATCH_LINES - shown)
    out.push(...numbered(lines.slice(start, stop), start), '  …')
    shown += stop - start
  }
  out.push(...numbered(lines.slice(tailStart), tailStart))
  return { text: out.join('\n'), matches }
}

export async function jobLog(ctx: Ctx, input: LogInput): Promise<string> {
  const job = need(id(input.jobId, 'jobId'), 'gitlab_job_log needs jobId (from gitlab_pipeline jobs).')
  const mode = str(input.mode) ?? 'errors'
  if (mode !== 'errors' && mode !== 'tail' && mode !== 'full') throw new InputError('mode must be errors, tail or full.')
  let match = ERROR_LINE
  const pattern = str(input.pattern)
  if (pattern !== undefined) {
    try {
      match = new RegExp(pattern, 'i')
    } catch {
      throw new InputError('pattern is not a valid regular expression.')
    }
  }
  const meta = (await ctx.api.get(`/jobs/${job}`)) as { name?: string; status?: string; failure_reason?: string; stage?: string }
  const lines = cleanLog(await ctx.api.text(`/jobs/${job}/trace`))
  const head = `Job ${job} ${meta.name ?? ''} (${meta.stage ?? '?'}): ${meta.status ?? '?'}${meta.failure_reason ? `, ${meta.failure_reason}` : ''}; ${lines.length} lines`
  if (mode === 'full') return clip(`${head}\n${numberedWithin(lines, 0)}`, 'use mode errors or tail')
  if (mode === 'tail') {
    const n = id(input.lines, 'lines') ?? DEFAULT_TAIL
    const from = Math.max(0, lines.length - n)
    return clip(`${head}\n${numberedWithin(lines, from)}`, 'ask for fewer lines')
  }
  const { text, matches } = errorExcerpt(lines, match)
  return clip(`${head}; ${matches} matching lines, then the last ${Math.min(TAIL_WITH_ERRORS, lines.length)}\n${text}`, 'pass pattern to narrow it')
}
