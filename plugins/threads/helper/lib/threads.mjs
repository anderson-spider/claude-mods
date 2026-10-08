// The state of each Codex thread, driven only by what app-server pushes. The helper
// never polls for status, so a thread's status is whatever the last notification
// said. Notifications for a thread the helper does not track (or has closed) are
// dropped.
export const STATUSES = ['starting', 'working', 'idle', 'needs-you', 'exited', 'failed']

const ACTIVITY_LIMIT = 20
const LINE_LIMIT = 200
const TOOL_ITEMS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'])
// Chatter the state does not depend on: startup and account status, hooks, token
// counts, and the streamed deltas whose final item comes in full anyway.
const NOISE = new Set([
  'mcpServer/startupStatus/updated',
  'hook/started',
  'hook/completed',
  'remoteControl/status/changed',
  'account/updated',
  'item/agentMessage/delta',
  'thread/tokenUsage/updated',
  'account/rateLimits/updated',
])
// JSON-RPC errors for server requests the helper cannot pass on: the server must get
// a reply, or its turn waits forever.
const NOT_ANSWERED = -32000
// The server requests that are an approval the person can give. Anything else (user
// input, MCP elicitation, dynamic tool calls) cannot be answered here and is refused.
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'])
const PERMISSIONS = 'item/permissions/requestApproval'
const ALREADY_WAITING = -32001

/** A refused call; `status` is the HTTP status the route answers with. */
export class ThreadError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ThreadError'
    this.status = status
    this.code = code
  }
}

const oneLine = text => {
  const flat = String(text).replace(/\s+/g, ' ').trim()

  return flat.length > LINE_LIMIT ? `${flat.slice(0, LINE_LIMIT - 3)}...` : flat
}

const toolLine = item => {
  const detail = item.command ?? item.query ?? item.tool ?? (Array.isArray(item.changes) ? `${item.changes.length} change(s)` : '')

  return detail === '' ? item.type : `${item.type}: ${detail}`
}

// Permission requests are answered with the permissions granted, not a decision: all
// that were asked for, or none; "cancel" also interrupts, which the server does itself.
const replyFor = (pending, decision) => {
  if (pending.method !== PERMISSIONS) {
    return { decision }
  }

  const granted = decision === 'accept' || decision === 'acceptForSession'

  return { permissions: granted ? (pending.params?.permissions ?? {}) : {}, scope: decision === 'acceptForSession' ? 'session' : 'turn' }
}

const messageOf = error => (error instanceof Error ? error.message : String(error))

const newRecord = ({ threadId, cwd, model, effort, now }) => ({
  threadId,
  cwd,
  model: model ?? null,
  effort: effort ?? null,
  status: 'starting',
  turnId: null,
  turnActive: false,
  lastAnswer: null,
  answerItem: null,
  answerTurn: null,
  pendingApproval: null,
  error: null,
  updatedAt: now,
  queued: null,
  activity: [],
  // Turn ids already completed, so a late response does not reopen them.
  done: new Set(),
})

// What the routes and the state file show: no internal ids, and the queue as a flag.
const publicState = record => ({
  threadId: record.threadId,
  cwd: record.cwd,
  model: record.model,
  effort: record.effort,
  status: record.status,
  turnId: record.turnId,
  lastAnswer: record.lastAnswer,
  pendingApproval:
    record.pendingApproval === null
      ? null
      : { method: record.pendingApproval.method, params: record.pendingApproval.params, at: record.pendingApproval.at },
  error: record.error,
  updatedAt: record.updatedAt,
  queued: record.queued !== null,
})

export class Threads {
  #client
  #now
  #persist
  #log
  #threads = new Map()

  constructor({ client, now = Date.now, persist = () => {}, log = () => {} }) {
    this.#client = client
    this.#now = now
    this.#persist = persist
    this.#log = log
  }

  /** Subscribes to the client's notifications, server requests and exit. */
  attach() {
    this.#client.onNotification((method, params) => this.#notification(method, params))
    this.#client.onServerRequest(request => this.#serverRequest(request))
    this.#client.onExit(reason => this.#exited(reason))
  }

  list() {
    return [...this.#threads.values()].map(publicState)
  }

  read(threadId) {
    const record = this.#get(threadId)

    return { ...publicState(record), activity: [...record.activity] }
  }

  /** Starts a thread and its first turn. */
  async start({ cwd, task, model, effort, sandbox, approval }) {
    const params = { cwd, approvalPolicy: approval, sandbox, serviceName: 'threads', ephemeral: false }

    if (model !== undefined) {
      params.model = model
    }

    const { thread } = await this.#client.request('thread/start', params)
    const record = newRecord({ threadId: thread.id, cwd, model, effort, now: this.#now() })
    this.#threads.set(record.threadId, record)
    this.#line(record, 'user', task)
    await this.#turn(record, task)

    return { threadId: record.threadId }
  }

  /** Sends a message as a new turn; with `queue`, holds one message while a turn runs. */
  async send({ threadId, text, queue = false }) {
    const record = this.#get(threadId)

    if (record.status === 'exited') {
      throw new ThreadError(409, 'exited', 'the thread has exited')
    }

    if (record.turnActive || record.pendingApproval !== null) {
      if (!queue) {
        throw new ThreadError(409, 'busy', 'a turn is running; send with queue to hold one message')
      }

      if (record.queued !== null) {
        throw new ThreadError(409, 'busy', 'a message is already queued')
      }

      record.queued = text
      this.#touch(record)

      return { status: 'queued' }
    }

    this.#line(record, 'user', text)
    await this.#turn(record, text)

    return { status: 'sent', turnId: record.turnId }
  }

  async interrupt({ threadId }) {
    const record = this.#get(threadId)

    if (!record.turnActive || record.turnId === null) {
      throw new ThreadError(409, 'idle', 'no turn is running')
    }

    // An interrupted turn does not run the message held for it.
    record.queued = null
    this.#answerPending(record, 'the turn was interrupted before the approval was answered')
    await this.#client.request('turn/interrupt', { threadId, turnId: record.turnId })

    return { status: 'ok' }
  }

  /** Answers the approval the server is waiting for with the person's decision. */
  async approve({ threadId, decision }) {
    const record = this.#get(threadId)
    const pending = record.pendingApproval

    if (pending === null) {
      throw new ThreadError(409, 'no-approval', 'no approval is waiting')
    }

    record.pendingApproval = null
    this.#client.respond(pending.id, replyFor(pending, decision))
    record.status = record.turnActive ? 'working' : 'idle'
    this.#line(record, 'approval', `${decision}: ${pending.method}`)

    return { status: 'ok' }
  }

  /** Stops tracking the thread; it is not archived in Codex. */
  async close({ threadId }) {
    const record = this.#get(threadId)
    this.#answerPending(record, 'the thread was closed before the approval was answered')
    this.#threads.delete(threadId)
    this.#save()

    return { status: 'ok' }
  }

  #get(threadId) {
    const record = this.#threads.get(threadId)

    if (record === undefined) {
      throw new ThreadError(404, 'unknown', `no tracked thread ${threadId}`)
    }

    return record
  }

  // Opens a turn. The turn counts as running from the moment it is requested, so a
  // second message sent before the reply is refused as busy.
  async #turn(record, text) {
    const params = { threadId: record.threadId, input: [{ type: 'text', text, text_elements: [] }] }

    if (record.model !== null) {
      params.model = record.model
    }

    if (record.effort !== null) {
      params.effort = record.effort
    }

    record.turnActive = true
    record.error = null

    if (record.pendingApproval === null) {
      record.status = 'working'
    }

    this.#touch(record)
    let result

    try {
      result = await this.#client.request('turn/start', params)
    } catch (error) {
      record.turnActive = false

      if (record.status !== 'exited') {
        record.status = 'failed'
        record.error = messageOf(error)
      }

      this.#touch(record)
      throw error
    }

    // The child may have died while the request was in flight.
    if (record.status === 'exited') {
      return
    }

    const { turn } = result

    if (!record.done.has(turn.id)) {
      record.turnId = turn.id
    }

    this.#touch(record)
  }

  #notification(method, params) {
    if (NOISE.has(method)) {
      return
    }

    const record = this.#threads.get(params?.threadId)

    if (record === undefined) {
      return
    }

    switch (method) {
      case 'turn/started':
        return this.#turnStarted(record, params.turn?.id)
      case 'turn/completed':
        return this.#turnCompleted(record, params.turn ?? {})
      case 'thread/status/changed':
        return this.#statusChanged(record, params.status?.type)
      case 'item/completed':
        return this.#itemCompleted(record, params.item)
      case 'serverRequest/resolved':
        return this.#requestResolved(record, params.requestId)
      default:
        return
    }
  }

  #turnStarted(record, turnId) {
    if (turnId === undefined || record.done.has(turnId)) {
      return
    }

    record.turnId = turnId
    record.turnActive = true

    if (record.pendingApproval === null) {
      record.status = 'working'
    }

    this.#touch(record)
  }

  #turnCompleted(record, turn) {
    if (turn.id !== undefined) {
      if (record.done.has(turn.id)) {
        return
      }

      record.done.add(turn.id)
    }

    record.turnActive = false

    for (const item of turn.items ?? []) {
      this.#captureAnswer(record, item)
    }

    // Some providers never set a phase: then the last agent message is the answer.
    if (turn.status === 'completed' && record.answerTurn !== turn.id) {
      const last = [...(turn.items ?? [])].reverse().find(item => item?.type === 'agentMessage' && item.phase == null)

      if (last !== undefined) {
        this.#captureAnswer(record, { ...last, phase: 'final_answer' })
      }
    }

    this.#answerPending(record, 'the turn ended before the approval was answered')

    if (turn.status === 'failed') {
      record.status = 'failed'
      record.error = turn.error?.message ?? 'the turn failed'
      this.#line(record, 'error', record.error)
    } else if (record.status !== 'exited') {
      record.status = 'idle'
      record.error = null
    }

    // The held message goes out as soon as the turn ends, whatever its outcome.
    if (record.queued !== null) {
      const next = record.queued
      record.queued = null
      this.#line(record, 'user', next)
      this.#turn(record, next).catch(() => {})

      return
    }

    this.#touch(record)
  }

  #statusChanged(record, type) {
    if (record.pendingApproval !== null || record.status === 'exited') {
      return
    }

    if (type === 'systemError') {
      record.status = 'failed'
      record.error = 'the thread reported a system error'
      this.#touch(record)
    } else if (type === 'idle' && record.status === 'working' && !record.turnActive) {
      record.status = 'idle'
      this.#touch(record)
    }
  }

  #itemCompleted(record, item) {
    if (item?.type === 'agentMessage') {
      return this.#captureAnswer(record, item)
    }

    if (TOOL_ITEMS.has(item?.type)) {
      this.#line(record, 'tool', toolLine(item))
    }
  }

  // The answer to a turn is the agent message marked final_answer; commentary lines
  // between tool calls are not answers.
  #captureAnswer(record, item) {
    if (item?.type !== 'agentMessage' || item.phase !== 'final_answer') {
      return
    }

    const text = item.text

    if (typeof text !== 'string' || text.trim() === '') {
      return
    }

    // The same item arrives once in item/completed and again in turn/completed.
    if (item.id !== undefined && record.answerItem === item.id) {
      return
    }

    record.answerItem = item.id ?? null
    record.answerTurn = record.turnId
    record.lastAnswer = { text, at: this.#now() }
    this.#line(record, 'answer', text)
  }

  // A server request is an approval the person must give. It is only held while a
  // turn runs; otherwise it is refused at once, so nothing waits on a dead turn.
  #serverRequest({ id, method, params }) {
    const record = this.#threads.get(params?.threadId)

    if (record === undefined) {
      this.#client.respondError(id, NOT_ANSWERED, `no tracked thread for ${method}`)

      return
    }

    if (!APPROVALS.has(method)) {
      this.#client.respondError(id, NOT_ANSWERED, `${method} cannot be answered by the threads helper`)

      return
    }

    if (!record.turnActive) {
      this.#client.respondError(id, NOT_ANSWERED, 'no turn is running')

      return
    }

    if (record.pendingApproval !== null) {
      this.#client.respondError(id, ALREADY_WAITING, 'another request is already waiting for an answer')

      return
    }

    record.pendingApproval = { id, method, params, at: this.#now() }
    record.status = 'needs-you'
    this.#line(record, 'approval', `asks: ${method}`)
  }

  // The server cleared a request without us (answered elsewhere, or cancelled while the turn
  // goes on). One we answered is already gone from the record, so only the waiting one matches.
  #requestResolved(record, requestId) {
    const pending = record.pendingApproval

    if (pending === null || String(pending.id) !== String(requestId)) {
      return
    }

    record.pendingApproval = null
    record.status = record.turnActive ? 'working' : 'idle'
    this.#line(record, 'approval', `resolved by the server: ${pending.method}`)
  }

  #answerPending(record, message) {
    const pending = record.pendingApproval

    if (pending === null) {
      return
    }

    record.pendingApproval = null
    this.#client.respondError(pending.id, NOT_ANSWERED, message)
    this.#line(record, 'approval', `not answered: ${message}`)
  }

  // The child is gone: nothing can be answered any more, so waiting approvals are
  // dropped and every thread is marked exited.
  #exited(reason) {
    for (const record of this.#threads.values()) {
      record.turnActive = false
      record.pendingApproval = null
      record.queued = null

      if (record.status !== 'exited') {
        record.status = 'exited'
        record.error = reason
      }
    }

    this.#save()
  }

  #line(record, kind, text) {
    record.activity.push({ at: this.#now(), kind, text: oneLine(text) })

    if (record.activity.length > ACTIVITY_LIMIT) {
      record.activity.splice(0, record.activity.length - ACTIVITY_LIMIT)
    }

    this.#touch(record)
  }

  #touch(record) {
    record.updatedAt = this.#now()
    this.#save()
  }

  #save() {
    const snapshot = [...this.#threads.values()].map(record => ({
      ...publicState(record),
      activity: [...record.activity],
    }))

    try {
      this.#persist(snapshot)
    } catch (error) {
      this.#log(`could not write thread state: ${messageOf(error)}`)
    }
  }
}
