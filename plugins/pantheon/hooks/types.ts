// Shared contract for Pantheon's modules.

export type Role = 'code-reader' | 'docs-reader' | 'developer' | 'architect' | 'qa' | 'ux' | 'git'
/** One native agent's settings: the model, the reasoning effort and text appended to its prompt. */
export interface AgentConfig { model?: string; effort?: string; prompt?: string }
export interface PantheonConfig {
  disabledAgents: string[]
  agents: Record<Role, AgentConfig>
  council: { seats: Record<string, AgentConfig> }
}
export type Origin = 'default' | 'user' | 'project'
export type ConfigResult =
  | { ok: true; config: PantheonConfig; origins: Record<string, Origin> }
  | { ok: false; error: string; config: PantheonConfig }
export type { Native, Round, RoundStatus, SessionInfo, PanelView, PanelGroup } from '../types'
export type ReadFile = (path: string) => Promise<string | undefined>
export type PromptKey = Role | 'councillor'
export type RolePrompts = (key: PromptKey) => string
