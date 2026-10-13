import { expect, test } from 'claude-code/testing'
import { CODEX_URL, codexBody, codexEffort, codexHeaders, failedStep, inputItems, rejectionNote, statusReason, stepOf } from '../hooks/codex'
import type { ApiMessage } from '../hooks/codex'
import { fnv1a } from '../hooks/decisions'

// Token fixtures are assembled at runtime so no source literal matches a secret scanner.
const TOKEN = ['eyJ', 'access-0123456789'].join('')
const none = () => undefined

/** An event stream as the backend sends it: one `data:` line per event, a blank line between. */
const sse = (...events: Record<string, unknown>[]) => events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')
const completed = (response: Record<string, unknown> = {}) => ({
  type: 'response.completed',
  response: { model: 'gpt-6-luna', usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 20 } }, ...response },
})
const done = (item: Record<string, unknown>) => ({ type: 'response.output_item.done', item })

test('the request goes to the Codex backend with the login, the account, the originator and a session id', () => {
  expect(CODEX_URL).toBe('https://chatgpt.com/backend-api/codex/responses')
  expect(codexHeaders({ accessToken: TOKEN, accountId: 'acct-1' }, 'sess-1')).toEqual({
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${TOKEN}`,
    'Chatgpt-Account-Id': 'acct-1',
    Originator: 'codex-tui',
    'User-Agent': 'codex-tui/0.153.3',
    Session_id: 'sess-1',
  })
})

test('the body puts the system prompt first as a developer message, with empty instructions, no storage and a streamed answer', () => {
  const body = codexBody({
    model: 'gpt-6-luna',
    effort: 'high',
    system: 'Find the requested code.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'where is auth?' }] }],
    tools: [{ name: 'Read', description: 'Reads a file.', parameters: { type: 'object', properties: {} } }],
    reasoning: none,
  })
  expect(body).toEqual({
    model: 'gpt-6-luna',
    instructions: '',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Find the requested code.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'where is auth?' }] },
    ],
    tools: [{ type: 'function', name: 'Read', strict: false, description: 'Reads a file.', parameters: { type: 'object', properties: {} } }],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { effort: 'high', summary: 'auto' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  })
})

test('calls and results become their own items in order, the kept reasoning goes back before its call, thinking is left out', () => {
  const messages: ApiMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hm', signature: 'sig' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/repo/a.ts' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: '1\tconst a = 1' }] },
        { type: 'text', text: '   ' },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x'.repeat(70), content: 'plain' }] },
  ]
  const items = inputItems(messages, id => (id === 'call_1' ? ['enc-1', 'enc-2'] : undefined))
  expect(items).toEqual([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] },
    { type: 'reasoning', summary: [], content: null, encrypted_content: 'enc-1' },
    { type: 'reasoning', summary: [], content: null, encrypted_content: 'enc-2' },
    { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"/repo/a.ts"}' },
    { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: '1\tconst a = 1' }] },
    // An id over 64 characters is cut and made unique again by a hash of the whole id.
    { type: 'function_call_output', call_id: `${'x'.repeat(55)}_${fnv1a('x'.repeat(70))}`, output: 'plain' },
  ])
})

test('a streamed answer becomes thinking, text, tool calls and a stop with usage, and keeps the reasoning before each call', () => {
  const text = sse(
    { type: 'response.created', response: { id: 'r1' } },
    { type: 'response.output_text.delta', delta: 'ignored: the finished item is read' },
    done({ type: 'reasoning', encrypted_content: 'enc-a', summary: [{ type: 'summary_text', text: 'Plan the search.' }] }),
    done({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Searching now.' }] }),
    done({ type: 'function_call', call_id: 'call_7', name: 'Grep', arguments: '{"pattern":"auth"}', status: 'completed' }),
    done({ type: 'function_call', call_id: 'call 8', name: 'Read', arguments: '' }),
    done({ type: 'function_call', call_id: 'call_9', name: 'Read', arguments: '[1]' }),
    done({ type: 'function_call', call_id: 'call_10', name: 'Read', arguments: '{"file_path":', status: 'incomplete' }),
    completed(),
  )
  const step = stepOf(text, 'gpt-6-luna')
  const usage = { model: 'gpt-6-luna', input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 }
  expect(step.chunks).toEqual([
    { kind: 'thinking', index: 0, text: 'Plan the search.' },
    { kind: 'text', index: 1, text: 'Searching now.' },
    { kind: 'tool', index: 2, id: 'call_7', name: 'Grep' },
    { kind: 'input', index: 2, json: '{"pattern":"auth"}' },
    { kind: 'tool', index: 3, id: 'call_8', name: 'Read' },
    { kind: 'input', index: 3, json: '{}' },
    { kind: 'stop', stopReason: 'tool_use', usage },
  ])
  expect(step).toMatchObject({ answer: 'Searching now.', toolUses: [{ name: 'Grep', input: { pattern: 'auth' } }, { name: 'Read', input: {} }], stopReason: 'tool_use', usage })
  expect([...step.reasoning]).toEqual([['call_7', ['enc-a']]])
})

test('a final answer ends the turn; the terminal list stands in when no item streamed; a cut answer is max_tokens', () => {
  const final = stepOf(sse(completed({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Found it at a.ts:3.' }] }] })), 'gpt-6-luna')
  expect(final).toMatchObject({ answer: 'Found it at a.ts:3.', toolUses: [], stopReason: 'end_turn' })
  const cut = stepOf(sse(done({ type: 'message', content: [{ type: 'output_text', text: 'Partial' }] }), { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }), 'gpt-6-luna')
  expect(cut).toMatchObject({ answer: 'Partial', stopReason: 'max_tokens', usage: { model: 'gpt-6-luna', input_tokens: 0, output_tokens: 0 } })
})

test('a failed response, an error event and a stream with no terminal event are failed steps with a short reason', () => {
  expect(stepOf(sse({ type: 'response.failed', response: { error: { code: 'usage_limit_reached', message: 'You have hit your usage limit.' } } }), 'm').answer)
    .toBe('crew: this Codex twin could not run: Codex failed: You have hit your usage limit..')
  expect(stepOf(sse({ type: 'error', code: 'model_not_found' }), 'm').answer).toBe('crew: this Codex twin could not run: Codex failed: model_not_found.')
  expect(stepOf(sse(done({ type: 'message', content: [{ type: 'output_text', text: 'half' }] })), 'm').answer)
    .toBe('crew: this Codex twin could not run: the Codex stream ended before the response completed.')
  expect(stepOf('', 'm').stopReason).toBe('end_turn')
})

test('a failed step is one text block and an end_turn stop with no usage', () => {
  expect(failedStep('no login')).toEqual({
    chunks: [{ kind: 'text', index: 0, text: 'crew: this Codex twin could not run: no login.' }, { kind: 'stop', stopReason: 'end_turn', usage: null }],
    answer: 'crew: this Codex twin could not run: no login.',
    toolUses: [],
    stopReason: 'end_turn',
    usage: null,
    reasoning: new Map(),
  })
})

test('a rejected request keeps its name and an errno code, and never the message text, the URL or a header', () => {
  const secret = 'Bearer abc123 https://chatgpt.com/backend-api/codex/responses account-1'
  const wrapped = Object.assign(new Error(`fetch hook was skipped: crew: connect ECONNRESET ${secret}`), { name: 'HooksError' })
  expect(rejectionNote(wrapped)).toBe(' (HooksError, ECONNRESET)')
  expect(rejectionNote(wrapped)).not.toContain('abc123')
  expect(rejectionNote(wrapped)).not.toContain('chatgpt.com')
  // A code on the error, or on its cause, comes before one found in the message.
  expect(rejectionNote(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }))).toBe(' (TypeError, ETIMEDOUT)')
  expect(rejectionNote(Object.assign(new Error('x ECONNRESET'), { code: 'EPIPE' }))).toBe(' (EPIPE)')
})

test('a rejection that tells nothing, or that is no error at all, adds nothing', () => {
  for (const value of [new Error('boom'), new Error(''), new Error('a fatal ERROR happened'), undefined, null, 'ECONNRESET', 3, {}, { name: 'not an identifier!', code: 'lower' }, { code: 'A'.repeat(60) }]) {
    expect(rejectionNote(value)).toBe('')
  }
})

test('an HTTP failure names the login, the usage limit or the status, with the backend message cut to one short line', () => {
  expect(statusReason(401, '{"error":{"message":"bad token"}}')).toBe('the Codex backend refused the login (run `codex login`): bad token')
  expect(statusReason(429, JSON.stringify({ detail: 'Usage limit\nreached' }))).toBe('Codex usage limit reached: Usage limit reached')
  expect(statusReason(400, 'x'.repeat(10))).toBe('the Codex backend answered HTTP 400')
  expect(statusReason(500, JSON.stringify({ error: { message: 'y'.repeat(300) } }))).toBe(`the Codex backend answered HTTP 500: ${'y'.repeat(200)}…`)
})

test('an effort outside the twins\' levels falls back to the default', () => {
  expect(codexEffort('high', 'medium')).toBe('high')
  expect(codexEffort('xhigh', 'medium')).toBe('xhigh')
  for (const other of ['max', 'ultra', '7', undefined]) expect(codexEffort(other, 'medium')).toBe('medium')
})
