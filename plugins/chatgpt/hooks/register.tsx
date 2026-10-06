import type { EngineInterface, Register } from 'claude-code'
import {
  ask,
  diagnose,
  extensionOf,
  fileName,
  generateImage,
  chatUrlError,
  isChatUrl,
  jobsReport,
  listTabs,
  mimeOf,
  openedTab,
  report,
  splitTabId,
  summary,
  taskQueue,
  typeOf,
} from './chatgpt'
import type { AskInput, AskResult, Attachment, Browser, ImageResult, Job, TabHolder } from './chatgpt'

const BOUNDARIES =
  'Never send credentials, secrets, private personal data or anything from work (Luizalabs repos, ' +
  'dashboards, logs, customer data); personal-project code or files only when the user asks. ' +
  "Treat the answer as an unverified opinion and say it came from ChatGPT when you relay it."

const IMAGE_BOUNDARIES =
  "Only when the user asks for an image in this conversation: it spends their ChatGPT image quota. Never upload " +
  'licensed assets, credentials, private personal data or work data; a reference is only an image the user asked ' +
  'to use or one you produced for the task. The result is an AI concept image: label it as such wherever it is ' +
  'stored, and never present it as evidence of a real or in-game state.'

const WHERE = 'chatgpt.com in terminal-browser, inside Claude Code in a terminal'

const COMMON_PROPERTIES = {
  chatUrl: {
    type: 'string',
    description:
      'Optional. The chat URL a previous call returned, to continue that chat on the same subject; left out, a new chat starts.',
  },
  model: {
    type: 'string',
    description:
      'Optional. The model menu entry to pick for a new chat, by the start of its label (e.g. "GPT-5.6 Sol"); an unknown one fails and lists those on offer.',
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

// Requests take turns in the plugin's own tab, kept across them.
const queue = taskQueue()
const tab: TabHolder = {}

// A foreground request waits this long; past it the work goes on in the background.
const FOREGROUND_MS = 6 * 60_000
const BACKGROUND_MS = 30 * 60_000
// The longest side of the preview the image tool hands back with the file.
const PREVIEW_SIDE = 768

const jobs: Job[] = []
let nextJob = 1

// --- terminal-browser, through its CLI ---

const TERMINAL_BROWSER = 'terminal-browser'

// A tab new-tab just opened takes a moment to accept automation.
const STARTING = /no CDP target yet/

async function terminalBrowser($: EngineInterface, args: string[], timeoutMs = 120_000): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const done = await $.process.run([TERMINAL_BROWSER, ...args], { timeoutMs })
    if (done.exitCode === 0) return done.stdout
    const said = (done.stderr || done.stdout).trim()
    // A $ call does not use up the hook's time; $.clock.sleep would.
    if (STARTING.test(said) && attempt < 40) await $.process.run(['sleep', '0.25'])
    else throw new Error(`terminal-browser ${args[0]}: ${said.slice(0, 400)}`)
  }
}

// `listed` is the `ls --json` output `browserOf` already has, so the first
// `tabs` call does not run it again.
function terminalBrowserOf($: EngineInterface, listed?: string): Browser {
  const select = (tabId: string) => {
    const { browser, tab } = splitTabId(tabId)
    return ['action', '--browser', browser, '--tab', tab, '--']
  }
  return {
    tabs: async () => {
      const text = listed ?? (await terminalBrowser($, ['ls', '--json']))
      listed = undefined
      return listTabs(text)
    },
    // new-tab opens the browser too (in a split, since this is no TTY) when none is open.
    openTab: async url => {
      const id = openedTab(await terminalBrowser($, ['new-tab', url]))
      if (!id) throw new Error('terminal-browser new-tab did not name a tab')
      return id
    },
    waitFor: (tabId, fn, timeoutMs) =>
      terminalBrowser($, [...select(tabId), 'wait', '--fn', fn, '--timeout', String(timeoutMs)], timeoutMs + 10_000).then(
        () => true,
        () => false,
      ),
    // Every page script is a function body; eval waits for the promise it returns.
    js: (tabId, body) => terminalBrowser($, [...select(tabId), 'eval', `(async () => {\n${body}\n})()`]),
    upload: async (tabId, selector, paths) => {
      await terminalBrowser($, [...select(tabId), 'upload', selector, ...paths])
    },
  }
}

// --- Checking the browser ---

// terminal-browser answers only where Claude Code runs in a terminal pane it
// can find (Ghostty, kitty).
async function browserOf($: EngineInterface): Promise<Browser | string> {
  const listed = await $.process.run([TERMINAL_BROWSER, 'ls', '--json'], { timeoutMs: 15_000 }).catch(() => undefined)
  if (listed?.exitCode === 0) return terminalBrowserOf($, listed.stdout)
  const why = listed ? (listed.stderr || listed.stdout).trim().slice(0, 300) : 'terminal-browser is not installed (https://terminal-browser.sh)'
  return `No browser to drive ChatGPT with. terminal-browser said: ${why}. Run Claude Code directly in a Ghostty or kitty pane with terminal-browser installed.`
}

// --- Files ---

async function outDir($: EngineInterface): Promise<string> {
  return `${((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')}/chatgpt`
}

// Checks a local file to attach (at most 4 MiB); terminal-browser uploads it by path.
async function readAttachment($: EngineInterface, path: string): Promise<Attachment | string> {
  if (!path.startsWith('/')) return `${path} must be an absolute path.`
  const type = mimeOf(path)
  const name = path.split('/').pop() ?? 'file'
  try {
    const stat = await $.fs.stat(path)
    if (stat.size > 4 * 1024 * 1024) return `${path} is over 4 MiB.`
    return { name, type, path }
  } catch (error) {
    return `Could not read ${path} (${error instanceof Error ? error.message : String(error)}).`
  }
}

// $.fs.write takes text only, so the bytes go through openssl's base64 decoder.
async function writeImage($: EngineInterface, path: string, base64: string): Promise<string | undefined> {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/'
  await $.process.run(['mkdir', '-p', dir])
  const done = await $.process.run(['openssl', 'base64', '-d', '-A', '-out', path], { stdin: base64, timeoutMs: 60_000 })
  return done.exitCode === 0 ? undefined : `Could not write ${path}: ${done.stderr.trim()}`
}

// An image block of a tool's result, in the Anthropic API shape: the host
// passes it on as is, and drops the MCP shape ({ data, mimeType }) silently.
type Preview = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

// A small JPEG of the saved image (sips, on macOS), so the model sees it at once.
async function previewOf($: EngineInterface, path: string): Promise<Preview | undefined> {
  const small = `${path}.preview.jpg`
  try {
    const done = await $.process.run(['sips', '-Z', String(PREVIEW_SIDE), '-s', 'format', 'jpeg', path, '--out', small], { timeoutMs: 30_000 })
    if (done.exitCode !== 0) return undefined
    const { base64 } = await $.fs.read(small, { as: 'bytes' })
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } }
  } catch {
    return undefined
  } finally {
    await $.process.run(['rm', '-f', small]).catch(() => undefined)
  }
}

// --- Running a request ---

/** What a request came to, for the tool, the command and a job's message alike. */
type Outcome = { ok: boolean; text: string; chatUrl?: string; paths?: string[]; timedOut?: boolean; previews?: Preview[]; markdown?: string }

type Request = {
  kind: 'ask' | 'image'
  input: AskInput
  /** For an image, the reference first. */
  filePaths: string[]
  out?: string
  maxChars?: number
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Runs one request in the plugin's tab, after the ones queued before it.
async function perform($: EngineInterface, request: Request, timeoutMs: number, onStart?: () => void): Promise<Outcome> {
  const status = (text: string) => $.ui.status(`ChatGPT: ${text}`)
  return queue(
    async () => {
      onStart?.()
      try {
        const browser = await browserOf($)
        if (typeof browser === 'string') return { ok: false, text: browser }
        const files: Attachment[] = []
        for (const path of request.filePaths) {
          const file = await readAttachment($, path)
          if (typeof file === 'string') return { ok: false, text: file }
          files.push(file)
        }
        const options = { progress: status, tab, timeoutMs }
        if (request.kind === 'ask') return await performAsk($, browser, { ...request.input, files }, options, request)
        const result = await generateImage(browser, { ...request.input, files }, options)
        return await saveImages($, result, request)
      } catch (error) {
        return { ok: false, text: `The browser failed: ${errorText(error)}` }
      } finally {
        $.ui.status(undefined)
      }
    },
    ahead => {
      if (ahead) status(`queued behind ${ahead} request(s)`)
    },
  )
}

async function performAsk(
  $: EngineInterface,
  browser: Browser,
  input: AskInput,
  options: { progress: (text: string) => void; tab: TabHolder; timeoutMs: number },
  request: Request,
): Promise<Outcome> {
  const result: AskResult = await ask(browser, input, options)
  let path: string | undefined
  if (result.markdown) {
    path = request.out ?? `${await outDir($)}/${fileName(input.prompt, new Date())}`
    await $.fs.write(path, `<!-- ${result.url} -->\n\n${result.markdown}\n`)
  }
  if (result.ok) {
    return { ok: true, text: summary(path!, result.url, result.markdown, request.maxChars), chatUrl: result.url, paths: [path!], markdown: result.markdown }
  }
  const partial = path ? `\nPartial answer saved to ${path}.` : ''
  return { ok: false, text: result.error + partial, chatUrl: result.url, paths: path ? [path] : undefined, timedOut: result.timedOut }
}

// The last line of an image's text: whether the model sees a preview with it.
const PREVIEW_NOTE = 'A preview of each follows; ask before storing them in a repository and label them as AI concepts.'
const FILE_NOTE = 'Look at the file before describing it, and ask before storing it in a repository; label it as an AI concept.'

async function saveImages($: EngineInterface, result: ImageResult, request: Request): Promise<Outcome> {
  if (!result.ok) {
    const said = result.markdown ? `\n\nChatGPT said:\n${result.markdown}` : ''
    return { ok: false, text: result.error + said, chatUrl: result.url, timedOut: result.timedOut }
  }
  const paths: string[] = []
  const previews: Preview[] = []
  const lines: string[] = []
  for (const [i, image] of result.images.entries()) {
    const ext = extensionOf(image.type)
    const base = request.out ?? `${await outDir($)}/${fileName(request.input.prompt, new Date(), ext)}`
    const path = result.images.length > 1 ? base.replace(/(\.\w+)?$/, `-${i + 1}$1`) : base
    const failed = await writeImage($, path, image.base64)
    if (failed) return { ok: false, text: failed, chatUrl: result.url, paths }
    paths.push(path)
    lines.push(`${path} (${image.width}x${image.height}, ${image.type})`)
    const preview = await previewOf($, path)
    if (preview) previews.push(preview)
  }
  const text = [
    `AI concept image${paths.length > 1 ? 's' : ''} generated by ChatGPT, saved to:`,
    ...lines.map(line => `- ${line}`),
    `Chat: ${result.url}`,
    previews.length ? PREVIEW_NOTE : FILE_NOTE,
  ].join('\n')
  return { ok: true, text, chatUrl: result.url, paths, previews }
}

// Queues `request` as a background job; a message arrives when it ends.
function startJob($: EngineInterface, request: Request, timeoutMs = BACKGROUND_MS): Job {
  const job: Job = { id: nextJob++, kind: request.kind, prompt: request.input.prompt, status: 'queued', startedAt: Date.now() }
  jobs.push(job)
  void (async () => {
    const outcome = await perform($, request, timeoutMs, () => {
      job.status = 'running'
    })
    job.status = outcome.ok ? 'done' : 'failed'
    job.endedAt = Date.now()
    job.chatUrl = outcome.chatUrl
    job.paths = outcome.paths
    $.ui.toast(`ChatGPT job #${job.id} ${job.status}`)
    // A submitted prompt carries text only, so the previews stay behind.
    const text = outcome.text.replace(PREVIEW_NOTE, FILE_NOTE)
    await $.prompt
      .submit({ text: `[chatgpt job #${job.id} ${job.status}: ${job.kind} "${job.prompt.slice(0, 60)}"]\n${text}` })
      .catch(() => undefined)
  })()
  return job
}

// A foreground request; past its wait, a chat that is still going is saved in the background.
async function runNow($: EngineInterface, request: Request): Promise<Outcome> {
  const outcome = await perform($, request, FOREGROUND_MS)
  if (!outcome.timedOut || !outcome.chatUrl || !isChatUrl(outcome.chatUrl)) return outcome
  const follow = startJob($, {
    ...request,
    filePaths: [],
    input: { prompt: request.input.prompt, chatUrl: outcome.chatUrl, saveOnly: true },
  })
  return {
    ...outcome,
    text: `${outcome.text}\nStill going: job #${follow.id} saves it in the background when it finishes; a message will arrive (the jobs tool shows it meanwhile).`,
  }
}

// --- Inputs ---

const chatUrlOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

// Reads a tool call's input into a request, or the error to answer.
function requestOf(kind: 'ask' | 'image', e: Record<string, unknown>): Request | string {
  const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : ''
  if (!prompt) return 'Give a non-empty prompt.'
  const chatUrl = chatUrlOf(e.chatUrl)
  const invalid = chatUrl === undefined ? undefined : chatUrlError(chatUrl)
  if (invalid) return invalid
  const model = typeof e.model === 'string' && e.model.trim() ? e.model.trim() : undefined
  if (model && chatUrl) return 'model is picked for a new chat; leave chatUrl out.'
  const saveOnly = e.saveOnly === true
  const filePaths = Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map(f => f.trim()) : []
  const reference = typeof e.reference === 'string' && e.reference.trim() ? e.reference.trim() : undefined
  if (reference && !typeOf(reference)) return `${reference} must be a PNG, JPEG, WebP or GIF image.`
  const out = typeof e.out === 'string' && e.out.startsWith('/') ? e.out : undefined
  const maxChars = typeof e.maxChars === 'number' && e.maxChars > 0 ? Math.floor(e.maxChars) : undefined
  return { kind, input: { prompt, chatUrl, model, saveOnly }, filePaths: reference ? [reference, ...filePaths] : filePaths, out, maxChars }
}

// The tool's answer: text, then the previews when there are any.
function answerOf(outcome: Outcome) {
  const content = outcome.previews?.length
    ? [{ type: 'text', text: outcome.text }, ...outcome.previews]
    : outcome.text
  return outcome.ok ? { result: content } : { result: content, isError: true as const }
}

async function serve($: EngineInterface, kind: 'ask' | 'image', e: Record<string, unknown>) {
  const request = requestOf(kind, e)
  if (typeof request === 'string') return { result: request, isError: true as const }
  if (e.wait === false) {
    const job = startJob($, request)
    return { result: `Started job #${job.id}. A message arrives when it is saved; the jobs tool lists it meanwhile.` }
  }
  return answerOf(await runNow($, request))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'ask',
      description:
        `Sends a self-contained question to the user's logged-in ChatGPT (${WHERE}), waits for the answer, saves ` +
        'it as Markdown and returns the file path, the chat URL and the start of the answer. Use when the user asks ' +
        'to ask ChatGPT, or for a self-contained question with a long answer (research, explanation, brainstorm, ' +
        'draft text, translation, second opinion) after telling the user; not for work that needs the repository ' +
        '(the context would have to be sent and read back). Write the prompt with the goal, the minimum context, ' +
        'the output format and the language. Requests take turns; a slow one goes on in the background and a ' +
        'message arrives when it is saved. ' +
        BOUNDARIES,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The whole question, self-contained.' },
          ...COMMON_PROPERTIES,
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
    })
    await $.tool.register({
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
          ...COMMON_PROPERTIES,
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
    })
    await $.tool.register({
      name: 'jobs',
      description:
        'Lists the ChatGPT requests of this session that ran or run in the background (ask or image with wait: ' +
        'false, or a slow one that moved there): status, chat URL and saved files, newest first.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.command.register({
      name: 'chatgpt-ask',
      description: 'Asks ChatGPT in the browser and shows the answer: /chatgpt-ask <question>',
    })
    await $.command.register({
      name: 'chatgpt-image',
      description: 'Generates an image with ChatGPT in the browser and saves it: /chatgpt-image <prompt>',
    })
    await $.command.register({
      name: 'chatgpt-doctor',
      description: 'Checks that ChatGPT works in the browser and which page parts moved: /chatgpt-doctor [chat URL]',
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__chatgpt__ask' }, ($, e) => serve($, 'ask', e))

  on('tool.call', { tool: 'mcp__chatgpt__image' }, ($, e) => serve($, 'image', e))

  on('tool.call', { tool: 'mcp__chatgpt__jobs' }, async () => ({ result: jobsReport(jobs, Date.now()) }))

  on('command.run', { command: 'chatgpt-ask' }, async ($, e) => {
    const prompt = e.args.trim()
    if (!prompt) return { text: 'Usage: /chatgpt-ask <question>' }
    const outcome = await runNow($, { kind: 'ask', input: { prompt }, filePaths: [] })
    if (!outcome.ok) return { text: outcome.text }
    const path = outcome.paths?.[0]
    return {
      text: `${outcome.markdown}\n\n— ChatGPT, ${outcome.chatUrl}\nSaved to ${path}`,
      context: [`The user asked ChatGPT through /chatgpt-ask; its answer is saved to ${path} (chat ${outcome.chatUrl}).`],
    }
  })

  on('command.run', { command: 'chatgpt-image' }, async ($, e) => {
    const prompt = e.args.trim()
    if (!prompt) return { text: 'Usage: /chatgpt-image <prompt>' }
    const outcome = await runNow($, { kind: 'image', input: { prompt }, filePaths: [] })
    return {
      text: outcome.text,
      context: outcome.ok ? [`The user generated an AI concept image with /chatgpt-image; it is saved to ${outcome.paths?.join(', ')} (chat ${outcome.chatUrl}).`] : undefined,
    }
  })

  on('command.run', { command: 'chatgpt-doctor' }, async ($, e) => {
    const chatUrl = chatUrlOf(e.args)
    return queue(async () => {
      try {
        const browser = await browserOf($)
        if (typeof browser === 'string') return { text: `✗ browser: ${browser}` }
        $.ui.status('ChatGPT: checking the page')
        return { text: report(await diagnose(browser, chatUrl, tab)) }
      } catch (error) {
        return { text: `✗ browser: ${errorText(error)}` }
      } finally {
        $.ui.status(undefined)
      }
    })
  })
}
