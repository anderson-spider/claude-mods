import type { Browser } from './model'

/** A backend the plugin can drive ChatGPT with; `open` resolves to a Browser, or to the reason it cannot be used (or throws it). */
export type Candidate = { name: string; open(): Promise<Browser | string> }

export type Chosen = { browser: Browser; name: string }

const REASON_MAX = 300

/**
 * The first backend that works, in the order given, with its name. When none
 * does, the string says what each one answered.
 */
export async function chooseBrowser(candidates: Candidate[]): Promise<Chosen | string> {
  const said: string[] = []
  for (const candidate of candidates) {
    try {
      const opened = await candidate.open()
      if (typeof opened !== 'string') return { browser: opened, name: candidate.name }
      said.push(`${candidate.name} said: ${opened.slice(0, REASON_MAX)}.`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      said.push(`${candidate.name} said: ${reason.slice(0, REASON_MAX)}.`)
    }
  }
  return (
    `No browser to drive ChatGPT with. ${said.join(' ')} ` +
    'Run Claude Code in a Ghostty or kitty pane with terminal-browser (https://terminal-browser.sh), or connect Claude in Chrome, ' +
    "or log in to chatgpt.com in the Claude app's built-in browser, then try again."
  )
}
