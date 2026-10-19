import { expect, test } from 'claude-code/testing'
import type { Card, PaneModel } from '../hooks/pane'
import { CELL, ROW, svgOf } from '../hooks/svg'
import { p } from '../hooks/text'

const PLAN: Card = { key: 'plan', tone: 'suggestion', title: 'Plan', count: '1/4', aside: [{ text: '▰', style: 'bar', tone: 'success' }, p('▱', 'barEmpty')], lines: [[p('T1 <a&b>', 'title')]] }
const RUNNING: Card = { key: 'running', tone: 'success', title: 'Running', aside: [], lines: [[{ text: '▮', style: 'bar', tone: 'suggestion' }, p('▯', 'barEmpty'), p(' worker')]] }
const model = (over: Partial<PaneModel> = {}): PaneModel => ({ header: [], cards: [PLAN, RUNNING], footer: [], motion: false, frame: 0, ...over })

test("the cards are one SVG on the terminal's grid: a stroked plate per card with no fill, its title in the top edge, its text escaped and held to its cells", () => {
  const drawing = svgOf(model(), 40)
  expect(drawing.width).toBe(Math.ceil(40 * CELL))
  expect(drawing.height).toBe((3 + 1 + 3) * ROW)
  expect(drawing.source).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 288 126"/)
  expect(drawing.source.match(/<path [^>]*fill="none"[^>]*class="s-suggestion"/g)?.length).toBe(1)
  expect(drawing.source).toContain('class="f-suggestion b"')
  expect(drawing.source).toContain('> Plan <')
  expect(drawing.source).toContain('>T1 &lt;a&amp;b&gt;<')
  expect(drawing.source).toContain(`textLength="${8 * CELL}"`)
  expect(drawing.source).toContain('@media (prefers-color-scheme: light)')
  expect(drawing.source.length).toBeLessThan(131_072)
})

test('gauges and attempt blocks are shapes in their tone; an empty block is only a stroke', () => {
  const source = svgOf(model(), 40).source
  expect(source).toMatch(/<rect [^>]*class="f-success"\/>/)
  expect(source).toMatch(/<rect [^>]*class="f-subtle"\/>/)
  expect(source).toMatch(/<rect [^>]*fill="none"[^>]*class="s-subtle"\/>/)
  expect(source).not.toContain('>▮<')
})

test('the rail into the running card moves only with motion, and only then is the drawing interactive', () => {
  expect(svgOf(model(), 40).moving).toBe(false)
  expect(svgOf(model(), 40).source).not.toContain('<animate')
  const moving = svgOf(model({ motion: true }), 40)
  expect(moving.moving).toBe(true)
  expect(moving.source).toContain('<animate attributeName="cx"')
  expect(svgOf(model({ motion: true, cards: [RUNNING, PLAN] }), 40).moving).toBe(false)
})

test('a lane of timeline cells is one shape, and control characters never reach the markup', () => {
  const lane: Card = { key: 'timeline', tone: 'merged', title: 'Last 15 minutes', aside: [], lines: [[{ text: '━'.repeat(200), style: 'bar', tone: 'claude' }, p('·'.repeat(200), 'barEmpty')], [p('bad\u0007\nnote')]] }
  const source = svgOf(model({ cards: [lane] }), 420).source
  expect(source.match(/<rect /g)?.length).toBe(2)
  expect(source).toContain('>bad  note<')
})
