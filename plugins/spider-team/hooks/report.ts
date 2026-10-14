// Restricted report writer: the plugin owns the destination, identity and receipt.
import type { ReportInput, ReportRecord, Context } from '../types'
import type { GitIo } from './diff'
import { verifyCheckout } from './diff'
export const REPORT_ERROR = 'spider-team: report refused or could not be saved; handback is BLOCKED.'
export type FileIo = {
  stat: (path: string) => Promise<{ isLink: boolean; kind: string; realPath?: string }>
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
}
const component = /^[A-Za-z0-9_-]{1,128}$/
function bytes(s: string) { let n = 0; for (const c of s) { const p = c.codePointAt(0)!; n += p < 128 ? 1 : p < 2048 ? 2 : p < 65536 ? 3 : 4 } return n }
/** Check even missing descendants: a dangling symbolic link is not an absent directory. */
export async function safeDestination(io: FileIo, path: string) {
  if (!path.startsWith('/') || /[\r\n\0]/.test(path) || path.split('/').some(p => p === '.' || p === '..' || !p && path.indexOf('//') >= 0)) throw new Error(REPORT_ERROR)
  let prefix = ''
  const parts = path.slice(1).split('/')
  for (let i = 0; i < parts.length; i++) {
    prefix += '/' + parts[i]
    let stat: Awaited<ReturnType<FileIo['stat']>>
    try { stat = await io.stat(prefix) } catch { if (await io.exists(prefix)) throw new Error(REPORT_ERROR); continue }
    if (stat.isLink || stat.realPath !== prefix || stat.kind !== (i === parts.length - 1 ? 'file' : 'dir')) throw new Error(REPORT_ERROR)
  }
}
export type Section = { heading: string; offset: number; limit: number }
export function sections(text: string): Section[] {
  const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop()
  const starts: { heading: string; offset: number }[] = []
  let fence: { marker: string; length: number } | undefined
  lines.forEach((line, i) => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (match) {
      if (!fence) fence = { marker: match[1]![0]!, length: match[1]!.length }
      else if (match[1]![0] === fence.marker && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined
      return
    }
    if (!fence && line.startsWith('## ')) starts.push({ heading: line.slice(3), offset: i + 1 })
  })
  return starts.map((s, i) => ({ ...s, limit: (starts[i + 1]?.offset ?? lines.length + 1) - s.offset }))
}
export function validateReport(input: ReportInput, run: Context) {
  if (!['done', 'blocked', 'partial', 'no-changes'].includes(input.status) || !['APPROVED', 'CHANGES', 'BLOCKED', 'NONE'].includes(input.verdict)) throw new Error(REPORT_ERROR)
  if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 240 || /[\r\n\x00-\x1f\x7f]/.test(input.summary)) throw new Error(REPORT_ERROR)
  if (typeof input.body !== 'string' || bytes(input.body) > 65536 || !input.body.startsWith('## ') || input.body.includes('\0')) throw new Error(REPORT_ERROR)
  const index = sections(input.body)
  if (!index.length || index.length > 16 || index.some(s => !s.heading.trim() || s.heading.length > 80 || /[\x00-\x1f\x7f]/.test(s.heading))) throw new Error(REPORT_ERROR)
  if (run.finished || run.status === 'blocked' || (input.verdict === 'APPROVED' && (run.role !== 'reviewer' || input.status !== 'done'))) throw new Error(REPORT_ERROR)
  if (run.role !== 'developer' && (input.worktreePath !== undefined || input.worktreeBranch !== undefined || input.status === 'no-changes')) throw new Error(REPORT_ERROR)
  if (run.role === 'reviewer' && input.verdict === 'NONE') throw new Error(REPORT_ERROR)
  if (input.status !== 'done' && input.verdict !== 'NONE' && input.verdict !== 'BLOCKED') throw new Error(REPORT_ERROR)
}
export async function saveReport(io: FileIo & GitIo, session: string, run: Context, input: ReportInput): Promise<ReportRecord> {
  validateReport(input, run)
  if (!component.test(session) || !component.test(run.agentId ?? '') || !run.home.startsWith('/')) throw new Error(REPORT_ERROR)
  if (run.role === 'developer' && input.status === 'done' && (!input.worktreePath || !input.worktreeBranch)) throw new Error(REPORT_ERROR)
  if (input.worktreePath || input.worktreeBranch) {
    if (run.role !== 'developer' || !input.worktreePath || !input.worktreeBranch) throw new Error(REPORT_ERROR)
    await verifyCheckout(io, run, input.worktreePath, input.worktreeBranch)
  }
  const body = input.body.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')
  const render = (id: string) => `status: ${input.status}\nrole: ${run.role}\nreport-id: ${id}\nverdict: ${input.verdict}\nsummary: ${input.summary}\n` + (input.worktreePath ? `worktree: ${input.worktreePath}\nbranch: ${input.worktreeBranch}\nbase: ${run.base}\n` : '') + '\n' + body
  if (run.report) {
    await safeDestination(io, run.report.path)
    if (await io.read(run.report.path) === render(run.report.id)) return run.report
  }
  const generation = (run.report?.generation ?? 0) + 1
  const id = `${session}/${run.agentId}/${generation}`
  const path = `${run.home}/.claude/spider-team/reports/${session}/${run.agentId}-${generation}.md`
  const content = render(id)
  const index = sections(content)
  const receipt = `status: ${input.status}\nreport: ${path}\nreport-id: ${id}\nverdict: ${input.verdict}\nsummary: ${input.summary}\n` + (input.worktreePath ? `worktree: ${input.worktreePath}\nbranch: ${input.worktreeBranch}\nbase: ${run.base}\n` : '') + 'sections:\n' + index.map(s => `- ${s.heading}: lines ${s.offset}-${s.offset + s.limit - 1}; offset=${s.offset}, limit=${s.limit}`).join('\n')
  await safeDestination(io, path)
  await io.write(path, content)
  return { id, path, receipt, status: input.status, verdict: input.verdict, generation, ...(input.worktreePath ? { worktreePath: input.worktreePath, worktreeBranch: input.worktreeBranch } : {}) }
}
