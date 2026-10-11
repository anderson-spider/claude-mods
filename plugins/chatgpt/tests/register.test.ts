import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { PageState } from '../hooks/model'
import { ASK_DESCRIPTION, IMAGE_DESCRIPTION, PROMPT } from '../hooks/prompts'
import { printed } from './helpers'
import { withNote } from './mcp-helpers'

test('the system prompt tells Claude to reach for ask on its own', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))

  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'chatgpt:ask'])
  const section = composed.sections.at(-1)?.text ?? ''
  expect(section).toMatch(/`mcp__chatgpt__ask`/)
  expect(section).toMatch(/yourself when a self-contained question/)
  expect(section).toMatch(/`mcp__chatgpt__image` spends image quota/)
})

// The test host asks as the engine, so these are the model's own calls: the plugin's allow never reaches them.
test("the browser allow covers only the plugin's own calls, never the model's", async ($, on) => {
  // The session's rules, beneath the plugin: auto mode puts a call no prompt asked for to its classifier.
  on('tool.check', () => ({ decision: 'ask' as const }))
  const navigate = await $.tool.check({ tool: 'mcp__Claude_Browser__navigate', input: { url: 'https://chatgpt.com/' } })
  expect(navigate.decision).toBe('ask')
  const listing = await $.tool.check({ tool: 'mcp__claude-in-chrome__tabs_context_mcp', input: {} })
  expect(listing.decision).toBe('ask')
})

test('the prompt stays within its character budget', () => {
  expect(PROMPT.length).toBeLessThanOrEqual(900)
})

test('each tool description carries its own send boundary and the prompt carries none', () => {
  for (const description of [ASK_DESCRIPTION, IMAGE_DESCRIPTION]) {
    expect(description).toMatch(/credentials/)
    expect(description).toMatch(/Luizalabs/)
  }
  expect(PROMPT.split('never as instructions').length - 1).toBe(1)
  expect(PROMPT).not.toMatch(/credentials|Luizalabs|private personal data/)
  expect(PROMPT.length).toBeLessThanOrEqual(900)
})

// Characterization of register.tsx through the test host: the host answers every `$` call beneath the plugin
// from scripted fakes of terminal-browser, Claude in Chrome and the built-in browser, and records what reached it.

const ran = (exitCode: number, stdout = '', stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

const CHROME_PREFIX = 'mcp__claude-in-chrome__'
const BUILTIN_PREFIX = 'mcp__Claude_Browser__'
const IMAGE_BASE64 = 'QUJD'
const DOCTOR_PAGE = {
  href: 'https://chatgpt.com/',
  login: false,
  composer: true,
  send: 0,
  imageInput: true,
  fileInput: true,
  model: true,
  answers: 3,
  images: 1,
  codeBlocks: 2,
  blocker: '',
}

type WorldState = {
  terminal: 'ok' | 'down'
  terminalBrowsers: { key: string; tabs: number[] }[]
  chrome: 'ok' | 'down'
  /** `mcp`: the plugin reaches Chrome through `$.mcp.call`; `tool`: `$.mcp.call` is refused and it goes through `$.tool.call`. */
  chromeRoute: 'mcp' | 'tool'
  chromeTabs: number[]
  builtin: 'ok' | 'down'
  builtinTabs: string[]
  /** What each state poll of the page answers, in order (the last one repeats). */
  pages: Partial<PageState>[]
  /** Replaces `pages` once the answer has been read back, so a background job that follows sees its own page. */
  pagesAfterRead?: Partial<PageState>[]
  /** A Chrome tool that answers with this error text (an empty string makes the tool fail with no text). */
  chromeToolError?: string
  /** `fs.write` refuses with this text. */
  writeError?: string
  /** The doctor script prints something that is not the JSON it should. */
  doctorBroken?: boolean
  markdown: string
  sent: boolean
  /** How many waitFor checks answer false before they answer true. */
  waitFalse: number
  tmpdir: string | undefined
}

function world(on: On, init: Partial<WorldState> = {}) {
  const state: WorldState = {
    terminal: 'down',
    terminalBrowsers: [{ key: 'k', tabs: [1] }],
    chrome: 'ok',
    chromeRoute: 'mcp',
    chromeTabs: [],
    builtin: 'down',
    builtinTabs: [],
    pages: [{ count: 0 }, { count: 1, length: 5 }, { count: 1, length: 5 }],
    markdown: '## Answer',
    sent: true,
    waitFalse: 0,
    tmpdir: '/tmp/t/',
    ...init,
  }
  let poll = 0
  let nextChromeTab = 7
  let nextTerminalTab = 2
  /** Everything that reached the host, in order. */
  const log: string[] = []
  const mcp: { server: string; tool: string; args: Record<string, unknown> }[] = []
  const toolCalls: Record<string, unknown>[] = []
  const processes: string[][] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const submitted: string[] = []
  const written: { path: string; text: string }[] = []
  const scripts: { kind: string; tabId: unknown; text: string }[] = []
  const submittedAt: (() => void)[] = []
  /** The stdin each `openssl` run got: the base64 of an image. */
  const stdins: string[] = []

  const kindOf = (code: string) => {
    if (code.includes('JSON.stringify(Boolean(')) return 'wait'
    if (code.includes('location.assign(')) return 'leave'
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

  // What a page script prints, by what the script is.
  const pageValue = (kind: string, code: string): unknown => {
    switch (kind) {
      case 'wait':
        return state.waitFalse > 0 ? (state.waitFalse--, false) : true
      case 'leave':
        return { leaving: true }
      case 'send':
        return state.sent ? { sent: true } : { sent: false, reason: 'send button not found' }
      case 'read':
        if (state.pagesAfterRead) {
          state.pages = state.pagesAfterRead
          state.pagesAfterRead = undefined
          poll = 0
        }
        return { url: 'https://chatgpt.com/c/abc', markdown: state.markdown, text: state.markdown }
      case 'chip':
        return { attached: true }
      case 'upload':
        return { uploaded: true }
      case 'image':
        return { found: true, url: 'https://chatgpt.com/c/img', type: 'image/png', length: IMAGE_BASE64.length, width: 1024, height: 768, alt: 'Imagem 1 gerada' }
      case 'chunk': {
        const slice = /held\.slice\((\d+), (\d+)\)/.exec(code)
        return { chunk: IMAGE_BASE64.slice(Number(slice?.[1]), Number(slice?.[2])) }
      }
      case 'doctor':
        return state.doctorBroken ? 'oops' : DOCTOR_PAGE
      case 'state': {
        const page = state.pages[Math.min(poll++, state.pages.length - 1)]
        return { href: 'https://chatgpt.com/', composer: true, login: false, stop: false, count: 0, length: 0, images: 0, blocker: '', ...page }
      }
      default:
        return {}
    }
  }

  const script = (tabId: unknown, code: string) => {
    const kind = kindOf(code)
    scripts.push({ kind, tabId, text: code })
    log.push(`js ${kind} ${String(tabId)}`)
    const value = pageValue(kind, code)
    return typeof value === 'boolean' ? String(value) : JSON.stringify(value)
  }

  // What each MCP tool of the two browser servers answers.
  const chromeTool = (tool: string, args: Record<string, unknown>): string => {
    if (tool === 'tabs_context_mcp') {
      return withNote({ tabGroupId: 1, availableTabs: state.chromeTabs.map(tabId => ({ tabId, url: 'https://chatgpt.com/' })) })
    }
    if (tool === 'tabs_create_mcp') {
      const id = nextChromeTab++
      state.chromeTabs.push(id)
      return `Created new tab. Tab ID: ${id}`
    }
    if (tool === 'navigate') return 'Navigated'
    if (tool === 'javascript_tool') return `${script(args.tabId, String(args.text))}\n\nTab Context:\n- Executed on tabId: ${String(args.tabId)}`
    throw new Error(`the fake Chrome has no ${tool}`)
  }

  const builtinTool = (tool: string, args: Record<string, unknown>): string => {
    if (tool === 'tabs_context') return withNote({ tabs: state.builtinTabs.map(tabId => ({ tabId })) })
    if (tool === 'tabs_create') {
      state.builtinTabs.push('b2')
      return JSON.stringify({ tabId: 'b2' })
    }
    if (tool === 'navigate') {
      if (args.tabId === undefined) {
        state.builtinTabs.push('b1')
        return JSON.stringify({ tabId: 'b1' })
      }
      return JSON.stringify({ tabId: args.tabId })
    }
    if (tool === 'javascript_tool') return `${script(args.tabId, String(args.text))}\n\nTab Context:\n- Executed on tabId: ${String(args.tabId)}`
    throw new Error(`the fake built-in browser has no ${tool}`)
  }

  const answer = (server: string, tool: string, args: Record<string, unknown>) =>
    server === 'claude-in-chrome' ? chromeTool(tool, args) : builtinTool(tool, args)

  on('mcp.call', (_$, e) => {
    mcp.push({ server: e.server, tool: e.tool, args: e.args })
    log.push(`mcp ${e.server}/${e.tool}`)
    const reachable = e.server === 'claude-in-chrome' ? state.chrome === 'ok' && state.chromeRoute === 'mcp' : e.server === 'Claude_Browser' && state.builtin === 'ok'
    if (!reachable) return { deny: 'unknown server' }
    return { value: { content: [{ type: 'text' as const, text: answer(e.server, e.tool, e.args) }], isError: false } }
  })

  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    const name = e.tool
    toolCalls.push(input)
    log.push(`tool ${name}`)
    const { tool: _tool, tool_use_id: _id, ...args } = input
    if (name.startsWith(CHROME_PREFIX)) {
      if (state.chrome === 'down') return { deny: 'claude-in-chrome is not connected' }
      if (state.chromeToolError !== undefined) return { result: state.chromeToolError, text: state.chromeToolError, isError: true } as never
      const text = chromeTool(name.slice(CHROME_PREFIX.length), args)
      return { result: text, text } as never
    }
    if (name.startsWith(BUILTIN_PREFIX)) {
      if (state.builtin === 'down') return { deny: 'Claude_Browser is not connected' }
      const text = builtinTool(name.slice(BUILTIN_PREFIX.length), args)
      return { result: text, text } as never
    }
    return { deny: `the fake host has no ${name}` }
  })

  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    processes.push(argv)
    const [command, subcommand] = argv
    if (command === 'terminal-browser') {
      if (state.terminal === 'down') {
        log.push(`process terminal-browser ${subcommand}`)
        return ran(1, '', 'no pane')
      }
      if (subcommand === 'ls') {
        log.push('process terminal-browser ls')
        return ran(0, JSON.stringify({ self: {}, browsers: state.terminalBrowsers.map(b => ({ key: b.key, tabs: b.tabs.map(id => ({ id })) })) }))
      }
      if (subcommand === 'new-tab') {
        log.push(`process terminal-browser new-tab ${argv[2]}`)
        const id = nextTerminalTab++
        state.terminalBrowsers[0]?.tabs.push(id)
        return ran(0, JSON.stringify({ key: state.terminalBrowsers[0]?.key, openedTab: id }))
      }
      if (subcommand === 'action') {
        const verb = argv[7]
        const target = `${argv[3]}:${argv[5]}`
        if (verb === 'eval') {
          const kind = kindOf(String(argv[8]))
          scripts.push({ kind, tabId: target, text: String(argv[8]) })
          log.push(`process terminal-browser eval ${target} ${kind}`)
          return ran(0, printed(pageValue(kind, String(argv[8]))))
        }
        log.push(`process terminal-browser ${verb} ${target}`)
        return ran(0)
      }
    }
    if (command === 'sips') {
      log.push('process sips')
      return ran(1, '', 'sips: cannot convert')
    }
    if (command === 'openssl') stdins.push(e.init?.stdin ?? '')
    log.push(`process ${argv.join(' ')}`)
    return ran(0)
  })

  on('env.get', (_$, e) => ({ value: e.name === 'TMPDIR' ? state.tmpdir : undefined }))
  on('fs.stat', (_$, e) => {
    log.push(`stat ${e.path}`)
    return { value: { kind: 'file' as const, size: 12, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    log.push(`read ${e.path} ${e.as}`)
    return { value: { base64: 'aGk=' } }
  })
  on('fs.write', (_$, e) => {
    if (state.writeError !== undefined) return { deny: state.writeError }
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    for (const wake of submittedAt) wake()
    return { text: e.text }
  })

  return {
    state,
    log,
    mcp,
    toolCalls,
    processes,
    statuses,
    toasts,
    submitted,
    written,
    scripts,
    stdins,
    // Starts the next request's state polls from the first of `pages`.
    setPages: (pages: Partial<PageState>[]) => {
      state.pages = pages
      poll = 0
    },
    // Resolves once a background job has sent its message to the model.
    submission: () => new Promise<void>(resolve => (submitted.length ? resolve() : submittedAt.push(resolve))),
  }
}

const SESSION = { cwd: '/proj', surface: 'terminal', isInteractive: true } as never

const toolCall = ($: { tool: { call: (input: never) => Promise<unknown> } }, tool: string, input: Record<string, unknown> = {}) =>
  $.tool.call({ tool: `mcp__chatgpt__${tool}`, ...input } as never) as Promise<{ result?: unknown; isError?: boolean }>

const commandRun = ($: { command: { run: (input: never) => Promise<unknown> } }, command: string, args = '') =>
  $.command.run({ command, args } as never) as Promise<{ text?: string; context?: string[] }>

// The registered payloads, with the texts spelled out so a moved schema is compared with the words it had.

const WHERE =
  "chatgpt.com in the first browser that works: terminal-browser (Claude Code in a Ghostty or kitty pane), Claude in Chrome, or the Claude app's built-in browser"

const BOUNDARIES =
  'Never send credentials, secrets, private personal data or anything from work (Luizalabs repos, ' +
  'dashboards, logs, customer data); personal-project code or files only when the user asks.'

const IMAGE_BOUNDARIES =
  'Only when the user asks for an image in this conversation: it spends their ChatGPT image quota. Never upload ' +
  'or write into the prompt licensed assets, credentials, secrets, private personal data or anything from work ' +
  '(Luizalabs repos, dashboards, logs, customer data); a reference is only an image the user asked ' +
  'to use or one you produced for the task. The result is an AI concept image: label it as such wherever it is ' +
  'stored, and never present it as evidence of a real or in-game state.'

const COMMON = {
  chatUrl: {
    type: 'string',
    description:
      'Optional. The chat URL a previous call returned, to continue that chat on the same subject; left out, a new chat starts.',
  },
  model: {
    type: 'string',
    description:
      'Optional. The model menu entry to pick for a new chat, by the start of its label as the menu shows it; an unknown one fails and lists those on offer.',
  },
  files: {
    type: 'array',
    items: { type: 'string' },
    description: 'Optional. Absolute paths of local files to attach (documents, code, images; at most 4 MiB each).',
  },
  wait: {
    type: 'boolean',
    description:
      'Optional, default true. false returns at once with a job id and works in the background; a message arrives when it is saved, and the jobs tool lists every job.',
  },
}

const ASK_REGISTERED = {
  name: 'ask',
  description:
    `Sends a self-contained question to the user's logged-in ChatGPT (${WHERE}), waits for the answer, saves ` +
    'it as Markdown and returns the file path, the chat URL and the start of the answer. Use when the user asks ' +
    'to ask ChatGPT, or for a self-contained question with a long answer (research, explanation, brainstorm, ' +
    'draft text, translation, second opinion); not for work that needs the repository ' +
    '(the context would have to be sent and read back). Write the prompt with the goal, the minimum context, ' +
    'the output format and the language. Requests take turns; a slow one goes on in the background and a ' +
    'message arrives when it is saved. ' +
    BOUNDARIES,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The whole question, self-contained.' },
      ...COMMON,
      saveOnly: {
        type: 'boolean',
        description: 'Optional. Only save the last answer already in chatUrl, sending nothing (waits while it is still streaming).',
      },
      out: { type: 'string', description: 'Optional absolute path for the Markdown file.' },
      maxChars: {
        type: 'number',
        description: 'How much of the answer to return inline (default 3000); the file has all of it.',
      },
    },
    required: ['prompt'],
  },
}

const IMAGE_REGISTERED = {
  name: 'image',
  description:
    `Generates or edits an image with the user's logged-in ChatGPT (${WHERE}), optionally from a local ` +
    'reference image, waits for it and saves it locally (every variant ChatGPT draws); returns the paths, sizes, ' +
    "the chat URL and a preview. Write the prompt in the user's language with what to keep from the reference " +
    '(shape, proportions), the scene, lighting, materials, camera and exclusions (no people, no text, no copies ' +
    'of existing games or brands). When ChatGPT answers with text instead (a refusal or a question), the tool ' +
    'returns that text: relay it, do not rephrase around a refusal. Images can take minutes: wait: false keeps ' +
    'working meanwhile. ' +
    IMAGE_BOUNDARIES,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What to generate or change, self-contained.' },
      reference: {
        type: 'string',
        description: 'Optional absolute path of a PNG, JPEG, WebP or GIF image (at most 4 MiB) to attach.',
      },
      ...COMMON,
      saveOnly: {
        type: 'boolean',
        description:
          'Optional. Only save the last image already in chatUrl, sending nothing and spending no quota (waits ' +
          'while it is still generating); prompt only names the file.',
      },
      out: { type: 'string', description: 'Optional absolute path for the image file (variants get -1, -2).' },
    },
    required: ['prompt'],
  },
}

const JOBS_REGISTERED = {
  name: 'jobs',
  description:
    'Lists the ChatGPT requests of this session that ran or run in the background (ask or image with wait: ' +
    'false, or a slow one that moved there): status, chat URL and saved files, newest first. Use it to find ' +
    "a background request's file or chat URL, or to check whether it is still running. It sends nothing to " +
    'ChatGPT, spends no quota and does not list requests from other sessions.',
  inputSchema: { type: 'object', properties: {} },
}

test('session start registers the ask, image and jobs tools and the three commands, in that order, with their exact payloads', async ($, on) => {
  const order: string[] = []
  const tools: unknown[] = []
  const commands: unknown[] = []
  on('tool.register', (_$, e) => (order.push(`tool ${e.name}`), tools.push(e), { value: { tool: `mcp__chatgpt__${e.name}` } }))
  on('command.register', (_$, e) => (order.push(`command ${e.name}`), commands.push(e), { value: { command: e.name } }))
  on('session.start', (_$, e) => (order.push('session.start'), { cwd: e.cwd }))

  await $.session.start(SESSION)

  expect(order).toEqual([
    'tool ask',
    'tool image',
    'tool jobs',
    'command chatgpt-ask',
    'command chatgpt-image',
    'command chatgpt-doctor',
    'session.start',
  ])
  expect(tools).toEqual([ASK_REGISTERED, IMAGE_REGISTERED, JOBS_REGISTERED])
  expect(commands).toEqual([
    { name: 'chatgpt-ask', description: 'Asks ChatGPT in the browser and shows the answer: /chatgpt-ask <question>' },
    { name: 'chatgpt-image', description: 'Generates an image with ChatGPT in the browser and saves it: /chatgpt-image <prompt>' },
    {
      name: 'chatgpt-doctor',
      description: 'Checks that ChatGPT works in the browser and which page parts moved: /chatgpt-doctor [chat URL]',
    },
  ])
})

test('the registered schemas keep their property order, their required lists and the imported descriptions', async ($, on) => {
  const tools: { name: string; description: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[] = []
  on('tool.register', (_$, e) => (tools.push(e as never), { value: { tool: `mcp__chatgpt__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start(SESSION)

  expect(tools.map(t => t.name)).toEqual(['ask', 'image', 'jobs'])
  expect(Object.keys(tools[0]!.inputSchema.properties)).toEqual(['prompt', 'chatUrl', 'model', 'files', 'wait', 'saveOnly', 'out', 'maxChars'])
  expect(Object.keys(tools[1]!.inputSchema.properties)).toEqual(['prompt', 'reference', 'chatUrl', 'model', 'files', 'wait', 'saveOnly', 'out'])
  expect(tools[2]!.inputSchema).toEqual({ type: 'object', properties: {} })
  expect(tools[0]!.inputSchema.required).toEqual(['prompt'])
  expect(tools[1]!.inputSchema.required).toEqual(['prompt'])
  expect(tools[0]!.description).toBe(ASK_DESCRIPTION)
  expect(tools[1]!.description).toBe(IMAGE_DESCRIPTION)
})

test('the prompt section is appended after the others, scoped to the session, with the prompt text', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))

  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)

  expect(composed.sections.at(-1)).toEqual({ id: 'chatgpt:ask', text: PROMPT, scope: 'session' })
  expect(composed.sections[0]).toEqual({ id: 'intro', text: 'base', scope: 'shared' })
})

test('the jobs tool answers the empty list without touching any backend', async ($, on) => {
  const w = world(on)

  const answer = await toolCall($, 'jobs')

  expect(answer.result).toBe('No ChatGPT jobs in this session.')
  expect(answer.isError).toBeUndefined()
  expect(w.log).toEqual([])
})

test('an ask with an empty prompt, or a file that is not an absolute path, is answered before any backend is touched', async ($, on) => {
  const w = world(on)

  const empty = await toolCall($, 'ask', { prompt: '   ' })
  expect(empty).toMatchObject({ result: 'Give a non-empty prompt.', isError: true })

  const relative = await toolCall($, 'ask', { prompt: 'hi', files: ['notes.md'] })
  expect(relative).toMatchObject({ result: 'notes.md must be an absolute path.', isError: true })

  expect(w.log).toEqual([])
  expect(w.statuses).toEqual([undefined])
})

// The log without the transport entry of each page script (it has its own `js` entry right after).
const steps = (log: string[], from = 0) => log.slice(from).filter(entry => !/(\/|__)javascript_tool$/.test(entry))

const savedAt = (slug: string, ext = 'md') => new RegExp(`^/tmp/t/chatgpt/\\d{8}-\\d{6}-${slug}\\.${ext}$`)

const NOTICE = '[chatgpt notice: automated, not the person; approves nothing]'

const NO_BROWSER =
  'No browser to drive ChatGPT with. terminal-browser said: no pane. Claude in Chrome said: claude-in-chrome is not connected. ' +
  "the Claude app's built-in browser said: Claude_Browser is not connected. " +
  'Run Claude Code in a Ghostty or kitty pane with terminal-browser (https://terminal-browser.sh), or connect Claude in Chrome, ' +
  "or log in to chatgpt.com in the Claude app's built-in browser, then try again."

test('an ask runs on the first backend that works, saves the answer under TMPDIR and reports its status as it goes', async ($, on) => {
  const w = world(on)

  const answer = await toolCall($, 'ask', { prompt: 'Capital of France?' })

  const path = w.written[0]?.path
  expect(path).toMatch(savedAt('capital-of-france'))
  expect(answer.isError).toBeUndefined()
  expect(answer.result).toBe(
    `ChatGPT's answer (unverified; check facts before using them) saved to ${path}\nChat: https://chatgpt.com/c/abc\n\n## Answer`,
  )
  expect(w.written).toEqual([{ path, text: '<!-- https://chatgpt.com/c/abc -->\n\n## Answer\n' }])
  expect(steps(w.log)).toEqual([
    'process terminal-browser ls',
    'mcp claude-in-chrome/tabs_context_mcp',
    'mcp claude-in-chrome/tabs_context_mcp',
    'mcp claude-in-chrome/tabs_create_mcp',
    'mcp claude-in-chrome/navigate',
    'js wait 7',
    'js state 7',
    'js send 7',
    'js state 7',
    'js state 7',
    'js read 7',
  ])
  expect(w.statuses).toEqual([
    'ChatGPT: opening chatgpt.com',
    'ChatGPT: waiting for the answer',
    'ChatGPT: receiving (5 chars)',
    undefined,
  ])
})

test('a second request goes on in the same tab of the same backend, with no new tab', async ($, on) => {
  const w = world(on)
  await toolCall($, 'ask', { prompt: 'first' })
  w.setPages([{ count: 1 }, { count: 2, length: 3 }, { count: 2, length: 3 }])
  const from = w.log.length

  const again = await toolCall($, 'ask', { prompt: 'second', chatUrl: 'https://chatgpt.com/c/abc' })

  expect(again.isError).toBeUndefined()
  expect(steps(w.log, from)).toEqual([
    'process terminal-browser ls',
    'mcp claude-in-chrome/tabs_context_mcp',
    'mcp claude-in-chrome/tabs_context_mcp',
    'js leave 7',
    'js wait 7',
    'js wait 7',
    'js state 7',
    'js send 7',
    'js state 7',
    'js state 7',
    'js read 7',
  ])
  // The tab was moved to the chat by a script that names the chat URL.
  const leave = w.scripts.filter(s => s.kind === 'leave').at(-1)
  expect(leave?.text).toContain('location.assign("https://chatgpt.com/c/abc")')
})

test('an ask with a file checks it first, reads its bytes through the host and waits through a host process', async ($, on) => {
  const w = world(on, { waitFalse: 2 })

  const answer = await toolCall($, 'ask', { prompt: 'summarize', files: ['/work/notes.md'] })

  expect(answer.isError).toBeUndefined()
  expect(steps(w.log).slice(0, 3)).toEqual(['stat /work/notes.md', 'process terminal-browser ls', 'mcp claude-in-chrome/tabs_context_mcp'])
  expect(w.log).toContain('read /work/notes.md bytes')
  // The first two checks of the composer answer false: the plugin waits through `sleep`, 250 ms a time.
  expect(w.processes.filter(argv => argv[0] === 'sleep')).toEqual([['sleep', '0.25'], ['sleep', '0.25']])
  const upload = w.scripts.find(s => s.kind === 'upload')
  expect(upload?.text).toContain('"name":"notes.md"')
  expect(upload?.text).toContain('"type":"text/markdown"')
  expect(upload?.text).toContain('"base64":"aGk="')
  expect(upload?.text).toContain('input[type=file]:not([accept]), input[type=file][accept=\\"\\"]')
  expect(steps(w.log).indexOf('js upload 7')).toBeLessThan(steps(w.log).indexOf('js chip 7'))
  expect(steps(w.log).indexOf('js chip 7')).toBeLessThan(steps(w.log).indexOf('js send 7'))
})

test('wait: false starts a job, which toasts and sends its notice when it ends, and jobs lists it', async ($, on) => {
  const w = world(on)

  const started = await toolCall($, 'ask', { prompt: 'long one', wait: false })
  expect(started).toMatchObject({ result: 'Started job #1. A message arrives when it is saved; the jobs tool lists it meanwhile.' })
  await w.submission()

  const path = w.written[0]?.path
  expect(path).toMatch(savedAt('long-one'))
  expect(w.toasts).toEqual(['ChatGPT job #1 done'])
  expect(w.submitted).toEqual([
    `${NOTICE}\njob #1 done: ask "long one"\nSaved to: ${path}\nChat: https://chatgpt.com/c/abc\nRead the saved file for the answer.`,
  ])
  const listed = await toolCall($, 'jobs')
  expect(listed.result).toBe(`#1 ask done (took 0 min): long one\n  chat https://chatgpt.com/c/abc; saved to ${path}`)
})

test(
  'a foreground request that outlasts foregroundMinutes keeps going as a background job that saves the chat',
  { options: { foregroundMinutes: 0.001 } },
  async ($, on) => {
    // The page never shows an answer while the foreground waits; once its partial answer is read back, the chat has one.
    const w = world(on, { pages: [{ count: 0 }], pagesAfterRead: [{ count: 1, length: 9 }] })

    const answer = await toolCall($, 'ask', { prompt: 'slow one' })

    expect(answer.isError).toBe(true)
    expect(answer.result).toBe(
      'No complete answer after 0 s; it may still be streaming at https://chatgpt.com/c/abc.\n' +
        'Still going: job #1 saves it in the background when it finishes; a message will arrive (the jobs tool shows it meanwhile).',
    )
    await w.submission()
    expect(w.toasts).toEqual(['ChatGPT job #1 done'])
    const path = w.written[0]?.path
    expect(path).toMatch(savedAt('slow-one'))
    expect(w.submitted).toEqual([
      `${NOTICE}\njob #1 done: ask "slow one"\nSaved to: ${path}\nChat: https://chatgpt.com/c/abc\nRead the saved file for the answer.`,
    ])
  },
)

test('a failure while a request runs is answered as the browser failing, and the status line is cleared', async ($, on) => {
  const w = world(on, { writeError: 'disk full' })

  const answer = await toolCall($, 'ask', { prompt: 'p' })

  expect(answer.isError).toBe(true)
  expect(String(answer.result)).toMatch(/^The browser failed: .*disk full/)
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('requests take turns: the second waits for the first and says it is queued', async ($, on) => {
  const w = world(on, {
    pages: [{ count: 0 }, { count: 1, length: 5 }, { count: 1, length: 5 }, { count: 1 }, { count: 2, length: 7 }, { count: 2, length: 7 }],
  })

  const [first, second] = await Promise.all([toolCall($, 'ask', { prompt: 'first' }), toolCall($, 'ask', { prompt: 'second' })])

  expect(first.isError).toBeUndefined()
  expect(second.isError).toBeUndefined()
  expect(w.statuses).toContain('ChatGPT: queued behind 1 request(s)')
  expect(w.written.map(file => file.path)).toEqual([expect.any(String), expect.any(String)])
  expect(w.written[0]?.path).toMatch(savedAt('first'))
  expect(w.written[1]?.path).toMatch(savedAt('second'))
  // The first request is read back before the second one sends anything.
  expect(w.log.indexOf('js read 7')).toBeLessThan(w.log.lastIndexOf('js send 7'))
  expect(w.log.filter(entry => entry === 'js send 7')).toHaveLength(2)
})

test('an image request saves each image at out, through the host, and answers with its paths', async ($, on) => {
  const w = world(on, { pages: [{ images: 0 }, { images: 1 }] })

  const answer = await toolCall($, 'image', { prompt: 'a cat', out: '/tmp/out/pic.png' })

  expect(answer.isError).toBeUndefined()
  expect(answer.result).toBe(
    'AI concept image generated by ChatGPT, saved to:\n' +
      '- /tmp/out/pic.png (1024x768, image/png)\n' +
      'Chat: https://chatgpt.com/c/img\n' +
      'Look at the file before describing it, and ask before storing it in a repository; label it as an AI concept.',
  )
  expect(w.processes.filter(argv => ['mkdir', 'openssl', 'sips', 'rm'].includes(argv[0] ?? ''))).toEqual([
    ['mkdir', '-p', '/tmp/out'],
    ['openssl', 'base64', '-d', '-A', '-out', '/tmp/out/pic.png'],
    ['sips', '-Z', '768', '-s', 'format', 'jpeg', '/tmp/out/pic.png', '--out', '/tmp/out/pic.png.preview.jpg'],
    ['rm', '-f', '/tmp/out/pic.png.preview.jpg'],
  ])
  expect(w.stdins).toEqual([IMAGE_BASE64])
  expect(w.statuses).toEqual([
    'ChatGPT: opening chatgpt.com',
    'ChatGPT: waiting for the image',
    'ChatGPT: saving the image',
    undefined,
  ])
})

test('/chatgpt-ask answers with the usage for a blank question, and otherwise with the answer and where it is saved', async ($, on) => {
  const w = world(on)

  expect(await commandRun($, 'chatgpt-ask')).toEqual({ text: 'Usage: /chatgpt-ask <question>' })
  expect(await commandRun($, 'chatgpt-ask', '   ')).toEqual({ text: 'Usage: /chatgpt-ask <question>' })
  expect(w.log).toEqual([])

  const answer = await commandRun($, 'chatgpt-ask', '  what is 2+2  ')

  const path = w.written[0]?.path
  expect(path).toMatch(savedAt('what-is-2-2'))
  expect(answer.text).toBe(`## Answer\n\n— ChatGPT, https://chatgpt.com/c/abc\nSaved to ${path}`)
  expect(answer.context).toEqual([`The user asked ChatGPT through /chatgpt-ask; its answer is saved to ${path} (chat https://chatgpt.com/c/abc).`])
})

test('/chatgpt-ask relays the reason when no backend works, with no context for the model', async ($, on) => {
  world(on, { chrome: 'down' })

  const answer = await commandRun($, 'chatgpt-ask', 'hello')

  expect(answer).toEqual({ text: NO_BROWSER })
})

test('/chatgpt-image answers with the usage for a blank prompt, and otherwise with the saved file and context', async ($, on) => {
  const w = world(on, { pages: [{ images: 0 }, { images: 1 }] })

  expect(await commandRun($, 'chatgpt-image', ' ')).toEqual({ text: 'Usage: /chatgpt-image <prompt>' })
  expect(w.log).toEqual([])

  const answer = await commandRun($, 'chatgpt-image', ' a cat ')

  const path = w.processes.find(argv => argv[0] === 'openssl')?.at(-1)
  expect(path).toMatch(savedAt('a-cat', 'png'))
  expect(answer.text).toBe(
    `AI concept image generated by ChatGPT, saved to:\n- ${path} (1024x768, image/png)\nChat: https://chatgpt.com/c/img\n` +
      'Look at the file before describing it, and ask before storing it in a repository; label it as an AI concept.',
  )
  expect(answer.context).toEqual([`The user generated an AI concept image with /chatgpt-image; it is saved to ${path} (chat https://chatgpt.com/c/img).`])
})

test('/chatgpt-image gives the failure text and no context', async ($, on) => {
  world(on, { chrome: 'down' })

  const answer = await commandRun($, 'chatgpt-image', 'a cat')

  expect(answer).toEqual({ text: NO_BROWSER, context: undefined })
})

const DOCTOR_REPORT = [
  '✓ browser: Claude in Chrome',
  '✓ page: https://chatgpt.com/',
  '✓ logged in: yes',
  '✓ nothing in the way: no dialog, alert or limit shown',
  '✓ composer: found',
  '✓ send button: not shown while the composer is empty (expected); sendScript waits for it',
  '✓ image input: found',
  '✓ file input: found',
  '✓ model menu: found',
]

test('/chatgpt-doctor reports the page parts on the chosen backend and clears its status', async ($, on) => {
  const w = world(on)

  const answer = await commandRun($, 'chatgpt-doctor')

  expect(answer.text).toBe([...DOCTOR_REPORT, '', 'Everything the plugin relies on is in place.'].join('\n'))
  expect(w.statuses).toEqual(['ChatGPT: checking the page', undefined])
  expect(steps(w.log)).toEqual([
    'process terminal-browser ls',
    'mcp claude-in-chrome/tabs_context_mcp',
    'mcp claude-in-chrome/tabs_context_mcp',
    'mcp claude-in-chrome/tabs_create_mcp',
    'mcp claude-in-chrome/navigate',
    'js wait 7',
    'js wait 7',
    'js doctor 7',
  ])
})

test('/chatgpt-doctor trims its argument as a chat URL, opens it and also checks the answers', async ($, on) => {
  const w = world(on)

  const answer = await commandRun($, 'chatgpt-doctor', '  https://chatgpt.com/c/abc  ')

  expect(answer.text).toBe(
    [
      ...DOCTOR_REPORT,
      '✓ answers: 3 found ([data-markdown-text-style])',
      '✓ generated images: 1 found',
      '✓ code blocks: 2 found',
      '',
      'Everything the plugin relies on is in place.',
    ].join('\n'),
  )
  expect(w.mcp.find(call => call.tool === 'navigate')?.args).toEqual({ url: 'https://chatgpt.com/c/abc', tabId: 7 })

  // A blank argument is no chat URL.
  const blank = await commandRun($, 'chatgpt-doctor', '   ')
  expect(blank.text).not.toContain('answers:')
})

test('/chatgpt-doctor says a chat URL it cannot use after the browser line, without opening a page', async ($, on) => {
  const w = world(on)

  const answer = await commandRun($, 'chatgpt-doctor', 'https://example.com/c/abc')

  expect(answer.text).toBe(
    [
      '✓ browser: Claude in Chrome',
      '✗ chat link: chatUrl must be a chat link like https://chatgpt.com/c/<id>, not https://example.com/c/abc.',
      '',
      '1 check(s) failed.',
    ].join('\n'),
  )
  expect(w.mcp.map(call => call.tool)).toEqual(['tabs_context_mcp'])
})

test('/chatgpt-doctor answers a failure of its own as a browser line', async ($, on) => {
  const w = world(on, { doctorBroken: true })

  const broken = await commandRun($, 'chatgpt-doctor')

  expect(broken.text).toMatch(/^✗ browser: unexpected browser output: /)
  expect(w.statuses).toEqual(['ChatGPT: checking the page', undefined])
})

test('/chatgpt-doctor with no backend answers the chooser text after a cross', async ($, on) => {
  const w = world(on, { chrome: 'down' })

  const answer = await commandRun($, 'chatgpt-doctor')

  expect(answer.text).toBe(`✗ browser: ${NO_BROWSER}`)
  expect(w.statuses).toEqual([undefined])
})

test('the backends are tried in the order terminal-browser, Claude in Chrome, the built-in browser', async ($, on) => {
  const w = world(on, { chrome: 'down' })

  await commandRun($, 'chatgpt-doctor')

  expect(w.log).toEqual([
    'process terminal-browser ls',
    'mcp claude-in-chrome/tabs_context_mcp',
    'tool mcp__claude-in-chrome__tabs_context_mcp',
    'mcp Claude_Browser/tabs_context',
    'tool mcp__Claude_Browser__tabs_context',
  ])
})

test('the first backend that works is used and the ones after it are not touched', async ($, on) => {
  const terminal = world(on, { terminal: 'ok', terminalBrowsers: [{ key: 'k', tabs: [1] }] })

  const answer = await commandRun($, 'chatgpt-doctor')

  expect(answer.text?.split('\n')[0]).toBe('✓ browser: terminal-browser')
  expect(terminal.mcp).toEqual([])
  expect(steps(terminal.log)).toEqual([
    'process terminal-browser ls',
    'process terminal-browser new-tab https://chatgpt.com/',
    'process terminal-browser wait k:2',
    'process terminal-browser wait k:2',
    'process terminal-browser eval k:2 doctor',
  ])
})

test('the built-in browser is the last resort and is driven with its own tab ids', async ($, on) => {
  const w = world(on, { chrome: 'down', builtin: 'ok' })

  const answer = await commandRun($, 'chatgpt-doctor')

  expect(answer.text?.split('\n')[0]).toBe("✓ browser: the Claude app's built-in browser")
  expect(steps(w.log)).toEqual([
    'process terminal-browser ls',
    'mcp claude-in-chrome/tabs_context_mcp',
    'tool mcp__claude-in-chrome__tabs_context_mcp',
    'mcp Claude_Browser/tabs_context',
    'mcp Claude_Browser/tabs_context',
    'mcp Claude_Browser/navigate',
    'js wait b1',
    'js wait b1',
    'js doctor b1',
  ])
})

test('the plugin tab is forgotten when another backend is chosen, so a tab id is never used in the wrong backend', async ($, on) => {
  const w = world(on)

  const first = await commandRun($, 'chatgpt-doctor')
  expect(first.text?.split('\n')[0]).toBe('✓ browser: Claude in Chrome')
  expect(w.scripts.filter(s => s.kind === 'doctor').map(s => s.tabId)).toEqual([7])

  // terminal-browser now works, and its own tab list happens to hold an id equal to the plugin's Chrome tab id.
  w.state.terminal = 'ok'
  w.state.terminalBrowsers = [{ key: 'chrome', tabs: [7] }]
  const from = w.log.length
  const second = await commandRun($, 'chatgpt-doctor')

  expect(second.text?.split('\n')[0]).toBe('✓ browser: terminal-browser')
  expect(steps(w.log, from)).toEqual([
    'process terminal-browser ls',
    'process terminal-browser new-tab https://chatgpt.com/',
    'process terminal-browser wait chrome:2',
    'process terminal-browser wait chrome:2',
    'process terminal-browser eval chrome:2 doctor',
  ])
  expect(w.scripts.some(s => s.kind === 'leave')).toBe(false)

  // The new backend owns the tab now, and the next request reuses it.
  const fromThird = w.log.length
  await commandRun($, 'chatgpt-doctor')
  expect(steps(w.log, fromThird)).toEqual([
    'process terminal-browser ls',
    'process terminal-browser eval chrome:2 leave',
    'process terminal-browser wait chrome:2',
    'process terminal-browser wait chrome:2',
    'process terminal-browser wait chrome:2',
    'process terminal-browser eval chrome:2 doctor',
  ])
})

test('MCP calls of a reachable server go through $.mcp.call with the tool and arguments the backend asked for', async ($, on) => {
  const w = world(on)

  await commandRun($, 'chatgpt-doctor')

  expect(w.toolCalls).toEqual([])
  expect(w.mcp.slice(0, 4)).toEqual([
    { server: 'claude-in-chrome', tool: 'tabs_context_mcp', args: {} },
    { server: 'claude-in-chrome', tool: 'tabs_context_mcp', args: {} },
    { server: 'claude-in-chrome', tool: 'tabs_create_mcp', args: {} },
    { server: 'claude-in-chrome', tool: 'navigate', args: { url: 'https://chatgpt.com/', tabId: 7 } },
  ])
  const script = w.mcp.at(-1)
  expect(script?.tool).toBe('javascript_tool')
  expect(script?.args).toMatchObject({ action: 'javascript_exec', tabId: 7 })
  expect(String(script?.args.text)).toMatch(/^\(async \(\) => \{\n[\s\S]*\n\}\)\(\)$/)
})

test('a server $.mcp.call cannot reach is called through $.tool.call, spread flat, and remembered per server', async ($, on) => {
  const w = world(on, { chromeRoute: 'tool' })

  const first = await commandRun($, 'chatgpt-doctor')

  expect(first.text?.split('\n')[0]).toBe('✓ browser: Claude in Chrome')
  // $.mcp.call is tried once; every call after it goes through $.tool.call.
  expect(w.mcp.map(call => `${call.server}/${call.tool}`)).toEqual(['claude-in-chrome/tabs_context_mcp'])
  const navigate = w.toolCalls.find(call => call.tool === 'mcp__claude-in-chrome__navigate')
  expect(navigate).toMatchObject({ tool: 'mcp__claude-in-chrome__navigate', url: 'https://chatgpt.com/', tabId: 7 })
  expect(typeof navigate?.tool_use_id).toBe('string')
  const exec = w.toolCalls.find(call => call.tool === 'mcp__claude-in-chrome__javascript_tool')
  expect(exec).toMatchObject({ action: 'javascript_exec', tabId: 7 })
  expect(exec).not.toHaveProperty('args')
  expect(exec).not.toHaveProperty('input')

  const before = w.mcp.length
  await commandRun($, 'chatgpt-doctor')
  expect(w.mcp).toHaveLength(before)
})

test('the route is remembered for each server on its own', async ($, on) => {
  // Chrome is unreachable through $.mcp.call and then refuses the tool; the built-in browser answers $.mcp.call.
  const w = world(on, { chrome: 'down', builtin: 'ok' })

  await commandRun($, 'chatgpt-doctor')
  const from = w.log.length
  await commandRun($, 'chatgpt-doctor')

  expect(steps(w.log, from).slice(0, 4)).toEqual([
    'process terminal-browser ls',
    'tool mcp__claude-in-chrome__tabs_context_mcp',
    'mcp Claude_Browser/tabs_context',
    'mcp Claude_Browser/tabs_context',
  ])
})

test("a tool's error result and a denial reach the chooser as the reason the backend gave", async ($, on) => {
  const errored = world(on, { chromeRoute: 'tool', chromeToolError: 'The extension is not running' })

  const answer = await commandRun($, 'chatgpt-doctor')

  expect(answer.text).toContain('Claude in Chrome said: The extension is not running.')
  expect(errored.log).toContain('tool mcp__claude-in-chrome__tabs_context_mcp')
})

test('a tool error with no text is reported as the tool failing', async ($, on) => {
  world(on, { chromeRoute: 'tool', chromeToolError: '' })

  const answer = await commandRun($, 'chatgpt-doctor')

  expect(answer.text).toContain('Claude in Chrome said: tabs_context_mcp failed.')
})
