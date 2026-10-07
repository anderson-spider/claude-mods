import { expect, test } from 'claude-code/testing'
import { PROMPT } from '../hooks/prompts'
import { bandRows, doctorReport } from '../hooks/presentation'
import type { BandJob } from '../types'
import { band } from './helpers'

test('bandRows draws one row per job with its status, elapsed time and pane', () => {
  const { rows, hidden } = bandRows([band('ct-1', 'working', 130)], 5)
  expect(rows).toEqual(['ct-1 execute  working  2m10s  w1:p2'])
  expect(hidden).toBe(0)
})

test('bandRows pads the seconds and points a blocked job to its pane', () => {
  expect(bandRows([band('ct-4', 'working', 605)], 5).rows[0]).toContain('10m05s')
  expect(bandRows([band('ct-4', 'working', 45)], 5).rows[0]).toContain('0m45s')
  expect(bandRows([band('ct-4', 'blocked', 45, 'w1:p3')], 5).rows[0]).toBe('ct-4 execute  blocked  0m45s  w1:p3  ← answer in the pane')
})

test('bandRows caps the rows at the room and counts the rest as hidden', () => {
  const jobs = [band('ct-1', 'working', 1), band('ct-2', 'working', 2), band('ct-3', 'working', 3)]
  const { rows, hidden } = bandRows(jobs, 2)
  expect(rows.length).toBe(2)
  expect(hidden).toBe(1)
  expect(bandRows(jobs, 0)).toEqual({ rows: [], hidden: 3 })
  expect(bandRows([], 5)).toEqual({ rows: [], hidden: 0 })
})

test('PROMPT teaches Claude to lead: execute, review, the report and the queue', () => {
  expect(PROMPT).toContain('mcp__codex-team__execute')
  expect(PROMPT).toContain('mcp__codex-team__review')
  expect(PROMPT).toContain('report')
  expect(PROMPT).toContain('second')
  expect(PROMPT).toContain('mcp__codex-team__loop')
  expect(PROMPT).toContain('maxRounds')
  expect(PROMPT).toContain('one message at the end with a verdict')
})

test('bandRows draws the loop phase and round without changing job rows', () => {
  const loop: BandJob = { id: 'loop-1', kind: 'loop', status: 'reviewing', round: 2, maxRounds: 3, pane: '…', elapsedSeconds: 10 }
  const { rows } = bandRows([loop, band('ct-4', 'working', 10)], 2)
  expect(rows[0]).toContain('loop-1 reviewing 2/3')
  expect(rows[1]).toBe('ct-4 execute  working  0m10s  w1:p2')
})

test('doctorReport marks each check and counts the failures', () => {
  const text = doctorReport([
    { name: 'herdr', ok: true, detail: 'herdr 0.9.3' },
    { name: 'codex', ok: false, detail: 'not in PATH' },
  ])
  expect(text).toContain('✓ herdr: herdr 0.9.3')
  expect(text).toContain('✗ codex: not in PATH')
  expect(text).toContain('1 check(s) failed.')
  expect(doctorReport([{ name: 'herdr', ok: true, detail: 'ok' }])).toContain('Everything codex-team relies on is in place.')
})
