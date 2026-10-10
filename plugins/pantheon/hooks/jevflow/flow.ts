// Flow file parsing and the Flow helpers, ported from JevFlow's flow.py (SPEC 1, 10.1, 10.3, 10.5).
//
// A flow is the JSON object typed as `Flow` in ./types. Validation is strict, as in JevFlow:
// unknown keys are rejected, so a typo or a feature this port dropped (`mode`, `gates`,
// `notify`, a phase's `dynamic`) fails loudly instead of changing behaviour silently.
// Like JevFlow, the first error found is the one reported.
//
// Dependency rule: a phase WITHOUT a `depends_on` key depends on the phase listed before it.
// `depends_on: []` makes it a root; an explicit list replaces the implicit dependency.
//
// Pure: the caller reads the JSON file and passes the parsed value in.

import type { Confidence, Flow, Limits, Loop, Phase } from './types'

export type ParseResult = { ok: true; flow: Flow } | { ok: false; errors: string[] }

/** JevFlow's limit defaults. A parsed flow's limits are these, overridden by its own `limits`. */
export const DEFAULT_LIMITS: Limits = Object.freeze({
  max_blocks_per_session: 6,
  max_restarts: 5,
  max_total_minutes: 90,
  hang_minutes: 10,
  max_jev_calls: 200,
  check_timeout_s: 120,
  state_char_budget: 12000,
  confidence: Object.freeze({ auto: 0.8, review: 0.5, flag: 0.7, trust_check: 0.9 }),
})

export const DEFAULT_PRIVACY: { send_diff: boolean } = Object.freeze({ send_diff: false })

const SCHEMA_VERSION = 1
export const PHASE_ID_RE = /^[a-z][a-z0-9_-]{0,39}$/
const RESERVED_PHASE_IDS: ReadonlySet<string> = new Set(['unclear'])
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['schema_version', 'flow_version', 'goal', 'title', 'phases', 'limits', 'privacy'])
const PHASE_KEYS: ReadonlySet<string> = new Set(['id', 'name', 'done_when', 'check', 'depends_on', 'loop', 'on_fail', 'side_effect'])
const LOOP_KEYS: ReadonlySet<string> = new Set(['max_iterations', 'until'])
const CONFIDENCE_KEYS: ReadonlySet<string> = new Set(['auto', 'review', 'flag', 'trust_check'])
// 0 is meaningful here: run once, never relaunch.
const ZERO_OK_LIMITS: ReadonlySet<string> = new Set(['max_restarts'])
const TITLE_MAX = 80

type ScalarLimit = Exclude<keyof Limits, 'confidence'>

class FlowInvalid extends Error {}
const invalid = (message: string): FlowInvalid => new FlowInvalid(message)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const quote = (s: string): string => `'${s}'`
const reprList = (xs: readonly string[]): string => `[${xs.map(quote).join(', ')}]`
/** A Python-style rendering of a JSON value, for messages that quote the bad value. */
const show = (v: unknown): string => {
  if (typeof v === 'string') return quote(v)
  if (v === undefined || v === null) return 'None'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(JSON.stringify(v))
}
// JevFlow reads `data.get("privacy") or {}`, so every falsy value falls back to the defaults.
const isPyFalsy = (v: unknown): boolean =>
  v === undefined || v === null || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0)

function reqStr(obj: Record<string, unknown>, key: string, where: string): string {
  const val = obj[key]
  if (typeof val !== 'string' || val.trim() === '') throw invalid(`${where}: '${key}' must be a non-empty string`)
  return val.trim()
}

function optStr(obj: Record<string, unknown>, key: string, where: string): string | undefined {
  const val = obj[key]
  if (val === undefined || val === null) return undefined
  if (typeof val !== 'string' || val.trim() === '') throw invalid(`${where}: '${key}' must be a non-empty string or null`)
  return val.trim()
}

function unit(val: unknown, where: string): number {
  if (typeof val !== 'number' || !(val >= 0 && val <= 1)) throw invalid(`${where} must be a number in [0, 1]`)
  return val
}

function posInt(val: unknown, where: string, minimum = 1): number {
  if (typeof val !== 'number' || !Number.isInteger(val) || val < minimum) throw invalid(`${where} must be an integer >= ${minimum}`)
  return val
}

function parseLimits(raw: unknown): Limits {
  const obj: unknown = raw === undefined || raw === null ? {} : raw
  if (!isRecord(obj)) throw invalid('limits must be an object')
  const unknown = Object.keys(obj).filter(k => !Object.hasOwn(DEFAULT_LIMITS, k)).sort()
  if (unknown.length > 0) throw invalid(`limits: unknown keys ${reprList(unknown)}`)

  const out: Limits = { ...DEFAULT_LIMITS, confidence: { ...DEFAULT_LIMITS.confidence } }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'confidence') continue
    out[k as ScalarLimit] = posInt(v, `limits.${k}`, ZERO_OK_LIMITS.has(k) ? 0 : 1)
  }

  const rc: unknown = Object.hasOwn(obj, 'confidence') ? obj.confidence : {}
  if (!isRecord(rc)) throw invalid('limits.confidence must be an object')
  const unknownConf = Object.keys(rc).filter(k => !CONFIDENCE_KEYS.has(k)).sort()
  if (unknownConf.length > 0) throw invalid(`limits.confidence: unknown keys ${reprList(unknownConf)}`)
  for (const [k, v] of Object.entries(rc)) out.confidence[k as keyof Confidence] = unit(v, `limits.confidence.${k}`)
  if (out.confidence.review > out.confidence.auto) throw invalid('limits.confidence: review must be <= auto')
  return out
}

function parsePhase(raw: unknown, index: number, prevId: string | undefined): Phase {
  const at = `phases[${index}]`
  if (!isRecord(raw)) throw invalid(`${at} must be an object`)
  const unknown = Object.keys(raw).filter(k => !PHASE_KEYS.has(k)).sort()
  if (unknown.length > 0) throw invalid(`${at}: unknown keys ${reprList(unknown)}`)
  const id = reqStr(raw, 'id', at)
  if (!PHASE_ID_RE.test(id)) throw invalid(`${at}: id ${quote(id)} must match ${PHASE_ID_RE.source}`)
  if (RESERVED_PHASE_IDS.has(id)) throw invalid(`${at}: id ${quote(id)} is reserved`)

  const where = `phase ${quote(id)}`
  const name = reqStr(raw, 'name', where)
  const doneWhen = reqStr(raw, 'done_when', where)
  const check = optStr(raw, 'check', where)

  let dependsOn: string[]
  if (Object.hasOwn(raw, 'depends_on')) {
    const deps = raw.depends_on
    if (!Array.isArray(deps) || !deps.every(d => typeof d === 'string')) {
      throw invalid(`${where}: depends_on must be a list of phase ids`)
    }
    if (new Set(deps).size !== deps.length) throw invalid(`${where}: depends_on has duplicates`)
    dependsOn = deps as string[]
  } else {
    dependsOn = prevId === undefined ? [] : [prevId]
  }

  let loop: Loop | undefined
  if (raw.loop !== undefined && raw.loop !== null) {
    const lr = raw.loop
    if (!isRecord(lr) || Object.keys(lr).some(k => !LOOP_KEYS.has(k))) {
      throw invalid(`${where}: loop must be {max_iterations, until}`)
    }
    const maxIterations = posInt(lr.max_iterations, `${where}: loop.max_iterations`)
    loop = { max_iterations: maxIterations, until: reqStr(lr, 'until', `${where}: loop`) }
  }

  const onFail = optStr(raw, 'on_fail', where)
  if (Object.hasOwn(raw, 'side_effect') && typeof raw.side_effect !== 'boolean') {
    throw invalid(`${where}: side_effect must be a boolean`)
  }
  const sideEffect = raw.side_effect === true
  // The ledger makes "done" permanent, so it must rest on a deterministic check, never on a judgment alone.
  if (sideEffect && check === undefined) throw invalid(`${where}: side_effect phases need a 'check'`)

  return {
    id,
    name,
    done_when: doneWhen,
    ...(check === undefined ? {} : { check }),
    depends_on: dependsOn,
    ...(loop === undefined ? {} : { loop }),
    ...(onFail === undefined ? {} : { on_fail: onFail }),
    side_effect: sideEffect,
  }
}

/** The on_fail targets that no phase depends on. */
function branchOnlyIds(phases: readonly Phase[]): Set<string> {
  const targets = new Set(phases.flatMap(p => (p.on_fail === undefined ? [] : [p.on_fail])))
  const depended = new Set(phases.flatMap(p => p.depends_on))
  return new Set([...targets].filter(t => !depended.has(t)))
}

/** Deterministic topological order (declaration order breaks ties). Throws naming the cycle. */
function topoOrderOf(phases: readonly Phase[]): string[] {
  const deps = new Map(phases.map(p => [p.id, p.depends_on] as const))
  const visitState = new Map<string, 'visiting' | 'done'>()
  const order: string[] = []
  const visit = (node: string, stack: string[]): void => {
    visitState.set(node, 'visiting')
    stack.push(node)
    for (const d of deps.get(node) ?? []) {
      if (visitState.get(d) === 'visiting') {
        const cycle = [...stack.slice(stack.indexOf(d)), d]
        throw invalid('depends_on cycle: ' + cycle.join(' -> '))
      }
      if (!visitState.has(d)) visit(d, stack)
    }
    stack.pop()
    visitState.set(node, 'done')
    order.push(node)
  }
  for (const p of phases) if (!visitState.has(p.id)) visit(p.id, [])
  return order
}

function parseFlowOrThrow(data: unknown): Flow {
  if (!isRecord(data)) throw invalid('flow must be a JSON object')
  const unknown = Object.keys(data).filter(k => !TOP_LEVEL_KEYS.has(k)).sort()
  if (unknown.length > 0) throw invalid(`unknown top-level keys ${reprList(unknown)}`)

  const schemaVersion = data.schema_version === undefined ? SCHEMA_VERSION : data.schema_version
  if (schemaVersion !== SCHEMA_VERSION) {
    throw invalid(`schema_version ${show(schemaVersion)} not supported (supported: ${SCHEMA_VERSION})`)
  }
  const fv = data.flow_version === undefined ? '1' : data.flow_version
  if (typeof fv === 'boolean' || !(typeof fv === 'string' || Number.isInteger(fv)) || String(fv).trim() === '') {
    throw invalid('flow_version must be a non-empty string or integer')
  }
  const flowVersion = String(fv).trim()

  const goal = reqStr(data, 'goal', 'flow')
  const title = data.title === undefined ? '' : data.title
  // Length is counted in code points, as Python's len() does.
  if (typeof title !== 'string' || [...title].length > TITLE_MAX) {
    throw invalid(`title must be a string of at most ${TITLE_MAX} characters`)
  }
  const rawPhases = data.phases
  if (!Array.isArray(rawPhases) || rawPhases.length === 0) throw invalid("flow: 'phases' must be a non-empty list")

  const phases: Phase[] = []
  for (const [i, rp] of rawPhases.entries()) phases.push(parsePhase(rp, i, phases.at(-1)?.id))

  const phaseIds = phases.map(p => p.id)
  if (new Set(phaseIds).size !== phaseIds.length) {
    const dup = [...new Set(phaseIds.filter((id, i) => phaseIds.indexOf(id) !== i))].sort()
    throw invalid(`duplicate phase ids ${reprList(dup)}`)
  }
  const known = new Set(phaseIds)
  for (const p of phases) {
    for (const d of p.depends_on) {
      if (!known.has(d)) throw invalid(`phase ${quote(p.id)}: depends_on unknown phase ${quote(d)}`)
      if (d === p.id) throw invalid(`phase ${quote(p.id)}: depends_on itself`)
    }
    if (p.on_fail !== undefined) {
      if (!known.has(p.on_fail)) throw invalid(`phase ${quote(p.id)}: on_fail unknown phase ${quote(p.on_fail)}`)
      if (p.on_fail === p.id) throw invalid(`phase ${quote(p.id)}: on_fail cannot target itself`)
    }
  }
  topoOrderOf(phases)
  const branch = branchOnlyIds(phases)
  if (phases.every(p => branch.has(p.id))) {
    throw invalid('every phase is a branch-only on_fail target; at least one must be a normal phase')
  }

  const rawPrivacy = isPyFalsy(data.privacy) ? {} : data.privacy
  if (!isRecord(rawPrivacy) || Object.keys(rawPrivacy).some(k => k !== 'send_diff')) {
    throw invalid("privacy must be an object with only 'send_diff'")
  }
  let sendDiff = DEFAULT_PRIVACY.send_diff
  if (Object.hasOwn(rawPrivacy, 'send_diff')) {
    if (typeof rawPrivacy.send_diff !== 'boolean') throw invalid('privacy.send_diff must be a boolean')
    sendDiff = rawPrivacy.send_diff
  }

  return {
    goal,
    title: title.trim(),
    schema_version: SCHEMA_VERSION,
    flow_version: flowVersion,
    phases,
    limits: parseLimits(data.limits),
    privacy: { send_diff: sendDiff },
  }
}

/** Validate a parsed flow.json. Returns the flow, or the first error as a one-item list. */
export function parseFlow(raw: unknown): ParseResult {
  try {
    return { ok: true, flow: parseFlowOrThrow(raw) }
  } catch (err) {
    if (err instanceof FlowInvalid) return { ok: false, errors: [err.message] }
    throw err
  }
}

/** Phase ids in declaration order. */
export function ids(flow: Flow): string[] {
  return flow.phases.map(p => p.id)
}

/** The phase with this id. Throws for an unknown id, as JevFlow's `Flow.phase` raises KeyError. */
export function phaseOf(flow: Flow, phaseId: string): Phase {
  const found = flow.phases.find(p => p.id === phaseId)
  if (found === undefined) throw new Error(`unknown phase ${quote(phaseId)}`)
  return found
}

/** The next phase in declaration order, or undefined for the last one. Throws for an unknown id. */
export function nextPhase(flow: Flow, phaseId: string): string | undefined {
  const phaseIds = ids(flow)
  const i = phaseIds.indexOf(phaseId)
  if (i < 0) throw new Error(`unknown phase ${quote(phaseId)}`)
  return phaseIds[i + 1]
}

/** Topological order of the phases over their dependencies. */
export function topoOrder(flow: Flow): string[] {
  return topoOrderOf(flow.phases)
}

/**
 * The on_fail targets that no phase depends on, in declaration order. They run only when routed
 * to by on_fail: eligibility skips them and the goal does not require them.
 */
export function branchOnly(flow: Flow): string[] {
  const branch = branchOnlyIds(flow.phases)
  return ids(flow).filter(id => branch.has(id))
}

/** The phases that must be done for the goal to be complete, in declaration order. */
export function required(flow: Flow): string[] {
  const branch = branchOnlyIds(flow.phases)
  return ids(flow).filter(id => !branch.has(id))
}

/**
 * Phases not yet done whose dependencies are all done, in declaration order. Branch-only phases
 * are never eligible.
 */
export function eligible(flow: Flow, phaseStatus: Readonly<Record<string, string>>): string[] {
  const branch = branchOnlyIds(flow.phases)
  return flow.phases
    .filter(p => phaseStatus[p.id] !== 'done' && !branch.has(p.id) && p.depends_on.every(d => phaseStatus[d] === 'done'))
    .map(p => p.id)
}
