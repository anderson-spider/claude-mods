export type Answer = { text: string; model?: string }

/** Where Claude Code keeps a session's transcript: the project folder is the cwd with `/` and `.` as `-`. */
export const claudeTranscriptPath = (home: string, cwd: string, sessionId: string): string =>
  `${home}/.claude/projects/${cwd.replace(/[/.]/g, '-')}/${sessionId}.jsonl`

const linesOf = (jsonl: string): string[] => jsonl.split('\n').filter(line => line.trim() !== '')

/** The position in an append-only transcript: how many non-empty lines it has. */
export const lineCount = (jsonl: string): number => linesOf(jsonl).length

/** The text of the last assistant message that has any, among the lines from `afterLine` on; corrupt lines are skipped. */
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

    if (texts.length > 0) {
      return { text: texts.join('\n\n'), model: typeof entry.message.model === 'string' ? entry.message.model : undefined }
    }
  }

  return undefined
}
