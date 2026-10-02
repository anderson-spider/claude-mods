import { atom, read } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { BlastRadiusHeld } from '../types'
import { classify, isDisposable, measure } from './risk'
import type { Probe, Risk } from './risk'

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type Decision = 'proceed' | 'cancel'
type Slot = { id: string; decision: Decision | null }

const TITLE = 'Blast Radius'
// Esperar dentro de uma chamada de `$` não gasta o tempo do hook; `$.clock.sleep` gastaria.
const POLL = ['sleep', '0.25']
// Borda, título, Comando, Iria, as duas linhas em branco, o rodapé, o 'e mais N' e os botões.
const CHROME_ROWS = 10
const MAX_LINES = 8

const ref = { plugin: 'blast-radius', key: 'held' } as const
const held = atom(ref, null)

// As leituras de `$.state` de um dispatch veem um só momento: a decisão que o hook
// espera não chegaria por lá, então ela viaja por aqui e o estado guarda só o desenho.
let waiting: Slot | undefined

const probe = ($: EngineInterface): Probe => ({
  run: (argv, init) => $.process.run(argv, init),
  list: path => $.fs.list(path),
  home: () => $.env.get('HOME'),
  real: path =>
    $.fs.stat(path, { resolve: true }).then(
      stat => stat.realPath,
      () => undefined,
    ),
})

const decide = (decision: Decision) => {
  if (waiting?.decision === null) {
    waiting.decision = decision
  }
}

/** Segura a chamada até a pessoa decidir; nunca rejeita, para o comando não escapar por um erro. */
const hold = async (
  $: EngineInterface,
  mine: BlastRadiusHeld,
  signal: AbortSignal,
): Promise<Decision | 'aborted'> => {
  const slot: Slot = { id: mine.id, decision: null }

  try {
    // Uma chamada segurada por vez: a segunda espera a primeira ser decidida.
    while (waiting !== undefined) {
      if (signal.aborted) {
        return 'aborted'
      }

      await $.process.run(POLL)
    }

    waiting = slot
    await $.state.set(ref, mine)

    while (slot.decision === null && !signal.aborted) {
      await $.process.run(POLL)
    }

    return slot.decision ?? 'aborted'
  } catch {
    return 'aborted'
  } finally {
    if (waiting === slot) {
      waiting = undefined
      await $.state.set(ref, null).catch(() => undefined)
    }
  }
}

const draw = ({ Box, Text, Button }: Kit, now: BlastRadiusHeld, room: number): RenderElement => {
  const { report } = now
  const shown = report.lines.slice(0, Math.max(0, room))
  const hidden = report.total - shown.length

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
      <Text bold color="warning">
        ⚠ {TITLE} · {report.title}
      </Text>
      <Box>
        <Text dimColor>{'Comando  '}</Text>
        <Text bold wrap="truncate-end">
          {now.command}
        </Text>
      </Box>
      <Box>
        <Text dimColor>{'Iria     '}</Text>
        <Text bold color="error">
          {report.summary}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        {shown.map(line => (
          <Text wrap="truncate-end">{line}</Text>
        ))}
        {hidden > 0 && <Text dimColor>{`… e mais ${hidden}`}</Text>}
      </Box>
      {report.notes.map(note => (
        <Text dimColor italic wrap="truncate-end">
          {note}
        </Text>
      ))}
      <Box marginTop={1} gap={2}>
        <Button key="proceed" label="Prosseguir" hotkey="1" plain onPress={() => decide('proceed')} />
        <Button key="cancel" label="Cancelar" hotkey="2" plain autoFocus onPress={() => decide('cancel')} />
        <Text dimColor>Claude aguarda sua resposta</Text>
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  // Um reload no meio de uma espera deixaria o valor preso e seguraria tudo depois dele.
  on('session.start', async ($, e, next) => {
    waiting = undefined
    await $.state.set(ref, null)

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const found = classify(e.command)

    if (found.length === 0) {
      return next(e)
    }

    const host = probe($)
    const cwd = await $.session.cwd()
    const risks: Risk[] = []

    // O que só toca um temporário do sistema passa sem perguntar.
    for (const risk of found) {
      if (!(await isDisposable(host, risk, cwd))) {
        risks.push(risk)
      }
    }

    if (risks.length === 0) {
      return next(e)
    }

    const report = await measure(host, risks, cwd)
    const outcome = await hold(
      $,
      { id: e.tool_use_id, command: e.command, report },
      next.signal,
    )

    if (outcome === 'proceed') {
      return next(e)
    }

    return {
      deny:
        outcome === 'cancel'
          ? `Blast Radius segurou este comando: a pessoa pressionou Cancelar. Ele iria ${report.summary}.`
          : `Blast Radius segurou este comando e a espera foi interrompida antes de uma decisão. Ele iria ${report.summary}.`,
    }
  })

  // O relatório fica na faixa acima do prompt, em qualquer largura.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, held)

    if (now === null || e.props.hasSurvey) {
      return next(e)
    }

    return draw($.ui.resolve(e), now, Math.min(MAX_LINES, e.props.maxRows - CHROME_ROWS))
  })
}
