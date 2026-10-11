// Pure reader for `codex exec --json`: JSONL text in, events out. It decides nothing about the outcome; jobs.ts does,
// from `completed` (turn.completed), `failed` (turn.failed) and the exit code. A top-level `error` is only a `note`:
// Codex retries transient errors and the turn can still complete.

export type Tokens = {
  input: number
  cached: number
  output: number
  /** reasoning_output_tokens, when Codex reports it. */
  reasoning?: number
  /** cache_write_input_tokens, when Codex reports it. */
  cacheWrite?: number
}

export type CodexEvent =
  | { kind: 'session'; sessionId: string }
  /** turn.started: the turn began. Without a terminal event after it, the run was interrupted (or died). */
  | { kind: 'started' }
  | { kind: 'activity'; text: string }
  /** An agent_message; the last one of a turn is the answer. */
  | { kind: 'message'; text: string }
  /** Paths of a completed file_change item. */
  | { kind: 'files'; paths: string[] }
  /** turn.completed: the turn succeeded. `tokens` is absent when the usage was missing or malformed. */
  | { kind: 'completed'; tokens?: Tokens }
  /** turn.failed: the turn failed with this message. */
  | { kind: 'failed'; error: string }
  /** A top-level `error` event: a diagnostic that may be retried, never a failure by itself. */
  | { kind: 'note'; text: string }
  /** An `error` item: Codex's way to show a warning (for example missing model metadata). Not a failure, not a note. */
  | { kind: 'warning'; text: string }

const ACTIVITY_MAX = 200

/**
 * A Codex thread id as 0.162 writes it: a UUID. Anything else is refused wherever an id is read (this stream, a job
 * record, the `resume` argv): the JSONL sits in the repository a write job can edit, and an id is placed in argv.
 */
export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isThreadId = (value: unknown): value is string => typeof value === 'string' && THREAD_ID.test(value)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function clip(text: string): string {
  return text.length > ACTIVITY_MAX ? `${text.slice(0, ACTIVITY_MAX - 1)}…` : text
}

function message(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function readTokens(usage: unknown): Tokens | undefined {
  if (!isRecord(usage)) return undefined
  const cached = usage.cached_input_tokens === undefined ? 0 : usage.cached_input_tokens
  if (!isTokenCount(usage.input_tokens) || !isTokenCount(cached) || !isTokenCount(usage.output_tokens)) return undefined
  const tokens: Tokens = { input: usage.input_tokens, cached, output: usage.output_tokens }
  if (isTokenCount(usage.reasoning_output_tokens)) tokens.reasoning = usage.reasoning_output_tokens
  if (isTokenCount(usage.cache_write_input_tokens)) tokens.cacheWrite = usage.cache_write_input_tokens
  return tokens
}

function changedPaths(item: Record<string, unknown>): string[] {
  if (!Array.isArray(item.changes)) return []
  return item.changes.flatMap(change =>
    isRecord(change) && typeof change.path === 'string' && change.path ? [change.path] : [])
}

function parseItem(phase: 'item.started' | 'item.updated' | 'item.completed', item: unknown): CodexEvent[] {
  if (!isRecord(item) || typeof item.type !== 'string') return []
  const done = phase === 'item.completed'

  switch (item.type) {
    case 'agent_message':
      // Only a completed message is final text; a started or updated one may be empty or partial.
      return done && typeof item.text === 'string' ? [{ kind: 'message', text: item.text }] : []
    case 'command_execution': {
      if (typeof item.command !== 'string') return []
      const exit = done && typeof item.exit_code === 'number' ? ` → ${item.exit_code}` : ''
      return [{ kind: 'activity', text: clip(`$ ${item.command}${exit}`) }]
    }
    case 'file_change': {
      const paths = changedPaths(item)
      const events: CodexEvent[] = [{ kind: 'activity', text: clip(paths.length ? `file_change: ${paths.join(', ')}` : 'file_change') }]
      if (done && paths.length && item.status !== 'failed') events.push({ kind: 'files', paths })
      return events
    }
    case 'mcp_tool_call': {
      const name = [item.server, item.tool].filter((part): part is string => typeof part === 'string' && part !== '').join('/')
      return [{ kind: 'activity', text: clip(name ? `mcp: ${name}` : 'mcp_tool_call') }]
    }
    case 'web_search':
      return [{ kind: 'activity', text: clip(typeof item.query === 'string' && item.query ? `web search: ${item.query}` : 'web_search') }]
    case 'todo_list': {
      if (!Array.isArray(item.items)) return [{ kind: 'activity', text: 'todo_list' }]
      const finished = item.items.filter(entry => isRecord(entry) && entry.completed === true).length
      return [{ kind: 'activity', text: `todo: ${finished}/${item.items.length}` }]
    }
    case 'error':
      return [{ kind: 'warning', text: message(item.message, 'Codex reported an error item without a message') }]
    default:
      // reasoning and any item type a newer Codex adds.
      return [{ kind: 'activity', text: item.type }]
  }
}

export function parseEvent(obj: unknown): CodexEvent[] {
  if (!isRecord(obj)) return []

  switch (obj.type) {
    case 'thread.started':
      if (isThreadId(obj.thread_id)) return [{ kind: 'session', sessionId: obj.thread_id }]
      // Not a UUID (a forged line, `--last`, a flag): never adopted as the session to resume.
      return obj.thread_id === undefined ? [] : [{ kind: 'activity', text: 'thread.started with an invalid thread id (ignored)' }]
    case 'turn.started':
      return [{ kind: 'started' }]
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return parseItem(obj.type, obj.item)
    case 'turn.completed': {
      const tokens = readTokens(obj.usage)
      return [tokens ? { kind: 'completed', tokens } : { kind: 'completed' }]
    }
    case 'turn.failed':
      return [{ kind: 'failed', error: message(isRecord(obj.error) ? obj.error.message : undefined, 'Codex reported turn.failed without a message') }]
    case 'error':
      return [{ kind: 'note', text: message(obj.message, 'Codex reported error without a message') }]
    default:
      return []
  }
}

function parseLine(line: string): CodexEvent[] {
  if (!line.trim()) return []
  try {
    return parseEvent(JSON.parse(line))
  } catch {
    return []
  }
}

export type JsonlReader = { push(text: string): CodexEvent[]; end(): CodexEvent[] }

/** Chunks need not be whole lines: a partial line waits in the buffer until its newline (or `end`). */
export function createJsonlReader(): JsonlReader {
  let buffer = ''
  return {
    push(text) {
      buffer += text
      const events: CodexEvent[] = []
      let start = 0
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        events.push(...parseLine(buffer.slice(start, newline)))
        start = newline + 1
        newline = buffer.indexOf('\n', start)
      }
      buffer = buffer.slice(start)
      return events
    },
    end() {
      const tail = buffer
      buffer = ''
      return parseLine(tail)
    },
  }
}
