import { expect, test } from 'claude-code/testing'
import type { ProcessRunner } from '../hooks/model'
import { parseOutput } from '../hooks/scripts'
import { NO_PANE, listTabs, openTerminalBrowser, openedTab, splitTabId } from '../hooks/terminal-browser'
import { printed } from './helpers'

test('parseOutput reads the JSON a page script returns', () => {
  expect(parseOutput(printed({ a: 'x "y"\nz', b: [1] }))).toEqual({ a: 'x "y"\nz', b: [1] })
  expect(() => parseOutput('Error: no tab')).toThrow()
})

test('terminal-browser output: tabs, ids and the tab new-tab opened', () => {
  const listed = listTabs(
    JSON.stringify({
      self: { tab: 't', pane: 'p' },
      browsers: [{ key: '96217-1', tabs: [{ id: 1, url: 'https://chatgpt.com/c/abc', active: true }, { id: 2, url: 'about:blank', active: false }] }],
    }),
  )
  expect(listed).toEqual(['96217-1:1', '96217-1:2'])
  expect(listTabs('{"browsers": []}')).toEqual([])
  expect(listTabs('terminal-browser: no pane')).toEqual([])
  expect(splitTabId('96217-1:3')).toEqual({ browser: '96217-1', tab: '3' })
  expect(openedTab('{ "key": "76085-1", "openedTab": 2, "tabs": [] }')).toBe('76085-1:2')
  expect(openedTab('{ "key": "97220-1", "openedTab": null, "splitDir": "right" }')).toBe('97220-1:1')
  expect(openedTab('nothing')).toBeUndefined()
})

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
  const browser = await openTerminalBrowser(run)
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

test('outside a pane terminal-browser cannot drive, the adapter says so and the chooser moves on', async () => {
  // The desktop app: ls exits 0 with no pane (self null) and no browser, so there is nothing to drive.
  expect(await openTerminalBrowser(async () => ({ exitCode: 0, stdout: '{"self": null, "browsers": []}', stderr: '' }))).toBe(NO_PANE)
  expect(await openTerminalBrowser(async () => ({ exitCode: 0, stdout: '{"self": null}', stderr: '' }))).toBe(NO_PANE)
  // A null pane with a browser that is open still has tabs to drive.
  const withBrowser = await openTerminalBrowser(async () => ({
    exitCode: 0,
    stdout: '{"self": null, "browsers": [{"key": "b", "tabs": [{"id": 1}]}]}',
    stderr: '',
  }))
  expect(typeof withBrowser).toBe('object')
})

test('the CLI adapter reports why it is unavailable and turns wait failures into false', async () => {
  expect(await openTerminalBrowser(async () => { throw new Error('missing') })).toBe('terminal-browser is not installed (https://terminal-browser.sh)')
  const calls: { argv: string[]; init?: Parameters<ProcessRunner>[1] }[] = []
  const browser = await openTerminalBrowser(async (argv, init) => {
    calls.push({ argv, init })
    return argv.includes('ls')
      ? { exitCode: 0, stdout: '{"self": {"tab": "t", "pane": "p"}, "browsers": []}', stderr: '' }
      : { exitCode: 1, stdout: '', stderr: 'timed out' }
  })
  if (typeof browser === 'string') throw new Error(browser)
  expect(await browser.waitFor('b:2', 'ready', 25)).toBe(false)
  expect(calls.at(-1)).toEqual({
    argv: ['terminal-browser', 'action', '--browser', 'b', '--tab', '2', '--', 'wait', '--fn', 'ready', '--timeout', '25'],
    init: { timeoutMs: 10_025 },
  })
})
