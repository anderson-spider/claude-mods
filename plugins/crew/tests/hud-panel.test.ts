import { expect, test } from 'claude-code/testing'
import type { PluginState } from 'claude-code'
import Clock from '../hooks/hud/clock'
import { openingOf, serverConsults, toolLine, WRITE_TOOLS } from '../hooks/hud/events'
import { elapsedCell, railRuns, RAIL_STEP_MS } from '../hooks/hud/live'
import {
  DOCKED_REPLY,
  INLINE_REPLY,
  PANEL_USAGE,
  REMOVED_LAYOUT,
  choiceAfterClose,
  choiceOf,
  hudOptions,
  parsePanelArgs,
  sideReply,
  storedChoice,
} from '../hooks/hud/panel'
import Rail from '../hooks/hud/rail'
import type { HudAtoms } from '../hooks/hud/types'

// ------------------------------------------------------------------ /crew:panel's grammar

test('parsePanelArgs reads the toggles, the layouts and the plan pin; case and spacing are free', () => {
  expect(parsePanelArgs('')).toEqual({ kind: 'toggle' })
  expect(parsePanelArgs(undefined)).toEqual({ kind: 'toggle' })
  for (const verb of ['on', 'off', 'side', 'prompt', 'reset'] as const) {
    expect(parsePanelArgs(verb)).toEqual({ kind: verb })
    expect(parsePanelArgs(`  ${verb.toUpperCase()}  `)).toEqual({ kind: verb })
  }
  expect(parsePanelArgs('layout auto')).toEqual({ kind: 'layout', layout: 'auto' })
  expect(parsePanelArgs('LAYOUT   Mini')).toEqual({ kind: 'layout', layout: 'mini' })
  expect(parsePanelArgs('plan auto')).toEqual({ kind: 'plan-auto' })
  expect(parsePanelArgs('plan Proxy-Rewrite')).toEqual({ kind: 'plan', name: 'Proxy-Rewrite' })
  expect(parsePanelArgs('plan crew-harness.md')).toEqual({ kind: 'plan', name: 'crew-harness' })
})

test('parsePanelArgs: the removed layouts have their own answer; anything else is usage', () => {
  expect(parsePanelArgs('layout compact')).toEqual({ kind: 'removed-layout' })
  expect(parsePanelArgs('layout wide')).toEqual({ kind: 'removed-layout' })
  for (const bad of ['bogus', 'on now', 'layout', 'layout diagonal', 'layout mini extra', 'plan', 'plan ../secrets', 'plan a/b', 'plan .hidden', 'plan two words', 'side x']) {
    expect(parsePanelArgs(bad)).toEqual({ kind: 'usage' })
  }
  expect(PANEL_USAGE).toBe('Usage: /crew:panel [on|off|side|prompt|reset|layout auto|mini|plan <name>|plan auto]')
  expect(REMOVED_LAYOUT).toBe(`Layouts compact and wide were removed; auto picks the form. ${PANEL_USAGE}`)
})

test('the stored pick is read leniently: only { v: 1, isVisible, placement } counts', () => {
  expect(storedChoice({ v: 1, isVisible: true, placement: 'prompt' })).toEqual({ isVisible: true, placement: 'prompt' })
  for (const junk of [undefined, null, 'prompt', 3, [], { v: 2, isVisible: true, placement: 'side' }, { v: 1, isVisible: 'yes', placement: 'side' }, { v: 1, isVisible: true, placement: 'floating' }]) {
    expect(storedChoice(junk)).toBeNull()
  }
  expect(choiceOf({ isVisible: false, placement: 'side' })).toEqual({ isVisible: false, placement: 'side' })
  expect(choiceOf(null)).toBeNull()
})

test('a person\'s close hides the panel for good; the plugin\'s own close and an unload say nothing', () => {
  expect(choiceAfterClose({ kind: 'person' })).toEqual({ isVisible: false, placement: 'side' })
  expect(choiceAfterClose({ kind: 'plugin' })).toBeNull()
  expect(choiceAfterClose({ kind: 'unload' })).toBeNull()
})

test('the options: placement, openOnStart and motion with their defaults; a removed option or a bad value changes nothing', () => {
  expect(hudOptions(undefined)).toEqual({ placement: 'side', openOnStart: true, motion: true })
  expect(hudOptions({ placement: 'prompt', openOnStart: false, motion: 'off' })).toEqual({ placement: 'prompt', openOnStart: false, motion: false })
  expect(hudOptions({ placement: 'floating', openOnStart: 'no', motion: 'sometimes', layout: 'wide', palette: 'pastel', statusLine: true })).toEqual({
    placement: 'side',
    openOnStart: true,
    motion: true,
  })
})

test('the side reply says docked or inline by the room the command has, or why the pane is not shown', () => {
  expect(sideReply({ isPlaced: true }, { isFullscreen: true, columns: 110 })).toBe(DOCKED_REPLY)
  expect(sideReply({ isPlaced: true }, { isFullscreen: true, columns: 109 })).toBe(INLINE_REPLY)
  expect(sideReply({ isPlaced: true }, { isFullscreen: false, columns: 200 })).toBe(INLINE_REPLY)
  expect(sideReply({ isPlaced: true }, undefined)).toBe(INLINE_REPLY)
  expect(sideReply({ isPlaced: false, reason: 'widen the terminal' }, undefined)).toBe('Panel set to the side, not shown yet: widen the terminal')
  expect(sideReply({ isPlaced: false }, undefined)).toBe('Panel set to the side, not shown yet: no reason given')
})

// ------------------------------------------------------------------ events read into the reducers

test('toolLine names the tool and what it was about, on one line', () => {
  expect(toolLine('Edit', { file_path: '/repo/proxy/internal/config/contract_on.go' })).toBe('Edit internal/config/contract_on.go')
  expect(toolLine('Bash', { command: 'go vet ./...' })).toBe('Bash go vet ./...')
  expect(toolLine('Grep', { pattern: 'base_url', path: 'proxy/internal' })).toBe('Grep proxy/internal')
  expect(toolLine('WebFetch', { url: 'https://example.com/a' })).toBe('WebFetch https://example.com/a')
  expect(toolLine('Agent', { description: 'T2 review' })).toBe('Agent T2 review')
  expect(toolLine('TodoWrite', {})).toBe('TodoWrite')
  expect(toolLine('Read', null)).toBe('Read')
  expect([...WRITE_TOOLS].sort()).toEqual(['Edit', 'MultiEdit', 'NotebookEdit', 'Write'])
})

test('openingOf tells your prompt from an agent\'s hand-back and from another engine notice', () => {
  expect(openingOf('split the proxy rewrite')).toEqual({ kind: 'prompt' })
  expect(openingOf('<agent-message from="ar1">\nThe report follows:\nApprove: clean')).toEqual({ kind: 'handback', from: 'ar1' })
  expect(openingOf('<task-notification>done</task-notification>')).toEqual({ kind: 'engine' })
  expect(openingOf(undefined)).toEqual({ kind: 'prompt' })
})

test('serverConsults reads the advisor tool\'s use and its result from an assistant row', () => {
  const content = [
    { type: 'text', text: 'asking' },
    { type: 'server_tool_use', id: 'sv1', name: 'advisor', input: {} },
    { type: 'server_tool_use', id: 'sv2', name: 'web_search', input: {} },
    { type: 'advisor_tool_result', tool_use_id: 'sv1', content: [{ type: 'text', text: 'Fixes: add a test' }] },
    { type: 'advisor_tool_result', tool_use_id: 'sv3', content: 'Approve: fine' },
    null,
  ]
  expect(serverConsults(content, 'advisor')).toEqual([
    { kind: 'open', id: 'sv1' },
    { kind: 'close', id: 'sv1', answer: 'Fixes: add a test' },
    { kind: 'close', id: 'sv3', answer: 'Approve: fine' },
  ])
  expect(serverConsults('text', 'advisor')).toEqual([])
})

// ------------------------------------------------------------------ the client modules (they import ./live at load)

type Drawn = { type: string; props: Record<string, unknown>; children: unknown[] }

function fakeSurface() {
  const timers: { ms: number; fn: () => void }[] = []
  const surface = {
    elements: {
      Text: (p: Record<string, unknown> & { children?: unknown }) => ({ type: 'Text', props: p, children: [p.children].flat() }),
      Box: (p: Record<string, unknown> & { children?: unknown }) => ({ type: 'Box', props: p, children: [p.children].flat() }),
    },
    state: undefined as unknown,
    setState(next: unknown) {
      surface.state = next
    },
    columns: 0,
    rows: 0,
    every(ms: number, fn: () => void) {
      timers.push({ ms, fn })
      return () => {}
    },
  }
  // Typed as whatever surface the module asks for: the fake holds the module's own state, whatever its type.
  return { surface: surface as never, timers }
}

const textOf = (n: unknown): string =>
  typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as Drawn).children ?? []).map(textOf).join('') : ''

test('the clock module draws elapsedCell and ticks once a second while it runs; a stopped clock stays', () => {
  const props = { since: 0, now: 42_000, endAt: null, width: 6, align: 'right' as const }
  const { surface, timers } = fakeSurface()
  expect(textOf(Clock(props, surface))).toBe(elapsedCell(props))
  expect(timers.map(t => t.ms)).toEqual([1000])
  timers[0]?.fn()
  expect(textOf(Clock(props, surface))).toBe(elapsedCell(props, 1))
  expect(textOf(Clock(props, surface))).toBe('  0:43')
  // A fresh drawing restarts the count from its own time.
  expect(textOf(Clock({ ...props, now: 60_000 }, surface))).toBe(elapsedCell({ ...props, now: 60_000 }))
  const stopped = fakeSurface()
  const ended = { ...props, endAt: 30_000 }
  Clock(ended, stopped.surface)
  stopped.timers[0]?.fn()
  expect(textOf(Clock(ended, stopped.surface))).toBe(elapsedCell(ended))
})

test('the rail module draws railRuns: packets move one cell per RAIL_STEP_MS while active, a still line otherwise', () => {
  const props = { active: true, width: 30, color: 'success', faint: 'subtle' }
  const { surface, timers } = fakeSurface()
  expect(textOf(Rail(props, surface))).toBe(railRuns(30, 0).map(r => r.text).join(''))
  expect(timers.map(t => t.ms)).toEqual([RAIL_STEP_MS])
  timers[0]?.fn()
  expect(textOf(Rail(props, surface))).toBe(railRuns(30, 1).map(r => r.text).join(''))
  expect(textOf(Rail({ ...props, active: false }, surface))).toBe('─'.repeat(30))
})

// ------------------------------------------------------------------ the types contract

type Crew = PluginState['crew']
type Contract = { session: Crew['hudSession']; agents: Crew['hudAgents']; consults: Crew['hudConsults']; log: Crew['hudLog']; loops: Crew['hudLoops']; favored: Crew['hudFavored']; plan: Crew['hudPlan']; view: Crew['hudView'] }

test('the HUD atoms in the plugin\'s types contract are the modules\' types, both ways (a compile-time check)', () => {
  const fromContract = (c: Contract): HudAtoms => c
  const toContract = (h: HudAtoms): Contract => h
  expect(typeof fromContract).toBe('function')
  expect(typeof toContract).toBe('function')
})
