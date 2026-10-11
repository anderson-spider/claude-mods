// The `codex exec` command line of a job. Pure: no host access.
import { isThreadId } from './events'
import { isCodexRole, CODEX_LANES, isWriteRole } from './roles'
import type { CodexRole } from './types'

export type CodexArgvInput = {
  role: CodexRole
  /** The role's prompt, sent as `developer_instructions`. */
  rolePrompt: string
  model?: string
  /** The file `-o` writes the final answer to. */
  output?: string
  /** The session (thread) id to resume: a UUID, or the argv is refused. */
  resume?: string
  /** Let Codex's auto-review answer a request to leave the sandbox. */
  approvals: boolean
  skipGitCheck: boolean
}

/** A TOML basic string: backslash, quote and every control character (and DEL) escaped. */
export function tomlString(text: string): string {
  const body = text.replace(/[\\"\u0000-\u001f\u007f]/g, ch => {
    if (ch === '\\') return '\\\\'
    if (ch === '"') return '\\"'
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
  return `"${body}"`
}

/** The `sandbox_workspace_write` keys pinned for a write role (accepted by `--strict-config` on 0.162.1). */
export const WRITE_LANE_PINS = ['-c', 'sandbox_workspace_write.writable_roots=[]', '-c', 'sandbox_workspace_write.network_access=false'] as const

export function buildArgv(input: CodexArgvInput): string[] {
  if (!isCodexRole(input.role)) throw new Error(`Unknown role: ${String(input.role)}`)
  const sandbox = CODEX_LANES[input.role].sandbox
  if (sandbox !== 'read-only' && sandbox !== 'workspace-write') throw new Error(`Unknown sandbox: ${String(sandbox)}`)

  if (input.output !== undefined && CODEX_LANES[input.role].output === undefined) {
    throw new Error(`Role ${input.role} has no output file`)
  }

  const argv = ['codex', 'exec', '--json', '-s', sandbox, '-c', `developer_instructions=${tomlString(input.rolePrompt)}`]
  if (input.approvals) argv.push('-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"')
  // The person's ~/.codex config still applies (model, MCP servers); these keys are pinned so it cannot widen a write
  // lane without a word: no extra writable roots, no network for sandboxed commands (auto-review may still allow one).
  if (isWriteRole(input.role)) argv.push(...WRITE_LANE_PINS)
  if (input.model) argv.push('-m', input.model)
  if (input.output !== undefined) argv.push('-o', input.output)
  if (input.skipGitCheck && !isWriteRole(input.role)) argv.push('--skip-git-repo-check')
  if (input.resume !== undefined) {
    // A thread id comes from Codex's own output, which a write job can edit: only a UUID reaches argv.
    if (!isThreadId(input.resume)) throw new Error('resume takes a Codex thread id (a UUID)')
    argv.push('resume', input.resume)
  }
  argv.push('-')
  return argv
}
