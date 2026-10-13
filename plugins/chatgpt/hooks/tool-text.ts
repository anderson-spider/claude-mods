/** The first JSON object in a tool's text: the tools print one, then a note about the tabs. */
export function leadingJson<T>(text: string): T | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let quoted = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as T
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/**
 * What a page script printed, as a string. The tool cuts the result off at the
 * notes it adds after it (`Tab Context:`, `(captured at …)`), and a tool may
 * print a string result as a JSON literal, which is decoded here.
 */
export function scriptText(text: string): string {
  const cut = text.search(/\n\n(?:Tab Context:|\(captured at )/)
  const body = (cut < 0 ? text : text.slice(0, cut)).trim()
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'string') return parsed
  } catch {
    // Not a JSON literal: the text is the result.
  }
  return body
}
