import { expect, test } from 'claude-code/testing'
import { agentName, nextFreeId, reportPath } from '../hooks/names'

test('agentName prefixes the job id', () => {
  expect(agentName(3)).toBe('ct-3')
})

test('nextFreeId skips the names that are still live agents', () => {
  expect(nextFreeId(1, ['ct-1', 'ct-2', 'other'])).toBe(3)
  expect(nextFreeId(1, [])).toBe(1)
})

test('reportPath lives in a codex-team folder of TMPDIR, falling back to /tmp', () => {
  expect(reportPath('/var/tmp', 4)).toBe('/var/tmp/codex-team/4.md')
  expect(reportPath('/var/tmp/', 4)).toBe('/var/tmp/codex-team/4.md')
  expect(reportPath(undefined, 4)).toBe('/tmp/codex-team/4.md')
})

test('nextFreeId reserves a loop id while either role agent is live', () => {
  expect(nextFreeId(1, ['ct-1-dev', 'ct-2-qa', 'ct-3', 'ct-40-dev'])).toBe(4)
  expect(nextFreeId(1, ['ct-10-dev', 'ct-1-other'])).toBe(1)
})
