// Small dispatch/finish decision records. Pure: the write is injected. Only lifecycle metadata and task hashes,
// never task text, keys, paths or command output.
import type { Role } from './roles'
import type { PromptStatus } from './herdr'
import type { JevReason, Levels, Pins, Selection, TaskType } from './effort'
import { DIMENSIONS, TASK_TYPES } from './effort'

export type DecisionRecord = {
  v: 3
  ts: string
  role: Role
  agent: string
  effectiveAgent: string
  selection: Selection | null
  /** True only when this dispatch started the agent with the selected pair. */
  modelApplied: boolean
  effortApplied: boolean
  jevModel: string | null
  jevAsked: boolean
  /** Expected level per dimension, rounded to one decimal; null when no assessment was used. */
  expected: Levels | null
  taskType: Record<TaskType, number> | null
  taskTypePrior: boolean
  pins: Pins
  pinsUsed: { model: boolean; effort: boolean; profile: boolean; dimensions: boolean }
  dimensionsIgnored: boolean
  jevReason: JevReason | null
  taskHash: string
  started: boolean
  promptStatus: PromptStatus
  /** A Herdr error code or a short fixed reason; never output text. */
  reason: string | null
  durationMs: number
}

export type FinishRecord = { v: 2; action: 'finish'; trigger?: 'report'; ts: string; agent: string; effectiveAgent: string; uuid: string | null; closed: boolean; archived: boolean; reason: string | null }

/** FNV-1a, 32 bits, as 8 hex digits: matches one task to another without keeping the text. Not a cryptographic hash. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** `<home>/.claude/codex-team/decisions/<ts with ':' replaced>-<agent>.json`. */
export function decisionPath(home: string, ts: string, agent: string): string {
  return `${home.replace(/\/+$/, '')}/.claude/codex-team/decisions/${ts.replace(/:/g, '-')}-${agent.replace(/[^\w.-]/g, '_')}.json`
}

/** Project nested metadata explicitly so extra service or caller fields cannot enter the log. */
export function decisionData(record: DecisionRecord | FinishRecord): DecisionRecord | FinishRecord {
  if ('action' in record) return { v: 2, action: 'finish', ...(record.trigger === 'report' ? { trigger: 'report' as const } : {}), ts: record.ts, agent: record.agent, effectiveAgent: record.effectiveAgent, uuid: record.uuid, closed: record.closed, archived: record.archived, reason: record.reason }
  const selection = record.selection
  return {
    v: 3, ts: record.ts, role: record.role, agent: record.agent, effectiveAgent: record.effectiveAgent,
    selection: selection ? { model: selection.model, effort: selection.effort, profileId: selection.profileId, source: selection.source, penalty: selection.penalty } : null,
    modelApplied: record.modelApplied, effortApplied: record.effortApplied,
    jevModel: record.jevModel, jevAsked: record.jevAsked,
    expected: record.expected ? Object.fromEntries(DIMENSIONS.map(dim => [dim, record.expected![dim]])) as Levels : null,
    taskType: record.taskType ? Object.fromEntries(TASK_TYPES.map(type => [type, record.taskType![type]])) as Record<TaskType, number> : null,
    taskTypePrior: record.taskTypePrior,
    pins: {
      ...(record.pins.model !== undefined ? { model: record.pins.model } : {}),
      ...(record.pins.effort !== undefined ? { effort: record.pins.effort } : {}),
      ...(record.pins.profileId !== undefined ? { profileId: record.pins.profileId } : {}),
      dimensions: Object.fromEntries([...DIMENSIONS, 'task_type' as const].filter(dim => record.pins.dimensions[dim] !== undefined).map(dim => [dim, record.pins.dimensions[dim]])),
    },
    pinsUsed: { model: record.pinsUsed.model, effort: record.pinsUsed.effort, profile: record.pinsUsed.profile, dimensions: record.pinsUsed.dimensions },
    dimensionsIgnored: record.dimensionsIgnored, jevReason: record.jevReason, taskHash: record.taskHash,
    started: record.started, promptStatus: record.promptStatus, reason: record.reason, durationMs: record.durationMs,
  }
}

/** Writes the record; a failure is one log line and never reaches the caller. */
export async function saveDecision(io: { write: (path: string, text: string) => Promise<void>; log: (text: string) => void }, home: string | undefined, record: DecisionRecord | FinishRecord): Promise<void> {
  if (!home) return io.log('codex-team: decision not logged (no home)')
  const path = decisionPath(home, record.ts, record.effectiveAgent)
  await io.write('action' in record ? path.replace(/\.json$/, '.finish.json') : path, `${JSON.stringify(decisionData(record))}\n`).catch(() => io.log('codex-team: decision not logged (write failed)'))
}
