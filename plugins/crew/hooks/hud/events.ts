// Host events read into what the reducers take: a tool call's one-line target, a turn's opening text (a prompt of
// yours, an agent's hand-back, or an engine notice) and the advisor tool's blocks in an assistant row. Pure: the hooks
// in register.tsx hand these the event's fields. Secrets are removed by the reducers (state.ts `safeText`).

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The last three parts of a path (`internal/config/contract_on.go`): the file and the folders that tell it apart. */
const tail = (path: string): string => path.split(/[\\/]/).filter(Boolean).slice(-3).join('/')

/** What a tool call was about, on one line: `Edit internal/config/contract_on.go`, `Bash go vet ./...`, `Grep base_url`. */
export function toolLine(tool: string, input: unknown): string {
  const i = isObject(input) ? input : {}
  const path = text(i.file_path) || text(i.notebook_path) || text(i.path)
  const what = text(i.command) || (path ? tail(path) : '') || text(i.pattern) || text(i.url) || text(i.query) || text(i.description)
  return what ? `${tool} ${what}` : tool
}

/** The tools whose `file_path` writes a file: a plan written by any of them is re-read. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** What opens a main-loop turn: your prompt, an agent's hand-back (`<agent-message from="id">`), or another engine notice. */
export type Opening = { kind: 'prompt' } | { kind: 'handback'; from: string } | { kind: 'engine' }

export function openingOf(raw: unknown): Opening {
  const t = text(raw)
  const from = /^\s*<agent-message\s+from="([^"]+)"/.exec(t)?.[1]
  if (from) return { kind: 'handback', from }
  return /^\s*<[a-z][\w-]*/i.test(t) ? { kind: 'engine' } : { kind: 'prompt' }
}

/** A consult of the server advisor tool seen in an assistant row: opened by its use, closed by its result. */
export type ServerConsult = { kind: 'open'; id: string } | { kind: 'close'; id: string; answer: string }

/** The text a tool result block carries, whatever its shape: a string, text blocks, or a `text` field. */
function resultText(block: Record<string, unknown>): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => (isObject(part) ? text(part.text) : text(part))).filter(Boolean).join('\n')
  if (isObject(content)) return text(content.text)
  return text(block.text)
}

/** The advisor tool's opens and closes in an assistant row's blocks, in order; anything else is skipped. */
export function serverConsults(content: unknown, toolName: string): ServerConsult[] {
  if (!Array.isArray(content)) return []
  const out: ServerConsult[] = []
  for (const block of content) {
    if (!isObject(block) || typeof block.type !== 'string') continue
    if (block.type === 'server_tool_use' && block.name === toolName && typeof block.id === 'string') out.push({ kind: 'open', id: block.id })
    else if (block.type.endsWith('_tool_result') && typeof block.tool_use_id === 'string') {
      out.push({ kind: 'close', id: block.tool_use_id, answer: resultText(block) })
    }
  }
  return out
}
