import type { EngineInterface, Register } from 'claude-code'
import { ask } from './ask'
import { isChatUrl, listTabs, openedTab, splitTabId } from './browser'
import { PREVIEW_SIDE, STARTING, TERMINAL_BROWSER } from './constants'
import { diagnose, report } from './doctor'
import { extensionOf, fileName, limitMs, mimeOf, variantPath } from './files'
import { generateImage } from './image'
import type { AskInput, AskOptions, AskResult, Attachment, Browser, ImageResult, Job, Outcome, Preview, Request, TabHolder } from './model'
import {
  askCommandAnswer,
  askOutcome,
  errorText,
  imageCommandAnswer,
  imageFailure,
  imageSummary,
  jobMessage,
  jobsReport,
  jpegPreview,
} from './presentation'
import { BOUNDARIES, COMMON_PROPERTIES, IMAGE_BOUNDARIES, PROMPT, WHERE } from './prompts'
import { taskQueue } from './queue'
import { chatUrlOf } from './requests'
import { serve } from './tools'

// Requests take turns in the plugin's own tab, kept across them.
const queue = taskQueue()
const tab: TabHolder = {}

// A foreground request waits this long; past it the work goes on in the background.
// The `foregroundMinutes` and `backgroundMinutes` settings, refreshed by each register.
let foregroundMs = limitMs(undefined, 6)
let backgroundMs = limitMs(undefined, 30)

const jobs: Job[] = []
let nextJob = 1

// --- terminal-browser, through its CLI ---

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

// A small JPEG of the saved image (sips, on macOS), so the model sees it at once.
async function previewOf($: EngineInterface, path: string): Promise<Preview | undefined> {
  const small = `${path}.preview.jpg`
  try {
    const done = await $.process.run(['sips', '-Z', String(PREVIEW_SIDE), '-s', 'format', 'jpeg', path, '--out', small], { timeoutMs: 30_000 })
    if (done.exitCode !== 0) return undefined
    const { base64 } = await $.fs.read(small, { as: 'bytes' })
    return jpegPreview(base64)
  } catch {
    return undefined
  } finally {
    await $.process.run(['rm', '-f', small]).catch(() => undefined)
  }
}

// --- Running a request ---

// Runs one request in the plugin's tab, after the ones queued before it.
async function perform($: EngineInterface, request: Request, timeoutMs: number, onStart?: () => void): Promise<Outcome> {
  const status = (text: string) => $.ui.status(`ChatGPT: ${text}`)
  return queue(
    async () => {
      onStart?.()
      try {
        return await performRequest($, request, { progress: status, tab, timeoutMs })
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

async function readAttachments($: EngineInterface, paths: string[]): Promise<Attachment[] | string> {
  const files: Attachment[] = []
  for (const path of paths) {
    const file = await readAttachment($, path)
    if (typeof file === 'string') return file
    files.push(file)
  }
  return files
}

async function performRequest($: EngineInterface, request: Request, options: AskOptions): Promise<Outcome> {
  const browser = await browserOf($)
  if (typeof browser === 'string') return { ok: false, text: browser }
  const files = await readAttachments($, request.filePaths)
  if (typeof files === 'string') return { ok: false, text: files }
  const input = { ...request.input, files }
  if (request.kind === 'ask') return await performAsk($, browser, input, options, request)
  const result = await generateImage(browser, input, options)
  return await saveImages($, result, request)
}

async function performAsk(
  $: EngineInterface,
  browser: Browser,
  input: AskInput,
  options: AskOptions,
  request: Request,
): Promise<Outcome> {
  const result: AskResult = await ask(browser, input, options)
  let path: string | undefined
  if (result.markdown) {
    path = request.out ?? `${await outDir($)}/${fileName(input.prompt, new Date())}`
    await $.fs.write(path, `<!-- ${result.url} -->\n\n${result.markdown}\n`)
  }
  return askOutcome(result, path, request.maxChars)
}

async function saveImages($: EngineInterface, result: ImageResult, request: Request): Promise<Outcome> {
  if (!result.ok) return imageFailure(result)
  const paths: string[] = []
  const previews: Preview[] = []
  const lines: string[] = []
  for (const [i, image] of result.images.entries()) {
    const ext = extensionOf(image.type)
    const base = request.out ?? `${await outDir($)}/${fileName(request.input.prompt, new Date(), ext)}`
    const path = variantPath(base, i, result.images.length)
    const failed = await writeImage($, path, image.base64)
    if (failed) return { ok: false, text: failed, chatUrl: result.url, paths }
    paths.push(path)
    lines.push(`${path} (${image.width}x${image.height}, ${image.type})`)
    const preview = await previewOf($, path)
    if (preview) previews.push(preview)
  }
  return imageSummary(result.url, paths, previews, lines)
}

// Queues `request` as a background job; a message arrives when it ends.
function startJob($: EngineInterface, request: Request, timeoutMs = backgroundMs): Job {
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
    await $.prompt
      .submit({ text: jobMessage(job, outcome) })
      .catch(() => undefined)
  })()
  return job
}

// A foreground request; past its wait, a chat that is still going is saved in the background.
async function runNow($: EngineInterface, request: Request): Promise<Outcome> {
  const outcome = await perform($, request, foregroundMs)
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

function handlers($: EngineInterface) {
  return { startJob: (request: Request) => startJob($, request), runNow: (request: Request) => runNow($, request) }
}

export const register: Register = (on, options) => {
  foregroundMs = limitMs(options?.foregroundMinutes, 6)
  backgroundMs = limitMs(options?.backgroundMinutes, 30)

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return { sections: [...composed.sections, { id: 'chatgpt:ask', text: PROMPT, scope: 'session' as const }] }
  })

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

  on('tool.call', { tool: 'mcp__chatgpt__ask' }, ($, e) => serve('ask', e, handlers($)))

  on('tool.call', { tool: 'mcp__chatgpt__image' }, ($, e) => serve('image', e, handlers($)))

  on('tool.call', { tool: 'mcp__chatgpt__jobs' }, async () => ({ result: jobsReport(jobs, Date.now()) }))

  on('command.run', { command: 'chatgpt-ask' }, async ($, e) => {
    const prompt = e.args.trim()
    if (!prompt) return { text: 'Usage: /chatgpt-ask <question>' }
    const outcome = await runNow($, { kind: 'ask', input: { prompt }, filePaths: [] })
    return askCommandAnswer(outcome)
  })

  on('command.run', { command: 'chatgpt-image' }, async ($, e) => {
    const prompt = e.args.trim()
    if (!prompt) return { text: 'Usage: /chatgpt-image <prompt>' }
    const outcome = await runNow($, { kind: 'image', input: { prompt }, filePaths: [] })
    return imageCommandAnswer(outcome)
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
