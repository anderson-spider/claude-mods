/** What the command would open: a sentence, the preview, and what breaks the conventions. */
export type PrPreviewReport = {
  /** The command by name: `gh pr create`, `glab mr create`. */
  title: string
  summary: string
  /** The preview: title, branches, assignee, labels, then the description. */
  lines: string[]
  /** How many preview items exist in total; `lines` holds them all, the band shows the first ones. */
  total: number
  /** What breaks the conventions, one sentence each. */
  problems: string[]
  /** Footer: what the text alone could not tell. */
  notes: string[]
}

/** The held command, with the preview drawn above the prompt. */
export type PrPreviewHeld = {
  id: string
  command: string
  report: PrPreviewReport
}

declare module 'claude-code' {
  interface PluginState {
    'pr-preview': { held: PrPreviewHeld | null }
  }
}
