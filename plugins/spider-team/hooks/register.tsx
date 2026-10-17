import type { BuiltinToolInputs, Hook, Register } from 'claude-code'
import { SPECS, roleOf } from './roles'
import { defaultOf } from './router'
import { assessRoute } from './effort'
import type { EffortIo } from './effort'
import { createBreaker, createGate } from './jev'
import { createRoleCache, readOnlyGit, refusal, UNCHECKED } from './guard'
import { createSampler, judgeAnswer, judgeEvery } from './judge'
import { isOff, OFF_TEXT, resolveAccess } from './key'
import { afterAgentCall, afterTurn, appendLine, createPending, decisionLine, formatSummary, ledgerPath, parseLedger, readAll, summarize, withJudge } from './ledger'
import type { Ended, FileIo, Line, OutcomeLine, TurnEnd } from './ledger'

type Dollar = Parameters<Hook<'session.start'>>[0]
export const EMPTY = 'spider-team: empty task.'
export const STATS_COMMAND = 'spider-team-stats'
export const STATS_DESCRIPTION = 'Summarize the local spider-team routing records: runs, failures, judged short runs, duration, cost and Jev confidence per role and pair, and whether Jev is reachable in this session.'
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
// The outcome judge reads a completed run's answer when the sampler says it is due; the answer goes only to Jev, redacted,
// and a run left out or any failure leaves `judge: null`.
async function judged($: Dollar, { line, answer }: Ended, due: () => boolean): Promise<OutcomeLine> {
  if (!answer.trim() || !due()) return line
  try {
    const judge = await judgeAnswer(io($, judging), { answer, home: await $.env.get('HOME') ?? '', root: await $.session.root(), key: await $.env.get('JEV_API_KEY') })
    return withJudge(line, judge)
  } catch { return line }
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
  try { $.ui.toast(`Jev off (${reason}): ${OFF_TEXT[reason]} Spider agents run at their role defaults.`, { timeoutMs: 10_000 }) } catch { /* A toast cannot change the dispatch. */ }
}
// The agent list names each agent's type; a Spider role's id is cached with its role, any other agent's with null. An id
// the list does not name yet is asked again next time.
async function roleOfAgent($: Dollar, agentId: string, cache: ReturnType<typeof createRoleCache>) {
  if (!cache.has(agentId)) for (const agent of await $.agent.list()) cache.set(agent.id, roleOf(agent.type) ?? null)
  return cache.get(agentId) ?? null
}

export const register: Register = (on, options) => {
  const due = createSampler(judgeEvery(options.judgeEvery))
  // Background agents wait here for their turn.complete; module state of this load only, dropped on reload.
  const background = createPending(200)
  const agents = createRoleCache(200)
  const warned = new Set<string>()
  on('session.start', async ($, e, next) => {
    await $.agent.register({ ...SPECS.analyst, name: 'analyst' })
    await $.agent.register({ ...SPECS.planner, name: 'planner' })
    await $.agent.register({ ...SPECS.reviewer, name: 'reviewer' })
    await $.command.register({ name: STATS_COMMAND, description: STATS_DESCRIPTION })
    return next(e)
  })
  // Routing rewrites the Agent call rather than hooking `agent.spawn`: the spawn takes a model but no effort, so effort
  // would need a second hook rewriting every `turn.step` of the agent, and the outcome comes from this call's result.
  // Picks model and effort for a Spider role: Jev through the router table and the role floor, else the role default. The
  // call's own model and effort are overwritten. The decision and the outcome go to the local ledger; the result passes on as it came.
  // The outcome, with its judge, is written once the result has gone back, so the lead never waits on the judge; a reload
  // drops one still running, which the advisory ledger can afford.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const call = e as BuiltinToolInputs['Agent'] & { tool_use_id: string }
    const role = roleOf(call.subagent_type)
    if (!role) return next(e)
    if (!call.prompt.trim()) return { deny: EMPTY }
    const choice = await assessRoute(io($), {
      role, task: call.prompt,
      home: await $.env.get('HOME') ?? '', root: await $.session.root(), key: await $.env.get('JEV_API_KEY'),
    })
    const model = choice.model, effort = choice.effort
    $.ui.log(`spider-team: ${role} → ${model}/${effort} (${choice.source})`, { to: 'debug' })
    warnOff($, choice.jevReason, warned)
    await record($, 'decision', decisionLine({ ts: stamp(), toolUseId: call.tool_use_id, role, briefChars: call.prompt.length, choice }))
    // The pair shows beside the task in the transcript, with the reason when Jev was off.
    const why = choice.source === 'default' && choice.jevReason ? `, default: ${choice.jevReason}` : ''
    const result = await next({ ...e, description: `${call.description} (${model}/${effort}${why})`, model, effort })
    await observe($, 'outcome', async () => {
      const ended = afterAgentCall({ toolUseId: call.tool_use_id, role, pair: { model, effort } }, result, stamp())
      if (!ended) return
      if ('launched' in ended) background.add(ended.launched, { toolUseId: call.tool_use_id, role, pair: { model, effort } })
      else void observe($, 'outcome', async () => record($, 'outcome', await judged($, ended, due)))
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
  // A background agent ends here, with its duration, usage and judged answer, written after the host result passes on as it came.
  on('turn.complete', {}, async ($, e, next) => {
    const result = await next(e)
    const pending = e.agentId ? background.take(e.agentId) : undefined
    if (pending) void observe($, 'outcome', async () => record($, 'outcome', await judged($, afterTurn(pending, e as TurnEnd, stamp()), due)))
    return result
  })
  // Spider roles run Bash for read-only git only, enforced here rather than trusted to the prompt: a command from a Spider
  // agent's loop that is not one read-only git command is refused. The main loop and other agents pass untouched. When the
  // agent cannot be told, the command is refused, so a failure never lets a Spider role run an unchecked command.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!e.agentId) return next(e)
    const role = await roleOfAgent($, e.agentId, agents)
    if (!role || readOnlyGit((e as BuiltinToolInputs['Bash']).command)) return next(e)
    return { deny: refusal(role) }
  }).catch(async ($, e, next) => (next.called ? next(e) : { deny: UNCHECKED }))
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
