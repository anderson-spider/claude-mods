import { test, expect } from 'claude-code/testing'
import {
  borderOf,
  cardWidth,
  fillOf,
  formatReset,
  formatTokens,
  isLightTheme,
  items,
  paceOf,
  paceSegment,
  segments,
  styleOf,
  svgLine,
  svgWidth,
  textOf,
} from '../hooks/usage'

const now = Date.parse('2026-10-06T12:00:00Z')
const at = (seconds: number) => new Date(now + seconds * 1000).toISOString()

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

const usage = {
  context: { tokens: 57_400, window: 1_000_000, percent: 6 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 62, resetsAt: at(110 * 60 + 5) },
    { kind: 'seven_day', percentUsed: 85, resetsAt: at(6 * 86400 + 14 * 3600 + 5) },
  ],
}

test('formatTokens is compact', () => {
  expect(formatTokens(850)).toBe('850')
  expect(formatTokens(57_400)).toBe('57k')
  expect(formatTokens(1_000_000)).toBe('1M')
  expect(formatTokens(1_200_000)).toBe('1.2M')
})

test('formatReset picks the two largest units', () => {
  expect(formatReset(now + (6 * 86400 + 14 * 3600 + 5) * 1000, now)).toBe('6d 14h')
  expect(formatReset(now + (1 * 3600 + 50 * 60 + 5) * 1000, now)).toBe('1h 50m')
  expect(formatReset(now + 40 * 60 * 1000, now)).toBe('40m')
  expect(formatReset(now - 1000, now)).toBe('0m')
})

test('the pace compares usage with the elapsed share', () => {
  // 5h window, 1h50m left: 63% elapsed
  const reset = now + 110 * 60 * 1000
  expect(paceOf(14, reset, 18000, now)).toBe(-49)
  expect(paceOf(80, reset, 18000, now)).toBe(17)
  expect(paceOf(10, now - 1000, 18000, now)).toBeUndefined()
  expect(paceOf(10, now + 17990 * 1000, 18000, now)).toBeUndefined()
})

test('the pace reads in points and ignores a small drift', () => {
  expect(paceSegment(-49)).toEqual({ text: '▼49', tone: 'ahead' })
  expect(paceSegment(17)).toEqual({ text: '▲17', tone: 'behind' })
  expect(paceSegment(5)).toEqual({ text: '●', tone: 'muted' })
  expect(paceSegment(-5)).toEqual({ text: '●', tone: 'muted' })
  expect(paceSegment(0)).toEqual({ text: '●', tone: 'muted' })
  expect(paceSegment(6)).toEqual({ text: '▲6', tone: 'behind' })
})

test('each card puts label, percent and pace left and the detail right', () => {
  const shown = items(usage, now)
  expect(shown.map(item => [textOf(item.left), textOf(item.right)])).toEqual([
    ['ctx 6%', '57k / 1M'],
    ['5h 62% ●', '1h 50m'],
    ['7d 85% ▲79', '6d 14h'],
  ])
  expect(shown.map(item => item.level)).toEqual(['plain', 'warn', 'bad'])
})

test('the one-line fallback joins the cards', () => {
  expect(textOf(segments(usage, now))).toBe('ctx 6% · 57k / 1M  │  5h 62% ● · 1h 50m  │  7d 85% ▲79 · 6d 14h')
})

test('nothing with no reading', () => {
  expect(segments({ context: { window: 200_000 }, rateLimits: [] }, now)).toEqual([])
  expect(textOf(segments({ context: { window: 200_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 3 }] }, now))).toBe(
    '7d 3%',
  )
})

test('only the percent is bold, and the colors take the diff\'s green and red', () => {
  expect(styleOf('plain', false)).toEqual({ bold: true })
  expect(styleOf('warn', false)).toEqual({ color: '#F5B047', bold: true })
  expect(styleOf('bad', false)).toEqual({ color: '#FF2B56', bold: true })
  expect(styleOf('ahead', false)).toEqual({ color: '#2FD84C' })
  expect(styleOf('behind', true)).toEqual({ color: '#CF222E' })
  expect(styleOf('label', false)).toEqual({ color: '#8F8D86' })
  expect(styleOf('muted', true)).toEqual({ color: '#87867F' })
  expect(isLightTheme('light-daltonized')).toBe(true)
  expect(isLightTheme('dark')).toBe(false)
  expect(isLightTheme(undefined)).toBe(false)
})

test('a card at rest has a fill and no visible border; past 50% the border shows', () => {
  expect(fillOf(false)).toBe('#2B2A28')
  expect(borderOf('plain', false)).toBe(fillOf(false))
  expect(borderOf('warn', false)).toBe('#F5B047')
  expect(borderOf('bad', true)).toBe('#CF222E')
})

test('cards split the band evenly and give way to the line when they do not fit', () => {
  const shown = items(usage, now)
  expect(cardWidth(shown, 120, 10)).toBe(39)
  // the widest card, 7d, needs 10 + 2 + 6 + 4 = 22 columns
  expect(cardWidth(shown, 68, 10)).toBe(22)
  expect(cardWidth(shown, 65, 10)).toBeUndefined()
  expect(cardWidth(shown, 120, 2)).toBeUndefined()
})

test('the band draws three filled cards on terminal and desktop', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, ...usage } }))
  on('clock.now', () => ({ value: now }))
  // The engine draws nothing of its own in the band.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-line', surface, component: 'AbovePrompt', props: BAND_PROPS })
    if (surface === 'desktop') {
      // a left and a right side per card
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(6)
    } else {
      expect(await ui.find({ type: 'Text', text: '▲79' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '6d 14h' })).toBeDefined()
    }
    for (const key of ['ctx', '5h', '7d']) {
      const card = await ui.find({ type: 'Box', key })
      expect(card?.props).toMatchObject({ backgroundColor: '#2B2A28', justifyContent: 'space-between' })
    }
    await ui.unmount()
  }
})

test('a narrow band falls back to one line', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, ...usage } }))
  on('clock.now', () => ({ value: now }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))

  const ui = await $.ui.mount({
    plugin: 'usage-line',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND_PROPS, bodyColumns: 60 },
  })
  expect(await ui.find({ type: 'Text', text: '▲79' })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: '5h' })).toBeUndefined()
  await ui.unmount()
})

test('another plugin\'s band wins', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, ...usage } }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['held'] }))

  const ui = await $.ui.mount({ plugin: 'usage-line', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: 'held' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '85%' })).toBeUndefined()
  await ui.unmount()
})

test('a light theme takes the light shades', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, ...usage } }))
  on('clock.now', () => ({ value: now }))
  on('config.list', () => ({ value: [{ key: 'theme', value: 'light' }] }) as never)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))

  const ui = await $.ui.mount({ plugin: 'usage-line', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const colors = (await ui.findAll({ type: 'Text', text: '85%' })).map(t => (t.props as { color?: string }).color)
  expect(colors).toContain('#CF222E')
  expect((await ui.find({ type: 'Box', key: 'ctx' }))?.props).toMatchObject({ backgroundColor: '#F0EEE6' })
  await ui.unmount()
})

test('the desktop sides are monospace SVGs with the same colors', () => {
  const [, five] = items(usage, now)
  const svg = svgLine(five?.left ?? [], false)
  // 8 characters, the ● wider: never under the monospace advance
  expect(svgWidth('5h 62% ●')).toBe(Math.ceil(7 * 8.4 + 14) + 4)
  expect(svg.source).toContain('viewBox="0 0 77 18"')
  expect(svg.source).toContain("font-family=\"'SF Mono', SFMono-Regular, Menlo, Consolas, monospace\"")
  expect(svg.source).toContain('<tspan fill="#F5B047" font-weight="600">62%</tspan>')
  expect(svg.source).toContain('<tspan fill="#8F8D86">5h</tspan>')
  expect(svgLine([{ text: 'a<b & c', tone: 'muted' }], true).source).toContain('>a&lt;b &amp; c<')
})
