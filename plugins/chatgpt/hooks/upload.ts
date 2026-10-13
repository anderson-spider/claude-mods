import type { Attachment } from './model'
import { uploadBody } from './scripts'

export function bytesOf(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0))
}

// Encodes in slices, so a large file never becomes one huge argument list.
export function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
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
