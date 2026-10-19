// The plugin's words in English and Brazilian Portuguese, and how the language is chosen.
import type { SpiderPhase } from '../types'
import type { SpiderConfig } from './config'

export type Lang = 'en' | 'pt-BR'

export type Strings = {
  agent: string
  agents: string
  counts: { running: string }
  phase: Record<SpiderPhase, string>
  task: { pending: string; blocked: string; running: string; reviewing: string; completed: string; failed: string; cancelled: string }
  pane: {
    title: string; heading: string; noRun: string; noAgents: string; plan: string; timeline: string
    agentsRunning: string; agentsFinished: string; agentsPlanned: string
    working: string; idle: string; subagents: string; sub: string; session: string; cost: string; time: string
    steps: string; calls: string; callsOne: string; waits: string; more: string; justNow: string; minutesAgo: string; hoursAgo: string; now: string
  }
  command: { opened: string; waits: string; closed: string; usage: string }
  na: string
}

/** `n` and the word for it: `one` for exactly one, else `many`. */
export const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** `{n}` in a string replaced by `n`. */
export const fill = (text: string, n: number | string): string => text.replace('{n}', String(n))

export const STRINGS: Record<Lang, Strings> = {
  en: {
    agent: 'agent',
    agents: 'agents',
    counts: { running: 'running' },
    phase: { understand: 'Understand', plan: 'Plan', investigate: 'Investigate', execute: 'Execute', review: 'Review', verify: 'Verify', complete: 'Complete', cancelled: 'Cancelled', failed: 'Failed' },
    task: { pending: 'pending', blocked: 'blocked', running: 'running', reviewing: 'reviewing', completed: 'accepted', failed: 'failed', cancelled: 'cancelled' },
    pane: {
      title: 'Spider agents', heading: 'Panel', noRun: 'no spider-team run', noAgents: 'No agents yet', plan: 'Plan', timeline: 'Last 15 minutes',
      agentsRunning: 'Agents · running', agentsFinished: 'Agents · finished', agentsPlanned: 'Agents · planned',
      working: 'working', idle: 'idle', subagents: 'subagents', sub: 'sub', session: 'Session', cost: 'cost', time: 'time',
      steps: 'steps', calls: 'calls', callsOne: 'call', waits: 'waits', more: '+{n} more', justNow: 'just now', minutesAgo: '{n} min ago', hoursAgo: '{n} h ago', now: 'now',
    },
    command: { opened: 'Agents pane open.', waits: 'The agents pane waits for room:', closed: 'Agents pane closed.', usage: 'Usage: /spider-agents [open|close]' },
    na: 'N/A',
  },
  'pt-BR': {
    agent: 'agente',
    agents: 'agentes',
    counts: { running: 'rodando' },
    phase: { understand: 'Entender', plan: 'Planejar', investigate: 'Investigar', execute: 'Executar', review: 'Revisão', verify: 'Verificar', complete: 'Concluído', cancelled: 'Cancelado', failed: 'Falhou' },
    task: { pending: 'pendente', blocked: 'bloqueada', running: 'rodando', reviewing: 'em revisão', completed: 'aceita', failed: 'falhou', cancelled: 'cancelada' },
    pane: {
      title: 'Agentes spider', heading: 'Painel', noRun: 'nenhuma execução do spider-team', noAgents: 'Nenhum agente ainda', plan: 'Plano', timeline: 'Últimos 15 minutos',
      agentsRunning: 'Agentes · rodando', agentsFinished: 'Agentes · terminados', agentsPlanned: 'Agentes · planejados',
      working: 'trabalhando', idle: 'ocioso', subagents: 'subagentes', sub: 'sub', session: 'Sessão', cost: 'custo', time: 'tempo',
      steps: 'passos', calls: 'chamadas', callsOne: 'chamada', waits: 'aguarda', more: '+{n} mais', justNow: 'agora', minutesAgo: 'há {n} min', hoursAgo: 'há {n} h', now: 'agora',
    },
    command: { opened: 'Painel de agentes aberto.', waits: 'O painel de agentes espera espaço:', closed: 'Painel de agentes fechado.', usage: 'Uso: /spider-agents [open|close]' },
    na: 'N/A',
  },
}

export const t = (lang: Lang): Strings => STRINGS[lang]

// `portugu` anywhere ("Brazilian Portuguese", "Português"), or a `pt` code (pt, pt-BR, pt_BR.UTF-8).
const PORTUGUESE = /portugu|^pt\b|^pt[_-]/i

/** The option when fixed; on `auto`, the Claude Code language setting when set, else the first locale variable set, else English. */
export function langOf(option: SpiderConfig['language'], settingsLanguage?: string, env: { LC_ALL?: string; LC_MESSAGES?: string; LANG?: string } = {}): Lang {
  if (option !== 'auto') return option
  if (settingsLanguage?.trim()) return PORTUGUESE.test(settingsLanguage.trim()) ? 'pt-BR' : 'en'
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || ''
  return PORTUGUESE.test(locale) ? 'pt-BR' : 'en'
}
