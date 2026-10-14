// The `dispatch` tool's work: check the call, pick the agent, its directory and effort, deliver the brief and log the
// decision. Pure: every host access is injected.
import { saveDecision, fnv1a } from './decisions'
import type { DecisionRecord } from './decisions'
import { assessEffort, JEV_MODEL } from './effort'
import type { EffortIo } from './effort'
import { deliver, isTeamName, listAgents } from './herdr'
import type { Delivery, Run } from './herdr'
import { brief, reportPath, reviewTask } from './report'
import { EFFORTS, ROLES, SLUG, SPECS, agentName, codexArgs, startEffort } from './roles'
import type { Effort, Role } from './roles'
import { finishAgent } from './finish'
import type { Finish } from './finish'

export type TeamIo = EffortIo & {
  run: Run
  /** The engine requires each environment variable name to be literal. */
  env: () => Promise<{ HERDR_ENV?: string; HERDR_WORKSPACE_ID?: string; HERDR_PANE_ID?: string; HOME?: string; JEV_API_KEY?: string }>
  sleep: (ms: number) => Promise<void>
  /** The session's project root: the repository the team works on. */
  root: () => Promise<string>
  now: () => Promise<number>
  write: (path: string, text: string) => Promise<void>
  log: (text: string) => void
  store: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void>; delete: (key: string) => Promise<void> }
  publish?: (root: string) => Promise<void>
}

export const NOT_IN_HERDR = 'codex-team can only be used inside a Herdr pane (HERDR_ENV=1); nothing was started.'

export type Answer = { ok: boolean; text: string }

const refuse = (text: string): Answer => ({ ok: false, text: `codex-team: ${text}` })

type DeveloperTask = { cwd: string; task: string }
function developerTask(value: unknown): DeveloperTask | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<DeveloperTask>
  return typeof record.cwd === 'string' && record.cwd.startsWith('/') && typeof record.task === 'string'
    ? { cwd: record.cwd, task: record.task } : undefined
}

/** The developer's directory: a git worktree other than the repository itself. */
async function developerDir(io: TeamIo, repo: string, cwd: unknown): Promise<{ cwd: string } | string> {
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.split('/').includes('..')) return 'the developer needs `cwd`: the absolute path of the task worktree'
  const top = await io.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return '`cwd` is not a git working tree'
  const toplevel = top.stdout.trim().replace(/\/+$/, '')
  if (toplevel === repo.replace(/\/+$/, '')) return '`cwd` is the repository itself: give the developer a worktree of its own (`git worktree add`)'
  return { cwd: toplevel }
}

type Input = { role?: unknown; task?: unknown; slug?: unknown; cwd?: unknown; effort?: unknown }
let dispatchQueue: Promise<void> = Promise.resolve()

/** One queue for the entire plugin: context reads and all delivery effects run without interleaving. */
export function dispatch(io: TeamIo, input: Input): Promise<Answer> {
  return queued(() => dispatchTask(io, input))
}

function queued<T>(action: () => Promise<T>): Promise<T> {
  const result = dispatchQueue.then(action)
  dispatchQueue = result.then(() => undefined, () => undefined)
  return result
}

async function finishInWorkspace(io: TeamIo, env: Awaited<ReturnType<TeamIo['env']>>, agent: string): Promise<Finish> {
  const ts = new Date(await io.now()).toISOString()
  const result = await finishAgent(io.run, io.sleep, { agent, workspace: env.HERDR_WORKSPACE_ID!, leadPane: env.HERDR_PANE_ID })
  await saveDecision(io, env.HOME, { v: 2, action: 'finish', ts, agent, uuid: result.uuid, closed: result.closed, archived: result.archived, reason: result.reason ?? null })
  return result
}

/** Explicit finish shares dispatch's queue and automatic shared-agent retirement. */
export function finish(io: TeamIo, input: { agent?: unknown }): Promise<Answer> {
  return queued(async () => {
    const env = await io.env().catch(() => ({}) as Awaited<ReturnType<TeamIo['env']>>)
    if (env.HERDR_ENV !== '1') return { ok: false, text: NOT_IN_HERDR }
    if (!env.HERDR_WORKSPACE_ID) return refuse('HERDR_WORKSPACE_ID is not set')
    if (typeof input.agent !== 'string' || !isTeamName(input.agent)) return refuse('agent must be a Codex team name')
    const result = await finishInWorkspace(io, env, input.agent)
    return { ok: result.archived, text: [
      `agent: ${result.agent}`,
      `closed: ${result.closed ? `pane ${result.pane}${result.tab ? ` and task tab ${result.tab}` : ''}` : 'nothing'}`,
      `archived: ${result.archived ? 'yes' : 'no'}${result.reason ? ` (${result.reason})` : ''}`,
    ].join('\n') }
  })
}

async function dispatchTask(io: TeamIo, input: Input): Promise<Answer> {
  const env = await io.env().catch(() => ({}) as Awaited<ReturnType<TeamIo['env']>>)
  if (env.HERDR_ENV !== '1') return { ok: false, text: NOT_IN_HERDR }
  const workspace = env.HERDR_WORKSPACE_ID
  if (!workspace) return refuse('HERDR_WORKSPACE_ID is not set')

  const role = ROLES.find(r => r === input.role)
  if (!role) return refuse(`role must be one of ${ROLES.join(', ')}`)
  if (role !== 'reviewer' && (typeof input.task !== 'string' || !input.task.trim())) return refuse('task is empty')
  if (input.task !== undefined && typeof input.task !== 'string') return refuse('task must be text')
  if (typeof input.slug !== 'string' || !SLUG.test(input.slug)) return refuse('slug must be lowercase letters, digits and hyphens, starting with a letter, at most 22 characters')
  if (input.effort !== undefined && !EFFORTS.includes(input.effort as Effort)) return refuse(`effort must be one of ${EFFORTS.join(', ')}`)

  const home = env.HOME
  if (!home || !home.startsWith('/')) return refuse('HOME is not an absolute path')
  const repo = (await io.root()).replace(/\/+$/, '')
  const reports = `${home.replace(/\/+$/, '')}/.claude/codex-team/reports`
  const report = reportPath(reports, repo, input.slug, role)
  const key = `developer:${repo}:${input.slug}`
  const original = role === 'developer' || role === 'reviewer' ? developerTask(await io.store.get(key)) : undefined
  let task = (input.task as string | undefined) ?? ''
  if (role === 'reviewer') {
    if (!original) return refuse('delivery: not_sent (no developer was dispatched for this slug)')
    const agents = await listAgents(io.run)
    if (typeof agents === 'string') return refuse(`delivery: not_sent (${agents})`)
    const dev = agents.find(agent => agent.name === `dev-${input.slug}`)
    if (dev && ['working', 'blocked'].includes(dev.agent_status ?? '')) return refuse(`delivery: not_sent (dev-${input.slug} is ${dev.agent_status})`)
    task = reviewTask({ ...original, report: reportPath(reports, repo, input.slug, 'developer') }, task)
  }
  const made = await io.run(['mkdir', '-p', report.slice(0, report.lastIndexOf('/'))])
  if (made.exitCode !== 0) return refuse('the reports directory could not be created')

  const spec = role === 'reviewer' ? {
    ...SPECS.architect,
    instructions: 'You are the reviewer of a team led by another agent. Review the recorded developer task against the complete uncommitted worktree and its AGENTS.md rules. Write only the named reviewer report; leave the repository untouched.',
  } : SPECS[role]
  let cwd = reports
  let roots: string[] = []
  if (spec.writes) {
    const dir = await developerDir(io, repo, input.cwd)
    if (typeof dir === 'string') return refuse(dir)
    cwd = dir.cwd
    if (original && original.cwd !== cwd) return refuse('this slug was dispatched in another worktree; use a new slug')
    roots = [reports]
  }

  const selected = role === 'reviewer'
    ? { effort: 'xhigh' as const, source: 'review-policy' as const, jevModel: JEV_MODEL, expected: null, jevReason: null }
    : await assessEffort(io, { role, task, key: env.JEV_API_KEY, home, root: repo, pinned: input.effort as Effort | undefined })
  const capped = startEffort(spec.model, selected.effort)
  const choice = { ...selected, effort: capped.effort }
  const { effort, source } = choice
  const name = agentName(role, input.slug)
  const started = await io.now()
  const ts = new Date(started).toISOString()
  const record = (delivery: Delivery, at: number): DecisionRecord => ({
    v: 2, ts, role, agent: delivery.agent, model: spec.model, ...choice, taskHash: fnv1a(task),
    effortApplied: delivery.started,
    started: delivery.started, promptStatus: delivery.status, reason: delivery.reason ?? null, durationMs: Math.max(0, at - started),
  })

  let createdRecord = false
  const delivery = await deliver(io.run, {
    name,
    analystSlug: role === 'analyst' ? input.slug : undefined,
    finishShared: agent => finishInWorkspace(io, env, agent),
    reviewDeveloper: role === 'reviewer' ? `dev-${input.slug}` : undefined,
    writes: spec.writes,
    workspace,
    cwd,
    codexArgs: codexArgs(spec, effort, roots),
    prompt: brief({ role, slug: input.slug, repo: role === 'reviewer' ? original!.cwd : repo, cwd, task, report }),
    // `unknown` is on disk before the prompt can reach the agent, so a crash never leaves a sent task unrecorded.
    beforeSend: async (started, agent) => {
      if (role === 'developer' && !original) {
        await io.store.set(key, { cwd, task })
        createdRecord = true
      }
      await saveDecision(io, home, record({ agent, started, existed: !started, status: 'unknown' }, await io.now()))
    },
  }).catch(async error => {
    if (createdRecord) await io.store.delete(key)
    throw error
  })
  if (createdRecord && delivery.status === 'not_sent') await io.store.delete(key)
  await saveDecision(io, home, record(delivery, await io.now()))
  if (io.publish) await io.publish(repo).catch(() => io.log('codex-team: dagr not published (publication failed)'))

  const lines = [
    `agent: ${delivery.agent}${delivery.pane ? ` (pane ${delivery.pane})` : ''}${delivery.started ? ', started now' : delivery.existed ? delivery.status === 'not_sent' ? ', already live' : ', reused' : ', not started'}`,
    `role: ${role}, model ${spec.model}, effort ${effort} (${source})${capped.reason ? `, ${capped.reason}` : ''}${delivery.existed ? ', not applied: reused agent keeps its start effort' : ''}`,
    `delivery: ${delivery.status}${delivery.reason ? ` (${delivery.reason})` : ''}`,
    `report: ${report}`,
    delivery.status === 'confirmed'
      ? `next: \`herdr agent wait ${delivery.agent}\`, then read the report.`
      : delivery.status === 'unknown'
        ? `next: do not send it again; check with \`herdr agent get ${delivery.agent}\` and \`herdr agent wait ${delivery.agent}\`.`
        : 'next: fix the cause, then dispatch again.',
  ]
  return { ok: delivery.status !== 'not_sent', text: lines.join('\n') }
}

export type { Role }
