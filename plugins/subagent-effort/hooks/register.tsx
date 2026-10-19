import type { BuiltinToolInputs, Hook, Register } from 'claude-code'
import { assessEffort } from './effort'
import type { Effort, EffortIo } from './effort'
import { createBreaker, createGate } from './jev'
import { isOff, OFF_TEXT, resolveAccess } from './key'
import { afterAgentCall, afterTurn, appendLine, createPending, decisionLine, formatSummary, ledgerPath, parseLedger, readAll, runsInBackground, summarize } from './ledger'
import type { Context, FileIo, Line, TurnEnd } from './ledger'

type Dollar = Parameters<Hook<'session.start'>>[0]
export const STATS_COMMAND = 'subagent-effort-stats'
export const STATS_DESCRIPTION = 'Summarize the local subagent-effort records: decisions per source, and runs, failures, median duration and tokens per model and effort, and whether Jev is reachable in this session.'
/** The type the host runs when a call names none. */
export const DEFAULT_TYPE = 'general-purpose'
// One breaker and gate for this load: a failing Jev pauses routing for every call, not per call.
const pool = { breaker: createBreaker(() => Date.now()), gate: createGate() }
function io($: Dollar): EffortIo {
  return {
    settings: async (source: 'project' | 'local') => ({ env: (await $.settings.read({ source })).env }),
    jev: {
      fetch: async (url, init) => {
        const r = await $.http.fetch(url, init)
        return { status: r.status, text: r.text, headers: r.headers }
      },
      timer: (ms, fn) => { const h = $.clock.after(ms, fn); return () => h.cancel() },
      now: () => Date.now(),
    },
    breaker: pool.breaker, gate: pool.gate,
    log: text => $.ui.log(text, { to: 'debug' }),
  }
}
const files = ($: Dollar): FileIo => ({
  exists: path => $.fs.exists(path),
  read: async path => { const text = await $.fs.read(path); return typeof text === 'string' ? text : '' },
  write: (path, text) => $.fs.write(path, text),
})
// The ledger is advisory: a failure to write or read it is one fixed debug line and never reaches the dispatch.
async function observe($: Dollar, what: string, work: () => Promise<void>) {
  try { await work() } catch { try { $.ui.log(`subagent-effort: ${what} not recorded`, { to: 'debug' }) } catch { /* Logging cannot change the host result. */ } }
}
async function record($: Dollar, what: string, line: Line) {
  await observe($, what, async () => {
    const home = await $.env.get('HOME')
    if (home) await appendLine(files($), ledgerPath(home), line)
  })
}
const stamp = () => new Date().toISOString()
// Whether this process can reach Jev now, checked the way routing checks it; the ledger only tells what past calls saw.
async function accessLine($: Dollar): Promise<string> {
  try {
    const access = await resolveAccess(io($), await $.env.get('JEV_API_KEY'))
    return access.key !== undefined ? 'Jev access in this session: ok.' : `Jev access in this session: off (${access.off}). ${OFF_TEXT[access.off]}`
  } catch { return 'Jev access in this session: could not be checked.' }
}
// A configuration problem turns Jev off until the person fixes it, so it is shown once per reason in this load, not per call.
function warnOff($: Dollar, reason: unknown, warned: Set<string>) {
  if (!isOff(reason) || warned.has(reason)) return
  warned.add(reason)
  try { $.ui.toast(`Jev off (${reason}): ${OFF_TEXT[reason]} Subagent calls go as they came.`, { timeoutMs: 10_000 }) } catch { /* A toast cannot change the dispatch. */ }
}
// The outcome is written after the result has gone back; a background launch waits for its turn.complete.
async function dispatched($: Dollar, ctx: Context, result: unknown, background: ReturnType<typeof createPending>) {
  await observe($, 'outcome', async () => {
    const ended = afterAgentCall(ctx, result, stamp())
    if (!ended) return
    if ('launched' in ended) background.add(ended.launched, ctx)
    else void record($, 'outcome', ended)
  })
}

export const register: Register = on => {
  // Background agents wait here for their turn.complete; module state of this load only, dropped on reload.
  const background = createPending(200)
  const warned = new Set<string>()
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: STATS_COMMAND, description: STATS_DESCRIPTION })
    return next(e)
  })
  // Sets the effort of every native subagent call from Jev's rating of the task, and only the effort: the model stays the
  // call's or the definition's. Jev is the authority: its effort replaces one the call came with. A fork is left alone (the
  // host ignores its effort), and when Jev is off or fails the call goes as it came, its own effort included.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const call = e as BuiltinToolInputs['Agent'] & { tool_use_id: string }
    const agentType = call.subagent_type || DEFAULT_TYPE
    if (agentType === 'fork' || typeof call.prompt !== 'string' || !call.prompt.trim()) return next(e)
    const received: Effort | null = call.effort ?? null
    const choice = await assessEffort(io($), {
      task: call.prompt, home: await $.env.get('HOME') ?? '', root: await $.session.root(), key: await $.env.get('JEV_API_KEY'),
    })
    const effort: Effort | null = choice.effort ?? received
    $.ui.log(`subagent-effort: ${agentType} → ${choice.effort ?? `as it came (${choice.jevReason})`}`, { to: 'debug' })
    warnOff($, choice.jevReason, warned)
    await record($, 'decision', decisionLine({ ts: stamp(), toolUseId: call.tool_use_id, agentType, briefChars: call.prompt.length, source: choice.effort ? 'jev' : 'off', received, effort, choice }))
    // The effort shows beside the task in the transcript, with the one it replaced.
    const was = received && received !== choice.effort ? `, was ${received}` : ''
    const result = await next(choice.effort ? { ...e, description: `${call.description} (${choice.effort}${was})`, effort: choice.effort } : e)
    // `run_in_background` is not in this host's Agent typing, and a call may send it as the string "true".
    const mode = { flag: (e as { run_in_background?: unknown }).run_in_background, surfaces: await $.session.surfaces().catch(() => []), fromSubagent: (e as { agentId?: string }).agentId !== undefined }
    await dispatched($, { toolUseId: call.tool_use_id, agentType, effort, background: runsInBackground(mode), model: call.model ?? null }, result, background)
    return result
  }).catch(async ($, e, next) => {
    // Routing is advisory: a failure before dispatch runs the call as it came.
    if (!next.called) try { $.ui.log('subagent-effort: routing failed; dispatching the call as it came.', { to: 'debug' }) } catch { /* Never block dispatch on logging. */ }
    return next(e)
  })
  // A background agent ends here, with its duration and usage, written after the host result passes on as it came.
  on('turn.complete', {}, async ($, e, next) => {
    const result = await next(e)
    const pending = e.agentId ? background.take(e.agentId) : undefined
    if (pending) void record($, 'outcome', afterTurn(pending, e as TurnEnd, stamp()))
    return result
  })
  // The host prefixes command output with the plugin name, so the texts below do not repeat it.
  on('command.run', { command: STATS_COMMAND }, async $ => {
    try {
      const access = await accessLine($)
      const home = await $.env.get('HOME')
      if (!home) return { text: `${access}\nno home directory, so no routing records.` }
      try { return { text: `${access}\n${formatSummary(summarize(parseLedger(await readAll(files($), ledgerPath(home)))))}` } } catch { return { text: `${access}\nthe routing records could not be read.` } }
    } catch { return { text: 'the routing records could not be read.' } }
  })
}
