// Native identity and per-request policy; helpers take injected I/O, never the host `$`.
import type { AgentInfo, TurnCompleteInput, TurnStepInput } from 'claude-code'
import type { Run, IdentityCache, Observation, ReportRecord } from '../types'
import { assessProfile, parsePins } from './effort'
import type { EffortIo } from './effort'
import { capEffort, family, roleOf } from './roles'
import type { Role } from './roles'
import { captureBase } from './diff'
import type { GitIo } from './diff'
import { fnv1a } from './decisions'
export const BLOCKED = 'spider-team: BLOCKED; model, effort, isolation or native identity could not be verified. Adjust conflicting settings or provide a compatible host.'
export type AgentCall = { tool: string; tool_use_id: string; agentId?: string; subagent_type?: string; prompt: string; model?: unknown; effort?: unknown; isolation?: string }
export type DispatchIo = EffortIo & GitIo & { home: string; root: string; key?: string; overrides: (string | undefined)[]; baseRef?: string; version: string }
export async function prepare(io: DispatchIo, call: AgentCall): Promise<{ run: Run; prompt: string } | undefined> {
  const role = roleOf(call.subagent_type)
  if (!role) return undefined
  const parsed = parsePins(call.prompt, { model: call.model, effort: call.effort })
  if (!parsed.task.trim()) throw new Error('spider-team: empty task after directives.')
  const version = /^2\.1\.(\d+)$/.exec(io.version)
  if (!version || Number(version[1]) < 292 || io.overrides.some(v => v !== undefined && v !== '') || call.isolation === 'remote' || (role !== 'developer' && call.isolation !== undefined) || (role === 'developer' && io.baseRef !== 'head')) throw new Error(BLOCKED)
  const base = role === 'developer' ? await captureBase(io, io.root) : {}
  const choice = await assessProfile(io, { role, task: parsed.task, pins: parsed.pins, home: io.home, root: io.root, key: io.key })
  const forwarded = { model: choice.model, effort: capEffort(choice.effort) }
  const run: Run = {
    key: 0, toolId: call.tool_use_id, role,
    taskHash: fnv1a(parsed.task), requested: { ...(parsed.pins.model ? { model: parsed.pins.model } : {}), ...(parsed.pins.effort ? { effort: parsed.pins.effort } : {}) },
    selected: { model: choice.model, effort: choice.effort }, forwarded, profile: choice.profileId, source: choice.source, cap: choice.effort !== forwarded.effort,
    jevAsked: choice.jevAsked, jevReason: choice.jevReason, dimensions: { ...parsed.pins.dimensions }, dimensionsUsed: choice.dimensionsUsed,
    expected: choice.expected, taskType: choice.taskType, root: io.root, home: io.home, ...base,
    status: 'pending', finished: false, observed: [], turns: {}, durationMs: null, handbackChars: null, receiptChars: null,
  }
  const prompt = parsed.task + (role === 'developer' ? `\n\nNative worktree base: ${run.base}. Tracked uncommitted changes from the lead are absent. If required, report BLOCKED; do not commit, stash or copy the lead checkout automatically.` : '')
  return { run, prompt }
}
/** Only the exact native row can classify an ID. Parent, order and call state are irrelevant. */
export function classify(id: string, agents: AgentInfo[]): string {
  if (typeof id !== 'string' || !id || id !== id.trim() || !Array.isArray(agents)) throw new Error(BLOCKED)
  const rows = agents.filter(a => a && a.id === id)
  const row = rows[0], type = row?.type
  if (rows.length !== 1 || !row || typeof row.description !== 'string' || !['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed'].includes(row.status) ||
      ['parentId', 'spawnedBy', 'name', 'teammateId'].some(k => k in row && row[k as keyof AgentInfo] !== undefined && typeof row[k as keyof AgentInfo] !== 'string') || typeof type !== 'string' || !type.trim() || type !== type.trim() ||
      /[\x00-\x1f\x7f]/.test(type) || (type.startsWith('spider-team:') && !roleOf(type))) throw new Error(BLOCKED)
  return type
}
export function policy(type: string, step: Pick<TurnStepInput, 'model' | 'effort'>) {
  if (!roleOf(type)) {
    if (type.startsWith('spider-team:')) throw new Error(BLOCKED)
    return
  }
  if (!family(step.model) || typeof step.effort !== 'string' || !['low', 'medium', 'high'].includes(step.effort)) throw new Error(BLOCKED)
}
export const IDENTITY_VERSION = 1
export function cacheType(cache: IdentityCache, id: string, type?: string): string | undefined {
  const index = cache.entries.findIndex(e => e.id === id)
  const prior = index < 0 ? undefined : cache.entries[index]!
  if (prior && type !== undefined && prior.type !== type) {
    // Contradictory evidence poisons this identity until eviction, never grants a new role.
    prior.type = ''; throw new Error(BLOCKED)
  }
  if (prior) cache.entries.splice(index, 1)
  const entry = prior ?? (type === undefined ? undefined : { id, type })
  if (entry) cache.entries.push(entry)
  if (cache.entries.length > 256) cache.entries.shift()
  return entry?.type
}
export function close<T extends { status: Run['status']; finished: boolean }>(run: T): T { run.status = 'blocked'; run.finished = true; return run }
export function observe(run: Observation, step: TurnStepInput) {
  const observation = { model: step.model, effort: step.effort ?? null }
  if (!run.observed.some(o => o.model === observation.model && o.effort === observation.effort)) {
    run.observed.push(observation)
    if (run.observed.length > 32) run.observed.shift()
  }
}
export function complete(run: Observation, event: Omit<TurnCompleteInput, 'usage'> & { usage?: { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null } }, report?: Pick<ReportRecord, 'receipt' | 'status'>) {
  if (event.isAborted || event.reason !== 'answer') close(run)
  if (Object.hasOwn(run.turns, event.turnId)) return
  if (Object.keys(run.turns).length >= 256) { run.finished = true; if (run.status !== 'blocked') run.status = 'partial'; return }
  const u = event.usage
  if (u?.model && !run.observed.some(o => o.model === u.model && o.effort === null) && run.observed.length < 32) run.observed.push({ model: u.model, effort: null })
  run.turns[event.turnId] = { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0, durationMs: event.durationMs }
  run.durationMs = Object.values(run.turns).reduce((sum, t) => sum + t.durationMs, 0)
  run.handbackChars = event.answer.length
  run.receiptChars = report?.receipt.length ?? null
  run.finished = true
  if (run.status === 'blocked' || event.isAborted || event.reason !== 'answer') run.status = 'blocked'
  else run.status = report && event.answer === report.receipt && ['done', 'no-changes'].includes(report.status) ? 'done' : 'partial'
}
export function acceptsSpawn(e: { subagentType: string; provider: { plugin: string }; model?: string; resume?: unknown; fork: boolean; isTeammate?: true }) {
  if (!roleOf(e.subagentType)) {
    if (e.subagentType.startsWith('spider-team:')) throw new Error(BLOCKED)
    return
  }
  if (e.provider.plugin !== 'spider-team' || (e.model !== undefined && !family(e.model)) || e.resume || e.fork || e.isTeammate) throw new Error(BLOCKED)
}
export const roleName = (role: Role) => `spider-team:${role}`
