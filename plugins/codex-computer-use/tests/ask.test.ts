import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { BAND, TOOL, pause, ran, textOf } from './helpers'

// The bridge's real question flow (`holdQuestion` in hooks/question.ts, wired in
// hooks/register.tsx) reached through `tool.call`. The test host's `mock.clock`
// answers `$.clock`, but the flow reads the global `Date.now()` and waits through
// `$.process.run(['sleep', '0.25'])`, so the deadline runs on the real clock
// (`approvalMinutes: 0.001` is 60 ms) and every poll is a held `process.run`
// the test releases or fails by hand. The host also has no way to abort a
// dispatch's `next.signal`, so `signal.aborted` itself is not driven here: the
// `aborted` outcome is reached through the `catch` (a poll that throws).

type Poll = { argv: readonly string[]; settled: boolean; release: () => void; fail: () => void }

const NEEDS = { status: 'needs_approval', app: { bundleId: 'com.apple.TextEdit', displayName: 'TextEdit', canAlways: true } }
const CODE = 'let app = await cua.getApp("TextEdit");'

/** The helper behind `http.fetch` (TextEdit asks until the caller is approved) and every `process.run` held as a Poll. */
const askWorld = (on: On) => {
  const polls: Poll[] = []
  const approved = new Set<string>()
  const store = new Map<string, unknown>()

  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', () => ({ value: '/home/me' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', (_$, e) =>
    new Promise((resolve, reject) => {
      const poll: Poll = {
        argv: e.argv,
        settled: false,
        release: () => ((poll.settled = true), resolve({ value: ran('') })),
        fail: () => ((poll.settled = true), reject(new Error('poll failed'))),
      }
      polls.push(poll)
    }),
  )
  on('http.fetch', (_$, e) => {
    const route = e.url.replace('http://codex-cu', '')
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    const reply = (value: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(value) } })

    if (route === '/approve') {
      approved.add(String(body.caller))

      return reply({ status: 'ok' })
    }

    if (route === '/call' && !approved.has(String(body.caller))) {
      return reply(NEEDS)
    }

    return reply({ status: 'ok', isError: false, content: [{ type: 'text', text: `ran ${String(body.caller)}` }] })
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['idle'] }))

  return polls
}

const until = async (done: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !done(); i++) {
    await pause(5)
  }

  expect(`${what}: ${done()}`).toBe(`${what}: true`)
}

/** Lets the engine settle after a release, long enough for a held poll's next iteration to be issued. */
const settle = () => pause(40)

test('ask polls with sleep 0.25 through $.process.run, one poll at a time, and the answer ends the wait', async ($, on) => {
  const polls = askWorld(on)

  const pending = $.tool.call({ tool: TOOL, code: CODE, tool_use_id: 'q1' } as never)
  await until(() => polls.length === 1, 'first poll issued')
  expect(polls[0]?.argv).toEqual(['sleep', '0.25'])

  // Nothing else is scheduled: no second poll while the first is held.
  await settle()
  expect(polls).toHaveLength(1)

  polls[0]?.release()
  await until(() => polls.length === 2, 'second poll issued after the first returned')
  expect(polls[1]?.argv).toEqual(['sleep', '0.25'])
  await settle()
  expect(polls).toHaveLength(2)

  // The band shows the question while it is pending; the person's press is read on the next poll.
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Codex computer use · Allow “TextEdit”?' })).toBeDefined()
  await ui.press({ key: 'session' })
  expect(polls).toHaveLength(2)
  polls[1]?.release()

  expect(textOf(await pending)).toBe('ran sess-1')
  // The answer loop made no further poll after the one that saw the choice.
  expect(polls).toHaveLength(2)
  await ui.unmount()
})

test('a second question waits in a queue with no deadline, and its deadline counted from before the queue', { options: { approvalMinutes: 0.001 } }, async ($, on) => {
  const polls = askWorld(on)

  const first = $.tool.call({ tool: TOOL, code: CODE, agentId: 'agent-a', tool_use_id: 'q1' } as never)
  await until(() => polls.length === 1, 'first question polling')
  const second = $.tool.call({ tool: TOOL, code: CODE, agentId: 'agent-b', tool_use_id: 'q2' } as never)
  await until(() => polls.length === 2, 'second question queued and polling')
  expect(polls.map(poll => poll.argv)).toEqual([['sleep', '0.25'], ['sleep', '0.25']])

  let secondDone = false
  void second.then(() => (secondDone = true))

  // Past the 60 ms limit, the queued question is still waiting: its queue loop never reads the clock.
  await pause(150)
  polls[1]?.release()
  await until(() => polls.length === 3, 'queued question polled again after its deadline')
  expect(secondDone).toBe(false)
  expect(polls[2]?.argv).toEqual(['sleep', '0.25'])

  // The first question times out at its next poll (its deadline passed) and frees the queue.
  polls[0]?.release()
  const firstAnswer = await first
  expect(firstAnswer.isError).toBe(true)
  expect(textOf(firstAnswer)).toBe('The person did not answer whether Codex may use TextEdit within 0.1 seconds; nothing was done with it.')
  expect(secondDone).toBe(false)

  // The second leaves the queue, finds its deadline (taken before the queue) already past, and times out
  // without a single poll of its own answer loop.
  polls[2]?.release()
  const secondAnswer = await second
  expect(secondAnswer.isError).toBe(true)
  expect(textOf(secondAnswer)).toBe('The person did not answer whether Codex may use TextEdit within 0.1 seconds; nothing was done with it.')
  expect(polls).toHaveLength(3)
})

/** Releases every held poll as it appears, as a `sleep` that returns, until `work` settles. */
const pump = async <T>(polls: Poll[], work: Promise<T>) => {
  let done = false
  void work.then(
    () => (done = true),
    () => (done = true),
  )

  while (!done) {
    for (const poll of polls.filter(item => !item.settled)) {
      poll.release()
    }

    await pause(5)
  }

  return work
}

test('ask ends in timeout once the deadline passes, and the band is cleared', { options: { approvalMinutes: 0.001 } }, async ($, on) => {
  const polls = askWorld(on)

  const started = Date.now()
  const answer = await pump(polls, $.tool.call({ tool: TOOL, code: CODE, tool_use_id: 'q1' } as never))
  // The limit (60 ms) is read from the real clock: `mock.clock` does not reach `Date.now()`.
  expect(Date.now() - started).toBeGreaterThanOrEqual(60)
  expect(answer.isError).toBe(true)
  expect(textOf(answer)).toBe('The person did not answer whether Codex may use TextEdit within 0.1 seconds; nothing was done with it.')
  expect(polls.length).toBeGreaterThan(0)
  expect(polls.map(poll => poll.argv)).toEqual(polls.map(() => ['sleep', '0.25']))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'idle' })).toBeDefined()
  await ui.unmount()
})

test('ask ends in aborted, not timeout, when waiting fails, and the band is cleared', async ($, on) => {
  const polls = askWorld(on)

  const pending = $.tool.call({ tool: TOOL, code: CODE, tool_use_id: 'q1' } as never)
  await until(() => polls.length === 1, 'first poll issued')
  polls[0]?.fail()
  const answer = await pending

  expect(answer.isError).toBe(true)
  // `aborted` leaves out the " within <limit>" that only `timeout` carries.
  expect(textOf(answer)).toBe('The person did not answer whether Codex may use TextEdit; nothing was done with it.')
  expect(polls).toHaveLength(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'idle' })).toBeDefined()
  await ui.unmount()
})

test('a queued question that fails ends in aborted and leaves the first question on the band', async ($, on) => {
  const polls = askWorld(on)

  const first = $.tool.call({ tool: TOOL, code: CODE, agentId: 'agent-a', tool_use_id: 'q1' } as never)
  await until(() => polls.length === 1, 'first question polling')
  const second = $.tool.call({ tool: TOOL, code: CODE, agentId: 'agent-b', tool_use_id: 'q2' } as never)
  await until(() => polls.length === 2, 'second question queued')

  polls[1]?.fail()
  const refused = await second
  expect(refused.isError).toBe(true)
  expect(textOf(refused)).toBe('The person did not answer whether Codex may use TextEdit; nothing was done with it.')

  // Only the owner of the slot clears it: the first question is still asked and still answerable.
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Asked by the subagent agent-a\./ })).toBeDefined()
  await ui.press({ key: 'session' })
  expect(textOf(await pump(polls, first))).toBe('ran sess-1/agent-a')
  await ui.unmount()
})
