// The lead's Markdown plan, parsed without host access. Only the Steps section defines work.
import { SLUG } from './roles'

export const STATES = ['queued', 'implementing', 'verified', 'blocked', 'committed', 'skipped'] as const
export type PlanState = (typeof STATES)[number]
export type Step = { id: string; owner: string; after: string[]; action: string; state: PlanState; note: string }
export type Plan = { id: string; deliverables: { id: string; title: string; steps: Step[] }[] }
export class PlanError extends Error {}

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const ownerOf = (owner: string): boolean => ['main', 'analyst', 'architect', 'git-master'].includes(owner)
  || /^(dev|analyst|architect)-/.test(owner) && SLUG.test(owner.replace(/^(dev|analyst|architect)-/, ''))

export function parsePlan(text: string, id = 'plan'): Plan {
  const groups: Plan['deliverables'] = []
  let active = false
  let fence: { marker: string; length: number } | undefined
  let group: Plan['deliverables'][number] | undefined
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const boundary = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fence) {
      if (boundary && boundary[1]![0] === fence.marker && boundary[1]!.length >= fence.length && !boundary[2]!.trim()) fence = undefined
      continue
    }
    if (boundary && (boundary[1]![0] === '~' || !boundary[2]!.includes('`'))) {
      fence = { marker: boundary[1]![0]!, length: boundary[1]!.length }
      continue
    }
    if (/^## Steps\s*$/.test(line)) { active = true; group = undefined; continue }
    if (/^#{1,2} /.test(line)) { active = false; continue }
    if (!active) continue
    const heading = line.match(/^### (.+)$/)
    if (heading) {
      group = { id: '', title: heading[1]!.trim(), steps: [] }
      groups.push(group)
      continue
    }
    if (!line.startsWith('- ')) continue
    const bad = (reason: string): never => { throw new PlanError(`plan line ${index + 1}: ${reason}`) }
    const match = line.match(/^- ([^ ]+) \(([^,)]+), after: ([^)]*)\) (.+) — state: (\S+)(?:\s+(.+))?$/)
    if (!match || !group) bad('expected a step under a deliverable heading')
    const [, stepId, owner, deps, action, state, rawNote] = match!
    if (!ID.test(stepId!)) bad('step id must be kebab-case')
    if (!ownerOf(owner!)) bad('unknown owner')
    if (!STATES.includes(state as PlanState)) bad('unknown state')
    const after = deps!.trim() === '—' ? [] : deps!.split(',').map(dep => dep.trim())
    if (after.some(dep => !ID.test(dep))) bad('dependencies must be comma-separated step ids or —')
    const note = (rawNote ?? '').trim().replace(/^\((.*)\)$/, '$1')
    group!.steps.push({ id: stepId!, owner: owner!, after, action: action!.trim(), state: state as PlanState, note })
  }
  const deliverables = groups.filter(group => group.steps.length)
  deliverables.forEach((group, i) => { group.id = `T${i + 1}` })
  if (!deliverables.length) throw new PlanError('plan has no steps')
  const steps = deliverables.flatMap(group => group.steps)
  const byId = new Map<string, Step>()
  for (const step of steps) {
    if (byId.has(step.id)) throw new PlanError(`duplicate step: ${step.id}`)
    byId.set(step.id, step)
  }
  for (const step of steps) for (const dep of step.after) {
    if (!byId.has(dep)) throw new PlanError(`unknown dependency: ${step.id} -> ${dep}`)
  }
  const visited = new Set<string>(), visiting = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new PlanError(`dependency cycle at ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dep of byId.get(id)!.after) visit(dep)
    visiting.delete(id)
    visited.add(id)
  }
  steps.forEach(step => visit(step.id))
  return { id, deliverables }
}
