import { reportDir } from './names'
import type { Engine, Kind } from './model'

/** What differs between the agents a job can run; everything else in the plugin is the same for both. */
export type Profile = {
  label: string
  /** The executable the doctor and the availability check look for. */
  binary: string
  /** The agent's own command-line arguments; `reports` is the folder where its reports go. */
  args(kind: Kind, reports: string, claudeMode?: string): string[]
  /** The keys that interrupt the turn, and the command typed once it settles to end the background commands, when there is one. */
  cancel: { keys: string[]; stop?: string }
  /** Whether a settled state is not enough to end a job: the report must be there too (see QUIET_MS). */
  confirmByReport: boolean
}

export const ENGINES: readonly Engine[] = ['codex', 'claude']

const SANDBOX: Record<Kind, string> = { execute: 'workspace-write', review: 'read-only' }

/** Claude modes a person may choose with CODEX_TEAM_CLAUDE_MODE: `auto` lets the classifier approve routine commands, `acceptEdits` asks for every command. */
const CLAUDE_MODES = ['auto', 'acceptEdits']
export const claudeModeOf = (value: string | undefined): string => (value && CLAUDE_MODES.includes(value) ? value : 'auto')

// The child must not lead agents of its own: it loads this plugin like any session.
const NO_NESTING = ['--disallowedTools', 'mcp__codex-team']

export const PROFILES: Record<Engine, Profile> = {
  codex: {
    label: 'Codex',
    binary: 'codex',
    args: kind => ['-s', SANDBOX[kind], '-a', 'on-request'],
    cancel: { keys: ['esc'], stop: '/stop' },
    confirmByReport: false,
  },
  claude: {
    label: 'Claude',
    binary: 'claude',
    args: (kind, reports, claudeMode) =>
      kind === 'execute'
        ? ['--permission-mode', claudeModeOf(claudeMode), '--add-dir', reports, ...NO_NESTING]
        // Read-only by permissions, not by a sandbox: edits are denied and a write is allowed only for the report; any other command asks the person in the pane.
        : ['--permission-mode', 'manual', '--disallowedTools', 'Edit', 'NotebookEdit', 'mcp__codex-team', '--allowedTools', `Write(/${reports}/**)`],
    cancel: { keys: ['esc'] },
    confirmByReport: true,
  },
}

/** The arguments `engine` starts with for a job of `kind`. */
export const argsFor = (engine: Engine, kind: Kind, tmpdir: string | undefined, claudeMode?: string): string[] =>
  PROFILES[engine].args(kind, reportDir(tmpdir), claudeMode)
