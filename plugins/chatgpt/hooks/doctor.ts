import type { Browser, Check, TabHolder } from './model'
import { CHATGPT_URL, ORIGIN, chatUrlError, findTab, parseOutput } from './browser'
import { DOCTOR_SCRIPT } from './scripts'

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
export async function diagnose(browser: Pick<Browser, 'tabs' | 'openTab' | 'js' | 'waitFor'>, chatUrl: string | undefined, tab: TabHolder): Promise<Check[]> {
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
