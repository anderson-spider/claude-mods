import type { Probe } from './probe'
import type { PermissionMode } from './settings'

export type AgentKind = 'claude' | 'codex'
export type HerdrError = { code: string; message: string }
export type Result<T> = { ok: true; value: T } | { ok: false; error: HerdrError }
export type Agent = {
  name?: string
  kind: string
  status: string
  paneId: string
  workspaceId: string
  cwd: string
  sessionId?: string
  completionSeq?: number
  stateChangeSeq?: number
}
export type Created = { workspaceId: string; paneId: string; path: string; branch: string }

export const ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] as const
const MODEL_ID = /^claude-(haiku|sonnet|opus|fable|mythos)-[0-9][0-9a-z.-]*(\[1m\])?$/
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Why a Claude model name cannot be used; Codex takes whatever it is given. */
export const modelError = (kind: AgentKind, model: string): string | undefined => {
  if (kind === 'codex' || (ALIASES as readonly string[]).includes(model) || MODEL_ID.test(model)) {
    return undefined
  }

  return `Unknown Claude model "${model}". Use an alias (${ALIASES.join(', ')}) or a full model name such as claude-sonnet-5-5.`
}

export const effortError = (effort: string): string | undefined =>
  EFFORTS.includes(effort) ? undefined : `Unknown effort "${effort}". Use one of: ${EFFORTS.join(', ')}.`

/** The arguments that go after `--` in `herdr agent start`. Codex gets nothing unless a model is asked for. */
export const nativeArgs = (a: { kind: AgentKind; model?: string; mode?: PermissionMode; effort?: string }): string[] => {
  if (a.kind === 'codex') {
    return a.model ? ['-m', a.model] : []
  }

  return [
    ...(a.model ? ['--model', a.model] : []),
    ...(a.mode ? ['--permission-mode', a.mode] : []),
    ...(a.effort ? ['--effort', a.effort] : []),
  ]
}

type Json = Record<string, any>

const parse = (text: string): Json | undefined => {
  const body = text.trim()

  if (!body.startsWith('{')) {
    return undefined
  }

  try {
    return JSON.parse(body) as Json
  } catch {
    return undefined
  }
}

const failed = (stdout: string, stderr: string, exitCode: number): HerdrError | undefined => {
  for (const text of [stdout, stderr]) {
    const error = parse(text)?.error

    if (error !== undefined) {
      return { code: String(error.code ?? 'error'), message: String(error.message ?? '') }
    }
  }

  return exitCode === 0 ? undefined : { code: 'cli', message: (stderr || stdout).trim().slice(0, 300) }
}

const call = async (probe: Probe, argv: string[], timeoutMs = 30_000): Promise<Result<Json>> => {
  const done = await probe.run(['herdr', ...argv], { timeoutMs })
  const error = failed(done.stdout, done.stderr, done.exitCode)

  return error === undefined ? { ok: true, value: (parse(done.stdout)?.result ?? {}) as Json } : { ok: false, error }
}

const agentOf = (raw: Json): Agent => ({
  name: raw.name,
  kind: String(raw.agent),
  status: String(raw.agent_status),
  paneId: String(raw.pane_id),
  workspaceId: String(raw.workspace_id),
  cwd: String(raw.cwd),
  sessionId: raw.agent_session?.value ?? undefined,
  completionSeq: raw.completion_seq,
  stateChangeSeq: raw.state_change_seq,
})

const one = async (probe: Probe, argv: string[], timeoutMs?: number): Promise<Result<Agent>> => {
  const done = await call(probe, argv, timeoutMs)

  return done.ok ? { ok: true, value: agentOf(done.value.agent ?? done.value) } : done
}

const nothing = async (probe: Probe, argv: string[]): Promise<Result<void>> => {
  const done = await call(probe, argv)

  return done.ok ? { ok: true, value: undefined } : done
}

export const worktreeCreate = async (
  probe: Probe,
  a: { cwd: string; branch: string; base: string; label: string },
): Promise<Result<Created>> => {
  const done = await call(probe, ['worktree', 'create', '--cwd', a.cwd, '--branch', a.branch, '--base', a.base, '--label', a.label, '--no-focus'])

  if (!done.ok) {
    return done
  }

  const { root_pane: pane, workspace, worktree } = done.value

  return { ok: true, value: { workspaceId: String(workspace?.workspace_id), paneId: String(pane?.pane_id), path: String(worktree?.path), branch: String(worktree?.branch) } }
}

export const worktreeRemove = (probe: Probe, workspaceId: string) => nothing(probe, ['worktree', 'remove', '--workspace', workspaceId])

export const agentStart = (probe: Probe, a: { name: string; kind: AgentKind; paneId: string; args: string[] }) =>
  one(probe, ['agent', 'start', a.name, '--kind', a.kind, '--pane', a.paneId, '--timeout', '60000', ...(a.args.length > 0 ? ['--', ...a.args] : [])], 90_000)

export const agentGet = (probe: Probe, target: string) => one(probe, ['agent', 'get', target])

export const agentList = async (probe: Probe): Promise<Result<Agent[]>> => {
  const done = await call(probe, ['agent', 'list'])

  return done.ok ? { ok: true, value: ((done.value.agents ?? []) as Json[]).map(agentOf) } : done
}

/**
 * Sends the text without `--wait`: whether the helper took it is seen later, from its status. A text that
 * starts with `-` would be read as an option, so it is introduced.
 */
export const agentPrompt = (probe: Probe, target: string, text: string) => one(probe, ['agent', 'prompt', target, text.trimStart().startsWith('-') ? `Instruction: ${text}` : text])

export type WorktreeInfo = { path: string; branch: string; workspaceId?: string }

/** The repository's worktrees as Herdr knows them, with the workspace each one is open in. */
export const worktreeList = async (probe: Probe, cwd: string): Promise<Result<WorktreeInfo[]>> => {
  const done = await call(probe, ['worktree', 'list', '--cwd', cwd])

  return done.ok
    ? { ok: true, value: ((done.value.worktrees ?? []) as Json[]).map(w => ({ path: String(w.path), branch: String(w.branch), workspaceId: w.open_workspace_id ?? undefined })) }
    : done
}

export const sendKeys = (probe: Probe, target: string, keys: string[]) => nothing(probe, ['agent', 'send-keys', target, ...keys])

/** The visible screen of an agent, as plain text. */
export const readScreen = async (probe: Probe, target: string, lines = 20): Promise<Result<string>> => {
  const done = await probe.run(['herdr', 'agent', 'read', target, '--source', 'visible', '--lines', String(lines)], { timeoutMs: 30_000 })
  const error = failed(done.stdout, done.stderr, done.exitCode)

  return error === undefined ? { ok: true, value: done.stdout } : { ok: false, error }
}

export const paneClose = (probe: Probe, paneId: string) => nothing(probe, ['pane', 'close', paneId])

export const agentFocus = (probe: Probe, target: string) => nothing(probe, ['agent', 'focus', target])
