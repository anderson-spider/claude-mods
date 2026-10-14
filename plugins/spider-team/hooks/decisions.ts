// Explicit telemetry projection: no task, path, native id, result, body or raw error.
import type { Run } from '../types'
import { family, ROLES } from './roles'
export function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const enumValue = <T extends string>(value: unknown, options: readonly T[]) => typeof value === 'string' && options.includes(value as T) ? value as T : null
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const pair = (p: Run['selected']) => ({ model: family(p.model) ?? null, effort: enumValue(p.effort, efforts) })
const reasons = ['no-key', 'bad-key', 'unreadable-settings', 'repo-declared-key', 'http', 'timeout', 'network', 'malformed', 'breaker', 'busy', 'config']
export function decision(run: Run, timestamp: number) {
  const usage = Object.values(run.turns).reduce((sum, t) => ({ input: sum.input + (finite(t.input) ?? 0), output: sum.output + (finite(t.output) ?? 0), cacheRead: sum.cacheRead + (finite(t.cacheRead) ?? 0), cacheWrite: sum.cacheWrite + (finite(t.cacheWrite) ?? 0) }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  const dimensions = Object.fromEntries(['difficulty', 'duration', 'scope', 'task_type'].filter(k => Object.hasOwn(run.dimensions, k)).map(k => {
    const value = run.dimensions[k]
    return [k, k === 'task_type' ? enumValue(value, ['implement', 'bugfix', 'refactor', 'review', 'research', 'docs', 'test']) : typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= (k === 'difficulty' ? 4 : 3) ? value : null]
  }))
  return {
    version: 1, timestamp: finite(timestamp), role: enumValue(run.role, ROLES), taskHash: typeof run.taskHash === 'string' && /^[a-f0-9]{8}$/.test(run.taskHash) ? run.taskHash : null,
    callerRequested: { model: family(run.requested.model) ?? null, effort: enumValue(run.requested.effort, efforts) },
    selected: pair(run.selected), forwarded: pair(run.forwarded), source: enumValue(run.source, ['jev', 'default', 'pinned', 'override']),
    profile: enumValue(run.profile, ['haiku-low', 'haiku-medium', 'haiku-high', 'sonnet-medium', 'sonnet-high', 'opus-high']),
    capReason: run.cap === true ? 'effort-high' : null, failureReason: enumValue(run.jevReason, reasons),
    jevAsked: run.jevAsked === true, dimensionsUsed: run.dimensionsUsed === true, dimensions,
    observed: run.observed.map(o => ({ model: family(o.model) ?? null, effort: enumValue(o.effort, ['low', 'medium', 'high']) })),
    divergence: run.observed.some(o => family(o.model) && o.effort !== null && (family(o.model) !== run.forwarded.model || o.effort !== run.forwarded.effort)),
    usage, durationMs: finite(run.durationMs), status: enumValue(run.status, ['pending', 'running', 'launched', 'done', 'partial', 'blocked']),
    handbackChars: finite(run.handbackChars), receiptChars: finite(run.receiptChars),
  }
}
