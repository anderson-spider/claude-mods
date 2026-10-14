// The inputs of the tools this plugin registers in session.start, in the shape
// the engine lays for connected MCP tools (.claude-plugin/types/claude-code-mcp),
// so `{ tool: 'mcp__gitlab__gitlab_mr' }` matchers type `e` before a save
// regenerates that file. Keep them in step with the inputSchema in hooks/register.tsx.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    mcp__gitlab__gitlab_mr: {
      action: 'list' | 'get' | 'status' | 'create' | 'update' | 'diff' | 'commits' | 'approve' | 'unapprove' | 'rebase' | 'merge'
      project?: string
      iid?: number
      state?: 'opened' | 'merged' | 'closed' | 'all'
      scope?: 'created_by_me' | 'assigned_to_me' | 'all'
      author?: string
      assignee?: string
      reviewer?: string
      search?: string
      allProjects?: boolean
      page?: number
      perPage?: number
      title?: string
      description?: string
      sourceBranch?: string
      targetBranch?: string
      labels?: string[]
      addLabels?: string[]
      removeLabels?: string[]
      createMissingLabels?: boolean
      assignees?: string[]
      reviewers?: string[]
      draft?: boolean
      stateEvent?: 'close' | 'reopen'
      removeSourceBranch?: boolean
      squash?: boolean
      files?: string[]
      sha?: string
      whenPipelineSucceeds?: boolean
      allowOthers?: boolean
      allowProtectedTarget?: boolean
    }
    mcp__gitlab__gitlab_mr_comment: {
      action: 'list' | 'comment' | 'reply' | 'line' | 'edit' | 'resolve' | 'unresolve'
      project?: string
      iid?: number
      body?: string
      discussionId?: string
      noteId?: number
      path?: string
      line?: number
      oldLine?: number
      unresolvedOnly?: boolean
      page?: number
      perPage?: number
      allowOthers?: boolean
    }
    mcp__gitlab__gitlab_pipeline: {
      action: 'list' | 'jobs' | 'run' | 'retry' | 'cancel' | 'play' | 'artifacts'
      project?: string
      iid?: number
      ref?: string
      pipelineId?: number
      jobId?: number
      failedOnly?: boolean
      variables?: string[]
      page?: number
      perPage?: number
      allowOthers?: boolean
    }
    mcp__gitlab__gitlab_job_log: {
      jobId: number
      project?: string
      mode?: 'errors' | 'tail' | 'full'
      lines?: number
      pattern?: string
    }
    mcp__gitlab__gitlab_label: {
      action: 'list' | 'create'
      project?: string
      name?: string
      color?: string
      description?: string
      search?: string
      page?: number
      perPage?: number
    }
  }
}
