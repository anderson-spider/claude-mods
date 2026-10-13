import { expect, test } from 'claude-code/testing'
import { type McpHost, type McpResult, mcpCallOf } from '../hooks/mcp-call'

// A host whose `$.mcp.call` and `$.tool.call` are scripted; every call is recorded.
function fakeHost(options: { mcp: (tool: string, args: Record<string, unknown>) => McpResult | Promise<McpResult>; tool?: (input: Record<string, unknown>) => { deny?: string; text?: string; isError?: boolean } }) {
  const mcp: string[] = []
  const tool: string[] = []
  const host: McpHost = {
    mcp: async (server, name, args) => {
      mcp.push(`${server}/${name}`)
      return options.mcp(name, args)
    },
    tool: async input => {
      tool.push(String(input.tool))
      return options.tool?.(input) ?? { text: 'via tool' }
    },
  }
  return { host, mcp, tool }
}

const text = (value: string): McpResult => ({ content: [{ type: 'text', text: value }] })

test('mcpCallOf answers through $.mcp.call when the server is reachable', async () => {
  const { host, mcp, tool } = fakeHost({ mcp: () => text('ok') })
  const call = mcpCallOf(host, 'claude-in-chrome')
  expect(await call('tabs_context_mcp', {})).toBe('ok')
  expect(mcp).toEqual(['claude-in-chrome/tabs_context_mcp'])
  expect(tool).toEqual([])
})

test('mcpCallOf falls back to $.tool.call only on an unreachable rejection, and remembers that route', async () => {
  const { host, mcp, tool } = fakeHost({
    mcp: () => {
      throw new Error('unknown server claude_ai_x')
    },
    tool: input => ({ text: `ran ${String(input.tool)}` }),
  })
  const call = mcpCallOf(host, 'Claude_Browser')
  expect(await call('navigate', { url: 'https://chatgpt.com/' })).toBe('ran mcp__Claude_Browser__navigate')
  expect(await call('navigate', { url: 'https://chatgpt.com/c/a' })).toBe('ran mcp__Claude_Browser__navigate')
  expect(mcp).toEqual(['Claude_Browser/navigate'])
  expect(tool).toEqual(['mcp__Claude_Browser__navigate', 'mcp__Claude_Browser__navigate'])
})

test('a rejection that is not an unreachable server is thrown, with no fallback', async () => {
  const { host, tool } = fakeHost({
    mcp: () => {
      throw new Error('socket hang up')
    },
  })
  expect(String(await mcpCallOf(host, 'S')('x', {}).catch(e => e))).toContain('socket hang up')
  expect(tool).toEqual([])
})

test('an isError result is a tool error: thrown at once, never retried through $.tool.call', async () => {
  let attempts = 0
  const { host, mcp, tool } = fakeHost({
    // The text matches the unreachable pattern, but the server answered, so it is the tool's own error.
    mcp: () => {
      attempts++
      return { content: [{ type: 'text', text: 'server not found on this page' }], isError: true }
    },
  })
  const call = mcpCallOf(host, 'claude-in-chrome')
  expect(String(await call('navigate', { url: 'https://chatgpt.com/' }).catch(e => e))).toContain('server not found on this page')
  expect(attempts).toBe(1)
  expect(tool).toEqual([])
  // The route stays with $.mcp.call: a later failure is not retried through $.tool.call either.
  expect(String(await call('navigate', {}).catch(e => e))).toContain('server not found on this page')
  expect(mcp).toEqual(['claude-in-chrome/navigate', 'claude-in-chrome/navigate'])
  expect(tool).toEqual([])
})

test('once $.mcp.call answered, a later unreachable rejection is not turned into a $.tool.call', async () => {
  let fail = false
  const { host, tool } = fakeHost({
    mcp: () => {
      if (fail) throw new Error('no such server')
      return text('first')
    },
  })
  const call = mcpCallOf(host, 'S')
  expect(await call('a', {})).toBe('first')
  fail = true
  expect(String(await call('b', {}).catch(e => e))).toContain('no such server')
  expect(tool).toEqual([])
})

test('a refused $.mcp.call moves to $.tool.call, even after $.mcp.call answered, and stays there', async () => {
  let refuse = false
  const { host, mcp, tool } = fakeHost({
    mcp: () => {
      if (refuse) throw new Error('chatgpt: $.mcp.call(Claude_Browser, navigate) refused: the classifier gave no verdict')
      return text('listed')
    },
    tool: input => ({ text: `ran ${String(input.tool)}` }),
  })
  const call = mcpCallOf(host, 'Claude_Browser')
  expect(await call('tabs_context', {})).toBe('listed')
  refuse = true
  expect(await call('navigate', { url: 'https://chatgpt.com/' })).toBe('ran mcp__Claude_Browser__navigate')
  expect(await call('javascript_tool', {})).toBe('ran mcp__Claude_Browser__javascript_tool')
  expect(mcp).toEqual(['Claude_Browser/tabs_context', 'Claude_Browser/navigate'])
  expect(tool).toEqual(['mcp__Claude_Browser__navigate', 'mcp__Claude_Browser__javascript_tool'])
})

test('a $.tool.call denial or tool error is thrown to the caller', async () => {
  const denied = fakeHost({ mcp: () => { throw new Error('not connected') }, tool: () => ({ deny: 'the person declined' }) })
  expect(String(await mcpCallOf(denied.host, 'S')('x', {}).catch(e => e))).toContain('the person declined')
  const failed = fakeHost({ mcp: () => { throw new Error('not connected') }, tool: () => ({ isError: true, text: 'tab closed' }) })
  expect(String(await mcpCallOf(failed.host, 'S')('x', {}).catch(e => e))).toContain('tab closed')
})
