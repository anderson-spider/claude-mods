// The file-explorer state contract: the values the pane draws from, held by the host for the session. Self-contained.

/** How Claude touched a file. */
export type FileExplorerActivityKind = 'read' | 'searched' | 'modified' | 'created' | 'removed' | 'committed'

/** One file Claude touched, when (ms since the epoch), and how. */
export type FileExplorerActivity = { path: string; kind: FileExplorerActivityKind; at: number }

/** One entry of a listing. A symbolic link carries the kind of what it leads to (`other` when it leads nowhere). */
export type FileExplorerEntry = { name: string; kind: 'file' | 'dir' | 'other'; isLink: boolean; size: number; mtimeMs: number }

/** A directory as last listed: its entries (at most `MAX_ENTRIES`), how many were left out, its own mtime then. */
export type FileExplorerListing = { entries: FileExplorerEntry[]; omitted: number; mtimeMs: number }

/** One letter per file: modified, added, deleted, renamed, untracked, conflicted. */
export type FileExplorerGitCode = 'M' | 'A' | 'D' | 'R' | '?' | 'U'

export type FileExplorerBranch = { name: string; upstream?: string; ahead: number; behind: number }

/** Git status by absolute path, the lines changed per file, and each directory's roll-up of what lies under it. */
export type FileExplorerGit = {
  branch: FileExplorerBranch
  files: Record<string, FileExplorerGitCode>
  lines: Record<string, { added: number; removed: number }>
  dirs: Record<string, { code: FileExplorerGitCode; count: number }>
}

/** A file opened in the pane: its text (cut to `PREVIEW_LINES`), drawn as Markdown or code. */
export type FileExplorerPreview = { path: string; text: string; isMarkdown: boolean; note?: string }

/** Where the person is in the pane: the root, what is expanded, the cursor, and the mode shown. */
export type FileExplorerView = {
  root: string
  /** True when `/file-explorer <path>` chose the root, so a cwd change leaves it. */
  isPinned: boolean
  expanded: string[]
  /** The path under the cursor in the tree, or null before the first row. */
  cursor: string | null
  /** The first tree row shown. */
  top: number
  showHidden: boolean
  mode: 'tree' | 'search' | 'preview'
  query: string
  /** The search hits, relative to the root, best first, and the one under the cursor. */
  hits: string[]
  hitCursor: number
  preview?: FileExplorerPreview
  /** A one-line note in the footer: a refusal, a copy, an error. */
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'file-explorer': {
      view: FileExplorerView
      dirs: Record<string, FileExplorerListing>
      git: FileExplorerGit | null
      activity: FileExplorerActivity[]
      /** Moves on when a flash ends, so the pane redraws without polling the tree. */
      tick: number
    }
  }
}
