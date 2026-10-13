// A twin's step on the user's Codex login (the `codexLogin` option): the subagent's conversation as one request to
// ChatGPT's Codex backend, and the backend's answer as the step's chunks. Pure: the step hook in register.tsx reads the
// login, the conversation and the tool descriptions, makes the one fetch and yields what this module builds.
//
// The wire shapes follow the Responses API as the Codex backend takes it: the system prompt as a `developer` message
// with empty `instructions`, `store: false` with the reasoning sent back as `encrypted_content`, and a streamed answer
// read whole, since the host's fetch returns the body at once.

import type { TurnStepChunk, TurnStepResult, TurnUsage } from 'claude-code'
import { fnv1a } from './decisions'
import type { Login } from './codex-login'

export const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses'

/** The backend names its client by `Originator` and refuses a request without one. */
export const ORIGINATOR = 'codex-tui'
export const USER_AGENT = 'codex-tui/0.153.3'

/** The efforts the twins' fixed models take; any other request falls back to the twin's default. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
export type CodexEffort = (typeof EFFORTS)[number]

export function codexEffort(requested: string | undefined, fallback: CodexEffort): CodexEffort {
  return EFFORTS.find(effort => effort === requested) ?? fallback
}

/** One message as `$.session.messages({ as: 'api' })` gives it. */
export type ApiMessage = { role: string; content: readonly { type: string; [field: string]: unknown }[] }

/** One tool as Codex is told it: the name the model calls, the host's description and crew's schema. */
export type CodexTool = { name: string; description: string; parameters: Record<string, unknown> }

/** The reasoning Codex returned before a call, by the call's id, sent back ahead of that call on later steps. */
export type Reasoning = (callId: string) => readonly string[] | undefined

export function codexHeaders(login: Login, sessionId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${login.accessToken}`,
    'Chatgpt-Account-Id': login.accountId,
    Originator: ORIGINATOR,
    'User-Agent': USER_AGENT,
    Session_id: sessionId,
  }
}

/** A call id as the backend takes it: at most 64 characters, the overflow replaced by a hash of the whole id. */
function fitCallId(id: string): string {
  return id.length <= 64 ? id : `${id.slice(0, 55)}_${fnv1a(id)}`
}

type Item = Record<string, unknown>

function partOf(block: ApiMessage['content'][number], role: 'user' | 'assistant'): Item | undefined {
  if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
    return { type: role === 'user' ? 'input_text' : 'output_text', text: block.text }
  }
  if (block.type === 'image' && role === 'user') {
    const source = block.source as { type?: unknown; url?: unknown; media_type?: unknown; data?: unknown } | undefined
    if (typeof source?.url === 'string') return { type: 'input_image', image_url: source.url }
    if (source?.type === 'base64' && typeof source.data === 'string') {
      return { type: 'input_image', image_url: `data:${typeof source.media_type === 'string' && source.media_type ? source.media_type : 'application/octet-stream'};base64,${source.data}` }
    }
  }
  return undefined
}

/** A tool result's content as the call's output: its text and images as parts, or its text alone. */
function outputOf(content: unknown): string | Item[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = content.flatMap(block => {
    const part = block && typeof block === 'object' ? partOf(block as ApiMessage['content'][number], 'user') : undefined
    return part ? [part] : []
  })
  return parts.length > 0 ? parts : JSON.stringify(content)
}

/** The conversation as Responses input items, in order: a message's text and images share an item, every call and result is its own. */
export function inputItems(messages: readonly ApiMessage[], reasoning: Reasoning): Item[] {
  const items: Item[] = []
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    let parts: Item[] = []
    const flush = () => {
      if (parts.length > 0) items.push({ type: 'message', role, content: parts })
      parts = []
    }
    for (const block of message.content) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        flush()
        for (const encrypted of reasoning(block.id) ?? []) items.push({ type: 'reasoning', summary: [], content: null, encrypted_content: encrypted })
        items.push({ type: 'function_call', call_id: fitCallId(block.id), name: block.name, arguments: JSON.stringify(block.input ?? {}) })
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        flush()
        items.push({ type: 'function_call_output', call_id: fitCallId(block.tool_use_id), output: outputOf(block.content) })
      } else {
        // Thinking and anything else the backend cannot read is left out.
        const part = partOf(block, role)
        if (part) parts.push(part)
      }
    }
    flush()
  }
  return items
}

/** The request body: the system prompt first, as a developer message, then the conversation. */
export function codexBody(input: { model: string; effort: CodexEffort; system: string; messages: readonly ApiMessage[]; tools: readonly CodexTool[]; reasoning: Reasoning }): Record<string, unknown> {
  return {
    model: input.model,
    instructions: '',
    input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: input.system }] }, ...inputItems(input.messages, input.reasoning)],
    tools: input.tools.map(tool => ({ type: 'function', name: tool.name, strict: false, description: tool.description, parameters: tool.parameters })),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { effort: input.effort, summary: 'auto' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  }
}

/** The step as crew yields it: the chunks in order, then the result's fields; `reasoning` is what to keep for later steps. */
export type CodexStep = Omit<TurnStepResult, 'turnId' | 'index'> & { chunks: TurnStepChunk[]; reasoning: Map<string, string[]> }

/** A step that answers with plain text: no tool, no reasoning to keep. */
export function textStep(text: string): CodexStep {
  return {
    chunks: [{ kind: 'text', index: 0, text }, { kind: 'stop', stopReason: 'end_turn', usage: null }],
    answer: text,
    toolUses: [],
    stopReason: 'end_turn',
    usage: null,
    reasoning: new Map(),
  }
}

/** A step that answers with why Codex was not asked or did not answer: never a throw, which would send the request to Anthropic. */
export function failedStep(reason: string): CodexStep {
  return textStep(`crew: this Codex twin could not run: ${reason}.`)
}

/** The payloads of an event stream's `data:` lines, one per event, parsed; anything that is no JSON object is skipped. */
function events(text: string): Item[] {
  const parsed: Item[] = []
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (!data || data === '[DONE]') continue
    try {
      const value: unknown = JSON.parse(data)
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed.push(value as Item)
    } catch {
      // A broken event is skipped; a stream with no terminal event fails below.
    }
  }
  return parsed
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** A message from the backend, cut to one short line: it is shown to the lead, never the request. */
function shortText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const line = value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
  return line ? (line.length > 200 ? `${line.slice(0, 200)}…` : line) : undefined
}

/** Why an HTTP answer is not a step, from its status and the backend's message. */
export function statusReason(status: number, body: string): string {
  let message: string | undefined
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; detail?: unknown }
    message = shortText(parsed?.error?.message) ?? shortText(parsed?.detail)
  } catch {
    message = undefined
  }
  const what =
    status === 401 || status === 403
      ? 'the Codex backend refused the login (run `codex login`)'
      : status === 429
        ? 'Codex usage limit reached'
        : `the Codex backend answered HTTP ${status}`
  return message ? `${what}: ${message}` : what
}

/** A tool use id as the transcript keeps it: the backend's call id, only letters, digits, `_` and `-`. */
const toolId = (callId: unknown) => (typeof callId === 'string' && callId ? callId.replace(/[^\w-]/g, '_') : 'toolu_codex')

/**
 * The step from the backend's streamed answer: the finished items of `response.completed` (or `incomplete`) in order,
 * each reasoning summary as thinking, each message as text, each call as a tool use. A stream that failed or never
 * finished is a failed step.
 */
export function stepOf(text: string, model: string): CodexStep {
  let terminal: Item | undefined
  const done: Item[] = []
  for (const event of events(text)) {
    const type = event.type
    if (type === 'response.output_item.done' && event.item && typeof event.item === 'object') done.push(event.item as Item)
    else if (type === 'response.completed' || type === 'response.incomplete') terminal = event
    else if (type === 'response.failed' || type === 'error') {
      const error = ((event.response as Item | undefined)?.error ?? event.error ?? event) as Item
      return failedStep(`Codex failed: ${shortText(error.message) ?? shortText(error.code) ?? 'no reason given'}`)
    }
  }
  if (!terminal) return failedStep('the Codex stream ended before the response completed')
  const response = (terminal.response ?? {}) as Item
  // The items as they finished streaming; the terminal event's own list stands in when none streamed.
  const items = done.length > 0 ? done : Array.isArray(response.output) ? (response.output as Item[]) : []

  const chunks: TurnStepChunk[] = []
  const toolUses: { name: string; input: unknown }[] = []
  const reasoning = new Map<string, string[]>()
  let pending: string[] = []
  let answer = ''
  let index = 0
  for (const item of items) {
    if (item.type === 'reasoning') {
      if (typeof item.encrypted_content === 'string' && item.encrypted_content) pending.push(item.encrypted_content)
      const summary = Array.isArray(item.summary) ? (item.summary as Item[]).map(part => (typeof part.text === 'string' ? part.text : '')).filter(Boolean).join('\n\n') : ''
      if (summary) chunks.push({ kind: 'thinking', index: index++, text: summary })
    } else if (item.type === 'message') {
      const content = Array.isArray(item.content) ? (item.content as Item[]) : []
      const said = content.map(part => (part.type === 'output_text' && typeof part.text === 'string' ? part.text : part.type === 'refusal' && typeof part.refusal === 'string' ? part.refusal : '')).join('')
      if (said) {
        chunks.push({ kind: 'text', index: index++, text: said })
        answer += said
      }
    } else if (item.type === 'function_call' && typeof item.name === 'string' && item.status !== 'incomplete') {
      let args: unknown
      try {
        args = JSON.parse(typeof item.arguments === 'string' && item.arguments.trim() ? item.arguments : '{}')
      } catch {
        continue
      }
      // A call whose arguments are no object cannot run; it is left out, as the gateway left it.
      if (!args || typeof args !== 'object' || Array.isArray(args)) continue
      const id = toolId(item.call_id)
      if (pending.length > 0) reasoning.set(id, pending)
      pending = []
      chunks.push({ kind: 'tool', index, id, name: item.name }, { kind: 'input', index, json: JSON.stringify(args) })
      index++
      toolUses.push({ name: item.name, input: args })
    }
  }

  const reason = (response.incomplete_details as Item | undefined)?.reason ?? response.stop_reason
  const stopReason: TurnStepResult['stopReason'] =
    reason === 'max_output_tokens' || reason === 'max_tokens'
      ? 'max_tokens'
      : toolUses.length > 0
        ? 'tool_use'
        : reason === 'content_filter' || reason === 'refusal'
          ? 'refusal'
          : 'end_turn'
  const used = (response.usage ?? {}) as Item
  const details = (used.input_tokens_details ?? {}) as Item
  const cached = num(details.cached_tokens)
  const written = num(details.cache_write_tokens)
  const usage: TurnUsage = {
    model: typeof response.model === 'string' && response.model ? response.model : model,
    input_tokens: Math.max(num(used.input_tokens) - cached - written, 0),
    output_tokens: num(used.output_tokens),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
  }
  chunks.push({ kind: 'stop', stopReason, usage })
  return { chunks, answer, toolUses, stopReason, usage, reasoning }
}
