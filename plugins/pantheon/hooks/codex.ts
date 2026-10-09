import type { CodexCall, CodexEvent, Tokens } from './types'

export function buildArgv(call: CodexCall): string[] {
  if (call.sandbox !== 'read-only' && call.sandbox !== 'workspace-write') {
    throw new Error(`Sandbox recusado: ${call.sandbox}`)
  }

  const argv = ['codex', 'exec', '--json', '-s', call.sandbox]
  if (call.model !== undefined) argv.push('-m', call.model)
  if (call.effort !== undefined) argv.push('-c', `model_reasoning_effort=${call.effort}`)
  const roots = (call.writableRoots ?? []).map(path => JSON.stringify(path).replace(/\u007f/g, '\\u007f')).join(',')
  argv.push('-c', `sandbox_workspace_write.writable_roots=[${roots}]`)
  if (call.noNetwork) argv.push('-c', 'sandbox_workspace_write.network_access=false')
  else if (call.network === true) argv.push('-c', 'sandbox_workspace_write.network_access=true')
  argv.push('--ignore-rules')
  if (call.skipGitRepoCheck) argv.push('--skip-git-repo-check')
  if (call.resumeSessionId !== undefined) argv.push('resume', call.resumeSessionId)
  argv.push('-')
  return argv
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function parseEvent(obj: unknown): CodexEvent[] {
  if (!isRecord(obj)) return []

  if (obj.type === 'thread.started') {
    return typeof obj.thread_id === 'string'
      ? [{ kind: 'session', sessionId: obj.thread_id }]
      : []
  }

  if (obj.type === 'item.started' || obj.type === 'item.completed') {
    const item = obj.item
    if (!isRecord(item) || typeof item.type !== 'string') return []
    if (item.type === 'agent_message') {
      return typeof item.text === 'string' ? [{ kind: 'message', text: item.text }] : []
    }
    if (item.type === 'command_execution') {
      if (typeof item.command !== 'string') return []
      const exit = obj.type === 'item.completed' && typeof item.exit_code === 'number'
        ? ` → ${item.exit_code}` : ''
      return [{ kind: 'activity', text: `$ ${item.command}${exit}` }]
    }
    return [{ kind: 'activity', text: item.type }]
  }

  if (obj.type === 'turn.completed') {
    const usage = obj.usage
    if (!isRecord(usage)) return []
    const cached = usage.cached_input_tokens === undefined ? 0 : usage.cached_input_tokens
    if (!isTokenCount(usage.input_tokens) || !isTokenCount(cached) || !isTokenCount(usage.output_tokens)) {
      return []
    }
    const tokens: Tokens = { input: usage.input_tokens, cached, output: usage.output_tokens }
    return [{ kind: 'usage', tokens }]
  }

  if (obj.type === 'turn.failed' || obj.type === 'error') {
    const message = obj.type === 'turn.failed' && isRecord(obj.error)
      ? obj.error.message : obj.message
    return [{ kind: 'failed', error: typeof message === 'string' && message.trim()
      ? message : `Codex reported ${obj.type} without a message` }]
  }

  return []
}

function parseLine(line: string): CodexEvent[] {
  if (!line.trim()) return []
  try {
    return parseEvent(JSON.parse(line))
  } catch {
    return []
  }
}

export function createJsonlReader(): { push(text: string): CodexEvent[]; end(): CodexEvent[] } {
  let buffer = ''
  return {
    push(text) {
      buffer += text
      const events: CodexEvent[] = []
      let start = 0
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        events.push(...parseLine(buffer.slice(start, newline)))
        start = newline + 1
        newline = buffer.indexOf('\n', start)
      }
      buffer = buffer.slice(start)
      return events
    },
    end() {
      const tail = buffer
      buffer = ''
      return parseLine(tail)
    },
  }
}
