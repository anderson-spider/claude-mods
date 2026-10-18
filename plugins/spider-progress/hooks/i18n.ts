// The plugin's words in English and Brazilian Portuguese, and how the language is chosen.
import type { SpiderAgent, SpiderPhase } from '../types'
import type { SpiderConfig } from './config'

export type Lang = 'en' | 'pt-BR'

export type Strings = {
  team: string
  tasks: string
  agent: string
  agents: string
  phase: Record<SpiderPhase, string>
  status: Record<SpiderAgent['status'], string>
  task: { pending: string; blocked: string; running: string; reviewing: string; completed: string; failed: string; cancelled: string }
  pane: { title: string; noRun: string; noAgents: string; others: string; tasks: string; totals: string; main: string; subagents: string; session: string; compact: string; expanded: string }
  column: { agent: string; model: string; effort: string; status: string; steps: string; tokens: string; context: string; cost: string; time: string }
  command: { opened: string; waits: string; closed: string; usage: string }
  na: string
}

export const STRINGS: Record<Lang, Strings> = {
  en: {
    team: 'SPIDER TEAM',
    tasks: 'tasks',
    agent: 'agent',
    agents: 'agents',
    phase: { understand: 'Understand', plan: 'Plan', investigate: 'Investigate', execute: 'Execute', review: 'Review', verify: 'Verify', complete: 'Complete', cancelled: 'Cancelled', failed: 'Failed' },
    status: { running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled' },
    task: { pending: 'pending', blocked: 'blocked', running: 'running', reviewing: 'reviewing', completed: 'accepted', failed: 'failed', cancelled: 'cancelled' },
    pane: { title: 'Spider agents', noRun: 'No spider-team run', noAgents: 'No agents yet', others: 'OTHER AGENTS', tasks: 'TASKS', totals: 'TOTALS', main: 'Main', subagents: 'Subagents', session: 'Session', compact: 'compact', expanded: 'expanded' },
    column: { agent: 'AGENT', model: 'MODEL', effort: 'EFFORT', status: 'STATUS', steps: 'STEPS', tokens: 'TOKENS', context: 'CONTEXT', cost: 'COST', time: 'TIME' },
    command: { opened: 'Agents pane open.', waits: 'The agents pane waits for room:', closed: 'Agents pane closed.', usage: 'Usage: /spider-agents [open|close]' },
    na: 'N/A',
  },
  'pt-BR': {
    team: 'SPIDER TEAM',
    tasks: 'tarefas',
    agent: 'agente',
    agents: 'agentes',
    phase: { understand: 'Entender', plan: 'Planejar', investigate: 'Investigar', execute: 'Executar', review: 'Revisão', verify: 'Verificar', complete: 'Concluído', cancelled: 'Cancelado', failed: 'Falhou' },
    status: { running: 'rodando', done: 'concluído', failed: 'falhou', cancelled: 'cancelado' },
    task: { pending: 'pendente', blocked: 'bloqueada', running: 'rodando', reviewing: 'em revisão', completed: 'aceita', failed: 'falhou', cancelled: 'cancelada' },
    pane: { title: 'Agentes spider', noRun: 'Nenhuma execução do spider-team', noAgents: 'Nenhum agente ainda', others: 'OUTROS AGENTES', tasks: 'TAREFAS', totals: 'TOTAIS', main: 'Main', subagents: 'Subagentes', session: 'Sessão', compact: 'compacto', expanded: 'expandido' },
    column: { agent: 'AGENTE', model: 'MODELO', effort: 'EFFORT', status: 'ESTADO', steps: 'PASSOS', tokens: 'TOKENS', context: 'CONTEXTO', cost: 'CUSTO', time: 'TEMPO' },
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
