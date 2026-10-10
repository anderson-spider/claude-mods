// JevFlow's hook entry points (hooks.py `handle`, auto.py, the I/O of project.py) over injected host access. Every entry
// point fails open: an error allows the stop and adds nothing, so the flow can never trap a session.

import { applyDecision, capReached, decide } from './policy'
import { PHASE_ID_RE, parseFlow } from './flow'
import { claim as claimPhase, newState, record, touchAgent, validateState } from './state'
import type { AgentInfo } from './state'
import { judge, judgmentProbs, NO_JUDGE } from './questions'
import type { AskFn } from './questions'
import { checksToRun, slugify, summaryMarkdown } from './project'
import { phaseTable, planInstructions, render, sessionContext, transitionLine } from './texts'
import { ADVANCE, ALLOW_STOP, BLOCK, ROLES } from './types'
import type { CheckResult, Flow, FlowState } from './types'

export const BASE = '.pantheon/flow'
const FLOWS = 'flows'
const DONE = 'done'
const SESSIONS = 'sessions'
const PREFIX = '[Pantheon flow]'
/** Shown while Jev has no key (io.ask undefined): the status line and the note at start. */
const JEV_OFF_STATUS = "Jev: off (the plugin's judgeKey option is not set); every Stop decides on the checks alone."
const JEV_OFF_NOTE = "Note: Jev is off (the plugin's judgeKey option is not set), so every Stop decides on the checks alone; tell the person."

const REASON_JOURNAL_CHARS = 600
const ERROR_DETAIL_CHARS = 300
const RESET_SOURCES = ['startup', 'resume', 'clear']
const PLAN_BLOCK_LIMIT = 3
const CHECK_OUTPUT_KEEP = 4000
const CHECKS_TOTAL_S = 300
const GIT_TOTAL_S = 45
const GIT_TIMEOUT_S = 20
const MAX_UNTRACKED = 200
const JOIN_RECENT_S = 12 * 3600
const JOIN_MAX = 3
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/
/** auto.py GITIGNORE, for what Pantheon writes: a session's binding is local; the flows themselves can be committed. */
const GITIGNORE = 'sessions/\n*.tmp\n'

export type Run = (argv: string[], init: { cwd: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/** Whether a check command may run; a refusal says why, and the check then counts as failed. */
export type CheckAuthorization = { ok: true } | { ok: false; reason: string }

/** What the controller needs from the host, built from the hook's `$` by register.tsx. Times are seconds, as JevFlow's. */
export type Io = {
  read: (path: string) => Promise<string | undefined>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  list: (dir: string) => Promise<{ name: string; kind: string; mtimeMs: number }[]>
  remove: (path: string) => Promise<void>
  move: (from: string, to: string) => Promise<void>
  run: Run
  now: () => Promise<number>
  /** Jev, when the judgeKey option is set; without it every Stop is checks-only (degraded). */
  ask?: AskFn
  /**
   * Decides whether a check command may run, asked once per distinct command before the check time budget starts.
   * Without it every check runs.
   */
  authorize?: (cmd: string, phase: string) => Promise<CheckAuthorization>
}

export type Paths = { root: string; id: string; archived: boolean; dir: string; flow: string; state: string; needsHuman: string; draft: string }

export function pathsOf(root: string, id: string, archived = false): Paths {
  const dir = `${root}/${BASE}/${archived ? DONE : FLOWS}/${id}`
  return { root, id, archived, dir, flow: `${dir}/flow.json`, state: `${dir}/state.json`, needsHuman: `${dir}/NEEDS_HUMAN.md`, draft: `${dir}/draft.json` }
}

const sessionFile = (root: string, sid: string | undefined): string | undefined => {
  const clean = String(sid ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)
  return clean ? `${root}/${BASE}/${SESSIONS}/${clean}` : undefined
}

async function readJson(io: Io, path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await io.read(path)
    if (text === undefined) return undefined
    const data = JSON.parse(text) as unknown
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined
  } catch { return undefined }
}

/** Active flow `id`, else the archived one, else undefined. */
export async function flowPaths(io: Io, root: string, id: string): Promise<Paths | undefined> {
  if (!ID_RE.test(id)) return undefined
  for (const archived of [false, true]) {
    const p = pathsOf(root, id, archived)
    if (await io.exists(p.dir)) return p
  }
  return undefined
}

export async function boundFlow(io: Io, root: string, sid: string | undefined): Promise<Paths | undefined> {
  const f = sessionFile(root, sid)
  if (!f) return undefined
  const id = (await io.read(f).catch(() => undefined))?.trim()
  return id ? flowPaths(io, root, id) : undefined
}

export async function bindSession(io: Io, root: string, sid: string | undefined, id: string): Promise<void> {
  const f = sessionFile(root, sid)
  if (f) await io.write(f, `${id}\n`)
}

export async function isDraft(io: Io, p: Paths): Promise<boolean> {
  return (await io.exists(p.draft)) || !(await io.exists(p.flow))
}

export class FlowError extends Error {}

export async function loadFlow(io: Io, p: Paths): Promise<Flow> {
  const text = await io.read(p.flow)
  if (text === undefined) throw new FlowError(`${rel(p, p.flow)} does not exist yet`)
  let raw: unknown
  try { raw = JSON.parse(text) } catch (error) { throw new FlowError(`${rel(p, p.flow)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`) }
  const parsed = parseFlow(raw)
  if (!parsed.ok) throw new FlowError(`${rel(p, p.flow)} is invalid: ${parsed.errors.join('; ')}`)
  return parsed.flow
}

/** The flow and its state, for a viewer. */
export async function loadFlowAndState(io: Io, p: Paths): Promise<{ flow: Flow; state: FlowState }> {
  const flow = await loadFlow(io, p)
  return { flow, state: await loadState(io, p, flow, await io.now()) }
}

async function loadState(io: Io, p: Paths, flow: Flow, now: number): Promise<FlowState> {
  const text = await io.read(p.state)
  if (text === undefined) return newState(flow, now)
  return validateState(JSON.parse(text), flow, now)
}

const saveState = (io: Io, p: Paths, state: FlowState) => io.write(p.state, `${JSON.stringify(state, null, 1)}\n`)
const rel = (p: Paths, path: string) => path.startsWith(`${p.root}/`) ? path.slice(p.root.length + 1) : path

/** Promote a draft once its flow.json is valid (auto.py try_activate). */
export async function tryActivate(io: Io, p: Paths): Promise<{ ok: boolean; error: string }> {
  try { await loadFlow(io, p) } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  if (await io.exists(p.draft)) await io.remove(p.draft)
  return { ok: true, error: '' }
}

/**
 * hooks.py `handle`: a draft whose flow.json became valid is promoted on any hook event, and tracking starts then (the
 * state is created with a `flow_laid_out` entry), so the viewer and a claim see it at once. Returns why it is still a
 * draft, or undefined once it is active.
 */
async function promote(io: Io, p: Paths): Promise<string | undefined> {
  if (!(await isDraft(io, p))) return undefined
  const { ok, error } = await tryActivate(io, p)
  if (!ok) return error
  const flow = await loadFlow(io, p)
  const now = await io.now()
  await saveState(io, p, record(await loadState(io, p, flow, now), 'flow_laid_out', { phases: flow.phases.length }, now))
  return undefined
}

async function draftGoal(io: Io, p: Paths): Promise<string> {
  return String((await readJson(io, p.draft))?.goal ?? '')
}

// ---------------------------------------------------------------- start, join, claim, status (the tool)

/** `jevflow start`: a draft under flows/<stamp>-<slug>/, bound to this session, and the planning instructions. */
export async function startFlow(io: Io, root: string, sid: string | undefined, goal: string, name?: string): Promise<string> {
  const now = await io.now()
  const ignore = `${root}/${BASE}/.gitignore`
  if (!(await io.exists(ignore))) await io.write(ignore, GITIGNORE)
  const stamp = new Date(now * 1000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const fromName = name ? slugify(name, 6) : 'flow'
  const slug = name && fromName !== 'flow' ? fromName : slugify(goal)
  const base = `${stamp}-${slug}`
  let id = base
  for (let n = 2; (await io.exists(pathsOf(root, id).dir)) || (await io.exists(pathsOf(root, id, true).dir)); n++) id = `${base}-${n}`
  const p = pathsOf(root, id)
  await io.write(p.draft, `${JSON.stringify({ goal: goal.trim(), created_at: now, session_id: sid ?? null, plan_blocks: 0 }, null, 1)}\n`)
  await bindSession(io, root, sid, id)
  const text = planInstructions(rel(p, p.flow), id, goal.trim())
  return io.ask ? text : `${text}\n\n${JEV_OFF_NOTE}`
}

export async function validateFlow(io: Io, root: string, sid: string | undefined): Promise<string> {
  const p = await boundFlow(io, root, sid)
  if (!p) return 'This session is not working on a flow. Start one with action start.'
  try {
    const flow = await loadFlow(io, p)
    await promote(io, p)
    return `${rel(p, p.flow)} is valid: ${flow.phases.length} phases.\n${phaseTable(flow, await loadState(io, p, flow, await io.now()))}`
  } catch (error) { return error instanceof Error ? error.message : String(error) }
}

export async function joinFlow(io: Io, root: string, sid: string | undefined, id: string): Promise<string> {
  const p = await flowPaths(io, root, id)
  if (!p || p.archived) return `No active flow ${id} in this folder.`
  await bindSession(io, root, sid, id)
  return `Joined flow ${id}. Claim the phase you take with action claim.`
}

/** `jevflow claim <phase> --as <role>`: the agent's advisory claim, shown in the status and the Flow tab. */
export async function claimFlow(io: Io, root: string, who: AgentInfo, phase: string, role: string): Promise<string> {
  const p = await boundFlow(io, root, who.sessionId)
  if (!p || p.archived) return 'This session is not working on an active flow. Start one with action start, or join one with action join.'
  if (await promote(io, p) !== undefined) return 'The flow is still a draft: lay out its phases first.'
  const flow = await loadFlow(io, p)
  const now = await io.now()
  const next = claimPhase(await loadState(io, p, flow, now), who, phase, role, now)
  if (typeof next === 'string') return `Not claimed: ${next}.`
  await saveState(io, p, next)
  return `Claimed ${phase} as ${role}.`
}

/** The roles a spawned agent can claim as: the lead is the main session, never a subagent. */
const SPAWN_ROLES: readonly string[] = ROLES.filter(role => role !== 'lead')

/**
 * The claim a delegated agent gets when it spawns: its type is `pantheon:<role>` and its description starts with
 * `[<phase id>]` (optional leading spaces). Anything else is not a delegation and claims nothing.
 */
export function spawnClaim(subagentType: string | undefined, description: string | undefined): { phase: string; role: string } | undefined {
  const role = subagentType?.startsWith('pantheon:') ? subagentType.slice('pantheon:'.length) : undefined
  if (role === undefined || !SPAWN_ROLES.includes(role)) return undefined
  const phase = /^\s*\[([^\]]*)\]/.exec(description ?? '')?.[1]
  if (phase === undefined || !PHASE_ID_RE.test(phase)) return undefined
  return { phase, role }
}

/** How many of the Stop's background tasks are agents: a dev server or a monitor is not work the flow waits for. */
export function pendingAgentTasks(tasks: readonly { type?: string }[] | undefined): number {
  return (tasks ?? []).filter(task => task.type === 'subagent' || task.type === 'workflow').length
}

/** The flow a viewer shows: the session's, else the newest active, else the newest archived (project.py default_flow). */
export async function viewedFlow(io: Io, root: string, sid: string | undefined): Promise<Paths | undefined> {
  const bound = await boundFlow(io, root, sid)
  if (bound) return bound
  return (await listFlows(io, root))[0]?.p
}

export async function listFlows(io: Io, root: string): Promise<{ p: Paths; mtime: number }[]> {
  const out: { p: Paths; mtime: number }[] = []
  for (const archived of [false, true]) {
    let names: { name: string; kind: string }[] = []
    try { names = await io.list(`${root}/${BASE}/${archived ? DONE : FLOWS}`) } catch { continue }
    const group: { p: Paths; mtime: number }[] = []
    for (const n of names) {
      if (n.kind !== 'dir' || !ID_RE.test(n.name)) continue
      const p = pathsOf(root, n.name, archived)
      let mtime = 0
      try { for (const f of await io.list(p.dir)) mtime = Math.max(mtime, f.mtimeMs / 1000) } catch { /* An unreadable folder sorts last. */ }
      group.push({ p, mtime })
    }
    out.push(...group.sort((a, b) => b.mtime - a.mtime))
  }
  return out
}

export async function statusText(io: Io, root: string, sid: string | undefined): Promise<string> {
  const p = await viewedFlow(io, root, sid)
  if (!p) return 'No flow in this folder. A multi-step task starts one with mcp__pantheon__flow start.'
  const off = io.ask ? [] : [JEV_OFF_STATUS]
  if (!p.archived && await promote(io, p) !== undefined) return [`Flow ${p.id}: draft, phases not laid out yet.`, ...off].join('\n')
  const flow = await loadFlow(io, p)
  const state = await loadState(io, p, flow, await io.now())
  const human = await io.read(p.needsHuman).catch(() => undefined)
  return [`Flow ${p.id}${p.archived ? ' (archived)' : ''}`, ...off, render(flow, state, human)].join('\n')
}

// ---------------------------------------------------------------- session start, prompt

async function activeFlows(io: Io, root: string, now: number): Promise<{ p: Paths; title: string; phase?: string; agents: string[] }[]> {
  const out: { p: Paths; title: string; phase?: string; agents: string[] }[] = []
  for (const { p, mtime } of await listFlows(io, root)) {
    if (p.archived || now - mtime > JOIN_RECENT_S) continue
    const st = await readJson(io, p.state) ?? {}
    if (st.done) continue
    const fl = await readJson(io, p.flow)
    const title = fl ? String(fl.title ?? '') : (await draftGoal(io, p)).slice(0, 60)
    const agents = Object.values((st.agents ?? {}) as Record<string, { label?: string }>).map(a => a?.label ?? '?')
    out.push({ p, title, phase: typeof st.current_phase === 'string' ? st.current_phase : undefined, agents })
    if (out.length >= JOIN_MAX) break
  }
  return out
}

/** auto.py join_hint: the flows other sessions run here, for a session bound to none. */
export async function joinHint(io: Io, root: string, sid: string | undefined, now: number): Promise<string | undefined> {
  const cur = await boundFlow(io, root, sid)
  if (cur && !cur.archived) return undefined
  const rows = await activeFlows(io, root, now)
  if (!rows.length) return undefined
  const lines = rows.map(({ p, title, phase, agents }) =>
    `- \`${p.id}\`: ${title || '(being planned)'}, at phase \`${phase ?? '?'}\`${agents.length ? `, worked on by ${agents.slice(0, 4).join(', ')}` : ''}`)
  return `${PREFIX} Other agents are running flows in this folder:\n${lines.join('\n')}\n`
    + 'If the request continues or helps with one of them, join it before working: mcp__pantheon__flow with action join and the flow id, '
    + 'then action claim with the phase you take and your role, so the Flow tab shows you next to the other agents. Start a new flow only for unrelated work.'
}

export async function onSessionStart(io: Io, root: string, payload: { session_id?: string; source?: string }): Promise<string | undefined> {
  const now = await io.now()
  const p = await boundFlow(io, root, payload.session_id)
  if (!p || p.archived) return joinHint(io, root, payload.session_id, now)
  if (await promote(io, p) !== undefined) return planInstructions(rel(p, p.flow), p.id, await draftGoal(io, p))
  const flow = await loadFlow(io, p)
  let state = await loadState(io, p, flow, now)
  const source = payload.source ?? 'startup'
  if (RESET_SOURCES.includes(source)) state = { ...state, blocks_this_session: 0, consecutive_blocks: 0 }
  state = { ...record(state, 'session_start', { source }, now), session_id: payload.session_id ?? null }
  await saveState(io, p, state)
  return sessionContext(flow, state, source, rel(p, p.needsHuman))
}

/** UserPromptSubmit: the join hint on the first prompt of a session with no flow, the refill of the block budget and the draft reminder for one with a flow. */
export async function onUserPrompt(io: Io, root: string, payload: { session_id?: string; prompt?: string }, first: boolean): Promise<string | undefined> {
  const now = await io.now()
  const p = await boundFlow(io, root, payload.session_id)
  if (!p || p.archived) {
    return first ? joinHint(io, root, payload.session_id, now) : undefined
  }
  const draftError = await promote(io, p)
  if (draftError !== undefined) {
    return `Reminder: flow \`${p.id}\` still needs its phases (${draftError}).\n\n${planInstructions(rel(p, p.flow), p.id, await draftGoal(io, p))}`
  }
  // A human reply is a fresh start: the block budget guards against looping unattended (hooks.py _refill_budget).
  try {
    const flow = await loadFlow(io, p)
    const state = await loadState(io, p, flow, now)
    if (!state.done && state.blocks_this_session) {
      await saveState(io, p, record({ ...state, blocks_this_session: 0, consecutive_blocks: 0 }, 'budget_refill', { source: 'user_prompt', used: state.blocks_this_session }, now))
    }
  } catch { /* Never raises. */ }
  return undefined
}

// ---------------------------------------------------------------- checks and changes (project.py)

export async function runCheck(io: Io, cmd: string, cwd: string, timeoutS: number): Promise<CheckResult> {
  if (timeoutS <= 0) return { passed: false, output: 'not run: check time budget for this Stop is used up' }
  let out: Awaited<ReturnType<Run>>
  try { out = await io.run(['/bin/sh', '-c', cmd], { cwd, timeoutMs: Math.round(timeoutS * 1000) }) } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { passed: false, output: /time/i.test(msg) ? `check timed out after ${Math.round(timeoutS)}s: ${cmd}` : `check could not start: ${msg}` }
  }
  let text = `${out.stdout}${out.stderr}`
  if (text.length > CHECK_OUTPUT_KEEP) text = `...${text.slice(-(CHECK_OUTPUT_KEEP - 3))}`
  return { passed: out.exitCode === 0, output: text }
}

/** One decision per distinct command, asked in order; an error from the host refuses the command. */
async function authorizeChecks(
  authorize: NonNullable<Io['authorize']>,
  commands: { cmd: string; phase: string }[],
): Promise<Map<string, CheckAuthorization>> {
  const decisions = new Map<string, CheckAuthorization>()
  for (const { cmd, phase } of commands) {
    if (decisions.has(cmd)) continue
    try {
      decisions.set(cmd, await authorize(cmd, phase))
    } catch (error) {
      decisions.set(cmd, { ok: false, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return decisions
}

export async function runChecks(io: Io, flow: Flow, state: FlowState, cwd: string): Promise<{ checks: Record<string, CheckResult>; loopChecks: Record<string, CheckResult> }> {
  const per = flow.limits.check_timeout_s
  let start = await io.now()
  const settling = capReached(flow, state, start) !== null
  const planned: { id: string; cmd: string }[] = []
  for (const id of checksToRun(flow, state, settling)) {
    const check = flow.phases.find(p => p.id === id)?.check
    if (check) planned.push({ id, cmd: check })
  }
  const cur = flow.phases.find(p => p.id === state.current_phase)
  const commands = planned.map(({ id, cmd }) => ({ cmd, phase: id }))
  if (cur?.loop) commands.push({ cmd: cur.loop.until, phase: cur.id })
  // A person deciding on a command does not eat the budget: the clock starts once every decision is in.
  const decisions = io.authorize ? await authorizeChecks(io.authorize, commands) : undefined
  if (decisions) start = await io.now()
  const left = async () => Math.min(per, start + CHECKS_TOTAL_S - (await io.now()))
  const run = async (cmd: string): Promise<CheckResult> => {
    const decision = decisions?.get(cmd)
    if (decision && !decision.ok) return { passed: false, output: `not run: ${decision.reason}` }
    return runCheck(io, cmd, cwd, await left())
  }
  const checks: Record<string, CheckResult> = {}
  for (const { id, cmd } of planned) checks[id] = await run(cmd)
  for (const p of flow.phases) if (!p.check && !(p.id in checks)) checks[p.id] = { passed: null, output: '' }
  const loopChecks: Record<string, CheckResult> = {}
  if (cur?.loop) loopChecks[cur.id] = await run(cur.loop.until)
  return { checks, loopChecks }
}

export type Change = { path: string; added: number; removed: number; diff?: string }

/** Uncommitted changes with line counts; `diff` text only with `send_diff`. Empty outside a git repo. Never raises. */
export async function gitChanges(io: Io, cwd: string, sendDiff: boolean): Promise<Change[]> {
  const start = await io.now()
  const git = async (args: string[]): Promise<string | undefined> => {
    const left = Math.min(GIT_TIMEOUT_S, start + GIT_TOTAL_S - (await io.now()))
    if (left <= 0) return undefined
    try {
      const out = await io.run(['git', ...args], { cwd, timeoutMs: Math.round(left * 1000) })
      return out.exitCode === 0 ? out.stdout : undefined
    } catch { return undefined }
  }
  const numstat = (await git(['diff', '--numstat', '--relative', 'HEAD'])) ?? (await git(['diff', '--numstat', '--relative', '--cached']))
  if (numstat === undefined) return []
  const entries: Change[] = []
  for (const line of numstat.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [a, r, ...rest] = parts
    entries.push({ path: rest.join('\t'), added: /^\d+$/.test(a!) ? Number(a) : 0, removed: /^\d+$/.test(r!) ? Number(r) : 0 })
  }
  const untracked = (await git(['ls-files', '--others', '--exclude-standard'])) ?? ''
  for (const path of untracked.split('\n').filter(Boolean).slice(0, MAX_UNTRACKED)) {
    const text = await io.read(`${cwd}/${path}`).catch(() => undefined)
    entries.push({ path, added: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, removed: 0 })
  }
  const kept = entries.filter(e => !e.path.startsWith('.pantheon/'))
  if (sendDiff) {
    for (const e of kept.slice(0, 40)) {
      const d = await git(['diff', 'HEAD', '--', e.path])
      if (d) e.diff = d.slice(0, 4000)
    }
  }
  return kept
}

// ---------------------------------------------------------------- Stop

export type StopPayload = { session_id?: string; stop_hook_active?: boolean; last_assistant_message?: string }
/** `noJev`: this Stop needed a judgment and Jev was not asked because there is no key, so it decided on the checks alone. */
export type StopOut = { block?: string; message?: string; noJev?: true }

async function writeNeedsHuman(io: Io, p: Paths, flow: Flow, state: FlowState, question: string, now: number): Promise<void> {
  const ts = new Date(now * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
  await io.write(p.needsHuman, `# Pantheon flow needs a human\n\n${ts}\n\n## Question\n\n${question}\n\n## Goal\n\n${flow.goal}\n\n`
    + `## Phases\n\n\`\`\`\n${phaseTable(flow, state)}\n\`\`\`\n\nResolve it, then clear \`needs_human\` (delete this file and edit the flow's state.json).\n`)
}

async function onFlowStop(io: Io, p: Paths, payload: StopPayload): Promise<StopOut> {
  const now = await io.now()
  const flow = await loadFlow(io, p)
  let state = await loadState(io, p, flow, now)
  if (state.done) return {}
  const active = payload.stop_hook_active === true
  const prevPhase = state.current_phase
  const { checks, loopChecks } = await runChecks(io, flow, state, p.root)
  // Deterministic first: budgets, caps, regression and loop phases never need Jev. Only a degraded_* result means the
  // outcome depends on the judgment.
  let d = decide(flow, state, null, checks, now, { stop_hook_active: active, loop_checks: loopChecks })
  let judged: Awaited<ReturnType<typeof judge>> | undefined
  if (d.condition.startsWith('degraded_')) {
    const remaining = flow.limits.max_jev_calls - state.jev_calls
    judged = remaining > 0
      ? await judge(io.ask, flow, state, {
        checks, lastMessage: String(payload.last_assistant_message ?? ''), changes: await gitChanges(io, p.root, flow.privacy.send_diff), maxCalls: remaining,
      })
      : { judgment: null, calls: 0, error: 'max_jev_calls reached' }
    d = decide(flow, state, judged.judgment, checks, now, {
      stop_hook_active: active, loop_checks: loopChecks, ...(judged.judgment ? {} : { degraded_reason: judged.error ?? 'no judgment' }),
    })
  }
  // Always enforce (policy.py apply_mode): BLOCK and ADVANCE block; ask_human writes NEEDS_HUMAN.md.
  const blocks = d.kind === BLOCK || d.kind === ADVANCE
  state = applyDecision(state, d, now)
  if (payload.session_id) state = touchAgent(state, { sessionId: payload.session_id }, now, 'stop')
  if (judged) {
    state = { ...state, jev_calls: state.jev_calls + judged.calls }
    if (!judged.judgment) state = { ...state, last_jev_error: { error: String(judged.error).slice(0, ERROR_DETAIL_CHARS), ts: now } }
  }
  state = { ...state, session_id: payload.session_id ?? state.session_id ?? null }
  if (d.question) await writeNeedsHuman(io, p, flow, state, d.question, now)
  const passed = Object.fromEntries(Object.entries(checks).filter(([, c]) => c.passed !== null).map(([k, c]) => [k, c.passed]))
  state = record(state, 'stop', {
    decision: d.kind, condition: d.condition, enforced: blocks, to_phase: d.to_phase ?? null, reason: d.reason.slice(0, REASON_JOURNAL_CHARS),
    checks: passed, probs: judged?.judgment ? judgmentProbs(judged.judgment) : null,
  }, now)
  await saveState(io, p, state)
  const noJev: Pick<StopOut, 'noJev'> = judged?.error === NO_JUDGE ? { noJev: true } : {}
  if (blocks) return { block: `${PREFIX} ${d.reason}`, ...(d.kind === ADVANCE ? { message: transitionLine(flow, state, d, prevPhase) } : {}), ...noJev }
  if (d.condition === 'goal_complete') return { message: `${PREFIX} Goal complete.`, ...noJev }
  if (d.kind === ALLOW_STOP && d.condition !== 'already_done') return { message: `${PREFIX} ${d.reason}`, ...noJev }
  return noJev
}

/** Move a finished flow to done/<id>/ with a SUMMARY.md (project.py archive). */
export async function archive(io: Io, p: Paths, outcome = 'complete'): Promise<Paths | undefined> {
  if (p.archived || !(await io.exists(p.dir))) return undefined
  const now = await io.now()
  const dst = pathsOf(p.root, p.id, true)
  try {
    const parsed = parseFlow(await readJson(io, p.flow))
    const draft = await readJson(io, p.draft) ?? {}
    await io.write(`${p.dir}/SUMMARY.md`, summaryMarkdown({
      flowId: p.id, ...(parsed.ok ? { flow: parsed.flow } : {}), state: await readJson(io, p.state) ?? {}, now, outcome,
      draft: { ...(typeof draft.goal === 'string' ? { goal: draft.goal } : {}), ...(typeof draft.created_at === 'number' ? { created_at: draft.created_at } : {}) },
    }))
  } catch { /* The summary is a courtesy. */ }
  await io.write(`${p.root}/${BASE}/${DONE}/.keep`, '')
  await io.move(p.dir, dst.dir)
  return dst
}

/** The Stop of the main session (hooks.py handle, event Stop). Fails open. */
export async function onStop(io: Io, root: string, payload: StopPayload): Promise<StopOut> {
  const p = await boundFlow(io, root, payload.session_id)
  if (!p || p.archived) return {}
  try {
    const error = await promote(io, p)
    if (error !== undefined) {
      const draft = await readJson(io, p.draft) ?? {}
      const n = Number(draft.plan_blocks ?? 0) + 1
      if (n > PLAN_BLOCK_LIMIT) {
        await archive(io, p, 'abandoned (no flow laid out)')
        return { message: `${PREFIX} flow ${p.id} was never laid out; archived as abandoned. The flow is not tracking this task.` }
      }
      await io.write(p.draft, `${JSON.stringify({ ...draft, plan_blocks: n }, null, 1)}\n`)
      return { block: `${PREFIX} Lay out the flow before stopping (${n}/${PLAN_BLOCK_LIMIT}): ${error}.\n\n${planInstructions(rel(p, p.flow), p.id, String(draft.goal ?? ''))}` }
    }
    const out = await onFlowStop(io, p, payload)
    if (!out.block && (await readJson(io, p.state))?.done === true) {
      const done = await archive(io, p)
      if (done) return { ...out, message: `${PREFIX} Goal complete. Flow archived to ${rel(done, done.dir)}/ (SUMMARY.md inside).` }
    }
    return out
  } catch (error) {
    return { message: `${PREFIX} disabled for this stop: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** StopFailure: the API error, kept in the state. */
export async function onStopFailure(io: Io, root: string, payload: { session_id?: string; error?: string; error_details?: string }): Promise<void> {
  const p = await boundFlow(io, root, payload.session_id)
  if (!p || p.archived || await isDraft(io, p)) return
  const now = await io.now()
  const flow = await loadFlow(io, p)
  const state = await loadState(io, p, flow, now)
  const err = String(payload.error ?? 'unknown').slice(0, 60)
  const last_error = { source: 'claude', error: err, details: String(payload.error_details ?? '').slice(0, ERROR_DETAIL_CHARS), session_id: payload.session_id ?? null, ts: now }
  await saveState(io, p, record({ ...state, last_error }, 'stop_failure', { error: err }, now))
}
