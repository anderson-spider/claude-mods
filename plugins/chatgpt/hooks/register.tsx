import type { EngineInterface, Register } from 'claude-code'
import { diagnose, report } from './doctor'
import { performRequest, runNow as runForeground, createJobs, taskQueue } from './runner'
import { chatUrlOf } from './input'
import { limitMs } from './settings'
import type { Browser, Outcome, ProcessRunner, Request, RequestDeps, TabHolder } from './model'
import { askCommandAnswer, errorText, imageCommandAnswer } from './presentation'
import { ASK_DESCRIPTION, IMAGE_DESCRIPTION, PROMPT } from './prompts'
import {
  ASK_COMMAND_DESCRIPTION,
  ASK_INPUT_SCHEMA,
  DOCTOR_COMMAND_DESCRIPTION,
  IMAGE_COMMAND_DESCRIPTION,
  IMAGE_INPUT_SCHEMA,
  JOBS_DESCRIPTION,
  JOBS_INPUT_SCHEMA,
} from './tool-schemas'
import { type Candidate, chooseBrowser } from './browsers'
import { BUILTIN, BUILTIN_SERVER, builtinBrowserOf, builtinStaysOnChatgpt } from './builtin-browser'
import { CHROME, CHROME_SERVER, chromeBrowserOf, chromeStaysOnChatgpt } from './chrome-browser'
import { type BrowserDeps, type McpCall, type McpHost, bytesOf, mcpCallOf } from './mcp-browser'
import { TERMINAL_BROWSER, openTerminalBrowser } from './terminal-browser'
import { serve } from './tools'

const PLUGIN = 'chatgpt'

// A backend: terminal-browser runs as a host process; the others are MCP servers, whose `stays` says which of the
// plugin's own calls to them stay on chatgpt.com.
type Backend =
  | { name: string; open(run: ProcessRunner): Promise<Browser | string> }
  | {
      name: string
      server: string
      open(deps: BrowserDeps): Promise<Browser>
      stays(tool: string, input: unknown, tabId: string | undefined): boolean
    }

// The backends in the order the plugin tries them.
const BACKENDS: Backend[] = [
  { name: TERMINAL_BROWSER, open: openTerminalBrowser },
  { name: CHROME, server: CHROME_SERVER, open: chromeBrowserOf, stays: chromeStaysOnChatgpt },
  { name: BUILTIN, server: BUILTIN_SERVER, open: builtinBrowserOf, stays: builtinStaysOnChatgpt },
]

// Which of the plugin's own calls to each browser server stay on chatgpt.com, by the tool's `mcp__` prefix.
const OWN_CALLS = BACKENDS.flatMap(backend => ('server' in backend ? [{ prefix: `mcp__${backend.server}__`, stays: backend.stays }] : []))

// Requests take turns in the plugin's own tab, kept across them.
const queue = taskQueue()
const tab: TabHolder = {}
const jobs = createJobs()

// The backend the plugin's tab belongs to: a tab id means nothing in another backend.
let tabOwner: string | undefined

// The defaults of the `foregroundMinutes` and `backgroundMinutes` settings, as plugin.json declares them.
const FOREGROUND_MINUTES = 6
const BACKGROUND_MINUTES = 30

// A foreground request waits this long; past it the work goes on in the background.
// The `foregroundMinutes` and `backgroundMinutes` settings, refreshed by each register.
let foregroundMs = limitMs(undefined, FOREGROUND_MINUTES)
let backgroundMs = limitMs(undefined, BACKGROUND_MINUTES)

function processOf($: EngineInterface): ProcessRunner {
  return (argv, init) => $.process.run(argv, init)
}

function readBytes($: EngineInterface, path: string) {
  return $.fs.read(path, { as: 'bytes' })
}

// One caller per MCP server for the session, so the route it decided (see mcpCallOf) is remembered across requests.
const mcpCalls = new Map<string, McpCall>()

function mcpHostOf($: EngineInterface): McpHost {
  return {
    mcp: (server, tool, args) => $.mcp.call(server, tool, args),
    tool: input => $.tool.call(input as never),
  }
}

function callOf($: EngineInterface, server: string): McpCall {
  let call = mcpCalls.get(server)
  if (!call) {
    call = mcpCallOf(mcpHostOf($), server)
    mcpCalls.set(server, call)
  }
  return call
}

// BACKENDS, each opened only when the chooser gets to it.
function candidatesOf($: EngineInterface): Candidate[] {
  const run = processOf($)
  // Waits go through a host process, which does not use up the hook's clock budget as a timer would.
  const deps = (server: string): BrowserDeps => ({
    call: callOf($, server),
    readBytes: async (path: string) => bytesOf((await readBytes($, path)).base64),
    sleep: async (ms: number) => {
      await $.process.run(['sleep', String(ms / 1000)])
    },
    now: () => Date.now(),
  })
  return BACKENDS.map(backend =>
    'server' in backend ? { name: backend.name, open: () => backend.open(deps(backend.server)) } : { name: backend.name, open: () => backend.open(run) },
  )
}

// Picks the backend, and starts the plugin's tab afresh when it differs from the one that opened that tab.
async function pickBrowser($: EngineInterface): Promise<{ browser: Browser; name: string } | string> {
  const chosen = await chooseBrowser(candidatesOf($))
  if (typeof chosen === 'string') return chosen
  if (tabOwner !== chosen.name) {
    tab.id = undefined
    tabOwner = chosen.name
  }
  return chosen
}

function requestDeps($: EngineInterface): RequestDeps {
  const run = processOf($)
  return {
    browser: async () => {
      const picked = await pickBrowser($)
      return typeof picked === 'string' ? picked : picked.browser
    },
    attachments: { stat: path => $.fs.stat(path) },
    output: {
      run,
      files: {
        write: (path, text) => $.fs.write(path, text),
        readBytes: path => readBytes($, path),
      },
      tmpDir: () => $.env.get('TMPDIR'),
    },
  }
}

// Runs one request in the plugin's tab, after the ones queued before it.
async function perform($: EngineInterface, request: Request, timeoutMs: number, onStart?: () => void): Promise<Outcome> {
  const status = (text: string) => $.ui.status(`ChatGPT: ${text}`)
  return queue(
    async () => {
      onStart?.()
      try {
        return await performRequest(requestDeps($), request, { progress: status, tab, timeoutMs })
      } catch (error) {
        const text = `The browser failed: ${errorText(error)}`
        return { ok: false, text, error: text }
      } finally {
        $.ui.status(undefined)
      }
    },
    ahead => {
      if (ahead) status(`queued behind ${ahead} request(s)`)
    },
  )
}

function handlers($: EngineInterface) {
  const run = (request: Request, timeoutMs: number, onStart?: () => void) => perform($, request, timeoutMs, onStart)
  const startJob = (request: Request) => jobs.start(
    {
      perform: run,
      notifications: {
        toast: text => $.ui.toast(text),
        submit: text => $.prompt.submit({ text }),
      },
    },
    request,
    backgroundMs,
  )
  return { startJob, runNow: (request: Request) => runForeground(run, startJob, request, foregroundMs) }
}

export const register: Register = (on, options) => {
  foregroundMs = limitMs(options?.foregroundMinutes, FOREGROUND_MINUTES)
  backgroundMs = limitMs(options?.backgroundMinutes, BACKGROUND_MINUTES)

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return { sections: [...composed.sections, { id: 'chatgpt:ask', text: PROMPT, scope: 'session' as const }] }
  })

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'ask', description: ASK_DESCRIPTION, inputSchema: ASK_INPUT_SCHEMA })
    await $.tool.register({ name: 'image', description: IMAGE_DESCRIPTION, inputSchema: IMAGE_INPUT_SCHEMA })
    await $.tool.register({ name: 'jobs', description: JOBS_DESCRIPTION, inputSchema: JOBS_INPUT_SCHEMA })
    await $.command.register({ name: 'chatgpt-ask', description: ASK_COMMAND_DESCRIPTION })
    await $.command.register({ name: 'chatgpt-image', description: IMAGE_COMMAND_DESCRIPTION })
    await $.command.register({ name: 'chatgpt-doctor', description: DOCTOR_COMMAND_DESCRIPTION })
    return next(e)
  })

  // Auto mode's classifier gives no verdict on a call no prompt asked for, so the plugin allows its own browser
  // calls that stay on chatgpt.com; every other call goes on to the session's rules.
  on('tool.check', async (_$, e, next) => {
    const own = next.origin.plugin === PLUGIN ? OWN_CALLS.find(({ prefix }) => e.tool.startsWith(prefix)) : undefined
    if (!own?.stays(e.tool.slice(own.prefix.length), e.input, tab.id)) return next(e)
    return { decision: 'allow' as const, reason: 'chatgpt plugin driving chatgpt.com in its own browser tab' }
  })

  on('tool.call', { tool: 'mcp__chatgpt__ask' }, ($, e) => serve('ask', e, handlers($)))

  on('tool.call', { tool: 'mcp__chatgpt__image' }, ($, e) => serve('image', e, handlers($)))

  on('tool.call', { tool: 'mcp__chatgpt__jobs' }, async () => ({ result: jobs.report() }))

  on('command.run', { command: 'chatgpt-ask' }, async ($, e) => {
    const prompt = e.args.trim()
    if (!prompt) return { text: 'Usage: /chatgpt-ask <question>' }
    const outcome = await handlers($).runNow({ kind: 'ask', input: { prompt }, filePaths: [] })
    return askCommandAnswer(outcome)
  })

  on('command.run', { command: 'chatgpt-image' }, async ($, e) => {
    const prompt = e.args.trim()
    if (!prompt) return { text: 'Usage: /chatgpt-image <prompt>' }
    const outcome = await handlers($).runNow({ kind: 'image', input: { prompt }, filePaths: [] })
    return imageCommandAnswer(outcome)
  })

  on('command.run', { command: 'chatgpt-doctor' }, async ($, e) => {
    const chatUrl = chatUrlOf(e.args)
    return queue(async () => {
      try {
        const picked = await pickBrowser($)
        if (typeof picked === 'string') return { text: `✗ browser: ${picked}` }
        $.ui.status('ChatGPT: checking the page')
        const checks = await diagnose(picked.browser, chatUrl, tab)
        return { text: report([{ name: 'browser', ok: true, detail: picked.name }, ...checks]) }
      } catch (error) {
        return { text: `✗ browser: ${errorText(error)}` }
      } finally {
        $.ui.status(undefined)
      }
    })
  })
}
