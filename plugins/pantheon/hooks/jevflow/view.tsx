import type { Elements } from 'claude-code'

import type { Flow, FlowState, PhaseStatus } from './types'

// The panel's Flow tab: JevFlow's `status` (phase table, claims, budgets, recent decisions, NEEDS_HUMAN) drawn as rows.

type Base = Pick<Elements['terminal'], 'Box' | 'Text'>

export type FlowView =
  | { kind: 'none' }
  | { kind: 'draft'; id: string; goal: string }
  | { kind: 'flow'; id: string; archived: boolean; flow: Flow; state: FlowState; needsHuman?: string }
  | { kind: 'error'; id: string; error: string }

const RECENT = 8
const COLOR: Record<PhaseStatus, string> = { done: 'success', active: 'warning', pending: 'inactive' }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s)

/** Depth of each phase in the DAG: roots are 0, a phase sits one below its deepest dependency. */
export function layers(flow: Flow): Record<string, number> {
  const depth: Record<string, number> = {}
  const byId = new Map(flow.phases.map(p => [p.id, p]))
  const visit = (id: string, seen: Set<string>): number => {
    if (depth[id] !== undefined) return depth[id]!
    if (seen.has(id)) return 0
    seen.add(id)
    const deps = byId.get(id)?.depends_on ?? []
    const d = deps.length ? Math.max(...deps.map(dep => visit(dep, seen) + 1)) : 0
    depth[id] = d
    return d
  }
  for (const p of flow.phases) visit(p.id, new Set())
  return depth
}

/** Who claimed or works on each phase, as `label (role)`. */
export function claimsByPhase(state: FlowState): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const a of Object.values(state.agents ?? {})) {
    if (!a?.phase) continue
    ;(out[a.phase] ??= []).push(a.role && a.role !== a.label ? `${a.label} (${a.role})` : a.label)
  }
  return out
}

export function drawFlowTab(el: Base, view: FlowView, columns: number): unknown {
  const { Box, Text } = el
  const W = Math.max(20, columns)
  if (view.kind === 'none') {
    return (
      <Box key="flow" flexDirection="column" width={W}>
        <Text key="none" dimColor>No flow in this folder. A multi-step task starts one with mcp__pantheon__flow start.</Text>
      </Box>
    )
  }
  if (view.kind === 'draft') {
    return (
      <Box key="flow" flexDirection="column" width={W}>
        <Text key="id" bold>{clip(`Flow ${view.id}`, W)}</Text>
        <Text key="draft" color="warning">Draft: phases not laid out yet.</Text>
        <Text key="goal" wrap="wrap">{`Goal: ${view.goal}`}</Text>
      </Box>
    )
  }
  if (view.kind === 'error') {
    return (
      <Box key="flow" flexDirection="column" width={W}>
        <Text key="id" bold>{clip(`Flow ${view.id}`, W)}</Text>
        <Text key="err" color="error" wrap="wrap">{view.error}</Text>
      </Box>
    )
  }
  const { flow, state } = view
  const depth = layers(flow)
  const who = claimsByPhase(state)
  const branch = new Set(flow.phases.filter(p => p.on_fail).map(p => p.on_fail!))
  const idW = Math.min(18, Math.max(...flow.phases.map(p => p.id.length + 2 * (depth[p.id] ?? 0)), 5))
  const rows = flow.phases.map(p => {
    const status = state.phase_status[p.id] ?? 'pending'
    const notes: string[] = []
    if (p.depends_on.length) notes.push(`after ${p.depends_on.join(',')}`)
    if (p.loop) notes.push(`loop ${state.loop_iterations[p.id] ?? 0}/${p.loop.max_iterations}`)
    if (p.on_fail) notes.push(`on_fail→${p.on_fail}`)
    if (branch.has(p.id)) notes.push('branch only')
    if (p.side_effect) notes.push('side effect')
    const agents = (who[p.id] ?? []).join(', ') || '-'
    const name = `${'  '.repeat(depth[p.id] ?? 0)}${p.id}`.padEnd(idW)
    const rest = clip(`${p.check ? 'check' : '-    '}  ${agents}${notes.length ? `  · ${notes.join('; ')}` : ''}`, Math.max(0, W - idW - 13))
    return (
      <Box key={`phase-${p.id}`} gap={1} width={W}>
        <Text key="cur" color="warning">{p.id === state.current_phase && !state.done ? '>' : ' '}</Text>
        <Text key="id" bold={p.id === state.current_phase}>{name}</Text>
        <Text key="st" color={COLOR[status]}>{status.padEnd(7)}</Text>
        <Text key="rest" dimColor>{rest}</Text>
      </Box>
    )
  })
  const lim = flow.limits
  const decisions = state.history.filter(h => h.event === 'stop').slice(-RECENT)
  return (
    <Box key="flow" flexDirection="column" width={W}>
      <Text key="id" bold>{clip(`Flow ${view.id}${flow.title ? ` · ${flow.title}` : ''}${view.archived ? ' (archived)' : ''}`, W)}</Text>
      <Text key="goal" wrap="wrap">{`Goal: ${flow.goal}`}</Text>
      <Text key="done" color={state.done ? 'success' : 'inactive'}>{state.done ? 'Done.' : `Current phase: ${state.current_phase}`}</Text>
      <Box key="phases" flexDirection="column" marginTop={1}>{rows}</Box>
      <Text key="budget" dimColor>{clip(`Blocks ${state.blocks_this_session}/${lim.max_blocks_per_session} · Restarts ${state.restarts}/${lim.max_restarts} · Jev calls ${state.jev_calls}/${lim.max_jev_calls}`, W)}</Text>
      <Box key="decisions" flexDirection="column" marginTop={1}>
        <Text key="h" bold>Recent decisions</Text>
        {decisions.length === 0
          ? <Text key="none" dimColor>  (none yet)</Text>
          : decisions.map((h, i) => <Text key={`d${i}`} dimColor>{clip(`  ${h.decision}/${h.condition} [${h.phase ?? '?'}] ${(h.reason ?? '').replace(/\s+/g, ' ')}`, W)}</Text>)}
      </Box>
      {state.needs_human || view.needsHuman
        ? <Text key="human" color="error" wrap="wrap">{`NEEDS_HUMAN: ${view.needsHuman ?? state.needs_human}`}</Text>
        : null}
    </Box>
  )
}
