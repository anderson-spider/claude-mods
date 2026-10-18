// The host fake the plugin's tests share: records the tools the plugin registers and answers the events around them.
import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'

export type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }

/** The MCP name the host gives a tool this plugin registers. */
export const id = (name: string) => `mcp__spider-progress__${name}`

/** A host that records each registered tool. Add handlers here for the other events the plugin uses (`env.get`, `http.fetch`). */
export function world(on: On) {
  const tools: Tool[] = []

  on('tool.register', (_$, e) => (tools.push(e as unknown as Tool), { value: { tool: id(e.name) } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  return { tools }
}

/** Starts the session, so the plugin registers its tools, and returns their names. */
export async function started($: { session: { start: (e: never) => Promise<unknown> } }, tools: Tool[]): Promise<string[]> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(tools.length).toBeGreaterThan(0)

  return tools.map((tool) => tool.name)
}
