import type { BuiltinToolInputs, Hook, Register } from 'claude-code'
import { SPECS, roleOf } from './roles'
import { defaultOf } from './router'
import { assessRoute } from './effort'
import type { EffortIo } from './effort'
import { createBreaker, createGate } from './jev'
import { judgeAnswer } from './judge'
import { afterAgentCall, afterTurn, appendLine, createPending, decisionLine, formatSummary, ledgerPath, parseLedger, readAll, summarize, withJudge } from './ledger'
import type { Ended, FileIo, Line, OutcomeLine, TurnEnd } from './ledger'

type Dollar = Parameters<Hook<'session.start'>>[0]
export const BASE_REF = 'spider-team: developer needs worktree.baseRef "head" in the merged settings so its worktree starts from your HEAD.'
export const EMPTY = 'spider-team: empty task.'
export const STATS_COMMAND = 'spider-team-stats'
export const STATS_DESCRIPTION = 'Summarize the local spider-team routing records: runs, failures, judged short runs, duration, cost and Jev confidence per role and pair.'
// Routing and the outcome judge each have their own breaker and gate, so a slow or failing judge never turns routing off.
type Pool = Pick<EffortIo, 'breaker' | 'gate'>
const routing: Pool = { breaker: createBreaker(() => Date.now()), gate: createGate() }
const judging: Pool = { breaker: createBreaker(() => Date.now()), gate: createGate() }
function io($: Dollar, pool: Pool = routing): EffortIo {
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
  try { await work() } catch { try { $.ui.log(`spider-team: ${what} not recorded`, { to: 'debug' }) } catch { /* Logging cannot change the host result. */ } }
}
async function record($: Dollar, what: string, line: Line) {
  await observe($, what, async () => {
    const home = await $.env.get('HOME')
    if (home) await appendLine(files($), ledgerPath(home), line)
  })
}
// The outcome judge reads a completed run's answer; the answer goes only to Jev, redacted, and any failure leaves `judge: null`.
async function judged($: Dollar, { line, answer }: Ended): Promise<OutcomeLine> {
  if (!answer.trim()) return line
  try {
    const judge = await judgeAnswer(io($, judging), { answer, home: await $.env.get('HOME') ?? '', root: await $.session.root(), key: await $.env.get('JEV_API_KEY') })
    return withJudge(line, judge)
  } catch { return line }
}
const stamp = () => new Date().toISOString()

export const register: Register = on => {
  // Background agents wait here for their turn.complete; module state of this load only, dropped on reload.
  const background = createPending(200)
  on('session.start', async ($, e, next) => {
    await $.agent.register({ ...SPECS.analyst, name: 'analyst' })
    await $.agent.register({ ...SPECS.developer, name: 'developer' })
    await $.agent.register({ ...SPECS.reviewer, name: 'reviewer' })
    await $.agent.register({ ...SPECS.architect, name: 'architect' })
    await $.command.register({ name: STATS_COMMAND, description: STATS_DESCRIPTION })
    return next(e)
  })
  // Picks model and effort for a Spider role: Jev through the router table and the role floor, else the role default. The
  // call's own model and effort are overwritten. The decision and the outcome go to the local ledger; the result passes on as it came.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const call = e as BuiltinToolInputs['Agent'] & { tool_use_id: string }
    const role = roleOf(call.subagent_type)
    if (!role) return next(e)
    if (!call.prompt.trim()) return { deny: EMPTY }
    if (role === 'developer') {
      const settings = await $.settings.read() as { worktree?: { baseRef?: string } }
      if (settings.worktree?.baseRef !== 'head') return { deny: BASE_REF }
    }
    const choice = await assessRoute(io($), {
      role, task: call.prompt,
      home: await $.env.get('HOME') ?? '', root: await $.session.root(), key: await $.env.get('JEV_API_KEY'),
    })
    const model = choice.model, effort = choice.effort
    $.ui.log(`spider-team: ${role} → ${model}/${effort} (${choice.source})`, { to: 'debug' })
    await record($, 'decision', decisionLine({ ts: stamp(), toolUseId: call.tool_use_id, role, choice }))
    // The pair shows beside the task in the transcript.
    const result = await next({ ...e, description: `${call.description} (${model}/${effort})`, model, effort })
    await observe($, 'outcome', async () => {
      const ended = afterAgentCall({ toolUseId: call.tool_use_id, role, pair: { model, effort } }, result, stamp())
      if (!ended) return
      if ('launched' in ended) background.add(ended.launched, { toolUseId: call.tool_use_id, role, pair: { model, effort } })
      else await record($, 'outcome', await judged($, ended))
    })
    return result
  }).catch(async ($, e, next) => {
    // Routing is advisory: a failure before dispatch runs the call with the role's default pair, never the lead's.
    if (next.called) return next(e)
    try { $.ui.log('spider-team: routing failed; dispatching the role default.', { to: 'debug' }) } catch { /* Never block dispatch on logging. */ }
    const call = e as BuiltinToolInputs['Agent']
    let pair
    try { const role = roleOf(call.subagent_type); pair = role && defaultOf(role) } catch { pair = undefined }
    return pair ? next({ ...e, description: `${call.description} (${pair.model}/${pair.effort})`, model: pair.model, effort: pair.effort }) : next(e)
  })
  // A background agent ends here, with its duration, usage and judged answer; the host result passes on as it came.
  on('turn.complete', {}, async ($, e, next) => {
    const result = await next(e)
    const pending = e.agentId ? background.take(e.agentId) : undefined
    if (pending) await record($, 'outcome', await judged($, afterTurn(pending, e as TurnEnd, stamp())))
    return result
  })
  // The host prefixes command output with the plugin name, so the texts below do not repeat it.
  on('command.run', { command: STATS_COMMAND }, async $ => {
    try {
      const home = await $.env.get('HOME')
      if (!home) return { text: 'no home directory, so no routing records.' }
      return { text: formatSummary(summarize(parseLedger(await readAll(files($), ledgerPath(home))))) }
    } catch { return { text: 'the routing records could not be read.' } }
  })
}
