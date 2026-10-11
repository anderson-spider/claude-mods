// What each crew role may do on Codex. Pure: no host access.
import type { CodexRole } from './types'

export type CodexSandbox = 'read-only' | 'workspace-write'

export type RoleLane = {
  sandbox: CodexSandbox
  /** Where the role's final answer is written (relative to the repository), by job name. */
  output?: (name: string) => string
}

export const CODEX_LANES: Record<CodexRole, RoleLane> = {
  'code-reader': { sandbox: 'read-only' },
  research: { sandbox: 'read-only', output: name => `.crew/research/${name}.md` },
  architect: { sandbox: 'read-only', output: name => `.crew/reviews/${name}.md` },
  developer: { sandbox: 'workspace-write' },
  designer: { sandbox: 'workspace-write' },
  tester: { sandbox: 'workspace-write' },
}

export function isCodexRole(value: unknown): value is CodexRole {
  return typeof value === 'string' && Object.hasOwn(CODEX_LANES, value)
}

/** A role whose sandbox lets it write inside the repository. */
export function isWriteRole(role: CodexRole): boolean {
  return CODEX_LANES[role].sandbox === 'workspace-write'
}

const SLUG_MAX = 40
// Far above a real job id (17 characters), so only a hostile id is cut.
const ID_MAX = 64

function slug(text: string, max: number): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, max).replace(/-+$/, '')
}

/**
 * The file name (no extension) of a job's output: a slug of the description, then the job id so two
 * jobs never share a file. Only `a-z`, `0-9` and `-`, so it holds no `/` and no `..`.
 */
export function outputName(description: string, jobId: string): string {
  return [slug(description, SLUG_MAX), slug(jobId, ID_MAX)].filter(Boolean).join('-') || 'job'
}
