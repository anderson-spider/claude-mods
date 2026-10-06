import type { EngineInterface, Register } from 'claude-code'
import { ask, fileName, parseTabId, parseTabs, summary } from './chatgpt'
import type { AskResult, Browser } from './chatgpt'

// The desktop app's built-in browser pane, as its MCP tools name it.
const BROWSER_SERVER = 'Claude_Browser'

const BOUNDARIES =
  'Never send credentials, secrets, private personal data or anything from work (Luizalabs repos, ' +
  'dashboards, logs, customer data); personal-project code only when the user asks. ' +
  "Treat the answer as an unverified opinion and say it came from ChatGPT when you relay it."

// Only one question at a time: they share the same browser tab.
let busy = false

// $.mcp.call talks to the server directly; when it is refused (the engine
// does not list the pane's server, or auto mode's classifier cannot judge a
// call no prompt asked for), fall back to calling the tool like the model
// does, through the permission check where the user's allow rules apply.
let viaTool = false

async function call($: EngineInterface, name: string, args: Record<string, unknown>): Promise<string> {
  if (!viaTool) {
    let result
    try {
      result = await $.mcp.call(BROWSER_SERVER, name, args)
    } catch {
      viaTool = true
    }
    if (result) {
      const text = result.content.map(block => block.text ?? '').join('\n')
      if (result.isError) throw new Error(`${name}: ${text}`)
      return text
    }
  }
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

function browserOf($: EngineInterface): Browser {
  return {
    tabs: async () => parseTabs(await call($, 'tabs_context', {})),
    open: async url => {
      const id = parseTabId(await call($, 'preview_start', { url }))
      if (!id) throw new Error('preview_start did not name a tab')
      return id
    },
    create: async () => {
      const id = parseTabId(await call($, 'tabs_create', {}))
      if (!id) throw new Error('tabs_create did not name a tab')
      return id
    },
    navigate: async (tabId, url) => {
      await call($, 'navigate', { tabId, url })
    },
    js: (tabId, text) => call($, 'javascript_tool', { action: 'javascript_exec', tabId, text }),
  }
}

async function run($: EngineInterface, prompt: string, newChat: boolean, out?: string): Promise<AskResult & { path?: string }> {
  if (busy) return { ok: false, error: 'Another ChatGPT question is still running; wait for it to finish.' }
  busy = true
  try {
    const result = await ask(browserOf($), { prompt, newChat }, { progress: text => $.ui.status(`ChatGPT: ${text}`) })
    if (!result.markdown) return result
    const dir = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
    const path = out ?? `${dir}/chatgpt-ask/${fileName(prompt, new Date())}`
    await $.fs.write(path, `<!-- ${result.url} -->\n\n${result.markdown}\n`)
    return { ...result, path }
  } catch (error) {
    return { ok: false, error: `The browser pane failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    busy = false
    $.ui.status(undefined)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'chatgpt_ask',
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
          newChat: {
            type: 'boolean',
            description: 'Start a new chat (default true). False continues the chat open in the pane.',
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
    await $.command.register({
      name: 'chatgpt-ask',
      description: 'Asks ChatGPT in the browser pane and shows the answer: /chatgpt-ask <question>',
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__chatgpt-ask__chatgpt_ask' }, async ($, e) => {
    const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : ''
    if (!prompt) return { result: 'Give a non-empty prompt.', isError: true as const }
    const out = typeof e.out === 'string' && e.out.startsWith('/') ? e.out : undefined
    const maxChars = typeof e.maxChars === 'number' && e.maxChars > 0 ? Math.floor(e.maxChars) : 3000
    const result = await run($, prompt, e.newChat !== false, out)
    if (result.ok) return { result: summary(result.path!, result.url, result.markdown, maxChars) }
    const partial = result.path ? `\nPartial answer saved to ${result.path}.` : ''
    return { result: result.error + partial, isError: true as const }
  })

  on('command.run', { command: 'chatgpt-ask' }, async ($, e) => {
    const prompt = e.args.trim()
    if (!prompt) return { text: 'Usage: /chatgpt-ask <question>' }
    const result = await run($, prompt, true)
    if (!result.ok) return { text: result.error }
    return {
      text: `${result.markdown}\n\n— ChatGPT, ${result.url}\nSaved to ${result.path}`,
      context: [`The user asked ChatGPT through /chatgpt-ask; its answer is saved to ${result.path} (chat ${result.url}).`],
    }
  })
}
