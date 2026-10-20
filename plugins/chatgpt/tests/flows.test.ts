import { expect, test } from 'claude-code/testing'
import type { Browser, Outcome, Request, RequestDeps } from '../hooks/model'
import { createJobs, performRequest, runNow, taskQueue } from '../hooks/runner'
import { askCommandAnswer, imageCommandAnswer, NOTICE } from '../hooks/presentation'
import { inputFor, sendScript, stateScript } from '../hooks/scripts'
import { fakeBrowser, fakeImageBrowser, fakeMenu, scriptKind, turns } from './fake-page'

// Characterization of the ask and image flows end to end, through the runner: run start, submit, waiting,
// saved files, errors, job records and every text the user or the model reads. The expectations are what the
// code does today; a refactor keeps them byte for byte.

const REFERENCE = { name: 'ref.png', type: 'image/png', path: '/x/ref.png' }

/** The host side of a request: the browser, the attachment checks, and the files and processes the save writes. */
function harness(browser: Browser, options: { previews?: boolean } = {}) {
  const writes: { path: string; text: string }[] = []
  const runs: string[][] = []
  const deps: RequestDeps = {
    browser: async () => browser,
    attachments: { stat: async () => ({ size: 12 }) },
    output: {
      run: async argv => {
        runs.push(argv)
        // sips makes the preview; without it the image is saved with the file note only.
        return { exitCode: argv[0] === 'sips' && !options.previews ? 1 : 0, stdout: '', stderr: '' }
      },
      files: {
        write: async (path, text) => {
          writes.push({ path, text })
        },
        readBytes: async () => ({ base64: 'UFJFVklFVw==' }),
      },
      tmpDir: async () => '/tmp/t/',
    },
  }
  return { deps, writes, runs }
}

const ASK_SETTLED = [{ turns: turns(0) }, { turns: turns(1), length: 5 }, { turns: turns(1), length: 5 }]

test('an ask run starts in the plugin tab, sends, waits for the settled answer and saves it at out', async () => {
  const { browser, calls } = fakeBrowser({
    tabs: ['seed'],
    pages: [
      { turns: turns(2) },
      { turns: turns(2), stop: true },
      { turns: turns(3), stop: true, length: 10 },
      { turns: turns(3), stop: false, length: 40 },
      { turns: turns(3), stop: false, length: 40 },
    ],
    markdown: '## Answer',
  })
  const h = harness(browser)
  const progress: string[] = []
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [], out: '/out/answer.md' }, {
    pollMs: 0,
    timeoutMs: 60_000,
    tab: { id: 'seed' },
    progress: text => progress.push(text),
  })

  expect(calls).toEqual(['tabs', 'navigate seed https://chatgpt.com/', 'model rows seed', 'model click seed', 'model rows seed', 'model close seed', 'send seed', 'read seed'])
  expect(progress).toEqual(['opening chatgpt.com', 'picking GPT-6', 'waiting for the answer', 'waiting for the answer', 'receiving (10 chars)', 'receiving (40 chars)'])
  expect(h.writes).toEqual([{ path: '/out/answer.md', text: '<!-- https://chatgpt.com/c/abc -->\n\n## Answer\n' }])
  expect(h.runs).toEqual([])
  expect(outcome).toEqual({
    ok: true,
    text: "ChatGPT's answer (unverified; check facts before using them) saved to /out/answer.md\nChat: https://chatgpt.com/c/abc\n\n## Answer",
    chatUrl: 'https://chatgpt.com/c/abc',
    paths: ['/out/answer.md'],
    markdown: '## Answer',
  })
})

test('an ask without out saves under TMPDIR/chatgpt with a timestamp and a slug of the prompt', async () => {
  const { browser } = fakeBrowser({ tabs: ['seed'], pages: ASK_SETTLED, markdown: 'a' })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'Explain: the tradeoffs?' }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' } })

  expect(h.writes.length).toBe(1)
  expect(h.writes[0]!.path).toMatch(/^\/tmp\/t\/chatgpt\/\d{8}-\d{6}-explain-the-tradeoffs\.md$/)
  expect(outcome).toMatchObject({ ok: true, paths: [h.writes[0]!.path] })
})

test('an ask with saveOnly saves the chat\'s last answer, sends nothing and says the chat it came from', async () => {
  const { browser, calls } = fakeBrowser({
    tabs: [],
    pages: [{ turns: turns(4), stop: true, length: 10 }, { turns: turns(4), stop: true, length: 30 }, { turns: turns(4), length: 50 }, { turns: turns(4), length: 50 }],
    markdown: 'the long answer',
  })
  const h = harness(browser)
  const progress: string[] = []
  // A short limit: if the run never settles (a mutated `before`), it times out and the assertions below fail, instead of hanging.
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'x', chatUrl: 'https://chatgpt.com/c/abc-1', saveOnly: true }, filePaths: [], out: '/out/saved.md' }, {
    pollMs: 0,
    timeoutMs: 1000,
    progress: text => progress.push(text),
  })

  expect(calls).toEqual(['open https://chatgpt.com/c/abc-1', 'read t2'])
  expect(progress).toEqual(['opening chatgpt.com', 'waiting for the answer', 'receiving (30 chars)', 'receiving (50 chars)'])
  expect(h.writes).toEqual([{ path: '/out/saved.md', text: '<!-- https://chatgpt.com/c/abc -->\n\nthe long answer\n' }])
  expect(outcome).toMatchObject({ ok: true, chatUrl: 'https://chatgpt.com/c/abc', text: expect.stringContaining('saved to /out/saved.md\nChat: https://chatgpt.com/c/abc') })
})

// A first backend nobody sees, whose page a check holds, and a second one where the ask goes through.
function heldThenReady() {
  const held = fakeBrowser({ tabs: [], pages: [{ composer: false, blocker: 'Verify you are human' }], markdown: '', name: 'headless' })
  held.browser.notReady = 'Nobody can clear it.'
  const ready = fakeBrowser({ tabs: [], pages: ASK_SETTLED, markdown: '## Answer', name: 'pane' })
  return { held, ready }
}

test('a page nobody can clear moves the request on to the next backend before anything is sent, and the answer says so', async () => {
  const { held, ready } = heldThenReady()
  const h = harness(held.browser)
  const skipped: (string | undefined)[] = []
  const deps: RequestDeps = { ...h.deps, browser: async skip => (skipped.push(skip), skip ? ready.browser : held.browser) }
  const progress: string[] = []
  const outcome = await performRequest(deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [], out: '/out/a.md' }, { pollMs: 0, tab: {}, progress: text => progress.push(text) })

  expect(skipped).toEqual([undefined, 'headless'])
  expect(held.calls).toEqual(['open https://chatgpt.com/'])
  expect(ready.calls).toContain('send t2')
  expect(progress).toContain('ChatGPT is not ready in headless; trying the other browsers')
  const note = 'Note: ChatGPT was not ready in headless (at https://chatgpt.com/), so this request ran in pane; /chatgpt-doctor shows what holds it.'
  expect(outcome).toEqual({
    ok: true,
    text: `${note}\nChatGPT's answer (unverified; check facts before using them) saved to /out/a.md\nChat: https://chatgpt.com/c/abc\n\n## Answer`,
    chatUrl: 'https://chatgpt.com/c/abc',
    paths: ['/out/a.md'],
    markdown: '## Answer',
    note,
  })
})

test('a held request with no other backend to take it says what held it, then what each other backend answered', async () => {
  const { held } = heldThenReady()
  const h = harness(held.browser)
  const deps: RequestDeps = { ...h.deps, browser: async skip => (skip ? 'No browser to drive ChatGPT with. pane said: no pane.' : held.browser) }
  const outcome = await performRequest(deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [] }, { pollMs: 0, tab: {} })

  const text =
    'ChatGPT is not ready in the browser (at https://chatgpt.com/). ChatGPT shows: "Verify you are human". Nobody can clear it.\n' +
    'The other browsers: No browser to drive ChatGPT with. pane said: no pane.'
  expect(outcome).toEqual({ ok: false, text, error: text, chatUrl: 'https://chatgpt.com/' })
  expect(h.writes).toEqual([])
})

test('an image request held in the first backend is generated in the next one', async () => {
  const held = fakeBrowser({ tabs: [], pages: [{ composer: false, blocker: 'Verify you are human' }], markdown: '', name: 'headless' })
  held.browser.notReady = 'Nobody can clear it.'
  const { browser: ready } = fakeImageBrowser({ shots: [{}, { stop: true }, { stop: true, images: 1 }, { images: 1 }], base64: 'B'.repeat(10) })
  const h = harness(held.browser)
  const deps: RequestDeps = { ...h.deps, browser: async skip => (skip ? ready : held.browser) }
  const outcome = await performRequest(deps, { kind: 'image', input: { prompt: 'a cat' }, filePaths: [], out: '/out/cat.png' }, { pollMs: 0, tab: {} })

  expect(outcome.ok).toBe(true)
  expect(outcome.paths).toEqual(['/out/cat.png'])
  expect(outcome.note).toBe(`Note: ChatGPT was not ready in headless (at https://chatgpt.com/), so this request ran in ${ready.name}; /chatgpt-doctor shows what holds it.`)
  expect(outcome.text.split('\n')[0]).toBe(outcome.note)
})

test('a failure after the prompt was sent never moves the request on', async () => {
  const { browser } = fakeBrowser({ tabs: [], pages: [{ turns: turns(0) }, { turns: turns(0), blocker: "You've reached your message limit" }], markdown: '' })
  browser.notReady = 'Nobody can clear it.'
  const asked: (string | undefined)[] = []
  const deps: RequestDeps = { ...harness(browser).deps, browser: async skip => (asked.push(skip), browser) }
  const outcome = await performRequest(deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [] }, { pollMs: 0, tab: {} })

  expect(asked).toEqual([undefined])
  expect(outcome.text).toBe('ChatGPT stopped: "You\'ve reached your message limit".')
})

test('a page held in a backend someone sees, or a logged-out page, ends the request where it is', async () => {
  for (const page of [{ composer: false, blocker: 'Verify you are human' }, { composer: false, login: true }]) {
    const { browser } = fakeBrowser({ tabs: [], pages: [page], markdown: '' })
    if (page.login) browser.notReady = 'Nobody can clear it.'
    const asked: (string | undefined)[] = []
    const deps: RequestDeps = { ...harness(browser).deps, browser: async skip => (asked.push(skip), browser) }
    const outcome = await performRequest(deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [] }, { pollMs: 0, tab: {} })

    expect(asked).toEqual([undefined])
    expect(outcome.ok).toBe(false)
    expect(outcome.note).toBeUndefined()
  }
})

test('an ask whose answer is empty says the page layout changed and saves nothing', async () => {
  const { browser } = fakeBrowser({ tabs: ['seed'], pages: ASK_SETTLED, markdown: '' })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' } })

  expect(h.writes).toEqual([])
  expect(outcome).toEqual({
    ok: false,
    text: 'The answer was empty or the page layout changed.',
    error: 'The answer was empty or the page layout changed.',
    chatUrl: 'https://chatgpt.com/c/abc',
  })
})

test('an ask refused by a limit answers the stop text with its url and saves nothing', async () => {
  const { browser } = fakeBrowser({
    tabs: [],
    pages: [{ turns: turns(0) }, { turns: turns(0), blocker: "You've reached your message limit" }],
    markdown: '',
  })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [] }, { pollMs: 0 })

  expect(h.writes).toEqual([])
  expect(outcome).toEqual({
    ok: false,
    text: 'ChatGPT stopped: "You\'ve reached your message limit".',
    error: 'ChatGPT stopped: "You\'ve reached your message limit".',
    chatUrl: 'https://chatgpt.com/',
  })
})

test('an ask that times out keeps the streamed part in a file and says the chat may still finish', async () => {
  const { browser } = fakeBrowser({ tabs: [], pages: [{ turns: turns(0) }, { turns: turns(1), stop: true, length: 3 }], markdown: 'par' })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [], out: '/out/partial.md' }, { pollMs: 0, timeoutMs: -1 })

  expect(h.writes).toEqual([{ path: '/out/partial.md', text: '<!-- https://chatgpt.com/c/abc -->\n\npar\n' }])
  expect(outcome).toEqual({
    ok: false,
    text: 'No complete answer after 0 s; it may still be streaming at https://chatgpt.com/c/abc.\nPartial answer saved to /out/partial.md.',
    error: 'No complete answer after 0 s; it may still be streaming at https://chatgpt.com/c/abc.',
    chatUrl: 'https://chatgpt.com/c/abc',
    paths: ['/out/partial.md'],
    timedOut: true,
  })
})

test('an ask whose answer loses its connection ends at once as timed out, with the chat url and the part so far', async () => {
  const { browser } = fakeBrowser({
    tabs: [],
    pages: [{ turns: turns(0) }, { turns: turns(1), stop: true, length: 3 }, { turns: turns(1), stop: true, length: 3, interrupted: true }, { turns: turns(1), length: 9 }],
    markdown: 'par',
  })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [], out: '/out/partial.md' }, { pollMs: 0 })

  expect(outcome).toEqual({
    ok: false,
    text: 'ChatGPT lost the connection while answering; the answer may still finish at https://chatgpt.com/c/abc.\nPartial answer saved to /out/partial.md.',
    error: 'ChatGPT lost the connection while answering; the answer may still finish at https://chatgpt.com/c/abc.',
    chatUrl: 'https://chatgpt.com/c/abc',
    paths: ['/out/partial.md'],
    timedOut: true,
  })
})

test('an ask whose connection dropped ends as timed out even when the stop button is gone and the part holds', async () => {
  const { browser } = fakeBrowser({
    tabs: [],
    pages: [{ turns: turns(0) }, { turns: turns(1), stop: true, length: 3 }, { turns: turns(1), length: 3, interrupted: true }],
    markdown: 'par',
  })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [], out: '/out/partial.md' }, { pollMs: 0 })

  expect(outcome).toMatchObject({ ok: false, error: 'ChatGPT lost the connection while answering; the answer may still finish at https://chatgpt.com/c/abc.', timedOut: true })
})

test('saving an answer whose connection dropped keeps waiting for it', async () => {
  const { browser } = fakeBrowser({
    tabs: ['seed'],
    pages: [{ href: 'https://chatgpt.com/c/abc', turns: turns(1), stop: true, length: 3, interrupted: true }, { href: 'https://chatgpt.com/c/abc', turns: turns(1), length: 9 }],
    markdown: 'full text',
  })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi', chatUrl: 'https://chatgpt.com/c/abc', saveOnly: true }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' } })

  expect(outcome.ok).toBe(true)
})

test('saving an answer whose connection dropped keeps waiting even when the stop button is gone and the part holds', async () => {
  const dropped = { href: 'https://chatgpt.com/c/abc', turns: turns(1), length: 3, interrupted: true }
  const { browser } = fakeBrowser({ tabs: ['seed'], pages: [dropped, dropped], markdown: 'par' })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi', chatUrl: 'https://chatgpt.com/c/abc', saveOnly: true }, filePaths: [] }, { pollMs: 0, timeoutMs: -1, tab: { id: 'seed' } })

  // Still waiting when the time runs out: the part is never saved as the answer.
  expect(outcome).toMatchObject({ ok: false, timedOut: true })
})

test('an ask whose prompt the page refuses answers the send text, with the page url and no file', async () => {
  const { browser } = fakeBrowser({ tabs: ['seed'], pages: [{}], markdown: '', sent: false })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' } })

  expect(h.writes).toEqual([])
  expect(outcome).toEqual({
    ok: false,
    text: 'Could not send the prompt: send button not found.',
    error: 'Could not send the prompt: send button not found.',
    chatUrl: 'https://chatgpt.com/',
  })
})

test('an ask on a logged-out page answers the not-ready text that names the browsers, and sends nothing', async () => {
  const { browser, calls } = fakeBrowser({ tabs: ['seed'], pages: [{ composer: false, login: true }], markdown: '' })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' }, backends: ['one', 'two'] })

  expect(calls.some(call => call.startsWith('send'))).toBe(false)
  expect(h.writes).toEqual([])
  expect(outcome).toEqual({
    ok: false,
    text:
      'ChatGPT is not ready in the browser (at https://chatgpt.com/). Ask the user to log in to chatgpt.com in the browser the plugin uses (one or two), ' +
      'or to clear what the page shows, and try again; never type credentials.',
    error:
      'ChatGPT is not ready in the browser (at https://chatgpt.com/). Ask the user to log in to chatgpt.com in the browser the plugin uses (one or two), ' +
      'or to clear what the page shows, and try again; never type credentials.',
    chatUrl: 'https://chatgpt.com/',
  })
})

test('an ask with an invalid chatUrl, or saveOnly without one, answers its error before any page is touched', async () => {
  const { browser, calls } = fakeBrowser({ tabs: [], pages: [{}], markdown: '' })
  const h = harness(browser)
  const bad = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'more', chatUrl: 'https://evil.example/c/1' }, filePaths: [] }, { pollMs: 0 })
  const unsaved = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'more', saveOnly: true }, filePaths: [] }, { pollMs: 0 })

  expect(calls).toEqual([])
  expect(bad).toEqual({
    ok: false,
    text: 'chatUrl must be a chat link like https://chatgpt.com/c/<id>, not https://evil.example/c/1.',
    error: 'chatUrl must be a chat link like https://chatgpt.com/c/<id>, not https://evil.example/c/1.',
  })
  expect(unsaved).toEqual({
    ok: false,
    text: 'saveOnly needs the chatUrl of the chat with the answer.',
    error: 'saveOnly needs the chatUrl of the chat with the answer.',
  })
})

test('an ask with a model that is not on the menu answers the offered models and sends nothing', async () => {
  const { browser, calls } = fakeBrowser({ tabs: ['seed'], pages: [{}], markdown: '', menu: fakeMenu(['Latest'], 'Latest') })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi', model: 'gpt-9' }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' } })

  expect(calls.some(call => call.startsWith('send'))).toBe(false)
  expect(outcome).toMatchObject({
    ok: false,
    text: 'Could not pick the model "gpt-9": no such entry. The menu offers: latest.',
    error: 'Could not pick the model "gpt-9": no such entry. The menu offers: latest.',
  })
})

test('an ask whose model row is gone by the click closes the menu, sets no effort and sends nothing', async () => {
  const { browser, calls } = fakeBrowser({ tabs: ['seed'], pages: [{}], markdown: '', menu: fakeMenu(['GPT-6'], 'GPT-6', { effort: 'high', gone: true }) })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [] }, { pollMs: 0, timeoutMs: -1, tab: { id: 'seed' } })

  expect(calls).toEqual(['tabs', 'navigate seed https://chatgpt.com/', 'model rows seed', 'model click seed', 'model close seed'])
  expect(outcome).toMatchObject({
    ok: false,
    error: 'Could not pick the model "GPT-6": its menu entry was gone by the click.',
  })
})

test('an ask with a model reads the menu again after the attachments and sends only while that model is checked', async () => {
  const { browser, calls } = fakeBrowser({ tabs: ['seed'], pages: ASK_SETTLED, markdown: 'ok' })
  const h = harness(browser)
  const outcome = await performRequest(
    h.deps,
    { kind: 'ask', input: { prompt: 'hi', model: 'GPT-5.6 Sol' }, filePaths: ['/x/notes.md'], out: '/out/a.md' },
    { pollMs: 0, tab: { id: 'seed' } },
  )

  expect(calls).toEqual([
    'tabs',
    'navigate seed https://chatgpt.com/',
    'model rows seed',
    'model click seed',
    `upload seed ${inputFor('text/markdown')} /x/notes.md`,
    'model rows seed',
    'model close seed',
    'send seed',
    'read seed',
  ])
  expect(outcome).toMatchObject({ ok: true, paths: ['/out/a.md'] })
})

test('an ask whose model menu shows another model checked before the send sends nothing and says which', async () => {
  // The click does not take: the page keeps GPT-6 checked.
  const { browser, calls } = fakeBrowser({ tabs: ['seed'], pages: [{}], markdown: '', menu: fakeMenu(['GPT-6', 'GPT-5.6 Sol'], 'GPT-6', { stuck: true }) })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi', model: 'GPT-5.6 Sol' }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' } })

  expect(calls).toEqual(['tabs', 'navigate seed https://chatgpt.com/', 'model rows seed', 'model click seed', 'model rows seed', 'model close seed'])
  expect(h.writes).toEqual([])
  expect(outcome).toEqual({
    ok: false,
    text: 'The model menu shows "gpt-6" checked instead of "GPT-5.6 Sol"; the prompt was not sent.',
    error: 'The model menu shows "gpt-6" checked instead of "GPT-5.6 Sol"; the prompt was not sent.',
    chatUrl: 'https://chatgpt.com/',
  })
})

test('an ask picks and checks a GPT model by its version whether the menu names the row "GPT-6" or only "6"', async () => {
  // Each menu as one rollout of chatgpt.com names its rows, the label asked for, and the row that ends up checked.
  const cases = [
    { rows: ['6', 'GPT-5.6 Sol'], model: 'GPT-6', checked: '6' },
    { rows: ['6', 'GPT-5.6 Sol'], model: 'gpt 6', checked: '6' },
    { rows: ['GPT-6', 'GPT-5.6 Sol'], model: '6', checked: 'GPT-6' },
    { rows: ['6', 'GPT-5.6 Sol'], model: 'GPT-5.6 Sol', checked: 'GPT-5.6 Sol' },
    { rows: ['6', 'GPT-5.6 Sol'], model: '5.6', checked: 'GPT-5.6 Sol' },
  ]
  for (const { rows, model, checked } of cases) {
    const menu = fakeMenu(rows, rows.find(row => row !== checked)!)
    const { browser, calls } = fakeBrowser({ tabs: ['seed'], pages: ASK_SETTLED, markdown: 'ok', menu })
    const h = harness(browser)
    const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi', model }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' } })

    expect({ model, outcome: outcome.ok, checked: menu.checked() }).toEqual({ model, outcome: true, checked })
    expect(calls).toEqual(['tabs', 'navigate seed https://chatgpt.com/', 'model rows seed', 'model click seed', 'model rows seed', 'model close seed', 'send seed', 'read seed'])
  }
})

test('an ask with a GPT version the menu does not have offers the rows as the menu names them and sends nothing', async () => {
  const menu = fakeMenu(['6', 'GPT-5.6 Sol'], '6')
  const { browser, calls } = fakeBrowser({ tabs: ['seed'], pages: [{}], markdown: '', menu })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi', model: 'GPT-7' }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' } })

  expect(calls).toEqual(['tabs', 'navigate seed https://chatgpt.com/', 'model rows seed', 'model close seed'])
  expect(menu.checked()).toBe('6')
  expect(outcome).toMatchObject({ ok: false, error: 'Could not pick the model "GPT-7": no such entry. The menu offers: 6, gpt-5.6 sol.' })
})

test('an ask that names no model picks GPT-6 at medium effort on a new chat, walking the slider from where it stands', async () => {
  // Each start: the checked row and effort, and the slider steps it takes to reach medium.
  const cases = [
    { checked: 'GPT-5.6 Sol', effort: 'high', steps: ['model effort seed'] },
    { checked: '6', effort: 'none', steps: ['model effort seed'] },
    { checked: '6', effort: 'medium', steps: [] },
  ]
  for (const { checked, effort, steps } of cases) {
    const menu = fakeMenu(['6', 'GPT-5.6 Sol'], checked, { effort })
    const { browser, calls } = fakeBrowser({ tabs: ['seed'], pages: ASK_SETTLED, markdown: 'ok', menu })
    const h = harness(browser)
    const progress: string[] = []
    const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' }, progress: text => progress.push(text) })

    expect({ start: [checked, effort], ok: outcome.ok, model: menu.checked(), effort: menu.effort() }).toEqual({ start: [checked, effort], ok: true, model: '6', effort: 'medium' })
    expect(calls).toEqual(['tabs', 'navigate seed https://chatgpt.com/', 'model rows seed', 'model click seed', ...steps, 'model rows seed', 'model close seed', 'send seed', 'read seed'])
    expect(progress.slice(0, 3)).toEqual(['opening chatgpt.com', 'picking GPT-6', steps.length ? 'setting the effort to medium' : 'waiting for the answer'])
  }
})

test('an ask whose effort slider cannot reach medium says what it offers, closes the menu and sends nothing', async () => {
  const cases = [
    { menu: fakeMenu(['6'], '6', { effort: 'high', stuckEffort: true }), error: 'Could not set the effort "medium": the slider offers high.' },
    { menu: fakeMenu(['6'], '6', { efforts: ['low', 'high'], effort: 'high' }), error: 'Could not set the effort "medium": the slider offers high, low.' },
  ]
  for (const { menu, error } of cases) {
    const { browser, calls } = fakeBrowser({ tabs: ['seed'], pages: [{}], markdown: '', menu })
    const h = harness(browser)
    const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' } })

    expect(outcome).toMatchObject({ ok: false, error })
    expect(calls.at(-1)).toBe('model close seed')
    expect(calls.some(call => call.startsWith('send'))).toBe(false)
  }
})

test('an ask that names a model leaves its effort as it is, and a follow-up in a chat picks nothing', async () => {
  const menu = fakeMenu(['6', 'GPT-5.6 Sol'], '6', { effort: 'high' })
  const named = fakeBrowser({ tabs: ['seed'], pages: ASK_SETTLED, markdown: 'ok', menu })
  const outcome = await performRequest(harness(named.browser).deps, { kind: 'ask', input: { prompt: 'hi', model: 'GPT-5.6 Sol' }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' } })
  expect(outcome.ok).toBe(true)
  expect(named.calls.some(call => call === 'model effort seed')).toBe(false)
  expect([menu.checked(), menu.effort()]).toEqual(['GPT-5.6 Sol', 'high'])

  const followUp = fakeBrowser({ tabs: ['seed'], pages: [{ turns: turns(1) }, { turns: turns(2), length: 3 }, { turns: turns(2), length: 3 }], markdown: 'ok' })
  const next = await performRequest(harness(followUp.browser).deps, { kind: 'ask', input: { prompt: 'more', chatUrl: 'https://chatgpt.com/c/abc' }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' } })
  expect(next.ok).toBe(true)
  expect(followUp.calls.some(call => call.startsWith('model'))).toBe(false)
})

test('an ask whose effort moved off medium before the send sends nothing and says which effort shows', async () => {
  const menu = fakeMenu(['6'], '6', { effort: 'high' })
  const { browser, calls } = fakeBrowser({ tabs: ['seed'], pages: [{}], markdown: '', menu })
  // Something moves the slider back up between the walk and the check.
  const js = browser.js
  let reads = 0
  browser.js = async (tabId, code) => {
    if (scriptKind(code) === 'model rows' && ++reads === 2) menu.step('"ArrowRight"')
    return js(tabId, code)
  }
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' } })

  expect(calls.some(call => call.startsWith('send'))).toBe(false)
  expect(outcome).toMatchObject({ ok: false, error: 'The model menu shows the effort "high" instead of "medium"; the prompt was not sent.' })
})

test('an ask says it is receiving only once the exchange it added holds text', async () => {
  const { browser } = fakeBrowser({
    tabs: ['seed'],
    pages: [
      { turns: turns(1) },
      // The new exchange shows up before its answer has any text.
      { turns: turns(2), stop: true, length: 0 },
      { turns: turns(2), stop: true, length: 4 },
      { turns: turns(2), length: 4 },
    ],
    markdown: 'PONG',
  })
  const h = harness(browser)
  const progress: string[] = []
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' }, progress: text => progress.push(text) })

  expect(outcome.ok).toBe(true)
  expect(progress).toEqual(['opening chatgpt.com', 'picking GPT-6', 'waiting for the answer', 'waiting for the answer', 'receiving (4 chars)'])
})

test('an ask waits for the exchange it added, not for an old one the chat remounts while it streams', async () => {
  const { browser, calls } = fakeBrowser({
    tabs: ['seed'],
    pages: [
      { turns: ['a', 'b'], length: 30 },
      // An old exchange remounts above the others: one more on the page, its last one still known.
      { turns: ['old', 'a', 'b'], length: 30 },
      { turns: ['old', 'a', 'b'], length: 30 },
      { turns: ['old', 'a', 'b', 'mine'], length: 7 },
      { turns: ['old', 'a', 'b', 'mine'], length: 7 },
    ],
    markdown: 'my answer',
  })
  const h = harness(browser)
  const progress: string[] = []
  const outcome = await performRequest(h.deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [], out: '/out/a.md' }, {
    pollMs: 0,
    tab: { id: 'seed' },
    progress: text => progress.push(text),
  })

  expect(calls).toEqual(['tabs', 'navigate seed https://chatgpt.com/', 'model rows seed', 'model click seed', 'model rows seed', 'model close seed', 'send seed', 'read seed'])
  expect(progress).toEqual(['opening chatgpt.com', 'picking GPT-6', 'waiting for the answer', 'waiting for the answer', 'waiting for the answer', 'receiving (7 chars)'])
  expect(outcome).toMatchObject({ ok: true, markdown: 'my answer' })
})

test('an image run attaches the reference, sends, waits for the image and saves it with its preview', async () => {
  const { browser, calls } = fakeImageBrowser({ shots: [{}, { stop: true }, { stop: true, images: 1 }, { images: 1 }], base64: 'B'.repeat(10) })
  const h = harness(browser, { previews: true })
  const progress: string[] = []
  const outcome = await performRequest(h.deps, { kind: 'image', input: { prompt: 'a lamp' }, filePaths: ['/x/ref.png'], out: '/out/lamp.png' }, {
    pollMs: 0,
    progress: text => progress.push(text),
  })

  expect(calls).toEqual(['navigate https://chatgpt.com/', `upload ${inputFor('image/png')} /x/ref.png`, 'attach', 'send', 'image'])
  expect(progress).toEqual(['opening chatgpt.com', 'picking GPT-6', `attaching ${REFERENCE.name}`, 'waiting for the image', 'generating the image', 'generating the image', 'saving the image'])
  expect(h.runs).toEqual([
    ['mkdir', '-p', '/out'],
    ['openssl', 'base64', '-d', '-A', '-out', '/out/lamp.png'],
    ['sips', '-Z', '768', '-s', 'format', 'jpeg', '/out/lamp.png', '--out', '/out/lamp.png.preview.jpg'],
    ['rm', '-f', '/out/lamp.png.preview.jpg'],
  ])
  expect(outcome).toEqual({
    ok: true,
    text:
      'AI concept image generated by ChatGPT, saved to:\n- /out/lamp.png (1024x1024, image/png)\nChat: https://chatgpt.com/c/img\n' +
      'A preview of each follows; ask before storing them in a repository and label them as AI concepts.',
    chatUrl: 'https://chatgpt.com/c/img',
    paths: ['/out/lamp.png'],
    previews: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'UFJFVklFVw==' } }],
  })
})

test('an image without a preview keeps the file note, and every variant is saved oldest first', async () => {
  const { browser } = fakeImageBrowser({ shots: [{}, { stop: true, images: 2 }, { images: 2 }], base64: 'B'.repeat(10) })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'image', input: { prompt: 'two lamps' }, filePaths: [], out: '/out/lamp.png' }, { pollMs: 0 })

  expect(outcome).toEqual({
    ok: true,
    text:
      'AI concept images generated by ChatGPT, saved to:\n- /out/lamp-1.png (1024x1024, image/png)\n- /out/lamp-2.png (1024x1024, image/png)\n' +
      'Chat: https://chatgpt.com/c/img\nLook at the file before describing it, and ask before storing it in a repository; label it as an AI concept.',
    chatUrl: 'https://chatgpt.com/c/img',
    paths: ['/out/lamp-1.png', '/out/lamp-2.png'],
    previews: [],
  })
  expect(h.runs.filter(argv => argv[0] === 'openssl').map(argv => argv.at(-1))).toEqual(['/out/lamp-1.png', '/out/lamp-2.png'])
})

test('an image answered with text is a refusal: the plugin error comes first, then ChatGPT\'s words', async () => {
  const { browser, calls } = fakeImageBrowser({ shots: [{}, { turns: turns(1), length: 20 }, { turns: turns(1), length: 20 }], base64: '', text: 'I cannot create that image.' })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'image', input: { prompt: 'a logo' }, filePaths: [] }, { pollMs: 0 })

  expect(calls).not.toContain('image')
  expect(h.writes).toEqual([])
  expect(outcome).toEqual({
    ok: false,
    text:
      'ChatGPT answered with text instead of an image (a refusal or a question); relay it, do not rephrase around a refusal.\n\nChatGPT said:\nI cannot create that image.',
    error: 'ChatGPT answered with text instead of an image (a refusal or a question); relay it, do not rephrase around a refusal.',
    chatUrl: 'https://chatgpt.com/c/img',
    timedOut: undefined,
  })
})

test('an image that never arrives says it may still be generating, and marks the run timed out', async () => {
  const { browser } = fakeImageBrowser({ shots: [{}, { stop: true }], base64: '' })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'image', input: { prompt: 'lamp' }, filePaths: [] }, { pollMs: 0, timeoutMs: -1 })

  expect(outcome).toEqual({
    ok: false,
    text: 'No image after 0 s; it may still be generating at https://chatgpt.com/c/img.',
    error: 'No image after 0 s; it may still be generating at https://chatgpt.com/c/img.',
    chatUrl: 'https://chatgpt.com/c/img',
    timedOut: true,
  })
})

test('an image whose bytes cannot be read back says so, and nothing is written', async () => {
  const { browser } = fakeImageBrowser({ shots: [{}, { stop: true, images: 1 }, { images: 1 }], base64: '' })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'image', input: { prompt: 'lamp' }, filePaths: [] }, { pollMs: 0 })

  expect(h.writes).toEqual([])
  expect(outcome).toEqual({
    ok: false,
    text: 'No generated image could be read from the page.',
    error: 'No generated image could be read from the page.',
    chatUrl: 'https://chatgpt.com/c/img',
  })
})

test('an image whose reference does not attach stops before the prompt is sent', async () => {
  const { browser, calls } = fakeImageBrowser({ shots: [{}], base64: '', attached: false })
  const h = harness(browser)
  const outcome = await performRequest(h.deps, { kind: 'image', input: { prompt: 'a lamp' }, filePaths: ['/x/ref.png'] }, { pollMs: 0 })

  expect(calls).not.toContain('send')
  expect(outcome).toEqual({
    ok: false,
    text: 'Could not attach ref.png: the attachment did not show up in the composer.',
    error: 'Could not attach ref.png: the attachment did not show up in the composer.',
    chatUrl: 'https://chatgpt.com/c/img',
  })
})

test('an image with saveOnly reads the chat\'s last image, sends nothing and names the image in its guard text', async () => {
  const { browser, calls } = fakeImageBrowser({ shots: [{}], base64: 'C'.repeat(11) })
  const h = harness(browser)
  const chatUrl = 'https://chatgpt.com/c/6ac53b54-ec00'
  const outcome = await performRequest(h.deps, { kind: 'image', input: { prompt: 'lamp', chatUrl, saveOnly: true }, filePaths: [], out: '/out/saved.png' }, { pollMs: 0 })

  expect(calls).toEqual([`navigate ${chatUrl}`, 'image'])
  expect(outcome).toMatchObject({ ok: true, paths: ['/out/saved.png'], chatUrl: 'https://chatgpt.com/c/img' })
  const unsaved = await performRequest(h.deps, { kind: 'image', input: { prompt: 'lamp', saveOnly: true }, filePaths: [] }, { pollMs: 0 })
  expect(unsaved).toEqual({
    ok: false,
    text: 'saveOnly needs the chatUrl of the chat with the image.',
    error: 'saveOnly needs the chatUrl of the chat with the image.',
  })
})

test('the job records: a finished ask and image each toast, send a notice without the content, and show in jobs', async () => {
  const askBrowser = fakeBrowser({ tabs: ['seed'], pages: ASK_SETTLED, markdown: 'the answer' })
  const askHarness = harness(askBrowser.browser)
  const askOutcome = await performRequest(askHarness.deps, { kind: 'ask', input: { prompt: 'Explain the tradeoffs' }, filePaths: [], out: '/out/a.md' }, { pollMs: 0, tab: { id: 'seed' } })
  const imageBrowser = fakeImageBrowser({ shots: [{}, { stop: true, images: 1 }, { images: 1 }], base64: 'B'.repeat(10) })
  const imageHarness = harness(imageBrowser.browser)
  const imageOutcome = await performRequest(imageHarness.deps, { kind: 'image', input: { prompt: 'x'.repeat(70) }, filePaths: [], out: '/out/lamp.png' }, { pollMs: 0 })

  const queue = taskQueue()
  const jobs = createJobs()
  const toasts: string[] = []
  const messages: string[] = []
  const submitted = new Promise<void>(resolve => {
    const perform = async (request: Request): Promise<Outcome> => (request.kind === 'ask' ? askOutcome : imageOutcome)
    const deps = {
      perform: (request: Request, timeoutMs: number, onStart?: () => void) => queue(async () => {
        onStart?.()
        return perform(request)
      }),
      notifications: {
        toast: (text: string) => {
          toasts.push(text)
        },
        submit: async (text: string) => {
          messages.push(text)
          if (messages.length === 2) resolve()
        },
      },
    }
    jobs.start(deps, { kind: 'ask', input: { prompt: 'Explain the tradeoffs' }, filePaths: [], out: '/out/a.md' }, 30 * 60_000)
    jobs.start(deps, { kind: 'image', input: { prompt: 'x'.repeat(70) }, filePaths: [], out: '/out/lamp.png' }, 30 * 60_000)
  })
  await submitted

  expect(toasts).toEqual(['ChatGPT job #1 done', 'ChatGPT job #2 done'])
  expect(messages).toEqual([
    [
      NOTICE,
      'job #1 done: ask "Explain the tradeoffs"',
      'Saved to: /out/a.md',
      'Chat: https://chatgpt.com/c/abc',
      'Read the saved file for the answer.',
    ].join('\n'),
    [
      NOTICE,
      `job #2 done: image "${'x'.repeat(60)}"`,
      'Saved to: /out/lamp.png',
      'Chat: https://chatgpt.com/c/img',
      'Look at the file before describing it, and ask before storing it in a repository; label it as an AI concept.',
    ].join('\n'),
  ])
  expect(messages.join('\n')).not.toContain('the answer\n')
  expect(jobs.report()).toBe(
    [
      `#2 image done (took 0 min): ${'x'.repeat(60)}…\n  chat ${'https://chatgpt.com/c/img'}; saved to /out/lamp.png`,
      '#1 ask done (took 0 min): Explain the tradeoffs\n  chat https://chatgpt.com/c/abc; saved to /out/a.md',
    ].join('\n'),
  )
})

test('a foreground ask that outlives its wait continues as a saveOnly job, and the answer says so', async () => {
  const { browser } = fakeBrowser({ tabs: [], pages: [{ turns: turns(0) }, { turns: turns(1), stop: true, length: 3 }], markdown: 'par' })
  const h = harness(browser)
  const request: Request = { kind: 'ask', input: { prompt: 'long', model: undefined }, filePaths: ['/ref.md'], out: '/out/long.md' }
  const started: Request[] = []
  const outcome = await runNow(
    async (given, timeoutMs) => {
      expect(timeoutMs).toBe(60_000)
      return performRequest(h.deps, given, { pollMs: 0, timeoutMs: -1 })
    },
    follow => {
      started.push(follow)
      return { id: 3, kind: follow.kind, prompt: follow.input.prompt, status: 'queued', startedAt: 0 }
    },
    request,
    60_000,
  )

  expect(started).toEqual([{ kind: 'ask', input: { prompt: 'long', chatUrl: 'https://chatgpt.com/c/abc', saveOnly: true }, filePaths: [], out: '/out/long.md' }])
  expect(outcome.text).toBe(
    'No complete answer after 0 s; it may still be streaming at https://chatgpt.com/c/abc.\nPartial answer saved to /out/long.md.' +
      '\nStill going: job #3 saves it in the background when it finishes; a message will arrive (the jobs tool shows it meanwhile).',
  )
})

test('the command answers: an ask gives the answer with its file, an image its file as context, and a failure its text alone', async () => {
  const { browser } = fakeBrowser({ tabs: ['seed'], pages: ASK_SETTLED, markdown: '## Answer' })
  const ask = await performRequest(harness(browser).deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [], out: '/out/answer.md' }, { pollMs: 0, tab: { id: 'seed' } })
  const image = await performRequest(harness(fakeImageBrowser({ shots: [{}, { stop: true, images: 1 }, { images: 1 }], base64: 'B'.repeat(10) }).browser).deps, { kind: 'image', input: { prompt: 'lamp' }, filePaths: [], out: '/out/lamp.png' }, { pollMs: 0 })
  const failed = await performRequest(harness(fakeBrowser({ tabs: [], pages: [{ composer: false, login: true }], markdown: '' }).browser).deps, { kind: 'image', input: { prompt: 'lamp' }, filePaths: [] }, { pollMs: 0 })

  expect(askCommandAnswer(ask)).toEqual({
    text: '## Answer\n\n— ChatGPT, https://chatgpt.com/c/abc\nSaved to /out/answer.md',
    context: ['The user asked ChatGPT through /chatgpt-ask; its answer is saved to /out/answer.md (chat https://chatgpt.com/c/abc).'],
  })
  expect(imageCommandAnswer(image)).toEqual({
    text: image.text,
    context: ['The user generated an AI concept image with /chatgpt-image; it is saved to /out/lamp.png (chat https://chatgpt.com/c/img).'],
  })
  expect(askCommandAnswer(failed)).toEqual({ text: failed.text })
  expect(imageCommandAnswer(failed).context).toBeUndefined()
})

test('without a pollMs option, an ask polls the page every 3 s and an image every 5 s, inside the page script', async () => {
  const ask = fakeBrowser({ tabs: ['seed'], pages: ASK_SETTLED, markdown: 'a' })
  const askJs = ask.browser.js
  const askPolls: string[] = []
  ask.browser.js = async (tabId, code) => {
    if (code === stateScript(3000)) askPolls.push(code)
    return askJs(tabId, code)
  }
  await performRequest(harness(ask.browser).deps, { kind: 'ask', input: { prompt: 'hi' }, filePaths: [] }, { tab: { id: 'seed' } })
  expect(askPolls.length).toBe(2)

  const image = fakeImageBrowser({ shots: [{}, { stop: true, images: 1 }, { images: 1 }], base64: 'B'.repeat(10) })
  const imageJs = image.browser.js
  const imagePolls: string[] = []
  image.browser.js = async (tabId, code) => {
    if (code === stateScript(5000)) imagePolls.push(code)
    return imageJs(tabId, code)
  }
  await performRequest(harness(image.browser).deps, { kind: 'image', input: { prompt: 'lamp' }, filePaths: [], out: '/out/lamp.png' }, {})
  expect(imagePolls.length).toBe(2)
})

test('the prompt of each flow reaches the page unchanged, in the send script of its submit step', async () => {
  const prompt = 'Explain: "quotes" \\ and\nlines'
  const ask = fakeBrowser({ tabs: ['seed'], pages: ASK_SETTLED, markdown: 'a' })
  const askJs = ask.browser.js
  const askSends: string[] = []
  ask.browser.js = async (tabId, code) => {
    if (code === sendScript(prompt)) askSends.push(code)
    return askJs(tabId, code)
  }
  await performRequest(harness(ask.browser).deps, { kind: 'ask', input: { prompt }, filePaths: [] }, { pollMs: 0, tab: { id: 'seed' } })
  expect(askSends.length).toBe(1)

  const image = fakeImageBrowser({ shots: [{}, { stop: true, images: 1 }, { images: 1 }], base64: 'B'.repeat(10) })
  const imageJs = image.browser.js
  const imageSends: string[] = []
  image.browser.js = async (tabId, code) => {
    if (code === sendScript(prompt)) imageSends.push(code)
    return imageJs(tabId, code)
  }
  await performRequest(harness(image.browser).deps, { kind: 'image', input: { prompt }, filePaths: [], out: '/out/lamp.png' }, { pollMs: 0 })
  expect(imageSends.length).toBe(1)
})
