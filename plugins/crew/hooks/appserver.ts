// A twin run by the crew Codex helper (`helper/`): the helper owns one `codex app-server` and a thread per agent, and
// the twin's step is one turn on it. HTTP over the helper's Unix socket through `$.http.fetch({ socketPath })`.
// Pure apart from the injected `Probe`: the step hook in register.tsx builds it from `$`.
import type { HttpInit, HttpResponse, ProcessRunInit, ProcessRunResult } from 'claude-code'

/** What the link needs from the host. */
export type Probe = {
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  run: (argv: string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
}

/** The LaunchAgent label helper/install.sh and uninstall.sh declare; `helper/test/contract.mjs` pins both. */
export const LABEL = 'com.anderson-spider.crew-codex'

/** The routes the helper serves, POSTed over its socket (`/status` answers any method). */
export const ROUTES = { start: '/start', poll: '/poll', interrupt: '/interrupt', reset: '/reset', status: '/status' } as const
export type Route = (typeof ROUTES)[keyof typeof ROUTES]

/** The roles whose twin runs on the helper: the ones that write, so Codex's own sandbox holds their lane. */
export const HELPER_ROLES: readonly string[] = ['developer', 'architect']

export const socketOf = (home: string) => `${home}/.claude/mcp/crew-codex/run/helper.sock`

export type Failure = { status: 'unreachable' | 'error' | 'busy' | 'full'; message?: string }
export type Finished = { status: 'ok'; turn: string; text: string; files: { status: string; paths: string[] }[]; commands: { command: string; status: string; exitCode: number | null }[]; declined: number; error: string | null }

export type RouteReplies = {
  '/start': { status: 'started' } | Failure
  '/poll': { status: 'running'; seconds: number } | { status: 'idle' } | Finished | Failure
  '/interrupt': { status: 'ok'; interrupted: boolean } | Failure
  '/reset': { status: 'ok' } | Failure
  '/status': { status: 'ok'; version: string; pid: number; jobs: number; threads: number; codex: boolean; login: boolean } | Failure
}

/** The turn's request: one caller (an agent id), its role, repository, model, effort and the text to answer. */
export type TurnRequest = { caller: string; role: string; repo: string; model: string; effort: string; instructions: string; prompt: string }

/** `<agent id>` made safe for the helper's caller grammar. */
export const callerOf = (agentId: string) => agentId.replace(/[^A-Za-z0-9._:-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 128) || 'x'

/** True when the twin named `crew:<role>-codex`'s base role runs on the helper. */
export const helperRole = (twinName: string) => HELPER_ROLES.includes(twinName.replace(/-codex$/, ''))

/** POSTs `body` to `route` and answers that route's reply; never rejects. */
export async function post<R extends Route>(probe: Probe, socket: string, route: R, body: unknown): Promise<RouteReplies[R]> {
  const failed = (failure: Failure) => failure as RouteReplies[R]
  let response: HttpResponse
  try {
    response = await probe.fetch(`http://crew-codex${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      socketPath: socket,
    })
  } catch (error) {
    return failed({ status: 'unreachable', message: error instanceof Error ? error.message : String(error) })
  }
  try {
    const parsed: unknown = JSON.parse(response.text)
    if (parsed && typeof parsed === 'object' && typeof (parsed as { status?: unknown }).status === 'string') return parsed as RouteReplies[R]
  } catch {
    // Not JSON: reported below.
  }
  return failed({ status: 'error', message: `the helper answered ${response.status} with something that is not its reply` })
}

/** Asks launchd to start the helper when it is not running. */
export async function kickstart(probe: Probe): Promise<boolean> {
  const uid = (await probe.run(['/usr/bin/id', '-u'])).stdout.trim()
  return (await probe.run(['/bin/launchctl', 'kickstart', `gui/${uid}/${LABEL}`])).exitCode === 0
}

export const START_RETRIES = 20
/** The pause between polls; `process.run` waits without spending the hook's time. */
export const POLL = ['sleep', '1']
/** How many polls one step waits for its turn: the helper ends a turn on its own limit first. */
export const MAX_POLLS = 1500

/** Like `post`, but starts the helper through launchd once when nothing listens, then polls for it. */
export async function postStarting<R extends Route>(probe: Probe, socket: string, route: R, body: unknown, retries = START_RETRIES): Promise<RouteReplies[R]> {
  const first = await post(probe, socket, route, body)
  if (first.status !== 'unreachable' || !(await kickstart(probe))) return first
  for (let i = 0; i < retries; i++) {
    await probe.run(['sleep', '0.25'])
    const again = await post(probe, socket, route, body)
    if (again.status !== 'unreachable') return again
  }
  return first
}

/** Whether the helper runs, found a `codex` binary and has a login to share: all a twin needs before its first step. */
export async function helperReady(probe: Probe, socket: string): Promise<{ ready: true } | { ready: false; reason: string }> {
  const reply = await post(probe, socket, ROUTES.status, {})
  if (reply.status === 'unreachable') return { ready: false, reason: 'the crew Codex helper is not running (run plugins/crew/helper/install.sh)' }
  if (reply.status !== 'ok' || !('codex' in reply)) return { ready: false, reason: 'the crew Codex helper did not answer its status' }
  if (!reply.codex) return { ready: false, reason: 'the crew Codex helper found no codex binary' }
  if (!reply.login) return { ready: false, reason: 'the crew Codex helper found no Codex login (run `codex login`)' }
  return { ready: true }
}

/** What a turn came to: the answer text, or why there is none. Never a throw. */
export type Outcome = { kind: 'text'; text: string } | { kind: 'failed'; reason: string } | { kind: 'aborted' }

/** The twin's answer: Codex's own text, then a note on what the sandbox refused when it refused anything. */
export function answerText(done: Finished): string {
  const text = done.text.trim() === '' ? 'The Codex turn ended without a message.' : done.text
  const notes: string[] = []
  const changed = [...new Set(done.files.filter(file => file.status === 'completed').flatMap(file => file.paths))]
  if (changed.length > 0) notes.push(`files changed: ${changed.join(', ')}`)
  if (done.declined > 0) notes.push(`${done.declined} action${done.declined === 1 ? ' was' : 's were'} refused outside this role's lane`)
  return notes.length === 0 ? text : `${text}\n\n(crew: ${notes.join('; ')})`
}

/**
 * One turn: start it (the helper is started through launchd when it is not running), poll until it ends, and stop it
 * when `aborted()` turns true. The helper's own time limit ends a turn that hangs.
 */
export async function runTurn(probe: Probe, socket: string, request: TurnRequest, aborted: () => boolean, maxPolls = MAX_POLLS): Promise<Outcome> {
  // An abort before the start asks nothing: there is no turn to stop.
  if (aborted()) return { kind: 'aborted' }
  const started = await postStarting(probe, socket, ROUTES.start, request)
  if (started.status === 'unreachable') return { kind: 'failed', reason: 'the crew Codex helper is not running (run plugins/crew/helper/install.sh)' }
  if (started.status === 'busy') return { kind: 'failed', reason: 'this agent already has a Codex turn running' }
  if (started.status === 'full') return { kind: 'failed', reason: `the crew Codex helper is full${started.message ? `: ${started.message}` : ''}`.slice(0, 300) }
  if (started.status !== 'started') return { kind: 'failed', reason: `the crew Codex helper refused the turn${'message' in started && started.message ? `: ${started.message}` : ''}`.slice(0, 400) }
  for (let polls = 0; polls < maxPolls; polls++) {
    if (aborted()) {
      await post(probe, socket, ROUTES.interrupt, { caller: request.caller })
      return { kind: 'aborted' }
    }
    const reply = await post(probe, socket, ROUTES.poll, { caller: request.caller })
    if (reply.status === 'ok' && 'turn' in reply) {
      if (reply.turn === 'completed') return { kind: 'text', text: answerText(reply) }
      const why = reply.error ? `: ${reply.error}` : ''
      return { kind: 'failed', reason: `the Codex turn ${reply.turn}${why}`.slice(0, 300) }
    }
    if (reply.status === 'idle') return { kind: 'failed', reason: 'the crew Codex helper lost the turn' }
    if (reply.status !== 'running') return { kind: 'failed', reason: reply.status === 'unreachable' ? 'the crew Codex helper stopped answering' : `the crew Codex helper failed: ${'message' in reply && reply.message ? reply.message : reply.status}`.slice(0, 300) }
    await probe.run([...POLL])
  }
  await post(probe, socket, ROUTES.interrupt, { caller: request.caller })
  return { kind: 'failed', reason: 'the Codex turn took too long' }
}

/** The text of the conversation's last user message, which is what the thread is asked next. */
export function lastUserText(messages: readonly { role: string; content: readonly { type: string; [field: string]: unknown }[] }[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const text = requestText(message)
    if (text !== '') return text
  }
  return undefined
}

/** The id prefix of the tool call a handed-back answer is made with. */
export const HANDBACK_ID = 'crew_handback_'

/** Text blocks of a message, without the host's own reminders. */
const requestText = (message: { content: readonly { type: string; [field: string]: unknown }[] }) =>
  message.content
    .flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim()

/**
 * The message of crew's own handback call when the conversation ends with its result and nothing new: the host asked
 * for another step after the answer was handed back (it refused the call, say), and answering again would run the whole
 * task a second time. A request that follows the result (a `SendMessage`, which the engine may merge into the same user
 * message) is new work and gives `undefined`.
 */
export function handedBackMessage(messages: readonly { role: string; content: readonly { type: string; [field: string]: unknown }[] }[]): string | undefined {
  const last = messages.at(-1)
  if (last?.role !== 'user') return undefined
  const result = last.content.find(block => block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id.startsWith(HANDBACK_ID))
  if (!result || requestText(last) !== '') return undefined
  const call = messages
    .flatMap(message => message.content)
    .find(block => block.type === 'tool_use' && block.id === result.tool_use_id)
  const input = call?.input as { message?: unknown } | undefined
  return typeof input?.message === 'string' && input.message !== '' ? input.message : 'crew: the answer was handed back.'
}
