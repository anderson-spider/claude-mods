// JSON-RPC over the stdio of `codex app-server`, one JSON object per line. The
// server sends three kinds of message: a response to one of our requests (id, no
// method), a notification (method, no id) and a request of its own (id and method)
// that waits for our answer. When the child dies, every request still waiting fails
// at once instead of hanging until its timeout.
import { spawn as nodeSpawn } from 'node:child_process'

const CLIENT_INFO = { name: 'threads-helper', title: 'Threads helper', version: '0.1.0' }
const DEFAULT_TIMEOUT_MS = 60_000
const STARTUP_TIMEOUT_MS = 30_000
const STDERR_TAIL = 2000

// The server answered one of our requests with an error.
export class RpcError extends Error {
  constructor(method, error) {
    super(error?.message ?? `${method} failed`)
    this.name = 'RpcError'
    this.code = error?.code
  }
}

export class AppServerClient {
  constructor({
    command = 'codex',
    args = ['app-server'],
    spawn = nodeSpawn,
    clientInfo = CLIENT_INFO,
    startupTimeoutMs = STARTUP_TIMEOUT_MS,
  } = {}) {
    this.command = command
    this.args = args
    this.spawnChild = spawn
    this.clientInfo = clientInfo
    this.startupTimeoutMs = startupTimeoutMs
    this.pending = new Map()
    this.nextId = 0
    this.buffer = ''
    this.stderr = ''
    this.closed = false
    this.reason = undefined
    this.notificationHandlers = []
    this.requestHandlers = []
    this.exitHandlers = []
  }

  /** Spawns the child, runs `initialize` and then sends `initialized`. */
  async start() {
    this.child = this.spawnChild(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.#read(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL)
    })
    // A missing binary reports through 'error'; a write to a dead child through stdin.
    this.child.stdin.on('error', error => this.#fail(`could not write to codex app-server: ${error.message}`))
    this.child.on('error', error => this.#fail(`could not start codex app-server: ${error.message}`))
    this.child.on('exit', (code, signal) =>
      this.#fail(`codex app-server exited (${signal ?? `code ${code}`})${this.#stderrTail()}`),
    )

    try {
      const init = await this.request(
        'initialize',
        { clientInfo: this.clientInfo, capabilities: { experimentalApi: true } },
        this.startupTimeoutMs,
      )
      // The protocol expects this notification after initialize and before anything else.
      this.#send({ jsonrpc: '2.0', method: 'initialized', params: {} })

      return init
    } catch (error) {
      this.close()
      throw error
    }
  }

  request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.closed) {
      return Promise.reject(new Error(this.reason))
    }

    const id = ++this.nextId

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)

      this.pending.set(id, {
        method,
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.#send({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Answers a server request with a result. */
  respond(id, result) {
    this.#send({ jsonrpc: '2.0', id, result })
  }

  /** Answers a server request with a JSON-RPC error, so the server's turn can go on. */
  respondError(id, code, message) {
    this.#send({ jsonrpc: '2.0', id, error: { code, message } })
  }

  onNotification(handler) {
    this.notificationHandlers.push(handler)
  }

  // A handler must answer with respond or respondError. One that throws is answered
  // with an error here, because an unanswered request would hold the server's turn.
  onServerRequest(handler) {
    this.requestHandlers.push(handler)
  }

  onExit(handler) {
    this.exitHandlers.push(handler)
  }

  close() {
    this.#fail('closed by the helper')
    this.child?.kill('SIGTERM')
  }

  get isAlive() {
    return !this.closed
  }

  #stderrTail() {
    const text = this.stderr.trim()

    return text === '' ? '' : `: ${text}`
  }

  #send(message) {
    if (!this.closed) {
      this.child.stdin.write(`${JSON.stringify(message)}\n`)
    }
  }

  #fail(reason) {
    if (this.closed) {
      return
    }

    this.closed = true
    this.reason = reason
    const waiting = [...this.pending.values()]
    this.pending.clear()

    for (const slot of waiting) {
      slot.reject(new Error(reason))
    }

    for (const handler of this.exitHandlers) {
      this.#guard(() => handler(reason))
    }
  }

  #read(chunk) {
    this.buffer += chunk
    let end

    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)

      if (line === '') {
        continue
      }

      let message

      try {
        message = JSON.parse(line)
      } catch {
        // A line that is not JSON is not a message; the stream goes on.
        continue
      }

      this.#dispatch(message)
    }
  }

  #dispatch(message) {
    const { id, method } = message
    const params = message.params ?? {}

    if (typeof method === 'string' && id !== undefined) {
      return this.#serverRequest({ id, method, params })
    }

    if (typeof method === 'string') {
      for (const handler of this.notificationHandlers) {
        this.#guard(() => handler(method, params))
      }

      return
    }

    const slot = this.pending.get(id)

    if (slot === undefined) {
      return
    }

    this.pending.delete(id)

    if (message.error !== undefined) {
      slot.reject(new RpcError(slot.method, message.error))
    } else {
      slot.resolve(message.result)
    }
  }

  #serverRequest(request) {
    if (this.requestHandlers.length === 0) {
      this.respondError(request.id, -32601, `unsupported request: ${request.method}`)

      return
    }

    for (const handler of this.requestHandlers) {
      try {
        handler(request)
      } catch (error) {
        this.respondError(request.id, -32603, error instanceof Error ? error.message : String(error))
      }
    }
  }

  // One broken handler must not stop the others or the stream.
  #guard(call) {
    try {
      call()
    } catch {}
  }
}
