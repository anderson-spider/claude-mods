// The Codex job record, as far as the panel needs it. Pure: no host access.

/** The six crew roles; a Codex job runs one of them. */
export type CodexRole = 'code-reader' | 'research' | 'designer' | 'developer' | 'tester' | 'architect'

export type CodexStatus = 'running' | 'background' | 'done' | 'error' | 'cancelled' | 'lost'

/** Tokens of the job's turn. Codex's `input` already counts the `cached` part, as in its `turn.completed` usage. */
export type CodexUsage = { input: number; cached: number; output: number }

export type CodexJob = {
  id: string
  agent: CodexRole
  description: string
  status: CodexStatus
  /** The model the job was told to use; absent when Codex picks its own. */
  model?: string
  startedAt: number
  endedAt?: number
  usage?: CodexUsage
  /** What the job did last, oldest first; the card keeps the last few. */
  activity: string[]
  answer?: string
}
