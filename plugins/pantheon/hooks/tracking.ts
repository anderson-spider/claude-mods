import type { Native, Round, RoundStatus, SessionInfo, PanelView, PanelGroup } from './types'
import { ROLES } from './defaults'

export const MAX_NATIVES = 24
export const DEFAULT_SESSION: SessionInfo = { isRunning: false }
export const DEFAULT_VIEW: PanelView = { tab: 'agents' }

export type StepUsage = {
  input_tokens?: number; cache_read_input_tokens?: number
  cache_creation_input_tokens?: number; output_tokens?: number
}

export const roleOf = (subagentType: string): string => {
  const role = ROLES.find(role => subagentType === `pantheon:${role}`)
  if (role) return role
  if (/^pantheon:councillor-.+$/.test(subagentType)) return subagentType.slice('pantheon:'.length)
  return 'other'
}

export const spawned = (list: Native[], s: {
  id: string; type: string; task: string; model: string; now: number
}): Native[] => [
  ...list.filter(n => n.id !== s.id),
  {
    id: s.id, role: roleOf(s.type), type: s.type, task: s.task, model: s.model,
    rounds: [{ startedAt: s.now, status: 'running' as const }], ctx: 0, out: 0, steps: 0,
  },
].slice(-MAX_NATIVES)

const updateNative = (list: Native[], id: string, fn: (n: Native) => Native): Native[] =>
  list.some(n => n.id === id) ? list.map(n => n.id === id ? fn(n) : n) : list

/** Opens (or tags) the round a step belongs to, before its response streams. */
export const roundOpened = (list: Native[], s: { id: string; turnId: string; now: number }): Native[] =>
  updateNative(list, s.id, n => {
    const last = n.rounds[n.rounds.length - 1]
    if (!last || (last.status !== 'running' && last.turnId !== s.turnId)) {
      // Native continuations have no turn.start; the first step opens their round.
      return { ...n, rounds: [...n.rounds, { turnId: s.turnId, startedAt: s.now, status: 'running' }] }
    }
    if (last.status === 'running' && last.turnId === undefined) {
      return { ...n, rounds: [...n.rounds.slice(0, -1), { ...last, turnId: s.turnId }] }
    }
    return n
  })

/** Counts a finished step and its usage. */
export const stepAccounted = (list: Native[], s: { id: string; usage?: StepUsage }): Native[] =>
  updateNative(list, s.id, n => {
    const usage = s.usage
    const ctx = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0)
      + (usage?.cache_creation_input_tokens ?? 0)
    return { ...n, steps: n.steps + 1, ctx: ctx > 0 ? ctx : n.ctx, out: n.out + (usage?.output_tokens ?? 0) }
  })

export const stepped = (list: Native[], s: {
  id: string; turnId: string; now: number; usage?: StepUsage
}): Native[] => stepAccounted(roundOpened(list, s), s)

export const toolNoted = (list: Native[], id: string, text: string): Native[] =>
  updateNative(list, id, n => ({ ...n, lastTool: text }))

export const completed = (list: Native[], c: {
  id: string; reason: string; now: number
}): Native[] => updateNative(list, c.id, n => {
  const last = n.rounds[n.rounds.length - 1]
  if (!last || last.status !== 'running') return n
  const status: RoundStatus = c.reason === 'answer' ? 'done' : c.reason === 'aborted' ? 'stopped' : 'failed'
  return { ...n, rounds: [...n.rounds.slice(0, -1), { ...last, status, endedAt: c.now }] }
})

export const markNativesLost = (list: Native[]): Native[] => list.map(n => ({
  ...n, rounds: n.rounds.map(r => r.status === 'running' ? { ...r, status: 'lost' } : r),
}))

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numberOf = (v: unknown) => isNumber(v) ? v : 0
const stringOf = (v: unknown) => typeof v === 'string' ? v : ''
const isStatus = (v: unknown): v is RoundStatus =>
  v === 'running' || v === 'done' || v === 'failed' || v === 'stopped' || v === 'lost'

export const normalizeNatives = (raw: unknown): Native[] => {
  if (!Array.isArray(raw)) return []
  const list: Native[] = []
  for (const n of raw) {
    if (!isObject(n) || typeof n.id !== 'string' || !Array.isArray(n.rounds)) continue
    const rounds: Round[] = []
    for (const r of n.rounds) {
      if (!isObject(r) || !isStatus(r.status)) continue
      rounds.push({
        status: r.status, startedAt: numberOf(r.startedAt),
        ...(typeof r.turnId === 'string' ? { turnId: r.turnId } : {}),
        ...(isNumber(r.endedAt) ? { endedAt: r.endedAt } : {}),
      })
    }
    const type = stringOf(n.type)
    list.push({
      id: n.id, role: roleOf(type), type,
      task: stringOf(n.task), model: stringOf(n.model), rounds,
      ctx: numberOf(n.ctx), out: numberOf(n.out), steps: numberOf(n.steps),
      ...(typeof n.lastTool === 'string' ? { lastTool: n.lastTool } : {}),
    })
  }
  return list.slice(-MAX_NATIVES)
}

export const normalizeSession = (raw: unknown): SessionInfo => {
  if (!isObject(raw)) return { ...DEFAULT_SESSION }
  const context = isObject(raw.context) && isNumber(raw.context.window) ? {
    tokens: isNumber(raw.context.tokens) ? raw.context.tokens : null,
    window: raw.context.window,
    percent: isNumber(raw.context.percent) ? raw.context.percent : null,
  } : undefined
  const turns = Array.isArray(raw.turns) ? raw.turns.flatMap(t =>
    isObject(t) && isNumber(t.startedAt) && isNumber(t.endedAt) && t.startedAt >= 0 && t.endedAt >= t.startedAt
      ? [{ startedAt: t.startedAt, endedAt: t.endedAt }] : [])
    .sort((a, b) => a.endedAt - b.endedAt).slice(-50) : undefined
  return {
    isRunning: typeof raw.isRunning === 'boolean' ? raw.isRunning : false,
    ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
    ...(typeof raw.effort === 'string' ? { effort: raw.effort } : {}),
    ...(context ? { context } : {}),
    ...(isNumber(raw.turnStartedAt) ? { turnStartedAt: raw.turnStartedAt } : {}),
    ...(isNumber(raw.lastTurnMs) ? { lastTurnMs: raw.lastTurnMs } : {}),
    ...(turns ? { turns } : {}),
    ...(isNumber(raw.costUsd) ? { costUsd: raw.costUsd } : {}),
  }
}

const GROUPS: PanelGroup[] = ['running', 'idle']

export const normalizeView = (raw: unknown): PanelView => {
  if (!isObject(raw) || (raw.tab !== 'agents' && raw.tab !== 'jobs')) return { ...DEFAULT_VIEW }
  const collapsed = Array.isArray(raw.collapsed) ? GROUPS.filter(g => (raw.collapsed as unknown[]).includes(g)) : []
  return { tab: raw.tab, ...(collapsed.length ? { collapsed } : {}) }
}
export const viewTab = (v: PanelView, tab: PanelView['tab']): PanelView => ({ ...v, tab })
export const viewToggled = (v: PanelView, group: PanelGroup): PanelView => {
  const rest = (v.collapsed ?? []).filter(g => g !== group)
  const collapsed = (v.collapsed ?? []).includes(group) ? rest : GROUPS.filter(g => g === group || rest.includes(g))
  const { collapsed: _drop, ...base } = v
  return { ...base, ...(collapsed.length ? { collapsed } : {}) }
}

export const sessionStarted = (s: SessionInfo, now: number): SessionInfo =>
  ({ ...s, isRunning: true, turnStartedAt: now })
export const sessionCompleted = (s: SessionInfo, durationMs: number): SessionInfo => {
  const startedAt = s.turnStartedAt
  const endedAt = startedAt === undefined ? undefined : startedAt + durationMs
  const turns = s.isRunning && isNumber(startedAt) && isNumber(endedAt) && durationMs >= 0
    ? [...(s.turns ?? []), { startedAt, endedAt }].filter(t => t.endedAt >= endedAt - 900_000).slice(-50)
    : s.turns
  return { ...s, isRunning: false, lastTurnMs: durationMs, ...(turns ? { turns } : {}) }
}
export const sessionStepped = (s: SessionInfo, model: string, effort: string | undefined): SessionInfo =>
  ({ ...s, model, effort })
export const sessionMeasured = (s: SessionInfo, context: {
  tokens?: number | null; window: number; percent?: number | null
}, cost?: { usd: number }): SessionInfo => ({ ...s, context: {
  tokens: context.tokens ?? null, window: context.window, percent: context.percent ?? null,
}, ...(cost && Number.isFinite(cost.usd) ? { costUsd: cost.usd } : {}) })

const shorten = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return n <= 0 ? '' : one.length > n ? `${one.slice(0, Math.max(0, n - 1)).trimEnd()}…` : one
}

const SECRETS: [RegExp, string][] = [
  [/(authorization\s*[:=]\s*)(bearer\s+|basic\s+)?\S+/gi, '$1$2•••'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 •••'],
  [/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g, '•••'],
  [/((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|pwd)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1•••'],
  [/(--(?:token|password|api-key|secret)[= ])\S+/gi, '$1•••'],
  [/(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=)\S+/g, '$1•••'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@]+@/gi, '$1•••@'],
]

const redact = (s: string) => SECRETS.reduce((t, [re, to]) => t.replace(re, to), s)

export const describeTool = (tool: string, input: unknown): string => {
  const i = isObject(input) ? input : {}
  const path = typeof i.file_path === 'string' ? i.file_path.split(/[\\/]/).slice(-2).join('/') : ''
  const what = typeof i.command === 'string' ? i.command
    : path || (typeof i.pattern === 'string' ? i.pattern : typeof i.url === 'string' ? i.url
      : typeof i.description === 'string' ? i.description : '')
  return shorten(redact(what ? `${tool} ${what}` : tool), 64)
}
