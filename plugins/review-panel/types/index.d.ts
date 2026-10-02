/** One file of the worktree diff, with its changed lines as `git diff` prints them. */
export type DiffFile = {
  path: string
  /** `+` lines. */
  added: number
  /** `-` lines. */
  removed: number
  /** The hunks, one text line each: `@@ … @@` headers, context, `+` and `-`. */
  lines: string[]
  isUntracked: boolean
}

export type CheckStatus = 'success' | 'failure' | 'running' | 'pending' | 'skipped'

/** One CI check (GitHub) or job (GitLab). */
export type Check = { name: string; status: CheckStatus }

export type CommentKind = 'review' | 'comment' | 'finding'

/** One comment already made: a review, a plain comment or an inline finding. */
export type Comment = {
  kind: CommentKind
  author: string
  /** `path:line` for a finding, the kind word otherwise. */
  anchor: string
  body: string
  createdAt: string
  isResolved: boolean
  isOutdated: boolean
}

export type PrState = 'open' | 'merged' | 'closed'

/** The pull or merge request of the current branch. */
export type PrSnapshot = {
  number: number
  title: string
  url: string
  body: string
  state: PrState
  isDraft: boolean
  headRef: string
  baseRef: string
  /** `clean`, `conflicting` or `blocked`. */
  merge: 'clean' | 'conflicting' | 'blocked'
  checks: Check[]
  comments: Comment[]
}

/** What the PR tab shows: the snapshot, or the reason there is none. */
export type PrView =
  | { kind: 'pr'; pr: PrSnapshot }
  | { kind: 'none'; message: string }
  | { kind: 'error'; message: string }

export type PanelView = {
  tab: 'diff' | 'pr'
  /** The branch the data was read on; empty before the first read. */
  branch: string
  diff: DiffFile[]
  /** An error reading the diff, empty when it read. */
  diffError: string
  pr: PrView
  /** Milliseconds since the epoch of the last read; 0 before it. */
  readAt: number
  isLoading: boolean
  /** First row of the tab's content that is drawn, for scrolling. */
  offset: number
}

declare module 'claude-code' {
  interface PluginState {
    'review-panel': { view: PanelView }
  }
}
