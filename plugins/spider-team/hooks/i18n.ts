// The plugin's words in English and Brazilian Portuguese, and how the language is chosen.
import type { SpiderAgent, SpiderPhase } from '../types'
import type { SpiderConfig } from './config'

export type Lang = 'en' | 'pt-BR'

export type Strings = {
  agent: string
  agents: string
  counts: { accepted: string; acceptedOne: string; running: string; left: string; leftOne: string; failed: string; failedOne: string; cancelled: string; cancelledOne: string; recent: string; recentOne: string }
  phase: Record<SpiderPhase, string>
  status: Record<SpiderAgent['status'], string>
  task: { pending: string; blocked: string; running: string; reviewing: string; completed: string; failed: string; cancelled: string }
  pane: {
    title: string; noRun: string; noAgents: string; plan: string; running: string; recent: string; others: string; timeline: string; totals: string
    main: string; subagents: string; session: string; tokens: string; cost: string; context: string
    steps: string; calls: string; callsOne: string; waits: string; more: string; justNow: string; minutesAgo: string; hoursAgo: string; now: string; finished: string
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
    counts: { accepted: 'accepted', acceptedOne: 'accepted', running: 'running', left: 'left', leftOne: 'left', failed: 'failed', failedOne: 'failed', cancelled: 'cancelled', cancelledOne: 'cancelled', recent: 'recent', recentOne: 'recent' },
    phase: { understand: 'Understand', plan: 'Plan', investigate: 'Investigate', execute: 'Execute', review: 'Review', verify: 'Verify', complete: 'Complete', cancelled: 'Cancelled', failed: 'Failed' },
    status: { running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled' },
    task: { pending: 'pending', blocked: 'blocked', running: 'running', reviewing: 'reviewing', completed: 'accepted', failed: 'failed', cancelled: 'cancelled' },
    pane: {
      title: 'Spider agents', noRun: 'No spider-team run', noAgents: 'No agents yet', plan: 'Plan', running: 'Running', recent: 'Recent', others: 'Other agents', timeline: 'Last 15 minutes', totals: 'Totals',
      main: 'Main', subagents: 'Subagents', session: 'Session', tokens: 'Tokens', cost: 'Cost', context: 'Context',
      steps: 'steps', calls: 'calls', callsOne: 'call', waits: 'waits', more: '+{n} more', justNow: 'just now', minutesAgo: '{n} min ago', hoursAgo: '{n} h ago', now: 'now', finished: 'finished',
    },
    command: { opened: 'Agents pane open.', waits: 'The agents pane waits for room:', closed: 'Agents pane closed.', usage: 'Usage: /spider-agents [open|close]' },
    na: 'N/A',
  },
  'pt-BR': {
    agent: 'agente',
    agents: 'agentes',
    counts: { accepted: 'aceitas', acceptedOne: 'aceita', running: 'rodando', left: 'faltam', leftOne: 'falta', failed: 'falharam', failedOne: 'falhou', cancelled: 'canceladas', cancelledOne: 'cancelada', recent: 'recentes', recentOne: 'recente' },
    phase: { understand: 'Entender', plan: 'Planejar', investigate: 'Investigar', execute: 'Executar', review: 'Revisão', verify: 'Verificar', complete: 'Concluído', cancelled: 'Cancelado', failed: 'Falhou' },
    status: { running: 'rodando', done: 'concluído', failed: 'falhou', cancelled: 'cancelado' },
    task: { pending: 'pendente', blocked: 'bloqueada', running: 'rodando', reviewing: 'em revisão', completed: 'aceita', failed: 'falhou', cancelled: 'cancelada' },
    pane: {
      title: 'Agentes spider', noRun: 'Nenhuma execução do spider-team', noAgents: 'Nenhum agente ainda', plan: 'Plano', running: 'Rodando', recent: 'Recentes', others: 'Outros agentes', timeline: 'Últimos 15 minutos', totals: 'Totais',
      main: 'Main', subagents: 'Subagentes', session: 'Sessão', tokens: 'Tokens', cost: 'Custo', context: 'Contexto',
      steps: 'passos', calls: 'chamadas', callsOne: 'chamada', waits: 'aguarda', more: '+{n} mais', justNow: 'agora', minutesAgo: 'há {n} min', hoursAgo: 'há {n} h', now: 'agora', finished: 'terminou',
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
