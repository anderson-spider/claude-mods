// The helper's routes over its Unix socket: POST with a JSON body for the thread
// actions, GET /status for the list. A bad body is a 400, an unknown thread a 404,
// a refused turn or approval a 409, and an app-server failure a 502. Nothing thrown
// escapes the handler, so the caller always gets a JSON reply.
import { isAbsolute } from 'node:path'

import { RpcError } from './app-server-client.mjs'
import { ThreadError } from './threads.mjs'

const MAX_BODY = 1_000_000
const MAX_TEXT = 200_000
const SANDBOX = ['read-only', 'workspace-write']
const APPROVAL = ['untrusted', 'on-request', 'never']
const DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel']
const ACTIONS = new Set(['/start', '/send', '/interrupt', '/read', '/approve', '/close'])

class BadRequest extends Error {
  constructor(message) {
    super(message)
    this.name = 'BadRequest'
  }
}

const messageOf = error => (error instanceof Error ? error.message : String(error))

const statusOf = error => {
  if (error instanceof BadRequest) {
    return 400
  }

  if (error instanceof ThreadError) {
    return error.status
  }

  if (error instanceof RpcError) {
    return 502
  }

  return 500
}

const readBody = request =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', chunk => {
      size += chunk.length

      if (size > MAX_BODY) {
        reject(new BadRequest('request too large'))
        request.destroy()
      } else {
        chunks.push(chunk)
      }
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

const parseBody = raw => {
  let body

  try {
    body = JSON.parse(raw || '{}')
  } catch {
    throw new BadRequest('body must be JSON')
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequest('body must be a JSON object')
  }

  return body
}

const text = (value, name, max = MAX_TEXT) => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new BadRequest(`${name} must be a non-empty string`)
  }

  return value
}

const optionalText = (value, name, max) => (value === undefined ? undefined : text(value, name, max))

const oneOf = (value, options, name) => {
  if (!options.includes(value)) {
    throw new BadRequest(`${name} must be one of ${options.join(', ')}`)
  }

  return value
}

const cwdOf = value => {
  const cwd = text(value, 'cwd', 4096)

  if (!isAbsolute(cwd)) {
    throw new BadRequest('cwd must be an absolute path')
  }

  return cwd
}

const threadIdOf = body => text(body.threadId, 'threadId', 200)

const act = async (path, body, threads) => {
  switch (path) {
    case '/start':
      return {
        status: 'ok',
        ...(await threads.start({
          cwd: cwdOf(body.cwd),
          task: text(body.task, 'task'),
          model: optionalText(body.model, 'model', 200),
          effort: optionalText(body.effort, 'effort', 50),
          sandbox: oneOf(body.sandbox, SANDBOX, 'sandbox'),
          approval: oneOf(body.approval, APPROVAL, 'approval'),
        })),
      }
    case '/send': {
      if (body.queue !== undefined && typeof body.queue !== 'boolean') {
        throw new BadRequest('queue must be true or false')
      }

      return {
        status: 'ok',
        ...(await threads.send({ threadId: threadIdOf(body), text: text(body.text, 'text'), queue: body.queue ?? false })),
      }
    }
    case '/interrupt':
      return { status: 'ok', ...(await threads.interrupt({ threadId: threadIdOf(body) })) }
    case '/read':
      return { status: 'ok', ...threads.read(threadIdOf(body)) }
    case '/approve':
      return {
        status: 'ok',
        ...(await threads.approve({ threadId: threadIdOf(body), decision: oneOf(body.decision, DECISIONS, 'decision') })),
      }
    case '/close':
      return { status: 'ok', ...(await threads.close({ threadId: threadIdOf(body) })) }
    default:
      throw new BadRequest(`unknown route ${path}`)
  }
}

/** The request handler for the helper's socket server; `threads` is a Threads. */
export const handler = ({ threads, log = () => {}, version = '' }) => async (request, response) => {
  const reply = (status, body) => {
    if (response.headersSent) {
      return
    }

    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }

  try {
    const { pathname } = new URL(request.url ?? '/', 'http://helper')

    if (pathname === '/status') {
      if (request.method !== 'GET') {
        return reply(405, { status: 'error', message: 'GET only' })
      }

      return reply(200, { status: 'ok', pid: process.pid, version, threads: threads.list() })
    }

    if (!ACTIONS.has(pathname)) {
      return reply(404, { status: 'error', message: `unknown route ${pathname}` })
    }

    if (request.method !== 'POST') {
      return reply(405, { status: 'error', message: 'POST only' })
    }

    const body = parseBody(await readBody(request))

    return reply(200, await act(pathname, body, threads))
  } catch (error) {
    const status = statusOf(error)

    if (status >= 500) {
      log(`${request.url}: ${messageOf(error)}`)
    }

    const failure = { status: 'error', message: messageOf(error) }

    if (error instanceof ThreadError) {
      failure.code = error.code
    }

    return reply(status, failure)
  }
}
