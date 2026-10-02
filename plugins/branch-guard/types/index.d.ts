/** What the command would do: a sentence, and the items that support it. */
export type BranchGuardReport = {
  /** The command by name: `git commit`, `git push`. */
  title: string
  summary: string
  lines: string[]
  /** How many items exist in total; `lines` holds only the first ones. */
  total: number
  /** Footer: the summary of what changed in the index. */
  notes: string[]
}

/** The held command, with the report drawn above the prompt. */
export type BranchGuardHeld = {
  id: string
  command: string
  report: BranchGuardReport
}

declare module 'claude-code' {
  interface PluginState {
    'branch-guard': { held: BranchGuardHeld | null }
  }
}
