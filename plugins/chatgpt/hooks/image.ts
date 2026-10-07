import type { AskInput, AskOptions, Browser, Image, ImageResult } from './model'
import { LOAD_MS, prepare } from './browser'
import { compose, readAnswer, send, stopped, unfinished, watch } from './conversation'
import { GENERATED, imageScript, parseOutput } from './scripts'

export async function generateImage(browser: Browser, input: AskInput, options: AskOptions = {}): Promise<ImageResult> {
  const timeoutMs = options.timeoutMs ?? 6 * 60_000
  const pollMs = options.pollMs ?? 5000
  const progress = options.progress ?? (() => {})
  const tab = options.tab ?? {}

  if (input.saveOnly && input.chatUrl === undefined) return { ok: false, error: 'saveOnly needs the chatUrl of the chat with the image.' }
  const ready = await prepare(browser, input, { progress, tab, busy: input.saveOnly })
  if (!ready.ok) return ready
  const { tabId } = ready

  const start = ready.page
  // Saving what the chat holds: wait while it still generates, then take the last image.
  if (input.saveOnly) {
    const { end, page: state } = await watch(browser, tabId, start, {
      before: start.count,
      pollMs,
      timeoutMs,
      until: p => !p.stop && 'finished',
      onPoll: () => progress('waiting for the image to finish'),
    })
    if (end !== 'finished') return unfinished(state.href, state, timeoutMs, 'finished image', 'generating')
    // A freshly opened chat shows the composer before its images load.
    await browser.waitFor(tabId, `${GENERATED}.length > 0`, LOAD_MS)
    return readImages(browser, tabId, state.href, 1, progress)
  }

  const failed = await compose(browser, tabId, input, progress)
  if (failed) return { ok: false, url: start.href, error: failed }

  const sent = await send(browser, tabId, input.prompt)
  if (!sent.ok) return { ok: false, url: start.href, error: sent.text }

  progress('waiting for the image')
  const { end, page: state } = await watch(browser, tabId, start, {
    before: start.count,
    pollMs,
    timeoutMs,
    until: (p, settled) => (p.images > start.images && !p.stop ? 'image' : settled && 'text'),
    onPoll: p => progress(p.stop ? 'generating the image' : 'waiting for the image'),
  })
  if (end === 'blocked') return stopped(state)
  if (end === 'timeout') return unfinished(state.href, state, timeoutMs, 'image', 'generating')
  // No image, and a settled text answer: a refusal or a question back.
  if (end === 'text') {
    const read = await readAnswer(browser, tabId)
    return {
      ok: false,
      url: read.url,
      markdown: read.markdown,
      error: 'ChatGPT answered with text instead of an image (a refusal or a question); relay it, do not rephrase around a refusal.',
    }
  }
  return readImages(browser, tabId, state.href, state.images - start.images, progress)
}

// Reads the chat's last `count` generated images back, oldest first.
async function readImages(
  browser: Pick<Browser, 'js'>,
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
