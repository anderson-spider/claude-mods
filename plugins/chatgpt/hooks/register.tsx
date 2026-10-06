import type { EngineInterface, Register } from 'claude-code'
import { ask, extensionOf, fallbackRouter, fileName, generateImage, isChatUrl, parseTabId, parseTabs, staysOnChatgpt, summary, typeOf } from './chatgpt'
import type { AskResult, Browser, Clipboard, ImageResult, Reference } from './chatgpt'

const PLUGIN = 'chatgpt'

// The desktop app's built-in browser pane, as its MCP tools name it.
const BROWSER_SERVER = 'Claude_Browser'

const BOUNDARIES =
  'Never send credentials, secrets, private personal data or anything from work (Luizalabs repos, ' +
  'dashboards, logs, customer data); personal-project code only when the user asks. ' +
  "Treat the answer as an unverified opinion and say it came from ChatGPT when you relay it."

const IMAGE_BOUNDARIES =
  "Only when the user asks for an image in this conversation: it spends their ChatGPT image quota. Never upload " +
  'licensed assets, credentials, private personal data or work data; a reference is only an image the user asked ' +
  'to use or one you produced for the task. The result is an AI concept image: label it as such wherever it is ' +
  'stored, and never present it as evidence of a real or in-game state.'

const CHAT_URL_HELP =
  'Optional. The chat URL a previous ask or image call returned, to continue that chat on the same ' +
  'subject; left out, a new chat starts.'

// Only one question at a time: they share the same browser tab.
let busy = false

// $.mcp.call talks to the server directly; once it is refused (the engine
// does not list the pane's server, or auto mode's classifier cannot judge a
// call no prompt asked for), calls go to the tool like the model's do,
// through the permission check where the user's allow rules apply. Only a
// refusal falls back: any other failure may come after the tool ran.
const route = fallbackRouter()

async function call($: EngineInterface, name: string, args: Record<string, unknown>): Promise<string> {
  return route(
    () => callDirect($, name, args),
    () => callViaTool($, name, args),
  )
}

async function callDirect($: EngineInterface, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await $.mcp.call(BROWSER_SERVER, name, args)
  const text = result.content.map(block => block.text ?? '').join('\n')
  if (result.isError) throw new Error(`${name}: ${text}`)
  return text
}

async function callViaTool($: EngineInterface, name: string, args: Record<string, unknown>): Promise<string> {
  const answer = await $.tool.call({ tool: `mcp__${BROWSER_SERVER}__${name}`, ...args })
  if ('deny' in answer && answer.deny) {
    // Say what the engine's permission decision was, so a missing allow
    // rule and a classifier refusal read differently.
    const check = await $.tool.check({ tool: `mcp__${BROWSER_SERVER}__${name}`, input: args }).catch(() => undefined)
    const verdict = check ? ` [permission check: ${check.decision}${check.rule ? `, rule ${check.rule}` : ''}${check.reason ? `, ${check.reason}` : ''}]` : ''
    throw new Error(`${name}: ${answer.deny}${verdict}`)
  }
  if (answer.isError) throw new Error(`${name}: ${answer.text}`)
  return answer.text ?? ''
}

// The tabs this plugin opened or sent to chatgpt.com: the only ones its
// `tool.check` hook lets a script run in.
const chatTabs = new Set<string>()

function browserOf($: EngineInterface): Browser {
  return {
    tabs: async () => parseTabs(await call($, 'tabs_context', {})),
    open: async url => {
      const id = parseTabId(await call($, 'preview_start', { url }))
      if (!id) throw new Error('preview_start did not name a tab')
      chatTabs.add(id)
      return id
    },
    create: async () => {
      const id = parseTabId(await call($, 'tabs_create', {}))
      if (!id) throw new Error('tabs_create did not name a tab')
      return id
    },
    navigate: async (tabId, url) => {
      await call($, 'navigate', { tabId, url })
      chatTabs.add(tabId)
    },
    js: (tabId, text) => call($, 'javascript_tool', { action: 'javascript_exec', tabId, text }),
  }
}

async function outDir($: EngineInterface): Promise<string> {
  return `${((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')}/chatgpt`
}

async function run($: EngineInterface, prompt: string, chatUrl?: string, out?: string): Promise<AskResult & { path?: string }> {
  if (busy) return { ok: false, error: 'Another ChatGPT question is still running; wait for it to finish.' }
  busy = true
  try {
    const result = await ask(browserOf($), { prompt, chatUrl }, { progress: text => $.ui.status(`ChatGPT: ${text}`) })
    if (!result.markdown) return result
    const path = out ?? `${await outDir($)}/${fileName(prompt, new Date())}`
    await $.fs.write(path, `<!-- ${result.url} -->\n\n${result.markdown}\n`)
    return { ...result, path }
  } catch (error) {
    return { ok: false, error: `The browser pane failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    busy = false
    $.ui.status(undefined)
  }
}

// Reads a local reference image for the upload; `$.fs.read` caps it at 4 MiB.
async function readReference($: EngineInterface, path: string): Promise<Reference | string> {
  const type = typeOf(path)
  if (!path.startsWith('/')) return 'The reference must be an absolute path.'
  if (!type) return 'The reference must be a PNG, JPEG, WebP or GIF image.'
  try {
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    return { name: path.split('/').pop() ?? 'reference', type, base64 }
  } catch (error) {
    return `Could not read the reference (${error instanceof Error ? error.message : String(error)}); it must exist and be at most 4 MiB.`
  }
}

// The macOS clipboard: the PNG a page copied comes out through osascript into a
// temporary file, read back as bytes. Only text the user had copied is kept;
// anything else on the clipboard is replaced by the image.
function clipboardOf($: EngineInterface): Clipboard {
  let saved = ''
  return {
    save: async () => {
      const pasted = await $.process.run(['pbpaste']).catch(() => undefined)
      saved = pasted?.exitCode === 0 ? pasted.stdout : ''
    },
    readImage: async () => {
      const path = `${await outDir($)}/.clipboard-${Date.now()}.png`
      await $.process.run(['mkdir', '-p', path.slice(0, path.lastIndexOf('/'))])
      const script = [
        'on run argv',
        'set f to POSIX file (item 1 of argv)',
        'set d to the clipboard as «class PNGf»',
        'set h to open for access f with write permission',
        'set eof h to 0',
        'write d to h',
        'close access h',
        'end run',
      ].flatMap(line => ['-e', line])
      try {
        const done = await $.process.run(['osascript', ...script, path], { timeoutMs: 30_000 })
        if (done.exitCode !== 0) return undefined
        return (await $.fs.read(path, { as: 'bytes' })).base64
      } catch {
        return undefined
      } finally {
        await $.process.run(['rm', '-f', path]).catch(() => undefined)
      }
    },
    restore: async () => {
      if (saved) await $.process.run(['pbcopy'], { stdin: saved }).catch(() => undefined)
    },
  }
}

// $.fs.write takes text only, so the bytes go through openssl's base64 decoder.
async function writeImage($: EngineInterface, path: string, base64: string): Promise<string | undefined> {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/'
  await $.process.run(['mkdir', '-p', dir])
  const done = await $.process.run(['openssl', 'base64', '-d', '-A', '-out', path], { stdin: base64, timeoutMs: 60_000 })
  return done.exitCode === 0 ? undefined : `Could not write ${path}: ${done.stderr.trim()}`
}

async function runImage(
  $: EngineInterface,
  prompt: string,
  options: { chatUrl?: string; reference?: string; out?: string; saveOnly?: boolean },
): Promise<ImageResult & { path?: string }> {
  if (busy) return { ok: false, error: 'Another ChatGPT request is still running; wait for it to finish.' }
  busy = true
  try {
    const reference = options.reference === undefined ? undefined : await readReference($, options.reference)
    if (typeof reference === 'string') return { ok: false, error: reference }
    const result = await generateImage(
      browserOf($),
      { prompt, chatUrl: options.chatUrl, reference, saveOnly: options.saveOnly },
      { progress: text => $.ui.status(`ChatGPT: ${text}`), clipboard: clipboardOf($) },
    )
    if (!result.ok) return result
    const path = options.out ?? `${await outDir($)}/${fileName(prompt, new Date(), extensionOf(result.type))}`
    const failed = await writeImage($, path, result.base64)
    return failed ? { ok: false, url: result.url, error: failed } : { ...result, path }
  } catch (error) {
    return { ok: false, error: `The browser pane failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    busy = false
    $.ui.status(undefined)
  }
}

function imageSummary(result: ImageResult & { ok: true }, path: string): string {
  return [
    `AI concept image generated by ChatGPT, saved to ${path} (${result.width}x${result.height}, ${result.type}).`,
    `Chat: ${result.url}`,
    'Look at the file before describing it, and ask before storing it in a repository; label it as an AI concept.',
  ].join('\n')
}

const chatUrlOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'ask',
      description:
        "Sends a self-contained question to the user's logged-in ChatGPT (chatgpt.com in Claude Code's built-in " +
        'browser pane), waits for the answer, saves it as Markdown and returns the file path, the chat URL and ' +
        'the start of the answer. Use when the user asks to ask ChatGPT, or for a self-contained question with a ' +
        "long answer (research, explanation, brainstorm, draft text, translation, second opinion) after telling " +
        'the user; not for work that needs the repository (the context would have to be sent and read back). ' +
        'Write the prompt with the goal, the minimum context, the output format and the language. ' +
        BOUNDARIES,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The whole question, self-contained.' },
          chatUrl: { type: 'string', description: CHAT_URL_HELP },
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
        "Generates or edits an image with the user's logged-in ChatGPT (chatgpt.com in Claude Code's built-in " +
        'browser pane), optionally from a local reference image, waits for it and saves it locally; returns the ' +
        'file path, its size and the chat URL. Write the prompt in the user\'s language with what to keep from the ' +
        'reference (shape, proportions), the scene, lighting, materials, camera and exclusions (no people, no text, ' +
        'no copies of existing games or brands). When ChatGPT answers with text instead (a refusal or a question), ' +
        'the tool returns that text: relay it, do not rephrase around a refusal. ' +
        IMAGE_BOUNDARIES,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to generate or change, self-contained.' },
          reference: {
            type: 'string',
            description: 'Optional absolute path of a PNG, JPEG, WebP or GIF image (at most 4 MiB) to attach.',
          },
          chatUrl: { type: 'string', description: CHAT_URL_HELP },
          out: { type: 'string', description: 'Optional absolute path for the image file.' },
          saveOnly: {
            type: 'boolean',
            description:
              'Optional. Only save the last image already generated in chatUrl, sending nothing and spending no quota ' +
              '(e.g. after a timeout said it may still be generating); prompt only names the file.',
          },
        },
        required: ['prompt'],
      },
    })
    await $.command.register({
      name: 'chatgpt-ask',
      description: 'Asks ChatGPT in the browser pane and shows the answer: /chatgpt-ask <question>',
    })
    await $.command.register({
      name: 'chatgpt-image',
      description: 'Generates an image with ChatGPT in the browser pane and saves it: /chatgpt-image <prompt>',
    })
    return next(e)
  })

  // Auto mode's classifier gives no verdict on the pane calls this plugin makes
  // (no prompt asked for each one), and the pane's tools ask on their own: allow
  // this plugin's calls that stay on chatgpt.com. The model's own calls, and
  // anything else, keep the engine's decision.
  on('tool.check', async (_$, e, next) => {
    const prefix = `mcp__${BROWSER_SERVER}__`
    if (next.origin.plugin !== PLUGIN || !e.tool.startsWith(prefix)) return next(e)
    if (!staysOnChatgpt(e.tool.slice(prefix.length), e.input, chatTabs)) return next(e)
    return { decision: 'allow' as const, reason: 'chatgpt plugin driving chatgpt.com in the browser pane' }
  })

  on('tool.call', { tool: 'mcp__chatgpt__ask' }, async ($, e) => {
    const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : ''
    if (!prompt) return { result: 'Give a non-empty prompt.', isError: true as const }
    const out = typeof e.out === 'string' && e.out.startsWith('/') ? e.out : undefined
    const maxChars = typeof e.maxChars === 'number' && e.maxChars > 0 ? Math.floor(e.maxChars) : 3000
    const chatUrl = chatUrlOf(e.chatUrl)
    if (chatUrl !== undefined && !isChatUrl(chatUrl)) {
      return { result: `chatUrl must be a chat link like https://chatgpt.com/c/<id>, not ${chatUrl}.`, isError: true as const }
    }
    const result = await run($, prompt, chatUrl, out)
    if (result.ok) return { result: summary(result.path!, result.url, result.markdown, maxChars) }
    const partial = result.path ? `\nPartial answer saved to ${result.path}.` : ''
    return { result: result.error + partial, isError: true as const }
  })

  on('command.run', { command: 'chatgpt-ask' }, async ($, e) => {
    const prompt = e.args.trim()
    if (!prompt) return { text: 'Usage: /chatgpt-ask <question>' }
    const result = await run($, prompt)
    if (!result.ok) return { text: result.error }
    return {
      text: `${result.markdown}\n\n— ChatGPT, ${result.url}\nSaved to ${result.path}`,
      context: [`The user asked ChatGPT through /chatgpt-ask; its answer is saved to ${result.path} (chat ${result.url}).`],
    }
  })

  on('tool.call', { tool: 'mcp__chatgpt__image' }, async ($, e) => {
    const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : ''
    if (!prompt) return { result: 'Give a non-empty prompt.', isError: true as const }
    const out = typeof e.out === 'string' && e.out.startsWith('/') ? e.out : undefined
    const reference = typeof e.reference === 'string' && e.reference.trim() ? e.reference.trim() : undefined
    const chatUrl = chatUrlOf(e.chatUrl)
    if (chatUrl !== undefined && !isChatUrl(chatUrl)) {
      return { result: `chatUrl must be a chat link like https://chatgpt.com/c/<id>, not ${chatUrl}.`, isError: true as const }
    }
    const saveOnly = e.saveOnly === true
    const result = await runImage($, prompt, { chatUrl, reference, out, saveOnly })
    if (result.ok) return { result: imageSummary(result, result.path!) }
    const said = result.markdown ? `\n\nChatGPT said:\n${result.markdown}` : ''
    return { result: result.error + said, isError: true as const }
  })

  on('command.run', { command: 'chatgpt-image' }, async ($, e) => {
    const prompt = e.args.trim()
    if (!prompt) return { text: 'Usage: /chatgpt-image <prompt>' }
    const result = await runImage($, prompt, {})
    if (!result.ok) return { text: result.markdown ? `${result.error}\n\n${result.markdown}` : result.error }
    return {
      text: `Saved to ${result.path} (${result.width}x${result.height})\n— ChatGPT, ${result.url}`,
      context: [`The user generated an AI concept image with /chatgpt-image; it is saved to ${result.path} (chat ${result.url}).`],
    }
  })
}
