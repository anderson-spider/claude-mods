import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Threads } from '../lib/threads.mjs'
import { fakeClient, waitFor } from './support.mjs'

const CWD = '/tmp/project'
const startInput = task => ({ cwd: CWD, task, sandbox: 'read-only', approval: 'on-request' })

// The statuses a thread went through, with repeats collapsed.
const statusesOf = (snapshots, threadId) =>
  snapshots
    .map(snapshot => snapshot.find(thread => thread.threadId === threadId)?.status)
    .filter(status => status !== undefined)
    .reduce((seen, status) => (seen.at(-1) === status ? seen : [...seen, status]), [])

const setup = async () => {
  const client = fakeClient()
  const replies = []
  const snapshots = []
  client.onNotification((method, params) => {
    if (method === 'fake/reply') {
      replies.push(params)
    }
  })
  const threads = new Threads({ client, persist: snapshot => snapshots.push(snapshot) })
  threads.attach()
  await client.start()

  return { client, threads, replies, snapshots }
}

test('a new thread runs its first turn: starting, working, idle, and the final answer is kept', async () => {
  const { threads, snapshots } = await setup()
  const { threadId } = await threads.start({ ...startInput('hello'), model: 'fake-model' })

  assert.equal(threadId, 'thr_1')
  await waitFor(() => threads.read(threadId).status === 'idle' && threads.read(threadId).lastAnswer)

  const state = threads.read(threadId)
  assert.equal(state.lastAnswer.text, 'answer to: hello')
  assert.equal(state.cwd, CWD)
  assert.equal(state.model, 'fake-model')
  // The commentary line is not the answer, and the streamed delta is not logged.
  assert.deepEqual(
    state.activity.map(line => line.kind),
    ['user', 'tool', 'answer'],
  )
  assert.equal(state.activity[1].text, 'commandExecution: ls')
  assert.deepEqual(statusesOf(snapshots, threadId), ['starting', 'working', 'idle'])
})

test('a turn that fails marks the thread failed with the error, and the next message runs', async () => {
  const { threads } = await setup()
  const { threadId } = await threads.start(startInput('FAIL now'))

  await waitFor(() => threads.read(threadId).status === 'failed')
  assert.equal(threads.read(threadId).error, 'model unavailable')

  await threads.send({ threadId, text: 'try again' })
  await waitFor(() => threads.read(threadId).status === 'idle' && threads.read(threadId).lastAnswer?.text === 'answer to: try again')
  assert.equal(threads.read(threadId).error, null)
})

test('a busy thread refuses a message unless queue holds one, and the held one runs at turn/completed', async () => {
  const { threads } = await setup()
  const { threadId } = await threads.start(startInput('SLOW first'))

  await assert.rejects(threads.send({ threadId, text: 'second' }), { status: 409, code: 'busy' })
  assert.deepEqual(await threads.send({ threadId, text: 'second', queue: true }), { status: 'queued' })
  await assert.rejects(threads.send({ threadId, text: 'third', queue: true }), { status: 409, code: 'busy' })
  assert.equal(threads.list()[0].queued, true)

  await waitFor(() => threads.read(threadId).status === 'idle' && threads.read(threadId).lastAnswer?.text === 'answer to: second')

  const state = threads.read(threadId)
  assert.equal(state.turnId, 'turn_2')
  assert.equal(state.queued, false)
  assert.ok(state.activity.some(line => line.kind === 'user' && line.text === 'second'))
})

test('interrupt stops a running turn, and interrupting an idle thread is refused', async () => {
  const { threads } = await setup()
  const { threadId } = await threads.start(startInput('HOLD'))

  await waitFor(() => threads.read(threadId).status === 'working')
  assert.deepEqual(await threads.interrupt({ threadId }), { status: 'ok' })
  await waitFor(() => threads.read(threadId).status === 'idle')
  assert.equal(threads.read(threadId).lastAnswer, null)

  await assert.rejects(threads.interrupt({ threadId }), { status: 409, code: 'idle' })
  await threads.send({ threadId, text: 'after' })
  await waitFor(() => threads.read(threadId).lastAnswer?.text === 'answer to: after')
})

test('an approval puts the thread in needs-you; approve answers it and the turn goes on', async () => {
  const { threads, replies } = await setup()
  const { threadId } = await threads.start(startInput('ASK first'))

  await waitFor(() => threads.read(threadId).status === 'needs-you')
  const pending = threads.read(threadId).pendingApproval
  assert.equal(pending.method, 'item/commandExecution/requestApproval')
  assert.equal(pending.params.command, 'rm -rf build')
  await assert.rejects(threads.send({ threadId, text: 'meanwhile' }), { status: 409, code: 'busy' })

  assert.deepEqual(await threads.approve({ threadId, decision: 'accept' }), { status: 'ok' })
  await waitFor(() => replies.length === 1 && threads.read(threadId).status === 'idle')

  assert.deepEqual(replies[0].result, { decision: 'accept' })
  assert.equal(threads.read(threadId).lastAnswer.text, 'approved: ASK first')
  assert.equal(threads.read(threadId).pendingApproval, null)
  await assert.rejects(threads.approve({ threadId, decision: 'accept' }), { status: 409, code: 'no-approval' })
})

test('a turn that ends with its approval unanswered gets a JSON-RPC error, never a hang', async () => {
  const { threads, replies } = await setup()
  const { threadId } = await threads.start(startInput('ASK again'))

  await waitFor(() => threads.read(threadId).status === 'needs-you')
  await threads.interrupt({ threadId })

  await waitFor(() => replies.length === 1)
  assert.equal(replies[0].error.code, -32000)
  await waitFor(() => threads.read(threadId).status === 'idle')
  assert.equal(threads.read(threadId).pendingApproval, null)
})

test('when the app-server exits, its threads are marked exited and refuse messages', async () => {
  const { threads, snapshots } = await setup()

  // The turn is answered and then the child exits, so start may resolve or reject.
  await threads.start(startInput('CRASH now')).catch(() => {})
  const threadId = threads.list()[0].threadId

  await waitFor(() => threads.read(threadId).status === 'exited')
  assert.match(threads.read(threadId).error, /codex app-server exited/)
  await assert.rejects(threads.send({ threadId, text: 'hello?' }), { status: 409, code: 'exited' })
  assert.equal(snapshots.at(-1)[0].status, 'exited')
})

test('close stops tracking the thread and answers its waiting approval with an error', async () => {
  const { threads, replies, snapshots } = await setup()
  const { threadId } = await threads.start(startInput('ASK close'))

  await waitFor(() => threads.read(threadId).status === 'needs-you')
  assert.deepEqual(await threads.close({ threadId }), { status: 'ok' })

  await waitFor(() => replies.length === 1)
  assert.equal(replies[0].error.code, -32000)
  assert.throws(() => threads.read(threadId), { status: 404, code: 'unknown' })
  assert.deepEqual(threads.list(), [])
  assert.deepEqual(snapshots.at(-1), [])
})

test('a request that is not an approval is refused at once and never held', async () => {
  const { threads, replies } = await setup()
  const { threadId } = await threads.start(startInput('INPUT please'))

  await waitFor(() => replies.length === 1)
  assert.equal(replies[0].error.code, -32000)
  assert.match(replies[0].error.message, /cannot be answered/)
  assert.equal(threads.read(threadId).pendingApproval, null)
})

test('a permissions request is answered with the permissions granted, or none', async () => {
  const { threads, replies } = await setup()
  const first = await threads.start(startInput('PERM yes'))

  await waitFor(() => threads.read(first.threadId).status === 'needs-you')
  await threads.approve({ threadId: first.threadId, decision: 'acceptForSession' })
  await waitFor(() => replies.length === 1)
  assert.deepEqual(replies[0].result, { permissions: { network: { enabled: true } }, scope: 'session' })

  const second = await threads.start(startInput('PERM no'))

  await waitFor(() => threads.read(second.threadId).status === 'needs-you')
  await threads.approve({ threadId: second.threadId, decision: 'decline' })
  await waitFor(() => replies.length === 2)
  assert.deepEqual(replies[1].result, { permissions: {}, scope: 'turn' })
})
