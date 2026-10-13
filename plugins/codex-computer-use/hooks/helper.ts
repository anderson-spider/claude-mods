import type { HttpInit, HttpResponse, ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { Failure, Route, RouteReplies } from './model'

// The private link to the codex-cu helper: HTTP over its Unix socket through
// `$.http.fetch({ socketPath })`. Pure apart from `probe`.

/** What the link needs from the host; register.tsx hands `$.http.fetch` and `$.process.run` over this way. */
export type Probe = {
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  run: (argv: string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
}

// Waiting inside a `$` call does not use up the hook's time; `$.clock.sleep` would.
export const POLL = ['sleep', '0.25']

// The LaunchAgent label helper/install.sh and uninstall.sh declare; helper/test/contract.mjs pins both.
export const LABEL = 'com.anderson-spider.codex-cu'

export const socketOf = (home: string) => `${home}/.claude/mcp/codex-cu/run/helper.sock`

/** `<session>` on the main loop, `<session>/<agent>` in a subagent: each gets its own Codex session. */
export const callerOf = (sessionId: string, agentId?: string) => {
  const clean = (text: string) => text.replace(/[^A-Za-z0-9._:-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 128) || 'x'

  return agentId === undefined || agentId === '' ? clean(sessionId) : `${clean(sessionId)}/${clean(agentId)}`
}

/** POSTs `body` to `route` on the helper's socket and answers that route's reply (`RouteReplies`); never rejects. */
export const post = async <R extends Route>(probe: Probe, socket: string, route: R, body: unknown): Promise<RouteReplies[R]> => {
  // Every route's reply includes `Failure`, which the generic cannot see.
  const failed = (failure: Failure) => failure as RouteReplies[R]
  let response: HttpResponse

  try {
    response = await probe.fetch(`http://codex-cu${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      socketPath: socket,
    })
  } catch (error) {
    // No socket, or nothing listening on it.
    return failed({ status: 'unreachable', message: error instanceof Error ? error.message : String(error) })
  }

  try {
    return JSON.parse(response.text) as RouteReplies[R]
  } catch {
    return failed({ status: 'error', message: `the helper answered ${response.status} with something that is not JSON: ${response.text.slice(0, 200)}` })
  }
}

/** Asks launchd to start the helper when it is not running. */
export const kickstart = async (probe: Probe) => {
  const uid = (await probe.run(['/usr/bin/id', '-u'])).stdout.trim()
  const ran = await probe.run(['/bin/launchctl', 'kickstart', `gui/${uid}/${LABEL}`])

  return ran.exitCode === 0
}

/** How many polls `postStarting` makes for the helper launchd was asked to start. */
export const START_RETRIES = 20

/**
 * Sends to the helper like `post`, but starts it through launchd once if
 * nothing listens, then polls up to `retries` times. A start that fails gives
 * the first reply; a probe that rejects rejects.
 */
export const postStarting = async <R extends Route>(
  probe: Probe,
  socket: string,
  route: R,
  body: unknown,
  retries = START_RETRIES,
): Promise<RouteReplies[R]> => {
  const first = await post(probe, socket, route, body)

  if (first.status !== 'unreachable' || !(await kickstart(probe))) {
    return first
  }

  for (let i = 0; i < retries; i++) {
    await probe.run(POLL)
    const again = await post(probe, socket, route, body)

    if (again.status !== 'unreachable') {
      return again
    }
  }

  return first
}
