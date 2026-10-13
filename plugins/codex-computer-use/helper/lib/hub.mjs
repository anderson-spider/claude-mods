// The helper's core: one persistent Codex session per caller (a Claude session,
// or one of its subagents as `<session>/<agent>`), calls serialized per caller,
// app approvals asked of the person through the mod, and one owner per app.
import { parseRequest } from './approvals.mjs'
import { CODEX_APPROVALS, removeCodexApproval } from './codex-approvals.mjs'
import { namedApps, resolveBundleId, usedApp } from './apps.mjs'
import { Owners, isUnder } from './owners.mjs'

export const IDLE_MS = 15 * 60_000
// An app stays with the caller that used it until this long after that caller's last call;
// hooks/routing.ts `LEASE_MINUTES` tells the model the same, and helper/test/contract.mjs pins both.
export const LEASE_MS = 2 * 60_000
// At most this many Codex sessions run at once; the quietest idle one makes room.
export const MAX_SESSIONS = 8
const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 300_000
// The documented entry calls a fresh or reset Codex session must start with.
const ENTRY = /\bcua\.(getState|getApp|listApps|getTab|createBrowserTab|getBrowser)\s*\(/

/** True when `code` opens with one of the documented entry calls. */
export const isEntryCall = code => {
  const first = code
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '' && !line.startsWith('//'))

  return first !== undefined && ENTRY.test(first)
}

const DECLINE = () => ({ action: 'decline' })
const ACCEPT_SESSION = () => ({ action: 'accept', content: {}, _meta: { persist: 'session' } })

/**
 * What the hub does with each decision of `Approvals#decide`, in one row each:
 * - `slot`: the `ctx` slot a server question fills, which `#outcome` turns into the reply (`denied`, `needs`);
 * - `claims`: `#elicit` takes the app for the asking caller;
 * - `stops`: `#precheck` refuses a call that names the app;
 * - `claimsOnRun`: `#invoke` takes each named app before the run (so a denied app is claimed too);
 * - `answer(request)`: what the server is told; only allowing decisions accept.
 * A new decision kind is a branch of `Approvals#decide` and a row here.
 */
const DECISION_EFFECTS = new Map(
  Object.entries({
    deny: { slot: 'denied', claims: false, stops: true, claimsOnRun: true, answer: DECLINE },
    ask: { slot: 'needs', claims: false, stops: false, claimsOnRun: false, answer: DECLINE },
    session: { slot: undefined, claims: true, stops: false, claimsOnRun: true, answer: ACCEPT_SESSION },
    auto: { slot: undefined, claims: true, stops: false, claimsOnRun: true, answer: ACCEPT_SESSION },
    always: {
      slot: undefined,
      claims: true,
      stops: false,
      claimsOnRun: true,
      answer: request => ({ action: 'accept', content: {}, _meta: { persist: request.canAlways ? 'always' : 'session' } }),
    },
  }).map(([decision, effects]) => [decision, Object.freeze(effects)]),
)
/** The decisions that have a row, for the test that ties them to what `Approvals#decide` returns. */
export const DECISION_KINDS = Object.freeze([...DECISION_EFFECTS.keys()])
// A decision no row lists claims the app and declines the question, as before the table; failing closed is a separate change.
const UNLISTED = Object.freeze({ slot: undefined, claims: true, stops: false, claimsOnRun: true, answer: DECLINE })
const effectsOf = decision => DECISION_EFFECTS.get(decision) ?? UNLISTED

export class Hub {
  /**
   * @param createClient (onElicit) => an McpStdioClient-like object, not yet started
   * @param approvals an Approvals
   */
  constructor({
    createClient,
    approvals,
    owners = new Owners(),
    resolve = resolveBundleId,
    idleMs = IDLE_MS,
    leaseMs = LEASE_MS,
    maxSessions = MAX_SESSIONS,
    codexApprovals = CODEX_APPROVALS,
    now = Date.now,
  }) {
    this.createClient = createClient
    this.approvals = approvals
    this.owners = owners
    this.resolve = resolve
    this.idleMs = idleMs
    this.leaseMs = leaseMs
    this.maxSessions = maxSessions
    this.codexApprovals = codexApprovals
    this.now = now
    this.sessions = new Map()
    this.aliases = new Map()
  }

  /** Runs `code` in the caller's Codex session, after the calls it queued before. */
  call(caller, input) {
    const session = this.#session(caller)
    const run = session.queue.then(() => this.#run(caller, session, input))
    session.queue = run.catch(() => undefined)

    return run
  }

  /** The person's answer to an approval question: `session`, `always` or `deny`. */
  approve(caller, bundleId, choice) {
    this.approvals.record(caller, bundleId, choice)

    if (choice === 'deny' && this.owners.ownerOf(bundleId) === caller) {
      this.owners.drop(bundleId)
    }
  }

  /**
   * Takes `app` (a name, path or bundle id) off "always allow": the helper's list and
   * Codex's own ComputerUseAppApprovals.json. Running Codex sessions are restarted on
   * their next call, so none keeps an approval it read before.
   */
  async forget(app) {
    const bundleId = typeof app === 'string' && app.trim() !== '' ? await this.resolve(app.trim(), this.aliases) : undefined

    if (bundleId === undefined) {
      return { status: 'error', message: `no app found for "${app}"; give its name as Finder shows it, or its bundle id.` }
    }

    const helper = this.approvals.unalways(bundleId)
    let codex

    try {
      codex = removeCodexApproval(bundleId, this.codexApprovals)
    } catch (error) {
      return { status: 'error', bundleId, helper, message: error instanceof Error ? error.message : String(error) }
    }

    if (codex === 'removed') {
      for (const session of this.sessions.values()) {
        session.client?.close()
      }
    }

    return { status: 'ok', bundleId, helper, codex }
  }

  /** Discards the caller's JavaScript session and frees its apps; its approvals stay. */
  async reset(caller) {
    const session = this.sessions.get(caller)
    this.owners.release(caller)

    if (session === undefined) {
      return { status: 'ok', message: 'No Codex session to reset.' }
    }

    await session.queue
    this.#end(caller, session)

    return { status: 'ok', message: 'Codex session reset; the next call must be an entry call.' }
  }

  /** Ends every caller under `prefix` (a closing Claude session and its subagents). */
  release(prefix) {
    const ended = []

    for (const [caller, session] of [...this.sessions]) {
      if (isUnder(prefix, caller)) {
        this.#end(caller, session)
        ended.push(caller)
      }
    }

    this.owners.releasePrefix(prefix)

    this.approvals.forget(prefix)

    return { status: 'ok', ended }
  }

  /** Ends sessions idle for longer than `idleMs`, freeing their apps. */
  sweep() {
    const now = this.now()

    for (const [caller, session] of [...this.sessions]) {
      if (session.running === 0 && now - session.lastUsed > this.idleMs) {
        this.#evict(caller, session)
      }
    }
  }

  status() {
    const now = this.now()

    return {
      callers: [...this.sessions].map(([caller, session]) => ({
        caller,
        apps: this.owners.appsOf(caller),
        isFresh: session.isFresh,
        idleSeconds: Math.round((now - session.lastUsed) / 1000),
      })),
      owners: Object.fromEntries(this.owners.apps().flatMap(app => {
        const held = this.#holder(app)

        return held === undefined ? [] : [[app, held]]
      })),
      settings: this.approvals.settings,
    }
  }

  close() {
    for (const session of this.sessions.values()) {
      session.client?.close()
    }

    this.sessions.clear()
  }

  /** Closes `caller`'s Codex client and forgets its session; its apps and approvals are the caller's business. */
  #end(caller, session) {
    session.client?.close()
    this.sessions.delete(caller)
  }

  /** Ends `caller`'s session and frees its apps. */
  #evict(caller, session) {
    this.#end(caller, session)
    this.owners.release(caller)
  }

  /** Who holds `app` now, or undefined: a lease lapses `leaseMs` after its holder's last call, or with its session. */
  #holder(app) {
    const owner = this.owners.ownerOf(app)

    if (owner === undefined) {
      return undefined
    }

    const session = this.sessions.get(owner)
    const idle = session === undefined ? Infinity : this.now() - session.lastUsed

    if (session === undefined || (session.running === 0 && idle > this.leaseMs)) {
      this.owners.drop(app)

      return undefined
    }

    return { owner, idleSeconds: session.running > 0 ? 0 : Math.round(idle / 1000) }
  }

  /** Frees `app` when its lease has lapsed; a live holder keeps it. */
  #expire(app) {
    this.#holder(app)
  }

  /** Frees a slot for `session` when `maxSessions` already run: the quietest idle one stops. */
  #makeRoom(session) {
    if (session.client?.isAlive) {
      return true
    }

    const live = [...this.sessions].filter(([, other]) => other !== session && other.client?.isAlive)

    if (live.length < this.maxSessions) {
      return true
    }

    const quiet = live.filter(([, other]) => other.running === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]

    if (quiet === undefined) {
      return false
    }

    this.#evict(quiet[0], quiet[1])

    return true
  }

  #session(caller) {
    let session = this.sessions.get(caller)

    if (session === undefined) {
      session = { client: undefined, queue: Promise.resolve(), lastUsed: this.now(), running: 0, isFresh: true, ctx: undefined }
      this.sessions.set(caller, session)
    }

    return session
  }

  async #client(caller, session) {
    if (session.client?.isAlive) {
      return session.client
    }

    const restarted = session.client !== undefined
    session.client = this.createClient(params => this.#elicit(caller, session, params))
    session.isFresh = true
    await session.client.start()

    return restarted ? 'restarted' : session.client
  }

  // Answers the server's "can I use this app?" for this caller from the person's choices only.
  #elicit(caller, session, params) {
    const ctx = session.ctx ?? {}
    const request = parseRequest(params)

    if (request.kind !== 'app') {
      ctx.unsupported = request.message

      return { action: 'decline' }
    }

    this.aliases.set(request.displayName.toLowerCase(), request.bundleId)
    const held = this.#holder(request.bundleId)

    if (held !== undefined && held.owner !== caller) {
      ctx.busy = { app: { bundleId: request.bundleId, displayName: request.displayName }, ...held }

      return { action: 'decline' }
    }

    const effects = effectsOf(this.approvals.decide(caller, request.bundleId))

    if (effects.slot !== undefined) {
      ctx[effects.slot] = request
    }

    if (effects.claims) {
      this.owners.claim(request.bundleId, caller)
    }

    return effects.answer(request)
  }

  /** Checks the code and the apps it names before anything runs: a finished reply, or the named apps. */
  async #precheck(caller, code) {
    if (typeof code !== 'string' || code.trim() === '') {
      return { reply: { status: 'error', message: 'code must be a non-empty string.' } }
    }

    // Ownership and earlier denials are checked before anything runs.
    const named = []

    for (const name of namedApps(code)) {
      const bundleId = await this.resolve(name, this.aliases)

      if (bundleId !== undefined) {
        named.push({ name, bundleId })
      }
    }

    for (const { name, bundleId } of named) {
      const held = this.#holder(bundleId)

      if (held !== undefined && held.owner !== caller) {
        return { reply: { status: 'busy', app: { bundleId, displayName: name }, ...held } }
      }

      if (effectsOf(this.approvals.decide(caller, bundleId)).stops) {
        return { reply: { status: 'denied', app: { bundleId, displayName: name } } }
      }
    }

    return { named }
  }

  /** Runs `code` in the caller's Codex session: a finished reply, or the tool result with what the server asked on the way. */
  async #invoke(caller, session, named, { code, title, timeoutMs }) {
    if (!this.#makeRoom(session)) {
      return { reply: { status: 'full', message: `${this.maxSessions} Codex sessions are mid-call.` } }
    }

    const client = await this.#client(caller, session)
    const notes = client === 'restarted' ? ['The Codex session had stopped and was started again; earlier variables are gone.'] : []

    if (session.isFresh && !isEntryCall(code)) {
      return {
        reply: {
          status: 'error',
          message:
            'This Codex session is new or was reset: the first call must be one documented entry call on its own, such as `await cua.getState();` or `let app = await cua.getApp("Calculator");`. Read the documentation it returns before calling anything else.',
          notes,
        },
      }
    }

    for (const { bundleId } of named) {
      if (effectsOf(this.approvals.decide(caller, bundleId)).claimsOnRun) {
        this.owners.claim(bundleId, caller)
      }
    }

    const timeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT)
    const ctx = {}
    session.ctx = ctx
    const args = { code, timeout_ms: timeout }

    if (typeof title === 'string' && title !== '') {
      args.title = title.slice(0, 80)
    }

    let result

    try {
      result = await session.client.callTool('js', args, timeout + 30_000)
    } finally {
      session.ctx = undefined
    }

    session.isFresh = false

    return { result, ctx, notes }
  }

  /** The reply for a finished tool call: the app it used is claimed, then what the server asked decides the status. */
  #outcome(caller, { result, ctx, notes }) {
    const used = usedApp(result)

    if (used !== undefined) {
      this.#expire(used)
      const claimed = this.owners.claim(used, caller)

      if (!claimed.ok) {
        notes.push(`Warning: ${used} is owned by another caller (${claimed.owner}).`)
      }
    }

    if (ctx.busy !== undefined) {
      return { status: 'busy', ...ctx.busy }
    }

    if (ctx.denied !== undefined) {
      return { status: 'denied', app: ctx.denied }
    }

    if (ctx.needs !== undefined) {
      // The call is run again only after the person allows, so the retried code runs from the start.
      return { status: 'needs_approval', app: ctx.needs }
    }

    if (ctx.unsupported !== undefined) {
      notes.push(`The Codex server asked for an approval this helper does not answer ("${ctx.unsupported}"); it was declined.`)
    }

    return { status: 'ok', isError: result?.isError === true, content: result?.content ?? [], notes }
  }

  async #run(caller, session, { code, title, timeout_ms: timeoutMs }) {
    session.running += 1
    session.lastUsed = this.now()

    try {
      const checked = await this.#precheck(caller, code)

      if (checked.reply !== undefined) {
        return checked.reply
      }

      const invoked = await this.#invoke(caller, session, checked.named, { code, title, timeoutMs })

      return invoked.reply ?? this.#outcome(caller, invoked)
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    } finally {
      session.running -= 1
      session.lastUsed = this.now()
    }
  }
}
