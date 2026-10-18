import type { Browser, PageState } from '../hooks/model'

// The one fake of the ChatGPT page and its host: every browser, flow and tool test answers page scripts from here.

// terminal-browser's eval prints a string result as a JSON literal.
export const printed = (value: unknown) => `${JSON.stringify(JSON.stringify(value))}\n`

/** The state poll of a settled page on a fresh chat. */
export const basePage: PageState = { href: 'https://chatgpt.com/', composer: true, login: false, stop: false, turns: [], length: 0, images: 0, blocker: '', interrupted: false }

/** The keys of a chat's first `count` exchanges: a page with one more holds a new one. */
export const turns = (count: number) => Array.from({ length: count }, (_, i) => `turn-${i + 1}`)

export type ScriptKind = 'wait' | 'leave' | 'model rows' | 'model click' | 'model effort' | 'model close' | 'send' | 'read' | 'chip' | 'upload' | 'image' | 'chunk' | 'doctor' | 'state' | 'other'

/** What a page script is, from its text. Add the branch for a new script here. */
export function scriptKind(code: string): ScriptKind {
  if (code.includes('JSON.stringify(Boolean(')) return 'wait'
  if (code.includes('location.assign(')) return 'leave'
  if (code.includes('item.focus()')) return 'model effort'
  if (code.includes('found: true, rows')) return 'model rows'
  if (code.includes('clicked: !!row')) return 'model click'
  if (code.includes('closed: true')) return 'model close'
  if (code.includes('ClipboardEvent')) return 'send'
  if (code.includes('function convert')) return 'read'
  if (code.includes('attachment did not show up')) return 'chip'
  if (code.includes('DataTransfer')) return 'upload'
  if (code.includes('readAsDataURL')) return 'image'
  if (code.includes('held.slice(')) return 'chunk'
  if (code.includes('codeBlocks')) return 'doctor'
  if (code.includes('answers.pop()')) return 'state'
  return 'other'
}

/** The URL a leave script sends the tab to, or undefined for any other script. */
export function leftFor(code: string): string | undefined {
  const literal = /location\.assign\(("[^"]*")\)/.exec(code)?.[1]
  return literal === undefined ? undefined : (JSON.parse(literal) as string)
}

export const DOCTOR_PAGE = {
  href: 'https://chatgpt.com/',
  login: false,
  composer: true,
  send: 0,
  imageInput: true,
  fileInput: true,
  model: true,
  answers: 3,
  turns: 2,
  images: 1,
  codeBlocks: 2,
  blocker: '',
}

/** What the fake page does. Read at every script, so a test may change it between requests. */
export type PageScript = {
  /** What each state poll answers, in order (the last one repeats). */
  pages: Partial<PageState>[]
  /** Replaces `pages` once the answer has been read back, so a background job that follows sees its own page. */
  pagesAfterRead?: Partial<PageState>[]
  markdown?: string
  /** The chat URL the read script reports. */
  readUrl?: string
  /** The model menu the model scripts read and click; GPT-6 and GPT-5.6 Sol, GPT-6 checked at medium, when unset. */
  menu?: FakeMenu
  /** False makes the send script report that it could not send. */
  sent?: boolean
  /** False makes the attachment chip never show up. */
  attached?: boolean
  /** How many wait checks answer false before they answer true. */
  waitFalse?: number
  /** The doctor script prints something that is not the JSON it should. */
  doctorBroken?: boolean
  /** The image the image scripts hand back, as base64. */
  base64?: string
  imageSize?: { width: number; height: number }
  /** The page every state poll starts from; `pages` override it. */
  base?: PageState
}

/** A fake page over `script`: `answer` is the value a script prints, by its kind. */
export function fakePage(script: PageScript) {
  const menu = script.menu ?? fakeMenu(['GPT-6', 'GPT-5.6 Sol'], 'GPT-6')
  let poll = 0
  let chunks = 0
  const answer = (kind: ScriptKind, code: string): unknown => {
    const markdown = script.markdown ?? ''
    switch (kind) {
      case 'wait': {
        if (script.waitFalse) {
          script.waitFalse--
          return false
        }
        return true
      }
      case 'leave':
        return { leaving: true }
      case 'model rows':
        return menu.rows()
      case 'model click':
        return menu.click(code)
      case 'model effort':
        return menu.step(code)
      case 'model close':
        return { closed: true }
      case 'send':
        return script.sent === false ? { sent: false, reason: 'send button not found' } : { sent: true }
      case 'read':
        if (script.pagesAfterRead) {
          script.pages = script.pagesAfterRead
          script.pagesAfterRead = undefined
          poll = 0
        }
        return { url: script.readUrl ?? 'https://chatgpt.com/c/abc', markdown, text: markdown }
      case 'chip':
        return script.attached === false ? { attached: false, reason: 'the attachment did not show up in the composer' } : { attached: true }
      case 'upload':
        return { uploaded: true }
      case 'image': {
        const size = script.imageSize ?? { width: 1024, height: 1024 }
        return { found: true, url: 'https://chatgpt.com/c/img', type: 'image/png', length: (script.base64 ?? '').length, ...size, alt: 'Imagem 1 gerada' }
      }
      case 'chunk': {
        chunks++
        const slice = /held\.slice\((\d+), (\d+)\)/.exec(code)
        return { chunk: (script.base64 ?? '').slice(Number(slice?.[1]), Number(slice?.[2])) }
      }
      case 'doctor':
        return script.doctorBroken ? 'oops' : DOCTOR_PAGE
      case 'state': {
        const page = script.pages[Math.min(poll++, script.pages.length - 1)]
        return { ...(script.base ?? basePage), ...page }
      }
      default:
        return {}
    }
  }
  return {
    answer,
    /** Starts the next request's state polls from the first of `pages`. */
    restart: () => {
      poll = 0
    },
    /** How many image chunks were read. */
    chunks: () => chunks,
  }
}

/**
 * The model menu, with its rows named as the page shows them and `checked` the selected one, and its effort
 * slider over `efforts` (none, medium, high by default) standing at `effort` (medium by default). `stuck` makes
 * a click leave the checked row as it was, and `stuckEffort` an arrow key leave the slider, as a page that did
 * not take them; `gone` makes the clicked row missing, as a menu that changed between reading and clicking.
 */
export function fakeMenu(
  rows: string[],
  checked: string,
  options: { stuck?: boolean; efforts?: string[]; effort?: string; stuckEffort?: boolean; gone?: boolean } = {},
) {
  const norm = (name: string) => name.toLowerCase().replace(/\s+/g, ' ').trim()
  const efforts = options.efforts ?? ['none', 'medium', 'high']
  let at = efforts.indexOf(options.effort ?? 'medium')
  const effort = () => ({ effort: efforts[at] ?? '', at, min: 0, max: efforts.length - 1 })
  return {
    rows: () => ({ found: true, rows: rows.map(row => ({ name: norm(row), checked: row === checked })), effort: effort() }),
    click: (code: string) => {
      const row = options.gone ? undefined : rows[Number(/rows\[(\d+)\]/.exec(code)?.[1])]
      if (row && !options.stuck) checked = row
      return { clicked: row !== undefined, effort: effort() }
    },
    step: (code: string) => {
      const by = code.includes('"ArrowLeft"') ? -1 : 1
      if (!options.stuckEffort) at = Math.min(efforts.length - 1, Math.max(0, at + by))
      return effort()
    },
    checked: () => checked,
    effort: () => efforts[at],
  }
}

export type FakeMenu = ReturnType<typeof fakeMenu>

/** A fake browser: each state poll returns the next page in `pages` (the last one repeats). */
export function fakeBrowser(options: { tabs: string[]; pages: Partial<PageState>[]; markdown: string; sent?: boolean; name?: string; menu?: FakeMenu }) {
  const calls: string[] = []
  const page = fakePage({ pages: options.pages, markdown: options.markdown, sent: options.sent, menu: options.menu })
  const browser: Browser = {
    name: options.name ?? 'fake browser',
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
      const kind = scriptKind(code)
      if (kind === 'leave') calls.push(`navigate ${tabId} ${leftFor(code)}`)
      else if (kind.startsWith('model')) calls.push(`${kind} ${tabId}`)
      else if (kind === 'send') calls.push(`send ${tabId}`)
      else if (kind === 'read') calls.push(`read ${tabId}`)
      return printed(page.answer(kind, code))
    },
    upload: async (tabId, selector, files) => {
      calls.push(`upload ${tabId} ${selector} ${files.map(file => file.path).join(' ')}`)
    },
  }
  return { browser, calls }
}

export type Shot = { stop?: boolean; images?: number; turns?: string[]; length?: number }

/** A fake browser for images: each state poll returns the next shot (the last one repeats). */
export function fakeImageBrowser(options: { shots: Shot[]; base64: string; attached?: boolean; text?: string }) {
  const calls: string[] = []
  const page = fakePage({
    pages: options.shots,
    markdown: options.text,
    readUrl: 'https://chatgpt.com/c/img',
    attached: options.attached,
    base64: options.base64,
    base: { ...basePage, href: 'https://chatgpt.com/c/img' },
  })
  const browser: Browser = {
    name: 'fake browser',
    tabs: async () => [],
    openTab: async url => {
      calls.push(`navigate ${url}`)
      return 't2'
    },
    waitFor: async () => true,
    js: async (_tabId, code) => {
      const kind = scriptKind(code)
      if (kind === 'chip') calls.push('attach')
      else if (kind === 'send') calls.push('send')
      else if (kind === 'image') calls.push('image')
      return printed(page.answer(kind, code))
    },
    upload: async (_tabId, selector, files) => {
      calls.push(`upload ${selector} ${files.map(file => file.path).join(' ')}`)
    },
  }
  return { browser, calls, chunks: page.chunks }
}
