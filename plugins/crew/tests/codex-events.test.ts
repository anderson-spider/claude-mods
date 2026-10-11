import { describe, expect, test } from 'claude-code/testing'
import { createJsonlReader, parseEvent } from '../hooks/codex/events'
import type { CodexEvent } from '../hooks/codex/events'
import { CODEX_EXEC_0_161 } from './fixtures/codex-exec-0.161'
import {
  CODEX_EXEC_0_162_APPROVAL, CODEX_EXEC_0_162_FAILURE, CODEX_EXEC_0_162_INTERRUPTED, CODEX_EXEC_0_162_RESUME, CODEX_EXEC_0_162_SUCCESS,
} from './fixtures/codex-exec-0.162'

describe('codex events', () => {
  test('turn.started yields started', () => {
    expect(parseEvent({ type: 'turn.started' })).toEqual([{ kind: 'started' }])
  })

  test('thread.started yields session', () => {
    expect(parseEvent({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000001' })).toEqual([
      { kind: 'session', sessionId: '00000000-0000-4000-8000-000000000001' },
    ])
  })

  test('command start yields activity without an exit code', () => {
    expect(parseEvent({ type: 'item.started', item: {
      type: 'command_execution', command: 'ls -1', exit_code: null, status: 'in_progress',
    } })).toEqual([{ kind: 'activity', text: '$ ls -1' }])
  })

  test('command completion includes zero and nonzero exit codes', () => {
    expect(parseEvent({ type: 'item.completed', item: {
      type: 'command_execution', command: 'ls -1', aggregated_output: 'a\n', exit_code: 0, status: 'completed',
    } })).toEqual([{ kind: 'activity', text: '$ ls -1 → 0' }])
    expect(parseEvent({ type: 'item.completed', item: {
      type: 'command_execution', command: 'false', exit_code: 1, status: 'failed',
    } })).toEqual([{ kind: 'activity', text: '$ false → 1' }])
  })

  test('command completion without an exit code remains activity', () => {
    expect(parseEvent({ type: 'item.completed', item: {
      type: 'command_execution', command: 'ls', exit_code: null,
    } })).toEqual([{ kind: 'activity', text: '$ ls' }])
  })

  test('a long command is clipped', () => {
    const [event] = parseEvent({ type: 'item.started', item: { type: 'command_execution', command: 'x'.repeat(500) } })
    expect(event?.kind === 'activity' && event.text.length).toBe(200)
  })

  test('agent_message is the answer only when completed', () => {
    expect(parseEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } })).toEqual([
      { kind: 'message', text: 'answer' },
    ])
    for (const type of ['item.started', 'item.updated']) {
      expect(parseEvent({ type, item: { type: 'agent_message', text: '' } })).toEqual([])
    }
  })

  test('file_change yields activity, and files once completed', () => {
    const item = { type: 'file_change', status: 'completed', changes: [
      { path: '/repo/a.ts', kind: 'update' }, { path: '/repo/b.ts', kind: 'add' }, { kind: 'delete' },
    ] }
    expect(parseEvent({ type: 'item.started', item })).toEqual([
      { kind: 'activity', text: 'file_change: /repo/a.ts, /repo/b.ts' },
    ])
    expect(parseEvent({ type: 'item.completed', item })).toEqual([
      { kind: 'activity', text: 'file_change: /repo/a.ts, /repo/b.ts' },
      { kind: 'files', paths: ['/repo/a.ts', '/repo/b.ts'] },
    ])
    expect(parseEvent({ type: 'item.completed', item: { ...item, status: 'failed' } })).toEqual([
      { kind: 'activity', text: 'file_change: /repo/a.ts, /repo/b.ts' },
    ])
    expect(parseEvent({ type: 'item.completed', item: { type: 'file_change' } })).toEqual([
      { kind: 'activity', text: 'file_change' },
    ])
  })

  test('mcp_tool_call, web_search, todo_list and reasoning become activity', () => {
    expect(parseEvent({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'docs', tool: 'search' } })).toEqual([
      { kind: 'activity', text: 'mcp: docs/search' },
    ])
    expect(parseEvent({ type: 'item.started', item: { type: 'mcp_tool_call' } })).toEqual([
      { kind: 'activity', text: 'mcp_tool_call' },
    ])
    expect(parseEvent({ type: 'item.started', item: { type: 'web_search', query: 'tailscale acl' } })).toEqual([
      { kind: 'activity', text: 'web search: tailscale acl' },
    ])
    expect(parseEvent({ type: 'item.updated', item: { type: 'todo_list', items: [
      { text: 'a', completed: true }, { text: 'b', completed: false },
    ] } })).toEqual([{ kind: 'activity', text: 'todo: 1/2' }])
    expect(parseEvent({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } })).toEqual([
      { kind: 'activity', text: 'reasoning' },
    ])
  })

  test('an error item is a warning, not a failure and not a note', () => {
    expect(parseEvent({ type: 'item.completed', item: { type: 'error', message: 'bad config' } })).toEqual([
      { kind: 'warning', text: 'bad config' },
    ])
  })

  test('unknown item type becomes generic activity', () => {
    for (const type of ['item.started', 'item.completed']) {
      expect(parseEvent({ type, item: { type: 'future_item' } })).toEqual([
        { kind: 'activity', text: 'future_item' },
      ])
    }
  })

  test('turn.completed maps token usage, with reasoning and cache writes when present', () => {
    expect(parseEvent({ type: 'turn.completed', usage: {
      input_tokens: 12, cached_input_tokens: 4, output_tokens: 2,
      reasoning_output_tokens: 1, cache_write_input_tokens: 3,
    } })).toEqual([{ kind: 'completed', tokens: { input: 12, cached: 4, output: 2, reasoning: 1, cacheWrite: 3 } }])
    expect(parseEvent({ type: 'turn.completed', usage: {
      input_tokens: 12, cached_input_tokens: 4, output_tokens: 2,
    } })).toEqual([{ kind: 'completed', tokens: { input: 12, cached: 4, output: 2 } }])
  })

  test('missing cache count defaults to zero', () => {
    expect(parseEvent({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } })).toEqual([
      { kind: 'completed', tokens: { input: 0, cached: 0, output: 0 } },
    ])
  })

  test('turn.completed with missing or malformed usage still completes, without tokens', () => {
    for (const usage of [undefined, null, {}, { input_tokens: '12', output_tokens: 2 },
      { input_tokens: 12, output_tokens: -1 }, { input_tokens: NaN, output_tokens: 2 },
      { input_tokens: 12, cached_input_tokens: '4', output_tokens: 2 }]) {
      expect(parseEvent({ type: 'turn.completed', usage })).toEqual([{ kind: 'completed' }])
    }
  })

  test('a malformed optional count is left out, not fatal', () => {
    expect(parseEvent({ type: 'turn.completed', usage: {
      input_tokens: 1, output_tokens: 2, reasoning_output_tokens: -5, cache_write_input_tokens: 'x',
    } })).toEqual([{ kind: 'completed', tokens: { input: 1, cached: 0, output: 2 } }])
  })

  test('turn.failed yields failed with its message', () => {
    expect(parseEvent({ type: 'turn.failed', error: { message: 'turn failed' } })).toEqual([
      { kind: 'failed', error: 'turn failed' },
    ])
  })

  test('a top-level error is a note: Codex retries it and the turn can still complete', () => {
    expect(parseEvent({ type: 'error', message: 'connection lost' })).toEqual([
      { kind: 'note', text: 'connection lost' },
    ])
  })

  test('a failure or note without a message still says what it was', () => {
    expect(parseEvent({ type: 'turn.failed' })).toEqual([{ kind: 'failed', error: expect.stringContaining('turn.failed') }])
    expect(parseEvent({ type: 'turn.failed', error: {} })).toEqual([{ kind: 'failed', error: expect.stringContaining('turn.failed') }])
    expect(parseEvent({ type: 'error' })).toEqual([{ kind: 'note', text: expect.stringContaining('error') }])
    expect(parseEvent({ type: 'error', message: '  ' })).toEqual([{ kind: 'note', text: expect.stringContaining('error') }])
  })

  test('a thread id that is not a UUID is never a session: a flag, --last or a path stays an activity line', () => {
    for (const thread_id of ['--last', '--dangerously-bypass-approvals-and-sandbox', '-c', 'sess-1', '../x', '', ' 00000000-0000-4000-8000-000000000001']) {
      expect(parseEvent({ type: 'thread.started', thread_id })).toEqual([{ kind: 'activity', text: expect.stringContaining('invalid thread id') }])
    }
    expect(parseEvent({ type: 'thread.started', thread_id: '01A12BD5-30E4-7F12-8E42-D8DB931E560D' })).toEqual([
      { kind: 'session', sessionId: '01A12BD5-30E4-7F12-8E42-D8DB931E560D' },
    ])
  })

  test('invalid objects and unrelated events are ignored', () => {
    for (const obj of [null, undefined, true, 3, 'text', [], {},
      { type: 'future.event' },
      { type: 'thread.started' },
      { type: 'item.completed' }, { type: 'item.started', item: null },
      { type: 'item.completed', item: { type: 'agent_message', text: 5 } },
      { type: 'item.completed', item: { type: 'command_execution', command: [] } },
      { type: 'item.completed', item: { type: 1 } },
    ]) expect(parseEvent(obj)).toEqual([])
  })
})

describe('codex JSONL reader', () => {
  test('0.161 fixture yields session, activity, message and completion with usage', () => {
    const r = createJsonlReader()
    const ev = r.push(CODEX_EXEC_0_161)
    expect(ev).toHaveLength(7)
    expect(ev[0]).toEqual({ kind: 'session', sessionId: '01a11cfa-fdc8-7b61-a3ff-779df92a9d86' })
    expect(ev.filter(e => e.kind === 'activity')).toEqual([
      { kind: 'activity', text: "$ /bin/zsh -lc 'ls -1 | wc -l'" },
      { kind: 'activity', text: "$ /bin/zsh -lc 'ls -1 | wc -l' → 0" },
    ])
    expect(ev.filter(e => e.kind === 'message').at(-1)).toEqual({ kind: 'message', text: '3' })
    expect(ev.at(-1)).toEqual({
      kind: 'completed', tokens: { input: 52107, cached: 25344, output: 68, reasoning: 0, cacheWrite: 0 },
    })
    expect(r.end()).toEqual([])
  })

  test('a retried error before the terminal event does not turn into a failure', () => {
    const lines = [
      { type: 'thread.started', thread_id: '00000000-0000-4000-8000-0000000000ff' },
      { type: 'error', message: 'Reconnecting... 1/5' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ].map(o => JSON.stringify(o)).join('\n') + '\n'
    const kinds = createJsonlReader().push(lines).map(e => e.kind)
    expect(kinds).toEqual(['session', 'note', 'message', 'completed'])
  })

  test('line split across chunks is read once', () => {
    const r = createJsonlReader()
    expect(r.push('{"type":"thread.started","thread_')).toEqual([])
    expect(r.push('id":"00000000-0000-4000-8000-000000000001"}')).toEqual([])
    expect(r.push('\n')).toEqual([{ kind: 'session', sessionId: '00000000-0000-4000-8000-000000000001' }])
    expect(r.push('')).toEqual([])
    expect(r.end()).toEqual([])
  })

  test('one-character chunks preserve escaped text and multiple lines', () => {
    const r = createJsonlReader()
    const events: CodexEvent[] = []
    for (const char of '{"type":"item.completed","item":{"type":"agent_message","text":"ação\\n\\\"ok\\\""}}\n{"type":"thread.started","thread_id":"00000000-0000-4000-8000-000000000002"}\n') {
      events.push(...r.push(char))
    }
    expect(events).toEqual([
      { kind: 'message', text: 'ação\n"ok"' }, { kind: 'session', sessionId: '00000000-0000-4000-8000-000000000002' },
    ])
    expect(r.end()).toEqual([])
  })

  test('end flushes the last line without a newline once', () => {
    const r = createJsonlReader()
    expect(r.push('{"type":"thread.started","thread_id":"00000000-0000-4000-8000-000000000001"}')).toEqual([])
    expect(r.end()).toEqual([{ kind: 'session', sessionId: '00000000-0000-4000-8000-000000000001' }])
    expect(r.end()).toEqual([])
  })

  test('complete lines emit immediately while the tail remains buffered', () => {
    const r = createJsonlReader()
    expect(r.push('{"type":"thread.started","thread_id":"00000000-0000-4000-8000-00000000000a"}\n{"type":"error","message":')).toEqual([
      { kind: 'session', sessionId: '00000000-0000-4000-8000-00000000000a' },
    ])
    expect(r.push('"oops"}\n')).toEqual([{ kind: 'note', text: 'oops' }])
    expect(r.end()).toEqual([])
  })

  test('non-JSON lines and blank lines are ignored without losing valid events', () => {
    const r = createJsonlReader()
    expect(r.push('warning\n\n{broken}\n{"type":"thread.started","thread_id":"00000000-0000-4000-8000-00000000000a"}\nnull\n')).toEqual([
      { kind: 'session', sessionId: '00000000-0000-4000-8000-00000000000a' },
    ])
    expect(r.push('{unfinished')).toEqual([])
    expect(r.end()).toEqual([])
  })

  test('CRLF split across chunks is accepted', () => {
    const r = createJsonlReader()
    expect(r.push('{"type":"thread.started","thread_id":"00000000-0000-4000-8000-00000000000a"}\r')).toEqual([])
    expect(r.push('\n \r\n')).toEqual([{ kind: 'session', sessionId: '00000000-0000-4000-8000-00000000000a' }])
    expect(r.end()).toEqual([])
  })

  test('readers keep separate buffers', () => {
    const a = createJsonlReader()
    const b = createJsonlReader()
    expect(a.push('{"type":"thread.started","thread_id":')).toEqual([])
    expect(b.push('{"type":"thread.started","thread_id":"00000000-0000-4000-8000-00000000000b"}\n')).toEqual([
      { kind: 'session', sessionId: '00000000-0000-4000-8000-00000000000b' },
    ])
    expect(a.push('"00000000-0000-4000-8000-00000000000a"}\n')).toEqual([{ kind: 'session', sessionId: '00000000-0000-4000-8000-00000000000a' }])
    expect(b.end()).toEqual([])
  })
})

// Independent verification of the reader and parser (edge cases and the 0.162.1 T0 fixtures).
describe('codex JSONL reader: edge cases', () => {
  function readAll(chunks: string[]): CodexEvent[] {
    const r = createJsonlReader()
    const events = chunks.flatMap(chunk => r.push(chunk))
    return [...events, ...r.end()]
  }

  function chunked(text: string, size: number): string[] {
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
    return chunks
  }

  // The reader takes strings (SpawnChunk.text is a string), so bytes never reach it: decoding is the host's.
  // What can still split a character is a chunk boundary between the two UTF-16 halves of an astral char.
  test('an emoji split between its surrogate halves across chunks is rejoined', () => {
    const line = `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok 😀 ação' } })}\n`
    const at = line.indexOf('😀') + 1
    expect(line.charCodeAt(at - 1)).toBeGreaterThanOrEqual(0xd800)
    expect(readAll([line.slice(0, at), line.slice(at)])).toEqual([{ kind: 'message', text: 'ok 😀 ação' }])
  })

  test('an escaped surrogate pair split across chunks decodes to the emoji', () => {
    const line = '{"type":"item.completed","item":{"type":"agent_message","text":"\\ud83d\\ude00"}}\n'
    const at = line.indexOf('\\ude00')
    expect(readAll([line.slice(0, at - 2), line.slice(at - 2, at + 3), line.slice(at + 3)])).toEqual([
      { kind: 'message', text: '😀' },
    ])
  })

  test('a 1 MB line arrives whole, in 64 KB and in 4 KB chunks, and the next line still reads', () => {
    const big = 'x'.repeat(1024 * 1024)
    const text = `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: big } })}\n`
      + '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n'
    for (const size of [65536, 4096]) {
      const events = readAll(chunked(text, size))
      expect(events).toHaveLength(2)
      expect(events[0]?.kind === 'message' && events[0].text.length).toBe(big.length)
      expect(events[1]).toEqual({ kind: 'completed', tokens: { input: 1, cached: 0, output: 2 } })
    }
  })

  test('a CRLF line flushed by end without its LF still parses', () => {
    expect(readAll(['{"type":"thread.started","thread_id":"00000000-0000-4000-8000-00000000000a"}\r'])).toEqual([{ kind: 'session', sessionId: '00000000-0000-4000-8000-00000000000a' }])
  })

  test('an invalid tail at end yields nothing and the reader stays empty', () => {
    const r = createJsonlReader()
    expect(r.push('{"type":"thread.started","thread_id":"00000000-0000-4000-8000-00000000000a"}\n{"type":"turn.compl')).toEqual([
      { kind: 'session', sessionId: '00000000-0000-4000-8000-00000000000a' },
    ])
    expect(r.end()).toEqual([])
    expect(r.end()).toEqual([])
    expect(r.push('{"type":"thread.started","thread_id":"00000000-0000-4000-8000-00000000000b"}\n')).toEqual([{ kind: 'session', sessionId: '00000000-0000-4000-8000-00000000000b' }])
  })

  test('JSON values that are not objects, and objects without a type, are ignored', () => {
    expect(readAll(['1\n"x"\n[]\ntrue\n{}\n{"type":7}\n'])).toEqual([])
  })
})

describe('codex events: usage and messages', () => {
  test('the 0.162 usage shape keeps zero reasoning and cache-write counts', () => {
    expect(parseEvent({ type: 'turn.completed', usage: {
      input_tokens: 49250, cached_input_tokens: 37632, cache_write_input_tokens: 0, output_tokens: 73, reasoning_output_tokens: 0,
    } })).toEqual([{ kind: 'completed', tokens: { input: 49250, cached: 37632, output: 73, reasoning: 0, cacheWrite: 0 } }])
  })

  test('malformed usage is tolerated: the turn still completes, without tokens', () => {
    for (const usage of [
      { input_tokens: '5', output_tokens: 1 },
      { input_tokens: -1, output_tokens: 1 },
      { input_tokens: 1, output_tokens: null },
      { input_tokens: 1, cached_input_tokens: null, output_tokens: 1 },
      [1, 2, 3],
      'usage',
    ]) {
      expect(parseEvent({ type: 'turn.completed', usage })).toEqual([{ kind: 'completed' }])
    }
  })

  test('unknown usage fields are ignored', () => {
    expect(parseEvent({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4, future_tokens: 9 } })).toEqual([
      { kind: 'completed', tokens: { input: 3, cached: 0, output: 4 } },
    ])
  })

  test('started and updated agent_messages never yield a message, even with text', () => {
    expect(parseEvent({ type: 'item.started', item: { type: 'agent_message', text: 'partial' } })).toEqual([])
    expect(parseEvent({ type: 'item.updated', item: { type: 'agent_message', text: 'partial longer' } })).toEqual([])
  })
})

describe('codex events: 0.162.1 fixtures', () => {
  function readFixture(jsonl: string): CodexEvent[] {
    const r = createJsonlReader()
    return [...r.push(jsonl), ...r.end()]
  }

  test('success: session, two messages, command activity, completed with usage', () => {
    const events = readFixture(CODEX_EXEC_0_162_SUCCESS.jsonl)
    expect(events[0]).toEqual({ kind: 'session', sessionId: '01a12bd5-30e4-7f12-8e42-d8db931e560d' })
    expect(events.filter(event => event.kind === 'message')).toHaveLength(2)
    expect(events.at(-1)).toEqual({ kind: 'completed', tokens: { input: 49250, cached: 37632, output: 73, reasoning: 0, cacheWrite: 0 } })
    expect(events.some(event => event.kind === 'failed')).toBe(false)
  })

  test('failure: warning items are warnings, the top-level error is the note, turn.failed is the failure', () => {
    const events = readFixture(CODEX_EXEC_0_162_FAILURE.jsonl)
    expect(events.filter(event => event.kind === 'note')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'warning')).toHaveLength(2)
    const failed = events.filter(event => event.kind === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.kind === 'failed' && failed[0].error).toContain('does-not-exist')
    expect(events.some(event => event.kind === 'completed')).toBe(false)
  })

  test('interrupted: no terminal event at all', () => {
    const events = readFixture(CODEX_EXEC_0_162_INTERRUPTED.jsonl)
    expect(events.some(event => event.kind === 'completed' || event.kind === 'failed' || event.kind === 'note' || event.kind === 'warning')).toBe(false)
    expect(events.at(-1)).toEqual({ kind: 'activity', text: "$ /bin/zsh -lc 'sleep 60; echo done'" })
  })

  test('resume: the same thread id as the session it resumed', () => {
    const [first] = readFixture(CODEX_EXEC_0_162_RESUME.jsonl)
    const [original] = readFixture(CODEX_EXEC_0_162_SUCCESS.jsonl)
    expect(first).toEqual(original)
  })

  test('approval: a failed command item is only activity, then the retry and turn.completed', () => {
    const events = readFixture(CODEX_EXEC_0_162_APPROVAL.jsonl)
    expect(events).toContainEqual({ kind: 'activity', text: "$ /bin/zsh -lc 'curl -sI https://example.com' → 6" })
    expect(events).toContainEqual({ kind: 'activity', text: "$ /bin/zsh -lc 'curl -sI https://example.com' → 0" })
    expect(events.some(event => event.kind === 'failed' || event.kind === 'note' || event.kind === 'warning')).toBe(false)
    expect(events.at(-1)?.kind).toBe('completed')
  })
})
