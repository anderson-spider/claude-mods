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

export type AskInput = { prompt: string; newChat: boolean }

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

async function findTab(browser: Browser, newChat: boolean): Promise<string> {
  const { browserOpen, tabs } = await browser.tabs()
  if (!browserOpen) return browser.open(CHATGPT_URL)
  const tab = tabs.find(t => t.origin === ORIGIN && t.isActive) ?? tabs.find(t => t.origin === ORIGIN)
  if (tab) {
    if (newChat) await browser.navigate(tab.tabId, CHATGPT_URL)
    return tab.tabId
  }
  const tabId = await browser.create()
  await browser.navigate(tabId, CHATGPT_URL)
  return tabId
}

export async function ask(browser: Browser, input: AskInput, options: AskOptions = {}): Promise<AskResult> {
  const timeoutMs = options.timeoutMs ?? 6 * 60_000
  const pollMs = options.pollMs ?? 3000
  const progress = options.progress ?? (() => {})
  const state = async (tabId: string, waitMs: number) =>
    parseOutput<PageState>(await browser.js(tabId, stateScript(waitMs)))

  progress('opening chatgpt.com')
  const tabId = await findTab(browser, input.newChat)

  // The page may still be loading after a navigation: wait for the composer.
  let page = await state(tabId, 0)
  for (let i = 0; i < 10 && !page.composer && !page.login; i++) page = await state(tabId, 1500)
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

  const before = page.count
  const sent = parseOutput<{ sent: boolean; reason?: string }>(await browser.js(tabId, sendScript(input.prompt)))
  if (!sent.sent) return { ok: false, url: page.href, error: `Could not send the prompt: ${sent.reason}.` }

  progress('waiting for the answer')
  const started = Date.now()
  let lastLength = -1
  for (;;) {
    page = await state(tabId, pollMs)
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

/** A file name for the answer: timestamp plus a slug of the prompt. */
export function fileName(prompt: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const slug = prompt
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '')
  return `${stamp}-${slug || 'answer'}.md`
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
