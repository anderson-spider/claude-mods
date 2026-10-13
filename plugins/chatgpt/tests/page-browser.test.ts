import { expect, test } from 'claude-code/testing'
import { pollUntil } from '../hooks/page-browser'

// A clock that moves only when a check or a sleep says so.
function clockOf() {
  let time = 0
  return { now: () => time, advance: (ms: number) => (time += ms) }
}

test('pollUntil answers false when the check never holds, and never throws', async () => {
  const clock = clockOf()
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
    clock.advance(ms)
  }
  expect(await pollUntil(async () => false, sleep, 300, clock.now)).toBe(false)
  expect(sleeps).toEqual([250, 250])
  expect(await pollUntil(async () => Promise.reject(new Error('gone')), sleep, 0, clock.now)).toBe(false)
})

test('pollUntil is bounded by the wall clock, so a slow check does not stretch the timeout', async () => {
  const clock = clockOf()
  const sleeps: number[] = []
  let checks = 0
  // Each check takes 400 ms of wall-clock time; the 1 s budget ends the poll after two of them, with one sleep.
  const check = async () => {
    checks++
    clock.advance(400)
    return false
  }
  const sleep = async (ms: number) => {
    sleeps.push(ms)
    clock.advance(ms)
  }
  expect(await pollUntil(check, sleep, 1000, clock.now)).toBe(false)
  expect(checks).toBe(2)
  expect(sleeps).toEqual([250])
})

test('pollUntil answers true as soon as the check holds', async () => {
  const clock = clockOf()
  const answers = [false, false, true]
  let poll = 0
  const sleep = async (ms: number): Promise<void> => {
    clock.advance(ms)
  }
  expect(await pollUntil(async () => answers[Math.min(poll++, answers.length - 1)]!, sleep, 5000, clock.now)).toBe(true)
  expect(poll).toBe(3)
})
