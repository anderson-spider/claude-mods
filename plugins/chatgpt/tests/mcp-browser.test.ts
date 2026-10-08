import { expect, test } from 'claude-code/testing'
import { base64Of, bytesOf, leadingJson, mcpCallOf, pollUntil, scriptText, uploadBody, uploadFiles, type McpHost, type McpResult } from '../hooks/mcp-browser'
import type { Attachment } from '../hooks/model'

test('leadingJson reads the first object, whatever braces and quotes it holds', () => {
  expect(leadingJson('{"a":"} {\\"x\\"","b":{"c":1}}\n\nTab Context:\n- x {y}')).toEqual({ a: '} {"x"', b: { c: 1 } })
  expect(leadingJson('no json here')).toBeUndefined()
  expect(leadingJson('{"unterminated": 1')).toBeUndefined()
})

test('scriptText cuts the tool note off and decodes a JSON string literal', () => {
  expect(scriptText('{"href":"x"}\n\nTab Context:\n- Executed on tabId: 1')).toBe('{"href":"x"}')
  expect(scriptText('"{\\"href\\":\\"x\\"}"\n\n(captured at origin https://chatgpt.com)\n\nTab Context:')).toBe('{"href":"x"}')
  expect(scriptText('true')).toBe('true')
})

test('base64 round-trips across the slice boundary and the bytes match the file', () => {
  const bytes = Uint8Array.from({ length: 70_001 }, (_, i) => i % 251)
  expect(bytesOf(base64Of(bytes))).toEqual(bytes)
  expect(base64Of(new Uint8Array([137, 80, 78, 71]))).toBe('iVBORw==')
})

// A clock that moves only when a check or a sleep says so.
function clockOf() {
  let time = 0
  return { now: () => time, advance: (ms: number) => (time += ms) }
}

test('pollUntil answers false when the check never holds, and never throws', async () => {
  const clock = clockOf()
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
    clock.advance(ms)
  }
  expect(await pollUntil(async () => false, sleep, 300, clock.now)).toBe(false)
  expect(sleeps).toEqual([250, 250])
  expect(await pollUntil(async () => Promise.reject(new Error('gone')), sleep, 0, clock.now)).toBe(false)
})

test('pollUntil is bounded by the wall clock, so a slow check does not stretch the timeout', async () => {
  const clock = clockOf()
  const sleeps: number[] = []
  let checks = 0
  // Each check takes 400 ms of wall-clock time; the 1 s budget ends the poll after two of them, with one sleep.
  const check = async () => {
    checks++
    clock.advance(400)
    return false
  }
  const sleep = async (ms: number) => {
    sleeps.push(ms)
    clock.advance(ms)
  }
  expect(await pollUntil(check, sleep, 1000, clock.now)).toBe(false)
  expect(checks).toBe(2)
  expect(sleeps).toEqual([250])
})

test('pollUntil answers true as soon as the check holds', async () => {
  const clock = clockOf()
  const answers = [false, false, true]
  let poll = 0
  const sleep = async (ms: number) => clock.advance(ms)
  expect(await pollUntil(async () => answers[Math.min(poll++, answers.length - 1)]!, sleep, 5000, clock.now)).toBe(true)
  expect(poll).toBe(3)
})

test('the page upload script first checks it runs on chatgpt.com', () => {
  expect(uploadBody('input[type=file]', []).trimStart().startsWith('if (location.origin !== "https://chatgpt.com") return')).toBe(true)
})

test('uploadFiles keeps the name and MIME type of each attachment, and throws the page reason off chatgpt.com', async () => {
  const scripts: string[] = []
  const files: Attachment[] = [{ name: 'notes.txt', type: 'text/plain', path: '/x/notes.txt' }]
  await uploadFiles(
    async body => {
      scripts.push(body)
      return '{"uploaded":true}'
    },
    async () => new Uint8Array([104, 105]),
    'input[type=file]',
    files,
  )
  expect(scripts[0]).toContain('"name":"notes.txt"')
  expect(scripts[0]).toContain('"type":"text/plain"')
  expect(scripts[0]).not.toContain('application/octet-stream')
  const error = await uploadFiles(async () => '{"uploaded":false,"reason":"not on chatgpt.com"}', async () => new Uint8Array(), 'input', files).catch(e => e)
  expect(String(error)).toContain('could not attach notes.txt: not on chatgpt.com')
})

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

test('a $.tool.call denial or tool error is thrown to the caller', async () => {
  const denied = fakeHost({ mcp: () => { throw new Error('not connected') }, tool: () => ({ deny: 'the person declined' }) })
  expect(String(await mcpCallOf(denied.host, 'S')('x', {}).catch(e => e))).toContain('the person declined')
  const failed = fakeHost({ mcp: () => { throw new Error('not connected') }, tool: () => ({ isError: true, text: 'tab closed' }) })
  expect(String(await mcpCallOf(failed.host, 'S')('x', {}).catch(e => e))).toContain('tab closed')
})
