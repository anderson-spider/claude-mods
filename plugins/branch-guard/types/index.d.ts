/** O que o comando faria: uma frase, e os itens que a sustentam. */
export type BranchGuardReport = {
  /** O comando pelo nome: `git commit`, `git push`. */
  title: string
  summary: string
  lines: string[]
  /** Quantos itens existem ao todo; `lines` guarda só os primeiros. */
  total: number
  /** Rodapé: o resumo do que mudou no índice. */
  notes: string[]
}

/** O comando segurado, com o relatório desenhado acima do prompt. */
export type BranchGuardHeld = {
  id: string
  command: string
  report: BranchGuardReport
}

declare module 'claude-code' {
  interface PluginState {
    'branch-guard': { held: BranchGuardHeld | null }
  }
}
