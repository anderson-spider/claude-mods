// Report observation is outside the dispatch queue; the injected finish callback revalidates inside it.
import { listAgents } from './herdr'
import type { Listed, Run } from './herdr'
import type { Finish } from './finish'
import type { Role } from './roles'
import { completedReport } from './report'

export type ReportStat = { kind: 'file' | 'dir' | 'other'; isLink: boolean; size: number; mtimeMs: number }
export type ReportIo = { stat: (path: string) => Promise<ReportStat | undefined>; read: (path: string) => Promise<string> }
export type Tracked = { workspace: string; effectiveAgent: string; pane: string; uuid: string; role: Role; report: string; submittedAt: number; baselineMtime: number }
export type AutoCloser = ReturnType<typeof createAutoCloser>

export function codexUuid(agent: Listed | undefined): string | undefined {
  const session = agent?.agent_session
  return agent?.agent === 'codex' && session?.kind === 'id' && session.source === 'herdr:codex'
    && typeof session.value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.value) ? session.value : undefined
}

/** A fresh report read bracketed by unchanged regular-file metadata. */
export async function readyReport(io: ReportIo, role: Role, report: string, freshAfter: number): Promise<boolean> {
  try {
    const metadata = await io.stat(report)
    const before = metadata && { ...metadata }
    if (!before || before.kind !== 'file' || before.isLink !== false || !Number.isFinite(before.mtimeMs) || !Number.isFinite(before.size)
      || !Number.isFinite(freshAfter)
      || before.mtimeMs <= freshAfter) return false
    const text = await io.read(report)
    const after = await io.stat(report)
    return !!after && after.kind === 'file' && after.isLink === false && before.size === after.size && before.mtimeMs === after.mtimeMs && completedReport(role, text)
  } catch { return false }
}

export type AutoCloseIo = ReportIo & {
  run: Run
  timer: (ms: number, fn: () => Promise<void>) => () => void
  finish: (tracked: Tracked, current: () => boolean) => Promise<Finish | undefined>
  log: (text: string) => void
}

export function createAutoCloser(io?: AutoCloseIo) {
  const entries = new Map<string, Tracked>()
  const pending = new Set<Tracked>()
  const key = (entry: Pick<Tracked, 'workspace' | 'effectiveAgent'>) => `${entry.workspace}:${entry.effectiveAgent}`
  let cancel: (() => void) | undefined, busy = false, alive = true
  const log = (text: string, observer = io) => { try { observer?.log(text) } catch { /* Observation never changes a tool result. */ } }
  const cancelTimer = () => { try { cancel?.() } catch { log('codex-team: report timer cancellation failed') } cancel = undefined }
  const current = (entry: Tracked) => alive && entries.get(key(entry)) === entry
  const forget = (workspace: string, effectiveAgent: string) => {
    entries.delete(`${workspace}:${effectiveAgent}`)
    if (!entries.size) cancelTimer()
  }
  const observe = async (observer = io) => {
    if (!alive || busy || !entries.size || !observer) return
    busy = true
    try {
      const snapshot = [...entries.values()]
      const agents = await listAgents(observer.run, { timeoutMs: 2_000 })
      if (typeof agents === 'string') { log('codex-team: report observation failed', observer); return }
      const results = await Promise.allSettled(snapshot.map(async entry => {
        if (!current(entry) || pending.has(entry)) return
        const agent = agents.find(agent => agent.workspace_id === entry.workspace && agent.name === entry.effectiveAgent)
        if (!agent || agent.pane_id !== entry.pane || codexUuid(agent) !== entry.uuid) {
          if (current(entry)) forget(entry.workspace, entry.effectiveAgent)
          return
        }
        if (!['idle', 'done'].includes(agent.agent_status ?? '') || !await readyReport(observer, entry.role, entry.report, Math.max(entry.submittedAt, entry.baselineMtime)) || !current(entry)) return
        pending.add(entry)
        try {
          const result = await observer.finish(entry, () => current(entry))
          if (result?.closed) {
            if (current(entry)) forget(entry.workspace, entry.effectiveAgent)
            if (!result.archived) log('codex-team: report finish archive pending', observer)
          } else if (result?.reason === 'expected agent changed' && current(entry)) forget(entry.workspace, entry.effectiveAgent)
        } finally { pending.delete(entry) }
      }))
      if (results.some(result => result.status === 'rejected')) log('codex-team: report observation failed', observer)
    } catch { log('codex-team: report observation failed', observer) } finally { busy = false }
  }
  return {
    track(entry: Tracked, timerIo = io) {
      if (!alive || !timerIo) return
      entries.set(key(entry), entry)
      if (!cancel) {
        try {
          // Keep this timer's I/O pinned to the hook that armed it, including after rearming.
          cancel = timerIo.timer(2_000, () => observe(timerIo))
          io = timerIo
        } catch {
          entries.delete(key(entry)); log('codex-team: report observation unavailable', timerIo)
        }
      }
    },
    current, forget, observe,
    stop() { alive = false; cancelTimer(); entries.clear() },
  }
}
