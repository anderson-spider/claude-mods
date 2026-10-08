// Contrato compartilhado entre os módulos do Pantheon. Congelado depois da Task 1:
// mudanças passam pelo orchestrator e são propagadas a todas as frentes.

export type Sandbox = 'read-only' | 'workspace-write'
export type CodexRole = 'explorer' | 'librarian' | 'fixer'
export type NativeRole = 'oracle' | 'designer'
export interface RoleOverride { model?: string; effort?: string; prompt?: string; sandbox?: Sandbox }
export interface Seat { engine: 'codex' | 'claude'; model?: string; effort?: string; prompt?: string }
export interface PantheonConfig {
  sandboxCap: Sandbox
  noNetwork: boolean
  foregroundMinutes: number
  disabledAgents: string[]
  agents: Record<CodexRole | NativeRole, RoleOverride>
  council: { seats: Record<string, Seat> }
}
export type Origin = 'default' | 'user' | 'project'
export type ConfigResult =
  | { ok: true; config: PantheonConfig; origins: Record<string, Origin> }
  | { ok: false; error: string; config: PantheonConfig }
export interface DelegateArgs {
  agent: string; prompt: string; description?: string; cwd?: string
  model?: string; effort?: string; background?: boolean; resume?: string
}
export interface CodexCall {
  agent: string; model?: string; effort?: string; sandbox: Sandbox; noNetwork: boolean
  prompt: string; cwd: string; skipGitRepoCheck: boolean; resumeSessionId?: string
}
import type { Tokens } from '../types'
export type { Job, JobStatus, Tokens, Native, Round, RoundStatus, SessionInfo, PanelView } from '../types'
export type CodexEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'activity'; text: string }
  | { kind: 'message'; text: string }
  | { kind: 'usage'; tokens: Tokens }
  | { kind: 'failed'; error: string }
export type SpawnChunk = { stream: 'stdout' | 'stderr'; text: string }
export type SpawnEnd = { code: number | null; signal?: string | null }
export type Spawn = (req: { argv: string[]; cwd: string; input: string }) =>
  AsyncIterable<SpawnChunk> & { result: Promise<SpawnEnd>; return?: () => unknown }
export type ReadFile = (path: string) => Promise<string | undefined>
/** realPath do caminho, ou undefined se não existir. */
export type StatReal = (path: string) => Promise<string | undefined>
export interface Clock {
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => { cancel: () => void }
}
export interface Codec {
  buildArgv: (call: CodexCall) => string[]
  createJsonlReader: () => { push(text: string): CodexEvent[]; end(): CodexEvent[] }
}
export type PromptKey = CodexRole | NativeRole | 'councillor'
export type RolePrompts = (key: PromptKey) => string
