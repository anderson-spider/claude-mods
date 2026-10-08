import type { BrowserDeps, McpCall } from '../hooks/mcp-browser'

/** A tool's answer: its text, or a function of the arguments (it may throw). */
export type Answer = string | ((args: Record<string, unknown>) => string)

// A fake MCP server: each tool answers from `answers` and every call is recorded; a tool with no answer throws.
export function fakeMcp(answers: Record<string, Answer>) {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  const call: McpCall = async (tool, args) => {
    calls.push({ tool, args })
    const answer = answers[tool]
    if (answer === undefined) throw new Error(`no answer for ${tool}`)
    return typeof answer === 'string' ? answer : answer(args)
  }
  return { call, calls }
}

// The dependencies over a fake call: `sleeps` records each wait, and the clock `now` moves by each wait, so a
// poll's timeout is in the same wall-clock time the sleeps add up to; `readBytes` answers `bytes` for any path.
export function fakeDeps(call: McpCall, bytes = new Uint8Array()) {
  const sleeps: number[] = []
  let clock = 0
  const deps: BrowserDeps = {
    call,
    readBytes: async () => bytes,
    sleep: async ms => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
  }
  return { deps, sleeps }
}

// A tool's text the way the tab tools print it: a JSON object, then a note about the tabs.
export const withNote = (value: unknown) => `${JSON.stringify(value)}\n\nTab Context:\n- Available tabs: (not shown)`
