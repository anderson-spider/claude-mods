import { expect, test } from 'claude-code/testing'
import { createEffortBook } from '../hooks/effort'
import type { Listed } from '../hooks/effort'

const agent = (id: string, type = 'crew:developer', description = 'fix it'): Listed => ({ id, type, description })

test('an id bound after the spawn resolves keeps its effort', async () => {
  const book = createEffortBook()
  const token = book.add('crew:developer', 'fix it', 'high')
  book.bind(token, 'a1')
  let reads = 0
  expect(await book.lookup('a1', async () => (reads++, []))).toBe('high')
  expect(reads).toBe(0)
})

test('a step before the spawn resolves is matched on type and description, once', async () => {
  const book = createEffortBook()
  const token = book.add('crew:developer', 'fix it', 'low')
  let reads = 0
  const list = async () => (reads++, [agent('a1')])
  expect(await book.lookup('a1', list)).toBe('low')
  expect(await book.lookup('a1', list)).toBe('low')
  expect(reads).toBe(1)
  // The spawn then resolves: nothing is left to bind, the id keeps its effort.
  book.bind(token, 'a1')
  expect(await book.lookup('a1', list)).toBe('low')
})

test('an agent that is not listed at its first step keeps the default: its effort does not change mid-run', async () => {
  const book = createEffortBook()
  const token = book.add('crew:developer', 'fix it', 'low')
  expect(await book.lookup('a1', async () => [])).toBeUndefined()
  // Listed at the next step, and bound when the spawn resolves: a step has gone out, so the default stands.
  expect(await book.lookup('a1', async () => [agent('a1')])).toBeUndefined()
  book.bind(token, 'a1')
  expect(await book.lookup('a1', async () => [agent('a1')])).toBeUndefined()
})

test('another agent, or the main loop with nothing pending, is a miss that is not read again', async () => {
  const book = createEffortBook()
  let reads = 0
  const list = async () => (reads++, [agent('x1', 'general-purpose', 'search')])
  expect(await book.lookup('x1', list)).toBeUndefined()
  expect(reads).toBe(0)

  book.add('crew:developer', 'fix it', 'low')
  expect(await book.lookup('x2', async () => (reads++, [agent('x2', 'general-purpose', 'other')]))).toBeUndefined()
  expect(await book.lookup('x2', list)).toBeUndefined()
  expect(reads).toBe(1)
})

test('two calls alike with different efforts are not guessed: the stepped one keeps the default, the other is bound', async () => {
  const book = createEffortBook()
  const first = book.add('crew:developer', 'fix it', 'low')
  const second = book.add('crew:developer', 'fix it', 'high')
  expect(await book.lookup('a1', async () => [agent('a1'), agent('a2')])).toBeUndefined()
  book.bind(first, 'a1')
  book.bind(second, 'a2')
  expect(await book.lookup('a1', async () => [])).toBeUndefined()
  expect(await book.lookup('a2', async () => [])).toBe('high')
})

test('a step that took the entry of a call alike is corrected at bind: the routed id gets the effort, the other keeps its own', async () => {
  const book = createEffortBook()
  const token = book.add('crew:developer', 'fix it', 'low')
  // An unrouted agent of the same type and description steps first and is matched.
  expect(await book.lookup('other', async () => [agent('other')])).toBe('low')
  // The spawn resolves with the routed agent's id, which has not stepped.
  book.bind(token, 'routed')
  expect(await book.lookup('routed', async () => [])).toBe('low')
  // Stable: the first step's effort of the other agent is not taken back.
  expect(await book.lookup('other', async () => [])).toBe('low')
})

test('the entry matched by a step is not matched by a second agent', async () => {
  const book = createEffortBook()
  book.add('crew:developer', 'fix it', 'low')
  expect(await book.lookup('a1', async () => [agent('a1'), agent('a2')])).toBe('low')
  expect(await book.lookup('a2', async () => [agent('a1'), agent('a2')])).toBeUndefined()
})

test('the stepped ids are bounded, and an id that keeps stepping stays among them', async () => {
  const book = createEffortBook()
  book.add('crew:developer', 'fix it', 'low')
  // A listed agent that is not the entry's: recorded as stepped.
  const other = async () => [agent('keep', 'general-purpose', 'search')]
  expect(await book.lookup('keep', other)).toBeUndefined()
  for (let i = 0; i < 1000; i++) {
    await book.lookup(`x${i}`, async () => [agent(`x${i}`, 'general-purpose', 'search')])
    // Stepping again refreshes its place.
    if (i % 100 === 0) await book.lookup('keep', other)
  }
  let reads = 0
  expect(await book.lookup('keep', async () => (reads++, [agent('keep')]))).toBeUndefined()
  expect(reads).toBe(0)
  // The oldest were forgotten: a listing that matches now is read again.
  expect(await book.lookup('x0', async () => (reads++, [agent('x0')]))).toBe('low')
  expect(reads).toBe(1)
})

test('a routed id keeps its effort while it keeps stepping, however many entries come after', async () => {
  const book = createEffortBook()
  book.bind(book.add('crew:developer', 'long run', 'high'), 'long')
  for (let i = 0; i < 200; i++) {
    book.bind(book.add('crew:developer', `task ${i}`, 'low'), `n${i}`)
    if (i % 10 === 0) expect(await book.lookup('long', async () => [])).toBe('high')
  }
  expect(await book.lookup('long', async () => [])).toBe('high')
})

test('a routed id that steps after its entry was taken by an agent alike keeps the default, and bind says so', async () => {
  const book = createEffortBook()
  const token = book.add('crew:developer', 'fix it', 'low')
  // A listed agent alike with no entry of its own takes the entry.
  expect(await book.lookup('other', async () => [agent('other')])).toBe('low')
  // The routed id steps with every entry matched: its first step goes out on the default and that stands.
  expect(await book.lookup('routed', async () => [agent('other'), agent('routed')])).toBeUndefined()
  expect(book.bind(token, 'routed')).toBe('stepped')
  expect(await book.lookup('routed', async () => [])).toBeUndefined()
})

test('documented exception: with nothing pending a step is not recorded, so an agent alike with no entry can take a later entry on its next step', async () => {
  const book = createEffortBook()
  expect(await book.lookup('a1', async () => [agent('a1')])).toBeUndefined()
  book.add('crew:developer', 'fix it', 'low')
  expect(await book.lookup('a1', async () => [agent('a1')])).toBe('low')
})

test('a list that fails at the first step leaves the default for the run', async () => {
  const book = createEffortBook()
  const token = book.add('crew:developer', 'fix it', 'low')
  expect(await book.lookup('a1', async () => { throw new Error('no list') })).toBeUndefined()
  // The list works at the second step and names it: the effort does not arrive mid-run.
  expect(await book.lookup('a1', async () => [agent('a1')])).toBeUndefined()
  expect(book.bind(token, 'a1')).toBe('stepped')
  expect(await book.lookup('a1', async () => [agent('a1')])).toBeUndefined()
})

test('many unlisted ids stepping while an entry is pending do not push a routed id out of the record', async () => {
  const book = createEffortBook()
  const token = book.add('crew:developer', 'fix it', 'low')
  expect(await book.lookup('routed', async () => [])).toBeUndefined()
  for (let i = 0; i < 200; i++) await book.lookup(`wf${i}`, async () => [])
  expect(book.bind(token, 'routed')).toBe('stepped')
  expect(await book.lookup('routed', async () => [agent('routed')])).toBeUndefined()
})

test('calls alike with the same effort that crossed their entries are reported as matched', async () => {
  const book = createEffortBook()
  const t1 = book.add('crew:developer', 'fix it', 'low')
  const t2 = book.add('crew:developer', 'fix it', 'low')
  const both = async () => [agent('a1'), agent('a2')]
  // a2 steps first and takes the first entry, a1 then takes the second.
  expect(await book.lookup('a2', both)).toBe('low')
  expect(await book.lookup('a1', both)).toBe('low')
  expect(book.bind(t1, 'a1')).toBe('matched')
  expect(book.bind(t2, 'a2')).toBe('matched')
  expect(await book.lookup('a1', async () => [])).toBe('low')
  expect(await book.lookup('a2', async () => [])).toBe('low')
})

test('an entry that applies nothing blocks the ambiguity and is never applied', async () => {
  const book = createEffortBook()
  const plain = book.add('crew:developer', 'fix it', 'medium', undefined, false)
  const moved = book.add('crew:developer', 'fix it', 'low')
  const both = async () => [agent('a1'), agent('a2')]
  // Alike with different efforts: both stay on their defaults.
  expect(await book.lookup('a1', both)).toBeUndefined()
  expect(await book.lookup('a2', both)).toBeUndefined()
  expect(book.bind(plain, 'a1')).toBe('known')
  book.bind(moved, 'a2')

  // Alone, a default entry matches and still applies nothing.
  const solo = createEffortBook()
  const token = solo.add('crew:developer', 'fix it', 'medium', undefined, false)
  expect(await solo.lookup('b1', async () => [agent('b1')])).toBeUndefined()
  expect(solo.bind(token, 'b1')).toBe('known')
  expect(await solo.lookup('b1', async () => [])).toBeUndefined()
  // Bound without a step, it is not remembered either, and no later entry takes the id.
  const bound = solo.add('crew:developer', 'fix it', 'medium', undefined, false)
  solo.bind(bound, 'b2')
  solo.add('crew:developer', 'fix it', 'low')
  expect(await solo.lookup('b2', async () => [agent('b2')])).toBeUndefined()
})

test('documented exception: agents no list names (a workflow, a fork) are not recorded, so a later entry alike can still match them', async () => {
  const book = createEffortBook()
  // Nothing pending: not read, not recorded.
  for (let i = 0; i < 1000; i++) expect(await book.lookup(`wf${i}`, async () => [])).toBeUndefined()
  // With an entry pending they are read once each while the entry lives, then forgotten with it.
  const token = book.add('crew:developer', 'fix it', 'low')
  expect(await book.lookup('wf1', async () => [])).toBeUndefined()
  book.drop(token)
  // A later entry alike: the id is listed now and matches, because it was never recorded as stepped.
  book.add('crew:developer', 'fix it', 'high')
  expect(await book.lookup('wf1', async () => [agent('wf1')])).toBe('high')
})

test('a spawn that resolves with an id that stepped unlisted keeps its default and says so', async () => {
  const book = createEffortBook()
  const token = book.add('crew:developer', 'fix it', 'low')
  expect(await book.lookup('a1', async () => [])).toBeUndefined()
  expect(book.bind(token, 'a1')).toBe('stepped')
  // Decided for good: a later entry alike does not move it mid-run.
  book.add('crew:developer', 'fix it', 'high')
  expect(await book.lookup('a1', async () => [agent('a1')])).toBeUndefined()
})

test('bind says what happened to the effort', async () => {
  const book = createEffortBook()
  expect(book.bind(book.add('crew:developer', 'fix it', 'low'), 'a1')).toBe('applied')
  expect(book.bind(book.add('crew:developer', 'fix it', 'high'), 'a1')).toBe('known')
  const early = book.add('crew:developer', 'other', 'low')
  await book.lookup('b1', async () => [agent('b1', 'crew:developer', 'other')])
  expect(book.bind(early, 'b1')).toBe('matched')
  expect(book.bind(early, 'b1')).toBe('gone')
})

test('calls alike, one routed and one left on the default, do not swap: both stay on their defaults', async () => {
  const book = createEffortBook()
  // R was routed to low; U (unrouted: Jev failed or changed nothing) registers its own default, medium.
  const routed = book.add('crew:developer', 'fix tests', 'low')
  const unrouted = book.add('crew:developer', 'fix tests', 'medium')
  const both = async () => [agent('U', 'crew:developer', 'fix tests'), agent('R', 'crew:developer', 'fix tests')]
  // Both step before the spawns resolve.
  expect(await book.lookup('U', both)).toBeUndefined()
  expect(await book.lookup('R', both)).toBeUndefined()
  expect(book.bind(unrouted, 'U')).toBe('stepped')
  expect(book.bind(routed, 'R')).toBe('stepped')
  expect(await book.lookup('U', both)).toBeUndefined()
  expect(await book.lookup('R', both)).toBeUndefined()
})

test('an entry with a parent matches only an agent of that parent, when both are known', async () => {
  const book = createEffortBook()
  book.add('crew:developer', 'fix it', 'low', 'loop-1')
  const list = async () => [
    { ...agent('x'), parentId: 'loop-2' },
    { ...agent('y'), parentId: 'loop-1' },
    agent('z'),
  ]
  expect(await book.lookup('x', list)).toBeUndefined()
  expect(await book.lookup('y', list)).toBe('low')

  // No parent on either side: the match is by type and description alone.
  const plain = createEffortBook()
  plain.add('crew:developer', 'fix it', 'low')
  expect(await plain.lookup('x', async () => [{ ...agent('x'), parentId: 'loop-2' }])).toBe('low')
})

test('a refused or failed spawn leaves nothing to match', async () => {
  const book = createEffortBook()
  book.drop(book.add('crew:developer', 'fix it', 'low'))
  expect(await book.lookup('a1', async () => [agent('a1')])).toBeUndefined()
})

// A list read that is in flight while the spawn resolves: the first step and bind must agree.
const gate = () => {
  let open!: (v: Listed[]) => void
  const promise = new Promise<Listed[]>(resolve => (open = resolve))
  return { promise, open }
}

test('a bind that runs while the list is read is honored: the first step gets the effort, and bind says applied', async () => {
  const book = createEffortBook()
  const token = book.add('crew:developer', 'fix it', 'low')
  const g = gate()
  const first = book.lookup('a1', () => g.promise)
  // The spawn resolves with the id while the list is still being read.
  expect(book.bind(token, 'a1')).toBe('applied')
  // The list does not name the agent yet.
  g.open([])
  expect(await first).toBe('low')
  expect(await book.lookup('a1', async () => [])).toBe('low')
})

test('a bind during the list read of an agent the list names gives the first step the effort too', async () => {
  const book = createEffortBook()
  const token = book.add('crew:developer', 'fix it', 'high')
  const g = gate()
  const first = book.lookup('a1', () => g.promise)
  expect(book.bind(token, 'a1')).toBe('applied')
  g.open([agent('a1')])
  expect(await first).toBe('high')
  expect(await book.lookup('a1', async () => [])).toBe('high')
})

test('a step that decided the id during the list read is not undone by the later one', async () => {
  const book = createEffortBook()
  book.add('crew:developer', 'fix it', 'low')
  const g1 = gate()
  const g2 = gate()
  const one = book.lookup('a1', () => g1.promise)
  const two = book.lookup('a1', () => g2.promise)
  g1.open([agent('a1')])
  expect(await one).toBe('low')
  g2.open([])
  expect(await two).toBe('low')
})

test('an entry dropped during the list read leaves the step on the default and records nothing', async () => {
  const book = createEffortBook()
  const token = book.add('crew:developer', 'fix it', 'low')
  const g = gate()
  const first = book.lookup('a1', () => g.promise)
  book.drop(token)
  g.open([agent('a1')])
  expect(await first).toBeUndefined()
  book.add('crew:developer', 'fix it', 'high')
  expect(await book.lookup('a1', async () => [agent('a1')])).toBe('high')
})
