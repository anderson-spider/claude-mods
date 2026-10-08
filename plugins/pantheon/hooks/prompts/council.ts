import { activeSeats } from '../roles'
import type { PantheonConfig } from '../types'

const COUNCIL_TRIGGER = /\b(?:councillors?|councils?|consensus|second opinions?|roundtable|multiple opinions|multiple models|several models|multi-model|conselho|consenso|segunda opini[aã]o)\b|议会|顾问团|圆桌|共识|第二意见|多方意见|多模型|多个模型|几个模型|别的模型|其他模型/i

function stripCode(text: string): string {
  let fence: { char: string; length: number; quoteDepth: number } | undefined
  const prose = text.split('\n').map(line => {
    const quote = /^(?: {0,3}>[ \t]?)+/.exec(line)?.[0] ?? ''
    const quoteDepth = quote.split('>').length - 1
    const content = line.slice(quote.length)
    if (fence && quoteDepth < fence.quoteDepth) fence = undefined
    if (fence) {
      const end = /^ {0,3}(`+|~+)\s*$/.exec(content)?.[1]
      if (quoteDepth === fence.quoteDepth && end && end[0] === fence.char && end.length >= fence.length) fence = undefined
      return ''
    }
    const start = /^ {0,3}(`{3,}|~{3,})/.exec(content)?.[1]
    if (start) {
      fence = { char: start.charAt(0), length: start.length, quoteDepth }
      return ''
    }
    return line
  }).join('\n')
  return prose.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ' ')
}

export function matchesCouncilTrigger(text: string): boolean {
  if (text.trimStart().startsWith('/')) return false
  const clean = stripCode(text)
  return !clean.trimStart().startsWith('/') && COUNCIL_TRIGGER.test(clean)
}

export function isCouncilOrigin(kind: string | undefined): boolean {
  return kind === 'composer' || kind === 'bridge'
}

export function buildCouncilBlock(config: PantheonConfig): string {
  const seats = activeSeats(config)
  if (seats.length === 0) return ''
  const calls = seats.map(name => config.council.seats[name]?.engine === 'codex'
    ? `   - ${name}: delegate({ agent: "councillor:${name}", background: true, prompt: <user task + fetched context> })`
    : `   - ${name}: Agent({ subagent_type: "pantheon:councillor-${name}", run_in_background: true, description: "Councillor on the task", prompt: <user task + fetched context> })`)
  return [
    '## Council Mode',
    '1. Fetch external resources (PR/URL/docs) FIRST and embed a concise summary in every prompt: councillors are read-only.',
    `2. Dispatch all seats (${seats.join(', ')}) independently in parallel, in the same turn, with background enabled:`,
    ...calls,
    '   Give a brief status and end the turn; completion notifications wake the session. Do not poll.',
    '3. Collect each response as it finishes (Codex: delegate_result({ jobId }); native: its completion result); retry an empty seat once. Wait until every seat has finished or failed, with no fixed deadline. Keep failed seats explicit, never omit them. A stuck seat is visible in /pantheon; cancel Codex with delegate_cancel({ jobId }) or stop the native agent, then count it as failed.',
    '4. Read the original user task and each response by exact seat name, identify agreements and contradictions, resolve disagreements with explicit reasoning, and synthesize yourself. Credit individual insights; choose and improve the best approach rather than averaging opinions.',
    'Required output (follow a host-requested checkpoint/compaction template instead when applicable):',
    '## Council Response',
    'The best synthesized answer with a clear recommendation and concrete details.',
    '## Per-Councillor Details',
    'For every exact seat name (not its model label): key insight, confidence if expressed, agreement/disagreement, or failed status.',
    '## Council Summary',
    '- Consensus Level: unanimous | majority | split',
    '- Agreed Points: shared conclusions',
    '- Disagreements: differences and their resolution',
    '- Remaining Uncertainty: caveats and untested assumptions',
    '- Recommended Action: what to do next',
  ].join('\n')
}
