import { expect, test } from 'claude-code/testing'
import { type Candidate, chooseBrowser } from '../hooks/chooser'
import type { Browser } from '../hooks/model'

// The chooser never calls a browser's methods, so a bare object stands for one.
const stub = { tabs: async () => [] } as unknown as Browser

test('the first backend that opens is chosen, and the ones after it are not tried', async () => {
  const tried: string[] = []
  const candidates: Candidate[] = [
    {
      name: 'terminal-browser',
      hint: 'run it in a pane',
      open: async () => {
        tried.push('terminal-browser')
        return 'terminal-browser is not installed (https://terminal-browser.sh)'
      },
    },
    {
      name: 'Claude in Chrome',
      hint: 'connect Chrome',
      open: async () => {
        tried.push('Claude in Chrome')
        return stub
      },
    },
    {
      name: "the Claude app's built-in browser",
      hint: 'log in to the pane',
      open: async () => {
        tried.push('built-in')
        return stub
      },
    },
  ]
  const chosen = await chooseBrowser(candidates)
  if (typeof chosen === 'string') throw new Error(chosen)
  expect(chosen.name).toBe('Claude in Chrome')
  expect(chosen.browser).toBe(stub)
  expect(tried).toEqual(['terminal-browser', 'Claude in Chrome'])
})

test('a thrown error counts as a backend that cannot be used', async () => {
  const chosen = await chooseBrowser([
    {
      name: 'Claude in Chrome',
      hint: 'connect Chrome',
      open: async () => {
        throw new Error('no answer for tabs_context_mcp')
      },
    },
    { name: "the Claude app's built-in browser", hint: 'log in to the pane', open: async () => stub },
  ])
  if (typeof chosen === 'string') throw new Error(chosen)
  expect(chosen.name).toBe("the Claude app's built-in browser")
})

test('when none opens, the answer says what each one said', async () => {
  const chosen = await chooseBrowser([
    { name: 'terminal-browser', hint: 'run it in a pane', open: async () => 'terminal-browser is not installed (https://terminal-browser.sh)' },
    {
      name: 'Claude in Chrome',
      hint: 'connect Chrome',
      open: async () => {
        throw new Error('no answer for tabs_context_mcp')
      },
    },
    { name: "the Claude app's built-in browser", hint: 'log in to the pane', open: async () => 'unexpected output from tabs_context' },
  ])
  expect(typeof chosen).toBe('string')
  const text = String(chosen)
  expect(text.startsWith('No browser to drive ChatGPT with. terminal-browser said: terminal-browser is not installed (https://terminal-browser.sh).')).toBe(true)
  expect(text).toContain('Claude in Chrome said: no answer for tabs_context_mcp.')
  expect(text).toContain("the Claude app's built-in browser said: unexpected output from tabs_context.")
})

test('when none opens, the advice strings the hints of the backends given, in their order, as a sentence', async () => {
  const none = async () => 'no'
  const advice = async (hints: string[]) => {
    const said = await chooseBrowser(hints.map((hint, i) => ({ name: `b${i}`, hint, open: none })))
    return String(said).replace(/^.*no\. /, '')
  }

  expect(await advice(['run it', 'connect it', 'log in'])).toBe('Run it, or connect it, or log in, then try again.')
  expect(await advice(['connect it', 'run it'])).toBe('Connect it, or run it, then try again.')
  expect(await advice(['Run /x'])).toBe('Run /x, then try again.')
})
