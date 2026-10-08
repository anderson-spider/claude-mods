import type { Elements, RenderSurface } from 'claude-code'

import type { ConfigResult, Job } from './types'

export const PANE_ID = 'pantheon'

const ACTIVE = new Set(['running', 'background'])

export function statusText(jobs: Job[]): string | undefined {
  const running = jobs.filter(job => job.status === 'running').length
  const background = jobs.filter(job => job.status === 'background').length
  if (!running && !background) return undefined
  return `pantheon: ${running} rodando · ${background} em background`
}

export function isResumable(job: Job): boolean {
  return !!job.sessionId && !ACTIVE.has(job.status)
}

/** Uma linha curta por job: o detalhe (modelo, tempo, tokens, atividade) fica no Flightdeck. */
export function jobLine(job: Job): string {
  const head = `${job.id} · ${job.status} · ${job.agent}${isResumable(job) ? ' · ↻' : ''}`
  return job.description ? `${head} — ${job.description}` : head
}

export function configReport(state: ConfigResult): string {
  const lines = [state.ok ? 'Config válida.' : `Config inválida: ${state.error}`]
  lines.push('', 'Config efetiva:', JSON.stringify(state.config, null, 2))
  if (state.ok) {
    const origins = Object.entries(state.origins).filter(([, origin]) => origin !== 'default')
    lines.push('', 'Origem (campos fora do padrão):')
    lines.push(...(origins.length ? origins.map(([field, origin]) => `- ${field}: ${origin}`) : ['- todos os campos no padrão']))
  }
  return lines.join('\n')
}

export type DoctorFacts = {
  codexVersion?: string
  loginStatus?: string
  loginOk: boolean
  config: ConfigResult
  root: string
  isRepo: boolean
}

export function doctorReport(facts: DoctorFacts): string {
  const mark = (ok: boolean) => (ok ? 'ok ' : 'falha')
  return [
    `${mark(!!facts.codexVersion)} codex no PATH${facts.codexVersion ? `: ${facts.codexVersion}` : ' — instale o Codex CLI'}`,
    `${mark(facts.loginOk)} codex login status${facts.loginStatus ? `: ${facts.loginStatus}` : ''}`,
    `${mark(facts.config.ok)} config${facts.config.ok ? '' : `: ${facts.config.error}`}`,
    `ok  raiz autorizada: ${facts.root}${facts.isRepo ? '' : ' (fora de repositório git: --skip-git-repo-check)'}`,
  ].join('\n')
}

type PaneElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export type PaneData = {
  jobs: Job[]
  rows: number
  onCancel: (jobId: string) => void
  onCopy: (text: string, surface: RenderSurface) => void
}

export function drawPane(el: PaneElements, data: PaneData) {
  const { Box, Text, Button } = el
  // Ativos primeiro (um job travado nunca some do painel), depois os mais recentes.
  const recent = [...data.jobs].reverse()
  const jobs = [...recent.filter(job => ACTIVE.has(job.status)), ...recent.filter(job => !ACTIVE.has(job.status))]
    .slice(0, Math.max(1, data.rows - 5))
  return (
    <Box flexDirection="column">
      {jobs.length === 0 && <Text dimColor>Nenhum job do Pantheon nesta sessão.</Text>}
      {jobs.map(job => (
        <Box key={`job-${job.id}`} flexDirection="row" gap={1}>
          <Text dimColor={!ACTIVE.has(job.status)}>{jobLine(job)}</Text>
          {ACTIVE.has(job.status) && (
            <Button key={`cancel-${job.id}`} label="Cancelar" onPress={() => data.onCancel(job.id)} />
          )}
          {job.result && (
            <Button
              key={`copy-${job.id}`}
              label="Copiar resposta"
              onPress={press => data.onCopy(job.result!, press.surface)}
            />
          )}
        </Box>
      ))}
      {jobs.some(isResumable) && (
        <Text dimColor>↻ retomável: o orchestrator retoma com delegate({'{'} resume: jobId {'}'}); o detalhe dos jobs fica no /flightdeck.</Text>
      )}
    </Box>
  )
}
