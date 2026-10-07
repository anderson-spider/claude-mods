import { mimeOf } from './files'
import type { Attachment, AttachmentFiles } from './model'

// Checks a local file to attach (at most 4 MiB); terminal-browser uploads it by path.
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
