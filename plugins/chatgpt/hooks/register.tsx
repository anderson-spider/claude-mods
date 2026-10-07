import type { EngineInterface, Register } from 'claude-code'
import { diagnose, report } from './doctor'
import { performRequest, runNow as runForeground } from './execution'
import { limitMs } from './files'
import { createJobs } from './jobs'
import type { Outcome, ProcessRunner, Request, RequestDeps, TabHolder } from './model'
import { askCommandAnswer, errorText, imageCommandAnswer } from './presentation'
import { BOUNDARIES, COMMON_PROPERTIES, IMAGE_BOUNDARIES, PROMPT, WHERE } from './prompts'
import { taskQueue } from './queue'
import { chatUrlOf } from './requests'
import { browserOf } from './terminal-browser'
import { serve } from './tools'

// Requests take turns in the plugin's own tab, kept across them.
const queue = taskQueue()
const tab: TabHolder = {}
const jobs = createJobs()

// A foreground request waits this long; past it the work goes on in the background.
// The `foregroundMinutes` and `backgroundMinutes` settings, refreshed by each register.
let foregroundMs = limitMs(undefined, 6)
let backgroundMs = limitMs(undefined, 30)

function processOf($: EngineInterface): ProcessRunner {
  return (argv, init) => $.process.run(argv, init)
}

function requestDeps($: EngineInterface): RequestDeps {
  const run = processOf($)
  return {
    browser: () => browserOf(run),
    attachments: { stat: path => $.fs.stat(path) },
    output: {
      run,
      files: {
        write: (path, text) => $.fs.write(path, text),
        readBytes: path => $.fs.read(path, { as: 'bytes' }),
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
        const browser = await browserOf(processOf($))
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
