import type { Browser, PageState } from '../hooks/model'

// terminal-browser's eval prints a string result as a JSON literal.
export const printed = (value: unknown) => `${JSON.stringify(JSON.stringify(value))}\n`

// A fake browser: each state poll returns the next page in `pages` (the last one repeats).
// The URL a leaveScript sends the tab to, or undefined for any other script.
const leftFor = (code: string) => /location\.assign\(("[^"]*")\)/.exec(code)?.[1] && JSON.parse(/location\.assign\(("[^"]*")\)/.exec(code)![1]!)

export function fakeBrowser(options: { tabs: string[]; pages: Partial<PageState>[]; markdown: string; sent?: boolean }) {
  const calls: string[] = []
  let poll = 0
  const base: PageState = { href: 'https://chatgpt.com/', composer: true, login: false, stop: false, count: 0, length: 0, images: 0, blocker: '' }
  const browser: Browser = {
    tabs: async () => {
      calls.push('tabs')
      return options.tabs
    },
    openTab: async url => {
      calls.push(`open ${url}`)
      return 't2'
    },
    waitFor: async () => true,
    js: async (tabId, code) => {
      const url = leftFor(code)
      if (url) {
        calls.push(`navigate ${tabId} ${url}`)
        return printed({ leaving: true })
      }
      if (code.includes('ClipboardEvent')) {
        calls.push(`send ${tabId}`)
        return printed(options.sent === false ? { sent: false, reason: 'send button not found' } : { sent: true })
      }
      if (code.includes('function convert')) {
        calls.push(`read ${tabId}`)
        return printed({ url: 'https://chatgpt.com/c/abc', markdown: options.markdown, text: options.markdown })
      }
      const page = options.pages[Math.min(poll++, options.pages.length - 1)]
      return printed({ ...base, ...page })
    },
    upload: async (tabId, selector, paths) => {
      calls.push(`upload ${tabId} ${selector} ${paths.join(' ')}`)
    },
  }
  return { browser, calls }
}

export type Shot = { stop?: boolean; images?: number; count?: number; length?: number }

// A fake browser for images: each state poll returns the next shot (the last one repeats).
export function fakeImageBrowser(options: { shots: Shot[]; base64: string; attached?: boolean; text?: string }) {
  const calls: string[] = []
  let poll = 0
  const browser: Browser = {
    tabs: async () => [],
    openTab: async url => {
      calls.push(`navigate ${url}`)
      return 't2'
    },
    waitFor: async () => true,
    js: async (_tabId, code) => {
      if (code.includes('attachment did not show up')) {
        calls.push('attach')
        return printed(options.attached === false ? { attached: false, reason: 'the attachment did not show up in the composer' } : { attached: true })
      }
      if (code.includes('ClipboardEvent')) {
        calls.push('send')
        return printed({ sent: true })
      }
      if (code.includes('readAsDataURL')) {
        calls.push('image')
        return printed({ found: true, url: 'https://chatgpt.com/c/img', type: 'image/png', base64: options.base64, width: 1024, height: 1024, alt: 'Imagem 1 gerada' })
      }
      if (code.includes('function convert')) return printed({ url: 'https://chatgpt.com/c/img', markdown: options.text ?? '', text: options.text ?? '' })
      const shot = options.shots[Math.min(poll++, options.shots.length - 1)]!
      return printed({ href: 'https://chatgpt.com/c/img', composer: true, login: false, stop: false, images: 0, count: 0, length: 0, blocker: '', ...shot })
    },
    upload: async (_tabId, selector, paths) => {
      calls.push(`upload ${selector} ${paths.join(' ')}`)
    },
  }
  return { browser, calls }
}
