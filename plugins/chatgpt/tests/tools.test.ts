import { expect, test } from 'claude-code/testing'
import type { Job, Outcome, Preview, Request } from '../hooks/model'
import { serve } from '../hooks/tools'

// serve: how a tool call's raw input is answered by the two handlers the plugin passes in.

function handlers(outcome: Outcome = { ok: true, text: 'the answer' }) {
  const started: Request[] = []
  const ran: Request[] = []
  return {
    started,
    ran,
    handlers: {
      startJob: (request: Request): Job => {
        started.push(request)
        return { id: 7, kind: request.kind, prompt: request.input.prompt, status: 'queued', startedAt: 0 }
      },
      runNow: async (request: Request) => {
        ran.push(request)
        return outcome
      },
    },
  }
}

test('serve answers an invalid input as an error result, before any handler runs', async () => {
  const h = handlers()
  expect(await serve('ask', { prompt: '  ' }, h.handlers)).toEqual({ result: 'Give a non-empty prompt.', isError: true })
  expect(await serve('image', { prompt: 'p', model: 'm', chatUrl: 'https://chatgpt.com/c/abc' }, h.handlers)).toEqual({
    result: 'model is picked for a new chat; leave chatUrl out.',
    isError: true,
  })
  // An invalid input is refused even with wait: false.
  expect(await serve('ask', { prompt: '', wait: false }, h.handlers)).toEqual({ result: 'Give a non-empty prompt.', isError: true })
  expect(h.started).toEqual([])
  expect(h.ran).toEqual([])
})

test('serve with wait: false starts a background job and says its number, running nothing now', async () => {
  const h = handlers()
  const answer = await serve('image', { prompt: ' draw ', wait: false, out: '/tmp/x.png' }, h.handlers)
  expect(answer).toEqual({
    result: 'Started job #7. A message arrives when it is saved; the jobs tool lists it meanwhile.',
  })
  expect(h.ran).toEqual([])
  expect(h.started).toEqual([
    { kind: 'image', input: { prompt: 'draw', chatUrl: undefined, model: undefined, saveOnly: false }, filePaths: [], out: '/tmp/x.png', maxChars: undefined },
  ])
})

test('serve waits only for wait: false; any other wait value runs the request now', async () => {
  for (const wait of [undefined, true, 'false', 0, null]) {
    const h = handlers()
    expect(await serve('ask', { prompt: 'p', wait }, h.handlers)).toEqual({ result: 'the answer' })
    expect(h.started).toEqual([])
    expect(h.ran).toHaveLength(1)
  }
})

test('serve passes the parsed request of its kind to runNow and answers its outcome', async () => {
  const h = handlers({ ok: true, text: 'saved to /tmp/a.md' })
  const answer = await serve('ask', { prompt: ' q ', files: ['/a.txt'], maxChars: 10 }, h.handlers)
  expect(answer).toEqual({ result: 'saved to /tmp/a.md' })
  expect(h.ran).toEqual([
    { kind: 'ask', input: { prompt: 'q', chatUrl: undefined, model: undefined, saveOnly: false }, filePaths: ['/a.txt'], out: undefined, maxChars: 10 },
  ])
})

test('serve marks a failed outcome as an error and keeps previews beside the text', async () => {
  const failed = handlers({ ok: false, text: 'ChatGPT stopped: "limit".', error: 'ChatGPT stopped: "limit".' })
  expect(await serve('ask', { prompt: 'p' }, failed.handlers)).toEqual({ result: 'ChatGPT stopped: "limit".', isError: true })

  const preview: Preview = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }
  const withPreview = handlers({ ok: true, text: 'AI concept image', previews: [preview] })
  expect(await serve('image', { prompt: 'p' }, withPreview.handlers)).toEqual({
    result: [{ type: 'text', text: 'AI concept image' }, preview],
  })

  const failedWithPreview = handlers({ ok: false, text: 'half', previews: [preview] })
  expect(await serve('image', { prompt: 'p' }, failedWithPreview.handlers)).toEqual({
    result: [{ type: 'text', text: 'half' }, preview],
    isError: true,
  })
})
