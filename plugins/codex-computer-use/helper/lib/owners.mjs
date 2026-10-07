// One caller per app: the first caller to touch an app owns it until it resets,
// its session closes or it goes idle. Keys are bundle identifiers.
/** True when `caller` is `prefix` itself or one of its subagents (`<prefix>/<agent>`). */
export const isUnder = (prefix, caller) => caller === prefix || caller.startsWith(`${prefix}/`)

export class Owners {
  constructor() {
    this.byApp = new Map()
  }

  /** Takes `app` for `caller`; `{ ok: true }` or `{ ok: false, owner }` when another caller has it. */
  claim(app, caller) {
    const owner = this.byApp.get(app)

    if (owner !== undefined && owner !== caller) {
      return { ok: false, owner }
    }

    this.byApp.set(app, caller)

    return { ok: true }
  }

  ownerOf(app) {
    return this.byApp.get(app)
  }

  appsOf(caller) {
    return [...this.byApp].filter(([, owner]) => owner === caller).map(([app]) => app)
  }

  /** Every app currently held, by bundle id. */
  apps() {
    return [...this.byApp.keys()]
  }

  /** Frees `app`, whoever holds it. */
  drop(app) {
    this.byApp.delete(app)
  }

  release(caller) {
    for (const [app, owner] of [...this.byApp]) {
      if (owner === caller) {
        this.byApp.delete(app)
      }
    }
  }

  /** Frees every app held by `prefix` or one of its subagents. */
  releasePrefix(prefix) {
    for (const [app, owner] of [...this.byApp]) {
      if (isUnder(prefix, owner)) {
        this.byApp.delete(app)
      }
    }
  }
}
