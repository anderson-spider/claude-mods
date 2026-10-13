import { expect, test } from 'claude-code/testing'
import { pageBrowser, pollUntil, type Page } from '../hooks/page-browser'
import { uploadBody } from '../hooks/scripts'

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
  const sleep = async (ms: number): Promise<void> => {
    clock.advance(ms)
  }
  expect(await pollUntil(async () => answers[Math.min(poll++, answers.length - 1)]!, sleep, 5000, clock.now)).toBe(true)
  expect(poll).toBe(3)
})

// A Page whose evaluate answers from `answers` (the last one repeats) and records each expression it was given.
function pageOf(answers: string[] | ((tabId: string, expression: string) => Promise<string>)) {
  const seen: [string, string][] = []
  const page: Page = {
    name: 'fake page',
    tabs: async () => ['t1'],
    openTab: async () => 't2',
    evaluate: async (tabId, expression) => {
      seen.push([tabId, expression])
      if (typeof answers === 'function') return answers(tabId, expression)
      return answers[Math.min(seen.length - 1, answers.length - 1)]!
    },
  }
  return { page, seen }
}

const NO_BYTES = async () => new Uint8Array()

test('pageBrowser js runs its body as an async function in the tab, and returns the page\'s text as a JSON string literal', async () => {
  const { page, seen } = pageOf(['done'])
  const browser = pageBrowser(page, { readBytes: NO_BYTES, sleep: async () => {}, now: () => 0 })

  expect(await browser.js('t1', 'return "x"')).toBe('"done"')
  expect(seen).toEqual([['t1', '(async () => {\nreturn "x"\n})()']])
  expect(await browser.tabs()).toEqual(['t1'])
  expect(await browser.openTab('https://chatgpt.com/')).toBe('t2')
})

test('pageBrowser waitFor polls the check in the tab until it holds, and a check that throws counts as not yet', async () => {
  const clock = clockOf()
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
    clock.advance(ms)
  }
  let calls = 0
  const { page, seen } = pageOf(async () => {
    calls++
    if (calls === 1) throw new Error('the page navigated')
    return calls < 3 ? 'false' : 'true'
  })
  const browser = pageBrowser(page, { readBytes: NO_BYTES, sleep, now: clock.now })

  expect(await browser.waitFor('t1', 'ready', 5000)).toBe(true)
  expect(calls).toBe(3)
  expect(sleeps).toEqual([250, 250])
  expect(seen[0]).toEqual(['t1', '(async () => {\nreturn JSON.stringify(Boolean(ready))\n})()'])
})

test('pageBrowser waitFor gives up at its bound on the wall clock and answers false', async () => {
  const clock = clockOf()
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
    clock.advance(ms)
  }
  const { page, seen } = pageOf(['false'])
  const browser = pageBrowser(page, { readBytes: NO_BYTES, sleep, now: clock.now })

  expect(await browser.waitFor('t1', 'never', 600)).toBe(false)
  expect(seen.length).toBe(4)
  expect(sleeps).toEqual([250, 250, 250])
})

test('pageBrowser upload reads each file by its path and sends the payload through an upload script in the tab', async () => {
  const reads: string[] = []
  const bytes = new Uint8Array([104, 105])
  const { page, seen } = pageOf(['{"uploaded":true}'])
  const browser = pageBrowser(page, {
    readBytes: async path => {
      reads.push(path)
      return bytes
    },
    sleep: async () => {},
    now: () => 0,
  })
  const file = { name: 'notes.md', type: 'text/markdown', path: '/x/notes.md' }
  await browser.upload('t1', 'input[type=file]', [file])

  expect(reads).toEqual(['/x/notes.md'])
  expect(seen).toEqual([['t1', `(async () => {\n${uploadBody('input[type=file]', [{ name: 'notes.md', type: 'text/markdown', base64: 'aGk=' }])}\n})()`]])
})

test('pageBrowser upload throws the page\'s reason when the files do not attach', async () => {
  const { page } = pageOf(['{"uploaded":false,"reason":"no file input"}'])
  const browser = pageBrowser(page, { readBytes: NO_BYTES, sleep: async () => {}, now: () => 0 })

  await expect(browser.upload('t1', 'input[type=file]', [{ name: 'notes.md', type: 'text/markdown', path: '/x/notes.md' }])).rejects.toThrow(
    'could not attach notes.md: no file input',
  )
})

test('pageBrowser awaits the page script only for a backend that says awaitResult, and keeps the bare wrapper for the rest', async () => {
  const seen: string[] = []
  const pageWith = (awaitResult?: boolean): Page => ({
    name: 'fake page',
    awaitResult,
    tabs: async () => [],
    openTab: async () => 't2',
    evaluate: async (_tabId, expression) => {
      seen.push(expression)
      return '"ok"'
    },
  })
  const deps = { readBytes: NO_BYTES, sleep: async () => {}, now: () => 0 }

  expect(await pageBrowser(pageWith(true), deps).js('t1', 'return 1')).toBe(JSON.stringify('"ok"'))
  expect(await pageBrowser(pageWith(), deps).js('t1', 'return 1')).toBe(JSON.stringify('"ok"'))
  expect(await pageBrowser(pageWith(false), deps).js('t1', 'return 1')).toBe(JSON.stringify('"ok"'))
  expect(seen).toEqual(['await (async () => {\nreturn 1\n})()', '(async () => {\nreturn 1\n})()', '(async () => {\nreturn 1\n})()'])
})
