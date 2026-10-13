// What the HUD may keep of an agent's activity. Pure: names from a fixed set, counts and ids of a fixed grammar,
// never an input, a command, a path or the description's text.
import type { CrewAgent, CrewToolNote } from '../../types'

/** The tools the HUD names. An `mcp__*` call is `mcp`; any other name is `?`, so a server's tool names never show. */
const TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebSearch', 'WebFetch', 'Agent', 'SubagentHandback',
  'TodoWrite', 'Skill', 'LSP', 'Monitor', 'SendMessage',
])

const STEP_ID = /^[A-Z][A-Z0-9]*[a-z]?$/
/** The calls kept per agent: the last three, newest last. */
export const TOOL_NOTES = 3
/** Ended agents kept for the timeline; running ones are never dropped. */
export const KEEP_ENDED = 12

export function toolName(raw: unknown): string {
  if (typeof raw !== 'string') return '?'
  if (TOOLS.has(raw)) return raw
  return raw.startsWith('mcp__') ? 'mcp' : '?'
}

/** The plan step a spawn's description starts with (`T3 contract suite`); nothing else of the text is read. */
export function planStepOf(description: unknown): string | undefined {
  if (typeof description !== 'string') return undefined
  const word = /^\S+/.exec(description.trimStart())?.[0]
  return word !== undefined && STEP_ID.test(word) ? word : undefined
}

export function noteTool(previous: readonly CrewToolNote[] | undefined, raw: unknown, failed: boolean): CrewToolNote[] {
  return [...(previous ?? []), { name: toolName(raw), failed }].slice(-TOOL_NOTES)
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0)

/** A step's tokens: the context is its whole input (uncached, cache read and cache write), the output adds up. */
export function tokensOf(usage: {
  input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown
}): { inTokens: number; outTokens: number } {
  return {
    inTokens: count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens),
    outTokens: count(usage.output_tokens),
  }
}

/** Every running agent, and the newest `KEEP_ENDED` ended ones in the order they were. */
export function trimEnded(list: readonly CrewAgent[], keep = KEEP_ENDED): CrewAgent[] {
  const ended = list.filter(agent => agent.status === 'ended')
  if (ended.length <= keep) return [...list]
  const drop = new Set(ended
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => (a.agent.endedAt ?? 0) - (b.agent.endedAt ?? 0) || a.index - b.index)
    .slice(0, ended.length - keep)
    .map(entry => entry.agent))
  return list.filter(agent => !drop.has(agent))
}
