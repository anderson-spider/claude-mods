import { chatUrlError } from './browser'
import { mimeOf, typeOf } from './files'
import type { Attachment, AttachmentFiles, Request } from './model'

// Attachment checks

// Checks a local file to attach (at most 4 MiB); the backend uploads it by its path.
async function readAttachment(files: AttachmentFiles, path: string): Promise<Attachment | string> {
  if (!path.startsWith('/')) return `${path} must be an absolute path.`
  const type = mimeOf(path)
  const name = path.split('/').pop() ?? 'file'
  try {
    const stat = await files.stat(path)
    if (stat.size > 4 * 1024 * 1024) return `${path} is over 4 MiB.`
    return { name, type, path }
  } catch (error) {
    return `Could not read ${path} (${error instanceof Error ? error.message : String(error)}).`
  }
}

export async function readAttachments(files: AttachmentFiles, paths: string[]): Promise<Attachment[] | string> {
  const attachments: Attachment[] = []
  for (const path of paths) {
    const file = await readAttachment(files, path)
    if (typeof file === 'string') return file
    attachments.push(file)
  }
  return attachments
}

// Tool inputs

export const chatUrlOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

// Reads a tool call's input into a request, or the error to answer.
export function requestOf(kind: 'ask' | 'image', e: Record<string, unknown>): Request | string {
  const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : ''
  if (!prompt) return 'Give a non-empty prompt.'
  const chatUrl = chatUrlOf(e.chatUrl)
  const invalid = chatUrl === undefined ? undefined : chatUrlError(chatUrl)
  if (invalid) return invalid
  const model = typeof e.model === 'string' && e.model.trim() ? e.model.trim() : undefined
  if (model && chatUrl) return 'model is picked for a new chat; leave chatUrl out.'
  const saveOnly = e.saveOnly === true
  const filePaths = Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map(f => f.trim()) : []
  const reference = typeof e.reference === 'string' && e.reference.trim() ? e.reference.trim() : undefined
  if (reference && !typeOf(reference)) return `${reference} must be a PNG, JPEG, WebP or GIF image.`
  const out = typeof e.out === 'string' && e.out.startsWith('/') ? e.out : undefined
  const maxChars = typeof e.maxChars === 'number' && e.maxChars > 0 ? Math.floor(e.maxChars) : undefined
  return { kind, input: { prompt, chatUrl, model, saveOnly }, filePaths: reference ? [reference, ...filePaths] : filePaths, out, maxChars }
}
