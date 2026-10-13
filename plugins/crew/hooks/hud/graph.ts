// One deliverable's plan steps as a tree of text rows. Pure: no host, no clock, no render kit.
//
// The shape follows herdr-dagr (MIT OR Apache-2.0), reimplemented here for the plan's step grammar: a forest whose
// parent is a step's first dependency inside the same deliverable, one glyph per state, a `waits`/`ready` signal
// derived from the dependencies (never a field the plan declares), and settled branches folded into their root.

/** A step as the tree reads it. `view.ts` hands over ids, owners and states it has already held to its allowlists. */
export type GraphStep = { id: string; owner: string; after: readonly string[]; state: string }

export type Tone = 'done' | 'running' | 'blocked' | 'waiting' | 'ready' | 'unknown'
/** `rail` is the tree's drawing (`├─ `, `│  `), `body` the step's text; the caller picks styles by tone. */
export type GraphRow = { rail: string; body: string; tone: Tone }

const SETTLED: ReadonlySet<string> = new Set(['verified', 'committed', 'skipped'])

/** The glyph of a state, in the vocabulary dagr draws: `●` done, `◎` working, `■` blocked, `○` queued, `✗` failed, `?`. */
export function glyphOf(state: string): string {
  if (SETTLED.has(state)) return '●'
  switch (state) {
    case 'implementing': return '◎'
    case 'blocked': return '■'
    case 'queued': return '○'
    default: return '?'
  }
}

/**
 * The rows of `steps`, in declaration order within each level. `states` holds every step of the plan by id, so a
 * dependency on another deliverable counts too; an id it does not know is unmet, as in dagr.
 */
export function treeRows(steps: readonly GraphStep[], states: ReadonlyMap<string, string>): GraphRow[] {
  const byId = new Map(steps.map(step => [step.id, step] as const))
  const parent = new Map<string, string>()
  for (const step of steps) {
    const first = step.after.find(id => id !== step.id && byId.has(id))
    if (first !== undefined) parent.set(step.id, first)
  }
  // A cycle has no root: the step that closes it is drawn as a root and says so.
  const cyclic = new Set<string>()
  for (const step of steps) {
    const seen = new Set([step.id])
    for (let at = parent.get(step.id); at !== undefined; at = parent.get(at)) {
      if (seen.has(at)) {
        if (at === step.id) { parent.delete(step.id); cyclic.add(step.id) }
        break
      }
      seen.add(at)
    }
  }
  const children = new Map<string, GraphStep[]>()
  const roots: GraphStep[] = []
  for (const step of steps) {
    const up = parent.get(step.id)
    if (up === undefined) roots.push(step)
    else children.set(up, [...(children.get(up) ?? []), step])
  }

  const stateOf = (id: string) => states.get(id) ?? 'queued'
  const unmet = (step: GraphStep) => step.after.find(id => !SETTLED.has(stateOf(id)))
  const descendants = (step: GraphStep): GraphStep[] => (children.get(step.id) ?? []).flatMap(kid => [kid, ...descendants(kid)])

  const bodyOf = (step: GraphStep, folded: number): { body: string; tone: Tone } => {
    let tone: Tone = 'unknown'
    let word = '?'
    if (SETTLED.has(step.state)) { tone = 'done'; word = step.state === 'skipped' ? 'skipped' : 'done' }
    else if (step.state === 'implementing') { tone = 'running'; word = 'working' }
    else if (step.state === 'blocked') { tone = 'blocked'; word = 'blocked' }
    else if (step.state === 'queued') {
      const waiting = unmet(step)
      if (waiting !== undefined) { tone = 'waiting'; word = `waits ${waiting}` } else { tone = 'ready'; word = 'ready' }
    }
    // Dependencies the tree edge does not already show.
    const shown = parent.get(step.id)
    const others = step.after.filter(id => id !== shown && id !== step.id)
    const refs = others.length > 0 ? `  <- ${others.join(', ')}` : ''
    const fold = folded > 0 ? `  [+${folded} done]` : ''
    const loop = cyclic.has(step.id) ? '  (cycle)' : ''
    return { body: `${glyphOf(step.state)} ${step.id} ${step.owner}  ${word}${refs}${fold}${loop}`, tone }
  }

  const rows: GraphRow[] = []
  const walk = (step: GraphStep, lead: string, last: boolean, root: boolean): void => {
    const kids = children.get(step.id) ?? []
    // A settled branch is history: one row says how much it holds. An alarm is never settled, so it never folds.
    const rest = descendants(step)
    const folded = SETTLED.has(step.state) && rest.length > 0 && rest.every(kid => SETTLED.has(kid.state)) ? rest.length : 0
    rows.push({ rail: root ? '' : `${lead}${last ? '└─ ' : '├─ '}`, ...bodyOf(step, folded) })
    if (folded > 0) return
    const next = root ? '' : `${lead}${last ? '   ' : '│  '}`
    kids.forEach((kid, index) => walk(kid, next, index === kids.length - 1, false))
  }
  for (const step of roots) walk(step, '', true, true)
  return rows
}
