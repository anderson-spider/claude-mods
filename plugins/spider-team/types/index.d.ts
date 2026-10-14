// Session-local identity cache and bounded observations survive compatible reloads.
export type Role = 'analyst' | 'developer' | 'reviewer' | 'architect'
export type Pair = { model: 'opus' | 'sonnet' | 'haiku'; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
export type ReportInput = {
  status: 'done' | 'blocked' | 'partial' | 'no-changes'
  summary: string
  verdict: 'APPROVED' | 'CHANGES' | 'BLOCKED' | 'NONE'
  body: string
  worktreePath?: string
  worktreeBranch?: string
}
export type ReportRecord = {
  id: string; path: string; receipt: string; status: ReportInput['status']; verdict: ReportInput['verdict']; generation: number
  worktreePath?: string; worktreeBranch?: string
}
export type Run = {
  key: number; toolId: string; settled?: boolean; linked?: boolean; role: Role; agentId?: string
  taskHash: string; requested: Partial<Pair>; selected: Pair; forwarded: Pair
  profile: string | null; source: 'jev' | 'default' | 'pinned' | 'override'; cap: boolean
  jevAsked: boolean; jevReason: string | null; dimensions: Record<string, number | string>; dimensionsUsed: boolean
  expected: Record<string, number> | null; taskType: Record<string, number> | null
  root: string; home: string; base?: string; commonDir?: string
  status: 'pending' | 'running' | 'launched' | 'done' | 'partial' | 'blocked'; finished: boolean
  observed: { model: string; effort: string | number | null }[]
  turns: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; durationMs: number }>
  durationMs: number | null; handbackChars: number | null; receiptChars: number | null
}
export type Observation = Pick<Run, 'status' | 'finished' | 'observed' | 'turns' | 'durationMs' | 'handbackChars' | 'receiptChars'>
export type Context = Pick<Run, 'toolId' | 'agentId' | 'role' | 'home' | 'root' | 'base' | 'commonDir' | 'status' | 'finished'> & { key: number; ambiguous?: boolean; report?: ReportRecord; nativePath?: string; nativeBranch?: string }
export type Runtime = { version?: 2; namespace?: string; counter: number; runs: Record<string, Run>; observations?: Record<string, Observation>; retained?: { kind: 'call' | 'child'; id: string }[]; references?: Record<string, Context> }
export type IdentityCache = { version: 1; entries: { id: string; type: string }[] }
declare module 'claude-code' {
  interface PluginState { 'spider-team': { runtime: Runtime; identities: IdentityCache } }
  interface McpToolInputs {
    'mcp__spider-team__report': ReportInput
    'mcp__spider-team__diff': { report: string; file?: string }
  }
}
