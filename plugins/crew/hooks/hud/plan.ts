import { CREW_TYPES } from '../agents'
import { redact } from '../redact'
import type { RedactContext } from '../redact'

export type PlanGroup = {
  heading: string
  done: number
  running: number
  left: number
  runningSteps: { id: string; owner: string }[]
  unknownStates: boolean
}

export type Plan = { name: string; groups: PlanGroup[]; open: boolean; malformed?: boolean }
export type PlanFile = { basename: string; text: string }

const ID = /^[A-Z][A-Z0-9]*[a-z]?$/
const OWNERS = new Set(['lead', ...CREW_TYPES])
const MAX_LABEL = 120

/** Only redacted, printable and bounded projections are retained for display. */
function label(value: string, context: RedactContext): string {
  // URLs, hostname-like identifiers and path fragments are never suitable as screen labels.
  // Reject the whole label so credentials/query strings cannot survive partial replacement.
  if (/[a-z][a-z0-9+.-]*:\/\/|(?:^|\s)(?:[\w-]+\.)+[a-z]{2,}(?:[/:?#]|\b)|(?:^|\s|["'`(])(?:\/|~\/|\.\.?\/|[a-z]:\\)|(?:^|\s)[^\s/]+\/[^\s/]+/i.test(value)) return '?'
  const safe = redact(value, context).replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, MAX_LABEL).trim()
  return safe || '?'
}

function group(heading: string): PlanGroup {
  return { heading, done: 0, running: 0, left: 0, runningSteps: [], unknownStates: false }
}

export function parsePlan(basename: string, text: string, context: RedactContext): Plan {
  const name = label(basename.replace(/\.md$/i, ''), context)
  const groups: PlanGroup[] = []
  const ids = new Set<string>()
  let current: PlanGroup | undefined
  let inSteps = false
  let stepCandidates = 0
  let fence: { marker: string; length: number } | undefined

  for (const line of text.split(/\r?\n/)) {
    const boundary = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (boundary) {
      const marker = boundary[1]!.charAt(0)
      if (!fence) fence = { marker, length: boundary[1]!.length }
      else if (marker === fence.marker && boundary[1]!.length >= fence.length && /^\s*$/.test(line.slice(boundary[0].length))) fence = undefined
      continue
    }
    if (fence) continue
    if (/^## /.test(line)) {
      inSteps = line.trim() === '## Steps'
      current = undefined
      continue
    }
    if (!inSteps) continue
    if (line.startsWith('### ')) {
      current = group(label(line.slice(4), context))
      groups.push(current)
      continue
    }
    // A candidate without a valid state must not silently disappear as a closed plan.
    if (/^- [A-Z][A-Z0-9]*[a-z]? \(/.test(line)) stepCandidates++
    // The action and note never enter the result. Require the entire step prefix and a final state marker.
    const step = /^- ([A-Z][A-Z0-9]*[a-z]?) \(([^(),]+), after: (?:—|[A-Z][A-Z0-9]*[a-z]?(?:, [A-Z][A-Z0-9]*[a-z]?)*)\) (.+) — state: (.+)$/.exec(line)
    if (!step || !ID.test(step[1]!) || ids.has(step[1]!)) continue
    const actionAndState = `${step[3]!} — state: ${step[4]!}`
    const marker = actionAndState.lastIndexOf(' — state: ')
    const tail = actionAndState.slice(marker + ' — state: '.length).trim()
    // A note begins at the first space-parenthesis and may itself contain parentheses.
    const state = tail.replace(/ \([\s\S]*\)$/, '').trim()
    if (!state || !actionAndState.slice(0, marker).trim()) continue
    ids.add(step[1]!)
    if (!current) {
      current = group(name)
      groups.push(current)
    }
    if (state === 'verified' || state === 'committed' || state === 'skipped') current.done++
    else if (state === 'implementing' || state === 'ready for QA' || state === 'fixes requested') {
      current.running++
      current.runningSteps.push({ id: step[1]!, owner: OWNERS.has(step[2]!) ? step[2]! : '?' })
    } else {
      current.left++
      if (state !== 'queued' && state !== 'blocked') current.unknownStates = true
    }
  }
  if (stepCandidates > 0 && ids.size === 0) return { name, groups: [], open: true, malformed: true }
  return { name, groups, open: groups.some(g => g.running + g.left > 0) }
}

/** Show active plans in file-name order; closed and empty plans are omitted. */
export function selectPlans(files: readonly PlanFile[], context: RedactContext): (Plan | { state: 'unknown' })[] {
  return [...files].sort((a, b) => a.basename < b.basename ? -1 : a.basename > b.basename ? 1 : 0)
    .map(file => parsePlan(file.basename, file.text, context)).filter(plan => plan.open)
    .map(plan => plan.malformed ? { state: 'unknown' as const } : plan)
}
