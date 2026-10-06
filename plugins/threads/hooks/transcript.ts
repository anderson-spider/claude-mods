export type Answer = { text: string; model?: string }

/** Where Claude Code keeps a session's transcript: the project folder is the cwd with every character that is not a letter or digit as `-`. */
export const claudeTranscriptPath = (home: string, cwd: string, sessionId: string): string =>
  `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`

const linesOf = (jsonl: string): string[] => jsonl.split('\n').filter(line => line.trim() !== '')

/** The position in an append-only transcript: how many non-empty lines it has. */
export const lineCount = (jsonl: string): number => linesOf(jsonl).length

/** The text of the last assistant message among the lines from `afterLine` on, or `undefined` when that message has none (a helper that stopped at a tool call has not answered); corrupt lines are skipped. */
export const claudeAnswerAfter = (jsonl: string, afterLine: number): Answer | undefined => {
  const lines = linesOf(jsonl).slice(afterLine)

  for (const line of lines.reverse()) {
    let entry: any

    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    if (entry?.type !== 'assistant' || !Array.isArray(entry.message?.content)) {
      continue
    }

    const texts = entry.message.content.filter((block: any) => block?.type === 'text' && typeof block.text === 'string').map((block: any) => block.text as string)

    return texts.length > 0 ? { text: texts.join('\n\n'), model: typeof entry.message.model === 'string' ? entry.message.model : undefined } : undefined
  }

  return undefined
}
