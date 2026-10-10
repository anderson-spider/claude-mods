import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { HOME, start, world } from './fixtures/world'
import { PANE_ID, configReport, doctorReport, drawPanel, timelineSource } from '../hooks/pane'
import { loadConfig } from '../hooks/config'
import { buildRoster } from '../hooks/roster'
import { BAD, OK, ROLE_COLOR, SECTION_COLOR, cellWidth } from '../hooks/theme'
import type { Slot } from '../hooks/roster'
import { DEFAULTS } from './fixtures/config'
import type { Native, PanelView, SessionInfo } from '../hooks/types'

const SURFACES = ['terminal', 'desktop'] as const
const rgba = (hex: string, a: number) => `rgba(${[1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16)).join(',')},${a})`
const NOW = 1_000_000_000

test('config report lists the effective config and the origins of what was set', async () => {
  const config = await loadConfig(async () => '{"disabledAgents":["qa"],"agents":{"architect":{"effort":"high"}}}', { user: 'fixture' })
  const report = configReport(config)
  expect(report.split('\n')[0]).toBe('Valid config.')
  expect(report).toContain('- disabledAgents: user')
  expect(report).toContain('- agents.architect.effort: user')
  expect(report).not.toMatch(/profile|codex|sandbox/i)
  expect(configReport(await loadConfig(async () => undefined, { user: 'fixture' }))).toContain('- every field at its default')
})

test('config report names the error of an invalid config', async () => {
  const config = await loadConfig(async () => '{"profile":"codex"}', { user: 'fixture' })
  expect(configReport(config)).toContain('Invalid config: fixture: profile: profiles were removed')
})

test('doctor report adds a ping section only when pings are given', async () => {
  const config = await loadConfig(async () => '{}', { user: 'fixture' })
  const facts = { config }
  expect(doctorReport(facts)).toBe('ok   config')
  const report = doctorReport({
    ...facts,
    pings: [
      { name: 'code-reader', model: 'haiku', state: 'ok', ms: 1200 },
      { name: 'architect', model: 'opus', state: 'fail', detail: 'timeout' },
      { name: 'developer', model: 'sonnet', state: 'pending' },
      { name: 'ux', state: 'off' },
    ],
  }).split('\n')
  expect(report).toContain('ping')
  expect(report).toContain('ok   code-reader (haiku) 1.2s')
  expect(report).toContain('fail architect (opus): timeout')
  expect(report).toContain('pending developer (sonnet) — the session confirms')
  expect(report).toContain('info ux off')
})

test('doctor report marks an invalid config', async () => {
  const config = await loadConfig(async () => '{ broken', { user: 'fixture' })
  expect(doctorReport({ config })).toBe('fail config: fixture: Invalid JSON')
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

// Serves the draw-time state reads, standing for what tracking would have written.
function seed(on: On, data: { natives?: Native[]; session?: SessionInfo; view?: PanelView }) {
  on('state.get', async (_$, e, next) => {
    const value = data[e.key as keyof typeof data]
    return value === undefined ? next(e) : ({ value: { value, version: 1 } } as never)
  })
}

/** A native of `role` with a single round (override `rounds` for more); `status` and the times shape that round. */
const run = (over: Partial<Native> & { status?: 'running' | 'done' | 'failed' | 'stopped' | 'lost'; startedAt?: number; endedAt?: number } = {}): Native => {
  const { status = 'running', startedAt = NOW - 60_000, endedAt, ...rest } = over
  const role = rest.role ?? 'code-reader'
  return {
    id: 'j1', role, type: `pantheon:${role}`, task: '', model: 'haiku', ctx: 0, out: 0, steps: 0,
    rounds: [{ startedAt, status, ...(endedAt !== undefined ? { endedAt } : {}) }], ...rest,
  }
}
const native = (over: Partial<Native> = {}): Native => ({
  id: 'n1', role: 'architect', type: 'pantheon:architect', task: 'Review the lifecycle', model: 'opus',
  rounds: [{ startedAt: NOW - 120_000, status: 'running' }], ctx: 5200, out: 310, steps: 4, lastTool: 'Read jobs.ts', ...over,
})

const t = (name: string, fn: (...args: Parameters<Parameters<typeof test>[1]>) => Promise<void>) =>
  test(name, async (...args) => {
    try { await fn(...args) } finally { await release() }
  })

describe('pane', () => {
  for (const surface of SURFACES) t(`the roles have an Idle row each and no git (${surface})`, async ($, on) => {
    world(on)
    await start($)
    const ui = await mountPane($, surface, { rows: 100 })
    expect(await ui.find({ key: 'idle-ux' })).toBeDefined()
    expect(await ui.find({ key: 'idle-git' })).toBeUndefined()
    expect(Object.keys(ROLE_COLOR)).not.toContain('git')
  })

  for (const surface of SURFACES) t(`header shows working when only the main session runs (${surface})`, async ($, on) => {
    world(on)
    seed(on, { session: { isRunning: true, turnStartedAt: NOW - 5000 } })
    await start($)
    const ui = await mountPane($, surface, { rows: 70 })
    const working = (await ui.findAll({ type: 'Text' })).filter(n => String(n.text).trim() === 'working')
    expect(working).toHaveLength(surface === 'desktop' ? 1 : 2) // desktop: the header's badge only
    for (const node of working) expect((node as unknown as { props: { color: string } }).props.color)
      .toBe(surface === 'desktop' ? '#4fb383' : 'success')
    expect(await texts(ui)).not.toContain('idle')
  })

  for (const surface of SURFACES) t(`the pane is the agents view only: no tabs, no jobs text, footer keys left (${surface})`, async ($, on) => {
    world(on)
    seed(on, { natives: [run(), native()] })
    await start($)
    const ui = await mountPane($, surface, { rows: 70 })
    for (const key of ['tab-agents', 'tab-jobs', 'pill-agents', 'pill-jobs', 'jobs-count', 'key-jobs']) expect(await ui.find({ key })).toBeUndefined()
    const all = await texts(ui)
    expect(all.filter(x => /jobs|resum|Copy/i.test(x) && x !== 'Read jobs.ts')).toEqual([])
    expect(all.some(x => /^Jobs/.test(x))).toBe(false)
    if (surface === 'desktop') {
      expect(all).toContain('keys:')
      expect(all).toContain('esc close')
    } else {
      expect(all).toContain('keys: esc close')
    }
    const buttons = (await ui.findAll({ type: 'Button' })).map(b => (b as unknown as { props: { hotkey?: string } }).props)
    expect(buttons.some(b => b.hotkey === '1' || b.hotkey === '2')).toBe(false)
  })

  for (const surface of SURFACES) {
    t(`agents view shows the session, the three groups and every role once (${surface})`, async ($, on) => {
      world(on)
      seed(on, {
        natives: [run({ id: 'pjr', role: 'developer', task: 'wire tabs', status: 'running' }), run({ id: 'pjd', role: 'code-reader', status: 'done', task: 'map', endedAt: NOW - 30_000 }), native()],
      })
      await start($)
      const ui = await mountPane($, surface, { rows: 60 })
      const all = await texts(ui)
      const at = ['Session', 'Agents · running', 'Agents · idle'].map(x => all.indexOf(x))
      expect(at.every(i => i >= 0)).toBe(true)
      expect(at).toEqual([...at].sort((a, b) => a - b))
      // developer and architect run, code-reader finished; docs-reader, ux and council have not run yet.
      for (const name of ['code-reader', 'docs-reader', 'developer', 'architect', 'qa', 'ux', 'council α', 'council β']) expect(all).toContain(name)
      expect(all).toContain('2 running')
    })

    t(`an active code-reader shows its instance, activity and clock (${surface})`, async ($, on) => {
      world(on)
      seed(on, { natives: [run({
        id: 'pj3a', task: 'map pane render tree', lastTool: "rg 'x' plugins/", ctx: 41200, out: 2300,
      })] })
      await start($)
      const ui = await mountPane($, surface)
      const all = await texts(ui)
      expect(all.some(x => x.includes('map pane render tree'))).toBe(true)
      expect(all.some(x => x.includes("rg 'x' plugins/"))).toBe(true)
      expect(all).toContain('41.2k↑ 2.3k↓') // the native's context and output, in the session tokens
      expect(all).toContain('1 running')
      // The clock is a Client where the surface has one, else a Text.
      expect((await ui.find({ key: 'clk-pj3a' })) ?? all.find(x => /^\d+:\d\d$/.test(x))).toBeDefined()
    })

    if (surface === 'desktop') t('desktop: the running badge is a bordered pill with a pulsing dot, the close button has room, and the mount is accepted by the engine', async ($, on) => {
      world(on)
      seed(on, { natives: [run({ id: 'pj3a', task: 'map pane render tree' })] })
      await start($)
      const ui = await mountPane($, 'desktop', { rows: 70 })
      const badge = await ui.find({ key: 'header-badge' })
      expect((badge as unknown as { props: Record<string, unknown> }).props).toMatchObject({ borderStyle: 'round', alignItems: 'center' })
      const dot = (await ui.findAll({ type: 'Svg' })).map(n => (n as unknown as { props: { alt: string; source: string; isInteractive?: boolean } }).props).find(p => p.alt === 'running')
      expect(dot?.isInteractive).toBeUndefined()
      expect(dot?.source).toContain('<animate')
      expect(await ui.find({ key: 'close-box' })).toBeDefined()
      const all = await texts(ui)
      for (const x of ['Pantheon', '1 running', 'Session', 'Agents · running', 'Agents · idle']) expect(all).toContain(x)
    })

    t(`a native with two rounds shows round 2 (${surface})`, async ($, on) => {
      world(on)
      seed(on, { natives: [run({ id: 'pjr', role: 'developer', task: 'wire tabs', rounds: [
        { startedAt: NOW - 300_000, endedAt: NOW - 200_000, status: 'stopped' },
        { startedAt: NOW - 60_000, status: 'running' },
      ] })] })
      await start($)
      const ui = await mountPane($, surface)
      // The strip holds one block per round: the stopped first round and the running second one.
      if (surface === 'desktop') {
        const strips = (await ui.findAll({ type: 'Svg' })).map(n => (n as unknown as { props: { alt: string; source: string } }).props).filter(p => p.alt === 'rounds')
        expect(strips.filter(p => p.source.split('<rect').length - 1 === 2)).toHaveLength(1)
      } else {
        // Two bars for the developer; roles that never ran have none.
        expect((await texts(ui)).filter(x => x === '▰')).toHaveLength(2)
      }
    })


    t(`off role shows disabledAgents (${surface})`, async ($, on) => {
      world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['docs-reader'] }) } })
      await start($)
      await command($, 'config')
      const ui = await mountPane($, surface, { rows: 70 })
      const all = await texts(ui)
      expect(all.some(x => x.includes('disabledAgents'))).toBe(true)
      expect(all).toContain('⊘')
    })

    t(`running rows have no Cancel button and no job id (${surface})`, async ($, on) => {
      world(on)
      seed(on, {
        natives: [run({ id: 'pjr', role: 'developer', status: 'running' }), run({ id: 'pjd', role: 'code-reader', status: 'done', endedAt: NOW - 30_000 }), native()],
      })
      await start($)
      const ui = await mountPane($, surface, { rows: 70 })
      const labels = (await ui.findAll({ type: 'Button' })).map(b => (b as unknown as { props: { label: string } }).props.label)
      expect(labels.filter(x => x === 'Cancel' || x === 'x')).toEqual([])
      expect(await ui.find({ key: 'cancel-pjr' })).toBeUndefined()
      const all = await texts(ui)
      expect(all.some(x => x.includes('pjr'))).toBe(false)
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

  t('desktop draws section cards in native bordered boxes with native rows and fixed numeric slots', async ($, on) => {
    world(on)
    await start($)
    const ui = await mountPane($, 'desktop', { columns: 86, rows: 70 })
    const props = async (key: string) => {
      const node = await ui.find({ key })
      if (!node) throw new Error(`Missing desktop node: ${key}`)
      return (node as unknown as { props: Record<string, unknown> }).props
    }
    expect(await props('header')).toMatchObject({ flexDirection: 'column', width: 80 })
    expect(await props('header-top')).toMatchObject({ height: 1.7, width: 80, alignItems: 'center' })
    expect(await props('session')).toMatchObject({ width: 80, paddingX: 1, borderStyle: 'round', flexDirection: 'column' })
    expect(await props('idle-rows')).toMatchObject({ width: 80, flexDirection: 'column', borderStyle: 'round' })
    expect(String((await props('idle-rows')).borderColor)).toMatch(/^#/)
    const svgs = (await ui.findAll({ type: 'Svg' })).map(n => (n as unknown as { props: { alt: string; source: string; width: number; height: number; isInteractive?: boolean } }).props)
    expect(svgs.some(p => p.alt === 'card background')).toBe(false)
    expect(await ui.find({ key: 'toggle-idle' })).toBeUndefined()
    expect(await ui.find({ key: 'idle-code-reader' })).toBeDefined()
    expect((await texts(ui)).filter(x => x === '—')).toHaveLength(4) // only the Session readings; a role that never ran leaves its time and task blank
    expect((await texts(ui)).some(t => t.includes('▎') || t.includes('━'))).toBe(false)
    const dividers = svgs.filter(p => p.alt === 'divider')
    expect(dividers.length).toBeGreaterThan(0)
    for (const p of dividers) expect(p).toMatchObject({ width: 640, height: 1 })
    expect(svgs.filter(p => p.alt === 'idle').every(p => !p.isInteractive)).toBe(true)
  })

  t('desktop: cards never overlap, they size to their content (a border, no fixed height) with a gap, and no rails', async ($, on) => {
    world(on)
    seed(on, busy())
    await start($)
    const ui = await mountPane($, 'desktop', { columns: 86, rows: 80 })
    expect(await railsOf(ui)).toEqual([])
    for (const key of ['session', 'running-rows', 'idle-rows']) {
      const p = (await ui.find({ key }) as unknown as { props: { height?: number; marginBottom?: number } }).props
      expect(p.height).toBeUndefined()
      expect((p as { borderStyle?: string }).borderStyle).toBe('round')
      expect(p.marginBottom).toBeGreaterThan(0)
    }
  })

  t('desktop: the header and the cards are spaced, and no group can be folded', async ($, on) => {
    world(on)
    seed(on, { ...busy(), view: { collapsed: ['running', 'idle'] } })
    await start($)
    const ui = await mountPane($, 'desktop', { columns: 86, rows: 80 })
    const props = async (key: string) => (await ui.find({ key }) as unknown as { props: Record<string, unknown> }).props
    expect(await props('header')).toMatchObject({ marginBottom: 1 })
    for (const key of ['session', 'running-rows', 'idle-rows']) expect((await props(key)).marginBottom).toBe(1)
    const labels = (await ui.findAll({ type: 'Button' })).map(b => String((b as unknown as { props: { label?: string } }).props.label))
    expect(labels).not.toContain('Collapse')
    expect(labels).not.toContain('Expand')
    expect(await texts(ui)).toContain('map') // a fold stored from the terminal does not hide rows on desktop
  })

  t('desktop: idle role names stay readable and the Agents footer counts and pluralizes', async ($, on) => {
    world(on)
    await start($)
    const ui = await mountPane($, 'desktop', { columns: 86, rows: 70 })
    const names = (await ui.findAll({ type: 'Text' })).filter(n => String(n.text).trim() === 'code-reader')
      .map(n => (n as unknown as { props: { color: string } }).props.color)
    expect(names).toContain(ROLE_COLOR['code-reader']) // full role color, not mixed toward the panel
    const all = await texts(ui)
    expect(all).toContain('agents')
    expect(all).toContain('9') // the lead plus the eight rows of the Agents card
  })

  t('desktop: a long model name is shown whole in the agent rows', async ($, on) => {
    world(on)
    seed(on, { natives: [run({ id: 'f1', role: 'developer', status: 'done', model: 'claude-sonnet-long-name', endedAt: NOW - 1000 })] })
    await start($)
    expect(await texts(await mountPane($, 'desktop', { columns: 86, rows: 70 }))).toContain('claude-sonnet-long-name')
  })

  t('desktop session, groups and timeline share the pane inset and resize with columns', async ($, on) => {
    world(on)
    await start($)
    for (const columns of [70, 86, 120]) {
      const ui = await mountPane($, 'desktop', { columns, rows: 70 })
      const props = async (key: string) => {
        const node = await ui.find({ key })
        if (!node) throw new Error(`Missing desktop node: ${key} at ${columns} columns`)
        return (node as unknown as { props: Record<string, unknown> }).props
      }
      const width = columns - 6
      expect(await props('pantheon-desktop')).toMatchObject({ width: columns, paddingX: 3 })
      for (const key of ['header', 'session', 'idle-rows', 'footer']) expect((await props(key)).width).toBe(width)
      const timeline = (await ui.findAll({ type: 'Svg' })).map(n => (n as unknown as { props: { alt: string; source: string; width: number; isInteractive?: boolean } }).props).find(p => p.alt.startsWith('Last 15 minutes'))
      expect(timeline).toBeDefined()
      expect(timeline!.width).toBe(width * 8)
      expect(timeline!.isInteractive).toBeUndefined()
      expect(timeline!.source).toContain(`viewBox="0 0 ${width * 8} `)
      await release()
    }
  })

  for (const [columns, rows] of [[40, 70], [80, 3], [20, 100], [8, 100]] as const) {
    t(`desktop keeps metrics within the pane at ${columns} columns / ${rows} rows`, async ($, on) => {
      world(on)
      seed(on, { session: { isRunning: true, turnStartedAt: NOW - 5000, costUsd: 1.25, context: { tokens: 1234, window: 200000, percent: 1 } } })
      await start($)
      const ui = await mountPane($, 'desktop', { columns, rows })
      if (rows === 3) expect(await ui.find({ key: 'footer' })).toBeUndefined()

      type LayoutNode = { type?: string; key?: string; props?: { key?: string; width?: number }; children?: LayoutNode[] }
      let metricNodes = 0
      let metricImages = 0
      const checkWidth = (node: LayoutNode, containerWidth: number, inMetrics = false) => {
        const key = node.key ?? node.props?.key
        const inside = inMetrics || key === 'session'
        const width = typeof node.props?.width === 'number'
          ? node.props.width / (node.type === 'Svg' ? 8 : 1) : containerWidth
        if (inside) {
          expect({ key, fits: width <= containerWidth }).toEqual({ key, fits: true })
          if (String(key).startsWith('s-metric')) metricNodes++
          if (node.type === 'Svg') metricImages++
        }
        for (const child of node.children ?? []) if (child) checkWidth(child, width, inside)
      }
      checkWidth(await ui.drawn() as LayoutNode, columns)
      expect(metricNodes > 0).toBe(rows !== 3)
      if (rows !== 3) for (const label of ['cost', 'tokens', 'time']) expect(await texts(ui)).toContain(label)
      expect(metricImages >= 0).toBe(true)
    })
  }

  const SIX = ['code-reader', 'docs-reader', 'developer', 'councillor-alpha']
  const allActive = () => seed_all()
  function seed_all() {
    return {
      natives: [
        ...SIX.map((role, k) => run({ id: `j${k}`, role, lastTool: 'read x' })),
        native(), native({ id: 'n2', role: 'ux', type: 'pantheon:ux' }),
      ],
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
    seed(on, { natives: [native(), native({ id: 'n2', role: 'ux', type: 'pantheon:ux' }), run({ id: 'pjf', role: 'developer', task: 'x' })] })
    await start($)
    const all = await texts(await mountPane($, 'terminal'))
    const running = all.slice(all.indexOf('Agents · running'), all.indexOf('Agents · planned'))
    const at = ['developer', 'architect', 'ux'].map(name => running.indexOf(name))
    expect(at.every(i => i >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })

  const clients = async (ui: Mounted) =>
    (await ui.findAll({ type: 'Client' })).map(node => (node as unknown as { props: Record<string, any> }).props)
  const railsOf = async (ui: Mounted) => (await clients(ui)).filter(c => String(c.module).includes('rail'))

  t('docked: text dots for the rows and header, with the rails as the only animated Clients', async ($, on) => {
    world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['docs-reader'] }) } })
    seed(on, { natives: [native()], session: { isRunning: true, turnStartedAt: NOW - 5_000 } })
    await start($)
    await command($, 'config')
    const ui = await mountPane($, 'terminal', { rows: 70 })
    expect((await railsOf(ui)).map(c => c.props.color)).toEqual([SECTION_COLOR.running, SECTION_COLOR.idle, SECTION_COLOR.timeline, SECTION_COLOR.log])
    const all = await texts(ui)
    expect(all.filter(text => text === '●')).toHaveLength(9) // header, lead, architect and the six idle rows
    expect(all).toContain('⊘') // the disabled docs-reader is planned and off
  })

  t('mini: steady text dots; desktop: pulsing image dots, clocks stay Clients', async ($, on) => {
    world(on)
    seed(on, { natives: [native()], session: { isRunning: true, turnStartedAt: NOW - 5_000 } })
    await start($)
    const mini = await mountPane($, 'terminal', { placement: 'inline' })
    expect(await railsOf(mini)).toEqual([])
    expect((await texts(mini)).filter(text => text === '●')).toHaveLength(2) // header and architect
    expect((await clients(mini)).some(c => String(c.module).includes('elapsed'))).toBe(true)
    await release()
    const desk = await mountPane($, 'desktop')
    expect(await railsOf(desk)).toEqual([]) // desktop's rail is the SVG timeline
    const dots = (await desk.findAll({ type: 'Svg' })).map(n => (n as unknown as {
      props: { source: string; alt: string; isInteractive?: boolean; width: number; height: number }
    }).props).filter(s => s.alt === 'running')
    expect(dots.length).toBe(2) // the header and the running architect row; the session card repeats no badge
    expect(dots.map(d => d.source).every(src => src === dots[0].source)).toBe(true)
    for (const dot of dots) {
      expect(dot.isInteractive).toBeUndefined()
      expect(dot.source).toContain('<animate')
      expect(dot.source).not.toContain('background:')
      expect(dot.source).not.toContain('<rect')
      expect(dot.source).toContain('fill="#4fb383"')
      expect([dot.width, dot.height]).toEqual([10, 10])
    }
    expect((await clients(desk)).some(c => String(c.module).includes('elapsed'))).toBe(true)
  })

  t('an 8-column body produces nothing wider than 8', async ($, on) => {
    world(on)
    seed(on, {
      natives: [run({ id: 'pj3a', task: 'map the pane render tree', lastTool: 'rg something long' })],
      natives: [native()],
      session: { isRunning: true, turnStartedAt: NOW - 5_000, model: 'opus', context: { tokens: 100, window: 200, percent: 50 } },
    })
    await start($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, { columns: 8 })
      expect((await texts(ui)).filter(x => x.length > 8)).toEqual([])
      const labels = (await ui.findAll({ type: 'Button' })).map(b => String((b as unknown as { props: { label?: string } }).props.label))
      expect(labels.filter(x => x.length + 4 > 8)).toEqual([])
      await release()
    }
  })

  t('the clock warning shows in docked at 40 columns and in mini', async ($, on) => {
    let fail = false
    world(on, { clockDown: () => fail })
    seed(on, { natives: [run({ id: 'pj3a', task: 'map' })], session: { isRunning: true, turnStartedAt: NOW - 5_000 } })
    await start($)
    fail = true
    const docked = await mountPane($, 'terminal', { columns: 40 })
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
    expect(colors.includes(ROLE_COLOR.architect)).toBe(true) // the running architect
    expect(colors.includes('#4fb383')).toBe(true) // running
    const borders = (await ui.findAll({ type: 'Box' })).map(node => (node as unknown as { props: { borderColor?: string; backgroundColor?: string } }).props)
    expect(borders.flatMap(p => [p.borderColor, p.backgroundColor]).filter(c => c && !c.startsWith('#'))).toEqual([])
    expect(colors.some(c => !c.startsWith('#') && c !== 'undefined')).toBe(false)
  })

  // Rows a node takes: a Text or Button is one, a Client or Svg its declared height, a column adds its
  // children, a row takes the tallest, a border adds two.
  type Node = { type?: string; key?: string; props?: { key?: string; flexDirection?: string; gap?: number; rowGap?: number; borderStyle?: string; height?: number; width?: number; position?: string; marginTop?: number; flexWrap?: string }; children?: Node[] }
  // Desktop uses pixel SVGs and absolute backplates, which do not consume terminal border rows.
  const desktopRows = (n: Node): number => {
    if (n.props?.position === 'absolute') return 0
    if (n.type === 'Text' || n.type === 'Button' || n.type === 'Client') return n.props?.height ?? 1
    if (n.type === 'Svg') return (n.props?.height ?? 20) / 20
    const children = (n.children ?? []).filter(Boolean).filter(c => c.props?.position !== 'absolute')
    const sizes = children.map(desktopRows)
    let inner = n.props?.flexDirection === 'column'
      ? sizes.reduce((a, b) => a + b, 0) + Math.max(0, sizes.length - 1) * (n.props?.rowGap ?? n.props?.gap ?? 0)
      : Math.max(0, ...sizes)
    if (n.props?.flexWrap === 'wrap' && n.props.width) {
      let used = 0, height = 0, total = 0
      children.forEach((child, k) => {
        const width = child.props?.width ?? 0
        const gap = used ? n.props?.gap ?? 0 : 0
        if (used + gap + width > n.props!.width!) { total += height + (n.props?.rowGap ?? 0); used = 0; height = 0 }
        used += (used ? n.props?.gap ?? 0 : 0) + width
        height = Math.max(height, sizes[k])
      })
      inner = total + height
    }
    return (n.props?.height ?? inner + (n.props?.borderStyle ? 0.1 : 0)) + (n.props?.marginTop ?? 0) + (n.props?.marginBottom ?? 0)
  }
  const rowsOf = (n: Node): number => {
    if ((n.key ?? n.props?.key) === 'pantheon-desktop') return desktopRows(n)
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
    natives: [
      run({ id: 'pj1', role: 'code-reader', task: 'map', lastTool: 'rg x', ctx: 1000, out: 10 }),
      run({ id: 'pj2', role: 'councillor-alpha', task: 'weigh' }),
      run({ id: 'pj3', role: 'developer', status: 'done', task: 'tests', endedAt: NOW - 1000 }),
      native(), native({ id: 'n2', role: 'docs-reader', type: 'pantheon:docs-reader', rounds: [{ startedAt: 1, endedAt: 2, status: 'done' }] }),
    ],
    session: { isRunning: true, turnStartedAt: NOW - 5_000, model: 'opus', costUsd: 0.5 } as SessionInfo,
  })

  t('the Agents view never draws taller than the body, at small and normal heights', async ($, on) => {
    world(on)
    seed(on, busy())
    await start($)
    for (const surface of SURFACES) {
      for (const [columns, rows] of [[70, 3], [70, 5], [70, 6], [70, 7], [70, 9], [70, 12], [70, 16], [70, 24], [70, 40], [70, 70], [40, 10], [40, 20], [20, 12], [8, 12], [120, 30]] as const) {
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
    expect(all).toContain('Agents · idle')
    expect(all).not.toContain('tests')
    expect(all).toContain('3 running')
  })

  t('a role with several finished runs gets one Idle row for the latest, with its rounds in the strip', async ($, on) => {
    world(on)
    const done = [1, 3, 2].map(k => run({ id: `ux-${k}`, role: 'ux', status: 'done',
      task: `finished ux ${k}`, startedAt: NOW - 10_000, endedAt: NOW - 4000 + k * 1000 }))
    seed(on, { natives: done })
    await start($)
    for (const surface of SURFACES) {
      const tall = await mountPane($, surface, { rows: 80 })
      const all = await texts(tall)
      expect(all.filter(x => x.startsWith('finished ux '))).toEqual(['finished ux 3'])
      expect(await tall.find({ key: 'idle-ux' })).toBeDefined()
      if (surface === 'terminal') { // desktop has no fold button
        await tall.press({ key: 'toggle-idle' })
        expect((await texts(tall)).some(x => x.startsWith('finished ux '))).toBe(false)
        await tall.press({ key: 'toggle-idle' })
      }
      await release()
      const short = await mountPane($, surface, { rows: 12 })
      expect(await texts(short)).toContain('Agents · idle')
      expect((await texts(short)).some(x => x.startsWith('finished ux '))).toBe(false)
      expect(rowsOf((await short.drawn()) as Node) <= 12).toBe(true)
      await release()
    }
  })

  t('Idle sums a role up in one row: last four rounds green or red and +N for the rest, lost runs included', async ($, on) => {
    world(on)
    const run = (k: number, status: 'done' | 'failed' | 'lost') => native({
      id: `f${k}`, role: 'developer', type: 'pantheon:developer', task: `task ${k}`,
      rounds: [{ startedAt: NOW - 600_000 + k * 10_000, endedAt: status === 'lost' ? undefined : NOW - 590_000 + k * 10_000, status }],
    })
    seed(on, { natives: [run(1, 'done'), run(2, 'done'), run(3, 'failed'), run(4, 'done'), run(5, 'lost'), run(6, 'done')] })
    await start($)
    const ui = await mountPane($, 'terminal', { rows: 70 })
    expect(await ui.find({ key: 'idle-developer' })).toBeDefined()
    const all = await texts(ui)
    expect(all.filter(x => x.startsWith('task '))).toEqual(['task 6']) // the latest run only
    expect(all).toContain('+2')
    const bars = (await ui.findAll({ type: 'Text' })).filter(n => String(n.text) === '▰')
      .map(n => (n as unknown as { props: { color?: string } }).props.color)
    expect(bars).toEqual([BAD, OK, undefined, OK]) // failed, done, lost (dim), done
  })

  t('docked: rails join neighbouring cards in the next card color and move only with active work', async ($, on) => {
    world(on)
    const data = busy()
    seed(on, data)
    await start($)
    const ui = await mountPane($, 'terminal', { rows: 70, columns: 80 })
    const rails = await railsOf(ui)
    expect(rails.map(c => c.props.color)).toEqual([SECTION_COLOR.running, SECTION_COLOR.idle, SECTION_COLOR.timeline, SECTION_COLOR.log])
    for (const rail of rails) {
      expect([rail.width, rail.height]).toEqual([76, 1])
      expect(rail.props).toMatchObject({ active: true, width: 76, marks: [], isMerge: false })
    }
    await release()
    // Nothing runs: the rails rest.
    data.natives = []
    data.session = { isRunning: false }
    const idle = await mountPane($, 'terminal', { rows: 70, columns: 80 })
    expect((await railsOf(idle)).length).toBeGreaterThan(0)
    for (const rail of await railsOf(idle)) expect(rail.props.active).toBe(false)
  })

  t('docked without a Client draws a static rail', async ($, on) => {
    let fail = false
    world(on, { clockDown: () => fail })
    seed(on, busy())
    await start($)
    fail = true
    const ui = await mountPane($, 'terminal', { rows: 70, columns: 80 })
    expect(await clients(ui)).toEqual([])
    const all = await texts(ui)
    expect(all.some(x => x === '─'.repeat(76))).toBe(true)
    expect(all.some(x => /[▄▟▙█]{3}/.test(x))).toBe(false)
  })

  t('docked: every card line is exactly the body width in cells', async ($, on) => {
    world(on)
    seed(on, busy())
    await start($)
    type N = { type?: string; key?: string; props?: { key?: string; label?: string; width?: number }; children?: (N | string)[] }
    const kids = (n: N): N[] => (n.children ?? []).filter((c): c is N => typeof c === 'object' && c !== null)
    const textOf = (n: N) => (n.children ?? []).filter((c): c is string => typeof c === 'string').join('')
    const all = (n: N): N[] => [n, ...kids(n).flatMap(all)]
    const keyOf = (n: N) => String(n.key ?? n.props?.key)
    const cells = (n: N): number => n.type === 'Button' ? cellWidth(String(n.props?.label)) + 4
      : n.type === 'Text' ? cellWidth(textOf(n)) : kids(n).reduce((a, c) => a + cells(c), 0)
    for (const columns of [30, 40, 56, 86]) {
      const ui = await mountPane($, 'terminal', { rows: 80, columns })
      const nodes = all((await ui.drawn()) as N)
      const edges = nodes.filter(n => /-(top|bottom)$/.test(keyOf(n)))
      expect(edges.length).toBeGreaterThan(0)
      for (const n of edges) expect({ key: keyOf(n), cells: cells(n) }).toEqual({ key: keyOf(n), cells: columns })
      const rows = nodes.filter(n => /-r\d+$/.test(keyOf(n)))
      expect(rows.length).toBeGreaterThan(0)
      for (const n of rows) {
        const width = kids(n).reduce((a, c) => a + (c.type === 'Text' ? cellWidth(textOf(c)) : c.props?.width ?? 0), 0)
        expect({ key: keyOf(n), width }).toEqual({ key: keyOf(n), width: columns })
      }
      await release()
    }
  })

  t('docked: the strip shows one block per round in the role, done, failed and planned colors', async ($, on) => {
    world(on)
    seed(on, { natives: [
      run({ id: 'pf', role: 'developer', rounds: [
        { startedAt: NOW - 600_000, endedAt: NOW - 500_000, status: 'failed' },
        { startedAt: NOW - 60_000, status: 'running' },
      ] }),
      run({ id: 'pe1', role: 'code-reader', status: 'done', startedAt: NOW - 300_000, endedAt: NOW - 200_000 }),
    ] })
    await start($)
    const ui = await mountPane($, 'terminal', { rows: 70 })
    const blocks = (await ui.findAll({ type: 'Text' })).filter(n => String(n.text) === '▰')
      .map(n => (n as unknown as { props: { color?: string; dimColor?: boolean } }).props)
    const failed = blocks.findIndex(b => b.color === BAD)
    expect(failed).toBeGreaterThanOrEqual(0)
    expect(blocks[failed + 1].color).toBe(ROLE_COLOR.developer) // the running second round follows the failed one
    expect(blocks.some(b => b.color === OK)).toBe(false) // the code-reader ran once: no strip
  })

  t('a one-round row has no strip glyph; three rounds show three spaced marks of exact width', async ($, on) => {
    world(on)
    const round = (k: number, status: 'done' | 'failed') => ({ startedAt: NOW - 900_000 + k * 100_000, endedAt: NOW - 850_000 + k * 100_000, status })
    seed(on, { natives: [
      native({ id: 'one', role: 'code-reader', type: 'pantheon:code-reader', task: 'single', rounds: [round(1, 'done')] }),
      native({ id: 'three', role: 'developer', type: 'pantheon:developer', task: 'triple', rounds: [round(1, 'done'), round(2, 'failed'), { startedAt: NOW - 30_000, status: 'running' }] }),
    ] })
    await start($)
    const ui = await mountPane($, 'terminal', { rows: 70, columns: 100 })
    const nodes = (await ui.findAll({ type: 'Text' })).map(n => n as unknown as { text: string; props: { color?: string } })
    const marks = nodes.filter(n => String(n.text) === '▰')
    // Only the developer row: three marks (done, failed, running) with a single space between each; the lone round of the code-reader has none.
    expect(marks.map(n => n.props.color)).toEqual([OK, BAD, ROLE_COLOR.developer])
    const at = nodes.findIndex(n => n === marks[0])
    expect(nodes.slice(at, at + 5).map(n => String(n.text))).toEqual(['▰', ' ', '▰', ' ', '▰'])
    expect(nodes.slice(at, at + 5).reduce((n, x) => n + cellWidth(String(x.text)), 0)).toBe(5)
    // The strip column keeps its width, so the row stays aligned: the task starts in the same cell as without one.
    expect((await texts(ui))).toContain('single')
  })

  t('docked: the context gauge changes color past 70% and 85%', async ($, on) => {
    world(on)
    const data = { session: { isRunning: false, context: { tokens: 1, window: 100, percent: 60 } } as SessionInfo }
    seed(on, data)
    await start($)
    for (const [percent, color] of [[60, SECTION_COLOR.session], [75, SECTION_COLOR.planned], [90, BAD]] as const) {
      data.session = { isRunning: false, context: { tokens: 1, window: 100, percent } }
      const ui = await mountPane($, 'terminal', { rows: 70 })
      const filled = (await ui.findAll({ type: 'Text' })).find(n => String(n.text).startsWith('▰'))
      expect(filled).toBeDefined()
      expect((filled as unknown as { props: { color: string } }).props.color).toBe(color)
      expect(await texts(ui)).toContain(`${percent}%`)
      await release()
    }
  })

  t('model names are friendly in the session title and agent rows, with a free cell around the bar and the strip', async ($, on) => {
    world(on)
    seed(on, {
      natives: [native({ model: 'claude-haiku-4-5-20251001' })],
      session: { isRunning: false, model: 'claude-opus-5-5', effort: 'high', context: { tokens: 7, window: 100, percent: 7 } },
    })
    await start($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, { rows: 80 })
      const all = await texts(ui)
      expect(all).toContain('Opus 5.5')
      expect(all).toContain('Haiku 4.5')
      expect(all.some(x => x.includes('claude-'))).toBe(false)
      if (surface === 'desktop') {
        // The gauge sits in a Box at least one cell wider than its image.
        const box = (await ui.find({ key: 's-gauge-box' })) as unknown as { props: { width: number } }
        const image = (await ui.findAll({ type: 'Svg' })).map(n => (n as unknown as { props: { alt: string; width: number } }).props).find(p => p.alt === 'context 7%')!
        expect(box.props.width).toBeGreaterThanOrEqual(Math.ceil(image.width / 8) + 1)
      }
      await release()
    }
  })

  t('session tokens split into input and output and show only the side that exists', async ($, on) => {
    world(on)
    const data: { natives?: Native[]; session?: SessionInfo } = {
      natives: [run({ ctx: 41200, out: 2300 })],
      session: { isRunning: false, context: { tokens: 10_000, window: 200_000, percent: 5 } },
    }
    seed(on, data)
    await start($)
    for (const surface of SURFACES) {
      expect(await texts(await mountPane($, surface, { rows: 70 }))).toContain('51.2k↑ 2.3k↓')
      await release()
    }
    data.natives = [run({ ctx: 0, out: 900 })]
    data.session = { isRunning: false }
    expect(await texts(await mountPane($, 'terminal', { rows: 70 }))).toContain('900↓')
    await release()
    data.natives = []
    const none = await texts(await mountPane($, 'terminal', { rows: 70 }))
    expect(none.some(x => x.includes('↑') || x.includes('↓'))).toBe(false)
  })

  t('a running Claude agent shows ctx N% only when the session reports the window', async ($, on) => {
    world(on)
    const data = { natives: [native({ ctx: 20_000 })], session: { isRunning: true, turnStartedAt: NOW - 5000, context: { tokens: 1, window: 200_000, percent: 1 } } as SessionInfo }
    seed(on, data)
    await start($)
    for (const surface of SURFACES) {
      expect(await texts(await mountPane($, surface, { rows: 70 }))).toContain('ctx 10%')
      await release()
    }
    // Narrow rows give the column up first and keep the model.
    const narrow = await texts(await mountPane($, 'terminal', { rows: 70, columns: 40 }))
    expect(narrow).not.toContain('ctx 10%')
    await release()
    data.session = { isRunning: true, turnStartedAt: NOW - 5000 }
    expect((await texts(await mountPane($, 'terminal', { rows: 70 }))).some(x => /^ctx \d+%$/.test(x))).toBe(false)
  })

  t('rails keep a visible track at rest on both surfaces', async ($, on) => {
    world(on)
    seed(on, {})
    await start($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, { rows: 70 })
      const rails = await railsOf(ui)
      if (surface === 'desktop') { expect(rails).toEqual([]); await release(); continue }
      expect(rails.length).toBeGreaterThan(0)
      for (const rail of rails) expect(rail.props).toMatchObject({ active: false, dim: '#3b4354' })
      await release()
    }
  })

  t('desktop tints each card by section', async ($, on) => {
    world(on)
    seed(on, busy())
    await start($)
    const ui = await mountPane($, 'desktop', { rows: 80 })
    const svgs = (await ui.findAll({ type: 'Svg' })).map(n => (n as unknown as { props: { source: string; alt: string } }).props)
    const borders = new Map<string, string>()
    for (const key of ['session', 'running-rows', 'idle-rows']) {
      const p = (await ui.find({ key }) as unknown as { props: { borderColor?: string } }).props
      expect(String(p.borderColor)).toMatch(/^#/)
      borders.set(key, String(p.borderColor))
    }
    expect(new Set(borders.values()).size).toBe(3)
    const timeline = svgs.find(s => s.alt.startsWith('Last 15 minutes'))!
    expect(timeline.source).toContain(`stroke="${rgba(SECTION_COLOR.timeline, 0.75)}"`)
    expect(await railsOf(ui)).toEqual([])
  })

  t('docked draws the Last 15 minutes timeline as lanes of minute cells while there is room', async ($, on) => {
    const { clock } = world(on)
    const data: { natives?: Native[] } = {}
    seed(on, data)
    await start($)
    // The timeline reads the host clock, so the run starts relative to it.
    const clockNow = clock.now()
    data.natives = [run({ id: 'pt1', role: 'code-reader', status: 'running', startedAt: clockNow - 200_000 })]
    const tall = await texts(await mountPane($, 'terminal', { rows: 80, columns: 80 }))
    expect(tall).toContain('Last 15 minutes')
    expect(tall).toContain('-15m')
    expect(tall).toContain('now')
    expect(tall.some(x => /^━+$/.test(x))).toBe(true)
    await release()
    expect(await texts(await mountPane($, 'terminal', { rows: 24, columns: 80 }))).not.toContain('Last 15 minutes')
  })

  t('docked timeline gives a 6-second run one cell in its lane', async ($, on) => {
    const { clock } = world(on)
    const data: { natives?: Native[] } = {}
    seed(on, data)
    await start($)
    const clockNow = clock.now()
    data.natives = [run({ id: 'pq1', role: 'developer', status: 'done', startedAt: clockNow - 300_000, endedAt: clockNow - 294_000 })]
    const tall = await texts(await mountPane($, 'terminal', { rows: 80, columns: 80 }))
    const from = tall.indexOf('Last 15 minutes')
    expect(from).toBeGreaterThan(-1)
    expect(tall.slice(from).some(x => /^━+$/.test(x))).toBe(true)
  })

  const hhmmss = (at: number) => {
    const d = new Date(at)
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
  }
  const logSetup = (): Native[] => [
    native({ id: 'l1', role: 'architect', type: 'pantheon:architect', task: 'First', rounds: [{ startedAt: NOW - 300_000, endedAt: NOW - 240_000, status: 'done' }] }),
    native({ id: 'l2', role: 'developer', type: 'pantheon:developer', task: 'Second 漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字', rounds: [{ startedAt: NOW - 200_000, endedAt: NOW - 100_000, status: 'failed' }] }),
  ]
  const logRows = async (ui: Mounted) => (await ui.findAll({ type: 'Text' })).map(n => (n as unknown as { props: { children?: unknown; text?: string; color?: string } }).props)

  for (const surface of SURFACES) t(`session log card sits last at level 0, oldest first, with colored actors (${surface})`, async ($, on) => {
    world(on)
    seed(on, { natives: logSetup() })
    await start($)
    const ui = await mountPane($, surface, { rows: 90, columns: 100 })
    const all = await texts(ui)
    expect(all).toContain('Session log')
    expect(all.indexOf('Session log')).toBeGreaterThan(all.indexOf('Last 15 minutes'))
    const stamps = all.filter(x => /^\d\d:\d\d:\d\d$/.test(x))
    expect(stamps.length).toBeGreaterThan(0)
    expect(stamps.length).toBeLessThanOrEqual(8)
    expect(stamps).toContain(hhmmss(NOW - 240_000))
    const times = stamps.map(x => x)
    expect(times.indexOf(hhmmss(NOW - 300_000))).toBeLessThan(times.indexOf(hhmmss(NOW - 240_000)))
    const nodes = await ui.findAll({ type: 'Text' })
    const colorOf = (txt: string) => nodes.filter(n => String(n.text).trim() === txt).map(n => (n as unknown as { props: { color?: string } }).props.color)
    const executorColor = surface === 'desktop' ? ROLE_COLOR.developer : ROLE_COLOR.developer
    expect(colorOf('developer')).toContain(executorColor)
    expect(all.some(x => x.startsWith('failed after'))).toBe(true)
  })

  t('session log terminal lines are exactly the card width', async ($, on) => {
    world(on)
    seed(on, { natives: logSetup() })
    await start($)
    const ui = await mountPane($, 'terminal', { rows: 90, columns: 60 })
    const nodes = (await ui.findAll({ type: 'Text' })).map(n => String(n.text))
    expect(nodes[nodes.indexOf('Session log') - 1]).toBe('╭─ ')
    const bottoms = nodes.filter(x => x.startsWith('╰'))
    expect(bottoms.every(x => cellWidth(x) === 60)).toBe(true)
    // Each log row is a Box of IW cells: its three columns plus the border cells add up to 60.
    for (let k = 0; k < 8; k++) {
      const row = await ui.find({ key: `log-${k}` }).catch(() => undefined)
      if (row) expect((row as unknown as { props: { width: number } }).props.width).toBe(56)
    }
    expect(nodes.some(x => x.includes('…') && x.includes('漢'))).toBe(true)
    expect(nodes.every(x => cellWidth(x) <= 60)).toBe(true)
  })

  for (const surface of SURFACES) t(`session log card is the first to go: gone at level 1 while the timeline stays (${surface})`, async ($, on) => {
    world(on)
    seed(on, { natives: logSetup() })
    await start($)
    let tall = 0
    for (let rows = 90; rows >= 20; rows--) {
      await release()
      const ui = await mountPane($, surface, { rows, columns: 100 })
      const all = await texts(ui)
      const alts = (await ui.findAll({ type: 'Svg' })).map(n => (n as unknown as { props: { alt: string } }).props.alt)
      const timeline = all.includes('Last 15 minutes') || alts.some(x => x.startsWith('Last 15 minutes'))
      if (all.includes('Session log')) { tall = rows; continue }
      if (timeline) { expect(tall).toBeGreaterThan(0); return }
    }
    throw new Error('no row count dropped the log card while keeping the timeline')
  })

  t('the session card shows cost, tokens and time on one line on both surfaces', async ($, on) => {
    world(on)
    seed(on, busy())
    await start($)
    const desk = await mountPane($, 'desktop', { rows: 70 })
    expect(await desk.find({ key: 's-metrics' })).toBeDefined()
    for (const label of ['cost', 'tokens', 'time']) expect(await texts(desk)).toContain(label)
    expect(await texts(desk)).toContain('≈$0.50')
    await release()
    const term = await mountPane($, 'terminal', { rows: 70 })
    const all = await texts(term)
    for (const label of ['cost', 'tokens', 'time']) expect(all).toContain(label)
    expect(all).toContain('≈$0.50')
  })

  t('a group folds and unfolds with its button and the choice persists', async ($, on) => {
    world(on)
    seed(on, busy())
    await start($)
    const ui = await mountPane($, 'terminal', { rows: 70 })
    expect(await texts(ui)).toContain('map')
    await ui.press({ key: 'toggle-running' })
    const folded = await texts(ui)
    expect(folded).toContain('Agents · running')
    expect(folded).not.toContain('map')
    const labels = async (u: Mounted) => (await u.findAll({ type: 'Button' })).map(b => String((b as unknown as { props: { label?: string } }).props.label))
    expect(await labels(ui)).toContain('Expand')
    await release()
    expect(await texts(await mountPane($, 'terminal', { rows: 70 }))).not.toContain('map')
    await release()
    const again = await mountPane($, 'terminal', { rows: 70 })
    await again.press({ key: 'toggle-running' })
    expect(await texts(again)).toContain('map')
  })

  t('the close button closes the pane', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const ui = await mountPane($, 'terminal', { columns: 70 })
    await ui.press({ key: 'close' })
    expect(seen.closed).toContain(PANE_ID)
  })

  t('an idle line keeps the role name at 40 columns', async ($, on) => {
    world(on)
    seed(on, {
      natives: [run({ id: 'pj1234567', role: 'councillor-alpha', status: 'done', endedAt: NOW - 900_000 })],
      natives: [native({ id: 'zz', role: 'councillor-beta', type: 'pantheon:councillor-beta', rounds: [{ startedAt: 1, endedAt: 2, status: 'done' }] })],
    })
    await start($)
    const ui = await mountPane($, 'terminal', { columns: 40 })
    const all = await texts(ui)
    expect(all).toContain('council')
    expect(all.filter(x => x.length > 40)).toEqual([])
  })

  t('a short body degrades the Idle group to its heading', async ($, on) => {
    world(on)
    await start($)
    const tall = await texts(await mountPane($, 'terminal', { rows: 60, bodyRows: 60 }))
    expect(tall.filter(x => x === 'disabledAgents').length).toBe(0)
    expect(tall).toContain('code-reader')
    await release()
    const short = await texts(await mountPane($, 'terminal', { rows: 40, bodyRows: 14 }))
    expect(short).toContain('Agents · idle')
    expect(short).not.toContain('code-reader')
  })

  t('a failing clock read draws without clocks and says so', async ($, on) => {
    let fail = false
    world(on, { clockDown: () => fail })
    seed(on, { natives: [run({ id: 'pj3a', task: 'map' })], session: { isRunning: true, turnStartedAt: NOW - 5_000 } })
    await start($)
    const ok = await mountPane($, 'terminal')
    expect((await texts(ok)).some(x => x.includes('clock unavailable'))).toBe(false)
    await release()
    fail = true
    const ui = await mountPane($, 'terminal')
    const all = await texts(ui)
    expect(all.includes('clock unavailable')).toBe(true)
    expect(all).toContain('map')
    expect(await clients(ui)).toEqual([])
  })

  t('a failed view write shows one toast and does not throw', async ($, on) => {
    const { seen } = world(on)
    let deny = false
    on('state.set', async (_$, e, next) => (deny && e.key === 'view' ? { deny: 'view storage unavailable' } : next(e)))
    await start($)
    deny = true
    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'toggle-idle' })
    await ui.press({ key: 'toggle-idle' })
    await ui.press({ key: 'toggle-idle' })
    const toasts = seen.toasts.filter(x => x.includes('could not save the panel state'))
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toContain('view storage unavailable')
  })

  for (const surface of SURFACES) {
    t(`an active council shows its disabled seat as off (${surface})`, async ($, on) => {
      world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['councillor:alpha'] }) } })
      seed(on, { natives: [native({ id: 'cb1', role: 'councillor-beta', type: 'pantheon:councillor-beta', task: 'weigh in' })] })
      await start($)
      await command($, 'config')
      const all = await texts(await mountPane($, surface))
      expect(all).toContain('council β')
      expect(all).toContain('weigh in')
      expect(all).toContain('council α') // the disabled seat is an Idle row of its own
      expect(all).toContain('Disabled')
      expect(all).toContain('⊘')
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
    expect(all).toContain('n1') // the active architect stays visible
  })

  t('a lost earlier round shows no invented duration', async ($, on) => {
    world(on)
    seed(on, { natives: [
      run({ id: 'pl', role: 'developer', rounds: [
        { startedAt: NOW - 600_000, status: 'lost' },
        { startedAt: NOW - 60_000, status: 'running' },
      ] }),
    ] })
    await start($)
    const ui = await mountPane($, 'terminal')
    // Two blocks: the lost round has no state color and no duration of its own; the running one is the role's.
    const blocks = (await ui.findAll({ type: 'Text' })).filter(n => String(n.text) === '▰')
      .map(n => (n as unknown as { props: { color?: string; dimColor?: boolean } }).props)
    const running = blocks.findIndex(b => b.color === ROLE_COLOR.developer)
    expect(running).toBeGreaterThan(0)
    expect(blocks[running - 1]).toMatchObject({ dimColor: true })
    expect(blocks[running - 1].color).toBeUndefined()
    expect((await texts(ui)).filter(x => /^\d+:\d\d$/.test(x))).toHaveLength(0) // the running clock is a Client
  })

  t('docked at 40 columns truncates', async ($, on) => {
    world(on)
    seed(on, {
      natives: [run({
        id: 'pj3a', task: 'a very long task description that cannot fit in forty columns',
        lastTool: 'apply_patch plugins/pantheon/hooks/pane.tsx and more',
      })],
      session: { isRunning: true, turnStartedAt: NOW - 5_000, model: 'claude-opus-5-5-with-a-long-name', effort: 'high' },
    })
    await start($)
    const ui = await mountPane($, 'terminal', { columns: 40 })
    expect((await texts(ui)).filter(x => x.length > 40)).toEqual([])
    await release()
  })

  t('/pantheon config shows origins and current error', async ($, on) => {
    const { files } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['qa'] }) } })
    await start($)
    const ok = await command($, 'config')
    expect(ok.text).toContain('Valid config')
    expect(ok.text).toContain('disabledAgents: user')
    files[`${HOME}/.claude/pantheon.json`] = '{ broken'
    const bad = await command($, 'config')
    expect(bad.text).toContain('Invalid config')
  })

  t('/pantheon doctor reports the config and the pending pings', async ($, on) => {
    world(on)
    await start($)
    const out = await command($, 'doctor')
    expect(out.text).toContain('ok   config')
    expect(out.text).not.toMatch(/codex|authorized root/i)
    expect(out.text.split('\nping')[0]).not.toContain('fail')
  })

  t('/pantheon cancel is no longer a subcommand', async ($, on) => {
    world(on)
    await start($)
    expect((await command($, 'cancel')).text).toContain('Unknown subcommand: cancel')
  })
})


describe('timelineSource', () => {
  const NOW_T = 10_000_000
  const slot = (over: Partial<Slot> & { name: Slot['name'] }): Slot => ({ state: 'idle', instances: [], ...over })
  const inst = (over: object) => ({
    id: 'i', task: '', status: 'running', isActive: true, startedAt: NOW_T - 60_000,
    rounds: [{ startedAt: NOW_T - 60_000, status: 'running' }], tokens: { out: 0 }, ...over,
  })
  const slots: Slot[] = [
    slot({ name: 'lead', state: 'active' }),
    slot({ name: 'code-reader', state: 'active', instances: [inst({ id: 'a' }), inst({ id: 'b', startedAt: NOW_T - 30_000, rounds: [{ startedAt: NOW_T - 30_000, status: 'running' }] })] }),
    slot({ name: 'docs-reader' }),
    slot({ name: 'developer', state: 'active', instances: [inst({ id: 'f', rounds: [
      { startedAt: NOW_T - 800_000, endedAt: NOW_T - 600_000, status: 'done' },
      { startedAt: NOW_T - 60_000, status: 'running' },
    ] })] }),
    slot({ name: 'architect', state: 'active', instances: [inst({ id: 'o' })] }),
    slot({ name: 'ux', lastEndedAt: NOW_T - 2_000_000 }),
    slot({ name: 'council', state: 'off', offReason: 'disabledAgents' }),
  ]
  const out = timelineSource(slots, { isRunning: true, turnStartedAt: NOW_T - 120_000 }, NOW_T).source

  test('timeline source and running bars stay identical within a 15-second bucket', () => {
    const bucket = Math.floor(NOW_T / 15_000) * 15_000
    const session = { isRunning: true, turnStartedAt: NOW_T - 120_000 }
    const first = timelineSource(slots, session, bucket)
    expect(timelineSource(slots, session, bucket + 14_999)).toEqual(first)
    expect(timelineSource(slots, session, bucket + 15_000).source).not.toBe(first.source)
  })

  test('each desktop draw computes the timeline once and keeps timeline and card keys and sources stable', () => {
    const session: SessionInfo = { isRunning: true, turnStartedAt: NOW_T - 120_000 }
    const roster = buildRoster({ natives: [run()], session, config: DEFAULTS })
    let timelineReads = 0
    // Only the timeline reads the retained turns; count evaluations without replacing its renderer.
    Object.defineProperty(session, 'turns', { get() { timelineReads++; return [] } })
    const element = (props: unknown) => ({ props })
    const el = { Box: element, Text: element, Button: element, Svg: element }
    type Node = { key?: string; props?: { key?: string; alt?: string; source?: string; children?: unknown } }
    const images = (tree: unknown): Node[] => {
      if (Array.isArray(tree)) return tree.flatMap(images)
      if (!tree || typeof tree !== 'object') return []
      const node = tree as Node
      return [...(node.props?.source ? [node] : []), ...images(node.props?.children)]
    }
    const bucket = Math.floor(NOW_T / 15_000) * 15_000
    const draw = (now: number) => images(drawPanel(el as never, {
      surface: 'desktop', columns: 120, rows: 100, now, roster, session, hasClient: false,
    }))
    const first = draw(bucket + 100)
    expect(timelineReads).toBe(1)
    const second = draw(bucket + 200)
    expect(timelineReads).toBe(2)
    const keyed = (nodes: Node[]) => nodes.map(n => ({ key: n.key ?? n.props?.key, source: n.props?.source }))
    expect(keyed(second)).toEqual(keyed(first))
    for (const node of first) expect(node.key ?? node.props?.key).toBeDefined()
    const timeline = first.find(n => n.props?.alt?.startsWith('Last 15 minutes'))!
    expect(timeline.key ?? timeline.props?.key).toBe('timeline')
  })

  test('running bars are solid, finished ones outlined, all in the one agent color', () => {
    expect(out).toContain('fill="#b58af0"/>')
    expect(out).not.toContain('#6aa3f0')
    expect(out).toContain('fill="#35274f" stroke="#b58af0"')
    expect(out).toContain('rx="12" fill="rgba(165,107,216,0.06)" stroke="rgba(165,107,216,0.75)"')
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
    const natives = [
      run({ id: 'ja', status: 'done', startedAt: NOW_T - 600_000, endedAt: NOW_T - 500_000 }),
      run({ id: 'jb', status: 'done', startedAt: NOW_T - 300_000, endedAt: NOW_T - 200_000 }),
      run({ id: 'jold', status: 'done', startedAt: NOW_T - 3_000_000, endedAt: NOW_T - 2_000_000 }),
    ]
    const roster = buildRoster({ natives, session: { isRunning: false }, config: DEFAULTS })
    // Cards retain every run; the timeline draws only those overlapping the window.
    expect(roster.slots[1].instances.map(i => i.id)).toEqual(['jb', 'ja', 'jold'])
    const svg = timelineSource(roster.slots, { isRunning: false }, NOW_T).source
    expect(svg.split('fill="#35274f" stroke="#b58af0"').length - 1).toBe(2)
    expect(svg).toContain('>ja</text>')
    expect(svg).toContain('>jb</text>')
    expect(svg).not.toContain('>jold</text>')
  })
  test('lead draws finished turns in the window and the running turn separately', () => {
    const session: SessionInfo = { isRunning: true, turnStartedAt: NOW_T - 60_000, turns: [
      { startedAt: NOW_T - 1_000_000, endedAt: NOW_T - 950_000 },
      { startedAt: NOW_T - 1_000_000, endedAt: NOW_T - 800_000 },
      { startedAt: NOW_T - 600_000, endedAt: NOW_T - 500_000 },
      { startedAt: NOW_T - 300_000, endedAt: NOW_T - 200_000 },
    ] }
    const lane = [slot({ name: 'lead' })]
    const svg = timelineSource(lane, session, NOW_T).source
    expect(svg.split('fill="#4a4945"/>').length - 1).toBe(3)
    expect(svg).toContain('<rect x="136" y="48"')
    expect(svg).toContain('height="12" rx="3" fill="#ebedf1"/>')
    const idle = timelineSource(lane, { ...session, isRunning: false }, NOW_T).source
    expect(idle.split('fill="#4a4945"/>').length - 1).toBe(3)
    expect(idle).not.toContain('height="12" rx="3" fill="#ebedf1"/>')
  })
  test('a run shorter than one 15-second step still draws one step width in its lane', () => {
    const quick: Slot[] = [slot({ name: 'developer', instances: [inst({ id: 'q', isActive: false, status: 'done',
      rounds: [{ startedAt: NOW_T - 300_000, endedAt: NOW_T - 294_000, status: 'done' }] })] })]
    const svg = timelineSource(quick, { isRunning: false }, NOW_T).source
    const step = (664 - 136) / 60
    const m = /<rect x="([\d.]+)" y="48" width="([\d.]+)" height="12" rx="3" fill="#[0-9a-f]+" stroke="#b58af0"\/>/.exec(svg)
    expect(m).not.toBeNull()
    expect(Math.abs(Number(m![2]) - step)).toBeLessThan(1e-6)
    const t0 = Math.floor(NOW_T / 15_000) * 15_000 - 900_000
    expect(Math.abs(Number(m![1]) - (136 + ((NOW_T - 300_000 - t0) / 900_000) * 528))).toBeLessThan(1e-6)
  })
  test('a minimum-width bar never extends past now', () => {
    const late: Slot[] = [slot({ name: 'developer', instances: [inst({ id: 'n', isActive: false, status: 'done',
      rounds: [{ startedAt: NOW_T - 3_000, endedAt: NOW_T - 1_000, status: 'done' }] })] })]
    const svg = timelineSource(late, { isRunning: false }, NOW_T).source
    const m = /<rect x="([\d.]+)" y="48" width="([\d.]+)" height="12" rx="3" fill="#[0-9a-f]+" stroke="#b58af0"\/>/.exec(svg)
    expect(m).not.toBeNull()
    expect(Number(m![1]) + Number(m![2])).toBeLessThanOrEqual(664 + 1e-6)
  })
  test('a lost round with no end is a tick at its start, not a bar to now', () => {
    const lost: Slot[] = [slot({ name: 'developer', instances: [inst({ id: 'l', isActive: false, status: 'lost',
      rounds: [{ startedAt: NOW_T - 600_000, status: 'lost' }] })] })]
    const svg = timelineSource(lost, { isRunning: false }, NOW_T).source
    expect(svg).toContain('width="3" height="12" fill="#e0a94a"/>')
    expect(svg).not.toContain('stroke="#b58af0"/>')
    expect(svg).not.toContain('height="12" rx="3" fill="#b58af0"/>')
  })
  test('parallel instances label their ids and the now line closes the window', () => {
    expect(out).toContain('>a</text>')
    expect(out).toContain('>b</text>')
    expect(out).toContain('>now</text>')
  })
})
