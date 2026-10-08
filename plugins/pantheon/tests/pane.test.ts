import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DELEGATE, HOME, RESULT, parse, start, world } from './fixtures/world'
import { PANE_ID, statusText } from '../hooks/pane'
import type { Job, Native, SessionInfo } from '../hooks/types'

const SURFACES = ['terminal', 'desktop'] as const
const NOW = 1_000_000_000

type Opts = { placement?: 'dock' | 'inline'; columns?: number; rows?: number }

const mounted: { unmount: () => Promise<unknown> }[] = []

async function mountPane($: Engine, surface: (typeof SURFACES)[number], opts: Opts = {}) {
  const ui = await $.ui.mount({
    plugin: 'pantheon',
    surface,
    component: 'Pane',
    props: {
      title: 'Pantheon', isFocused: true, bodyColumns: opts.columns ?? 120, placement: opts.placement ?? 'dock',
    } as never,
    requestId: PANE_ID,
    viewport: { columns: opts.columns ?? 120, rows: opts.rows ?? 40 } as never,
  })
  mounted.push(ui)
  return ui
}

// A pane left mounted keeps redrawing after its test ends.
async function release() {
  for (const ui of mounted.splice(0)) await ui.unmount().catch(() => undefined)
}

type Mounted = Awaited<ReturnType<typeof mountPane>>
async function texts(ui: Mounted): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(node => String(node.text))
}

function command($: Engine, args: string) {
  return $.command.run({ command: 'pantheon', args } as never)
}

// Serves the draw-time state reads, standing for what tracking and the jobs would have written.
function seed(on: On, data: { jobs?: Job[]; natives?: Native[]; session?: SessionInfo }) {
  on('state.get', async (_$, e, next) => {
    const value = data[e.key as keyof typeof data]
    return value === undefined ? next(e) : ({ value: { value, version: 1 } } as never)
  })
}

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1', agent: 'explorer', status: 'background', startedAt: NOW - 60_000, cwd: '/repo', ...over,
})
const native = (over: Partial<Native> = {}): Native => ({
  id: 'n1', role: 'oracle', type: 'pantheon:oracle', task: 'Review the lifecycle', model: 'opus',
  rounds: [{ startedAt: NOW - 120_000, status: 'running' }], ctx: 5200, out: 310, steps: 4, lastTool: 'Read jobs.ts', ...over,
})

const t = (name: string, fn: (...args: Parameters<Parameters<typeof test>[1]>) => Promise<void>) =>
  test(name, async (...args) => {
    try { await fn(...args) } finally { await release() }
  })

describe('pane', () => {
  for (const surface of SURFACES) {
    t(`agents tab shows seven slots in order (${surface})`, async ($, on) => {
      world(on)
      await start($)
      const ui = await mountPane($, surface)
      const names = ['orchestrator', 'explorer', 'librarian', 'fixer', 'oracle', 'designer', 'council']
      const all = await texts(ui)
      const at = names.map(name => all.indexOf(name))
      expect(at.every(i => i >= 0)).toBe(true)
      expect(at).toEqual([...at].sort((a, b) => a - b))
      expect(await ui.find({ key: 'tab-agents' })).toBeDefined()
      expect(await ui.find({ key: 'tab-jobs' })).toBeDefined()
    })

    t(`an active explorer shows its instance, activity and clock (${surface})`, async ($, on) => {
      world(on)
      seed(on, { jobs: [job({
        id: 'pj3a', description: 'map pane render tree', lastActivity: "rg 'x' plugins/",
        tokens: { input: 41200, cached: 30100, output: 2300 },
      })] })
      await start($)
      const ui = await mountPane($, surface)
      const all = await texts(ui)
      expect(all).toContain('pj3a')
      expect(all.some(x => x.includes('map pane render tree'))).toBe(true)
      expect(all.some(x => x.includes("rg 'x' plugins/"))).toBe(true)
      expect(all.some(x => x.includes('in 41.2k · cached 30.1k · out 2.3k'))).toBe(true)
      expect(all).toContain('1 running')
      // The clock is a Client where the surface has one, else a Text.
      expect((await ui.find({ key: 'clk-pj3a' })) ?? all.find(x => /^\d+:\d\d$/.test(x))).toBeDefined()
    })

    t(`a resumed job shows round 2 (${surface})`, async ($, on) => {
      world(on, { hang: true })
      await start($)
      const first = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x', description: 'wire tabs', background: true } as never))
      await $.tool.call({ tool: 'mcp__pantheon__delegate_cancel', jobId: first.jobId } as never)
      const second = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'again', resume: first.jobId, background: true } as never))
      const ui = await mountPane($, surface)
      expect((await texts(ui)).some(x => x.includes('↻ round 2'))).toBe(true)
      await $.tool.call({ tool: 'mcp__pantheon__delegate_cancel', jobId: second.jobId } as never)
    })

    t(`off role shows disabledAgents (${surface})`, async ($, on) => {
      world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['librarian'] }) } })
      await start($)
      await command($, 'config')
      const ui = await mountPane($, surface)
      const all = await texts(ui)
      expect(all).toContain('disabledAgents')
      expect(all).toContain('⊘')
    })

    t(`tab button switches to jobs, which cancels and copies (${surface})`, async ($, on) => {
      const { seen } = world(on, { hang: true })
      await start($)
      const run = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x', description: 'wire tabs', background: true } as never))
      const done = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'y', description: 'map', background: true } as never))
      await $.tool.call({ tool: 'mcp__pantheon__delegate_cancel', jobId: done.jobId } as never)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'tab-jobs' })
      const all = await texts(ui)
      expect(all).toContain('active')
      expect(all).toContain('finished')
      await ui.press({ key: `copy-${done.jobId}` })
      expect(seen.copied[0]).toContain(String(done.jobId))
      expect(seen.copied[0]).toContain('resume: delegate({ agent: "explorer"')
      expect(await ui.find({ key: `cancel-${done.jobId}` })).toBeUndefined()
      await ui.press({ key: `cancel-${run.jobId}` })
      expect(parse(await $.tool.call({ tool: RESULT, jobId: run.jobId } as never)).status).toBe('cancelled')
      await ui.press({ key: 'tab-agents' })
      expect(await ui.find({ type: 'Text', text: 'orchestrator' })).toBeDefined()
    })

    t(`other agents line only when present (${surface})`, async ($, on) => {
      world(on)
      await start($)
      expect((await texts(await mountPane($, surface))).includes('other agents')).toBe(false)
    })

    t(`other agents line shows when a subagent is tracked (${surface})`, async ($, on) => {
      world(on)
      seed(on, { natives: [native({ id: 'x9', role: 'other', type: 'Explore', task: 'survey' })] })
      await start($)
      expect((await texts(await mountPane($, surface))).includes('other agents')).toBe(true)
    })
  }

  t('desktop draws the timeline Svg', async ($, on) => {
    world(on)
    seed(on, { natives: [native()] })
    await start($)
    const ui = await mountPane($, 'desktop')
    expect(await ui.find({ type: 'Svg' })).toBeDefined()
    const terminal = await mountPane($, 'terminal')
    expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  })

  t('mini stays within 8 lines and collapses to +N', async ($, on) => {
    world(on)
    const agents = ['explorer', 'librarian', 'fixer', 'councillor:alpha']
    seed(on, {
      jobs: agents.map((agent, k) => job({ id: `j${k}`, agent, lastActivity: 'read x' })),
      natives: [native(), native({ id: 'n2', role: 'designer', type: 'pantheon:designer' })],
      session: { isRunning: true, turnStartedAt: NOW - 5_000, model: 'opus' },
    })
    await start($)
    const full = await mountPane($, 'terminal', { placement: 'inline', rows: 40 })
    const root = (await full.drawn()) as { children?: unknown[] }
    expect((root.children ?? []).filter(Boolean).length <= 8).toBe(true)
    expect((await texts(full)).some(x => /^\+\d+ active$/.test(x))).toBe(false)
    expect((await texts(full)).includes('/pantheon for details')).toBe(true)
    await release()
    const tight = await mountPane($, 'terminal', { placement: 'inline', rows: 7 })
    expect((await texts(tight)).includes('+1 active')).toBe(true)
    expect(await tight.find({ key: 'tab-jobs' })).toBeUndefined()
  })

  t('docked at 40 columns truncates', async ($, on) => {
    world(on)
    seed(on, {
      jobs: [job({
        id: 'pj3a', description: 'a very long task description that cannot fit in forty columns',
        lastActivity: 'apply_patch plugins/pantheon/hooks/pane.tsx and more',
      })],
      session: { isRunning: true, turnStartedAt: NOW - 5_000, model: 'claude-opus-5-5-with-a-long-name', effort: 'high' },
    })
    await start($)
    for (const tab of ['agents', 'jobs'] as const) {
      const ui = await mountPane($, 'terminal', { columns: 40 })
      if (tab === 'jobs') await ui.press({ key: 'tab-jobs' })
      expect((await texts(ui)).filter(x => x.length > 40)).toEqual([])
      await release()
    }
  })

  t('status line counts running and background, clears when none', async ($, on) => {
    const { seen } = world(on, { hang: true })
    await start($)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'fixer', prompt: 'x', background: true } as never))
    expect(seen.statuses).toContain('pantheon: 0 rodando · 1 em background')
    await $.tool.call({ tool: 'mcp__pantheon__delegate_cancel', jobId: out.jobId } as never)
    expect(seen.statuses[seen.statuses.length - 1]).toBeUndefined()
    expect(statusText([])).toBeUndefined()
  })

  t('/pantheon config shows origins and current error', async ($, on) => {
    const { files } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ noNetwork: true }) } })
    await start($)
    const ok = await command($, 'config')
    expect(ok.text).toContain('Config válida')
    expect(ok.text).toContain('noNetwork: user')
    files[`${HOME}/.claude/pantheon.json`] = '{ broken'
    const bad = await command($, 'config')
    expect(bad.text).toContain('Config inválida')
  })

  t('/pantheon doctor reports codex, login and config', async ($, on) => {
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

  t('/pantheon cancel without id shows usage', async ($, on) => {
    world(on)
    await start($)
    expect((await command($, 'cancel')).text).toContain('Uso')
  })
})
