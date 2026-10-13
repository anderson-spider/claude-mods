// The `dispatch` tool's work: check the call, pick the agent, its directory and effort, deliver the brief and log the
// decision. Pure: every host access is injected.
import { saveDecision, fnv1a } from './decisions'
import type { DecisionRecord } from './decisions'
import { assessEffort } from './effort'
import type { EffortIo } from './effort'
import { deliver } from './herdr'
import type { Delivery, Run } from './herdr'
import { brief, reportPath } from './report'
import { EFFORTS, ROLES, SLUG, SPECS, agentName, codexArgs, startEffort } from './roles'
import type { Effort, Role } from './roles'

export type TeamIo = EffortIo & {
  run: Run
  /** The engine requires each environment variable name to be literal. */
  env: () => Promise<{ HERDR_ENV?: string; HERDR_WORKSPACE_ID?: string; HOME?: string; JEV_API_KEY?: string }>
  /** The session's project root: the repository the team works on. */
  root: () => Promise<string>
  now: () => Promise<number>
  write: (path: string, text: string) => Promise<void>
  log: (text: string) => void
}

export const NOT_IN_HERDR = 'codex-team can only be used inside a Herdr pane (HERDR_ENV=1); nothing was started.'

export type Answer = { ok: boolean; text: string }

const refuse = (text: string): Answer => ({ ok: false, text: `codex-team: ${text}` })

/** The developer's directory: a git worktree other than the repository itself. */
async function developerDir(io: TeamIo, repo: string, cwd: unknown): Promise<{ cwd: string } | string> {
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.split('/').includes('..')) return 'the developer needs `cwd`: the absolute path of the task worktree'
  const top = await io.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return '`cwd` is not a git working tree'
  const toplevel = top.stdout.trim().replace(/\/+$/, '')
  if (toplevel === repo.replace(/\/+$/, '')) return '`cwd` is the repository itself: give the developer a worktree of its own (`git worktree add`)'
  return { cwd: toplevel }
}

/** Answers one `dispatch` call. Never throws: every failure is the answer's text. */
export async function dispatch(io: TeamIo, input: { role?: unknown; task?: unknown; slug?: unknown; cwd?: unknown; effort?: unknown }): Promise<Answer> {
  const env = await io.env().catch(() => ({}) as Awaited<ReturnType<TeamIo['env']>>)
  if (env.HERDR_ENV !== '1') return { ok: false, text: NOT_IN_HERDR }
  const workspace = env.HERDR_WORKSPACE_ID
  if (!workspace) return refuse('HERDR_WORKSPACE_ID is not set')

  const role = ROLES.find(r => r === input.role)
  if (!role) return refuse(`role must be one of ${ROLES.join(', ')}`)
  if (typeof input.task !== 'string' || !input.task.trim()) return refuse('task is empty')
  if (typeof input.slug !== 'string' || !SLUG.test(input.slug)) return refuse('slug must be lowercase letters, digits and hyphens, starting with a letter, at most 28 characters')
  if (input.effort !== undefined && !EFFORTS.includes(input.effort as Effort)) return refuse(`effort must be one of ${EFFORTS.join(', ')}`)

  const home = env.HOME
  if (!home || !home.startsWith('/')) return refuse('HOME is not an absolute path')
  const repo = (await io.root()).replace(/\/+$/, '')
  const reports = `${home.replace(/\/+$/, '')}/.claude/codex-team/reports`
  const report = reportPath(reports, repo, input.slug, role)
  const made = await io.run(['mkdir', '-p', report.slice(0, report.lastIndexOf('/'))])
  if (made.exitCode !== 0) return refuse('the reports directory could not be created')

  const spec = SPECS[role]
  let cwd = reports
  let roots: string[] = []
  if (spec.writes) {
    const dir = await developerDir(io, repo, input.cwd)
    if (typeof dir === 'string') return refuse(dir)
    cwd = dir.cwd
    roots = [reports]
  }

  const selected = await assessEffort(io, { role, task: input.task, key: env.JEV_API_KEY, home, root: repo, pinned: input.effort as Effort | undefined })
  const capped = startEffort(spec.model, selected.effort)
  const choice = { ...selected, effort: capped.effort }
  const { effort, source } = choice
  const name = agentName(role, input.slug)
  const started = await io.now()
  const ts = new Date(started).toISOString()
  const record = (delivery: Delivery, at: number): DecisionRecord => ({
    v: 2, ts, role, agent: name, model: spec.model, ...choice, taskHash: fnv1a(input.task as string),
    effortApplied: delivery.started,
    started: delivery.started, promptStatus: delivery.status, reason: delivery.reason ?? null, durationMs: Math.max(0, at - started),
  })

  const delivery = await deliver(io.run, {
    name,
    writes: spec.writes,
    workspace,
    cwd,
    codexArgs: codexArgs(spec, effort, roots),
    prompt: brief({ role, slug: input.slug, repo, cwd, task: input.task, report }),
    // `unknown` is on disk before the prompt can reach the agent, so a crash never leaves a sent task unrecorded.
    beforeSend: async started => {
      await saveDecision(io, home, record({ agent: name, started, existed: !started, status: 'unknown' }, await io.now()))
    },
  })
  await saveDecision(io, home, record(delivery, await io.now()))

  const lines = [
    `agent: ${delivery.agent}${delivery.pane ? ` (pane ${delivery.pane})` : ''}${delivery.started ? ', started now' : delivery.existed ? ', reused' : ', not started'}`,
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
