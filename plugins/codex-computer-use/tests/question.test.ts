import { expect, test } from 'claude-code/testing'

import { holdQuestion } from '../hooks/question'
import type { QuestionHost, Waiting } from '../hooks/question'
import type { CodexAsking } from '../types'

const question: CodexAsking = { id: 'q1', bundleId: 'com.apple.TextEdit', displayName: 'TextEdit', canAlways: true, who: 'main session' }
const LIMIT = 1000

/** A host with its own clock: each wait is 250 ms and `onWait` runs after it, with the poll's number. */
const worldOf = (onWait: (poll: number) => void = () => undefined) => {
  const world = {
    time: 0,
    polls: 0,
    log: [] as string[],
    waiting: { current: undefined } as Waiting,
    signal: { aborted: false } as { aborted: boolean },
  }
  const host: QuestionHost = {
    now: () => world.time,
    wait: async () => {
      world.polls += 1
      world.time += 250
      onWait(world.polls)
    },
    show: async asked => {
      world.log.push(asked === null ? 'clear' : `show ${asked.id}`)
    },
  }
  const hold = () => holdQuestion(host, world.waiting, LIMIT, question, world.signal as AbortSignal)

  return { world, host, hold }
}

test('holdQuestion times out once the injected clock passes the deadline and clears the band', async () => {
  const { world, hold } = worldOf()

  expect(await hold()).toBe('timeout')
  // Deadline 1000 from time 0: polls at 0, 250, 500 and 750 ms.
  expect(world.polls).toBe(4)
  expect(world.log).toEqual(['show q1', 'clear'])
  expect(world.waiting.current).toBeUndefined()
})

test('holdQuestion returns the choice made while waiting, without another poll', async () => {
  const { world, hold } = worldOf(poll => {
    if (poll === 2 && world.waiting.current !== undefined) {
      world.waiting.current.choice = 'always'
    }
  })

  expect(await hold()).toBe('always')
  expect(world.polls).toBe(2)
  expect(world.log).toEqual(['show q1', 'clear'])
  expect(world.waiting.current).toBeUndefined()
})

test('holdQuestion ends in aborted when the signal aborts during the answer wait, even past the deadline', async () => {
  const { world, hold } = worldOf(poll => {
    if (poll === 1) {
      world.signal.aborted = true
      world.time += 10_000
    }
  })

  expect(await hold()).toBe('aborted')
  expect(world.polls).toBe(1)
  expect(world.log).toEqual(['show q1', 'clear'])
})

test('holdQuestion queues behind another question with no deadline, then times out at once when its deadline passed', async () => {
  const { world, hold } = worldOf(poll => {
    if (poll === 3) {
      world.time += 10_000
      world.waiting.current = undefined
    }
  })
  world.waiting.current = { id: 'earlier', choice: null }

  expect(await hold()).toBe('timeout')
  // Three queue polls (the clock was never read for them), no answer poll after the queue.
  expect(world.polls).toBe(3)
  expect(world.log).toEqual(['show q1', 'clear'])
})

test('holdQuestion queued behind another question aborts without touching its band', async () => {
  const { world, hold } = worldOf(poll => {
    if (poll === 2) {
      world.signal.aborted = true
    }
  })
  const earlier = { id: 'earlier', choice: null }
  world.waiting.current = earlier

  expect(await hold()).toBe('aborted')
  expect(world.polls).toBe(2)
  expect(world.log).toEqual([])
  expect(world.waiting.current).toBe(earlier)
})

test('holdQuestion ends in aborted when the band fails, and still frees the queue', async () => {
  const { world, host } = worldOf()
  const failing: QuestionHost = { ...host, show: async () => { throw new Error('band failed') } }

  expect(await holdQuestion(failing, world.waiting, LIMIT, question, world.signal as AbortSignal)).toBe('aborted')
  expect(world.waiting.current).toBeUndefined()
})
