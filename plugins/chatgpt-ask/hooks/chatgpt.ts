// Drives the user's logged-in ChatGPT in Claude Code's built-in browser pane.
// Pure: everything that touches the pane goes through the injected `Browser`.

export const CHATGPT_URL = 'https://chatgpt.com/'
const ORIGIN = 'https://chatgpt.com'

export type BrowserTab = { tabId: string; origin: string; isActive: boolean }

export type Browser = {
  /** The pane's tabs; `browserOpen` false while the pane is closed. */
  tabs(): Promise<{ browserOpen: boolean; tabs: BrowserTab[] }>
  /** Opens the pane at `url` and returns its tab id. */
  open(url: string): Promise<string>
  /** Opens a blank tab and returns its id. */
  create(): Promise<string>
  navigate(tabId: string, url: string): Promise<void>
  /** Runs `code` in the tab and returns the tool's raw text output. */
  js(tabId: string, code: string): Promise<string>
}

export type AskInput = { prompt: string; chatUrl?: string }

export type AskResult =
  | { ok: true; url: string; markdown: string }
  | { ok: false; error: string; url?: string; markdown?: string }

export type AskOptions = {
  /** How long to wait for the answer, in ms. */
  timeoutMs?: number
  /** How long each poll waits inside the page, in ms. */
  pollMs?: number
  /** Called with a short status while waiting. */
  progress?: (text: string) => void
}

type PageState = {
  href: string
  composer: boolean
  login: boolean
  stop: boolean
  count: number
  length: number
}

// Every page script returns JSON.stringify(...): the tool prints a string
// result as a JSON literal, followed by notes about the tab.
export function parseOutput<T>(text: string): T {
  const match = /^\s*("(?:[^"\\]|\\.)*")/.exec(text)
  if (!match) throw new Error(`unexpected browser output: ${text.slice(0, 200)}`)
  return JSON.parse(JSON.parse(match[1]!)) as T
}

// tabs_context prints a JSON object followed by a line about the pane.
export function parseTabs(text: string): { browserOpen: boolean; tabs: BrowserTab[] } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return { browserOpen: false, tabs: [] }
  const parsed = JSON.parse(text.slice(start, end + 1)) as { browserOpen?: boolean; tabs?: BrowserTab[] }
  return { browserOpen: parsed.browserOpen === true, tabs: parsed.tabs ?? [] }
}

// How the engine words a `$.mcp.call` it refused before the tool ran
// (`<plugin>: $.mcp.call(<server>, <tool>) refused: <reason>`).
const REFUSED = /\$\.mcp\.call\([^)]*\) refused\b/

/** Whether `$.mcp.call` was refused, so the tool never ran. */
export function isRefusal(error: unknown): boolean {
  return REFUSED.test(error instanceof Error ? error.message : String(error))
}

/**
 * Runs each call `direct` until one is refused, then `fallback` from then on.
 * Any other failure is thrown as is: it may come after the tool ran (a prompt
 * already sent), so the call is never repeated.
 */
export function fallbackRouter(): <T>(direct: () => Promise<T>, fallback: () => Promise<T>) => Promise<T> {
  let refused = false
  return async (direct, fallback) => {
    if (!refused) {
      try {
        return await direct()
      } catch (error) {
        if (!isRefusal(error)) throw error
        refused = true
      }
    }
    return fallback()
  }
}

/**
 * Whether the plugin's own call to the pane's `tool` stays on chatgpt.com, so
 * its `tool.check` hook may allow it: auto mode's classifier gives no verdict
 * on a call no prompt asked for. `chatTabs` are the tabs the plugin opened or
 * sent to chatgpt.com; a script runs only there.
 */
export function staysOnChatgpt(tool: string, input: unknown, chatTabs: ReadonlySet<string>): boolean {
  const args = (input ?? {}) as Record<string, unknown>
  const onChatgpt = (url: unknown) => typeof url === 'string' && (url === CHATGPT_URL || isChatUrl(url))
  switch (tool) {
    case 'tabs_context':
    case 'tabs_create':
      return true
    case 'preview_start':
    case 'navigate':
      return onChatgpt(args.url)
    case 'javascript_tool':
      return args.action === 'javascript_exec' && typeof args.tabId === 'string' && chatTabs.has(args.tabId)
    default:
      return false
  }
}

export function parseTabId(text: string): string | undefined {
  return /"?tabId"?\s*[:=]\s*"?([\w-]+)/.exec(text)?.[1]
}

const STOP_LABELS = /^(Parar|Stop)/i
const SEND_SELECTOR =
  '[data-testid=send-button], #composer-submit-button, button[aria-label=Enviar], button[aria-label=Send], button[aria-label="Send prompt"], button[aria-label="Enviar prompt"]'

export function stateScript(waitMs: number): string {
  return `
await new Promise(r => setTimeout(r, ${Math.max(0, Math.floor(waitMs))}));
const answers = [...document.querySelectorAll('[data-markdown-text-style]')];
JSON.stringify({
  href: location.href,
  composer: !!document.querySelector('.ProseMirror[contenteditable=true], #prompt-textarea'),
  login: !!document.querySelector('[data-testid=login-button]') || /\\/auth\\/|\\/log-?in/.test(location.pathname),
  stop: !!document.querySelector('[data-testid=stop-button]') ||
    [...document.querySelectorAll('button')].some(b => ${STOP_LABELS}.test(b.getAttribute('aria-label') || '')),
  count: answers.length,
  length: (answers.pop()?.innerText || '').length,
})`
}

export function sendScript(prompt: string): string {
  return `
const ed = document.querySelector('.ProseMirror[contenteditable=true], #prompt-textarea');
if (!ed) JSON.stringify({ sent: false, reason: 'composer not found' }); else {
  const text = ${JSON.stringify(prompt)};
  ed.focus();
  if (ed.innerText.trim()) {
    const range = document.createRange();
    range.selectNodeContents(ed);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.execCommand('delete');
  }
  // A paste keeps line breaks without pressing Enter; a page still settling
  // may drop the first one, so try again, then fall back to typing.
  for (let i = 0; i < 3 && !ed.innerText.trim(); i++) {
    ed.focus();
    const data = new DataTransfer();
    data.setData('text/plain', text);
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 400 + 600 * i));
  }
  if (!ed.innerText.trim()) document.execCommand('insertText', false, text.replace(/\\n+/g, ' '));
  await new Promise(r => setTimeout(r, 300));
  let button = null;
  for (let i = 0; i < 20 && !button; i++) {
    button = [...document.querySelectorAll(${JSON.stringify(SEND_SELECTOR)})].find(b => !b.disabled) || null;
    if (!button) await new Promise(r => setTimeout(r, 250));
  }
  if (button) button.click();
  JSON.stringify(button ? { sent: true } : { sent: false, reason: 'send button not found' });
}`
}

// Turns the last answer's DOM back into Markdown: headings, lists, code
// blocks with their language, tables, quotes, links, inline marks and math.
export const READ_SCRIPT = `
const inline = node => [...node.childNodes].map(md).join('');
const fence = text => { const runs = text.match(/\`+/g) || []; return '\`'.repeat(Math.max(3, ...runs.map(r => r.length + 1))); };
const tick = text => { const runs = text.match(/\`+/g) || []; const t = '\`'.repeat(Math.max(1, ...runs.map(r => r.length + 1))); return t.length > 1 ? t + ' ' + text + ' ' + t : t + text + t; };
const fenced = (code, language) => { code = code.replace(/\\n$/, ''); const f = fence(code); return f + language + '\\n' + code + '\\n' + f + '\\n\\n'; };
// The current UI draws a code block as an editor with one div per line.
// Its header names the language when the editor does not.
const codeBlock = el => {
  const label = el.querySelector('[data-markdown-copy=exclude]')?.innerText?.trim().split('\\n')[0] || '';
  const named = /^[\\w+#.-]{1,20}$/.test(label) ? label.toLowerCase() : '';
  const editor = el.querySelector('[data-language]');
  if (!editor) return fenced((el.querySelector('code') || el).textContent, named);
  const lines = [...editor.children].every(c => c.tagName === 'DIV') ? [...editor.children].map(c => c.textContent) : [editor.textContent];
  return fenced(lines.join('\\n'), editor.dataset.language || named);
};
const lang = pre => {
  const code = pre.querySelector('code');
  const cls = [...(code?.classList || [])].find(c => c.startsWith('language-'));
  if (cls) return cls.slice(9);
  const label = pre.querySelector('div')?.innerText?.trim().split('\\n')[0] || '';
  return /^[\\w+#.-]{1,20}$/.test(label) ? label.toLowerCase() : '';
};
const list = (el, depth) => [...el.children].filter(li => li.tagName === 'LI').map((li, i) => {
  const mark = el.tagName === 'OL' ? (Number(el.getAttribute('start') || 1) + i) + '. ' : '- ';
  const pad = '  '.repeat(depth);
  // Inline children run together; a block child (a paragraph) starts after a space.
  let text = '';
  for (const c of li.childNodes) {
    if (c.tagName === 'UL' || c.tagName === 'OL') text = text.trimEnd() + '\\n' + list(c, depth + 1);
    else if (/^(P|DIV|PRE|TABLE|BLOCKQUOTE|H[1-6])$/.test(c.tagName || '')) text += (text.trim() ? ' ' : '') + block(c).trim();
    else text += md(c);
  }
  return pad + mark + text.trim();
}).join('\\n');
const table = el => {
  const rows = [...el.querySelectorAll('tr')].map(tr => [...tr.children].map(td => inline(td).replace(/\\|/g, '\\\\|').replace(/\\n/g, ' ').trim()));
  if (!rows.length) return '';
  const head = rows[0];
  const line = r => '| ' + r.join(' | ') + ' |';
  return [line(head), line(head.map(() => '---')), ...rows.slice(1).map(line)].join('\\n');
};
const math = el => {
  const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent || el.innerText;
  return el.classList.contains('katex-display') ? '\\n$$\\n' + tex + '\\n$$\\n' : '$' + tex + '$';
};
function md(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return '';
  const el = node, tag = el.tagName, copy = el.dataset?.markdownCopy;
  if (copy === 'exclude' || el.hidden || el.getAttribute('aria-hidden') === 'true' || tag === 'BUTTON' || tag === 'svg') return '';
  if (el.classList.contains('katex-display') || el.classList.contains('katex')) return math(el);
  if (copy === 'inline-code') return tick(el.textContent);
  if (copy === 'code-block') return codeBlock(el);
  switch (tag) {
    case 'STRONG': case 'B': return '**' + inline(el) + '**';
    case 'EM': case 'I': return '*' + inline(el) + '*';
    case 'DEL': case 'S': return '~~' + inline(el) + '~~';
    case 'CODE': return tick(el.textContent);
    case 'A': return '[' + inline(el) + '](' + el.getAttribute('href') + ')';
    case 'BR': return '\\n';
    case 'IMG': return '![' + (el.alt || '') + '](' + el.src + ')';
    case 'SPAN': case 'SUP': case 'SUB': case 'MARK': case 'U': case 'SMALL': return inline(el);
    default: return block(el);
  }
}
function block(el) {
  if (el.nodeType !== 1) return md(el);
  const tag = el.tagName, copy = el.dataset?.markdownCopy;
  if (copy || el.hidden || el.getAttribute('aria-hidden') === 'true') return md(el);
  if (/^H[1-6]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + inline(el).trim() + '\\n\\n';
  if (tag === 'P') return inline(el).trim() + '\\n\\n';
  if (tag === 'UL' || tag === 'OL') return list(el, 0) + '\\n\\n';
  if (tag === 'PRE') return fenced((el.querySelector('code') || el).textContent, lang(el));
  if (tag === 'TABLE') return table(el) + '\\n\\n';
  if (tag === 'BLOCKQUOTE') return convert(el).trim().split('\\n').map(l => '> ' + l).join('\\n') + '\\n\\n';
  if (tag === 'HR') return '---\\n\\n';
  if (['STRONG','B','EM','I','DEL','S','CODE','A','BR','IMG','SPAN'].includes(tag) || el.classList.contains('katex')) return md(el);
  return convert(el);
}
function convert(root) { return [...root.childNodes].map(block).join(''); }
const last = [...document.querySelectorAll('[data-markdown-text-style]')].pop();
JSON.stringify({
  url: location.href,
  markdown: last ? convert(last).replace(/\\n{3,}/g, '\\n\\n').trim() : '',
  text: last ? last.innerText : (document.querySelector('main')?.innerText || ''),
});`

/** Whether `url` names one of the user's chats (`https://chatgpt.com/c/<id>`). */
export function isChatUrl(url: string): boolean {
  return /^https:\/\/chatgpt\.com\/c\/[\w-]+\/?$/.test(url)
}

// Goes to `target` in the chatgpt.com tab, opening the pane or a tab when
// there is none; never touches a tab on another site. The home page is a new
// chat, so going there is what the "New chat" button does.
async function findTab(browser: Browser, target: string): Promise<string> {
  const { browserOpen, tabs } = await browser.tabs()
  if (!browserOpen) return browser.open(target)
  const tab = tabs.find(t => t.origin === ORIGIN && t.isActive) ?? tabs.find(t => t.origin === ORIGIN)
  const tabId = tab ? tab.tabId : await browser.create()
  await browser.navigate(tabId, target)
  return tabId
}

type Ready = { ok: true; tabId: string; page: PageState } | { ok: false; error: string; url?: string }

// Opens a new chat, or `chatUrl` to continue one, and waits for the composer.
async function prepare(browser: Browser, chatUrl: string | undefined, progress: (text: string) => void): Promise<Ready> {
  if (chatUrl !== undefined && !isChatUrl(chatUrl)) {
    return { ok: false, error: `chatUrl must be a chat link like https://chatgpt.com/c/<id>, not ${chatUrl}.` }
  }
  progress('opening chatgpt.com')
  const tabId = await findTab(browser, chatUrl ?? CHATGPT_URL)

  // The page may still be loading after a navigation: wait for the composer.
  let page = parseOutput<PageState>(await browser.js(tabId, stateScript(0)))
  for (let i = 0; i < 10 && !page.composer && !page.login; i++) {
    page = parseOutput<PageState>(await browser.js(tabId, stateScript(1500)))
  }
  if (!page.href.startsWith(ORIGIN) || page.login || !page.composer) {
    return {
      ok: false,
      url: page.href,
      error:
        `ChatGPT is not ready in the browser pane (at ${page.href}). ` +
        'Ask the user to open the browser pane, log in to chatgpt.com and try again; never type credentials.',
    }
  }
  if (page.stop) return { ok: false, url: page.href, error: 'ChatGPT is still answering in that chat; wait and try again.' }
  return { ok: true, tabId, page }
}

export async function ask(browser: Browser, input: AskInput, options: AskOptions = {}): Promise<AskResult> {
  const timeoutMs = options.timeoutMs ?? 6 * 60_000
  const pollMs = options.pollMs ?? 3000
  const progress = options.progress ?? (() => {})

  const ready = await prepare(browser, input.chatUrl, progress)
  if (!ready.ok) return ready
  const { tabId } = ready
  let page = ready.page

  const before = page.count
  const sent = parseOutput<{ sent: boolean; reason?: string }>(await browser.js(tabId, sendScript(input.prompt)))
  if (!sent.sent) return { ok: false, url: page.href, error: `Could not send the prompt: ${sent.reason}.` }

  progress('waiting for the answer')
  const started = Date.now()
  let lastLength = -1
  for (;;) {
    page = parseOutput<PageState>(await browser.js(tabId, stateScript(pollMs)))
    const done = page.count > before && !page.stop && page.length > 0 && page.length === lastLength
    if (done) break
    lastLength = page.count > before ? page.length : -1
    if (Date.now() - started > timeoutMs) {
      const partial = parseOutput<{ url: string; markdown: string }>(await browser.js(tabId, READ_SCRIPT))
      return {
        ok: false,
        url: partial.url,
        markdown: page.count > before ? partial.markdown : undefined,
        error: `No complete answer after ${Math.round(timeoutMs / 1000)} s; it may still be streaming at ${partial.url}.`,
      }
    }
    progress(page.count > before ? `receiving (${page.length} chars)` : 'waiting for the answer')
  }

  const read = parseOutput<{ url: string; markdown: string; text: string }>(await browser.js(tabId, READ_SCRIPT))
  const markdown = read.markdown || read.text
  if (!markdown) return { ok: false, url: read.url, error: 'The answer was empty or the page layout changed.' }
  return { ok: true, url: read.url, markdown }
}

// Images cross the page boundary as base64 in slices, so neither the script
// text nor the tool's output carries a whole file at once.
export const CHUNK = 512 * 1024

export type Reference = { name: string; type: string; base64: string }

export type ImageInput = { prompt: string; chatUrl?: string; reference?: Reference }

export type ImageResult =
  | { ok: true; url: string; base64: string; type: string; width: number; height: number; alt: string }
  | { ok: false; error: string; url?: string; markdown?: string }

type ImageState = { href: string; stop: boolean; images: number; count: number; length: number }

// A generated image: a large picture whose alt says so ("Imagem 1 gerada",
// "Generated image 1"); an attached reference has its file name instead.
const GENERATED = `[...document.querySelectorAll('main img')].filter(i => i.naturalWidth > 500 && /gerad|generated/i.test(i.alt || ''))`

export function imageStateScript(waitMs: number): string {
  return `
await new Promise(r => setTimeout(r, ${Math.max(0, Math.floor(waitMs))}));
const answers = [...document.querySelectorAll('[data-markdown-text-style]')];
JSON.stringify({
  href: location.href,
  stop: !!document.querySelector('[data-testid=stop-button]') ||
    [...document.querySelectorAll('button')].some(b => ${STOP_LABELS}.test(b.getAttribute('aria-label') || '')),
  images: ${GENERATED}.length,
  count: answers.length,
  length: (answers.pop()?.innerText || '').length,
})`
}

export function uploadChunkScript(index: number, chunk: string): string {
  return `
if (${index} === 0) window.__chatgptAskUpload = [];
window.__chatgptAskUpload.push(${JSON.stringify(chunk)});
JSON.stringify({ chunks: window.__chatgptAskUpload.length })`
}

// Attaches the uploaded bytes to the composer through its image input.
export function attachScript(name: string, type: string): string {
  return `
const b64 = (window.__chatgptAskUpload || []).join('');
delete window.__chatgptAskUpload;
const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const file = new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} });
const input = [...document.querySelectorAll('input[type=file]')].find(i => i.accept === 'image/*') ||
  document.querySelector('input[type=file][accept*="image"]');
if (!input) JSON.stringify({ attached: false, reason: 'image input not found' }); else {
  const data = new DataTransfer();
  data.items.add(file);
  input.files = data.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const label = b => /^(Remover|Remove) /.test(b.getAttribute('aria-label') || '') && (b.getAttribute('aria-label') || '').endsWith(${JSON.stringify(name)});
  let chip = false;
  for (let i = 0; i < 40 && !chip; i++) {
    await new Promise(r => setTimeout(r, 250));
    chip = [...document.querySelectorAll('button')].some(label);
  }
  JSON.stringify(chip ? { attached: true } : { attached: false, reason: 'the attachment did not show up in the composer' });
}`
}

// Reads the last generated image's bytes into the page, as the server sent
// them when the page may fetch it, else redrawn as PNG.
export const IMAGE_SCRIPT = `
const img = ${GENERATED}.pop();
if (!img) JSON.stringify({ found: false }); else {
  let type = 'image/png', b64 = '';
  try {
    const blob = await (await fetch(img.currentSrc || img.src, { credentials: 'include' })).blob();
    if (!/^image\\//.test(blob.type)) throw new Error(blob.type);
    type = blob.type;
    b64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    const copy = new Image();
    copy.crossOrigin = 'anonymous';
    copy.src = img.currentSrc || img.src;
    await copy.decode();
    const canvas = document.createElement('canvas');
    canvas.width = copy.naturalWidth;
    canvas.height = copy.naturalHeight;
    canvas.getContext('2d').drawImage(copy, 0, 0);
    type = 'image/png';
    b64 = canvas.toDataURL('image/png').split(',')[1] || '';
  }
  window.__chatgptAskImage = b64;
  JSON.stringify({ found: true, url: location.href, type, length: b64.length, width: img.naturalWidth, height: img.naturalHeight, alt: img.alt || '' });
}`

export function imageChunkScript(offset: number, size: number): string {
  return `JSON.stringify({ chunk: (window.__chatgptAskImage || '').slice(${offset}, ${offset + size}) })`
}

export const IMAGE_CLEANUP_SCRIPT = `delete window.__chatgptAskImage; JSON.stringify({ done: true })`

export async function generateImage(browser: Browser, input: ImageInput, options: AskOptions = {}): Promise<ImageResult> {
  const timeoutMs = options.timeoutMs ?? 6 * 60_000
  const pollMs = options.pollMs ?? 5000
  const progress = options.progress ?? (() => {})

  const ready = await prepare(browser, input.chatUrl, progress)
  if (!ready.ok) return ready
  const { tabId } = ready

  if (input.reference) {
    progress('attaching the reference')
    const { base64, name, type } = input.reference
    for (let offset = 0, index = 0; offset < base64.length || index === 0; offset += CHUNK, index++) {
      await browser.js(tabId, uploadChunkScript(index, base64.slice(offset, offset + CHUNK)))
    }
    const attached = parseOutput<{ attached: boolean; reason?: string }>(await browser.js(tabId, attachScript(name, type)))
    if (!attached.attached) return { ok: false, url: ready.page.href, error: `Could not attach the reference: ${attached.reason}.` }
  }

  let state = parseOutput<ImageState>(await browser.js(tabId, imageStateScript(0)))
  const before = state
  const sent = parseOutput<{ sent: boolean; reason?: string }>(await browser.js(tabId, sendScript(input.prompt)))
  if (!sent.sent) return { ok: false, url: state.href, error: `Could not send the prompt: ${sent.reason}.` }

  progress('waiting for the image')
  const started = Date.now()
  let lastLength = -1
  for (;;) {
    state = parseOutput<ImageState>(await browser.js(tabId, imageStateScript(pollMs)))
    if (state.images > before.images && !state.stop) break
    // No image, and a settled text answer: a refusal or a question back.
    const texted = state.count > before.count && !state.stop && state.length > 0 && state.length === lastLength
    if (texted) {
      const read = parseOutput<{ url: string; markdown: string; text: string }>(await browser.js(tabId, READ_SCRIPT))
      return {
        ok: false,
        url: read.url,
        markdown: read.markdown || read.text,
        error: 'ChatGPT answered with text instead of an image (a refusal or a question); relay it, do not rephrase around a refusal.',
      }
    }
    lastLength = state.count > before.count ? state.length : -1
    if (Date.now() - started > timeoutMs) {
      return { ok: false, url: state.href, error: `No image after ${Math.round(timeoutMs / 1000)} s; it may still be generating at ${state.href}.` }
    }
    progress(state.stop ? 'generating the image' : 'waiting for the image')
  }

  progress('saving the image')
  const found = parseOutput<{ found: boolean; url: string; type: string; length: number; width: number; height: number; alt: string }>(
    await browser.js(tabId, IMAGE_SCRIPT),
  )
  if (!found.found || found.length === 0) return { ok: false, url: state.href, error: 'The generated image could not be read from the page.' }
  let base64 = ''
  for (let offset = 0; offset < found.length; offset += CHUNK) {
    base64 += parseOutput<{ chunk: string }>(await browser.js(tabId, imageChunkScript(offset, CHUNK))).chunk
  }
  await browser.js(tabId, IMAGE_CLEANUP_SCRIPT)
  if (base64.length !== found.length) return { ok: false, url: found.url, error: 'The image came back incomplete; try again.' }
  return { ok: true, url: found.url, base64, type: found.type, width: found.width, height: found.height, alt: found.alt }
}

/** The extension for an image MIME type. */
export function extensionOf(type: string): string {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[type] ?? 'png'
}

/** The MIME type of a reference image, by its extension. */
export function typeOf(path: string): string | undefined {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext]
}

/** A file name for an answer or image: timestamp plus a slug of the prompt. */
export function fileName(prompt: string, now: Date, extension = 'md'): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const slug = prompt
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '')
  return `${stamp}-${slug || 'answer'}.${extension}`
}

/** What the model reads: where the answer is and how much of it. */
export function summary(path: string, url: string, markdown: string, maxChars: number): string {
  const head = [`ChatGPT's answer (unverified; check facts before using them) saved to ${path}`, `Chat: ${url}`]
  if (markdown.length <= maxChars) return [...head, '', markdown].join('\n')
  return [
    ...head,
    `Showing the first ${maxChars} of ${markdown.length} chars; read the file for the rest.`,
    '',
    markdown.slice(0, maxChars),
  ].join('\n')
}
