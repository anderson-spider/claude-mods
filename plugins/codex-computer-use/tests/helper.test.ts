import { expect, test } from 'claude-code/testing'

import { LABEL, POLL, post, postStarting } from '../hooks/helper'
import type { Probe } from '../hooks/helper'

import { ran } from './helpers'

test('post speaks to the helper over its Unix socket and reports a missing helper as unreachable', async () => {
  const seen: { url: string; socketPath?: string }[] = []
  const run = async () => ran('')
  const reply = await post(
    { fetch: async (url, init) => (seen.push({ url, socketPath: init.socketPath }), Promise.reject(new Error('ECONNREFUSED'))), run },
    '/s.sock',
    '/call',
    { caller: 'x' },
  )

  expect(reply.status).toBe('unreachable')
  expect(seen).toEqual([{ url: 'http://codex-cu/call', socketPath: '/s.sock' }])

  const answered = await post({ fetch: async () => ({ status: 200, ok: true, headers: {}, text: '{"status":"ok","ended":[]}' }), run }, '/s.sock', '/release', {})
  expect(answered.status).toBe('ok')
})

// A fake probe: `fetch` fails until its `reachableAt`-th call (-1: never), `run` answers `id -u` and `launchctl`.
const fakeProbe = (options: { reachableAt: number; kickstartExit?: number; runFails?: boolean }) => {
  const runs: string[][] = []
  let fetches = 0
  const probe: Probe = {
    fetch: async () => {
      fetches++

      if (options.reachableAt < 0 || fetches <= options.reachableAt) {
        throw new Error(`down ${fetches}`)
      }

      return { status: 200, ok: true, headers: {}, text: '{"status":"ok","ended":[]}' }
    },
    run: async argv => {
      runs.push([...argv])

      if (options.runFails === true) {
        throw new Error('run failed')
      }

      return argv[0] === '/usr/bin/id' ? ran('501\n') : ran('', argv[0] === '/bin/launchctl' ? (options.kickstartExit ?? 0) : 0)
    },
  }

  return { probe, runs, fetches: () => fetches }
}

const START = [['/usr/bin/id', '-u'], ['/bin/launchctl', 'kickstart', `gui/501/${LABEL}`]]

test('postStarting leaves a reachable helper alone: one post, nothing run', async () => {
  const { probe, runs, fetches } = fakeProbe({ reachableAt: 0 })

  expect((await postStarting(probe, '/s.sock', '/release', {})).status).toBe('ok')
  expect(fetches()).toBe(1)
  expect(runs).toEqual([])
})

test('postStarting asks launchd for gui/<uid>/<label> and returns the first reply when the start fails, without polling', async () => {
  const { probe, runs, fetches } = fakeProbe({ reachableAt: -1, kickstartExit: 1 })
  const reply = await postStarting(probe, '/s.sock', '/release', {})

  expect(reply).toEqual({ status: 'unreachable', message: 'down 1' })
  expect(fetches()).toBe(1)
  expect(runs).toEqual(START)
})

test('postStarting returns the reply of poll N after N polls of sleep 0.25', async () => {
  for (const n of [1, 2, 20]) {
    const { probe, runs, fetches } = fakeProbe({ reachableAt: n })

    expect((await postStarting(probe, '/s.sock', '/release', {})).status).toBe('ok')
    expect(fetches()).toBe(n + 1)
    expect(runs).toEqual([...START, ...Array.from({ length: n }, () => ['sleep', '0.25'])])
  }

  expect(POLL).toEqual(['sleep', '0.25'])
})

test('postStarting gives up after twenty polls and returns the first reply; the count can be set', async () => {
  const never = fakeProbe({ reachableAt: -1 })

  expect(await postStarting(never.probe, '/s.sock', '/release', {})).toEqual({ status: 'unreachable', message: 'down 1' })
  expect(never.fetches()).toBe(21)
  expect(never.runs.filter(argv => argv[0] === 'sleep')).toHaveLength(20)

  const few = fakeProbe({ reachableAt: -1 })
  await postStarting(few.probe, '/s.sock', '/release', {}, 3)
  expect(few.fetches()).toBe(4)

  const none = fakeProbe({ reachableAt: 1 })
  expect((await postStarting(none.probe, '/s.sock', '/release', {}, 0)).status).toBe('unreachable')
  expect(none.runs).toEqual(START)
})

test('postStarting does not start a helper that answered with something that is not JSON', async () => {
  const runs: string[][] = []
  const probe: Probe = {
    fetch: async () => ({ status: 502, ok: false, headers: {}, text: 'bad gateway' }),
    run: async argv => (runs.push([...argv]), ran('')),
  }

  expect((await postStarting(probe, '/s.sock', '/release', {})).status).toBe('error')
  expect(runs).toEqual([])
})

test('postStarting rejects when a start step rejects: only the caller decides to swallow it', async () => {
  const { probe } = fakeProbe({ reachableAt: -1, runFails: true })
  let failure: unknown

  try {
    await postStarting(probe, '/s.sock', '/release', {})
  } catch (error) {
    failure = error
  }

  expect(failure).toEqual(new Error('run failed'))
})
