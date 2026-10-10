import { expect, test } from 'claude-code/testing'
import { parseArchitect, parseQa } from '../hooks/flow/verdicts'

const qa = (...lines: string[]) => lines.join('\n')

test('QA pass needs every criterion line to pass', () => {
  expect(parseQa(qa('C1: pass — ran npm test, 12 passed', 'C2: pass — curl returned 200', 'QA: pass'), 2)).toEqual({ ok: true, verdict: 'pass' })
})

test('QA fail quotes the failing criteria', () => {
  const result = parseQa(qa('C1: pass — fine', 'C2: fail — the export is missing, run `node a.js`', 'QA: fail'), 2)
  expect(result).toMatchObject({ ok: true, verdict: 'fail' })
  expect(result.ok && result.note).toContain('C2: fail')
  expect(result.ok && result.note).toContain('export is missing')
})

test('QA blocked keeps its reason and needs no criterion lines', () => {
  expect(parseQa('QA: blocked — the staging database is not reachable', 2)).toEqual({ ok: true, verdict: 'blocked', note: 'the staging database is not reachable' })
  expect(parseQa('QA: blocked', 1)).toEqual({ ok: true, verdict: 'blocked' })
})

test('a QA pass with a missing criterion is partial coverage, so a fail', () => {
  const result = parseQa(qa('C1: pass — ok', 'QA: pass'), 3)
  expect(result).toMatchObject({ ok: true, verdict: 'fail' })
  expect(result.ok && result.note).toContain('C2, C3 have no passing line')
})

test('a QA pass beside a failing criterion line is a fail', () => {
  const result = parseQa(qa('C1: pass — ok', 'C2: fail — nope', 'QA: pass'), 2)
  expect(result).toMatchObject({ ok: true, verdict: 'fail' })
  expect(result.ok && result.note).toContain('C2: fail')
})

test('a task without criteria needs only the final QA line', () => {
  expect(parseQa('Looked at it. QA: pass is below\nQA: pass', 0)).toEqual({ ok: true, verdict: 'pass' })
})

test('QA output with no final verdict is unparseable, never a receipt', () => {
  expect(parseQa('C1: pass — ok', 1)).toMatchObject({ ok: false })
  expect(parseQa('All looks good to me.', 1)).toMatchObject({ ok: false })
  expect(parseQa('', 0)).toMatchObject({ ok: false })
})

test('quotes, bullets, emphasis and case around the lines are tolerated; the last QA line wins', () => {
  expect(parseQa(qa('> C1: pass — ok', '  C2: pass — ok', '**QA: pass**'), 2)).toEqual({ ok: true, verdict: 'pass' })
  expect(parseQa(qa('- C1: pass — ok', '* c2: PASS — ok', 'qa: Pass'), 2)).toEqual({ ok: true, verdict: 'pass' })
  expect(parseQa(qa('C1: pass — ok', 'QA: fail', 'Re-ran after the fix.', 'QA: pass'), 1)).toEqual({ ok: true, verdict: 'pass' })
})

test('the architect ends with REVIEW: pass or fail', () => {
  expect(parseArchitect('Looks right.\nREVIEW: pass')).toEqual({ ok: true, verdict: 'pass' })
  const failed = parseArchitect('The null case in a.ts:12 is not handled.\nREVIEW: fail')
  expect(failed).toMatchObject({ ok: true, verdict: 'fail' })
  expect(failed.ok && failed.note).toBe('The null case in a.ts:12 is not handled.')
  expect(parseArchitect('**REVIEW: Pass**')).toEqual({ ok: true, verdict: 'pass' })
})

test('an architect answer without the line is no receipt', () => {
  expect(parseArchitect('I think it is fine.')).toMatchObject({ ok: false })
  expect(parseArchitect('REVIEW pass')).toMatchObject({ ok: false })
})
