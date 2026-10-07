import { ask } from './ask'
import { readAttachments } from './attachments'
import { isChatUrl } from './browser'
import { generateImage } from './image'
import type { AskOptions, BackgroundStart, Outcome, Request, RequestDeps, RequestRunner } from './model'
import { saveAnswer, saveImages } from './output'

export async function performRequest(deps: RequestDeps, request: Request, options: AskOptions): Promise<Outcome> {
  const browser = await deps.browser()
  if (typeof browser === 'string') return { ok: false, text: browser }
  const files = await readAttachments(deps.attachments, request.filePaths)
  if (typeof files === 'string') return { ok: false, text: files }
  const input = { ...request.input, files }
  if (request.kind === 'ask') return await saveAnswer(deps.output, await ask(browser, input, options), request)
  const result = await generateImage(browser, input, options)
  return await saveImages(deps.output, result, request)
}

// A foreground request; past its wait, a chat that is still going is saved in the background.
export async function runNow(perform: RequestRunner, startJob: BackgroundStart, request: Request, timeoutMs: number): Promise<Outcome> {
  const outcome = await perform(request, timeoutMs)
  if (!outcome.timedOut || !outcome.chatUrl || !isChatUrl(outcome.chatUrl)) return outcome
  const follow = startJob({
    ...request,
    filePaths: [],
    input: { prompt: request.input.prompt, chatUrl: outcome.chatUrl, saveOnly: true },
  })
  return {
    ...outcome,
    text: `${outcome.text}\nStill going: job #${follow.id} saves it in the background when it finishes; a message will arrive (the jobs tool shows it meanwhile).`,
  }
}
