// A fake `codex app-server` child for the helper tests: it answers requests from a table, records what it received and
// lets a test push notifications and server requests. No process, no Codex.
import { EventEmitter } from 'node:events'

export const fakeChild = ({ handlers = {}, autoComplete = false, text = 'done' } = {}) => {
  const stdout = new EventEmitter()
  const received = []
  const replies = []
  let exitFn = () => {}
  let counter = 0
  let ended = false
  const emit = message => stdout.emit('data', `${JSON.stringify(message)}\n`)

  const reply = message => {
    replies.push(message)
  }

  const respond = message => {
    const handler = handlers[message.method]
    const result = handler
      ? handler(message.params, message)
      : message.method === 'initialize'
        ? { codexHome: '/h' }
        : message.method === 'thread/start'
          ? { thread: { id: `th-${++counter}` } }
          : message.method === 'turn/start'
            ? { turn: { id: `tn-${++counter}` } }
            : {}

    if (result instanceof Error) {
      emit({ id: message.id, error: { message: result.message } })
      return
    }

    if (result === 'silent') {
      return
    }

    emit({ id: message.id, result })

    if (autoComplete && message.method === 'turn/start') {
      const threadId = message.params.threadId

      setImmediate(() => {
        emit({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', text } } })
        emit({ method: 'turn/completed', params: { threadId, turn: { id: `tn-x`, status: 'completed', error: null } } })
      })
    }
  }

  const child = {
    stdout,
    stdin: {
      write: line => {
        const message = JSON.parse(line)

        if (message.id !== undefined && message.method === undefined) {
          reply(message)
          return
        }

        received.push(message)

        if (message.id !== undefined) {
          setImmediate(() => respond(message))
        }
      },
      end: () => {
        ended = true
        setImmediate(() => exitFn())
      },
    },
    kill: () => exitFn(),
    onExit: fn => {
      exitFn = fn
    },
  }

  return {
    child,
    received,
    replies,
    emit,
    exit: () => exitFn(),
    get ended() {
      return ended
    },
    methods: () => received.map(message => message.method),
    params: method => received.filter(message => message.method === method).map(message => message.params),
  }
}

export const tick = () => new Promise(resolve => setImmediate(resolve))
export const until = async (predicate, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    if (predicate()) {
      return
    }

    await tick()
  }

  throw new Error('condition not reached')
}
