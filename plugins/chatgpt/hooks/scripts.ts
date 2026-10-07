// The page parts every script relies on, kept in one place so /chatgpt-doctor
// checks the same selectors the scripts use. They follow chatgpt.com as of 2026-10: when the UI
// changes, run /chatgpt-doctor, fix them here and check them in the browser (`terminal-browser
// action -- eval`) before trusting the tests, which only cover the flow.
export const COMPOSER = `document.querySelector('.ProseMirror[contenteditable=true], #prompt-textarea')`
export const LOGIN = `(!!document.querySelector('[data-testid=login-button]') || /\\/auth\\/|\\/log-?in/.test(location.pathname))`
const STOP = `(!!document.querySelector('[data-testid=stop-button]') || [...document.querySelectorAll('button')].some(b => /^(Parar|Stop)/i.test(b.getAttribute('aria-label') || '')))`
const MODEL_BUTTON = `([...document.querySelectorAll('button')].find(b => /^(Selecionar modelo|Select model|Model selector)/i.test(b.getAttribute('aria-label') || '')) || document.querySelector('[data-testid=model-switcher-dropdown-button]'))`
const ANSWERS = `[...document.querySelectorAll('[data-markdown-text-style]')]`
// A generated image: a large picture whose alt says so ("Imagem 1 gerada",
// "Generated image 1"); an attached reference has its file name instead.
export const GENERATED = `[...document.querySelectorAll('main img')].filter(i => i.naturalWidth > 500 && /gerad|generated/i.test(i.alt || ''))`
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

// Marks the page, then leaves it: the mark is gone once the new page loads
// (`LANDED`), which tells a reload of the same URL from the old page still
// standing.
export function leaveScript(url: string): string {
  return `
window.__chatgptLeaving = true;
setTimeout(() => location.assign(${JSON.stringify(url)}), 50);
return JSON.stringify({ leaving: true });`
}

export const LANDED = `!window.__chatgptLeaving && document.readyState !== 'loading'`

// Every page script returns JSON.stringify(...): terminal-browser's eval
// prints a string result as a JSON literal.
export function parseOutput<T>(text: string): T {
  try {
    return JSON.parse(JSON.parse(text.trim())) as T
  } catch {
    throw new Error(`unexpected browser output: ${text.slice(0, 200)}`)
  }
}
