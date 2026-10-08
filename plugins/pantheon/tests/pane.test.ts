import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DELEGATE, HOME, RESULT, parse, start, world } from './fixtures/world'
import { PANE_ID, statusText } from '../hooks/pane'

const SURFACES = ['terminal', 'desktop'] as const

function mountPane($: Engine, surface: (typeof SURFACES)[number]) {
  return $.ui.mount({
    plugin: 'pantheon',
    surface,
    component: 'Pane',
    props: { title: 'Pantheon', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
    requestId: PANE_ID,
    viewport: { columns: 120, rows: 30 } as never,
  })
}

function command($: Engine, args: string) {
  return $.command.run({ command: 'pantheon', args } as never)
}

describe('pane', () => {
  for (const surface of SURFACES) {
    test(`pane lists codex jobs with status, role and resumable mark (${surface})`, async ($, on) => {
      world(on)
      await start($)
      const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'x', description: 'map auth' } as never))
      const ui = await mountPane($, surface)
      const row = await ui.find({ type: 'Text', text: String(out.jobId) })
      expect(row?.text).toBe(`${out.jobId} · done · explorer · ↻ — map auth`)
      expect(await ui.find({ type: 'Text', text: 'delegate({ resume: jobId })' })).toBeDefined()
      expect(await ui.find({ key: `copy-${out.jobId}` })).toBeDefined()
      expect(await ui.find({ key: `cancel-${out.jobId}` })).toBeUndefined()
    })

    test(`cancel button cancels a running job (${surface})`, async ($, on) => {
      world(on, { hang: true })
      await start($)
      const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x', background: true } as never))
      const ui = await mountPane($, surface)
      await ui.press({ key: `cancel-${out.jobId}` })
      const read = parse(await $.tool.call({ tool: RESULT, jobId: out.jobId } as never))
      expect(read.status).toBe('cancelled')
    })

    test(`the pane holds only codex jobs, not native agents (${surface})`, async ($, on) => {
      world(on)
      await start($)
      const ui = await mountPane($, surface)
      expect((await ui.find({ type: 'Text', text: 'Nenhum job' }))).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'retomável' })).toBeUndefined()
      expect(await ui.findAll({ type: 'Button' })).toEqual([])
    })
  }

  test('status line counts running and background, clears when none', async ($, on) => {
    const { seen } = world(on, { hang: true })
    await start($)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x', background: true } as never))
    expect(seen.statuses).toContain('pantheon: 0 rodando · 1 em background')
    await $.tool.call({ tool: 'mcp__pantheon__delegate_cancel', jobId: out.jobId } as never)
    expect(seen.statuses[seen.statuses.length - 1]).toBeUndefined()
    expect(statusText([])).toBeUndefined()
  })

  test('/pantheon config shows origins and current error', async ($, on) => {
    const { files } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ noNetwork: true }) } })
    await start($)
    const ok = await command($, 'config')
    expect(ok.text).toContain('Config válida')
    expect(ok.text).toContain('noNetwork: user')
    files[`${HOME}/.claude/pantheon.json`] = '{ broken'
    const bad = await command($, 'config')
    expect(bad.text).toContain('Config inválida')
  })

  test('/pantheon doctor reports codex, login and config', async ($, on) => {
    world(on, {
      runs: {
        'codex --version': { exitCode: 0, stdout: 'codex-cli 9.9.9\n' },
        'codex login status': { exitCode: 0, stdout: 'Logged in using ChatGPT\n' },
      },
    })
    await start($)
    const out = await command($, 'doctor')
    expect(out.text).toContain('codex-cli 9.9.9')
    expect(out.text).toContain('Logged in')
    expect(out.text).toContain('raiz autorizada: /repo')
    expect(out.text).not.toContain('falha')
  })

  test('/pantheon cancel without id shows usage', async ($, on) => {
    world(on)
    await start($)
    expect((await command($, 'cancel')).text).toContain('Uso')
  })
})
