// A JSON-RPC client for `codex app-server` over a child's stdio (one JSON object per line). The child is injected:
// `{ stdin, stdout, kill, onExit(fn) }`, so tests drive a fake server without a process.

export class RpcClient {
  #child
  #nextId = 1
  #pending = new Map()
  #buffer = ''
  #closed = false
  #listeners = { notification: () => {}, request: () => undefined, exit: () => {} }
  #timeoutMs

  /** `timeoutMs`: how long a request waits for its response; a server that goes silent rejects it instead of holding it. */
  constructor(child, { timeoutMs = 30_000 } = {}) {
    this.#child = child
    this.#timeoutMs = timeoutMs
    child.stdout.on('data', chunk => this.#read(String(chunk)))
    child.onExit(() => this.#ended(new Error('the Codex app-server exited')))
  }

  get closed() {
    return this.#closed
  }

  /** `fn(method, params)` for each notification; `serve(fn)`: `fn(method, params)` answers a server request (undefined refuses). */
  onNotification(fn) {
    this.#listeners.notification = fn
  }

  serve(fn) {
    this.#listeners.request = fn
  }

  onExit(fn) {
    this.#listeners.exit = fn
  }

  request(method, params) {
    if (this.#closed) {
      return Promise.reject(new Error('the Codex app-server is not running'))
    }

    const id = this.#nextId++

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method}: the Codex app-server did not answer in ${Math.round(this.#timeoutMs / 1000)} s`))
      }, this.#timeoutMs)
      timer.unref?.()
      this.#pending.set(id, {
        resolve: value => (clearTimeout(timer), resolve(value)),
        reject: error => (clearTimeout(timer), reject(error)),
        method,
      })
      this.#send(params === undefined ? { id, method } : { id, method, params })
    })
  }

  notify(method, params) {
    this.#send(params === undefined ? { method } : { method, params })
  }

  /** Ends the server the way it expects: stdin closes, and a server that stays is killed. */
  close() {
    if (this.#closed) {
      return
    }

    try {
      this.#child.stdin.end()
    } catch {}

    setTimeout(() => this.#closed || this.#child.kill(), 3000).unref?.()
  }

  #send(message) {
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      // A server that is gone answers through its exit, which rejects what is pending.
    }
  }

  #read(text) {
    this.#buffer += text
    let at

    while ((at = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, at)
      this.#buffer = this.#buffer.slice(at + 1)

      if (line.trim() !== '') {
        this.#message(line)
      }
    }
  }

  #message(line) {
    let message

    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    if (message === null || typeof message !== 'object') {
      return
    }

    if (message.id !== undefined && typeof message.method === 'string') {
      const result = this.#listeners.request(message.method, message.params)

      this.#send(
        result === undefined
          ? { id: message.id, error: { code: -32601, message: `crew: ${message.method} is not served` } }
          : { id: message.id, result },
      )

      return
    }

    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id)

      if (entry !== undefined) {
        this.#pending.delete(message.id)

        if (message.error) {
          entry.reject(new Error(`${entry.method}: ${message.error.message ?? 'failed'}`))
        } else {
          entry.resolve(message.result)
        }
      }

      return
    }

    if (typeof message.method === 'string') {
      this.#listeners.notification(message.method, message.params)
    }
  }

  #ended(error) {
    if (this.#closed) {
      return
    }

    this.#closed = true

    for (const entry of this.#pending.values()) {
      entry.reject(error)
    }

    this.#pending.clear()
    this.#listeners.exit()
  }
}
