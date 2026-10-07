import { expect, test } from 'claude-code/testing'
import { checksOf, isWaiting, verdictOf } from '../hooks/report'

test('verdictOf accepts only the exact last non-empty line', () => {
  expect(verdictOf('findings\nVERDICT: APPROVED')).toBe('approved')
  expect(verdictOf('findings\n  VERDICT: CHANGES  \n\n  ')).toBe('changes')
  expect(verdictOf('findings\r\n VERDICT: APPROVED \r\n')).toBe('approved')
  for (const report of [undefined, '', '  \n', 'verdict: approved', 'VERDICT: approved', 'VERDICT: APPROVED extra', 'VERDICT: APPROVED\nmore text']) {
    expect(verdictOf(report)).toBe(undefined)
  }
})

test('isWaiting accepts only an exact first non-empty line', () => {
  expect(isWaiting('STATUS: WAITING\nWhich port?')).toBe(true)
  expect(isWaiting('\n  STATUS: WAITING  \r\nWhich port?')).toBe(true)
  for (const report of [undefined, '', '## Report\nSTATUS: WAITING', 'status: waiting', 'STATUS: WAITING now']) {
    expect(isWaiting(report)).toBe(false)
  }
})

test('checksOf reads the first CHECKS line', () => {
  expect(checksOf('## Checks\nCHECKS: PASS — claude plugin test')).toBe('pass')
  expect(checksOf('CHECKS: FAIL — 2 failing')).toBe('fail')
  expect(checksOf('CHECKS: NOT RUN')).toBe('not run')
  expect(checksOf('CHECKS: FAIL\nCHECKS: PASS')).toBe('fail')
  for (const report of [undefined, '', 'checks: pass', 'CHECKS: PASSED', 'CHECKS: maybe']) {
    expect(checksOf(report)).toBe(undefined)
  }
})

test('verdictOf reads an approval that ends the report with a trailing newline', () => {
  expect(verdictOf('x\nVERDICT: APPROVED\n')).toBe('approved')
})

test('verdictOf rejects a verdict line that is not the last one', () => {
  expect(verdictOf('VERDICT: APPROVED\nmore')).toBe(undefined)
})

test('isWaiting reads a STATUS: WAITING first line after leading blank lines', () => {
  expect(isWaiting('\nSTATUS: WAITING\nq')).toBe(true)
})

test('isWaiting rejects STATUS: WAITING when it is not the first line', () => {
  expect(isWaiting('a\nSTATUS: WAITING')).toBe(false)
})

test('checksOf returns the lowercase status of the CHECKS line', () => {
  expect(checksOf('## Checks\nCHECKS: FAIL')).toBe('fail')
})

test('checksOf returns undefined when no CHECKS line exists', () => {
  expect(checksOf('## Checks\nno status here')).toBe(undefined)
})
