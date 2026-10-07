import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { BranchGuardReport } from '../types'
import { PROTECTED } from './classify'
import type { Risk } from './classify'
import { locate, resolve } from './shell'

/** What the check needs from the host; the hooks module owns `$` and hands it over this way. */
export type Probe = {
  run: (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>
  home: () => Promise<string | undefined>
  /** The path with every symlink resolved; `undefined` when it does not exist. */
  real: (path: string) => Promise<string | undefined>
}

type Part = { summary: string; lines: string[]; note?: string }

const KEPT_LINES = 40

const GIT_MS = 15_000

const rows = (text: string) => text.split('\n').filter(line => line.trim() !== '')

const count = (many: number, one: string, plural = `${one}s`) => `${many} ${many === 1 ? one : plural}`

// A command that fails to run (git missing, timeout) becomes `undefined`, never a hook error.
const out = async (probe: Probe, argv: readonly string[], cwd: string) => {
  try {
    const ran = await probe.run(argv, { cwd, timeoutMs: GIT_MS })

    return ran.exitCode === 0 ? ran.stdout.trimEnd() : undefined
  } catch {
    return undefined
  }
}

// Where everything is disposable, and from which level below the root on: in /var/folders the
// each user's temp directory is xx/<hash>/T, so only what is inside it counts.
const TEMP_ROOTS = [
  { root: '/tmp', floor: 1 },
  { root: '/private/tmp', floor: 1 },
  { root: '/var/folders', floor: 4 },
  { root: '/private/var/folders', floor: 4 },
]

// Claude Code's own temp directory holds scratchpads and skills for all sessions.
const SHARED = /^claude-[^/]*$/

const isInTemp = (real: string) =>
  TEMP_ROOTS.some(({ root, floor }) => {
    const below = real.startsWith(`${root}/`) ? real.slice(root.length + 1).split('/') : []

    return below.length >= floor && !(below.length === 1 && SHARED.test(below[0] ?? ''))
  })

// A target that does not exist counts where its parent really is.
const realOf = async (probe: Probe, path: string) => {
  const cut = path.lastIndexOf('/')
  const real = await probe.real(path)
  const parent = real === undefined && cut > 0 ? await probe.real(path.slice(0, cut)) : undefined

  return real ?? (parent === undefined ? undefined : `${parent}${path.slice(cut)}`)
}

// The whole repository in a temp directory: the working tree and the common .git.
const isTempRepo = async (probe: Probe, dir: string) => {
  const asked = await out(probe, ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], dir)
  const places = rows(asked ?? '')

  for (const place of places) {
    const real = await realOf(probe, place)

    if (real === undefined || !isInTemp(real)) {
      return false
    }
  }

  return places.length === 2
}

// The branch the push would update, by refspec: `src`, `src:dst`, `:dst`, `refs/heads/x`.
const pushed = (risk: Risk & { kind: 'publish' }, here: string, upstream: string | undefined) => {
  if (risk.refspecs.length === 0) {
    const tracked = risk.remote === undefined ? upstream?.replace(/^[^/]+\//, '') : undefined
    const names = [here, tracked].flatMap(name => (name === undefined || name === '' || name === 'unknown' ? [] : [name]))

    return [...new Set(names)].map(name => ({ local: 'HEAD', name }))
  }

  return risk.refspecs.flatMap(spec => {
    const [src = '', dst] = spec.split(':')
    const raw = (dst ?? src).replace(/^refs\/heads\//, '')
    const name = raw === 'HEAD' ? here : raw

    return name === '' || name === 'unknown' ? [] : [{ local: src === '' ? undefined : src, name }]
  })
}

const upstreamOf = (probe: Probe, dir: string) => out(probe, ['git', 'rev-parse', '--abbrev-ref', '@{u}'], dir)

const currentOf = (probe: Probe, risk: Risk, dir: string) =>
  risk.branchAfter === undefined ? out(probe, ['git', 'branch', '--show-current'], dir) : Promise.resolve(risk.branchAfter)

/** A commit or push whose target branch is protected; everything else passes without asking. */
export const isProtectedTarget = async (probe: Probe, risk: Risk, cwd: string): Promise<boolean> => {
  const dir = locate(cwd, risk.dir, await probe.home())

  if (risk.isAdrift === true || risk.isElsewhere || dir === undefined || (await isTempRepo(probe, dir))) {
    return false
  }

  const here = (await currentOf(probe, risk, dir)) ?? ''

  if (risk.kind === 'commit') {
    if (here === '' || here === 'unknown') {
      return false
    }

    // With nothing staged git refuses the commit: there is nothing to hold.
    const isSure = risk.isAll || risk.isAmend || risk.isAllowEmpty || risk.hasPathspec || risk.stagesFirst
    const staged = isSure ? 'sure' : await out(probe, ['git', 'diff', '--cached', '--name-only'], dir)

    return staged !== undefined && staged !== '' && PROTECTED.test(here)
  }

  if (risk.isAllRefs || risk.hasUnknownRef) {
    return true
  }

  const upstream = risk.refspecs.length === 0 && risk.remote === undefined ? await upstreamOf(probe, dir) : undefined

  return pushed(risk, here, upstream).some(target => PROTECTED.test(target.name))
}

const measureCommit = async (probe: Probe, risk: Risk & { kind: 'commit' }, dir: string): Promise<Part> => {
  const branch = (await currentOf(probe, risk, dir)) || 'HEAD'
  const isIndex = !(risk.isAll || risk.stagesFirst || risk.hasPathspec)
  const files = isIndex
    ? rows((await out(probe, ['git', 'diff', '--cached', '--name-only'], dir)) ?? '')
    : rows((await out(probe, ['git', 'status', '--porcelain'], dir)) ?? '').filter(
        line => risk.stagesFirst || !line.startsWith('??'),
      )
  const stat = isIndex ? ((await out(probe, ['git', 'diff', '--cached', '--shortstat'], dir)) ?? '').trim() : ''

  if (risk.isAmend) {
    return {
      summary: `rewrite the last commit on ${branch}${files.length > 0 ? ` with ${count(files.length, 'more file')}` : ''}`,
      lines: files,
      ...(stat !== '' && { note: stat }),
    }
  }

  return {
    summary:
      files.length === 0
        ? `commit directly on ${branch}, with no changes I can see`
        : `commit ${count(files.length, 'file')} directly on ${branch}`,
    lines: files,
    ...(stat !== '' && { note: stat }),
  }
}

const measurePublish = async (probe: Probe, risk: Risk & { kind: 'publish' }, dir: string): Promise<Part> => {
  if (risk.isAllRefs) {
    return { summary: 'push all local branches to the remote (--all/--mirror)', lines: [] }
  }

  const here = (await currentOf(probe, risk, dir)) || 'HEAD'
  const upstream = await upstreamOf(probe, dir)
  const remote = risk.remote ?? upstream?.split('/')[0] ?? 'origin'
  const targets = pushed(risk, here, risk.refspecs.length === 0 && risk.remote === undefined ? upstream : undefined)
  const commits: string[] = []
  const notes: string[] = []

  for (const target of targets) {
    const ref = `${remote}/${target.name}`

    if (target.local === undefined && risk.refspecs.length > 0) {
      notes.push(`${ref}: will be deleted`)
      continue
    }

    const log = await out(probe, ['git', 'log', '--oneline', `${ref}..${target.local ?? 'HEAD'}`], dir)

    if (log === undefined) {
      notes.push(`${ref}: unknown ref here, nothing to compare`)
    } else {
      commits.push(...rows(log))
    }
  }

  if (risk.hasUnknownRef) {
    notes.push('target not measured (only the shell knows which it is)')
  }

  const names = targets.map(target => `${remote}/${target.name}`).join(', ') || remote

  return {
    summary:
      commits.length > 0
        ? `push ${count(commits.length, 'commit')} to ${names}`
        : `push nothing new to ${names} (compared without fetch)`,
    lines: [...notes, ...commits],
  }
}

const measureOne = (probe: Probe, risk: Risk, dir: string): Promise<Part> =>
  risk.kind === 'commit' ? measureCommit(probe, risk, dir) : measurePublish(probe, risk, dir)

/** What the commits and pushes would do, measured with git itself. */
export const measure = async (
  probe: Probe,
  risks: readonly Risk[],
  cwd: string,
): Promise<BranchGuardReport> => {
  const parts: Part[] = []
  const home = await probe.home()

  for (const risk of risks) {
    parts.push(await measureOne(probe, risk, locate(cwd, risk.dir, home) ?? resolve(cwd, risk.dir)))
  }

  const lines = parts.flatMap(part => part.lines)
  const titles = risks.map(risk => (risk.kind === 'commit' ? 'git commit' : 'git push'))

  return {
    title: [...new Set(titles)].join(' + '),
    notes: parts.flatMap(part => part.note ?? []),
    summary: parts.map(part => part.summary).join('; '),
    lines: lines.slice(0, KEPT_LINES),
    total: lines.length,
  }
}
