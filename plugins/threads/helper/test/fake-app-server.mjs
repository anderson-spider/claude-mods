// A stand-in for `codex app-server` (newline-delimited JSON-RPC over stdio) that
// replays the notification sequence probed with codex-cli 0.161.0. The text of each
// turn's input picks the scenario, so one fake serves every test:
//   CRASH  the process exits right after answering turn/start
//   FAIL   the turn fails with an error
//   HOLD   the turn runs until turn/interrupt
//   SLOW   the turn completes by itself after 150 ms
//   INPUT  the turn asks for user input (a server request that is not an approval)
//   PERM   the turn asks for permissions (its reply is a permission grant)
//   ASK    the turn asks for approval (a server request) and waits for the answer
//   CANCEL like ASK, but the server then clears the request itself (serverRequest/resolved)
//          and the turn goes on until turn/interrupt
//   other  a full turn: a command, a commentary line, a final answer
// Test-only methods: fake/probe (did `initialized` arrive?), fake/silent (never
// answered), fake/exit (exits without answering). A reply to one of the fake's server
// requests comes back to the client as a fake/reply notification.
import { createInterface } from 'node:readline'

let initialized = false
let capabilities = null
let threadCount = 0
let turnCount = 0
let nextServerId = 9000
const running = new Map() // turnId -> threadId, for turns not yet completed
const asking = new Map() // server request id -> { threadId, turnId, text }

const write = (message, after) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`, after)
const notify = (method, params) => write({ method, params })
const answer = (id, result) => write({ id, result })

const finish = (threadId, turnId, status, text, error = null) => {
  running.delete(turnId)
  const items = text === undefined ? [] : [{ type: 'agentMessage', id: `msg-${turnId}`, text, phase: 'final_answer' }]

  for (const item of items) {
    notify('item/completed', { threadId, turnId, item })
  }

  notify('turn/completed', { threadId, turn: { id: turnId, status, items, error } })
  notify('thread/status/changed', { threadId, status: { type: 'idle', activeFlags: [] } })
}

const runTurn = (threadId, turnId, text) => {
  running.set(turnId, threadId)
  notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [], error: null } })
  notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } })
  notify('item/completed', {
    threadId,
    turnId,
    item: { type: 'userMessage', id: `user-${turnId}`, content: [{ type: 'text', text, text_elements: [] }] },
  })

  if (text.includes('FAIL')) {
    return finish(threadId, turnId, 'failed', undefined, { message: 'model unavailable' })
  }

  if (text.includes('HOLD')) {
    return
  }

  if (text.includes('SLOW')) {
    return setTimeout(() => {
      if (running.has(turnId)) {
        finish(threadId, turnId, 'completed', `answer to: ${text}`)
      }
    }, 150)
  }

  if (text.includes('INPUT') || text.includes('PERM')) {
    const id = nextServerId++
    asking.set(id, { threadId, turnId, text })

    return write({
      id,
      method: text.includes('INPUT') ? 'item/tool/requestUserInput' : 'item/permissions/requestApproval',
      params: { threadId, turnId, itemId: `ask-${turnId}`, cwd: '/tmp/project', permissions: { network: { enabled: true } } },
    })
  }

  if (text.includes('ASK') || text.includes('CANCEL')) {
    const id = nextServerId++
    asking.set(id, { threadId, turnId, text })

    if (text.includes('CANCEL')) {
      setTimeout(() => {
        asking.delete(id)
        notify('serverRequest/resolved', { threadId, requestId: id })
      }, 100)
    }

    return write({
      id,
      method: 'item/commandExecution/requestApproval',
      params: { threadId, turnId, itemId: `cmd-${turnId}`, command: 'rm -rf build', reason: 'clean up' },
    })
  }

  notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: `cmd-${turnId}`, command: 'ls', status: 'inProgress' } })
  notify('item/agentMessage/delta', { threadId, turnId, itemId: `msg-c-${turnId}`, delta: 'Checking' })
  notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: `cmd-${turnId}`, command: 'ls', status: 'completed' } })
  notify('item/completed', {
    threadId,
    turnId,
    item: { type: 'agentMessage', id: `msg-c-${turnId}`, text: 'Checking.', phase: 'commentary' },
  })
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: {} })
  finish(threadId, turnId, 'completed', `answer to: ${text}`)
}

const handle = message => {
  // A reply to one of our server requests: no method, only the id.
  if (message.method === undefined) {
    const waiting = asking.get(message.id)

    if (waiting === undefined) {
      return
    }

    asking.delete(message.id)
    notify('fake/reply', {
      threadId: waiting.threadId,
      turnId: waiting.turnId,
      id: message.id,
      result: message.result ?? null,
      error: message.error ?? null,
    })

    if (message.result !== undefined) {
      finish(waiting.threadId, waiting.turnId, 'completed', `approved: ${waiting.text}`)
    }

    return
  }

  const { id, method } = message
  const params = message.params ?? {}

  switch (method) {
    case 'initialized':
      initialized = true
      return
    case 'initialize':
      capabilities = params.capabilities ?? null

      return answer(id, { userAgent: 'fake-codex/0.0', codexHome: '/nowhere', platformFamily: 'unix', platformOs: 'macos' })
    case 'thread/start': {
      threadCount += 1
      const threadId = `thr_${threadCount}`
      answer(id, { thread: { id: threadId, cwd: params.cwd, model: params.model ?? 'fake-model', ephemeral: false } })

      return notify('thread/started', { thread: { id: threadId } })
    }
    case 'turn/start': {
      turnCount += 1
      const turnId = `turn_${turnCount}`
      const text = params.input?.[0]?.text ?? ''

      if (text.includes('CRASH')) {
        return write({ id, result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } } }, () => process.exit(3))
      }

      answer(id, { turn: { id: turnId, status: 'inProgress', items: [], error: null } })

      return runTurn(params.threadId, turnId, text)
    }
    case 'turn/interrupt':
      answer(id, {})

      if (running.has(params.turnId)) {
        finish(params.threadId, params.turnId, 'interrupted')
      }

      return
    case 'fake/probe':
      return answer(id, { initialized, capabilities })
    case 'fake/silent':
      return
    case 'fake/exit':
      return process.exit(0)
    default:
      if (id !== undefined) {
        write({ id, error: { code: -32601, message: `unknown method ${method}` } })
      }
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === '') {
    return
  }

  let message

  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  handle(message)
})
