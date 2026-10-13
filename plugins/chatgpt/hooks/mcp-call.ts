/** Calls one of a browser's MCP tools and returns its text; throws when the tool reports an error. */
export type McpCall = (tool: string, args: Record<string, unknown>) => Promise<string>

/** What the host's `$.mcp.call` answers: the MCP result's content blocks and whether the tool failed. */
export type McpResult = { content?: unknown; isError?: boolean }

/** What the host's `$.tool.call` answers, as far as a backend reads it: a denial, or the tool's text and whether it failed. */
type ToolCallReply = { deny?: string; text?: string; isError?: boolean }

/** The two host calls a backend can make: `$.mcp.call` by server name, and `$.tool.call` by the tool's `mcp__` name. */
export type McpHost = {
  mcp(server: string, tool: string, args: Record<string, unknown>): Promise<McpResult>
  tool(input: Record<string, unknown>): Promise<ToolCallReply>
}

// A rejection of `$.mcp.call` that says the server cannot be reached that way. A tool's own error is an `isError` result, never one of these.
// The host words an unconnected server as `no tool "<tool>" on a server named "<server>"; servers with tools: ...`.
const UNREACHABLE = /unknown server|no such server|not connected|not configured|not found|no tool "[^"]*" on a server named/i

// How the engine words a `$.mcp.call` it refused before the tool ran (`<plugin>: $.mcp.call(<server>, <tool>) refused: <reason>`),
// as auto mode's classifier does with a call no prompt asked for.
const REFUSED = /\$\.mcp\.call\([^)]*\) refused\b/

// The way a server's calls go once the first call decided it; undefined until then.
type Route = 'mcp' | 'tool' | undefined

// Whether a rejected `$.mcp.call` moves to `$.tool.call`: a refusal at any call, unreachable only at the first one.
function shouldFallBack(message: string, route: Route): boolean {
  return REFUSED.test(message) || (route === undefined && UNREACHABLE.test(message))
}

const textOf = (content: unknown) =>
  (Array.isArray(content) ? (content as { type?: string; text?: string }[]) : [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')

/**
 * Calls a tool of an MCP server the way the host allows. The first call decides the route once: `$.mcp.call`
 * when it answers, or `$.tool.call` (a permission prompt may follow) when it rejects as unreachable. A refused
 * `$.mcp.call` moves to `$.tool.call` from then on, at any call, since the tool never ran. A tool error
 * (`isError`) is thrown to the caller at once and never retried, since the tool may already have acted.
 */
export function mcpCallOf(host: McpHost, server: string): McpCall {
  let route: Route
  const viaTool = async (tool: string, args: Record<string, unknown>) => {
    const done = await host.tool({ tool: `mcp__${server}__${tool}`, ...args })
    if (done.deny) throw new Error(done.deny)
    if (done.isError) throw new Error(done.text || `${tool} failed`)
    return done.text ?? ''
  }
  return async (tool, args) => {
    if (route === 'tool') return viaTool(tool, args)
    let result: McpResult
    try {
      result = await host.mcp(server, tool, args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!shouldFallBack(message, route)) throw error
      route = 'tool'
      return viaTool(tool, args)
    }
    route = 'mcp'
    const text = textOf(result.content)
    if (result.isError) throw new Error(text || `${tool} failed`)
    return text
  }
}
