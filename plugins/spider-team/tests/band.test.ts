import { expect, test } from 'claude-code/testing'
import type { SpiderRun, SpiderTask } from '../types'
import { bandLine } from '../hooks/band'
import type { Piece } from '../hooks/text'

const task = (id: string, state: SpiderTask['state'], owner: SpiderTask['owner'] = 'main'): SpiderTask => ({ id, title: id, owner, after: [], state, attempts: 1, errors: [], agentIds: [] })
const RUN: SpiderRun = { runId: 'r', title: 'Implement authentication', phase: 'execute', startedAt: 0, tasks: [task('T1', 'completed'), task('T2', 'completed'), task('T3', 'running'), task('T4', 'reviewing', 'worker'), task('T5', 'pending')] }
const text = (line: Piece[]) => line.map(p => p.text).join('')
const draw = (over: Partial<Parameters<typeof bandLine>[0]> = {}) => bandLine({ run: RUN, running: 2, agents: 3, lastTool: 'Grep', columns: 120, lang: 'en', frame: 0, animations: false, ...over })

test('the band is one line: mark, counts, tasks in progress, agents running and the latest tool', () => {
  expect(text(draw())).toBe('● spider · 2 accepted / 2 running / 1 left │ T3 main  T4 worker │ 2 agents · Grep')
  expect(text(draw({ lang: 'pt-BR', running: 1 }))).toBe('● spider · 2 aceitas / 2 rodando / 1 falta │ T3 main  T4 worker │ 1 agente · Grep')
  expect(text(draw({ running: 0 }))).not.toContain('Grep')
})

test('a count of one takes the singular word', () => {
  const run = { ...RUN, tasks: [task('T1', 'completed'), task('T2', 'pending'), task('T3', 'failed')] }
  expect(text(draw({ run, lang: 'pt-BR', running: 0 }))).toBe('● spider · 1 aceita / 0 rodando / 1 falta / 1 falhou │ 0 agentes')
})

test('failed tasks are counted in error, and the mark shows how the run ended', () => {
  const line = draw({ run: { ...RUN, tasks: [...RUN.tasks, task('T6', 'failed')] } })
  expect(line.find(p => p.text.includes('1 failed'))!.style).toBe('error')
  expect(draw({ run: { ...RUN, phase: 'complete' } })[0]).toEqual({ text: '✓', style: 'ok' })
  expect(draw({ run: { ...RUN, phase: 'failed' } })[0]).toEqual({ text: '✗', style: 'error' })
  expect(draw({ running: 0 })[0]).toEqual({ text: '●', style: 'dim' })
})

test('a narrow band leaves room for the buttons, drops the tool, then the tasks, and cuts the counts last', () => {
  for (const columns of [70, 60, 40, 20]) {
    const line = text(draw({ columns }))
    expect([...line].length).toBeLessThanOrEqual(columns - [...'×3 ✕'].length - 1)
  }
  expect(text(draw({ columns: 80 }))).toBe('● spider · 2 accepted / 2 running / 1 left │ T3 main  T4 worker │ 2 agents')
  expect(text(draw({ columns: 64 }))).toBe('● spider · 2 accepted / 2 running / 1 left │ 2 agents')
  expect(text(draw({ columns: 40 })).endsWith('…')).toBe(true)
})

test('a running agent shows a spinner only with animations on', () => {
  expect(draw({ animations: true, frame: 1 })[0]!.text).toBe('⠙')
  expect(draw({ animations: false, frame: 1 })[0]!.text).toBe('●')
})

test('tasks the run cancelled stay in the band counts', () => {
  const run: SpiderRun = { ...RUN, phase: 'cancelled', tasks: [task('T1', 'completed'), { ...task('T2', 'cancelled'), cancelledWithRun: true }, task('T3', 'cancelled')] }
  expect(text(draw({ run, running: 0 }))).toBe('– spider · 1 accepted / 0 running / 0 left / 1 cancelled │ 0 agents')
})
