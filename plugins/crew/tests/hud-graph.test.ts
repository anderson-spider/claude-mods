import { expect, test } from 'claude-code/testing'
import { glyphOf, treeRows } from '../hooks/hud/graph'
import type { GraphStep } from '../hooks/hud/graph'

const step = (id: string, state: string, after: string[] = [], owner = 'main'): GraphStep => ({ id, owner, after, state })
const statesOf = (steps: readonly GraphStep[], extra: [string, string][] = []) => new Map([...steps.map(s => [s.id, s.state] as [string, string]), ...extra])
const shown = (steps: readonly GraphStep[], extra: [string, string][] = []) => treeRows(steps, statesOf(steps, extra)).map(row => `${row.rail}${row.body}`)

test('a step hangs under its first dependency; the others show as references, with the signal derived from them', () => {
  const steps = [step('T1', 'verified'), step('T2', 'implementing', ['T1']), step('T3', 'queued', ['T2']), step('T4', 'queued', ['T1', 'T2'])]
  expect(treeRows(steps, statesOf(steps))).toEqual([
    { rail: '', body: '● T1 main  done', tone: 'done' },
    { rail: '├─ ', body: '◎ T2 main  working', tone: 'running' },
    { rail: '│  └─ ', body: '○ T3 main  waits T2', tone: 'waiting' },
    { rail: '└─ ', body: '○ T4 main  waits T2  <- T2', tone: 'waiting' },
  ])
})

test('a queued step is ready once every dependency is settled, and an id the plan does not know keeps it waiting', () => {
  const steps = [step('A1', 'committed'), step('A2', 'queued', ['A1']), step('A3', 'queued', ['A1', 'Z9']), step('A4', 'queued', ['X1'])]
  expect(shown(steps, [['X1', 'implementing']])).toEqual([
    '● A1 main  done',
    '├─ ○ A2 main  ready',
    '└─ ○ A3 main  waits Z9  <- Z9',
    '○ A4 main  waits X1  <- X1',
  ])
})

test('a settled branch folds into its root, and a blocked step is never folded away', () => {
  expect(shown([step('T1', 'verified'), step('T2', 'committed', ['T1']), step('T3', 'skipped', ['T2'])])).toEqual(['● T1 main  done  [+2 done]'])
  expect(shown([step('T1', 'verified'), step('T2', 'blocked', ['T1']), step('T3', 'verified', ['T1'])])).toEqual([
    '● T1 main  done',
    '├─ ■ T2 main  blocked',
    '└─ ● T3 main  done',
  ])
})

test('a cycle or a self-dependency draws every step once and never loops', () => {
  const cyclic = shown([step('A', 'queued', ['B']), step('B', 'queued', ['A'])])
  expect(cyclic).toHaveLength(2)
  expect(cyclic.filter(line => line.includes('(cycle)'))).toHaveLength(1)
  expect(shown([step('S1', 'queued', ['S1'])])).toEqual(['○ S1 main  waits S1  (cycle)'])
  expect(shown([step('B1', 'verified'), step('S2', 'queued', ['B1', 'S2'])])).toEqual(['● B1 main  done', '└─ ○ S2 main  waits S2  (cycle)'])
})

test('siblings and roots keep the order the plan wrote them in', () => {
  const steps = [step('R2', 'queued'), step('R1', 'queued'), step('C9', 'queued', ['R1']), step('C1', 'queued', ['R1'])]
  expect(shown(steps).map(line => /[RC]\d/u.exec(line)?.[0])).toEqual(['R2', 'R1', 'C9', 'C1'])
})

test('an unknown state is a ? and an unknown owner stays what the caller sanitized', () => {
  expect(shown([step('T1', '?', [], '?')])).toEqual(['? T1 ?  ?'])
  expect(glyphOf('verified')).toBe('●')
  expect(glyphOf('implementing')).toBe('◎')
  expect(glyphOf('blocked')).toBe('■')
  expect(glyphOf('queued')).toBe('○')
  expect(glyphOf('anything else')).toBe('?')
})

test('the walk reads its input and leaves it as it was', () => {
  const steps = [step('T1', 'verified'), step('T2', 'implementing', ['T1'])]
  const before = JSON.stringify(steps)
  treeRows(steps, statesOf(steps))
  expect(JSON.stringify(steps)).toBe(before)
})
