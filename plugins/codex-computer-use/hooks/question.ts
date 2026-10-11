import type { CodexAsking } from '../types'
import type { Choice } from './model'

// One approval question at a time, held until the person answers. Pure: the
// clock, the wait and the band are injected, and register.tsx owns the `$` calls.

export type Slot = { id: string; choice: Choice | null }

/** The question being asked now; register.tsx keeps one at module scope. */
export type Waiting = { current: Slot | undefined }

/** What holding a question needs from the host. */
export type QuestionHost = {
  now(): number
  /** One poll's worth of waiting. */
  wait(): Promise<unknown>
  /** Puts the question on the band, or clears it with `null`. */
  show(question: CodexAsking | null): Promise<unknown>
}

/** Holds the bridge call until the person answers; never rejects, so a failure is never an approval. */
export const holdQuestion = async (
  host: QuestionHost,
  waiting: Waiting,
  limitMs: number,
  question: CodexAsking,
  signal: AbortSignal,
): Promise<Choice | 'aborted' | 'timeout'> => {
  const slot: Slot = { id: question.id, choice: null }
  const deadline = host.now() + limitMs

  try {
    // One question at a time: a second caller waits for the first to be answered.
    while (waiting.current !== undefined) {
      if (signal.aborted) {
        return 'aborted'
      }

      await host.wait()
    }

    waiting.current = slot
    await host.show(question)

    while (slot.choice === null && !signal.aborted && host.now() < deadline) {
      await host.wait()
    }

    return slot.choice ?? (signal.aborted ? 'aborted' : 'timeout')
  } catch {
    return 'aborted'
  } finally {
    if (waiting.current === slot) {
      waiting.current = undefined
      await host.show(null).catch(() => undefined)
    }
  }
}
