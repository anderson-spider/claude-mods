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

export type PageState = {
  href: string
  composer: boolean
  login: boolean
  stop: boolean
  count: number
  length: number
  images: number
  blocker: string
}

/** `saveOnly` saves the last image already generated in `chatUrl`, sending nothing (and waiting while it is still generating). */
export type ImageInput = AskInput

export type Image = { base64: string; type: string; width: number; height: number; alt: string }

/** Every image the request produced (ChatGPT sometimes draws variants), last one last. */
export type ImageResult =
  | { ok: true; url: string; images: Image[] }
  | { ok: false; error: string; url?: string; markdown?: string; timedOut?: boolean }

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

export type Check = { name: string; ok: boolean; detail: string }

// An image block of a tool's result, in the Anthropic API shape: the host
// passes it on as is, and drops the MCP shape ({ data, mimeType }) silently.
export type Preview = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** What a request came to; `error` holds only plugin error text, never ChatGPT output. */
export type Outcome = { ok: boolean; text: string; error?: string; chatUrl?: string; paths?: string[]; timedOut?: boolean; previews?: Preview[]; markdown?: string }

export type Request = {
  kind: 'ask' | 'image'
  input: AskInput
  /** For an image, the reference first. */
  filePaths: string[]
  out?: string
  maxChars?: number
}

export type ProcessRunner = (
  argv: string[],
  init?: { stdin?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export type AttachmentFiles = { stat(path: string): Promise<{ size: number }> }

export type OutputFiles = {
  write(path: string, text: string): Promise<void>
  readBytes(path: string): Promise<{ base64: string }>
}

export type OutputDeps = {
  run: ProcessRunner
  files: OutputFiles
  tmpDir(): Promise<string | undefined>
}

export type RequestDeps = {
  browser(): Promise<Browser | string>
  attachments: AttachmentFiles
  output: OutputDeps
}

export type RequestRunner = (request: Request, timeoutMs: number, onStart?: () => void) => Promise<Outcome>

export type JobNotifications = {
  toast(text: string): void
  submit(text: string): Promise<unknown>
}

export type JobDeps = { perform: RequestRunner; notifications: JobNotifications }

export type BackgroundStart = (request: Request) => Job
