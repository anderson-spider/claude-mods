import { expect, test } from 'claude-code/testing'
import { cleanLog, errorExcerpt, jobLog } from '../hooks/joblog'
import { fakeCtx } from './fake-api'

const ESC = '\x1b'

test('cleanLog removes colours and section markers and keeps the last state of a rewritten line', () => {
  const raw = `${ESC}[0Ksection_start:1700000000:step_script[collapsed=true]\r${ESC}[0K${ESC}[36;1mExecuting${ESC}[0;m\nprogress 10%\rprogress 100%\r\nsection_end:1700000001:step_script\r${ESC}[0K`
  expect(cleanLog(raw)).toEqual(['Executing', 'progress 100%', ''])
})

test('errorExcerpt shows each match with three lines around it, merged, then the last thirty lines', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
  lines[9] = 'Error: boom'
  lines[11] = 'npm ERR! failed'
  const { text, matches } = errorExcerpt(lines, /error|err!/i)
  const shown = text.split('\n')

  expect(matches).toBe(2)
  expect(shown[0]).toBe('    7| line 7')
  expect(shown[6]).toBe('   13| line 13')
  expect(shown[8]).toBe('   15| line 15')
  expect(shown).toContain('  …')
  expect(shown.at(-1)).toBe('  100| line 100')
  expect(shown.filter((l) => /^\s+\d+\|/.test(l))).toHaveLength(9 + 30)
})

test('errorExcerpt caps the match lines even when the matches merge into one range spanning the log', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `error ${i + 1}`)
  const shown = errorExcerpt(lines, /error/).text.split('\n')
  expect(shown.filter((l) => /^\s+\d+\|/.test(l))).toHaveLength(300 + 30)
  expect(shown[299]).toBe('  300| error 300')
})

test('errors mode heads the excerpt with the job and its failure reason; tail and pattern work', async () => {
  const trace = ['$ npm test', 'ok 1', 'FAIL src/a.test.ts', 'expected 1', 'done'].join('\n')
  const { ctx } = fakeCtx({
    'GET /jobs/2': { name: 'unit', stage: 'test', status: 'failed', failure_reason: 'script_failure' },
    'GET /jobs/2/trace': trace,
  })

  const errors = await jobLog(ctx, { jobId: 2 })
  expect(errors.split('\n')[0]).toBe('Job 2 unit (test): failed, script_failure; 5 lines; 1 matching lines, then the last 5')

  const tail = await jobLog(ctx, { jobId: 2, mode: 'tail', lines: 2 })
  expect(tail.split('\n').slice(1)).toEqual(['    4| expected 1', '    5| done'])

  const custom = await jobLog(ctx, { jobId: 2, pattern: 'expected' })
  expect(custom).toContain('1 matching lines')
  await expect(jobLog(ctx, { jobId: 2, pattern: '(' })).rejects.toThrow('pattern is not a valid regular expression.')
  await expect(jobLog(ctx, { jobId: 2, mode: 'head' })).rejects.toThrow('mode must be errors, tail or full.')
  await expect(jobLog(ctx, {})).rejects.toThrow(/needs jobId/)
})
