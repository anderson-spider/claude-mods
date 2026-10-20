import type { Browser } from './model'

/**
 * A backend the plugin can drive ChatGPT with; `open` resolves to a Browser, or to the reason it cannot be used (or
 * throws it). `hint` is what the person can do to make it usable, as a clause that follows "or".
 */
export type Candidate = { name: string; hint: string; open(): Promise<Browser | string> }

type Chosen = { browser: Browser; name: string }

const REASON_MAX = 300

/**
 * The first backend that works, in the order given, with its name. When none
 * does, the string says what each one answered, then what to do to get one working.
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
  const hints = candidates.map(candidate => candidate.hint).join(', or ')
  return `No browser to drive ChatGPT with. ${said.join(' ')} ${hints.charAt(0).toUpperCase()}${hints.slice(1)}, then try again.`
}
