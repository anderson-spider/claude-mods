/** The message of an error, or the value itself as text when it is not an Error. */
export const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Sets the first note of a record's `error`; each later one goes on its own line. */
export function appendNote(target: { error?: string }, text: string): void {
  target.error = target.error ? `${target.error}\n${text}` : text
}
