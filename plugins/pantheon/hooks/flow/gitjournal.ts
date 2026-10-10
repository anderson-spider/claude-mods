// The git gate's journal entry: what the gate denied (enforce) or would have denied (shadow), in the active plan's journal.
// Pure: file access, the clock and the per-plan queue are injected, and nothing here touches `$`. Nothing is written when no
// plan is active: the gate protects without one, but a journal belongs to a plan and the gate creates none of its own.
import { activePlanId } from './controller'
import type { Serial } from './controller'
import { redactSecrets } from './redact'
import { appendJournal } from './store'
import type { FlowFs, JournalInput } from './store'
import type { Mode } from './types'

export type GitJournalCtx = {
  fs: FlowFs
  root: string
  mode: Mode
  now: () => Promise<number>
  serial: (planId: string) => Serial
  warn: (text: string) => void
}

export type GitNote = {
  actor: string
  /** The task the actor works on, for a developer. */
  task?: string
  reason: string
  /** The git commands of the line, without their arguments. */
  summary: string
}

const REASON_MAX = 600
const DETAIL_MAX = 300

/** Secrets out first (a reason can quote a path or a refspec), then the cut. */
function clean(text: string, max: number): string {
  const safe = redactSecrets(text)
  return safe.length > max ? `${safe.slice(0, max - 3)}...` : safe
}

/**
 * Journals one denial of the git gate, in the shape the ownership denials use: `action: block` in enforce, `action: allow`
 * with `wouldBe: block` in shadow. The plan is the one `activePlanId` names (the id it was approved under), and the text goes
 * through `redactSecrets` first. Best effort: a failure is warned and never changes the gate's answer.
 */
export async function noteGit(ctx: GitJournalCtx, note: GitNote): Promise<void> {
  try {
    const planId = await activePlanId(ctx)
    if (!planId) return
    const at = await ctx.now()
    const isEnforce = ctx.mode === 'enforce'
    const entry: JournalInput = {
      at, kind: 'decision', event: 'git', condition: 'git_gate', mode: ctx.mode,
      ...(note.task ? { task: note.task } : {}),
      action: isEnforce ? 'block' : 'allow', ...(isEnforce ? {} : { wouldBe: 'block' as const }),
      reason: clean(note.reason, REASON_MAX),
      detail: clean(`${note.actor}: ${note.summary}`, DETAIL_MAX),
    }
    await ctx.serial(planId)(() => appendJournal(ctx.fs, ctx.root, planId, entry))
  } catch (error) {
    try { ctx.warn(`git gate journal: ${error instanceof Error ? error.message : String(error)}`) } catch { /* A failing warning changes nothing. */ }
  }
}
