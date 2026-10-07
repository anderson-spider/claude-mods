import { expect, test } from 'claude-code/testing'
import { HerdrError } from '../hooks/model'
import { herdrAvailable, versionOf } from '../hooks/herdr'
import { owns } from '../hooks/identity'
import { fakeRun, agent, adapter } from './helpers'

test('herdrOf passes a prompt with quotes, newlines and $() as exactly one argv element', async () => {
  const { herdr, argvs } = adapter({ 'agent prompt': { stdout: agent('done') } })
  const text = 'a "b"\n`c` $(d) \'e\''
  expect(await herdr.prompt('ct-1', text, 1000)).toBe('done')
  const argv = argvs.find(a => a[2] === 'prompt')!
  expect(argv).toEqual(['herdr', 'agent', 'prompt', 'ct-1', text, '--wait', '--timeout', '1000'])
})

test('herdrOf gives the process room beyond the herdr wait it asks for', async () => {
  const { herdr, timeouts } = adapter({ 'agent prompt': { stdout: agent('idle') }, 'agent wait': { stdout: agent('blocked') } })
  await herdr.prompt('ct-1', 'x', 540_000)
  expect(timeouts[0]).toBe(560_000)
  expect(await herdr.wait('ct-1', 1000)).toBe('blocked')
  expect(timeouts[1]).toBe(21_000)
})

test('herdrOf splits the given pane without focus, in the given directory', async () => {
  const { herdr, argvs } = adapter({ 'pane split': { stdout: JSON.stringify({ result: { pane: { pane_id: 'w1:p2' } } }) } })
  expect(await herdr.split('down')).toBe('w1:p2')
  expect(argvs[0]).toEqual(['herdr', 'pane', 'split', 'w1:p1', '--direction', 'down', '--cwd', '/proj', '--no-focus'])
  expect(await herdr.split('right', 'w1:p3')).toBe('w1:p2')
  expect(argvs[1]).toEqual(['herdr', 'pane', 'split', 'w1:p3', '--direction', 'right', '--cwd', '/proj', '--no-focus'])
})

test('herdrOf closes the given pane by id', async () => {
  const { herdr, argvs } = adapter({})
  await herdr.close('w1:p2')
  expect(argvs[0]).toEqual(['herdr', 'pane', 'close', 'w1:p2'])
})

test('herdrOf ignores a pane that is already gone but propagates other close errors', async () => {
  for (const code of ['pane_not_found', 'unknown']) {
    const { herdr } = adapter({ 'pane close': { exitCode: 1, stderr: JSON.stringify({ error: { code, message: 'close failed' } }) } })
    const error = await herdr.close('w1:p2').catch(e => e)
    if (code === 'pane_not_found') expect(error).toBeUndefined()
    else {
      expect(error).toBeInstanceOf(HerdrError)
      expect(error.code).toBe('unknown')
    }
  }
})

test('herdrOf starts Codex with its own arguments after --', async () => {
  const { herdr, argvs } = adapter({})
  await herdr.start('ct-1', 'w1:p2', ['-s', 'read-only', '-a', 'on-request'])
  expect(argvs[0]).toEqual(['herdr', 'agent', 'start', 'ct-1', '--kind', 'codex', '--pane', 'w1:p2', '--', '-s', 'read-only', '-a', 'on-request'])
})

test('herdrOf waits until the given states and sends keys', async () => {
  const { herdr, argvs } = adapter({ 'agent wait': { stdout: agent('working') } })
  expect(await herdr.wait('ct-1', 5000, ['working', 'idle'])).toBe('working')
  expect(argvs[0]).toEqual(['herdr', 'agent', 'wait', 'ct-1', '--timeout', '5000', '--until', 'working', '--until', 'idle'])
  await herdr.sendKeys('ct-1', ['esc'])
  expect(argvs[1]).toEqual(['herdr', 'agent', 'send-keys', 'ct-1', 'esc'])
})

test('herdrOf submits text without waiting for the agent', async () => {
  const { herdr, argvs } = adapter({})
  await herdr.submit('ct-1', '/stop')
  expect(argvs[0]).toEqual(['herdr', 'agent', 'prompt', 'ct-1', '/stop'])
})

test('herdrOf reads the pane text raw and lists only ct agents', async () => {
  const listed = JSON.stringify({ result: { agents: [{ agent: 'claude', pane_id: 'w1:p1' }, { agent: 'codex', name: 'ct-2', pane_id: 'w1:p3' }, { agent: 'codex', name: 'other', pane_id: 'w1:p4' }] } })
  const { herdr, argvs } = adapter({ 'agent read': { stdout: 'line 1\nline 2\n' }, 'agent list': { stdout: listed } })
  expect(await herdr.read('ct-1', 50)).toBe('line 1\nline 2\n')
  expect(argvs[0]).toEqual(['herdr', 'agent', 'read', 'ct-1', '--source', 'recent-unwrapped', '--lines', '50'])
  expect(await herdr.list()).toEqual([{ name: 'ct-2', pane: 'w1:p3' }])
})

test('herdrOf lists the terminal of each ct agent', async () => {
  const listed = JSON.stringify({ result: { agents: [{ agent: 'codex', name: 'ct-2', pane_id: 'w1:p3', terminal_id: 'term_a' }] } })
  const { herdr } = adapter({ 'agent list': { stdout: listed } })
  expect(await herdr.list()).toEqual([{ name: 'ct-2', pane: 'w1:p3', terminal: 'term_a' }])
})

test('owns needs the name and pane, and the terminal once known', async () => {
  const herdr = { list: async () => [{ name: 'ct-2', pane: 'w1:p3', terminal: 'term_a' }] }
  expect(await owns(herdr, 'ct-2', 'w1:p3')).toBe(true)
  expect(await owns(herdr, 'ct-2', 'w1:p3', 'term_a')).toBe(true)
  expect(await owns(herdr, 'ct-2', 'w1:p3', 'term_b')).toBe(false)
  expect(await owns(herdr, 'ct-2', 'w1:p4', 'term_a')).toBe(false)
})

test('herdrOf notifies and annotates with one argv element per value and the codex-team source', async () => {
  const { herdr, argvs } = adapter({ 'notification show': { stdout: '{}' }, 'pane report-metadata': { stdout: '{}' } })
  await herdr.notify('codex-team: ct-1 needs you', 'pane w1:p2 "x" $(y)')
  expect(argvs[0]).toEqual(['herdr', 'notification', 'show', 'codex-team: ct-1 needs you', '--body', 'pane w1:p2 "x" $(y)', '--sound', 'request'])
  await herdr.annotate('w1:p2', { title: 'ct-1 execute', stateLabel: 'needs you', ttlMs: 1000 })
  expect(argvs[1]).toEqual(['herdr', 'pane', 'report-metadata', 'w1:p2', '--source', 'codex-team', '--title', 'ct-1 execute', '--state-label', 'blocked=needs you', '--ttl-ms', '1000'])
  await herdr.annotate('w1:p2', { ttlMs: 5 })
  expect(argvs[2]).toEqual(['herdr', 'pane', 'report-metadata', 'w1:p2', '--source', 'codex-team', '--ttl-ms', '5'])
})

test('herdrOf turns a CLI error into a HerdrError with its code', async () => {
  const { herdr } = adapter({ 'agent start': { exitCode: 1, stderr: '{"error":{"code":"agent_not_ready","message":"blocked at startup"},"id":"x"}' }, 'agent wait': { exitCode: 1, stdout: 'not json at all' } })
  const started = await herdr.start('ct-1', 'w1:p2', []).catch(e => e)
  expect(started).toBeInstanceOf(HerdrError)
  expect((started as HerdrError).code).toBe('agent_not_ready')
  expect((started as HerdrError).message).toContain('blocked at startup')
  const waited = await herdr.wait('ct-1', 1000).catch(e => e)
  expect((waited as HerdrError).code).toBe('unknown')
  expect((waited as HerdrError).message).toContain('not json at all')
})

test('herdrOf refuses a prompt answer that is not a settled state', async () => {
  const { herdr } = adapter({ 'agent prompt': { stdout: agent('working') } })
  const error = await herdr.prompt('ct-1', 'x', 1000).catch(e => e)
  expect(error).toBeInstanceOf(HerdrError)
})

test('herdrAvailable says why the plugin cannot run', async () => {
  expect(await herdrAvailable(fakeRun({}).run, {})).toContain('Herdr')
  expect(await herdrAvailable(fakeRun({ herdr: { exitCode: 127 } }).run, { HERDR_ENV: '1' })).toContain('herdr')
  expect(await herdrAvailable(fakeRun({ codex: { exitCode: 127 } }).run, { HERDR_ENV: '1' })).toContain('codex')
  expect(await herdrAvailable(fakeRun({}).run, { HERDR_ENV: '1' })).toBeUndefined()
})

test('herdrOf passes the pane name as one argv element', async () => {
  const { herdr, argvs } = adapter({})
  await herdr.rename('w1:p2', 'loop-1 dev')
  expect(argvs[0]).toEqual(['herdr', 'pane', 'rename', 'w1:p2', 'loop-1 dev'])
})

test('versionOf answers the first stdout line of a successful version probe, else nothing', async () => {
  expect(await versionOf(async () => ({ exitCode: 0, stdout: 'herdr 1.2\nmore' }), 'herdr')).toBe('herdr 1.2')
  expect(await versionOf(async () => ({ exitCode: 1, stdout: '' }), 'herdr')).toBeUndefined()
  expect(await versionOf(async () => undefined, 'herdr')).toBeUndefined()
})
