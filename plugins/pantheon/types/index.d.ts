// Contrato do $.state do Pantheon (autocontido: sem imports).

export type RoundStatus = 'running' | 'done' | 'failed' | 'stopped' | 'lost'
export type Round = { turnId?: string; startedAt: number; endedAt?: number; status: RoundStatus }
export type Native = {
  id: string; role: string; type: string; task: string; model: string
  rounds: Round[]; ctx: number; out: number; steps: number; lastTool?: string
}
export type SessionInfo = {
  model?: string; effort?: string
  context?: { tokens: number | null; window: number; percent: number | null }
  isRunning: boolean; turnStartedAt?: number; lastTurnMs?: number
  turns?: { startedAt: number; endedAt: number }[]
  /** US dollars the session has cost so far, as the host's ledger totals it. */
  costUsd?: number
}
export type PanelGroup = 'running' | 'idle'
export type PanelView = { collapsed?: PanelGroup[] }
/**
 * A subagent the flow controller linked to a task: the `[<taskId>]` its description started with, read at spawn.
 * `work` is the task's developer or ux, `review` a qa or architect spawned for a receipt the task awaited, `diagnosis`
 * the architect asked to diagnose a task that ran out of attempts (its return is not a receipt).
 */
export type FlowAgent = {
  task: string
  plan: string
  kind: 'work' | 'review' | 'diagnosis'
  by?: 'qa' | 'architect'
  /** The task's end count when the agent was spawned: a reviewer answers for that delivery. */
  end: number
  /** Writes the controller refused (enforce) or would have (shadow) outside the task's files since its last return. */
  denials: number
  /** The task's files, kept only when the flow was live at spawn: what the agent may write. */
  files?: string[]
  /** For a subagent spawned by a task's agent: the work agent whose task and files it inherited, whose return it never is. */
  root?: string
  /** The repository's HEAD and working-tree digest when a QA agent was spawned. */
  git?: { head: string; dirty: string }
}

/**
 * What the flow controller keeps in the plugin's own store (`$.store`: a JSON file under the Claude Code configuration
 * directory, `~/.claude/plugins/store/pantheon_<install source>-<hash>.json`), under the key
 * `flow.attest.<first 32 hex digits of sha256(real path of the repository root)>.<planId>`: the record of what the person
 * approved. Written only by `/pantheon flow approve` and by an adopted plan edit; a snapshot
 * (`.pantheon/flow/<planId>/approved.json`) is believed only while it is exactly the flow this record names, so no edit of the
 * repository can make the flow run another command. The plan in force is the record `flow.active.<same digits>`
 * (`{ planId, plan }`), written by the same command, which the pointer files under `.pantheon/flow/` only echo.
 *
 * The store is outside the repository and no other plugin or hook can write it through the plugin API. It is not out of reach of
 * a Bash call or a Write to that path: the boundary there is the person's own permission rules (for example
 * `Edit(~/.claude/plugins/store/**)` and a Bash rule on the same path). The file's name carries the install source, so loading
 * the plugin another way (`--plugin-dir` against the marketplace copy) is another store: approvals read as unattested until
 * `/pantheon flow approve` runs again.
 */
export type FlowAttest = {
  /** The hash of the plan block the person approved. */
  approvedHash: string
  /** The hash of the flow in force once amendments were adopted over the approval. */
  adoptedHash?: string
  /** The hash of the flow in the snapshot: `adoptedHash` when there is one, else `approvedHash`. */
  snapshotHash: string
  /** The tasks adopted over the approval: their text is not the person's. */
  adopted?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    pantheon: { natives: Native[]; session: SessionInfo; view: PanelView; gateHeld: { message: string } | null; flowAgents: Record<string, FlowAgent> }
  }
}
