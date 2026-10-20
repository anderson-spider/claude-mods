import type { EngineInterface, Register } from 'claude-code'
import { diagnose, report } from './doctor'
import { performRequest, runNow as runForeground, createJobs, taskQueue } from './runner'
import { chatUrlOf } from './input'
import { limitMs } from './settings'
import type { Browser, Outcome, ProcessRunner, Request, RequestDeps, TabHolder } from './model'
import { askCommandAnswer, errorText, imageCommandAnswer } from './presentation'
import { PROMPT } from './prompts'
import { DOCTOR_COMMAND_DESCRIPTION, LOGIN_COMMAND_DESCRIPTION, TOOLS } from './tool-schemas'
import { type Candidate, chooseBrowser } from './chooser'
import { type Backend, backendsFor, ownCallAllowed } from './backends'
import { type McpCall, type McpHost, mcpCallOf } from './mcp-call'
import type { BrowserDeps } from './page-browser'
import { type PlaywrightHost, signIn } from './playwright-browser'
import { bytesOf } from './upload'
import { serve } from './tools'

// Requests take turns in the plugin's own tab, kept across them.
const queue = taskQueue()
const tab: TabHolder = {}
const jobs = createJobs()

// The backend the plugin's tab belongs to: a tab id means nothing in another backend. Each backend's own tab is kept
// while another holds the plugin's tab, so a request that moves on and back (see performRequest) reuses it.
let tabOwner: string | undefined
const tabsOf = new Map<string, string | undefined>()

// The defaults of the `foregroundMinutes` and `backgroundMinutes` settings, as plugin.json declares them.
const FOREGROUND_MINUTES = 6
const BACKGROUND_MINUTES = 30

// A foreground request waits this long; past it the work goes on in the background.
// The `foregroundMinutes` and `backgroundMinutes` settings, refreshed by each register.
let foregroundMs = limitMs(undefined, FOREGROUND_MINUTES)
let backgroundMs = limitMs(undefined, BACKGROUND_MINUTES)

// The `headlessChromium` setting: off leaves the plugin's own browser out, so only the ones the user logs in to are tried.
let headlessFirst = true

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

// The plugin's version, which the headless Chromium's helper must match; read from plugin.json once per load.
let pluginVersion: string | undefined

async function playwrightHostOf($: EngineInterface): Promise<PlaywrightHost> {
  pluginVersion ??= (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version: string }).version
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    run: processOf($),
    exists: path => $.fs.exists(path),
    home: await $.env.get('HOME'),
    root: $.plugin.root,
    version: pluginVersion,
  }
}

// The backends in this session's order (see backendsFor), without the headless Chromium when the setting is off.
async function backendsOf($: EngineInterface): Promise<Backend[]> {
  const backends = backendsFor(await $.env.get('CLAUDE_CODE_ENTRYPOINT'))
  return headlessFirst ? backends : backends.filter(backend => !('helper' in backend))
}

// The backends, each opened only when the chooser gets to it.
function candidatesOf($: EngineInterface, backends: Backend[]): Candidate[] {
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
  return backends.map(backend => {
    if ('server' in backend) return { name: backend.name, hint: backend.hint, open: () => backend.open(deps(backend.server)) }
    if ('helper' in backend) return { name: backend.name, hint: backend.hint, open: async () => backend.open(await playwrightHostOf($)) }
    return { name: backend.name, hint: backend.hint, open: () => backend.open(run) }
  })
}

// Picks the backend, leaving out the one `skip` names, and swaps in that backend's own tab when it differs from the
// one that holds the plugin's tab.
async function pickBrowser($: EngineInterface, skip?: string): Promise<{ browser: Browser; name: string } | string> {
  const chosen = await chooseBrowser(candidatesOf($, (await backendsOf($)).filter(({ name }) => name !== skip)))
  if (typeof chosen === 'string') return chosen
  if (tabOwner !== chosen.name) {
    if (tabOwner !== undefined) tabsOf.set(tabOwner, tab.id)
    tab.id = tabsOf.get(chosen.name)
    tabOwner = chosen.name
  }
  return chosen
}

function requestDeps($: EngineInterface): RequestDeps {
  const run = processOf($)
  return {
    browser: async skip => {
      const picked = await pickBrowser($, skip)
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
        return await performRequest(requestDeps($), request, { progress: status, tab, timeoutMs, backends: (await backendsOf($)).map(({ name }) => name) })
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
  headlessFirst = options?.headlessChromium !== false

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return { sections: [...composed.sections, { id: 'chatgpt:ask', text: PROMPT, scope: 'session' as const }] }
  })

  // The names stay literal in each call: the engine's scan reads them to classify the command hooks below.
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'ask', description: TOOLS.ask.description, inputSchema: TOOLS.ask.inputSchema })
    await $.tool.register({ name: 'image', description: TOOLS.image.description, inputSchema: TOOLS.image.inputSchema })
    await $.tool.register({ name: 'jobs', description: TOOLS.jobs.description, inputSchema: TOOLS.jobs.inputSchema })
    await $.command.register({ name: 'chatgpt-ask', description: TOOLS.ask.command.description })
    await $.command.register({ name: 'chatgpt-image', description: TOOLS.image.command.description })
    await $.command.register({ name: 'chatgpt-doctor', description: DOCTOR_COMMAND_DESCRIPTION })
    await $.command.register({ name: 'chatgpt-login', description: LOGIN_COMMAND_DESCRIPTION })
    return next(e)
  })

  // Auto mode's classifier gives no verdict on a call no prompt asked for, so the plugin allows its own browser
  // calls that stay on chatgpt.com; every other call goes on to the session's rules.
  on('tool.check', async (_$, e, next) => {
    if (!ownCallAllowed({ plugin: next.origin.plugin, tool: e.tool, input: e.input, tab })) return next(e)
    return { decision: 'allow' as const, reason: 'chatgpt plugin driving chatgpt.com in its own browser tab' }
  })

  on('tool.call', { tool: 'mcp__chatgpt__ask' }, ($, e) => serve(TOOLS.ask.kind, e, handlers($)))

  on('tool.call', { tool: 'mcp__chatgpt__image' }, ($, e) => serve(TOOLS.image.kind, e, handlers($)))

  on('tool.call', { tool: 'mcp__chatgpt__jobs' }, async () => ({ result: jobs.report() }))

  on('command.run', { command: 'chatgpt-ask' }, async ($, e) => {
    const request = TOOLS.ask.commandRequest(e.args)
    if (typeof request === 'string') return { text: request }
    const outcome = await handlers($).runNow(request)
    return askCommandAnswer(outcome)
  })

  on('command.run', { command: 'chatgpt-image' }, async ($, e) => {
    const request = TOOLS.image.commandRequest(e.args)
    if (typeof request === 'string') return { text: request }
    const outcome = await handlers($).runNow(request)
    return imageCommandAnswer(outcome)
  })

  // Signing in stops the helper, so it waits for the requests queued before it, and the plugin's tab starts afresh.
  on('command.run', { command: 'chatgpt-login' }, async $ =>
    queue(async () => {
      $.ui.status('ChatGPT: preparing the headless Chromium (the first run downloads it)')
      try {
        tab.id = undefined
        return { text: await signIn(await playwrightHostOf($)) }
      } finally {
        $.ui.status(undefined)
      }
    }),
  )

  on('command.run', { command: 'chatgpt-doctor' }, async ($, e) => {
    const chatUrl = chatUrlOf(e.args)
    return queue(async () => {
      let backend: string | undefined
      try {
        const picked = await pickBrowser($)
        if (typeof picked === 'string') return { text: `✗ browser: ${picked}` }
        backend = picked.name
        $.ui.status('ChatGPT: checking the page')
        const checks = await diagnose(picked.browser, chatUrl, tab)
        return { text: report([{ name: 'browser', ok: true, detail: picked.name }, ...checks]) }
      } catch (error) {
        return { text: backend ? `✗ browser: ${backend} failed: ${errorText(error)}` : `✗ browser: ${errorText(error)}` }
      } finally {
        $.ui.status(undefined)
      }
    })
  })
}
