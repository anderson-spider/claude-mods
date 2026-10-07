// A minimal MCP client over a child's stdio (newline-delimited JSON-RPC). It
// declares form elicitation so the server can ask for app approval, and hands
// each such request to `onElicit`, whose answer goes back verbatim.
import { spawn } from 'node:child_process'

import { VERSION } from './version.mjs'

const PROTOCOL = '2025-06-18'
const STDERR_TAIL = 2000

export class McpStdioClient {
  constructor({ command, args = [], env = process.env, onElicit, startupTimeoutMs = 120_000 }) {
    this.command = command
    this.args = args
    this.env = env
    this.onElicit = onElicit
    this.startupTimeoutMs = startupTimeoutMs
    this.pending = new Map()
    this.nextId = 0
    this.buffer = ''
    this.stderr = ''
    this.closed = false
  }

  async start() {
    this.child = spawn(this.command, this.args, { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.#read(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL)
    })
    this.child.on('error', error => this.#fail(`could not start the Codex server: ${error.message}`))
    this.child.on('exit', (code, signal) =>
      this.#fail(`the Codex server exited (${signal ?? `code ${code}`})${this.stderr ? `: ${this.stderr.trim()}` : ''}`),
    )

    const init = await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL,
        // Without form elicitation node_repl refuses `getApp`.
        capabilities: { elicitation: { form: {} } },
        clientInfo: { name: 'codex-cu-helper', version: VERSION },
      },
      this.startupTimeoutMs,
    )

    this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    this.serverInfo = init.serverInfo

    return init
  }

  /** Calls one tool; resolves the MCP result (`content`, `isError`, `_meta`). */
  callTool(name, args, timeoutMs) {
    return this.request('tools/call', { name, arguments: args }, timeoutMs)
  }

  request(method, params, timeoutMs = 60_000) {
    if (this.closed) {
      return Promise.reject(new Error(this.reason ?? 'the Codex server is closed'))
    }

    const id = ++this.nextId

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: value => (clearTimeout(timer), resolve(value)),
        reject: error => (clearTimeout(timer), reject(error)),
      })
      this.#send({ jsonrpc: '2.0', id, method, params })
    })
  }

  close() {
    if (!this.closed) {
      this.#fail('closed')
    }

    this.child?.kill('SIGTERM')
  }

  get isAlive() {
    return !this.closed
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

    for (const { reject } of this.pending.values()) {
      reject(new Error(reason))
    }

    this.pending.clear()
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
        continue
      }

      if (typeof message.method === 'string' && message.id !== undefined) {
        void this.#answer(message)
      } else if (message.id !== undefined && this.pending.has(message.id)) {
        const slot = this.pending.get(message.id)
        this.pending.delete(message.id)

        if (message.error !== undefined) {
          slot.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
        } else {
          slot.resolve(message.result)
        }
      }
    }
  }

  // Requests the server makes of us: approval questions, pings, roots.
  async #answer({ id, method, params }) {
    let result

    try {
      if (method === 'elicitation/create') {
        result = this.onElicit === undefined ? { action: 'decline' } : await this.onElicit(params ?? {})
      } else if (method === 'ping') {
        result = {}
      } else if (method === 'roots/list') {
        result = { roots: [] }
      } else {
        this.#send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported: ${method}` } })

        return
      }
    } catch {
      result = { action: 'decline' }
    }

    this.#send({ jsonrpc: '2.0', id, result })
  }
}
