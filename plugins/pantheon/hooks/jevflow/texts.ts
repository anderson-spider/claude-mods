// Text the JevFlow port gives the lead and the user, with JevFlow's wording: the phase table and SessionStart context
// and the transition line (hooks.py), the auto-planning instructions (auto.py), and the status render
// (status.py). Only the names changed: the lead starts, joins and claims through the mcp__pantheon__flow tool instead of
// the jevflow CLI, and the flows live under .pantheon/flow/. Pure: no file, clock or command here.

import { ROLES } from './types'
import type { Decision, Flow, PhaseStatus } from './types'
import { branchOnly, FLOW_DIR_REL, isDict, pyStr, requiredPhases, utcStamp } from './project'
import type { StateView } from './project'

/** Characters of the last block reason that come back on resume or compact (hooks.py). */
export const LAST_BLOCK_CONTEXT_CHARS = 1500
/** Characters of NEEDS_HUMAN.md the status shows (status.py). */
export const NEEDS_HUMAN_CHARS = 2000
/** Stop decisions the status lists (status.py). */
export const RECENT = 8
const REASON_CHARS = 110
const GOAL_EXCERPT_CHARS = 200

const cpLen = (s: string): number => Array.from(s).length
const cpSlice = (s: string, n: number): string => Array.from(s).slice(0, n).join('')
const ljust = (s: string, width: number): string => s + ' '.repeat(Math.max(0, width - cpLen(s)))
const ts = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? utcStamp(v) : '?')

/** JevFlow regions.attempt: the phase's attempt count, 1 unless state holds a whole number of at least 1. */
export function attempt(state: StateView, phaseId: string): number {
  const n = state.phase_attempts?.[phaseId]
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : 1
}

/** JevFlow regions.idempotency_key: the key a side-effect phase passes to its action. */
export function idempotencyKey(flow: Flow, state: StateView, phaseId: string): string {
  return `${flow.flow_version}:${phaseId}:${attempt(state, phaseId)}`
}

export function phaseTable(flow: Flow, state: StateView): string {
  const status: Partial<Record<string, PhaseStatus>> = state.phase_status ?? {}
  const cur = state.current_phase
  const bo = branchOnly(flow)
  return flow.phases
    .map(p => {
      const mark = p.id === cur ? '>' : ' '
      const extra: string[] = []
      if (p.depends_on.length) extra.push(`after ${p.depends_on.join(',')}`)
      if (p.loop) extra.push(`loop<= ${p.loop.max_iterations} until \`${p.loop.until}\``)
      if (p.on_fail) extra.push(`on_fail->${p.on_fail}`)
      if (bo.has(p.id)) extra.push('branch only')
      if (p.side_effect) extra.push('side effect')
      const tail = extra.length ? ` (${extra.join('; ')})` : ''
      return `${mark} [${status[p.id] ?? 'pending'}] ${p.id}: ${p.name}${tail}`
    })
    .join('\n')
}

export function sessionContext(flow: Flow, state: StateView, source: string, needsHumanRel = 'NEEDS_HUMAN.md'): string {
  const status: Partial<Record<string, PhaseStatus>> = state.phase_status ?? {}
  const cur = state.current_phase
  const parts: string[] = [
    'The Pantheon flow is tracking this session against a declared flow. A Stop hook checks progress before you are allowed to stop.',
    `Goal: ${flow.goal}`,
    `Phases:\n${phaseTable(flow, state)}`,
  ]
  const p = flow.phases.find(ph => ph.id === cur)
  if (state.done) {
    parts.push('The goal is already complete.')
  } else if (p) {
    parts.push(`Current phase: ${p.id} (${p.name}). Done when: ${p.done_when}.` + (p.check ? ` Check: \`${p.check}\`.` : ''))
    if (p.side_effect) {
      parts.push(
        'This phase has an external side effect. Idempotency key: '
        + `\`${idempotencyKey(flow, state, p.id)}\`. A previous session may have done it before stopping, so check first `
        + 'and pass the key to the action if it accepts one. Do it at most once.',
      )
    }
  }
  const ran = flow.phases.filter(q => q.side_effect && status[q.id] === 'done')
  if (ran.length) {
    parts.push(
      `Side effects already performed, never repeat them: ${ran.map(q => `${q.id} (${idempotencyKey(flow, state, q.id)})`).join(', ')}`,
    )
  }
  const last = state.last_block_reason
  if (last && (source === 'resume' || source === 'compact')) {
    const shown = Array.from(last).length > LAST_BLOCK_CONTEXT_CHARS
      ? `${cpSlice(last, LAST_BLOCK_CONTEXT_CHARS - 3)}...`
      : last
    parts.push(`Last flow instruction before this point:\n${shown}`)
  }
  if (state.needs_human) {
    parts.push(`A human decision is pending (see ${needsHumanRel}): ${pyStr(state.needs_human)}`)
  }
  return parts.join('\n\n')
}

/** One line for the user after a phase change, for example `[Pantheon flow] ✓ package → cli (1/4 done) · Phase 'package' is complete.` */
export function transitionLine(flow: Flow, state: StateView, d: Pick<Decision, 'reason' | 'to_phase'>, frm = ''): string {
  const status: Partial<Record<string, PhaseStatus>> = state.phase_status ?? {}
  const req = requiredPhases(flow)
  const done = req.filter(pid => status[pid] === 'done').length
  const firstLine = (d.reason ?? '').split('\n')[0] ?? ''
  const first = `${(firstLine.split('. ')[0] ?? '').replace(/\.+$/, '')}.`
  const title = flow.title ? ` ${flow.title}:` : ''
  const toPhase = d.to_phase ?? ''
  const head = frm && frm !== toPhase ? `✓ ${frm} → ${toPhase}` : `→ ${toPhase}`
  return `[Pantheon flow]${title} ${head} (${done}/${req.length} done) · ${first}`
}

/** The instructions that make the lead lay the work out as phases in the flow's flow.json (`flowRel`) before it starts. */
export function planInstructions(flowRel: string, flowId: string, goal: string): string {
  const goalExcerpt = cpSlice(goal, GOAL_EXCERPT_CHARS) + (cpLen(goal) > GOAL_EXCERPT_CHARS ? '...' : '')
  const example = {
    schema_version: 1,
    title: 'Temperature converter CLI',
    goal: goalExcerpt,
    phases: [
      {
        id: 'implement', name: 'Implement', done_when: 'the feature works end to end',
        check: 'python -m pytest -q tests/test_feature.py', depends_on: [],
      },
      {
        id: 'docs', name: 'Document', done_when: 'README explains the new behaviour',
        check: "grep -q 'new flag' README.md", depends_on: ['implement'],
      },
    ],
  }
  return (
    `Pantheon flow planning: this request starts a tracked flow \`${flowId}\`.\n`
    + `Before doing the work, lay it out as phases by writing \`${flowRel}\`:\n`
    + '- keep `goal` exactly as the user asked (the full request, not the shortened example);\n'
    + '- set `title` to a short, specific name for this piece of work (3 to 6 words, what it '
    + 'delivers, for example "Temperature converter CLI", not "Build a small package"); the '
    + 'viewer and flow lists show it;\n'
    + '- 2 to 8 phases in execution order; ids are short lowercase words; use `depends_on` for order '
    + 'and to let independent phases run in parallel;\n'
    + '- each phase has `name`, a concrete `done_when`, and wherever possible a `check`: a shell '
    + 'command run from the project root that exits 0 only when the phase is really done '
    + '(tests, a file exists, grep for content). Optional: `loop` '
    + '{"max_iterations": N, "until": "cmd"}, `on_fail`: "<phase id>", `side_effect`: true '
    + 'for one-shot actions like tagging or deploying.\n'
    + `Shape (example values, replace them):\n\`\`\`json\n${JSON.stringify(example, null, 1)}\n\`\`\`\n`
    + 'Check it by calling the `mcp__pantheon__flow` tool with `action: "validate"`, then start on the first phase. '
    + 'The flow will not let you stop until it is laid out, then it tracks each phase. When you delegate a phase, '
    + 'start the Agent description with `[<phase id>]` (for example `[docs] Update the README`), and the flow claims '
    + 'that phase for the agent as its role. Agents still claim with the tool when they move to another phase, and '
    + `you claim your own phase with the tool. Do not edit other files under \`${FLOW_DIR_REL}/\`.`
  )
}

/** The prompt Claude gets after `/pantheon goal <text>`: the planning instructions, and the brainstorm's decisions if any. */
export function goalPrompt(instructions: string): string {
  return (
    '[Pantheon flow] The person started a flow with /pantheon goal.\n\n'
    + `${instructions}\n\n`
    + 'If a brainstorm defined the idea in this conversation, turn its decisions into the phases and their checks.'
  )
}

/** The prompt Claude gets after `/pantheon goal` with no text: the flow starts from the idea defined in this conversation. */
export function goalFromConversationPrompt(): string {
  return (
    '[Pantheon flow] The person ran /pantheon goal without text: turn the idea defined in this conversation into a flow. '
    + 'Call the `mcp__pantheon__flow` tool with `action: "start"`, `goal` set to the defined idea in one or two concrete '
    + 'sentences (the person\'s words where possible) and `name` set to a short kebab-case name of 2 to 5 words. Then lay out '
    + 'the phases with their checks as the tool asks, call validate, and start the first phase. If no idea has been defined '
    + 'in this conversation yet, ask the person for the goal in one question and stop.'
  )
}

/**
 * The claim sentence of JevFlow's join hint, for the join hint port: a claim names the phase taken and one of
 * Pantheon's roles, so the viewer shows the agent next to the others.
 */
export function claimInstruction(): string {
  const roles = ROLES.map(r => `\`${r}\``).join(', ')
  return (
    'then call the `mcp__pantheon__flow` tool with `action: "claim"`, `phase: "<phase id>"` and `as: "<your role>"` '
    + `for the phase you take, so the viewer shows you next to the other agents. The role is one of ${roles}.`
  )
}

/** The agents of state, grouped by the phase each one works on (agents.py by_phase). */
function agentsByPhase(state: StateView): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const a of Object.values(state.agents ?? {})) {
    if (!a.phase) continue
    const labels = out[a.phase] ?? []
    labels.push(a.label)
    out[a.phase] = labels
  }
  return out
}

/** A stop record's enforced flag: missing reads as enforced (status.py). */
const enforcedOf = (h: Record<string, unknown>): boolean => (h.enforced === undefined ? true : Boolean(h.enforced))

/**
 * The status view (status.py): phase table, budgets, the last errors, recent stop decisions and NEEDS_HUMAN.
 * `needsHuman` is the text of NEEDS_HUMAN.md, or null when the file is absent.
 */
export function render(flow: Flow, state: StateView, needsHuman: string | null = null, recent = RECENT): string {
  const status: Partial<Record<string, PhaseStatus>> = state.phase_status ?? {}
  const cur = state.current_phase
  const loops: Partial<Record<string, number>> = state.loop_iterations ?? {}
  const who = agentsByPhase(state)
  const bo = branchOnly(flow)
  const head = ['', 'PHASE', 'STATUS', 'CHECK', 'AGENTS', 'NOTES']
  const rows = flow.phases.map(p => {
    const notes: string[] = []
    if (p.depends_on.length) notes.push(`after ${p.depends_on.join(',')}`)
    if (p.loop) notes.push(`loop ${loops[p.id] ?? 0}/${p.loop.max_iterations} runs`)
    if (p.on_fail) notes.push(`on_fail->${p.on_fail}`)
    if (bo.has(p.id)) notes.push('branch only')
    return [
      p.id === cur ? '>' : '',
      p.id,
      status[p.id] ?? 'pending',
      p.check ? 'yes' : '-',
      (who[p.id] ?? []).join(', ') || '-',
      notes.join('; '),
    ]
  })
  const widths = head.map((_, i) => Math.max(cpLen(head[i] ?? ''), ...rows.map(r => cpLen(r[i] ?? ''))))
  const row = (cells: string[]): string =>
    cells.map((c, i) => ljust(c, widths[i] ?? 0)).join('  ').trimEnd()
  const lim = flow.limits
  const out: string[] = []
  if (flow.title) out.push(`Flow: ${flow.title}`)
  out.push(`Goal: ${flow.goal}`)
  out.push(`Flow version ${flow.flow_version}. Done: ${state.done ? 'yes' : 'no'}.`)
  out.push('', row(head), ...rows.map(row), '')
  out.push(
    `Blocks this session: ${state.blocks_this_session ?? 0}/${lim.max_blocks_per_session}  `
    + `Restarts: ${state.restarts ?? 0}/${lim.max_restarts}  `
    + `Jev calls: ${state.jev_calls ?? 0}/${lim.max_jev_calls}  `
    + `Started: ${ts(state.started_at)}`,
  )
  const err = state.last_error
  if (isDict(err)) out.push(`Last Claude API error: ${pyStr(err.error ?? '?')} at ${ts(err.ts)}`)
  const jerr = state.last_jev_error
  if (isDict(jerr)) out.push(`Last Jev error (checks-only fallback): ${pyStr(jerr.error ?? '?')} at ${ts(jerr.ts)}`)
  const decisions = (state.history ?? []).filter(h => isDict(h) && h.event === 'stop').slice(-recent)
  out.push('', 'Recent decisions:')
  if (!decisions.length) out.push('  (none yet)')
  for (const h of decisions) {
    let reason = h.reason ? String(h.reason).replace(/\n/g, ' ') : ''
    if (cpLen(reason) > REASON_CHARS) reason = `${cpSlice(reason, REASON_CHARS - 3)}...`
    const flag = enforcedOf(h) || h.decision === 'ALLOW_STOP' ? '' : ' (not enforced)'
    out.push(
      `  ${ts(h.ts)}  ${pyStr(h.decision)}/${pyStr(h.condition)}${flag}  [${pyStr(h.phase)}] ${reason}`,
    )
  }
  if (state.needs_human || needsHuman !== null) {
    out.push('', 'NEEDS_HUMAN:')
    const body = needsHuman ? cpSlice(needsHuman, NEEDS_HUMAN_CHARS) : null
    out.push(body ? body.trimEnd() : `  ${pyStr(state.needs_human)}`)
  }
  return out.join('\n')
}
