// The inputs of the tools this plugin registers in session.start, in the shape
// the engine lays for connected MCP tools (.claude-plugin/types/claude-code-mcp),
// so `{ tool: 'mcp__gitlab__gitlab_mr' }` matchers type `e` before a save
// regenerates that file. Keep them in step with the inputSchema in hooks/register.tsx.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    mcp__gitlab__gitlab_mr: {
      action: 'list' | 'get' | 'create' | 'update' | 'diff' | 'commits' | 'approve' | 'unapprove' | 'rebase'
      iid?: number
      state?: 'opened' | 'merged' | 'closed' | 'all'
      title?: string
      description?: string
      sourceBranch?: string
      targetBranch?: string
      labels?: string[]
      addLabels?: string[]
      removeLabels?: string[]
      assignees?: string[]
      reviewers?: string[]
      draft?: boolean
      stateEvent?: 'close' | 'reopen'
      removeSourceBranch?: boolean
      squash?: boolean
      files?: string[]
    }
    mcp__gitlab__gitlab_mr_comment: {
      action: 'list' | 'comment' | 'reply' | 'line' | 'edit' | 'resolve' | 'unresolve'
      iid?: number
      body?: string
      discussionId?: string
      noteId?: number
      path?: string
      line?: number
      oldLine?: number
      unresolvedOnly?: boolean
    }
    mcp__gitlab__gitlab_pipeline: {
      action: 'list' | 'jobs' | 'retry' | 'cancel' | 'play'
      iid?: number
      ref?: string
      pipelineId?: number
      jobId?: number
      failedOnly?: boolean
    }
    mcp__gitlab__gitlab_job_log: {
      jobId: number
      mode?: 'errors' | 'tail' | 'full'
      lines?: number
      pattern?: string
    }
  }
}
