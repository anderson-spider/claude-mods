/** What the command would change: a sentence, and the items that support it. */
export type BlastRadiusReport = {
  /** The risk by name: `rm -rf`, `git clean`. */
  title: string
  summary: string
  lines: string[]
  /** How many items exist in total; `lines` holds only the first ones. */
  total: number
  /** Footer: the targets as written (`Caminhos: build`) or the size of the loss. */
  notes: string[]
}

/** The held command, with the report drawn above the prompt. */
export type BlastRadiusHeld = {
  id: string
  command: string
  report: BlastRadiusReport
}

declare module 'claude-code' {
  interface PluginState {
    'blast-radius': { held: BlastRadiusHeld | null }
  }
}
