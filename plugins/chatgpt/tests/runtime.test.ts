import { expect, test } from 'claude-code/testing'
import { readAttachments } from '../hooks/attachments'
import { performRequest, runNow } from '../hooks/execution'
import { createJobs } from '../hooks/jobs'
import type { Outcome, OutputDeps, ProcessRunner, Request, RequestRunner } from '../hooks/model'
import { saveAnswer, saveImages } from '../hooks/output'
import { taskQueue } from '../hooks/queue'
import { browserOf } from '../hooks/terminal-browser'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('the CLI adapter caches the first listing and retries a starting tab through the runner', async () => {
  const calls: { argv: string[]; init?: Parameters<ProcessRunner>[1] }[] = []
  let starting = true
  const run: ProcessRunner = async (argv, init) => {
    calls.push({ argv, init })
    if (argv.includes('eval') && starting) {
      starting = false
      return { exitCode: 1, stdout: '', stderr: 'no CDP target yet' }
    }
    return { exitCode: 0, stdout: '{"browsers":[{"key":"b","tabs":[{"id":1}]}]}', stderr: '' }
  }
  const browser = await browserOf(run)
  if (typeof browser === 'string') throw new Error(browser)
  expect(await browser.tabs()).toEqual(['b:1'])
  expect(calls).toEqual([{ argv: ['terminal-browser', 'ls', '--json'], init: { timeoutMs: 15_000 } }])
  await browser.js('b:1', 'return JSON.stringify({ok: true})')
  expect(calls.slice(1).map(call => call.argv)).toEqual([
    ['terminal-browser', 'action', '--browser', 'b', '--tab', '1', '--', 'eval', '(async () => {\nreturn JSON.stringify({ok: true})\n})()'],
    ['sleep', '0.25'],
    ['terminal-browser', 'action', '--browser', 'b', '--tab', '1', '--', 'eval', '(async () => {\nreturn JSON.stringify({ok: true})\n})()'],
  ])
  expect(calls[1]?.init).toEqual({ timeoutMs: 120_000 })
  await browser.tabs()
  expect(calls.at(-1)?.argv).toEqual(['terminal-browser', 'ls', '--json'])
})

test('the CLI adapter preserves availability errors and turns wait failures into false', async () => {
  expect(await browserOf(async () => { throw new Error('missing') })).toBe(
    'No browser to drive ChatGPT with. terminal-browser said: terminal-browser is not installed (https://terminal-browser.sh). Run Claude Code directly in a Ghostty or kitty pane with terminal-browser installed.',
  )
  const calls: { argv: string[]; init?: Parameters<ProcessRunner>[1] }[] = []
  const browser = await browserOf(async (argv, init) => {
    calls.push({ argv, init })
    return argv.includes('ls')
      ? { exitCode: 0, stdout: '{"browsers":[]}', stderr: '' }
      : { exitCode: 1, stdout: '', stderr: 'timed out' }
  })
  if (typeof browser === 'string') throw new Error(browser)
  expect(await browser.waitFor('b:2', 'ready', 25)).toBe(false)
  expect(calls.at(-1)).toEqual({
    argv: ['terminal-browser', 'action', '--browser', 'b', '--tab', '2', '--', 'wait', '--fn', 'ready', '--timeout', '25'],
    init: { timeoutMs: 10_025 },
  })
})

test('attachment checks accept the size boundary and stop before later files on failure', async () => {
  const calls: string[] = []
  const files = { stat: async (path: string) => {
    calls.push(path)
    if (path === '/missing') throw new Error('absent')
    return { size: 4 * 1024 * 1024 + (path === '/large' ? 1 : 0) }
  } }
  expect(await readAttachments(files, ['/ref.PNG'])).toEqual([{ name: 'ref.PNG', type: 'image/png', path: '/ref.PNG' }])
  expect(await readAttachments(files, ['relative', '/later'])).toBe('relative must be an absolute path.')
  expect(await readAttachments(files, ['/large', '/later'])).toBe('/large is over 4 MiB.')
  expect(await readAttachments(files, ['/missing', '/later'])).toBe('Could not read /missing (absent).')
  expect(calls).toEqual(['/ref.PNG', '/large', '/missing'])
})

test('answer persistence saves partial Markdown with its chat header and honors an explicit path', async () => {
  const writes: [string, string][] = []
  const files = { write: async (path: string, text: string) => { writes.push([path, text]) }, readBytes: async () => ({ base64: '' }) }
  const result = { ok: false as const, url: 'https://chatgpt.com/c/partial', error: 'still going', markdown: 'partial', timedOut: true }
  const request: Request = { kind: 'ask', input: { prompt: 'question' }, filePaths: [], out: '/out/answer.md' }
  const outcome = await saveAnswer({ files, tmpDir: async () => { throw new Error('unused') } }, result, request)
  expect(writes).toEqual([['/out/answer.md', '<!-- https://chatgpt.com/c/partial -->\n\npartial\n']])
  expect(outcome).toEqual({
    ok: false,
    text: 'still going\nPartial answer saved to /out/answer.md.',
    timedOut: true,
    chatUrl: result.url,
    paths: ['/out/answer.md'],
  })
  writes.length = 0
  await saveAnswer({ files, tmpDir: async () => undefined }, result, { ...request, out: undefined })
  expect(writes[0]?.[0]).toMatch(/^\/tmp\/chatgpt\/\d{8}-\d{6}-question\.md$/)
})

test('image persistence keeps saved variants on a later write failure and cleans up failed previews', async () => {
  const calls: string[][] = []
  const deps: OutputDeps = {
    run: async (argv, init) => {
      calls.push(argv)
      if (argv[0] === 'rm') throw new Error('cleanup failed')
      if (argv[0] === 'openssl') {
        expect(init?.timeoutMs).toBe(60_000)
        expect(init?.stdin).toBe('aW1hZ2U=')
        if (argv.at(-1) === '/out/lamp-2.png') return { exitCode: 1, stdout: '', stderr: ' disk full ' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    files: { write: async () => {}, readBytes: async () => { throw new Error('preview unavailable') } },
    tmpDir: async () => { throw new Error('unused') },
  }
  const image = { base64: 'aW1hZ2U=', type: 'image/png', width: 1024, height: 1024, alt: 'generated' }
  const outcome = await saveImages(deps, { ok: true, url: 'https://chatgpt.com/c/image', images: [image, image] }, {
    kind: 'image', input: { prompt: 'lamp' }, filePaths: [], out: '/out/lamp.png',
  })
  expect(outcome).toEqual({ ok: false, text: 'Could not write /out/lamp-2.png: disk full', chatUrl: 'https://chatgpt.com/c/image', paths: ['/out/lamp-1.png'] })
  expect(calls).toEqual([
    ['mkdir', '-p', '/out'],
    ['openssl', 'base64', '-d', '-A', '-out', '/out/lamp-1.png'],
    ['sips', '-Z', '768', '-s', 'format', 'jpeg', '/out/lamp-1.png', '--out', '/out/lamp-1.png.preview.jpg'],
    ['rm', '-f', '/out/lamp-1.png.preview.jpg'],
    ['mkdir', '-p', '/out'],
    ['openssl', 'base64', '-d', '-A', '-out', '/out/lamp-2.png'],
  ])
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
    return { ok: false, text: 'failed' }
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
  expect(messages[0]).toContain('saved')
  expect(messages[1]).toContain('failed')
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

test('request dispatch reports an unavailable browser before touching attachments or output', async () => {
  const unused = async () => { throw new Error('unused dependency') }
  expect(await performRequest({
    browser: async () => 'unavailable',
    attachments: { stat: unused },
    output: { run: unused, files: { write: unused, readBytes: unused }, tmpDir: unused },
  }, { kind: 'ask', input: { prompt: 'question' }, filePaths: ['/ref.png'] }, {})).toEqual({ ok: false, text: 'unavailable' })
})
