import type { Flow, FlowState } from './types'

// What the panel's flow card draws (`pane.tsx`): JevFlow's `status` data (phases, claims, budgets, recent decisions, NEEDS_HUMAN).

export type FlowView =
  | { kind: 'none' }
  | { kind: 'draft'; id: string; goal: string }
  | { kind: 'flow'; id: string; archived: boolean; flow: Flow; state: FlowState; needsHuman?: string }
  | { kind: 'error'; id: string; error: string }

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
