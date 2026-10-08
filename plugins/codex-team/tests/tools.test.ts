import { expect, test } from 'claude-code/testing'
import { startJob, startLoop } from '../hooks/tools'
import type { Book, LoopDeps } from '../hooks/model'

const book = { start: async () => { throw new Error('must not start') } } as unknown as Pick<Book, 'start'>
const publish = async () => {}

test('execute and review refuse an engine whose executable is missing, and Codex when nothing is said', async () => {
  const claude = await startJob({ book, absent: ['claude'] }, 'execute', { task: 't', engine: 'claude' }, publish)
  expect(claude).toEqual({ result: 'claude is not installed or not in PATH: Claude cannot run here.', isError: true })
  const codex = await startJob({ book, absent: ['codex'] }, 'review', {}, publish)
  expect(codex).toEqual({ result: 'codex is not installed or not in PATH: Codex cannot run here.', isError: true })
})

test('a loop refuses a missing engine for either role, the default one included', async () => {
  const loopDeps = {} as LoopDeps
  const qa = await startLoop({ book: book as Book, loopDeps, absent: ['claude'] }, { task: 't', qaEngine: 'claude' }, () => {}, publish)
  expect(qa).toEqual({ result: 'claude is not installed or not in PATH: Claude cannot run here.', isError: true })
  const dev = await startLoop({ book: book as Book, loopDeps, absent: ['codex'] }, { task: 't', qaEngine: 'claude' }, () => {}, publish)
  expect(dev).toEqual({ result: 'codex is not installed or not in PATH: Codex cannot run here.', isError: true })
})

test('an engine that is present starts the job', async () => {
  const started: string[] = []
  const live = { start: async (request: { engine?: string }) => { started.push(request.engine ?? 'codex'); return { agent: 'ct-1' } } } as unknown as Pick<Book, 'start'>
  const answer = await startJob({ book: live, absent: ['codex'] }, 'execute', { task: 't', engine: 'claude' }, publish)
  expect(answer.isError).toBeUndefined()
  expect(started).toEqual(['claude'])
})
