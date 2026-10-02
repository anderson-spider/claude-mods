import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { Check, CheckStatus, Comment, DiffFile, PrSnapshot, PrState, PrView } from '../types'

/** What the reads need from the host; the hooks module owns `$` and hands it over this way. */
export type Probe = {
  run: (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>
}

export type Remote = { host: string; path: string }

export type Reading = { branch: string; diff: DiffFile[]; diffError: string; pr: PrView }

const MAX_COMMENTS = 30
const TIMEOUT = 20_000

type Json = Record<string, unknown>

const obj = (value: unknown): Json => (typeof value === 'object' && value !== null ? (value as Json) : {})
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const git = (probe: Probe, dir: string, args: string[]) =>
  probe.run(['git', '-c', 'core.quotepath=false', ...args], { cwd: dir, timeoutMs: TIMEOUT })

/** `git@host:group/repo.git`, `https://host/group/repo` and `ssh://git@host/group/repo` read the same. */
export const parseRemote = (url: string): Remote | undefined => {
  const text = url.trim()
  const scp = /^[\w.-]+@([^:/\s]+):(.+?)(?:\.git)?\/?$/.exec(text)

  if (scp !== null) {
    return { host: scp[1], path: scp[2] }
  }

  const web = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(text)

  return web === null ? undefined : { host: web[1], path: web[2] }
}

/** `github.com` and GitHub Enterprise hosts name `github`; every other host is taken as GitLab. */
export const platformOf = (host: string): 'github' | 'gitlab' => (host.includes('github') ? 'github' : 'gitlab')

/** Splits `git diff` output into files, counting changed lines and keeping the hunks. */
export const parseDiff = (text: string): DiffFile[] => {
  const files: DiffFile[] = []
  let current: DiffFile | undefined
  let inHunk = false

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const named = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
      current = { path: named === null ? line.slice(11) : named[2], added: 0, removed: 0, lines: [], isUntracked: false }
      files.push(current)
      inHunk = false
    } else if (current === undefined) {
      continue
    } else if (line.startsWith('@@')) {
      inHunk = true
      current.lines.push(line)
    } else if (inHunk) {
      if (line.startsWith('+')) {
        current.added += 1
      } else if (line.startsWith('-')) {
        current.removed += 1
      }

      if (line !== '') {
        current.lines.push(line)
      }
    }
  }

  return files
}

/** Staged, unstaged and untracked changes against HEAD. */
const readDiff = async (probe: Probe, dir: string): Promise<{ files: DiffFile[]; error: string }> => {
  let tracked = await git(probe, dir, ['diff', 'HEAD', '--no-color', '--no-ext-diff'])

  // A repository with no commit yet has no HEAD to compare against.
  if (tracked.exitCode !== 0) {
    tracked = await git(probe, dir, ['diff', '--no-color', '--no-ext-diff'])
  }

  if (tracked.exitCode !== 0) {
    return { files: [], error: tracked.stderr.trim() || 'git diff failed' }
  }

  const files = parseDiff(tracked.stdout)
  const others = await git(probe, dir, ['ls-files', '--others', '--exclude-standard'])

  if (others.exitCode === 0) {
    for (const path of others.stdout.split('\n').filter(line => line !== '')) {
      files.push({ path, added: 0, removed: 0, lines: [], isUntracked: true })
    }
  }

  return { files, error: '' }
}

const checkStatusOf = (status: string, conclusion: string): CheckStatus => {
  if (status === 'COMPLETED') {
    if (conclusion === 'SUCCESS') {
      return 'success'
    }

    return conclusion === 'SKIPPED' || conclusion === 'NEUTRAL' ? 'skipped' : 'failure'
  }

  return status === 'IN_PROGRESS' ? 'running' : 'pending'
}

const contextStatusOf = (state: string): CheckStatus => {
  if (state === 'SUCCESS') {
    return 'success'
  }

  return state === 'FAILURE' || state === 'ERROR' ? 'failure' : 'pending'
}

const newestFirst = (comments: Comment[]): Comment[] =>
  [...comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_COMMENTS)

const gh = (probe: Probe, dir: string, args: string[]) => probe.run(['gh', ...args], { cwd: dir, timeoutMs: TIMEOUT })

/** Folds `gh pr view --json …` and the inline review comments into a snapshot. */
export const foldGithub = (view: Json, inline: unknown[]): PrSnapshot => {
  const checks: Check[] = list(view.statusCheckRollup).map(raw => {
    const one = obj(raw)

    return one.__typename === 'StatusContext'
      ? { name: str(one.context), status: contextStatusOf(str(one.state)) }
      : { name: str(one.name), status: checkStatusOf(str(one.status), str(one.conclusion)) }
  })
  const comments: Comment[] = []

  for (const raw of list(view.comments)) {
    const one = obj(raw)
    comments.push({
      kind: 'comment',
      author: str(obj(one.author).login),
      anchor: 'comment',
      body: str(one.body),
      createdAt: str(one.createdAt),
      isResolved: false,
      isOutdated: false,
    })
  }

  for (const raw of list(view.reviews)) {
    const one = obj(raw)
    const state = str(one.state).toLowerCase().replace('_', ' ')

    if (str(one.body) === '' && state === 'commented') {
      continue
    }

    comments.push({
      kind: 'review',
      author: str(obj(one.author).login),
      anchor: `review (${state})`,
      body: str(one.body),
      createdAt: str(one.submittedAt),
      isResolved: false,
      isOutdated: false,
    })
  }

  for (const raw of inline) {
    const one = obj(raw)
    const line = one.line ?? one.original_line

    comments.push({
      kind: 'finding',
      author: str(obj(one.user).login),
      anchor: typeof line === 'number' ? `${str(one.path)}:${line}` : str(one.path),
      body: str(one.body),
      createdAt: str(one.created_at),
      // GitHub's thread resolution is a GraphQL field; the REST comments carry only whether the line moved.
      isResolved: false,
      isOutdated: one.line === null,
    })
  }

  const state = str(view.state).toLowerCase()

  return {
    number: typeof view.number === 'number' ? view.number : 0,
    title: str(view.title),
    url: str(view.url),
    body: str(view.body),
    state: (state === 'merged' || state === 'closed' ? state : 'open') as PrState,
    isDraft: view.isDraft === true,
    headRef: str(view.headRefName),
    baseRef: str(view.baseRefName),
    merge: view.mergeable === 'CONFLICTING' ? 'conflicting' : str(view.mergeStateStatus) === 'BLOCKED' ? 'blocked' : 'clean',
    checks,
    comments: newestFirst(comments),
  }
}

const readGithub = async (probe: Probe, dir: string, remote: Remote): Promise<PrView> => {
  const fields =
    'number,title,url,body,state,isDraft,headRefName,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,comments,reviews'
  const viewed = await gh(probe, dir, ['pr', 'view', '--json', fields])

  if (viewed.exitCode !== 0) {
    const message = viewed.stderr.trim()

    return /no pull requests? found/i.test(message)
      ? { kind: 'none', message: 'No pull request for this branch.' }
      : { kind: 'error', message: message || 'gh pr view failed' }
  }

  const view = obj(parse(viewed.stdout))
  const number = typeof view.number === 'number' ? view.number : 0
  const inline = await gh(probe, dir, [
    'api',
    '--hostname',
    remote.host,
    `repos/${remote.path}/pulls/${number}/comments?per_page=100`,
  ])

  return { kind: 'pr', pr: foldGithub(view, inline.exitCode === 0 ? list(parse(inline.stdout)) : []) }
}

const jobStatusOf = (status: string, isAllowedToFail: boolean): CheckStatus => {
  switch (status) {
    case 'success':
      return 'success'
    case 'failed':
      return isAllowedToFail ? 'skipped' : 'failure'
    case 'running':
      return 'running'
    case 'skipped':
    case 'canceled':
    case 'manual':
      return 'skipped'
    default:
      return 'pending'
  }
}

/** Folds the merge request, its discussions and its head pipeline's jobs into a snapshot. */
export const foldGitlab = (mr: Json, discussions: unknown[], jobs: unknown[]): PrSnapshot => {
  const comments: Comment[] = []

  for (const raw of discussions) {
    const notes = list(obj(raw).notes).map(obj)
    const first = notes[0]

    // System notes ("added 2 commits", "marked as draft") are events, not comments.
    if (first === undefined || first.system === true) {
      continue
    }

    const position = obj(first.position)
    const line = position.new_line ?? position.old_line
    const isFinding = first.type === 'DiffNote'

    comments.push({
      kind: isFinding ? 'finding' : 'comment',
      author: str(obj(first.author).username),
      anchor: isFinding ? (typeof line === 'number' ? `${str(position.new_path)}:${line}` : str(position.new_path)) : 'comment',
      body: str(first.body),
      createdAt: str(first.created_at),
      isResolved: first.resolved === true,
      isOutdated: false,
    })
  }

  const state = str(mr.state)
  const detailed = str(mr.detailed_merge_status)

  return {
    number: typeof mr.iid === 'number' ? mr.iid : 0,
    title: str(mr.title),
    url: str(mr.web_url),
    body: str(mr.description),
    state: state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open',
    isDraft: mr.draft === true,
    headRef: str(mr.source_branch),
    baseRef: str(mr.target_branch),
    merge: mr.has_conflicts === true ? 'conflicting' : detailed === 'not_approved' || detailed === 'discussions_not_resolved' ? 'blocked' : 'clean',
    checks: jobs.map(raw => {
      const job = obj(raw)

      return { name: str(job.name), status: jobStatusOf(str(job.status), job.allow_failure === true) }
    }),
    comments: newestFirst(comments),
  }
}

const glab = (probe: Probe, dir: string, host: string, endpoint: string) =>
  probe.run(['glab', 'api', '--hostname', host, endpoint], { cwd: dir, timeoutMs: TIMEOUT })

const readGitlab = async (probe: Probe, dir: string, remote: Remote, branch: string): Promise<PrView> => {
  const project = encodeURIComponent(remote.path)
  const found = await glab(
    probe,
    dir,
    remote.host,
    `projects/${project}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all&order_by=updated_at&per_page=1`,
  )

  if (found.exitCode !== 0) {
    return { kind: 'error', message: found.stderr.trim() || 'glab api failed' }
  }

  const iid = obj(list(parse(found.stdout))[0]).iid

  if (typeof iid !== 'number') {
    return { kind: 'none', message: 'No merge request for this branch.' }
  }

  const base = `projects/${project}/merge_requests/${iid}`
  const [detail, discussions] = await Promise.all([
    glab(probe, dir, remote.host, base),
    glab(probe, dir, remote.host, `${base}/discussions?per_page=100`),
  ])

  if (detail.exitCode !== 0) {
    return { kind: 'error', message: detail.stderr.trim() || 'glab api failed' }
  }

  const mr = obj(parse(detail.stdout))
  const pipeline = obj(mr.head_pipeline).id
  let jobs: unknown[] = []

  if (typeof pipeline === 'number') {
    const ran = await glab(probe, dir, remote.host, `projects/${project}/pipelines/${pipeline}/jobs?per_page=100`)
    jobs = ran.exitCode === 0 ? list(parse(ran.stdout)) : []
  }

  return { kind: 'pr', pr: foldGitlab(mr, discussions.exitCode === 0 ? list(parse(discussions.stdout)) : [], jobs) }
}

const readPr = async (probe: Probe, dir: string, branch: string): Promise<PrView> => {
  if (branch === '') {
    return { kind: 'none', message: 'HEAD is detached, so there is no branch to look up.' }
  }

  const origin = await git(probe, dir, ['remote', 'get-url', 'origin'])
  const remote = origin.exitCode === 0 ? parseRemote(origin.stdout) : undefined

  if (remote === undefined) {
    return { kind: 'none', message: 'No origin remote that names a GitHub or GitLab repository.' }
  }

  try {
    return platformOf(remote.host) === 'github'
      ? await readGithub(probe, dir, remote)
      : await readGitlab(probe, dir, remote, branch)
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : 'the read failed' }
  }
}

/** One full read of the worktree: branch, diff and pull request. Never rejects. */
export const readAll = async (probe: Probe, dir: string): Promise<Reading> => {
  try {
    const current = await git(probe, dir, ['branch', '--show-current'])
    const branch = current.stdout.trim()
    const [diff, pr] = await Promise.all([readDiff(probe, dir), readPr(probe, dir, branch)])

    return { branch, diff: diff.files, diffError: diff.error, pr }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'the read failed'

    return { branch: '', diff: [], diffError: message, pr: { kind: 'error', message } }
  }
}
