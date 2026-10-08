import type { Attachment, Browser } from './model'
import { ORIGIN } from './browser'

/** Calls one of a browser's MCP tools and returns its text; throws when the tool reports an error. */
export type McpCall = (tool: string, args: Record<string, unknown>) => Promise<string>

export type BrowserDeps = {
  call: McpCall
  readBytes(path: string): Promise<Uint8Array>
  /** Waits `ms` (a host process call, so the hook's clock budget is not spent meanwhile). */
  sleep(ms: number): Promise<void>
  /** The wall clock, in ms. */
  now(): number
}

// How often waitFor looks again inside a page.
const STEP_MS = 250

/** What the host's `$.mcp.call` answers: the MCP result's content blocks and whether the tool failed. */
export type McpResult = { content?: unknown; isError?: boolean }

/** The two host calls a backend can make: `$.mcp.call` by server name, and `$.tool.call` by the tool's `mcp__` name. */
export type McpHost = {
  mcp(server: string, tool: string, args: Record<string, unknown>): Promise<McpResult>
  tool(input: Record<string, unknown>): Promise<{ deny?: string; text?: string; isError?: boolean }>
}

// A rejection of `$.mcp.call` that says the server cannot be reached that way. A tool's own error is an `isError` result, never one of these.
export const UNREACHABLE = /unknown server|no such server|not connected|not configured|not found/i

const textOf = (content: unknown) =>
  (Array.isArray(content) ? (content as { type?: string; text?: string }[]) : [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')

/**
 * Calls a tool of an MCP server the way the host allows. The first call decides the route once: `$.mcp.call`
 * when it answers, or `$.tool.call` (a permission prompt may follow) when it rejects as unreachable. A tool
 * error (`isError`) is thrown to the caller at once and never retried, since the tool may already have acted.
 */
export function mcpCallOf(host: McpHost, server: string): McpCall {
  let route: 'mcp' | 'tool' | undefined
  const viaTool = async (tool: string, args: Record<string, unknown>) => {
    const done = await host.tool({ tool: `mcp__${server}__${tool}`, ...args })
    if (done.deny) throw new Error(done.deny)
    if (done.isError) throw new Error(done.text || `${tool} failed`)
    return done.text ?? ''
  }
  return async (tool, args) => {
    if (route === 'tool') return viaTool(tool, args)
    let result: McpResult
    try {
      result = await host.mcp(server, tool, args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (route !== undefined || !UNREACHABLE.test(message)) throw error
      route = 'tool'
      return viaTool(tool, args)
    }
    route = 'mcp'
    const text = textOf(result.content)
    if (result.isError) throw new Error(text || `${tool} failed`)
    return text
  }
}

/** The first JSON object in a tool's text: the tools print one, then a note about the tabs. */
export function leadingJson<T>(text: string): T | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let quoted = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as T
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/**
 * What a page script printed, as a string. The tool cuts the result off at the
 * notes it adds after it (`Tab Context:`, `(captured at …)`), and a tool may
 * print a string result as a JSON literal, which is decoded here.
 */
export function scriptText(text: string): string {
  const cut = text.search(/\n\n(?:Tab Context:|\(captured at )/)
  const body = (cut < 0 ? text : text.slice(0, cut)).trim()
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'string') return parsed
  } catch {
    // Not a JSON literal: the text is the result.
  }
  return body
}

export function bytesOf(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0))
}

// Encodes in slices, so a large file never becomes one huge argument list.
export function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

// The page script that puts the files on the first input `selector` names, and prints `{ uploaded }`.
// It runs only on chatgpt.com, so the files never reach another page.
export function uploadBody(selector: string, files: { name: string; type: string; base64: string }[]): string {
  return `
if (location.origin !== ${JSON.stringify(ORIGIN)}) return JSON.stringify({ uploaded: false, reason: 'not on chatgpt.com' });
const bytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const transfer = new DataTransfer();
for (const f of ${JSON.stringify(files)}) transfer.items.add(new File([bytes(f.base64)], f.name, { type: f.type }));
const input = document.querySelector(${JSON.stringify(selector)});
if (!input) return JSON.stringify({ uploaded: false, reason: 'no input matched ' + ${JSON.stringify(selector)} });
input.files = transfer.files;
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));
return JSON.stringify({ uploaded: true });`
}

/**
 * Sets the local files on the input `selector` names, through a page script (the MCP file upload needs an element
 * ref). Each file keeps the name and MIME type the attachment check read.
 */
export async function uploadFiles(
  run: (body: string) => Promise<string>,
  readBytes: (path: string) => Promise<Uint8Array>,
  selector: string,
  files: Attachment[],
): Promise<void> {
  const payload = await Promise.all(files.map(async file => ({ name: file.name, type: file.type, base64: base64Of(await readBytes(file.path)) })))
  const done = JSON.parse(await run(uploadBody(selector, payload))) as { uploaded?: boolean; reason?: string }
  if (!done.uploaded) throw new Error(`could not attach ${files.map(f => f.name).join(', ')}: ${done.reason ?? 'no reason given'}`)
}

// Polls `check` until it is true or `timeoutMs` of wall-clock time (by `now`) has passed. The time a check takes
// counts too, so slow checks cannot stretch the timeout; a check that throws (a navigation may destroy the page) counts as not yet.
export async function pollUntil(
  check: () => Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
  now: () => number,
): Promise<boolean> {
  const started = now()
  for (;;) {
    if (await check().catch(() => false)) return true
    if (now() - started >= timeoutMs) return false
    await sleep(STEP_MS)
  }
}

/** What a backend must say: its tabs, how it opens one, and how it runs a function body in a tab. */
export type Page = {
  tabs(): Promise<string[]>
  openTab(url: string): Promise<string>
  /** Runs `expression` (an async IIFE) in the tab and returns its text, as `scriptText` reads it. */
  evaluate(tabId: string, expression: string): Promise<string>
}

/** The Browser the flows use, built on a backend's `Page`. */
export function pageBrowser(page: Page, deps: Pick<BrowserDeps, 'readBytes' | 'sleep' | 'now'>): Browser {
  const run = (tabId: string, body: string) => page.evaluate(tabId, `(async () => {\n${body}\n})()`)
  return {
    tabs: () => page.tabs(),
    openTab: url => page.openTab(url),
    waitFor: (tabId, fn, timeoutMs) =>
      pollUntil(async () => (await run(tabId, `return JSON.stringify(Boolean(${fn}))`)) === 'true', deps.sleep, timeoutMs, deps.now),
    js: async (tabId, body) => JSON.stringify(await run(tabId, body)),
    upload: (tabId, selector, files) => uploadFiles(body => run(tabId, body), deps.readBytes, selector, files),
  }
}
