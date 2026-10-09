// Shared contract for Pantheon's modules.

export type Sandbox = 'read-only' | 'workspace-write'
export type Role = 'explorer' | 'librarian' | 'fixer' | 'oracle' | 'designer' | 'git'
export type Engine = 'codex' | 'claude'
export interface RoleConfig { engine: Engine; model?: string; effort?: string; prompt?: string; sandbox?: Sandbox }
export interface Seat { engine: Engine; model?: string; effort?: string; prompt?: string }
export interface PantheonConfig {
  profile: string
  sandboxCap: Sandbox
  noNetwork: boolean
  foregroundMinutes: number
  disabledAgents: string[]
  agents: Record<Role, RoleConfig>
  council: { seats: Record<string, Seat> }
}
export type Origin = 'default' | 'settings' | 'user' | 'project'
export type ConfigResult =
  | { ok: true; config: PantheonConfig; origins: Record<string, Origin>; profiles: string[] }
  | { ok: false; error: string; config: PantheonConfig; profiles: string[] }
export interface DelegateArgs {
  agent: string; prompt: string; description?: string; cwd?: string
  model?: string; effort?: string; background?: boolean; resume?: string
}
export interface CodexCall {
  agent: string; model?: string; effort?: string; sandbox: Sandbox; noNetwork: boolean
  prompt: string; cwd: string; skipGitRepoCheck: boolean; resumeSessionId?: string
}
import type { Tokens } from '../types'
export type { Job, JobStatus, Tokens, Native, Round, RoundStatus, SessionInfo, PanelView, PanelGroup } from '../types'
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
export type PromptKey = Role | 'councillor'
export type RolePrompts = (key: PromptKey, engine: Engine) => string
