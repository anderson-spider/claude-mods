// App-approval policy. The server asks "Allow Computer Use to use <app>?" through
// elicitation/create; the answer may come only from the person's choice for this
// caller, the person's saved "always", or the auto-approve switch they turned on.
// Anything else is declined, so the question reaches the person first.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { isUnder } from './owners.mjs'

/** Reads an elicitation's params: an app approval, or something this helper does not answer. */
export const parseRequest = params => {
  const meta = params?._meta ?? {}
  const app = meta.tool_params?.app
  const shown = Array.isArray(meta.tool_params_display) ? meta.tool_params_display.find(item => item?.name === 'app') : undefined

  if (meta.connector_id === 'computer-use' && typeof app === 'string' && app !== '') {
    return {
      kind: 'app',
      bundleId: app,
      displayName: typeof shown?.value === 'string' ? shown.value : app,
      canAlways: Array.isArray(meta.persist) && meta.persist.includes('always'),
    }
  }

  return { kind: 'other', message: typeof params?.message === 'string' ? params.message : 'an approval request' }
}

/** The elicitation result for a decision; only allowing answers accept. */
export const answerFor = (decision, request) => {
  switch (decision) {
    case 'session':
    case 'auto':
      return { action: 'accept', content: {}, _meta: { persist: 'session' } }
    case 'always':
      return { action: 'accept', content: {}, _meta: { persist: request.canAlways ? 'always' : 'session' } }
    default:
      return { action: 'decline' }
  }
}

export class Approvals {
  /** `file` keeps the person's "always" apps and the auto-approve switch; session choices stay in memory. */
  constructor(file) {
    this.file = file
    this.session = new Map()
    this.saved = { autoApprove: false, always: [] }

    try {
      const read = JSON.parse(readFileSync(file, 'utf8'))
      this.saved = {
        autoApprove: read.autoApprove === true,
        always: Array.isArray(read.always) ? read.always.filter(id => typeof id === 'string') : [],
      }
    } catch {
      // No file yet: auto-approve stays off.
    }
  }

  /** `deny`, `session`, `always`, `auto` or `ask`, in that order of precedence. */
  decide(caller, bundleId) {
    const mine = this.session.get(caller)?.get(bundleId)

    if (mine === 'deny') {
      return 'deny'
    }

    if (mine === 'allow') {
      return 'session'
    }

    if (this.saved.always.includes(bundleId)) {
      return 'always'
    }

    return this.saved.autoApprove ? 'auto' : 'ask'
  }

  /** Records the person's answer: `session`, `always` or `deny`. */
  record(caller, bundleId, choice) {
    if (!['session', 'always', 'deny'].includes(choice)) {
      throw new Error(`unknown choice: ${choice}`)
    }

    const mine = this.session.get(caller) ?? new Map()

    if (choice === 'always') {
      mine.delete(bundleId)
    } else {
      mine.set(bundleId, choice === 'deny' ? 'deny' : 'allow')
    }

    this.session.set(caller, mine)

    if (choice === 'always' && !this.saved.always.includes(bundleId)) {
      this.saved.always.push(bundleId)
      this.#save()
    }
  }

  /** Drops the session choices of every caller under `prefix` (a session id covers its subagents). */
  forget(prefix) {
    for (const caller of [...this.session.keys()]) {
      if (isUnder(prefix, caller)) {
        this.session.delete(caller)
      }
    }
  }

  /** Takes `bundleId` off the "always" list; true when it was there. */
  unalways(bundleId) {
    const had = this.saved.always.includes(bundleId)

    if (had) {
      this.saved.always = this.saved.always.filter(id => id !== bundleId)
      this.#save()
    }

    return had
  }

  setAutoApprove(isOn) {
    this.saved.autoApprove = isOn === true
    this.#save()
  }

  get settings() {
    return { autoApprove: this.saved.autoApprove, always: [...this.saved.always] }
  }

  #save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, `${JSON.stringify(this.saved, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.file)
  }
}
