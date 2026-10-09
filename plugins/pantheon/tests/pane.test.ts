import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DELEGATE, HOME, ROOT, RESULT, parse, start, world } from './fixtures/world'
import { PANE_ID, configReport, doctorReport, drawPanel, statusText, timelineSource } from '../hooks/pane'
import { clawdLines, clawdSvg } from '../hooks/clawd'
import { loadConfig } from '../hooks/config'
import { buildRoster } from '../hooks/roster'
import type { Slot } from '../hooks/roster'
import { MIXED } from './fixtures/profiles'
import type { Job, Native, SessionInfo } from '../hooks/types'

const SURFACES = ['terminal', 'desktop'] as const
const NOW = 1_000_000_000

test('config report identifies the active profile and origin before JSON', async () => {
  const config = await loadConfig(async () => '{"profile":"codex"}', { user: 'fixture' })
  const lines = configReport(config).split('\n')
  expect(lines.slice(0, 3)).toContain('Active profile: codex (user)')
})

test('doctor treats unavailable Codex as informational only when unused', async () => {
  const config = await loadConfig(async () => '{"profile":"claude"}', { user: 'fixture' })
  const facts = { usesCodex: false, profile: 'claude', loginOk: false, config, root: '/repo', isRepo: true }
  const report = doctorReport(facts)
  expect(report).not.toContain('fail')
  expect(report).toContain('info')
  expect(report).toContain('not needed by profile claude')
  expect(doctorReport({ ...facts, usesCodex: true })).toContain('fail')
})

type Opts = { placement?: 'dock' | 'inline'; columns?: number; rows?: number; bodyRows?: number; requestId?: string }

const mounted: { unmount: () => Promise<unknown> }[] = []

async function mountPane($: Engine, surface: (typeof SURFACES)[number], opts: Opts = {}) {
  const ui = await $.ui.mount({
    plugin: 'pantheon',
    surface,
    component: 'Pane',
    props: {
      title: 'Pantheon', isFocused: true, bodyColumns: opts.columns ?? 120, placement: opts.placement ?? 'dock',
      scroll: { offset: 0, bodyRows: opts.bodyRows ?? opts.rows ?? 40 },
    } as never,
    requestId: opts.requestId ?? PANE_ID,
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
  return (await ui.findAll({ type: 'Text' })).map(node => String(node.text).trim())
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
    for (const placement of ['dock', 'inline'] as const) {
      for (const profile of ['claude', 'codex']) {
        test(`profile selector lists custom profiles and writes the selected name (${surface}, ${placement}, ${profile})`,
          { options: { profile } }, async ($, on) => {
            try {
              world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{"profiles":{"personal":{}}}' } })
              const writes: unknown[] = []
              on('config.set', async (_$, e) => { writes.push({ key: e.key, value: e.value }); return { value: e.value } })
              await start($)
              const ui = await mountPane($, surface, { placement })
              const select = await ui.find({ key: 'profile' })
              expect(select).toBeDefined()
              const props = (select as unknown as { props: { value: string; options: { value: string }[] } }).props
              expect(props.value).toBe(profile)
              expect(props.options.map(o => o.value)).toEqual(['claude', 'codex', 'mixed', 'personal'])
              await ui.select({ key: 'profile', value: 'personal' })
              expect(writes).toEqual([{ key: 'pantheon.profile', value: 'personal' }])
            } finally { await release() }
          })
      }

      for (const layer of ['user', 'project'] as const) {
        t(`profile selector is read-only and names the winning ${layer} layer (${surface}, ${placement})`, async ($, on) => {
          world(on, { files: {
            [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ profile: layer === 'project' ? 'claude' : 'mixed' }),
            ...(layer === 'project' ? { [`${ROOT}/.claude/pantheon.json`]: '{"profile":"mixed"}' } : {}),
          } })
          const writes: unknown[] = []
          on('config.set', async (_$, e) => { writes.push(e); return { value: e.value } })
          await start($)
          const ui = await mountPane($, surface, { placement })
          const all = await texts(ui)
          expect(all).toContain(`set by ${layer} pantheon.json`)
          expect(all).toContain('● mixed')
          expect(all).toContain('claude')
          expect(all).toContain('codex')
          expect(await ui.find({ type: 'Select', key: 'profile' })).toBeUndefined()
          expect(await ui.find({ type: 'Button', key: 'profile-mixed' })).toBeUndefined()
          expect(writes).toEqual([])
          await release()
          const narrow = await mountPane($, surface, { placement, columns: 24 })
          expect(await texts(narrow)).toContain(`${layer} JSON`)
          expect(await narrow.find({ type: 'Select', key: 'profile' })).toBeUndefined()
        })
      }

      t(`profile selector offers buttons when Select is absent (${surface}, ${placement})`, async ($, on) => {
        world(on)
        const choices: string[] = []
        on('ui.render', { component: 'Pane', requestId: 'profile-fixture' }, ($, e) => {
          const { Box, Text, Button } = $.ui.resolve(e)
          return drawPanel({ Box, Text, Button }, {
            surface, placement, columns: 120, rows: 40, now: NOW,
            profiles: ['claude', 'codex', 'mixed'], activeProfile: 'mixed', onProfile: name => { choices.push(name) },
            roster: buildRoster({ jobs: [], natives: [], session: { isRunning: false }, config: MIXED }), jobs: [], session: { isRunning: false },
            tab: 'agents', hasClient: false, onTab: () => {}, onCancel: () => {}, onCopy: () => {},
          }) as never
        })
        const ui = await mountPane($, surface, { placement, requestId: 'profile-fixture' })
        const buttons = await ui.findAll({ type: 'Button' })
        const labels = buttons.map(b => (b as unknown as { props: { label: string } }).props.label)
        expect(labels).toContain('● mixed')
        // The fixture, rather than Pantheon, owns the handlers in this drawing.
        type Node = { props?: { key?: string }; press?: { plugin: string }; children?: Node[] }
        const nodes = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(nodes)]
        const drawn = nodes(await ui.drawn() as Node)
        for (const name of ['claude', 'codex', 'mixed']) {
          const key = `profile-${name}`
          const plugin = drawn.find(n => n.props?.key === key)?.press?.plugin
          expect(plugin).toBeDefined()
          await ui.press({ key, plugin })
        }
        expect(choices).toEqual(['claude', 'codex', 'mixed'])
      })
    }
  }

  t('the default profile remains interactive without a JSON selection', async ($, on) => {
    world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{}' } })
    const writes: string[] = []
    const viewWrites: unknown[] = []
    on('config.set', async (_$, e) => { writes.push(String(e.value)); return { value: e.value } })
    on('state.set', async (_$, e, next) => {
      if (e.key === 'view') viewWrites.push(e.value)
      return next(e)
    })
    await start($)
    const ui = await mountPane($, 'terminal')
    expect((await ui.find({ key: 'profile' }))?.props.value).toBe('claude')
    const before = viewWrites.length
    await ui.select({ key: 'profile', value: 'mixed' })
    expect(writes).toEqual(['mixed'])
    expect(viewWrites.length).toBe(before)
  })

  t('long profile names clip at narrow widths while selections carry the full name', async ($, on) => {
    const name = 'a-personal-profile-with-a-long-name'
    world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ profiles: { [name]: {} } }) } })
    const writes: string[] = []
    on('config.set', async (_$, e) => { writes.push(String(e.value)); return { value: e.value } })
    await start($)
    for (const surface of SURFACES) {
      for (const placement of ['dock', 'inline'] as const) {
        const ui = await mountPane($, surface, { placement, columns: 8, rows: 8 })
        const select = await ui.find({ key: 'profile' })
        const options = select?.props.options as { value: string; label: string }[]
        expect(options.map(o => o.value)).toContain(name)
        expect(options.every(o => o.label.length <= 8)).toBe(true)
        await ui.select({ key: 'profile', value: name })
        await release()
      }
    }
    expect(writes).toEqual([name, name, name, name])
  })

  t('profile selection denial shows the reason as a toast', async ($, on) => {
    const { seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{}' } })
    on('config.set', async () => ({ deny: 'profile settings are read-only' }))
    await start($)
    const ui = await mountPane($, 'terminal')
    await ui.select({ key: 'profile', value: 'codex' })
    expect(seen.toasts.some(text => text.includes('profile settings are read-only'))).toBe(true)
  })

  for (const surface of SURFACES) {
    t(`agents tab shows the session, the three groups and every role once (${surface})`, async ($, on) => {
      world(on)
      seed(on, {
        jobs: [job({ id: 'pjr', agent: 'fixer', description: 'wire tabs', status: 'running' }), job({ id: 'pjd', agent: 'explorer', status: 'done', description: 'map', endedAt: NOW - 30_000 })],
        natives: [native()],
      })
      await start($)
      const ui = await mountPane($, surface, { rows: 60 })
      const all = await texts(ui)
      const at = ['orchestrator', 'Running', 'Finished', 'Planned'].map(x => all.indexOf(x))
      expect(at.every(i => i >= 0)).toBe(true)
      expect(at).toEqual([...at].sort((a, b) => a - b))
      // fixer and oracle run, explorer finished; librarian, designer and council have not run yet.
      for (const name of ['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'council']) expect(all).toContain(name)
      expect(await ui.find({ key: 'tab-agents' })).toBeDefined()
      expect(await ui.find({ key: 'tab-jobs' })).toBeDefined()
      expect(all).toContain('2 running')
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
      expect(all).toContain('43.5k') // input + output of the job, in the stats beside the clock
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

  const SIX = ['explorer', 'librarian', 'fixer', 'councillor:alpha']
  const allActive = () => seed_all()
  function seed_all() {
    return {
      jobs: SIX.map((agent, k) => job({ id: `j${k}`, agent, lastActivity: 'read x' })),
      natives: [native(), native({ id: 'n2', role: 'designer', type: 'pantheon:designer' })],
      session: { isRunning: true, turnStartedAt: NOW - 5_000, model: 'opus' } as SessionInfo,
    }
  }

  t('mini stays within 8 lines and collapses the sixth active line into +1', async ($, on) => {
    world(on)
    seed(on, allActive())
    await start($)
    for (const rows of [8, 40]) {
      const ui = await mountPane($, 'terminal', { placement: 'inline', rows })
      const root = (await ui.drawn()) as { children?: unknown[] }
      expect((root.children ?? []).filter(Boolean).length <= 8).toBe(true)
      const all = await texts(ui)
      expect(all.includes('+1 active')).toBe(true)
      expect(all.includes('/pantheon for details')).toBe(true)
      expect(await ui.find({ key: 'tab-jobs' })).toBeUndefined()
      await release()
    }
  })

  t('mini degrades below three rows', async ($, on) => {
    world(on)
    seed(on, allActive())
    await start($)
    const two = await mountPane($, 'terminal', { placement: 'inline', rows: 2 })
    expect(((await two.drawn()) as { children?: unknown[] }).children?.length).toBe(2)
    expect((await texts(two)).includes('+6 active')).toBe(true)
    await release()
    const one = await mountPane($, 'terminal', { placement: 'inline', rows: 1 })
    expect(((await one.drawn()) as { children?: unknown[] }).children?.length).toBe(1)
  })

  t('inside a group the roles keep their fixed order', async ($, on) => {
    world(on)
    seed(on, { natives: [native(), native({ id: 'n2', role: 'designer', type: 'pantheon:designer' })], jobs: [job({ id: 'pjf', agent: 'fixer', description: 'x' })] })
    await start($)
    const all = await texts(await mountPane($, 'terminal'))
    const running = all.slice(all.indexOf('Running'), all.indexOf('Planned'))
    const at = ['fixer', 'oracle', 'designer'].map(name => running.indexOf(name))
    expect(at.every(i => i >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })

  const clients = async (ui: Mounted) =>
    (await ui.findAll({ type: 'Client' })).map(node => (node as unknown as { props: Record<string, any> }).props)
  const railsOf = async (ui: Mounted) => (await clients(ui)).filter(c => String(c.module).includes('rail'))

  t('docked: a pulsing dot per running agent and one in the header; planned and finished rows have none', async ($, on) => {
    world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['librarian'] }) } })
    seed(on, { natives: [native()], session: { isRunning: true, turnStartedAt: NOW - 5_000 } })
    await start($)
    await command($, 'config')
    const ui = await mountPane($, 'terminal')
    const rails = await railsOf(ui)
    expect(rails.length).toBe(3) // header, orchestrator, the running oracle
    expect(rails.every(r => r.props.isLine === false && r.props.active && r.width === 1)).toBe(true)
    const all = await texts(ui)
    expect(all).toContain('⊘') // the disabled librarian is planned and off
    expect(all).toContain('◷') // the other roles are planned and waiting
  })

  t('mini: clocks and a one-cell pulse; desktop: pulse dots are Svg, clocks stay Clients', async ($, on) => {
    world(on)
    seed(on, { natives: [native()], session: { isRunning: true, turnStartedAt: NOW - 5_000 } })
    await start($)
    const mini = await mountPane($, 'terminal', { placement: 'inline' })
    const stubs = await railsOf(mini)
    expect(stubs.length).toBe(1)
    expect(stubs[0].props.isLine).toBe(false)
    expect((await clients(mini)).some(c => String(c.module).includes('elapsed'))).toBe(true)
    await release()
    const desk = await mountPane($, 'desktop')
    expect(await railsOf(desk)).toEqual([])
    const dots = (await desk.findAll({ type: 'Svg' })).filter(n => String((n as unknown as { props: { source: string } }).props.source).includes('<animate'))
    expect(dots.length).toBe(3)
    expect((await clients(desk)).some(c => String(c.module).includes('elapsed'))).toBe(true)
  })

  t('an 8-column body produces nothing wider than 8', async ($, on) => {
    world(on)
    seed(on, {
      jobs: [job({ id: 'pj3a', description: 'map the pane render tree', lastActivity: 'rg something long' })],
      natives: [native()],
      session: { isRunning: true, turnStartedAt: NOW - 5_000, model: 'opus', context: { tokens: 100, window: 200, percent: 50 } },
    })
    await start($)
    for (const surface of SURFACES) {
      for (const tab of ['agents', 'jobs'] as const) {
        const ui = await mountPane($, surface, { columns: 8 })
        // The view persists between mounts: press only when the tab is not already showing.
        if (await ui.find({ key: `tab-${tab}` })) await ui.press({ key: `tab-${tab}` })
        expect((await texts(ui)).filter(x => x.length > 8)).toEqual([])
        const labels = (await ui.findAll({ type: 'Button' })).map(b => String((b as unknown as { props: { label?: string } }).props.label))
        expect(labels.filter(x => x.length + 4 > 8)).toEqual([])
        await release()
      }
    }
  })

  t('the job actions row stays within 8 columns on the Jobs tab', async ($, on) => {
    world(on)
    seed(on, { jobs: [job({ id: 'pj3a', description: 'map', result: 'an answer', sessionId: 's' })] })
    await start($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, { columns: 8 })
      if (await ui.find({ key: 'tab-jobs' })) await ui.press({ key: 'tab-jobs' })
      expect(await ui.find({ key: 'cancel-pj3a' })).toBeDefined()
      expect(await ui.find({ key: 'copy-pj3a' })).toBeDefined()
      // Width a node takes if drawn on one line: Buttons are `[ label ]`, rows add their gaps.
      type Node = { type?: string; props?: { label?: string; flexDirection?: string; gap?: number }; text?: string; children?: Node[] }
      const widest = (n: Node): number => {
        const kids = (n.children ?? []).filter(Boolean)
        if (n.type === 'Button') return String(n.props?.label).length + 4
        if (n.type === 'Text') return String(n.text ?? '').length
        const sizes = kids.map(widest)
        if (n.props?.flexDirection === 'column') return Math.max(0, ...sizes)
        return sizes.reduce((a, b) => a + b, 0) + Math.max(0, sizes.length - 1) * (n.props?.gap ?? 0)
      }
      expect(widest((await ui.drawn()) as Node)).toBeLessThanOrEqual(8)
      await release()
    }
  })

  t('the Jobs tab never draws taller than the body, at narrow and normal widths', async ($, on) => {
    world(on)
    const finished = Array.from({ length: 6 }, (_, k) => job({
      id: `pd${k}`, status: 'done', description: `finished task ${k}`, startedAt: NOW - 600_000 + k * 1000, endedAt: NOW - 60_000,
    }))
    const running = [0, 1].map(k => job({
      id: `pr${k}`, description: `running task ${k}`, lastActivity: 'rg x', tokens: { input: 1000, cached: 0, output: 10 }, startedAt: NOW - 5000 + k,
    }))
    seed(on, { jobs: [...running, ...finished] })
    await start($)
    // Rows a node takes: a Text or Button is one row, a column adds its children and gaps, a border adds two.
    type Node = { type?: string; props?: { flexDirection?: string; gap?: number; borderStyle?: string }; children?: Node[] }
    const tallest = (n: Node): number => {
      if (n.type === 'Text' || n.type === 'Button' || n.type === 'Client') return 1
      const sizes = (n.children ?? []).filter(Boolean).map(tallest)
      const inner = n.props?.flexDirection === 'column'
        ? sizes.reduce((a, b) => a + b, 0) + Math.max(0, sizes.length - 1) * (n.props?.gap ?? 0)
        : Math.max(0, ...sizes)
      return inner + (n.props?.borderStyle ? 2 : 0)
    }
    for (const surface of SURFACES) {
      for (const [columns, rows] of [[20, 20], [8, 20], [11, 14], [40, 16], [120, 12], [20, 40]] as const) {
        const ui = await mountPane($, surface, { columns, rows })
        if (await ui.find({ key: 'tab-jobs' })) await ui.press({ key: 'tab-jobs' })
        expect({ surface, columns, rows, height: tallest((await ui.drawn()) as Node) <= rows }).toEqual({ surface, columns, rows, height: true })
        const ids = new Set(await texts(ui))
        const drawn = [...running, ...finished].filter(j => ids.has(j.id)).length
        if (rows === 20 && columns === 20) {
          // Three rows per finished job at 20 columns: fewer than all six fit, and the rest are counted.
          expect(drawn).toBeLessThan(8)
          expect((await texts(ui)).some(x => /^\+\d+ (older )?jobs hidden$/.test(x))).toBe(true)
        }
        if (rows === 40) expect(drawn).toBe(8)
        await release()
      }
    }
  })

  t('the clock warning shows in docked at 40 columns and in mini', async ($, on) => {
    let fail = false
    world(on, { clockDown: () => fail })
    seed(on, { jobs: [job({ id: 'pj3a', description: 'map' })], session: { isRunning: true, turnStartedAt: NOW - 5_000 } })
    await start($)
    fail = true
    const docked = await mountPane($, 'terminal', { columns: 40 })
    expect((await texts(docked)).includes('clock unavailable')).toBe(true)
    await docked.press({ key: 'tab-jobs' })
    expect((await texts(docked)).includes('clock unavailable')).toBe(true)
    await release()
    const mini = await mountPane($, 'terminal', { placement: 'inline', columns: 60 })
    expect((await texts(mini)).includes('clock unavailable')).toBe(true)
    await release()
    const narrow = await mountPane($, 'terminal', { placement: 'inline', columns: 20 })
    expect((await texts(narrow)).some(x => x.startsWith('clock'))).toBe(true)
  })

  t('desktop text and chips use the artboard hex values', async ($, on) => {
    world(on)
    seed(on, { natives: [native()] })
    await start($)
    const ui = await mountPane($, 'desktop')
    const colors = (await ui.findAll({ type: 'Text' })).map(node => String((node as unknown as { props: { color?: string } }).props.color))
    expect(colors.includes('#b58af0')).toBe(true) // claude
    expect(colors.includes('#4fb383')).toBe(true) // running
    expect(colors.map(c => c.toLowerCase()).includes('#a56bd8')).toBe(true) // the oracle's role color
    const borders = (await ui.findAll({ type: 'Box' })).map(node => (node as unknown as { props: { borderColor?: string; backgroundColor?: string } }).props)
    expect(borders.flatMap(p => [p.borderColor, p.backgroundColor]).filter(c => c && !c.startsWith('#'))).toEqual([])
    expect(colors.some(c => !c.startsWith('#') && c !== 'undefined')).toBe(false)
  })

  // Rows a node takes: a Text or Button is one, a Client or Svg its declared height, a column adds its
  // children, a row takes the tallest, a border adds two.
  type Node = { type?: string; props?: { flexDirection?: string; gap?: number; borderStyle?: string; height?: number }; children?: Node[] }
  const rowsOf = (n: Node): number => {
    if (n.type === 'Text' || n.type === 'Button') return 1
    if (n.type === 'Client') return n.props?.height ?? 1
    if (n.type === 'Svg') return Math.ceil((n.props?.height ?? 20) / 20)
    const sizes = (n.children ?? []).filter(Boolean).map(rowsOf)
    const inner = n.props?.flexDirection === 'column'
      ? sizes.reduce((a, b) => a + b, 0) + Math.max(0, sizes.length - 1) * (n.props?.gap ?? 0)
      : Math.max(0, ...sizes)
    return inner + (n.props?.borderStyle ? 2 : 0)
  }

  const busy = () => ({
    jobs: [
      job({ id: 'pj1', agent: 'explorer', description: 'map', lastActivity: 'rg x', tokens: { input: 1000, cached: 0, output: 10 } }),
      job({ id: 'pj2', agent: 'councillor:alpha', description: 'weigh' }),
      job({ id: 'pj3', agent: 'fixer', status: 'done', description: 'tests', endedAt: NOW - 1000, sessionId: 's' }),
    ],
    natives: [native(), native({ id: 'n2', role: 'librarian', type: 'pantheon:librarian', rounds: [{ startedAt: 1, endedAt: 2, status: 'done' }] })],
    session: { isRunning: true, turnStartedAt: NOW - 5_000, model: 'opus', costUsd: 0.5 } as SessionInfo,
  })

  t('the Agents tab never draws taller than the body, at small and normal heights', async ($, on) => {
    world(on)
    seed(on, busy())
    await start($)
    for (const surface of SURFACES) {
      for (const [columns, rows] of [[70, 3], [70, 6], [70, 9], [70, 12], [70, 16], [70, 24], [70, 40], [70, 70], [40, 10], [40, 20], [20, 12], [8, 12], [120, 30]] as const) {
        const ui = await mountPane($, surface, { columns, rows })
        const height = rowsOf((await ui.drawn()) as Node)
        expect({ surface, columns, rows, fits: height <= rows, height }).toEqual({ surface, columns, rows, fits: true, height })
        await release()
      }
    }
  })

  t('a short body keeps the running agents and folds the rest into headings', async ($, on) => {
    world(on)
    seed(on, busy())
    await start($)
    const all = await texts(await mountPane($, 'terminal', { rows: 14 }))
    expect(all).toContain('map') // the running rows stay, one line each
    expect(all).toContain('Finished')
    expect(all).not.toContain('tests')
    expect(all).toContain('3 running')
  })

  t('docked: each agent row carries a mascot Client of its role and mood, the session one at the same size', async ($, on) => {
    world(on)
    seed(on, busy())
    await start($)
    const ui = await mountPane($, 'terminal', { rows: 70 })
    const mascots = (await clients(ui)).filter(c => String(c.module).includes('mascot')).map(c => c.props)
    const of = (role: string) => mascots.filter(m => m.role === role)
    expect(of('orchestrator')).toEqual([{ role: 'orchestrator', mood: 'work', size: 'small' }])
    expect(of('explorer')).toEqual([{ role: 'explorer', mood: 'work', size: 'small' }])
    expect(of('oracle')).toEqual([{ role: 'oracle', mood: 'work', size: 'small' }])
    expect(of('fixer')).toEqual([{ role: 'fixer', mood: 'idle', size: 'small' }]) // finished
    expect(of('designer')).toEqual([{ role: 'designer', mood: 'off', size: 'small' }]) // planned
    const sizes = (await clients(ui)).filter(c => String(c.module).includes('mascot')).map(c => [c.width, c.height])
    expect(sizes).not.toContainEqual([15, 6])
    expect(sizes).toContainEqual([8, 3])
  })

  t('docked without a Client draws static colorless mascot rows with the same layout', async ($, on) => {
    let fail = false
    world(on, { clockDown: () => fail })
    seed(on, busy())
    await start($)
    fail = true
    const ui = await mountPane($, 'terminal', { rows: 70 })
    expect(await clients(ui)).toEqual([])
    const all = await texts(ui)
    const rows = clawdLines('explorer', 'work', 0, 'small').map(x => x.trim())
    for (const row of rows) expect(all).toContain(row)
    expect(all).toContain(clawdLines('orchestrator', 'work', 0, 'small')[0].trim())
    const colored = (await ui.findAll({ type: 'Text' })).filter(n => String(n.text).trim() === rows[0])
    expect(colored.every(n => (n as unknown as { props: { color?: string } }).props.color === undefined)).toBe(true)
  })

  t('desktop draws every mascot through Svg from clawdSvg, animated only while working', async ($, on) => {
    world(on)
    seed(on, busy())
    await start($)
    const ui = await mountPane($, 'desktop', { rows: 70 })
    const svgs = (await ui.findAll({ type: 'Svg' })).map(n => (n as unknown as { props: { source: string; alt: string; isInteractive?: boolean; height: number } }).props)
    const mascot = (role: string, mood: string) => svgs.filter(s => s.alt === `${role} mascot, ${mood}`)
    expect(mascot('orchestrator', 'work').length).toBe(1)
    expect(mascot('orchestrator', 'work')[0].source).toBe(clawdSvg('orchestrator', 'work', 92))
    expect(mascot('explorer', 'work')[0].source).toBe(clawdSvg('explorer', 'work', 48))
    expect(mascot('explorer', 'work')[0].isInteractive).toBe(true)
    expect(mascot('fixer', 'idle')[0].isInteractive).toBeFalsy()
    expect(mascot('designer', 'off')[0].source).toBe(clawdSvg('designer', 'off', 48))
    expect((await clients(ui)).filter(c => String(c.module).includes('mascot'))).toEqual([])
  })

  t('the session shows cost, tokens and time as tiles on desktop and as one line docked', async ($, on) => {
    world(on)
    seed(on, busy())
    await start($)
    const desk = await mountPane($, 'desktop', { rows: 70 })
    expect(await desk.find({ key: 'tile-cost' })).toBeDefined()
    expect(await desk.find({ key: 'tile-tokens' })).toBeDefined()
    expect(await desk.find({ key: 'tile-time' })).toBeDefined()
    expect(await texts(desk)).toContain('≈$0.50')
    await release()
    const term = await mountPane($, 'terminal', { rows: 70 })
    expect(await term.find({ key: 'tile-cost' })).toBeUndefined()
    const all = await texts(term)
    for (const label of ['Cost', 'Tokens', 'Time']) expect(all).toContain(label)
    expect(all).toContain('≈$0.50')
  })

  t('a group folds and unfolds with its button and the choice persists', async ($, on) => {
    world(on)
    seed(on, busy())
    await start($)
    const ui = await mountPane($, 'terminal', { rows: 70 })
    expect(await texts(ui)).toContain('pj1')
    await ui.press({ key: 'toggle-running' })
    const folded = await texts(ui)
    expect(folded).toContain('Running')
    expect(folded).not.toContain('pj1')
    const labels = async (u: Mounted) => (await u.findAll({ type: 'Button' })).map(b => String((b as unknown as { props: { label?: string } }).props.label))
    expect(await labels(ui)).toContain('Expand')
    await release()
    expect(await texts(await mountPane($, 'terminal', { rows: 70 }))).not.toContain('pj1')
    await release()
    const again = await mountPane($, 'terminal', { rows: 70 })
    await again.press({ key: 'toggle-running' })
    expect(await texts(again)).toContain('pj1')
  })

  t('the close button closes the pane', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const ui = await mountPane($, 'terminal', { columns: 70 })
    await ui.press({ key: 'close' })
    expect(seen.closed).toContain(PANE_ID)
  })

  t('the Jobs tab lists Claude agent rounds read-only, so it is not empty on the claude profile', async ($, on) => {
    world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ profile: 'claude' }) } })
    seed(on, { natives: [native({ rounds: [
      { startedAt: NOW - 200_000, endedAt: NOW - 152_000, status: 'done' },
      { startedAt: NOW - 134_000, status: 'running' },
    ] })] })
    await start($)
    await command($, 'config')
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, { rows: 40 })
      if (await ui.find({ key: 'tab-jobs' })) await ui.press({ key: 'tab-jobs' })
      const all = await texts(ui)
      expect(all).not.toContain('No Pantheon jobs in this session.')
      expect(all).toContain('Claude agent rounds')
      expect(all).toContain('read-only')
      expect(all).toContain('Review the lifecycle')
      expect(all).toContain('oracle')
      expect(all).toContain('✓ r1')
      expect(all).toContain('0:48')
      expect(all).toContain('● r2')
      expect(await ui.find({ key: 'cancel-n1' })).toBeUndefined()
      expect(await ui.find({ key: 'copy-n1' })).toBeUndefined()
      expect((await ui.findAll({ type: 'Button' })).map(b => String((b as unknown as { props: { key?: string } }).props.key)).filter(k => k.startsWith('cancel-') || k.startsWith('copy-'))).toEqual([])
      await release()
    }
  })

  t('the Jobs tab keeps Codex jobs with their buttons beside the Claude rounds and stays within the body', async ($, on) => {
    world(on)
    seed(on, busy())
    await start($)
    for (const surface of SURFACES) {
      for (const rows of [6, 10, 14, 20, 40]) {
        const ui = await mountPane($, surface, { rows })
        if (await ui.find({ key: 'tab-jobs' })) await ui.press({ key: 'tab-jobs' })
        expect({ surface, rows, fits: rowsOf((await ui.drawn()) as Node) <= rows }).toEqual({ surface, rows, fits: true })
        if (rows === 40) {
          expect(await ui.find({ key: 'cancel-pj1' })).toBeDefined()
          expect(await ui.find({ key: 'copy-pj3' })).toBeDefined()
          expect(await texts(ui)).toContain('Claude agent rounds')
        }
        await release()
      }
    }
  })

  t('an idle line keeps the role name at 40 columns', async ($, on) => {
    world(on)
    seed(on, {
      jobs: [job({ id: 'pj1234567', agent: 'councillor:alpha', status: 'done', endedAt: NOW - 900_000, sessionId: 'sess' })],
      natives: [native({ id: 'zz', role: 'councillor-beta', type: 'pantheon:councillor-beta', rounds: [{ startedAt: 1, endedAt: 2, status: 'done' }] })],
    })
    await start($)
    const ui = await mountPane($, 'terminal', { columns: 40 })
    const all = await texts(ui)
    expect(all).toContain('council')
    expect(all.filter(x => x.length > 40)).toEqual([])
  })

  t('a short body degrades the planned and finished groups to their headings', async ($, on) => {
    world(on)
    await start($)
    const tall = await texts(await mountPane($, 'terminal', { rows: 60, bodyRows: 60 }))
    expect(tall.filter(x => x === 'disabledAgents').length).toBe(0)
    expect(tall).toContain('Waiting for work')
    await release()
    const short = await texts(await mountPane($, 'terminal', { rows: 40, bodyRows: 14 }))
    expect(short).toContain('Planned')
    expect(short).not.toContain('Waiting for work')
  })

  t('a failing clock read draws without clocks and says so', async ($, on) => {
    let fail = false
    world(on, { clockDown: () => fail })
    seed(on, { jobs: [job({ id: 'pj3a', description: 'map' })], session: { isRunning: true, turnStartedAt: NOW - 5_000 } })
    await start($)
    const ok = await mountPane($, 'terminal')
    expect((await texts(ok)).some(x => x.includes('clock unavailable'))).toBe(false)
    await release()
    fail = true
    const ui = await mountPane($, 'terminal')
    const all = await texts(ui)
    expect(all.includes('clock unavailable')).toBe(true)
    expect(all).toContain('pj3a')
    expect(await clients(ui)).toEqual([])
  })

  t('a failed tab write shows one toast and does not throw', async ($, on) => {
    const { seen } = world(on)
    let deny = false
    on('state.set', async (_$, e, next) => (deny && e.key === 'view' ? { deny: 'view storage unavailable' } : next(e)))
    await start($)
    deny = true
    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'tab-jobs' })
    await ui.press({ key: 'tab-agents' })
    await ui.press({ key: 'tab-jobs' })
    const toasts = seen.toasts.filter(x => x.includes('could not save the panel state'))
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toContain('view storage unavailable')
  })

  t('fast tab switches persist in order even when the first write is slow', async ($, on) => {
    const { clock } = world(on)
    const stored: string[] = []
    let slowed = false
    on('state.set', async (_$, e, next) => {
      if (e.key !== 'view') return next(e)
      const tab = (e.value as { tab: string }).tab
      if (tab === 'jobs' && !slowed) { slowed = true; await clock.sleep(10) }
      const result = await next(e)
      if (result.value.isSet) stored.push(tab)
      return result
    })
    await start($)
    const ui = await mountPane($, 'terminal')
    const first = ui.press({ key: 'tab-jobs' })
    await clock.settle()
    const second = ui.press({ key: 'tab-agents' })
    await clock.settle()
    await clock.advance(10)
    await Promise.all([first, second])
    await clock.settle()
    expect(stored[stored.length - 1]).toBe('agents')
    expect(await ui.find({ key: 'tab-agents' })).toBeDefined()
    const labels = (await ui.findAll({ type: 'Button' })).map(b => String((b as unknown as { props: { label?: string } }).props.label))
    expect(labels).toContain('● Agents')
  })

  for (const surface of SURFACES) {
    t(`an active council shows its disabled seat as off (${surface})`, async ($, on) => {
      world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['councillor:alpha'] }) } })
      seed(on, { natives: [native({ id: 'cb1', role: 'councillor-beta', type: 'pantheon:councillor-beta', task: 'weigh in' })] })
      await start($)
      await command($, 'config')
      const all = await texts(await mountPane($, surface))
      expect(all).toContain('cb1')
      expect(all).toContain('alpha off')
      await release()
      const mini = await texts(await mountPane($, 'terminal', { placement: 'inline' }))
      expect(mini).toContain('⊘ alpha off')
    })
  }

  t('mini summarizes other agents and keeps active roles', async ($, on) => {
    world(on)
    seed(on, { natives: [native(), native({ id: 'x9', role: 'other', type: 'Explore', task: 'survey' })] })
    await start($)
    const ui = await mountPane($, 'terminal', { placement: 'inline', rows: 8 })
    const root = (await ui.drawn()) as { children?: unknown[] }
    expect((root.children ?? []).filter(Boolean).length <= 8).toBe(true)
    const all = await texts(ui)
    expect(all).toContain('● 1 other agent')
    expect(all).toContain('n1') // the active oracle stays visible
  })

  t('a lost earlier round shows no invented duration', async ($, on) => {
    world(on)
    seed(on, { jobs: [
      job({ id: 'pl1', agent: 'fixer', status: 'lost', sessionId: 's', startedAt: NOW - 600_000 }),
      job({ id: 'pl2', agent: 'fixer', status: 'running', sessionId: 's', startedAt: NOW - 60_000 }),
    ] })
    await start($)
    const all = await texts(await mountPane($, 'terminal'))
    expect(all).toContain('■ ?')
    expect(all).toContain('■ now')
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
    expect(seen.statuses).toContain('pantheon: 0 running · 1 in background')
    await $.tool.call({ tool: 'mcp__pantheon__delegate_cancel', jobId: out.jobId } as never)
    expect(seen.statuses[seen.statuses.length - 1]).toBeUndefined()
    expect(statusText([])).toBeUndefined()
  })

  t('/pantheon config shows origins and current error', async ($, on) => {
    const { files } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ noNetwork: true }) } })
    await start($)
    const ok = await command($, 'config')
    expect(ok.text).toContain('Valid config')
    expect(ok.text).toContain('noNetwork: user')
    files[`${HOME}/.claude/pantheon.json`] = '{ broken'
    const bad = await command($, 'config')
    expect(bad.text).toContain('Invalid config')
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
    expect(out.text).toContain('authorized root: /repo')
    expect(out.text).not.toContain('fail')
  })

  t('/pantheon cancel without id shows usage', async ($, on) => {
    world(on)
    await start($)
    expect((await command($, 'cancel')).text).toContain('Usage')
  })
})

describe('timelineSource', () => {
  const NOW_T = 10_000_000
  const slot = (over: Partial<Slot> & { name: Slot['name'] }): Slot => ({ engine: 'codex', state: 'idle', instances: [], ...over })
  const inst = (over: object) => ({
    id: 'i', engine: 'codex' as const, task: '', status: 'running', isActive: true, startedAt: NOW_T - 60_000,
    rounds: [{ startedAt: NOW_T - 60_000, status: 'running' }], tokens: { out: 0 }, ...over,
  })
  const slots: Slot[] = [
    slot({ name: 'orchestrator', engine: 'claude', state: 'active' }),
    slot({ name: 'explorer', state: 'active', instances: [inst({ id: 'a' }), inst({ id: 'b', startedAt: NOW_T - 30_000, rounds: [{ startedAt: NOW_T - 30_000, status: 'running' }] })] }),
    slot({ name: 'librarian' }),
    slot({ name: 'fixer', state: 'active', instances: [inst({ id: 'f', rounds: [
      { startedAt: NOW_T - 800_000, endedAt: NOW_T - 600_000, status: 'done' },
      { startedAt: NOW_T - 60_000, status: 'running' },
    ] })] }),
    slot({ name: 'oracle', engine: 'claude', state: 'active', instances: [inst({ id: 'o', engine: 'claude' })] }),
    slot({ name: 'designer', engine: 'claude', lastEndedAt: NOW_T - 2_000_000 }),
    slot({ name: 'council', state: 'off', offReason: 'disabledAgents' }),
  ]
  const out = timelineSource(slots, { isRunning: true, turnStartedAt: NOW_T - 120_000 }, NOW_T).source

  test('running bars are solid in the engine color, finished ones outlined', () => {
    expect(out).toContain('fill="#6aa3f0"/>')
    expect(out).toContain('fill="#b58af0"/>')
    expect(out).toContain('fill="#1f3350" stroke="#6aa3f0"')
    expect(out).toContain('fill="#242423"') // the dark card
  })
  test('rounds of one session are labelled and joined by a dashed line', () => {
    expect(out).toContain('>r1</text>')
    expect(out).toContain('>r2</text>')
    expect(out).toContain('stroke-dasharray="2 3"')
  })
  test('off roles get a dotted lane with an off pill, idle roles their last run', () => {
    expect(out).toContain('stroke-dasharray="1 4"')
    expect(out).toContain('>off</text>')
    expect(out).toContain('last run 33m ago')
  })
  test('two independent recent runs of one role draw two bars', () => {
    const jobs: Job[] = [
      { id: 'ja', agent: 'explorer', status: 'done', startedAt: NOW_T - 600_000, endedAt: NOW_T - 500_000, cwd: '/repo' },
      { id: 'jb', agent: 'explorer', status: 'done', startedAt: NOW_T - 300_000, endedAt: NOW_T - 200_000, cwd: '/repo' },
      { id: 'jold', agent: 'explorer', status: 'done', startedAt: NOW_T - 3_000_000, endedAt: NOW_T - 2_000_000, cwd: '/repo' },
    ]
    const roster = buildRoster({ jobs, natives: [], session: { isRunning: false }, config: MIXED })
    // The card keeps only the latest; the timeline draws both runs inside the window, not the old one.
    expect(roster.slots[1].instances.map(i => i.id)).toEqual(['jb'])
    const svg = timelineSource(roster.slots, { isRunning: false }, NOW_T).source
    expect(svg.split('fill="#1f3350" stroke="#6aa3f0"').length - 1).toBe(2)
    expect(svg).toContain('>ja</text>')
    expect(svg).toContain('>jb</text>')
    expect(svg).not.toContain('>jold</text>')
  })
  test('a lost round with no end is a tick at its start, not a bar to now', () => {
    const lost: Slot[] = [slot({ name: 'fixer', instances: [inst({ id: 'l', isActive: false, status: 'lost',
      rounds: [{ startedAt: NOW_T - 600_000, status: 'lost' }] })] })]
    const svg = timelineSource(lost, { isRunning: false }, NOW_T).source
    expect(svg).toContain('width="3" height="12" fill="#e0a94a"/>')
    expect(svg).not.toContain('stroke="#6aa3f0"/>')
    expect(svg).not.toContain('fill="#6aa3f0"/>')
  })
  test('parallel instances label their ids and the now line closes the window', () => {
    expect(out).toContain('>a</text>')
    expect(out).toContain('>b</text>')
    expect(out).toContain('>now</text>')
  })
})
