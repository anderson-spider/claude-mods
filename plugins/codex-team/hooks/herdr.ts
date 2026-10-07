import { HerdrError } from './model'
import type { AgentState, Herdr, Run, Settled } from './model'
import { isAgentName } from './names'
import { messageOf } from './text'

// The Herdr interface over the `herdr` CLI. Every command prints JSON on success
// and a JSON error on failure; `agent read` prints the pane text raw.

const STATES: readonly string[] = ['idle', 'working', 'blocked', 'done']
const SETTLED: readonly string[] = ['idle', 'blocked', 'done']
// A herdr wait that gives up by itself answers `timeout`; the process gets a little longer than the wait it asked for.
const GRACE_MS = 20_000
// Marks the pane metadata this plugin reports, so it never touches what others set.
const SOURCE = 'codex-team'

type Json = { result?: any; error?: { code?: string; message?: string } }

function errorOf(stderr: string, stdout: string, exitCode: number): HerdrError {
  for (const text of [stderr, stdout]) {
    try {
      const { error } = JSON.parse(text) as Json
      if (error?.code) return new HerdrError(error.code, error.message ?? error.code)
    } catch {
      // not JSON: fall through to the raw text
    }
  }
  const raw = (stderr || stdout).trim().slice(0, 300)
  return new HerdrError('unknown', raw || `herdr exited with ${exitCode}`)
}

/** The Herdr interface over `run`, acting on `pane` (the calling pane) and `cwd` (the session's directory). */
export function herdrOf(run: Run, options: { pane: string; cwd: string }): Herdr {
  // Pane names and prompts each go as one argv element, never through a shell.
  const exec = async (argv: string[], timeoutMs?: number): Promise<string> => {
    let result: Awaited<ReturnType<Run>>
    try {
      result = await run(['herdr', ...argv], timeoutMs === undefined ? undefined : { timeoutMs })
    } catch (error) {
      throw new HerdrError('unknown', messageOf(error))
    }
    if (result.exitCode !== 0) throw errorOf(result.stderr, result.stdout, result.exitCode)
    return result.stdout
  }
  const json = async (argv: string[], timeoutMs?: number): Promise<Json> => {
    const out = await exec(argv, timeoutMs)
    try {
      return JSON.parse(out) as Json
    } catch {
      throw new HerdrError('unknown', `herdr answered something that is not JSON: ${out.slice(0, 200)}`)
    }
  }
  const stateOf = (answer: Json): AgentState => {
    const status = answer.result?.agent?.agent_status
    if (typeof status !== 'string' || !STATES.includes(status)) throw new HerdrError('unknown', `herdr reported an unexpected agent status: ${String(status)}`)
    return status as AgentState
  }

  return {
    async split(direction, target) {
      const id = (await json(['pane', 'split', target ?? options.pane, '--direction', direction, '--cwd', options.cwd, '--no-focus'])).result?.pane?.pane_id
      if (typeof id !== 'string') throw new HerdrError('unknown', 'herdr did not return the new pane')
      return id
    },

    async rename(pane, name) {
      await exec(['pane', 'rename', pane, name])
    },

    async close(pane) {
      try {
        await exec(['pane', 'close', pane])
      } catch (error) {
        if (!(error instanceof HerdrError) || error.code !== 'pane_not_found') throw error
      }
    },

    async start(name, pane, args) {
      await exec(['agent', 'start', name, '--kind', 'codex', '--pane', pane, '--', ...args])
    },

    async prompt(name, text, timeoutMs) {
      const state = stateOf(await json(['agent', 'prompt', name, text, '--wait', '--timeout', String(timeoutMs)], timeoutMs + GRACE_MS))
      if (!SETTLED.includes(state)) throw new HerdrError('unknown', `herdr answered the prompt with the status ${state}, not a settled one`)
      return state as Settled
    },

    async wait(name, timeoutMs, until) {
      const states = (until ?? []).flatMap(state => ['--until', state])
      return stateOf(await json(['agent', 'wait', name, '--timeout', String(timeoutMs), ...states], timeoutMs + GRACE_MS))
    },

    read: (name, lines) => exec(['agent', 'read', name, '--source', 'recent-unwrapped', '--lines', String(lines)]),

    async sendKeys(name, keys) {
      await exec(['agent', 'send-keys', name, ...keys])
    },

    async submit(name, text) {
      await exec(['agent', 'prompt', name, text])
    },

    async list() {
      const agents: { name?: string; pane_id?: string; terminal_id?: string }[] = (await json(['agent', 'list'])).result?.agents ?? []
      return agents.flatMap(agent => (agent.name && isAgentName(agent.name) && agent.pane_id
        ? [{ name: agent.name, pane: agent.pane_id, ...(typeof agent.terminal_id === 'string' ? { terminal: agent.terminal_id } : {}) }]
        : []))
    },

    async notify(title, body) {
      await exec(['notification', 'show', title, '--body', body, '--sound', 'request'])
    },

    async annotate(pane, meta) {
      await exec([
        'pane', 'report-metadata', pane, '--source', SOURCE,
        ...(meta.title ? ['--title', meta.title] : []),
        ...(meta.stateLabel ? ['--state-label', `blocked=${meta.stateLabel}`] : []),
        '--ttl-ms', String(meta.ttlMs),
      ])
    },
  }
}

/** Why the plugin cannot run here, or undefined when it can. */
export async function herdrAvailable(run: Run, env: { HERDR_ENV?: string }): Promise<string | undefined> {
  if (env.HERDR_ENV !== '1') return 'Not running inside Herdr (HERDR_ENV is not 1): codex-team needs Claude Code in a Herdr pane.'
  for (const tool of ['herdr', 'codex']) {
    if (await versionOf(argv => run(argv, { timeoutMs: 15_000 }).catch(() => undefined), tool) === undefined) return `${tool} is not installed or not in PATH.`
  }
  return undefined
}

/** The first line of `<tool> --version`, or undefined when the tool did not answer or failed. */
export async function versionOf(run: (argv: string[]) => Promise<{ exitCode: number; stdout: string } | undefined>, tool: string): Promise<string | undefined> {
  const found = await run([tool, '--version'])
  return found?.exitCode === 0 ? found.stdout.trim().split('\n')[0]! : undefined
}
