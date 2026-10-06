// Drives the user's logged-in ChatGPT in terminal-browser, the browser that
// runs inside a terminal session.
// Pure: everything that touches the browser goes through the injected `Browser`.

export const CHATGPT_URL = 'https://chatgpt.com/'
const ORIGIN = 'https://chatgpt.com'

export type Browser = {
  /** The ids of the open tabs. */
  tabs(): Promise<string[]>
  /** Opens a tab at `url` (and the browser, when none is open) and returns its id. */
  openTab(url: string): Promise<string>
  /** Waits, inside the browser, until the JS expression `fn` is truthy; false on a timeout. */
  waitFor(tabId: string, fn: string, timeoutMs: number): Promise<boolean>
  /**
   * Runs `body` in the tab and returns the raw output: a function body that
   * may `await` and ends in `return JSON.stringify(...)`, printed as a JSON
   * string literal.
   */
  js(tabId: string, body: string): Promise<string>
  /** Sets local files on the input `selector` names. */
  upload(tabId: string, selector: string, paths: string[]): Promise<void>
}

/** A local file to attach, uploaded by its path. */
export type Attachment = { name: string; type: string; path: string }

/**
 * What to send. `chatUrl` continues a chat, else a new one starts; `model` picks an
 * entry of the model menu by its label; `files` are attached first;
 * `saveOnly` sends nothing and saves what `chatUrl` already holds, waiting
 * while it is still being written.
 */
export type AskInput = {
  prompt: string
  chatUrl?: string
  model?: string
  files?: Attachment[]
  saveOnly?: boolean
}

/** `timedOut` marks a run that may still finish at `url`. */
export type AskResult =
  | { ok: true; url: string; markdown: string }
  | { ok: false; error: string; url?: string; markdown?: string; timedOut?: boolean }

/** The plugin's own tab, kept across requests so it never takes over another. */
export type TabHolder = { id?: string }

export type AskOptions = {
  /** How long to wait for the answer, in ms. */
  timeoutMs?: number
  /** How long each poll waits inside the page, in ms. */
  pollMs?: number
  /** Called with a short status while waiting. */
  progress?: (text: string) => void
  /** The plugin's tab; a new one is opened (and recorded here) when it is gone. */
  tab?: TabHolder
}

type PageState = {
  href: string
  composer: boolean
  login: boolean
  stop: boolean
  count: number
  length: number
  images: number
  blocker: string
}

// Every page script returns JSON.stringify(...): terminal-browser's eval
// prints a string result as a JSON literal.
export function parseOutput<T>(text: string): T {
  try {
    return JSON.parse(JSON.parse(text.trim())) as T
  } catch {
    throw new Error(`unexpected browser output: ${text.slice(0, 200)}`)
  }
}

// The page parts every script relies on, kept in one place so /chatgpt-doctor
// checks the same selectors the scripts use.
const COMPOSER = `document.querySelector('.ProseMirror[contenteditable=true], #prompt-textarea')`
const LOGIN = `(!!document.querySelector('[data-testid=login-button]') || /\\/auth\\/|\\/log-?in/.test(location.pathname))`
const STOP = `(!!document.querySelector('[data-testid=stop-button]') || [...document.querySelectorAll('button')].some(b => /^(Parar|Stop)/i.test(b.getAttribute('aria-label') || '')))`
const MODEL_BUTTON = `([...document.querySelectorAll('button')].find(b => /^(Selecionar modelo|Select model|Model selector)/i.test(b.getAttribute('aria-label') || '')) || document.querySelector('[data-testid=model-switcher-dropdown-button]'))`
const ANSWERS = `[...document.querySelectorAll('[data-markdown-text-style]')]`
// A generated image: a large picture whose alt says so ("Imagem 1 gerada",
// "Generated image 1"); an attached reference has its file name instead.
const GENERATED = `[...document.querySelectorAll('main img')].filter(i => i.naturalWidth > 500 && /gerad|generated/i.test(i.alt || ''))`
const sleep = (waitMs: number) => `await new Promise(r => setTimeout(r, ${Math.max(0, Math.floor(waitMs))}));`
const SEND_SELECTOR =
  '[data-testid=send-button], #composer-submit-button, button[aria-label=Enviar], button[aria-label=Send], button[aria-label="Send prompt"], button[aria-label="Enviar prompt"]'

// What stands in the way, in the page's words: a human verification, an open
// dialog or alert, or an error line in the conversation (a usage limit).
const BLOCKER = `(() => {
  if (document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-form, #cf-challenge-running')) return 'a human verification (captcha)';
  const shown = el => el.offsetParent !== null && (el.innerText || '').trim();
  const box = [...document.querySelectorAll('[role=dialog], [role=alertdialog], [role=alert]')].find(shown);
  if (box) return box.innerText.trim().replace(/\\s+/g, ' ').slice(0, 300);
  const error = [...document.querySelectorAll('main .text-token-text-error, main [class*="text-red"]')].find(shown);
  return error ? error.innerText.trim().replace(/\\s+/g, ' ').slice(0, 300) : '';
})()`

/** A blocker that ends a run at once (a limit, a verification), not just any dialog. */
export function isHardBlocker(text: string): boolean {
  return /limit|limite|cap\b|captcha|verif|unusual activity|atividade incomum|try again|tente novamente|too many|muitas/i.test(text)
}

export function stateScript(waitMs: number): string {
  return `
${sleep(waitMs)}
const answers = ${ANSWERS};
return JSON.stringify({
  href: location.href,
  composer: !!${COMPOSER},
  login: ${LOGIN},
  stop: ${STOP},
  count: answers.length,
  length: (answers.pop()?.innerText || '').length,
  images: ${GENERATED}.length,
  blocker: ${BLOCKER},
})`
}

// Opens the model menu and clicks the entry whose label starts with `label`
// (case and spacing ignored); answers the labels on offer when none does.
export function modelScript(label: string): string {
  return `
const norm = t => (t || '').toLowerCase().replace(/\\s+/g, ' ').trim();
const want = norm(${JSON.stringify(label)});
const button = ${MODEL_BUTTON};
if (!button) return JSON.stringify({ picked: false, reason: 'model menu not found', offered: [] }); else {
  button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  button.click();
  await new Promise(r => setTimeout(r, 800));
  const items = [...document.querySelectorAll('[role=menuitem], [role=menuitemradio], [role=option]')].filter(i => norm(i.innerText));
  const label = i => norm(i.innerText.split('\\n')[0]);
  const item = items.find(i => label(i) === want) || items.find(i => label(i).startsWith(want));
  if (item) item.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  return JSON.stringify(item ? { picked: true } : { picked: false, reason: 'no such entry', offered: items.map(label) });
}`
}

export function sendScript(prompt: string): string {
  return `
const ed = ${COMPOSER};
if (!ed) return JSON.stringify({ sent: false, reason: 'composer not found' }); else {
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
  return JSON.stringify(button ? { sent: true } : { sent: false, reason: 'send button not found' });
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
const last = ${ANSWERS}.pop();
return JSON.stringify({
  url: location.href,
  markdown: last ? convert(last).replace(/\\n{3,}/g, '\\n\\n').trim() : '',
  text: last ? last.innerText : (document.querySelector('main')?.innerText || ''),
});`

/** Whether `url` names one of the user's chats (`https://chatgpt.com/c/<id>`). */
export function isChatUrl(url: string): boolean {
  return /^https:\/\/chatgpt\.com\/c\/[\w-]+\/?$/.test(url)
}

/** Why `url` cannot be a `chatUrl`, or undefined when it can. */
export function chatUrlError(url: string): string | undefined {
  return isChatUrl(url) ? undefined : `chatUrl must be a chat link like https://chatgpt.com/c/<id>, not ${url}.`
}

/** Whether `url` starts a new chat: the home page. */
export function isNewChatUrl(url: string): boolean {
  return url === CHATGPT_URL
}

// Goes to `target` in the plugin's own tab, opening one when it is gone, and
// waits for the composer (or a login page); never touches a tab it did not
// open. The home page is a new chat, so going there is what the "New chat"
// button does.
async function findTab(browser: Browser, target: string, holder: TabHolder): Promise<string> {
  if (holder.id && (await browser.tabs()).includes(holder.id)) {
    await browser.js(holder.id, leaveScript(target))
    await browser.waitFor(holder.id, LANDED, LOAD_MS)
  } else {
    holder.id = await browser.openTab(target)
  }
  await browser.waitFor(holder.id, `!!${COMPOSER} || ${LOGIN}`, LOAD_MS)
  return holder.id
}

// How long a page may take to load and show the composer.
const LOAD_MS = 20_000

type Ready = { ok: true; tabId: string; page: PageState } | { ok: false; error: string; url?: string }

function blocked(page: { blocker: string }): string {
  return page.blocker ? ` ChatGPT shows: "${page.blocker}".` : ''
}

// Opens a new chat, or `chatUrl` to continue one, and waits for the composer.
// `busy` accepts a chat still answering (to save what it is writing).
async function prepare(
  browser: Browser,
  input: { chatUrl?: string },
  options: { progress: (text: string) => void; tab: TabHolder; busy?: boolean },
): Promise<Ready> {
  const { chatUrl } = input
  const invalid = chatUrl === undefined ? undefined : chatUrlError(chatUrl)
  if (invalid) return { ok: false, error: invalid }
  options.progress('opening chatgpt.com')
  const tabId = await findTab(browser, chatUrl ?? CHATGPT_URL, options.tab)

  let page = parseOutput<PageState>(await browser.js(tabId, stateScript(0)))
  if (!page.href.startsWith(ORIGIN) || page.login || !page.composer) {
    return {
      ok: false,
      url: page.href,
      error:
        `ChatGPT is not ready in the browser (at ${page.href}).${blocked(page)} ` +
        'Ask the user to log in to chatgpt.com in terminal-browser (or clear what the page shows) and try again; never type credentials.',
    }
  }
  if (page.stop && !options.busy) return { ok: false, url: page.href, error: 'ChatGPT is still answering in that chat; wait and try again.' }
  return { ok: true, tabId, page }
}

// Picks the model and attaches the files, in that order; an error string stops the run.
async function compose(browser: Browser, tabId: string, input: AskInput, progress: (text: string) => void): Promise<string | undefined> {
  if (input.model) {
    progress(`picking ${input.model}`)
    const picked = parseOutput<{ picked: boolean; reason?: string; offered?: string[] }>(await browser.js(tabId, modelScript(input.model)))
    if (!picked.picked) {
      const offered = picked.offered?.length ? ` The menu offers: ${picked.offered.join(', ')}.` : ''
      return `Could not pick the model "${input.model}": ${picked.reason}.${offered}`
    }
  }
  for (const file of input.files ?? []) {
    progress(`attaching ${file.name}`)
    await browser.upload(tabId, inputFor(file.type), [file.path])
    const attached = parseOutput<{ attached: boolean; reason?: string }>(await browser.js(tabId, chipScript(file.name)))
    if (!attached.attached) return `Could not attach ${file.name}: ${attached.reason}.`
  }
  return undefined
}

type Answer = { url: string; markdown: string }

async function readAnswer(browser: Browser, tabId: string): Promise<Answer> {
  const read = parseOutput<{ url: string; markdown: string; text: string }>(await browser.js(tabId, READ_SCRIPT))
  return { url: read.url, markdown: read.markdown || read.text }
}

export async function ask(browser: Browser, input: AskInput, options: AskOptions = {}): Promise<AskResult> {
  const timeoutMs = options.timeoutMs ?? 6 * 60_000
  const pollMs = options.pollMs ?? 3000
  const progress = options.progress ?? (() => {})
  const tab = options.tab ?? {}

  if (input.saveOnly && input.chatUrl === undefined) return { ok: false, error: 'saveOnly needs the chatUrl of the chat with the answer.' }
  const ready = await prepare(browser, input, { progress, tab, busy: input.saveOnly })
  if (!ready.ok) return ready
  const { tabId } = ready
  let page = ready.page

  // Saving what the chat holds: its last answer counts as the new one.
  const before = input.saveOnly ? page.count - 1 : page.count
  if (!input.saveOnly) {
    const failed = await compose(browser, tabId, input, progress)
    if (failed) return { ok: false, url: page.href, error: failed }
    const sent = parseOutput<{ sent: boolean; reason?: string }>(await browser.js(tabId, sendScript(input.prompt)))
    if (!sent.sent) return { ok: false, url: page.href, error: `Could not send the prompt: ${sent.reason}.` }
  }

  progress('waiting for the answer')
  const started = Date.now()
  let lastLength = input.saveOnly && !page.stop ? page.length : -1
  for (;;) {
    if (input.saveOnly && !page.stop && page.length > 0 && page.length === lastLength) break
    page = parseOutput<PageState>(await browser.js(tabId, stateScript(pollMs)))
    const done = page.count > before && !page.stop && page.length > 0 && page.length === lastLength
    if (done) break
    if (page.blocker && !page.stop && isHardBlocker(page.blocker)) {
      return { ok: false, url: page.href, error: `ChatGPT stopped: "${page.blocker}".` }
    }
    lastLength = page.count > before ? page.length : -1
    if (Date.now() - started > timeoutMs) {
      const partial = await readAnswer(browser, tabId)
      return {
        ok: false,
        url: partial.url,
        markdown: page.count > before ? partial.markdown : undefined,
        timedOut: isChatUrl(partial.url),
        error: `No complete answer after ${Math.round(timeoutMs / 1000)} s; it may still be streaming at ${partial.url}.${blocked(page)}`,
      }
    }
    progress(page.count > before ? `receiving (${page.length} chars)` : 'waiting for the answer')
  }

  const { url, markdown } = await readAnswer(browser, tabId)
  if (!markdown) return { ok: false, url, error: 'The answer was empty or the page layout changed.' }
  return { ok: true, url, markdown }
}

/** `saveOnly` saves the last image already generated in `chatUrl`, sending nothing (and waiting while it is still generating). */
export type ImageInput = AskInput

export type Image = { base64: string; type: string; width: number; height: number; alt: string }

/** Every image the request produced (ChatGPT sometimes draws variants), last one last. */
export type ImageResult =
  | { ok: true; url: string; images: Image[] }
  | { ok: false; error: string; url?: string; markdown?: string; timedOut?: boolean }

// Waits for the composer's chip of an attachment the browser uploaded (its
// remove button names the file), which shows the upload took.
export function chipScript(name: string): string {
  return `
const label = b => /^(Remover|Remove) /.test(b.getAttribute('aria-label') || '') && (b.getAttribute('aria-label') || '').endsWith(${JSON.stringify(name)});
let chip = false;
for (let i = 0; i < 40 && !chip; i++) {
  await new Promise(r => setTimeout(r, 250));
  chip = [...document.querySelectorAll('button')].some(label);
}
return JSON.stringify(chip ? { attached: true } : { attached: false, reason: 'the attachment did not show up in the composer' });`
}

/** The file input an attachment of `type` goes through: images by the image input, anything else by the one that takes every type. */
export function inputFor(type: string): string {
  return type.startsWith('image/') ? 'input[type=file][accept="image/*"]' : 'input[type=file]:not([accept]), input[type=file][accept=""]'
}

// Reads a generated image's bytes (`back` 0 is the last one), as the server
// sent them when the page may fetch it, else redrawn as PNG.
export function imageScript(back: number): string {
  return `
const img = ${GENERATED}.at(${-1 - back});
if (!img) return JSON.stringify({ found: false }); else {
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
  return JSON.stringify({ found: true, url: location.href, type, base64: b64, width: img.naturalWidth, height: img.naturalHeight, alt: img.alt || '' });
}`
}

export async function generateImage(browser: Browser, input: ImageInput, options: AskOptions = {}): Promise<ImageResult> {
  const timeoutMs = options.timeoutMs ?? 6 * 60_000
  const pollMs = options.pollMs ?? 5000
  const progress = options.progress ?? (() => {})
  const tab = options.tab ?? {}

  if (input.saveOnly && input.chatUrl === undefined) return { ok: false, error: 'saveOnly needs the chatUrl of the chat with the image.' }
  const ready = await prepare(browser, input, { progress, tab, busy: input.saveOnly })
  if (!ready.ok) return ready
  const { tabId } = ready

  let state = ready.page
  // Saving what the chat holds: wait while it still generates, then take the last image.
  if (input.saveOnly) {
    const started = Date.now()
    while (state.stop && Date.now() - started <= timeoutMs) {
      progress('waiting for the image to finish')
      state = parseOutput<PageState>(await browser.js(tabId, stateScript(pollMs)))
    }
    if (state.stop) return { ok: false, url: state.href, timedOut: true, error: `The image is still generating at ${state.href}.` }
    // A freshly opened chat shows the composer before its images load.
    await browser.waitFor(tabId, `${GENERATED}.length > 0`, LOAD_MS)
    return readImages(browser, tabId, state.href, 1, progress)
  }

  const failed = await compose(browser, tabId, input, progress)
  if (failed) return { ok: false, url: ready.page.href, error: failed }

  const before = state
  const sent = parseOutput<{ sent: boolean; reason?: string }>(await browser.js(tabId, sendScript(input.prompt)))
  if (!sent.sent) return { ok: false, url: state.href, error: `Could not send the prompt: ${sent.reason}.` }

  progress('waiting for the image')
  const started = Date.now()
  let lastLength = -1
  for (;;) {
    state = parseOutput<PageState>(await browser.js(tabId, stateScript(pollMs)))
    if (state.images > before.images && !state.stop) break
    if (state.blocker && !state.stop && isHardBlocker(state.blocker)) {
      return { ok: false, url: state.href, error: `ChatGPT stopped: "${state.blocker}".` }
    }
    // No image, and a settled text answer: a refusal or a question back.
    const texted = state.count > before.count && !state.stop && state.length > 0 && state.length === lastLength
    if (texted) {
      const read = await readAnswer(browser, tabId)
      return {
        ok: false,
        url: read.url,
        markdown: read.markdown,
        error: 'ChatGPT answered with text instead of an image (a refusal or a question); relay it, do not rephrase around a refusal.',
      }
    }
    lastLength = state.count > before.count ? state.length : -1
    if (Date.now() - started > timeoutMs) {
      return {
        ok: false,
        url: state.href,
        timedOut: isChatUrl(state.href),
        error: `No image after ${Math.round(timeoutMs / 1000)} s; it may still be generating at ${state.href}.${blocked(state)}`,
      }
    }
    progress(state.stop ? 'generating the image' : 'waiting for the image')
  }

  return readImages(browser, tabId, state.href, state.images - before.images, progress)
}

// Reads the chat's last `count` generated images back, oldest first.
async function readImages(
  browser: Browser,
  tabId: string,
  href: string,
  count: number,
  progress: (text: string) => void,
): Promise<ImageResult> {
  const images: Image[] = []
  let url = href
  for (let back = Math.max(1, count) - 1; back >= 0; back--) {
    progress('saving the image')
    const found = parseOutput<{ found: boolean } & Image & { url: string }>(await browser.js(tabId, imageScript(back)))
    if (!found.found || !found.base64) {
      if (images.length) break
      return { ok: false, url: href, error: 'No generated image could be read from the page.' }
    }
    url = found.url
    images.push({ base64: found.base64, type: found.type, width: found.width, height: found.height, alt: found.alt })
  }
  return { ok: true, url, images }
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

/** The extension for an image MIME type. */
export function extensionOf(type: string): string {
  return Object.keys(IMAGE_TYPES).find(ext => IMAGE_TYPES[ext] === type) ?? 'png'
}

/** The MIME type of an image, by its extension. */
export function typeOf(path: string): string | undefined {
  return IMAGE_TYPES[path.toLowerCase().split('.').pop() ?? '']
}

const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
}

/** The MIME type of a file to attach, by its extension: an image's, a document's, else plain text for code and other text. */
export function mimeOf(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  return typeOf(path) ?? FILE_TYPES[ext] ?? 'text/plain'
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
export function summary(path: string, url: string, markdown: string, maxChars = 3000): string {
  const head = [`ChatGPT's answer (unverified; check facts before using them) saved to ${path}`, `Chat: ${url}`]
  if (markdown.length <= maxChars) return [...head, '', markdown].join('\n')
  return [
    ...head,
    `Showing the first ${maxChars} of ${markdown.length} chars; read the file for the rest.`,
    '',
    markdown.slice(0, maxChars),
  ].join('\n')
}

/**
 * Runs `task` after the ones queued before it: requests share the plugin's
 * tab, so they take turns. `ahead` says how many wait in front.
 */
export function taskQueue(): <T>(task: () => Promise<T>, ahead?: (count: number) => void) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  let pending = 0
  return (task, ahead) => {
    ahead?.(pending)
    pending++
    const run = tail.then(task, task).finally(() => {
      pending--
    })
    tail = run.catch(() => undefined)
    return run
  }
}

export type Check = { name: string; ok: boolean; detail: string }

// What /chatgpt-doctor looks at in the page: every selector the plugin relies on.
export const DOCTOR_SCRIPT = `
const all = s => [...document.querySelectorAll(s)];
const inputs = all('input[type=file]');
return JSON.stringify({
  href: location.href,
  login: ${LOGIN},
  composer: !!${COMPOSER},
  send: all(${JSON.stringify(SEND_SELECTOR)}).length,
  imageInput: inputs.some(i => i.accept.includes('image')),
  fileInput: inputs.some(i => !i.accept),
  model: !!${MODEL_BUTTON},
  answers: ${ANSWERS}.length,
  images: ${GENERATED}.length,
  codeBlocks: all('[data-markdown-copy=code-block], pre').length,
  blocker: ${BLOCKER},
})`

type Doctor = {
  href: string
  login: boolean
  composer: boolean
  send: number
  imageInput: boolean
  fileInput: boolean
  model: boolean
  answers: number
  images: number
  codeBlocks: number
  blocker: string
}

/**
 * Opens a new chat (or `chatUrl`, to also check what reads an answer back) in
 * the plugin's tab and reports which of the page parts the plugin relies on
 * are where it expects them.
 */
export async function diagnose(browser: Browser, chatUrl: string | undefined, tab: TabHolder): Promise<Check[]> {
  const invalid = chatUrl === undefined ? undefined : chatUrlError(chatUrl)
  if (invalid) return [{ name: 'chat link', ok: false, detail: invalid }]
  const tabId = await findTab(browser, chatUrl ?? CHATGPT_URL, tab)
  const page = parseOutput<Doctor>(await browser.js(tabId, DOCTOR_SCRIPT))
  const checks: Check[] = [
    { name: 'page', ok: page.href.startsWith(ORIGIN), detail: page.href },
    { name: 'logged in', ok: !page.login, detail: page.login ? 'the page asks for a login' : 'yes' },
    { name: 'nothing in the way', ok: !page.blocker, detail: page.blocker || 'no dialog, alert or limit shown' },
    { name: 'composer', ok: page.composer, detail: page.composer ? 'found' : 'not found: sendScript and stateScript need updating' },
    {
      name: 'send button',
      ok: true,
      detail: page.send ? 'found' : 'not shown while the composer is empty (expected); sendScript waits for it',
    },
    { name: 'image input', ok: page.imageInput, detail: page.imageInput ? 'found' : 'not found: references cannot be attached' },
    { name: 'file input', ok: page.fileInput, detail: page.fileInput ? 'found' : 'not found: files cannot be attached' },
    { name: 'model menu', ok: page.model, detail: page.model ? 'found' : 'not found: model cannot be picked' },
  ]
  if (chatUrl !== undefined) {
    checks.push(
      { name: 'answers', ok: page.answers > 0, detail: `${page.answers} found ([data-markdown-text-style])` },
      { name: 'generated images', ok: true, detail: `${page.images} found` },
      { name: 'code blocks', ok: true, detail: `${page.codeBlocks} found` },
    )
  }
  return checks
}

/** The doctor's report, one line per check. */
export function report(checks: Check[]): string {
  const failed = checks.filter(c => !c.ok).length
  const lines = checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`)
  return [...lines, '', failed ? `${failed} check(s) failed.` : 'Everything the plugin relies on is in place.'].join('\n')
}

// terminal-browser names a tab by its browser's key and its own number; the
// plugin carries both as one id, `<key>:<tab>`.

// The JSON object a terminal-browser command prints, after any banner.
function jsonOf<T>(text: string): T | undefined {
  try {
    return JSON.parse(text.slice(text.indexOf('{'))) as T
  } catch {
    return undefined
  }
}

/** The ids of every browser's tabs, from `terminal-browser ls --json`. */
export function listTabs(text: string): string[] {
  const parsed = jsonOf<{ browsers?: { key: string; tabs?: { id: number }[] }[] }>(text)
  return (parsed?.browsers ?? []).flatMap(b => (b.tabs ?? []).map(t => `${b.key}:${t.id}`))
}

/** The `--browser` and `--tab` a `<key>:<tab>` id stands for. */
export function splitTabId(tabId: string): { browser: string; tab: string } {
  const at = tabId.lastIndexOf(':')
  return { browser: tabId.slice(0, at), tab: tabId.slice(at + 1) }
}

/**
 * The tab `terminal-browser new-tab <url>` opened, from its JSON output. When
 * it had to start a browser, `openedTab` is null and the tab is the new
 * browser's first.
 */
export function openedTab(text: string): string | undefined {
  const parsed = jsonOf<{ key?: string; openedTab?: number | null; tabs?: { id: number; active?: boolean }[] }>(text)
  if (!parsed?.key) return undefined
  const tab = parsed.openedTab ?? parsed.tabs?.find(t => t.active)?.id ?? parsed.tabs?.[0]?.id ?? 1
  return `${parsed.key}:${tab}`
}

// Marks the page, then leaves it: the mark is gone once the new page loads
// (`LANDED`), which tells a reload of the same URL from the old page still
// standing.
export function leaveScript(url: string): string {
  return `
window.__chatgptLeaving = true;
setTimeout(() => location.assign(${JSON.stringify(url)}), 50);
return JSON.stringify({ leaving: true });`
}

const LANDED = `!window.__chatgptLeaving && document.readyState !== 'loading'`

export type Job = {
  id: number
  kind: 'ask' | 'image'
  prompt: string
  status: 'queued' | 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  chatUrl?: string
  paths?: string[]
}

/** What `jobs` answers: one line per job, newest first. */
export function jobsReport(jobs: Job[], now: number): string {
  if (!jobs.length) return 'No ChatGPT jobs in this session.'
  const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`
  return [...jobs]
    .reverse()
    .map(job => {
      const took = job.endedAt ? `took ${minutes(job.endedAt - job.startedAt)}` : `for ${minutes(now - job.startedAt)}`
      const where = [job.chatUrl ? `chat ${job.chatUrl}` : '', job.paths?.length ? `saved to ${job.paths.join(', ')}` : '']
        .filter(Boolean)
        .join('; ')
      const head = `#${job.id} ${job.kind} ${job.status} (${took}): ${job.prompt.slice(0, 60)}${job.prompt.length > 60 ? '…' : ''}`
      return where ? `${head}\n  ${where}` : head
    })
    .join('\n')
}
