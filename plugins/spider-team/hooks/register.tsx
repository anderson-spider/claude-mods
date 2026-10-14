import type { BuiltinToolInputs, Hook, Register } from 'claude-code'
import { SPECS, roleOf } from './roles'
import { assessRoute } from './effort'
import type { EffortIo } from './effort'
import { createBreaker, createGate } from './jev'

type Dollar = Parameters<Hook<'session.start'>>[0]
export const BASE_REF = 'spider-team: developer needs worktree.baseRef "head" in the merged settings so its worktree starts from your HEAD.'
export const EMPTY = 'spider-team: empty task.'
const breaker = createBreaker(() => Date.now())
const gate = createGate()
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
    breaker, gate,
    log: text => $.ui.log(text, { to: 'debug' }),
  }
}
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.agent.register({ ...SPECS.analyst, name: 'analyst' })
    await $.agent.register({ ...SPECS.developer, name: 'developer' })
    await $.agent.register({ ...SPECS.reviewer, name: 'reviewer' })
    await $.agent.register({ ...SPECS.architect, name: 'architect' })
    return next(e)
  })
  // Picks model and effort for a Spider role: Jev through the router table, else the role default. The call's own model and effort are overwritten.
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
    // The pair shows beside the task in the transcript.
    return next({ ...e, description: `${call.description} (${model}/${effort})`, model, effort })
  }).catch(async ($, e, next) => {
    // Routing is advisory: a failure before dispatch runs the call as asked, with the role's own model and effort.
    try { $.ui.log('spider-team: routing failed; dispatching unchanged.', { to: 'debug' }) } catch { /* Never block dispatch on logging. */ }
    return next(e)
  })
}
