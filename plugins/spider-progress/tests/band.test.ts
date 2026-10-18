import { expect, test } from 'claude-code/testing'
import type { SpiderRun, SpiderTask } from '../types'
import { bandLines } from '../hooks/band'
import type { Piece } from '../hooks/text'

const task = (id: string, state: SpiderTask['state']): SpiderTask => ({ id, title: id, owner: 'main', after: [], state, attempts: 1, errors: [], agentIds: [] })
const RUN: SpiderRun = { runId: 'r', title: 'Implement authentication', phase: 'review', startedAt: 0, tasks: [task('T1', 'completed'), task('T2', 'completed'), task('T3', 'running'), task('T4', 'pending')] }
const text = (line: Piece[] | undefined) => (line ?? []).map(p => p.text).join('')
const draw = (over: Partial<Parameters<typeof bandLines>[0]> = {}) => bandLines({ run: RUN, running: 3, agents: 3, columns: 60, lang: 'en', frame: 0, animations: false, ...over })

test('the band shows title, bar with percent and phase · accepted/total · agents', () => {
  const lines = draw()
  expect(lines.length).toBe(3)
  expect(text(lines[0])).toBe('SPIDER TEAM · Implement authentication')
  expect(text(lines[1])).toMatch(/^━+░+ 50%$/)
  expect([...text(lines[1])].length).toBe(60)
  expect(text(lines[2])).toBe('Review · 2/4 tasks · 3 agents')
})

test('before a plan has a total the bar is indeterminate and shows no percent', () => {
  const line = text(draw({ run: { ...RUN, phase: 'plan', tasks: [] } })[1])
  expect(line).not.toMatch(/%/)
  expect(line).toContain('░')
  expect(text(draw({ run: { ...RUN, phase: 'plan', tasks: [] } })[2])).toBe('Plan · 0/0 tasks · 3 agents')
})

test('a narrow band cuts the title and keeps the counts', () => {
  const lines = draw({ columns: 40, run: { ...RUN, title: 'x'.repeat(120) } })
  expect([...text(lines[0])].length).toBe(40)
  expect(text(lines[0]).endsWith('…')).toBe(true)
  expect(text(lines[2])).toContain('2/4 tasks')
  expect([...text(lines[1])].length).toBe(40)
})

test('the band uses pt-BR strings when asked', () => {
  const lines = draw({ lang: 'pt-BR', running: 1 })
  expect(text(lines[2])).toBe('Revisão · 2/4 tarefas · 1 agente')
})

test('a running agent shows a spinner only with animations on, and a finished or failed run is coloured', () => {
  expect(text(draw({ animations: true, frame: 1 })[2]).startsWith('⠙ ')).toBe(true)
  expect(text(draw({ animations: true, running: 0 })[2]).startsWith('Review')).toBe(true)
  expect(draw({ run: { ...RUN, phase: 'complete' } })[2]![0]!.style).toBe('ok')
  expect(draw({ run: { ...RUN, phase: 'failed' } })[2]![0]!.style).toBe('error')
})

test('the status line leaves room for the buttons and cuts the phase before the counts', () => {
  const tasks = Array.from({ length: 12 }, (_, i) => task(`T${i + 1}`, 'pending'))
  for (const [lang, phase] of [['pt-BR', 'investigate'], ['pt-BR', 'execute'], ['en', 'investigate']] as const) {
    const line = text(draw({ columns: 40, lang, running: 3, agents: 3, run: { ...RUN, phase, tasks } })[2])
    expect([...line].length).toBeLessThanOrEqual(40 - [...'×3 ✕'].length)
    expect(line).toMatch(/0\/12 (tarefas|tasks) · 3 (agentes|agents)$/)
  }
})
