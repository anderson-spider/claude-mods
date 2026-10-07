const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

/** The extension for an image MIME type. */
export function extensionOf(type: string): string {
  return Object.keys(IMAGE_TYPES).find(ext => IMAGE_TYPES[ext] === type) ?? 'png'
}

// A time limit setting in minutes as milliseconds: the default when it is not a positive number, 24 h at most.
export function limitMs(raw: unknown, defaultMinutes: number): number {
  const minutes = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return Math.round(defaultMinutes * 60_000)
  return Math.round(Math.min(minutes, 24 * 60) * 60_000)
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

/** Adds a variant number only when the request produced more than one image. */
export function variantPath(base: string, index: number, count: number): string {
  return count > 1 ? base.replace(/(\.\w+)?$/, `-${index + 1}$1`) : base
}
