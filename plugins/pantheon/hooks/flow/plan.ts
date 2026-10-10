// The flow contract: the fenced `pantheon-flow` JSON block a plan carries, validated strictly so a
// typo fails at approval instead of silently changing what the controller enforces.

import type { Role } from '../types'

export const FLOW_FENCE = 'pantheon-flow'
export const SCHEMA_VERSION = 1

export type Check = { argv: string[]; cwd?: string; timeoutSec: number }
export type Acceptance = { checks: Check[]; criteria: string[] }
export type FlowTask = {
  id: string
  goal: string
  files: string[]
  role: Role
  dependsOn: string[]
  acceptance: Acceptance
  risk: boolean
  loop?: { maxIterations: number }
  onFail?: string
  sideEffect: boolean
}
export type Limits = { maxBlocks: number; maxAttempts: number }
export type Flow = { schemaVersion: 1; planId: string; goal: string; limits: Limits; tasks: FlowTask[] }
export type TaskStatus = 'pending' | 'active' | 'done' | 'failed'

export type ParseResult = { ok: true; flow: Flow; hash: string } | { ok: false; errors: string[] }

export const DEFAULT_LIMITS: Limits = { maxBlocks: 6, maxAttempts: 2 }
const CHECK_TIMEOUT = { default: 120, max: 600 }
const PLAN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const TASK_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
const TOP_KEYS = ['schemaVersion', 'planId', 'goal', 'limits', 'tasks']
// The architect reviews through `risk` and the readers are delegated by the lead outside the flow, so a task is implemented by one of these two.
const TASK_ROLES: readonly Role[] = ['developer', 'ux']
const TASK_KEYS = ['id', 'goal', 'files', 'role', 'dependsOn', 'acceptance', 'risk', 'loop', 'onFail', 'sideEffect']

type Raw = Record<string, unknown>
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const int = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/** The one fenced block, or an error naming why there is none to read. */
export function extractBlock(markdown: string): { json: string } | { error: string } {
  const fence = new RegExp('^```' + FLOW_FENCE + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```[ \\t]*$', 'gm')
  const blocks = [...markdown.matchAll(fence)]
  if (blocks.length === 0) return { error: `no \`\`\`${FLOW_FENCE} block in the plan` }
  if (blocks.length > 1) return { error: `${blocks.length} \`\`\`${FLOW_FENCE} blocks in the plan; keep one` }
  return { json: blocks[0][1] }
}

export function parseFlow(markdown: string): ParseResult {
  const block = extractBlock(markdown)
  if ('error' in block) return { ok: false, errors: [block.error] }
  let raw: unknown
  try {
    raw = JSON.parse(block.json)
  } catch (error) {
    return { ok: false, errors: [`the flow block is not JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  return validateFlow(raw)
}

export function validateFlow(raw: unknown): ParseResult {
  const errors: string[] = []
  if (!isObject(raw)) return { ok: false, errors: ['the flow must be a JSON object'] }
  for (const key of Object.keys(raw)) if (!TOP_KEYS.includes(key)) errors.push(`unknown field ${key}`)
  if (raw.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`)
  if (typeof raw.planId !== 'string' || !PLAN_ID.test(raw.planId)) errors.push(`planId must match ${PLAN_ID}`)
  if (!text(raw.goal)) errors.push('goal must be a non-empty string')

  const limits = { ...DEFAULT_LIMITS }
  if (raw.limits !== undefined) {
    if (!isObject(raw.limits)) errors.push('limits must be an object')
    else {
      for (const key of Object.keys(raw.limits)) if (!(key in DEFAULT_LIMITS)) errors.push(`limits: unknown field ${key}`)
      // The engine honors 8 consecutive Stop blocks; the policy stops one short of it.
      if (raw.limits.maxBlocks !== undefined) {
        if (int(raw.limits.maxBlocks, 1, 7)) limits.maxBlocks = raw.limits.maxBlocks
        else errors.push('limits.maxBlocks must be an integer from 1 to 7')
      }
      if (raw.limits.maxAttempts !== undefined) {
        if (int(raw.limits.maxAttempts, 1, 10)) limits.maxAttempts = raw.limits.maxAttempts
        else errors.push('limits.maxAttempts must be an integer from 1 to 10')
      }
    }
  }

  const tasks: FlowTask[] = []
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) errors.push('tasks must be a non-empty list')
  else {
    let previous: string | undefined
    raw.tasks.forEach((item, index) => {
      const task = parseTask(item, index, previous, errors)
      if (task) { tasks.push(task); previous = task.id }
    })
  }

  const ids = tasks.map(task => task.id)
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  if (duplicates.length) errors.push(`duplicate task ids: ${duplicates.join(', ')}`)
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) errors.push(`${task.id}: dependsOn itself`)
      else if (!ids.includes(dep)) errors.push(`${task.id}: dependsOn unknown task ${dep}`)
    }
    if (task.onFail !== undefined) {
      if (task.onFail === task.id) errors.push(`${task.id}: onFail cannot target itself`)
      else if (!ids.includes(task.onFail)) errors.push(`${task.id}: onFail names unknown task ${task.onFail}`)
    }
  }
  if (errors.length === 0) {
    const cycle = findCycle(tasks)
    if (cycle) errors.push(`dependsOn cycle: ${cycle.join(' -> ')}`)
    if (tasks.every(task => branchOnly(tasks).has(task.id))) errors.push('every task is an onFail branch; at least one must be a normal task')
  }
  if (errors.length) return { ok: false, errors }
  const flow: Flow = { schemaVersion: 1, planId: raw.planId as string, goal: (raw.goal as string).trim(), limits, tasks }
  return { ok: true, flow, hash: flowHash(flow) }
}

function parseTask(raw: unknown, index: number, previous: string | undefined, errors: string[]): FlowTask | undefined {
  const where = `tasks[${index}]`
  if (!isObject(raw)) { errors.push(`${where} must be an object`); return undefined }
  if (typeof raw.id !== 'string' || !TASK_ID.test(raw.id)) { errors.push(`${where}.id must match ${TASK_ID}`); return undefined }
  const at = raw.id
  for (const key of Object.keys(raw)) if (!TASK_KEYS.includes(key)) errors.push(`${at}: unknown field ${key}`)
  if (!text(raw.goal)) errors.push(`${at}: goal must be a non-empty string`)
  const files = Array.isArray(raw.files) && raw.files.every(text) ? (raw.files as string[]).map(f => f.trim()) : undefined
  if (!files) errors.push(`${at}: files must be a list of non-empty paths or globs`)
  else for (const file of files) if (file.startsWith('/') || file.split('/').includes('..')) errors.push(`${at}: file ${file} must be relative and stay inside the repository`)

  let role: Role | undefined
  if (raw.role !== undefined) {
    if (typeof raw.role === 'string' && (TASK_ROLES as readonly string[]).includes(raw.role)) role = raw.role as Role
    else if (typeof raw.role === 'string') errors.push(`${at}: role ${raw.role} is not a task role; task roles are developer or ux`)
    else errors.push(`${at}: role must be developer or ux`)
  }

  // Omitted means after the task listed before it; [] makes a root.
  let dependsOn: string[] = previous ? [previous] : []
  if (raw.dependsOn !== undefined) {
    if (Array.isArray(raw.dependsOn) && raw.dependsOn.every(text)) dependsOn = [...new Set(raw.dependsOn as string[])]
    else errors.push(`${at}: dependsOn must be a list of task ids`)
  }

  const acceptance: Acceptance = { checks: [], criteria: [] }
  if (!isObject(raw.acceptance)) errors.push(`${at}: acceptance must be an object with checks and/or criteria`)
  else {
    for (const key of Object.keys(raw.acceptance)) if (key !== 'checks' && key !== 'criteria') errors.push(`${at}: acceptance: unknown field ${key}`)
    if (raw.acceptance.checks !== undefined) {
      if (!Array.isArray(raw.acceptance.checks)) errors.push(`${at}: acceptance.checks must be a list`)
      else raw.acceptance.checks.forEach((check, i) => {
        const parsed = parseCheck(check, `${at}: acceptance.checks[${i}]`, errors)
        if (parsed) acceptance.checks.push(parsed)
      })
    }
    if (raw.acceptance.criteria !== undefined) {
      if (Array.isArray(raw.acceptance.criteria) && raw.acceptance.criteria.every(text)) acceptance.criteria = (raw.acceptance.criteria as string[]).map(c => c.trim())
      else errors.push(`${at}: acceptance.criteria must be a list of non-empty sentences`)
    }
    if (acceptance.checks.length === 0 && acceptance.criteria.length === 0) errors.push(`${at}: acceptance needs at least one check or criterion`)
  }

  let loop: FlowTask['loop']
  if (raw.loop !== undefined) {
    if (isObject(raw.loop) && Object.keys(raw.loop).every(k => k === 'maxIterations') && int(raw.loop.maxIterations, 1, 10)) loop = { maxIterations: raw.loop.maxIterations }
    else errors.push(`${at}: loop must be { maxIterations } with an integer from 1 to 10`)
  }
  let onFail: string | undefined
  if (raw.onFail !== undefined) {
    if (text(raw.onFail)) onFail = raw.onFail
    else errors.push(`${at}: onFail must be a task id`)
  }
  for (const flag of ['risk', 'sideEffect'] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') errors.push(`${at}: ${flag} must be a boolean`)
  }
  const sideEffect = raw.sideEffect === true
  // A side effect is recorded once and never re-entered, so its done must rest on a check.
  if (sideEffect && acceptance.checks.length === 0) errors.push(`${at}: a sideEffect task needs a check`)
  if (!files || !text(raw.goal)) return undefined
  return { id: at, goal: (raw.goal as string).trim(), files, role: role ?? 'developer', dependsOn, acceptance, risk: raw.risk === true, ...(loop ? { loop } : {}), ...(onFail ? { onFail } : {}), sideEffect }
}

function parseCheck(raw: unknown, where: string, errors: string[]): Check | undefined {
  if (!isObject(raw)) { errors.push(`${where} must be an object`); return undefined }
  for (const key of Object.keys(raw)) if (!['argv', 'cwd', 'timeoutSec'].includes(key)) errors.push(`${where}: unknown field ${key}`)
  // An argv array runs without a shell: no pipes, globbing or substitution to review.
  if (!Array.isArray(raw.argv) || raw.argv.length === 0 || !raw.argv.every(text)) { errors.push(`${where}.argv must be a non-empty list of strings`); return undefined }
  let cwd: string | undefined
  if (raw.cwd !== undefined) {
    if (text(raw.cwd) && !raw.cwd.startsWith('/') && !raw.cwd.split('/').includes('..')) cwd = raw.cwd
    else { errors.push(`${where}.cwd must be a relative path inside the repository`); return undefined }
  }
  let timeoutSec = CHECK_TIMEOUT.default
  if (raw.timeoutSec !== undefined) {
    if (int(raw.timeoutSec, 1, CHECK_TIMEOUT.max)) timeoutSec = raw.timeoutSec
    else { errors.push(`${where}.timeoutSec must be an integer from 1 to ${CHECK_TIMEOUT.max}`); return undefined }
  }
  return { argv: raw.argv as string[], ...(cwd ? { cwd } : {}), timeoutSec }
}

function findCycle(tasks: FlowTask[]): string[] | undefined {
  const deps = new Map(tasks.map(task => [task.id, task.dependsOn]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, 'visiting')
    stack.push(id)
    for (const dep of deps.get(id) ?? []) {
      const cycle = visit(dep)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(id, 'done')
    return undefined
  }
  for (const task of tasks) {
    const cycle = visit(task.id)
    if (cycle) return cycle
  }
  return undefined
}

/** onFail targets nothing depends on: they run only when routed to and do not count for completion. */
export function branchOnly(tasks: FlowTask[]): Set<string> {
  const targets = new Set(tasks.flatMap(task => task.onFail ? [task.onFail] : []))
  const depended = new Set(tasks.flatMap(task => task.dependsOn))
  return new Set([...targets].filter(id => !depended.has(id)))
}

export function requiredTasks(flow: Flow): string[] {
  const branches = branchOnly(flow.tasks)
  return flow.tasks.filter(task => !branches.has(task.id)).map(task => task.id)
}

/** Tasks not done whose dependencies are all done, in plan order; onFail branches are never offered. */
export function eligible(flow: Flow, status: Readonly<Record<string, TaskStatus>>): string[] {
  const branches = branchOnly(flow.tasks)
  return flow.tasks
    .filter(task => status[task.id] !== 'done' && !branches.has(task.id))
    .filter(task => task.dependsOn.every(dep => status[dep] === 'done'))
    .map(task => task.id)
}

export function findTask(flow: Flow, id: string): FlowTask | undefined {
  return flow.tasks.find(task => task.id === id)
}

/** Whether `path` (relative to the repository root, `/`-separated) falls under one of the task's files. */
export function ownsPath(task: Pick<FlowTask, 'files'>, path: string): boolean {
  const target = path.replace(/^\.\//, '')
  return task.files.some(pattern => matchGlob(pattern.replace(/^\.\//, ''), target))
}

/** `dir/` covers everything under it; `*` matches within a segment and `**` across segments. */
export function matchGlob(pattern: string, path: string): boolean {
  if (pattern.endsWith('/')) return path.startsWith(pattern)
  if (!pattern.includes('*')) return path === pattern
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      // `**/` may match no directory at all.
      if (pattern[i + 2] === '/') { source += '(?:.*/)?'; i += 2 } else { source += '.*'; i++ }
    } else if (c === '*') source += '[^/]*'
    else source += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`).test(path)
}

/** Key order and whitespace never change the hash; any change of content does. */
export function flowHash(flow: Flow): string {
  return sha256(canonical(flow))
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// The module runs with no Node or Web crypto, so SHA-256 is computed here (FIPS 180-4).
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

export function sha256(input: string): string {
  const bytes = utf8(input)
  const length = bytes.length
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[length] = 0x80
  const bits = length * 8
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000))
  view.setUint32(padded.length - 4, bits >>> 0)
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const t1 = (hh + s1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0
  }
  return h.map(x => x.toString(16).padStart(8, '0')).join('')
}

function utf8(input: string): Uint8Array {
  const out: number[] = []
  for (const char of input) {
    const cp = char.codePointAt(0)!
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
  }
  return Uint8Array.from(out)
}
