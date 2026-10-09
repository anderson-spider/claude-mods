import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DELEGATE, HOME, ROOT, RESULT, parse, start, world } from './fixtures/world'
import { PANE_ID, configReport, doctorReport, drawPanel, statusText, timelineSource } from '../hooks/pane'
import { loadConfig } from '../hooks/config'
import { buildRoster } from '../hooks/roster'
import { BAD, OK, ROLE_COLOR, SECTION_COLOR, cellWidth } from '../hooks/theme'
import type { Slot } from '../hooks/roster'
import { MIXED } from './fixtures/profiles'
import type { Job, Native, SessionInfo } from '../hooks/types'

const SURFACES = ['terminal', 'desktop'] as const
const rgba = (hex: string, a: number) => `rgba(${[1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16)).join(',')},${a})`
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

test('doctor report adds a ping section only when pings are given', async () => {
  const config = await loadConfig(async () => '{"profile":"mixed"}', { user: 'fixture' })
  const facts = { usesCodex: true, profile: 'mixed', loginOk: true, config, root: '/repo', isRepo: true }
  expect(doctorReport(facts)).not.toContain('ping')
  const report = doctorReport({
    ...facts,
    pings: [
      { name: 'explorer', engine: 'codex', model: 'gpt-6-luna', state: 'ok', ms: 1200 },
      { name: 'oracle', engine: 'codex', model: 'gpt-6-luna', state: 'fail', detail: 'timeout' },
      { name: 'fixer', engine: 'claude', model: 'sonnet', state: 'pending' },
      { name: 'designer', engine: 'claude', state: 'off' },
    ],
  }).split('\n')
  expect(report).toContain('ping')
  expect(report).toContain('ok   explorer (codex gpt-6-luna) 1.2s')
  expect(report).toContain('fail oracle (codex gpt-6-luna): timeout')
  expect(report).toContain('pending fixer (claude sonnet) — the session confirms')
  expect(report).toContain('info designer off')
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
  for (const surface of SURFACES) t(`header shows working when only the main session runs (${surface})`, async ($, on) => {
    world(on)
    seed(on, { session: { isRunning: true, turnStartedAt: NOW - 5000 } })
    await start($)
    const ui = await mountPane($, surface, { rows: 70 })
    const working = (await ui.findAll({ type: 'Text' })).filter(n => String(n.text).trim() === 'working')
    expect(working).toHaveLength(2)
    for (const node of working) expect((node as unknown as { props: { color: string } }).props.color)
      .toBe(surface === 'desktop' ? '#4fb383' : 'success')
    expect(await texts(ui)).not.toContain('idle')
  })

  for (const surface of SURFACES) t(`tabs separate counts and the footer identifies keys (${surface})`, async ($, on) => {
    world(on)
    seed(on, { jobs: [job()], natives: [native()] })
    await start($)
    const ui = await mountPane($, surface, { rows: 70 })
    const tab = (await ui.find({ key: 'tab-jobs' })) as unknown as { props: { label: string; hotkey: string } }
    if (surface === 'desktop') {
      expect(tab.props.label).toBe('Jobs')
      expect(tab.props.hotkey).toBe('2')
      expect(await texts(ui)).toContain('2')
      expect(await texts(ui)).toContain('keys:')
      const shortcut = (await ui.find({ key: 'key-jobs' })) as unknown as { props: { hotkey: string } }
      expect(shortcut.props.hotkey).toBeUndefined()
      await ui.press({ key: 'tab-jobs' })
      expect(await texts(ui)).toContain('↻ resumable · Copy = id + resume hint')
      return
    }
    expect(tab.props.label).toBe('Jobs · 2')
    expect(tab.props.hotkey).toBe('2')
    expect(await texts(ui)).toContain('keys: 1 agents · 2 jobs · esc close')
    await ui.press({ key: 'tab-jobs' })
    expect(await texts(ui)).toContain('keys: 1 agents · 2 jobs · ↻ resumable · Copy = id + resume hint')
  })

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
      const at = ['Session', 'Agents · running', 'Agents · finished', 'Agents · planned'].map(x => all.indexOf(x))
      expect(at.every(i => i >= 0)).toBe(true)
      expect(at).toEqual([...at].sort((a, b) => a - b))
      // fixer and oracle run, explorer finished; librarian, designer and council have not run yet.
      for (const name of ['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'council']) expect(all).toContain(name)
      expect(await ui.find({ key: 'tab-agents' })).toBeDefined()
      expect(await ui.find({ key: 'tab-jobs' })).toBeDefined()
      if (surface === 'desktop') {
        expect(all).toContain('2')
        expect(all).toContain('running')
      } else expect(all).toContain('2 running')
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
      expect(all.some(x => x.includes('map pane render tree'))).toBe(true)
      expect(all.some(x => x.includes("rg 'x' plugins/"))).toBe(true)
      expect(all).toContain('43.5k') // input + output of the job, in the session tokens
      if (surface === 'desktop') {
        expect(all).toContain('1')
        expect(all).toContain('running')
      } else expect(all).toContain('1 running')
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
      // The strip holds one block per round: the cancelled first round and the running second one.
      if (surface === 'desktop') {
        const strips = (await ui.findAll({ type: 'Svg' })).map(n => (n as unknown as { props: { alt: string; source: string } }).props).filter(p => p.alt === 'jobs')
        expect(strips.filter(p => p.source.split('<rect').length - 1 === 2)).toHaveLength(1)
      } else {
        // Two blocks for the fixer, one for each of the five planned roles.
        expect((await texts(ui)).filter(x => x === '▮')).toHaveLength(7)
      }
      await $.tool.call({ tool: 'mcp__pantheon__delegate_cancel', jobId: second.jobId } as never)
    })

    t(`off role shows disabledAgents (${surface})`, async ($, on) => {
      world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['librarian'] }) } })
      await start($)
      await command($, 'config')
      const ui = await mountPane($, surface, { rows: 70 })
      const all = await texts(ui)
      expect(all.some(x => x.includes('disabledAgents'))).toBe(true)
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

  t('desktop draws section cards on SVG backplates with native rows and fixed numeric slots', async ($, on) => {
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
    expect(await props('profile-row')).toMatchObject({ width: 80 })
    expect(await props('session')).toMatchObject({ width: 80, paddingX: 2, position: 'relative', flexDirection: 'column' })
    expect(await props('planned-rows')).toMatchObject({ width: 80, flexDirection: 'column', position: 'relative' })
    expect((await props('planned-rows')).borderStyle).toBeUndefined()
    expect(await props('jobs-count')).toMatchObject({ width: 3, flexShrink: 0, justifyContent: 'flex-end' })
    const svgs = (await ui.findAll({ type: 'Svg' })).map(n => (n as unknown as { props: { alt: string; source: string; width: number; height: number; isInteractive?: boolean } }).props)
    expect(svgs.some(p => p.source.includes('rx="6" fill="rgba(196,80,127,0.11)"'))).toBe(true) // the Agents tab pill
    expect(svgs.some(p => p.alt === 'card background' && p.source.includes(`stroke="${rgba(SECTION_COLOR.session, 0.75)}"`))).toBe(true)
    expect(svgs.some(p => p.alt === 'card background' && p.source.includes(`stroke="${rgba(SECTION_COLOR.planned, 0.75)}"`))).toBe(true)
    expect((await props('pill-toggle-planned')).width).toBe(10.5)
    expect((await props('tab-agents')).hotkey).toBe('1')
    expect((await props('tab-jobs')).hotkey).toBe('2')
    expect((await props('key-agents')).hotkey).toBeUndefined()
    expect(await ui.find({ key: 'plan-explorer' })).toBeDefined()
    expect(await texts(ui)).toContain('Waiting for work')
    expect((await texts(ui)).some(t => t.includes('▎') || t.includes('━'))).toBe(false)
    const dividers = svgs.filter(p => p.alt === 'divider')
    expect(dividers.length).toBeGreaterThan(0)
    for (const p of dividers) expect(p).toMatchObject({ width: 640, height: 1 })
    expect(svgs.filter(p => p.alt === 'idle').every(p => !p.isInteractive)).toBe(true)
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
      for (const key of ['header', 'session', 'planned-rows', 'footer']) expect((await props(key)).width).toBe(width)
      const timeline = (await ui.findAll({ type: 'Svg' })).map(n => (n as unknown as { props: { alt: string; source: string; width: number; isInteractive?: boolean } }).props).find(p => p.alt.startsWith('Last 15 minutes'))
      expect(timeline).toBeDefined()
      expect(timeline!.width).toBe(width * 8)
      expect(timeline!.isInteractive).toBeUndefined()
      expect(timeline!.source).toContain(`viewBox="0 0 ${width * 8} `)
      await release()
    }
  })

  for (const [columns, rows] of [[40, 70], [80, 3], [20, 100], [8, 100]] as const) {
    t(`desktop keeps tab hotkeys and metrics within the pane at ${columns} columns / ${rows} rows`, async ($, on) => {
      world(on)
      seed(on, { session: { isRunning: true, turnStartedAt: NOW - 5000, costUsd: 1.25, context: { tokens: 1234, window: 200000, percent: 1 } } })
      const switched: string[] = []
      on('state.set', async (_$, event, next) => {
        if (event.key === 'view') switched.push((event.value as { tab: string }).tab)
        return next(event)
      })
      await start($)
      const ui = await mountPane($, 'desktop', { columns, rows })
      const tabProps = async (tab: string) => {
        const node = await ui.find({ key: `tab-${tab}` })
        expect(node).toBeDefined()
        return (node as unknown as { props: { hotkey: string } }).props
      }
      expect((await tabProps('jobs')).hotkey).toBe('2')
      if (columns >= 30) expect((await tabProps('agents')).hotkey).toBe('1')
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

      await ui.press({ key: 'tab-jobs' })
      expect(switched[switched.length - 1]).toBe('jobs')
      expect((await tabProps('agents')).hotkey).toBe('1')
      if (columns >= 30) expect((await tabProps('jobs')).hotkey).toBe('2')
      await ui.press({ key: 'tab-agents' })
      expect(switched.slice(-2)).toEqual(['jobs', 'agents'])
      expect((await tabProps('jobs')).hotkey).toBe('2')
    })
  }

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
    const running = all.slice(all.indexOf('Agents · running'), all.indexOf('Agents · planned'))
    const at = ['fixer', 'oracle', 'designer'].map(name => running.indexOf(name))
    expect(at.every(i => i >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })

  const clients = async (ui: Mounted) =>
    (await ui.findAll({ type: 'Client' })).map(node => (node as unknown as { props: Record<string, any> }).props)
  const railsOf = async (ui: Mounted) => (await clients(ui)).filter(c => String(c.module).includes('rail'))

  t('docked: text dots for the rows and header, with the rails as the only animated Clients', async ($, on) => {
    world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['librarian'] }) } })
    seed(on, { natives: [native()], session: { isRunning: true, turnStartedAt: NOW - 5_000 } })
    await start($)
    await command($, 'config')
    const ui = await mountPane($, 'terminal', { rows: 70 })
    expect((await railsOf(ui)).map(c => c.props.color)).toEqual([SECTION_COLOR.running, SECTION_COLOR.planned, SECTION_COLOR.timeline])
    const all = await texts(ui)
    expect(all.filter(text => text === '●')).toHaveLength(7) // header, orchestrator, oracle and the four waiting roles
    expect(all).toContain('⊘') // the disabled librarian is planned and off
  })

  t('mini: steady text dots; desktop: steady image dots, clocks stay Clients', async ($, on) => {
    world(on)
    seed(on, { natives: [native()], session: { isRunning: true, turnStartedAt: NOW - 5_000 } })
    await start($)
    const mini = await mountPane($, 'terminal', { placement: 'inline' })
    expect(await railsOf(mini)).toEqual([])
    expect((await texts(mini)).filter(text => text === '●')).toHaveLength(2) // header and oracle
    expect((await clients(mini)).some(c => String(c.module).includes('elapsed'))).toBe(true)
    await release()
    const desk = await mountPane($, 'desktop')
    expect((await railsOf(desk)).length).toBeGreaterThan(0)
    const dots = (await desk.findAll({ type: 'Svg' })).map(n => (n as unknown as {
      props: { source: string; alt: string; isInteractive?: boolean; width: number; height: number }
    }).props).filter(s => s.alt === 'running')
    expect(dots.length).toBe(2) // header and session pill
    for (const dot of dots) {
      expect(dot.isInteractive).toBeUndefined()
      expect(dot.source).not.toContain('<animate')
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
    expect(colors.includes(ROLE_COLOR.oracle)).toBe(true) // the running oracle
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
    return (n.props?.height ?? inner + (n.props?.borderStyle ? 0.1 : 0)) + (n.props?.marginTop ?? 0)
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
    expect(all).toContain('Agents · finished')
    expect(all).not.toContain('tests')
    expect(all).toContain('3 running')
  })

  t('all finished designer instances appear when space allows and fold within the row budget', async ($, on) => {
    world(on)
    const done = [1, 3, 2].map(k => job({ id: `designer-${k}`, agent: 'designer', status: 'done',
      description: `finished designer ${k}`, startedAt: NOW - 10_000, endedAt: NOW - 4000 + k * 1000 }))
    seed(on, { jobs: done })
    await start($)
    for (const surface of SURFACES) {
      const tall = await mountPane($, surface, { rows: 80 })
      const all = await texts(tall)
      expect(all.filter(x => x.startsWith('finished designer '))).toEqual([
        'finished designer 3', 'finished designer 2', 'finished designer 1',
      ])
      expect(await tall.find({ key: 'plan-designer' })).toBeUndefined()
      await tall.press({ key: 'toggle-finished' })
      expect((await texts(tall)).some(x => x.startsWith('finished designer '))).toBe(false)
      await tall.press({ key: 'toggle-finished' })
      await release()
      const short = await mountPane($, surface, { rows: 12 })
      expect(await texts(short)).toContain('Agents · finished')
      expect((await texts(short)).some(x => x.startsWith('finished designer '))).toBe(false)
      expect(rowsOf((await short.drawn()) as Node) <= 12).toBe(true)
      await release()
    }
  })

  t('docked: rails join neighbouring cards in the next card color and move only with active work', async ($, on) => {
    world(on)
    const data = busy()
    seed(on, data)
    await start($)
    const ui = await mountPane($, 'terminal', { rows: 70, columns: 80 })
    const rails = await railsOf(ui)
    expect(rails.map(c => c.props.color)).toEqual([SECTION_COLOR.running, SECTION_COLOR.finished, SECTION_COLOR.planned, SECTION_COLOR.timeline])
    for (const rail of rails) {
      expect([rail.width, rail.height]).toEqual([76, 1])
      expect(rail.props).toMatchObject({ active: true, width: 76, marks: [], isMerge: false })
    }
    expect((await clients(ui)).filter(c => String(c.module).includes('mascot'))).toEqual([])
    await release()
    // Nothing runs: the rails rest.
    data.jobs = []
    data.natives = []
    data.session = { isRunning: false }
    const idle = await mountPane($, 'terminal', { rows: 70, columns: 80 })
    expect((await railsOf(idle)).length).toBeGreaterThan(0)
    for (const rail of await railsOf(idle)) expect(rail.props.active).toBe(false)
  })

  t('docked without a Client draws a static rail and no mascot', async ($, on) => {
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
    seed(on, { jobs: [
      job({ id: 'pf1', agent: 'fixer', status: 'error', startedAt: NOW - 600_000, endedAt: NOW - 500_000, sessionId: 's' }),
      job({ id: 'pf2', agent: 'fixer', status: 'running', startedAt: NOW - 60_000, sessionId: 's' }),
      job({ id: 'pe1', agent: 'explorer', status: 'done', startedAt: NOW - 300_000, endedAt: NOW - 200_000 }),
    ] })
    await start($)
    const ui = await mountPane($, 'terminal', { rows: 70 })
    const blocks = (await ui.findAll({ type: 'Text' })).filter(n => String(n.text) === '▮')
      .map(n => (n as unknown as { props: { color?: string; dimColor?: boolean } }).props)
    const failed = blocks.findIndex(b => b.color === BAD)
    expect(failed).toBeGreaterThanOrEqual(0)
    expect(blocks[failed + 1].color).toBe(ROLE_COLOR.fixer) // the running second round follows the failed one
    expect(blocks.some(b => b.color === OK)).toBe(true) // the finished explorer
    expect(blocks.some(b => b.color === undefined && b.dimColor)).toBe(true) // a planned role
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

  t('desktop draws no mascot sprite and tints each card by section', async ($, on) => {
    world(on)
    seed(on, busy())
    await start($)
    const ui = await mountPane($, 'desktop', { rows: 80 })
    const svgs = (await ui.findAll({ type: 'Svg' })).map(n => (n as unknown as { props: { source: string; alt: string } }).props)
    expect(svgs.filter(s => s.alt.includes('mascot'))).toEqual([])
    const plates = svgs.filter(s => s.alt === 'card background').map(s => s.source)
    for (const color of [SECTION_COLOR.session, SECTION_COLOR.running, SECTION_COLOR.finished, SECTION_COLOR.planned]) {
      expect(plates.some(source => source.includes(`stroke="${rgba(color, 0.75)}"`))).toBe(true)
    }
    const timeline = svgs.find(s => s.alt.startsWith('Last 15 minutes'))!
    expect(timeline.source).toContain(`stroke="${rgba(SECTION_COLOR.timeline, 0.75)}"`)
    expect((await clients(ui)).filter(c => String(c.module).includes('mascot'))).toEqual([])
    expect((await railsOf(ui)).map(c => c.props.color)).toEqual([SECTION_COLOR.running, SECTION_COLOR.finished, SECTION_COLOR.planned, SECTION_COLOR.timeline])
  })

  t('docked draws the Last 15 minutes timeline as lanes of minute cells while there is room', async ($, on) => {
    const { clock } = world(on)
    const data: { jobs?: Job[] } = {}
    seed(on, data)
    await start($)
    // The timeline reads the host clock, so the run starts relative to it.
    const clockNow = clock.now()
    data.jobs = [job({ id: 'pt1', agent: 'explorer', status: 'running', startedAt: clockNow - 200_000 })]
    const tall = await texts(await mountPane($, 'terminal', { rows: 80, columns: 80 }))
    expect(tall).toContain('Last 15 minutes')
    expect(tall).toContain('-15m')
    expect(tall).toContain('now')
    expect(tall.some(x => /^━+$/.test(x))).toBe(true)
    await release()
    expect(await texts(await mountPane($, 'terminal', { rows: 24, columns: 80 }))).not.toContain('Last 15 minutes')
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
      for (const rows of (surface === 'desktop' ? [3, 6, 10, 14, 20, 40] : [6, 10, 14, 20, 40])) {
        const ui = await mountPane($, surface, { rows })
        if (await ui.find({ key: 'tab-jobs' })) await ui.press({ key: 'tab-jobs' })
        expect({ surface, rows, fits: rowsOf((await ui.drawn()) as Node) <= rows }).toEqual({ surface, rows, fits: true })
        expect(await ui.find({ key: 'profile-row' })).toBeDefined()
        if (surface === 'desktop' && rows <= 6) expect(await ui.find({ key: 'footer' })).toBeUndefined()
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
    expect(short).toContain('Agents · planned')
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
    expect(all).toContain('map')
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
      expect(all).toContain('council β')
      expect(all).toContain('weigh in')
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
    const ui = await mountPane($, 'terminal')
    // Two blocks: the lost round has no state color and no duration of its own; the running one is the role's.
    const blocks = (await ui.findAll({ type: 'Text' })).filter(n => String(n.text) === '▮')
      .map(n => (n as unknown as { props: { color?: string; dimColor?: boolean } }).props)
    const running = blocks.findIndex(b => b.color === ROLE_COLOR.fixer)
    expect(running).toBeGreaterThan(0)
    expect(blocks[running - 1]).toMatchObject({ dimColor: true })
    expect(blocks[running - 1].color).toBeUndefined()
    expect((await texts(ui)).filter(x => /^\d+:\d\d$/.test(x))).toHaveLength(0) // the running clock is a Client
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
    // The ping section is covered in register.test.ts.
    expect(out.text.split('\nping')[0]).not.toContain('fail')
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

  test('timeline source and running bars stay identical within a 15-second bucket', () => {
    const bucket = Math.floor(NOW_T / 15_000) * 15_000
    const session = { isRunning: true, turnStartedAt: NOW_T - 120_000 }
    const first = timelineSource(slots, session, bucket)
    expect(timelineSource(slots, session, bucket + 14_999)).toEqual(first)
    expect(timelineSource(slots, session, bucket + 15_000).source).not.toBe(first.source)
  })

  test('each desktop draw computes the timeline once and keeps timeline and card keys and sources stable', () => {
    const session: SessionInfo = { isRunning: true, turnStartedAt: NOW_T - 120_000 }
    const roster = buildRoster({ jobs: [job()], natives: [], session, config: MIXED })
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
      surface: 'desktop', columns: 120, rows: 100, now, roster, jobs: [], session,
      profiles: ['claude', 'codex', 'mixed'], activeProfile: 'mixed',
      tab: 'agents', hasClient: false, onTab: () => {}, onCancel: () => {}, onCopy: () => {},
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
    expect(first.filter(n => n.props?.alt?.includes('mascot'))).toEqual([])
    const plates = first.filter(n => n.props?.alt === 'card background')
    expect(plates.length > 0).toBe(true)
    for (const node of plates) expect(node.key ?? node.props?.key).toBeDefined()
  })

  test('running bars are solid in the engine color, finished ones outlined', () => {
    expect(out).toContain('fill="#6aa3f0"/>')
    expect(out).toContain('fill="#b58af0"/>')
    expect(out).toContain('fill="#1f3350" stroke="#6aa3f0"')
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
    const jobs: Job[] = [
      { id: 'ja', agent: 'explorer', status: 'done', startedAt: NOW_T - 600_000, endedAt: NOW_T - 500_000, cwd: '/repo' },
      { id: 'jb', agent: 'explorer', status: 'done', startedAt: NOW_T - 300_000, endedAt: NOW_T - 200_000, cwd: '/repo' },
      { id: 'jold', agent: 'explorer', status: 'done', startedAt: NOW_T - 3_000_000, endedAt: NOW_T - 2_000_000, cwd: '/repo' },
    ]
    const roster = buildRoster({ jobs, natives: [], session: { isRunning: false }, config: MIXED })
    // Cards retain every run; the timeline draws only those overlapping the window.
    expect(roster.slots[1].instances.map(i => i.id)).toEqual(['jb', 'ja', 'jold'])
    const svg = timelineSource(roster.slots, { isRunning: false }, NOW_T).source
    expect(svg.split('fill="#1f3350" stroke="#6aa3f0"').length - 1).toBe(2)
    expect(svg).toContain('>ja</text>')
    expect(svg).toContain('>jb</text>')
    expect(svg).not.toContain('>jold</text>')
  })
  test('orchestrator draws finished turns in the window and the running turn separately', () => {
    const session: SessionInfo = { isRunning: true, turnStartedAt: NOW_T - 60_000, turns: [
      { startedAt: NOW_T - 1_000_000, endedAt: NOW_T - 950_000 },
      { startedAt: NOW_T - 1_000_000, endedAt: NOW_T - 800_000 },
      { startedAt: NOW_T - 600_000, endedAt: NOW_T - 500_000 },
      { startedAt: NOW_T - 300_000, endedAt: NOW_T - 200_000 },
    ] }
    const lane = [slot({ name: 'orchestrator', engine: 'claude' })]
    const svg = timelineSource(lane, session, NOW_T).source
    expect(svg.split('fill="#4a4945"/>').length - 1).toBe(3)
    expect(svg).toContain('<rect x="118" y="48"')
    expect(svg).toContain('height="12" rx="3" fill="#ebedf1"/>')
    const idle = timelineSource(lane, { ...session, isRunning: false }, NOW_T).source
    expect(idle.split('fill="#4a4945"/>').length - 1).toBe(3)
    expect(idle).not.toContain('height="12" rx="3" fill="#ebedf1"/>')
  })
  test('a lost round with no end is a tick at its start, not a bar to now', () => {
    const lost: Slot[] = [slot({ name: 'fixer', instances: [inst({ id: 'l', isActive: false, status: 'lost',
      rounds: [{ startedAt: NOW_T - 600_000, status: 'lost' }] })] })]
    const svg = timelineSource(lost, { isRunning: false }, NOW_T).source
    expect(svg).toContain('width="3" height="12" fill="#e0a94a"/>')
    expect(svg).not.toContain('stroke="#6aa3f0"/>')
    expect(svg).not.toContain('height="12" rx="3" fill="#6aa3f0"/>')
  })
  test('parallel instances label their ids and the now line closes the window', () => {
    expect(out).toContain('>a</text>')
    expect(out).toContain('>b</text>')
    expect(out).toContain('>now</text>')
  })
})
