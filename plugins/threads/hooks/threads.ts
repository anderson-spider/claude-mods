import { agentPrompt, agentStart, effortError, modelError, nativeArgs, readScreen, worktreeCreate, worktreeRemove } from './herdr'
import type { AgentKind } from './herdr'
import type { Probe } from './probe'
import { capError, newId } from './registry'
import type { Registry, Thread } from './registry'
import type { Settings } from './settings'
import { claudeAnswerAfter, claudeTranscriptPath, lineCount } from './transcript'
import type { Answer } from './transcript'
import { branchFor, classify, currentCommit, repoParent } from './worktree'
import type { Outcome } from './worktree'

/** What the tools need from the host; `register.tsx` builds it from `$`. */
export type Ports = {
  probe: Probe
  load: () => Promise<Registry>
  save: (r: Registry) => Promise<void>
  /** The session id of the lead chat. */
  owner: () => Promise<string>
  cwd: () => Promise<string>
  /** The lead's model, for an empty `defaultModel`. */
  leadModel: () => Promise<string>
  now: () => number
  random?: () => number
  sleep: (ms: number) => Promise<void>
}

export type ToolResult = { text: string; isError?: true }
export type StartInput = { task: string; title?: string; agent?: AgentKind; model?: string; effort?: string }

const GIT_MS = 15_000
const fail = (text: string): ToolResult => ({ text, isError: true })

let tail: Promise<unknown> = Promise.resolve()

/** Runs `fn` on the registry one call at a time, saving what it returns, so concurrent tools never overwrite each other. */
export const withRegistry = <T>(ports: Ports, fn: (r: Registry) => Promise<{ registry: Registry; value: T }>): Promise<T> => {
  const run = tail.then(async () => {
    const { registry, value } = await fn(await ports.load())
    await ports.save(registry)

    return value
  })
  tail = run.catch(() => undefined)

  return run
}

const patch = (ports: Ports, id: string, change: (t: Thread) => Thread) =>
  withRegistry(ports, async r => ({ registry: { ...r, threads: r.threads.map(t => (t.id === id ? change(t) : t)) }, value: undefined }))

const forget = (ports: Ports, id: string) => withRegistry(ports, async r => ({ registry: { ...r, threads: r.threads.filter(t => t.id !== id) }, value: undefined }))

/** The first prompt: where the helper works and what is expected of it, then the task. It never starts with `-`. */
export const briefing = (a: { branch: string; base: string; task: string }): string =>
  [
    `You are a helper started by another Claude Code chat. You work in your own git worktree on branch ${a.branch}, created from commit ${a.base}: you see what was committed at that commit, not what the other chat has only on disk.`,
    'Commit your finished work on that branch with git. Never push, and never merge or switch branches.',
    'When you are done, end with a short summary of what you did.',
    '',
    'Task:',
    a.task,
  ].join('\n')

const transcriptOf = async (ports: Ports, t: Thread): Promise<string | undefined> => {
  const home = await ports.probe.home()

  return t.agent === 'claude' && t.path !== undefined && t.sessionId !== undefined && home !== undefined
    ? ports.probe.read(claudeTranscriptPath(home, t.path, t.sessionId))
    : undefined
}

/** The helper's transcript length now: the marker a prompt is measured from. */
export const transcriptLines = async (ports: Ports, t: Thread): Promise<number> => {
  const text = await transcriptOf(ports, t)

  return text === undefined ? 0 : lineCount(text)
}

/** The helper's answer to its latest prompt: what it said after the marker, never anything older. */
export const readAnswer = async (ports: Ports, t: Thread): Promise<Answer | undefined> => {
  const text = await transcriptOf(ports, t)

  return text === undefined ? undefined : claudeAnswerAfter(text, t.marker?.transcriptLines ?? 0)
}

export type Discard =
  | { kind: 'removed' }
  | { kind: 'branch-left'; why: string }
  | { kind: 'kept'; outcome: Outcome }
  | { kind: 'failed'; why: string }

/** Removes a helper's worktree and branch, but only when it is provably empty. */
export const discard = async (ports: Ports, t: Thread, repo: string): Promise<Discard> => {
  if (t.path === undefined || t.workspaceId === undefined) {
    return { kind: 'kept', outcome: { kind: 'unknown', reason: 'no worktree was recorded' } }
  }

  const outcome = await classify(ports.probe, { path: t.path, base: t.base, branch: t.branch })

  if (outcome.kind !== 'empty') {
    return { kind: 'kept', outcome }
  }

  const gone = await worktreeRemove(ports.probe, t.workspaceId)

  if (!gone.ok) {
    return { kind: 'failed', why: gone.error.message }
  }

  const branch = await ports.probe.run(['git', 'branch', '-d', t.branch], { cwd: repo, timeoutMs: GIT_MS })

  return branch.exitCode === 0 ? { kind: 'removed' } : { kind: 'branch-left', why: branch.stderr.trim() || `exit ${branch.exitCode}` }
}

const describe = (t: Thread) => `${t.agentName} "${t.title}" (${t.agent}${t.requestedModel ? `, ${t.requestedModel}` : ''})`

export const start = async (ports: Ports, settings: Settings, input: StartInput): Promise<ToolResult> => {
  const task = input.task.trim()

  if (task === '') {
    return fail('threads_start needs a task for the helper.')
  }

  const kind = input.agent ?? 'claude'
  const model = kind === 'claude' ? input.model?.trim() || settings.defaultModel || (await ports.leadModel()) : input.model?.trim() || undefined
  const badModel = kind === 'claude' && model !== undefined ? modelError(kind, model) : undefined
  const badEffort = kind === 'claude' && input.effort !== undefined ? effortError(input.effort) : undefined

  if (badModel !== undefined || badEffort !== undefined) {
    return fail(badModel ?? badEffort ?? '')
  }

  const lead = await ports.cwd()
  const repo = await repoParent(ports.probe, lead)
  const base = repo === undefined ? undefined : await currentCommit(ports.probe, lead)

  if (repo === undefined || base === undefined) {
    return fail(`${lead} is not inside a git repository with a commit, so there is nothing to start a helper from.`)
  }

  const owner = await ports.owner()
  const title = input.title?.trim() || task.split('\n')[0]?.slice(0, 60) || 'helper'
  const made = await withRegistry<Thread | string>(ports, async r => {
    const refused = capError(r, owner, settings.maxThreads)

    if (refused !== undefined) {
      return { registry: r, value: refused }
    }

    const id = newId(new Set(r.threads.map(t => t.id)), ports.random)
    const created: Thread = {
      id,
      owner,
      title,
      agent: kind,
      requestedModel: model,
      stage: 'creating',
      status: 'starting',
      agentName: `t-${id}`,
      branch: branchFor(id),
      base,
      createdAt: ports.now(),
    }

    return { registry: { ...r, threads: [...r.threads, created] }, value: created }
  })

  if (typeof made === 'string') {
    return fail(made)
  }

  let current = made
  const update = async (change: Partial<Thread>) => {
    current = { ...current, ...change }
    await patch(ports, current.id, () => current)
  }
  const giveUp = async (why: string): Promise<ToolResult> => {
    const dropped = await discard(ports, current, repo)

    if (dropped.kind === 'removed') {
      await forget(ports, current.id)

      return fail(`${why}. The empty worktree and its branch were removed (rolled back).`)
    }

    await update({ status: 'orphan' })

    return fail(`${why}. The worktree could not be removed and is still at ${current.path}; close it with threads_close ${current.id}.`)
  }

  const created = await worktreeCreate(ports.probe, { cwd: repo, branch: current.branch, base, label: title })

  if (!created.ok) {
    await forget(ports, current.id)

    return fail(`Could not create the worktree (${created.error.code}): ${created.error.message}`)
  }

  await update({ stage: 'worktree', workspaceId: created.value.workspaceId, paneId: created.value.paneId, path: created.value.path })

  const started = await agentStart(ports.probe, {
    name: current.agentName,
    kind,
    paneId: created.value.paneId,
    args: nativeArgs({ kind, model, mode: settings.defaultPermissionMode, effort: input.effort }),
  })

  if (!started.ok && started.error.code === 'agent_not_ready') {
    await update({ stage: 'agent', status: 'blocked' })
    const screen = await readScreen(ports.probe, current.agentName)

    return {
      text: `Started ${describe(current)} in ${current.path}, but it is stopped at startup and has not been given its task. Its screen:\n${screen.ok ? screen.value.trim() : '(unreadable)'}\nAnswer it with threads_answer or in its pane.`,
    }
  }

  if (!started.ok) {
    return giveUp(`Could not start the helper (${started.error.code}): ${started.error.message}`)
  }

  await update({ stage: 'agent', sessionId: started.value.sessionId })
  await update({
    stage: 'prompted',
    marker: { at: ports.now(), completionSeq: started.value.completionSeq, stateChangeSeq: started.value.stateChangeSeq, transcriptLines: await transcriptLines(ports, current), seenWorking: false },
  })

  const sent = await agentPrompt(ports.probe, current.agentName, briefing({ branch: current.branch, base, task }))

  if (!sent.ok) {
    if (sent.error.code === 'agent_blocked') {
      await update({ status: 'blocked' })
    }

    return fail(
      `Started ${describe(current)} (id ${current.id}) but delivery of its task is unconfirmed (${sent.error.code}: ${sent.error.message}). It was not sent again; check threads_status ${current.id}, or give it the task with threads_answer text.`,
    )
  }

  return {
    text: `Started ${describe(current)} in ${current.path} on branch ${current.branch}. Id: ${current.id}. You will be told when it finishes or needs you; threads_status shows it meanwhile.`,
  }
}
