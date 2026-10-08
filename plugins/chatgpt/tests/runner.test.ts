import { expect, test } from 'claude-code/testing'
import { performRequest, runNow, createJobs, taskQueue } from '../hooks/runner'
import type { Outcome, Request, RequestRunner } from '../hooks/model'
import { NOTICE } from '../hooks/presentation'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('taskQueue runs requests one after another and says how many wait ahead', async () => {
  const run = taskQueue()
  const order: string[] = []
  const ahead: number[] = []
  let release = () => {}
  const gate = new Promise<string>(resolve => (release = () => resolve('a')))
  const first = run(
    () => gate.then(v => (order.push(v), v)),
    n => ahead.push(n),
  )
  const second = run(async () => (order.push('b'), 'b'), n => ahead.push(n))
  const third = run(async () => {
    throw new Error('boom')
  })
  const fourth = run(async () => (order.push('d'), 'd'))
  release()
  expect(await first).toBe('a')
  expect(await second).toBe('b')
  await expect(third).rejects.toThrow('boom')
  expect(await fourth).toBe('d')
  expect(order).toEqual(['a', 'b', 'd'])
  expect(ahead).toEqual([0, 1])
  expect(order.indexOf('b')).toBeGreaterThan(order.indexOf('a'))
})

test('background jobs remain queued until their turn and notify with the settled status', async () => {
  const jobs = createJobs()
  const queue = taskQueue()
  const started = deferred<void>()
  const finish = deferred<Outcome>()
  const notified = deferred<void>()
  const toasts: string[] = []
  const messages: string[] = []
  const perform: RequestRunner = (request, timeoutMs, onStart) => queue(async () => {
    expect(timeoutMs).toBe(30 * 60_000)
    onStart?.()
    if (request.input.prompt === 'first') {
      started.resolve()
      return await finish.promise
    }
    return { ok: false, text: 'failed', error: 'failed' }
  })
  const deps = { perform, notifications: {
    toast: (text: string) => { toasts.push(text) },
    submit: async (text: string) => {
      messages.push(text)
      if (messages.length === 2) notified.resolve()
      throw new Error('submission failed')
    },
  } }
  const request: Request = { kind: 'ask', input: { prompt: 'first' }, filePaths: [] }
  const first = jobs.start(deps, request, 30 * 60_000)
  const second = jobs.start(deps, { ...request, input: { prompt: 'second' } }, 30 * 60_000)
  await started.promise
  expect([first.id, first.status, second.id, second.status]).toEqual([1, 'running', 2, 'queued'])
  finish.resolve({ ok: true, text: 'saved', chatUrl: 'https://chatgpt.com/c/a', paths: ['/out/a.md'] })
  await notified.promise
  expect(first).toMatchObject({ status: 'done', chatUrl: 'https://chatgpt.com/c/a', paths: ['/out/a.md'] })
  expect(second.status).toBe('failed')
  expect(toasts).toEqual(['ChatGPT job #1 done', 'ChatGPT job #2 failed'])
  expect(messages[0]?.split('\n')[0]).toBe(NOTICE)
  expect(messages[0]).toContain('Saved to: /out/a.md')
  expect(messages[0]).not.toContain('\nsaved')
  expect(messages[1]?.split('\n')[0]).toBe(NOTICE)
  expect(messages[1]).toContain('Note: failed')
  expect(jobs.report().split('\n')[0]).toContain('#2 ask failed')
})

test('a foreground timeout continues only a valid chat with saveOnly and no attachments', async () => {
  const requests: Request[] = []
  const request: Request = { kind: 'image', input: { prompt: 'lamp', model: 'chosen' }, filePaths: ['/ref.png'], out: '/out.png' }
  const late: Outcome = { ok: false, text: 'partial', timedOut: true, chatUrl: 'https://chatgpt.com/c/a' }
  const start = (follow: Request) => {
    requests.push(follow)
    return { id: 1, kind: follow.kind, prompt: follow.input.prompt, status: 'queued' as const, startedAt: 0 }
  }
  const outcome = await runNow(async (given, timeoutMs) => {
    expect(given).toEqual(request)
    expect(timeoutMs).toBe(6 * 60_000)
    return late
  }, start, request, 6 * 60_000)
  expect(requests).toEqual([{ ...request, filePaths: [], input: { prompt: 'lamp', chatUrl: late.chatUrl, saveOnly: true } }])
  expect(outcome).toEqual({ ...late, text: 'partial\nStill going: job #1 saves it in the background when it finishes; a message will arrive (the jobs tool shows it meanwhile).' })
  const invalid = { ...late, chatUrl: 'https://example.com/c/a' }
  expect(await runNow(async () => invalid, start, request, 1)).toEqual(invalid)
  expect(requests.length).toBe(1)
})

test('request dispatch checks the attachments before it opens a browser', async () => {
  const opened: string[] = []
  const unused = async () => { throw new Error('unused dependency') }
  const deps = (browser: () => Promise<string>) => ({
    browser,
    attachments: { stat: async () => ({ size: 10 }) },
    output: { run: unused, files: { write: unused, readBytes: unused }, tmpDir: unused },
  })
  // An invalid path answers at once, and no browser is opened.
  expect(await performRequest(deps(async () => { opened.push('browser'); return 'unavailable' }), { kind: 'ask', input: { prompt: 'question' }, filePaths: ['ref.png'] }, {})).toEqual({
    ok: false,
    text: 'ref.png must be an absolute path.',
    error: 'ref.png must be an absolute path.',
  })
  expect(opened).toEqual([])
  // A valid attachment, with no browser, still reports the browser.
  expect(await performRequest(deps(async () => 'unavailable'), { kind: 'ask', input: { prompt: 'question' }, filePaths: ['/ref.png'] }, {})).toEqual({
    ok: false,
    text: 'unavailable',
    error: 'unavailable',
  })
})
