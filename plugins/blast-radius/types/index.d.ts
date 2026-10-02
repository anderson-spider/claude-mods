/** O que o comando mudaria: uma frase, e os itens que a sustentam. */
export type BlastRadiusReport = {
  /** O risco pelo nome: `rm -rf`, `git clean`. */
  title: string
  summary: string
  lines: string[]
  /** Quantos itens existem ao todo; `lines` guarda só os primeiros. */
  total: number
  /** Rodapé: os alvos como foram escritos (`Caminhos: build`) ou o tamanho da perda. */
  notes: string[]
}

/** O comando segurado, com o relatório desenhado acima do prompt. */
export type BlastRadiusHeld = {
  id: string
  command: string
  report: BlastRadiusReport
}

declare module 'claude-code' {
  interface PluginState {
    'blast-radius': { held: BlastRadiusHeld | null }
  }
}
