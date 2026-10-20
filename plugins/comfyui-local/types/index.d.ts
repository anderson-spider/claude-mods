// The inputs of the tools this plugin registers in session.start, in the shape
// the engine lays for connected MCP tools (.claude-plugin/types/claude-code-mcp),
// so `{ tool: 'mcp__comfyui-local__...' }` matchers type `e` before a save
// regenerates that file. Keep them in step with the inputSchema in hooks/register.tsx.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__comfyui-local__system_info': {}
    'mcp__comfyui-local__search_nodes': {
      query?: string
      category?: string
      pack?: string
      input_type?: string
      output_type?: string
      limit?: number
    }
    'mcp__comfyui-local__search_models': {
      query?: string
      folder?: string
      limit?: number
    }
    'mcp__comfyui-local__search_templates': {
      query?: string
      tag?: string
      model?: string
      limit?: number
    }
    'mcp__comfyui-local__get_template': {
      name: string
      pack?: string
    }
    'mcp__comfyui-local__submit_workflow': {
      workflow: unknown
      client_id?: string
    }
    'mcp__comfyui-local__get_job_status': {
      prompt_id?: string
    }
    'mcp__comfyui-local__cancel_job': {
      prompt_id?: string
      clear_pending?: boolean
    }
    'mcp__comfyui-local__upload_file': {
      path: string
      subfolder?: string
      overwrite?: boolean
    }
    'mcp__comfyui-local__get_output': {
      prompt_id: string
      directory?: string
      description?: string
    }
    'mcp__comfyui-local__manager_packs': {
      state?: 'enabled' | 'disabled'
    }
    'mcp__comfyui-local__manager_search_packs': {
      query: string
      limit?: number
    }
    'mcp__comfyui-local__manager_task': {
      action: 'install' | 'update' | 'uninstall' | 'disable' | 'enable' | 'fix'
      pack: string
      version?: string
      repository?: string
    }
    'mcp__comfyui-local__restart_server': {
      force?: boolean
    }
    'mcp__comfyui-local__save_workflow': {
      path: string
      workflow: unknown
      overwrite?: boolean
    }
    'mcp__comfyui-local__list_workflows': {}
    'mcp__comfyui-local__get_workflow': {
      path: string
    }
  }
}
