// The git gate's decision for one Bash command (decision 12): who runs it, what a push or a commit would name, what a
// developer owns. Pure: the host reads (the paths a developer owns, the branch that is checked out, the push settings) are
// injected, and nothing here touches `$`.
// `gitgate.ts` classifies the text. This adds what the text cannot say: a push with no destination (`git push`,
// `git push origin`, `git push origin HEAD`) goes to the branch that is checked out, which `gitAllowed` cannot know; and
// where it goes can be changed by configuration. The git role, and a lead acting as it, write to the current branch with
// `commit`, `merge`, `rebase`, `reset`, `cherry-pick`, `revert`, `am` and `pull`, so those are held to it as well.
import { PROTECTED_DEFAULT, classifyGitCommand, gitAllowed, isProtected } from './gitgate'
import type { Classified, GitActor, GitSegment } from './gitgate'

export type GitHost = {
  /** The subset of `paths` the caller owns, as the host resolves them (links followed). Asked only for a developer. */
  owned: (paths: string[]) => Promise<string[]>
  /**
   * The branch checked out where `git <dirArgs> …` runs (`dirArgs` is `[]` or `-C <dir>` pairs); `HEAD` for a detached
   * HEAD, `undefined` when git cannot say. Asked only for a push or a write that names no branch.
   */
  branch: (dirArgs: string[]) => Promise<string | undefined>
  /**
   * The `key value` lines of `git config --get-regexp` for the settings that decide where a push goes (`remote.*.push`,
   * `remote.*.mirror`, `push.default`): `[]` when none is set, `undefined` when git cannot say. Asked only for a push that names no branch.
   */
  config: (dirArgs: string[]) => Promise<string[] | undefined>
}

export type GitCall = {
  command: string
  actor: GitActor
  /** The developer's task id: its commit messages must carry `[<task>]`. Absent outside a flow. */
  task?: string
  /** Whether the git role is enabled; when it is not, the lead does what the git role does. */
  gitRole: boolean
  protected?: string[]
  /** The caller's own `classifyGitCommand(command)`. */
  found?: Classified
}

export type GitOutcome = { allow: true } | { allow: false; reason: string; summary: string }

/** What the engine tells at a spawn about where an agent works: the `cwd` the call set, and the agents that have none to read. */
export type CwdBook = { cwds: ReadonlyMap<string, string>; unknown: ReadonlySet<string> }

/**
 * The directory an agent's commands run in, for the branch and settings lookups: `undefined` is the session's (the main
 * loop, or an agent chain that set none), a string the `cwd` a spawn set, and `null` is not knowable (an agent started
 * in a worktree of its own, or one nothing in `agents` or `book` accounts for). The Bash event does not carry it.
 */
export function cwdOfAgent(agentId: string | undefined, agents: readonly { id: string; parentId?: string }[], book: CwdBook): string | null | undefined {
  let id = agentId

  for (let depth = 0; id !== undefined && depth < 8; depth += 1) {
    if (book.unknown.has(id)) {
      return null
    }

    const own = book.cwds.get(id)

    if (own !== undefined) {
      return own
    }

    const info = agents.find(agent => agent.id === id)

    if (info === undefined) {
      return null
    }

    id = info.parentId
  }

  return id === undefined ? undefined : null
}

/** Verbs that leave the checked-out branch's name as it was: a write after one of them still names the branch resolved before. */
const KEEPS_BRANCH = new Set([
  'push', 'add', 'commit', 'mv', 'rm', 'restore', 'tag', 'notes', 'stash', 'apply', 'clean', 'reset', 'merge', 'pull',
  'cherry-pick', 'revert', 'am', 'worktree', 'submodule',
])
/** What the git role writes to the current branch. */
const BRANCH_WRITES = new Set(['commit', 'merge', 'rebase', 'reset', 'cherry-pick', 'revert', 'am', 'pull', 'update-ref'])
/** The options of `rebase` whose value is the next word, which is not the branch to rebase. */
const REBASE_VALUED = ['--onto', '-x', '--exec', '-s', '--strategy', '-X', '--strategy-option']
const MAX_BRANCH_LOOKUPS = 4
const MAX_OWNED_PATHS = 200

// The pathspecs `gitgate.ts` refuses before it asks who owns them (`.`, a directory, magic, a glob, a climb out): no host lookup for them.
const isPlain = (path: string) => path !== '.' && path !== '..' && !path.endsWith('/') && !path.startsWith(':') && !path.startsWith('../') && !/[*?[]/.test(path)

/** Whether the line runs any git or forge command, or hides one: the gate has nothing to say about the rest. */
export function usesGit(input: string | Classified): boolean {
  const found = typeof input === 'string' ? classifyGitCommand(input) : input

  return found.segments.length > 0 || found.forges.length > 0 || found.opaque
}

const ROLE_ACTORS: Record<string, GitActor> = {
  git: 'git', developer: 'developer', ux: 'ux', 'code-reader': 'code-reader', 'docs-reader': 'docs-reader', architect: 'architect', qa: 'qa',
}

/**
 * The actor an agent is, by its type, when no task links it: a Pantheon role by its name (the read-only ones are read-only),
 * a council seat as read-only, and every other agent (general-purpose, Explore, a type the engine does not list) as the lead,
 * whose push rules are the least any agent gets.
 */
export function actorOfType(type: string | undefined): GitActor {
  if (type === undefined || !type.startsWith('pantheon:')) return 'lead'
  const name = type.slice('pantheon:'.length)

  return name.startsWith('councillor-') ? 'councillor' : ROLE_ACTORS[name] ?? 'lead'
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`)

/** `git push, gh pr`: what the line runs, without its arguments (they may hold a URL with a credential). */
function summaryOf(found: Classified): string {
  const names = [
    ...found.segments.map(segment => `git ${segment.verb}`.trim()),
    ...found.forges.map(forge => `${forge.tool} ${forge.group}`.trim()),
    ...(found.opaque ? ['hidden git'] : []),
  ]

  return clip([...new Set(names)].slice(0, 8).join(', '), 200)
}

/** The `-C <dir>` pairs of the options before the verb, or undefined when another option could change which repository git reads. */
function dirArgsOf(global: readonly string[]): string[] | undefined {
  const dirs: string[] = []

  for (let at = 0; at < global.length; at += 1) {
    const option = global[at] ?? ''

    if (option === '-C') {
      dirs.push('-C', global[at + 1] ?? '.')
      at += 1
    } else if (option !== '-P' && option !== '--no-pager') {
      return undefined
    }
  }

  return dirs
}

/**
 * What a push leaves to git. A refspec with no `:dst` (and a push with none at all) does not say where it goes, so the push
 * settings can send it elsewhere (`remote.*.push`, `push.default=upstream` on a branch that tracks another): `settings`. Of
 * those, no refspec at all, or `HEAD` or `@` alone, also names no branch: `current`. `src:dst` written out leaves nothing.
 */
function pushShape(segment: GitSegment): { current: boolean; settings: boolean } {
  const longs = segment.flags.filter(flag => flag.startsWith('--'))
  // git takes unambiguous prefixes of long options (as `gitgate.ts` reads them).
  const hasLong = (name: string) => longs.some(flag => flag === name || (flag.length >= 4 && name.startsWith(flag)))
  const refspecs = hasLong('--repo') ? segment.positional : segment.positional.slice(1)

  if (refspecs.length === 0) {
    // `--tags` alone pushes only the tags.
    const isTagsOnly = hasLong('--tags')

    return { current: !isTagsOnly, settings: !isTagsOnly }
  }

  let current = false
  let settings = false

  for (const refspec of refspecs) {
    const colon = refspec.indexOf(':')
    const source = colon === -1 ? refspec : refspec.slice(0, colon)
    const target = colon === -1 ? '' : refspec.slice(colon + 1)

    if (target === '') {
      settings = true
      current ||= source === 'HEAD' || source === '@'
    }
  }

  return { current, settings }
}

/** The branch the line has just made current, when its text says so: `checkout -b X`, `switch -c X`, `switch X`. */
function namedAfter(segment: GitSegment): string | undefined {
  if (segment.hasUnknown) {
    return undefined
  }

  const after = (...names: string[]) => {
    const at = segment.args.findIndex(arg => names.includes(arg))

    return at === -1 ? undefined : segment.args[at + 1]
  }

  if (segment.verb === 'checkout') {
    return after('-b', '-B')
  }

  if (segment.verb === 'switch') {
    return after('-c', '-C', '--create', '--force-create') ?? (segment.flags.length === 0 && segment.positional.length === 1 && segment.positional[0] !== '-' ? segment.positional[0] : undefined)
  }

  return undefined
}

type Need = {
  /** The git command the need belongs to, for the message. */
  verb: string
  dirArgs: string[]
  /** It writes to the current branch, whose name is needed. */
  branch: boolean
  /** Where it goes depends on the push settings (a push that does not write `src:dst`). */
  settings: boolean
  /** The branch the line itself made current: nothing to look up. */
  named?: string
  /** Why the need cannot be met; it is denied. */
  unsure?: string
}

const NAME_IT = 'name the branch: `git push <remote> <branch>`'
const WRITE_IT = 'write the destination out: `git push <remote> <src>:<dst>`'

/**
 * What the line needs the repository for, in order. A push needs the push settings unless it writes `src:dst`, and the
 * current branch when it names none; with `writes` (the git role, or a lead acting as it) a commit, merge, rebase, reset,
 * cherry-pick, revert, am, pull or `update-ref HEAD` needs the current branch. The line is followed: `checkout -b X`,
 * `switch -c X` and `switch X` make X the branch for what comes after, but only when `&&` joins them (after `;`, `||`, a pipe
 * or a newline the change may have failed); any other branch-changing git makes it unknown, and so does anything that makes
 * the directory unreadable.
 */
function branchNeeds(segments: readonly GitSegment[], writes: boolean): Need[] {
  const needs: Need[] = []
  // What the line has done to the branch, per directory (`-C`): a name it set, or why it is no longer known.
  const current = new Map<string, { name: string } | { why: string }>()
  let wild: string | undefined

  for (const segment of segments) {
    if (segment.before !== '&&' && segment.before !== '') {
      for (const [place, state] of current) {
        if ('name' in state) {
          current.set(place, { why: 'a branch change that is not joined to it by `&&` (it may have failed)' })
        }
      }
    }

    const dirArgs = dirArgsOf(segment.global)
    const where = dirArgs?.join('\0')
    const { verb } = segment
    const label = `git ${verb}`
    const isUsable = !segment.uncertain && dirArgs !== undefined && where !== undefined
    let branch = false
    let settings = false
    let unsure: string | undefined

    if (verb === 'push') {
      if (segment.hasUnknown) {
        unsure = `A word of this \`git push\` is not literal (a variable or a substitution), so it could name a protected branch; ${NAME_IT}, written out.`
      } else {
        ;({ current: branch, settings } = pushShape(segment))
      }
    } else if (writes && BRANCH_WRITES.has(verb)) {
      if (verb === 'update-ref') {
        branch = segment.positional.some(word => word === 'HEAD' || word === '@')
      } else if (verb === 'rebase') {
        // `git rebase <upstream> <branch>` switches to <branch> first: more than the upstream is a branch this cannot follow.
        const valued = segment.args.filter(arg => REBASE_VALUED.includes(arg)).length

        if (segment.positional.length - valued > 1) {
          unsure = '`git rebase` names the branch to rebase; check that branch out in its own command first.'
        } else {
          branch = true
        }
      } else {
        branch = true
      }
    }

    const state = isUsable && where !== undefined ? current.get(where) : undefined
    const how = verb === 'push' ? (branch ? NAME_IT : WRITE_IT) : 'run it in its own command'

    if (unsure !== undefined) {
      needs.push({ verb: label, dirArgs: [], branch: false, settings: false, unsure })
    } else if (branch || settings) {
      if (!isUsable) {
        needs.push({ verb: label, dirArgs: [], branch: false, settings: false, unsure: `\`${label}\` depends on the repository, and the directory or repository it runs in cannot be read from the text (\`cd\`, a variable, \`--git-dir\`); run it from the repository root in its own command and ${how}.` })
      } else if (branch && wild !== undefined) {
        needs.push({ verb: label, dirArgs: [], branch: false, settings: false, unsure: `\`${label}\` writes to the current branch, which cannot be known after \`${wild}\` earlier on the line; ${how}.` })
      } else if (branch && state !== undefined && 'why' in state) {
        needs.push({ verb: label, dirArgs: [], branch: false, settings: false, unsure: `\`${label}\` writes to the current branch, which cannot be known after ${state.why.startsWith('a ') ? state.why : `\`${state.why}\``} earlier on the line; ${how}.` })
      } else {
        needs.push({ verb: label, dirArgs: dirArgs ?? [], branch, settings, ...(branch && state !== undefined && 'name' in state ? { named: state.name } : {}) })
      }
    }

    // What this command does to the branch for the ones that follow.
    if (segment.changesState && !KEEPS_BRANCH.has(verb)) {
      const named = namedAfter(segment)

      if (isUsable && where !== undefined) {
        current.set(where, named === undefined ? { why: label } : { name: named })
      } else {
        wild ??= label
      }
    }
  }

  return needs
}

/** The branch as a push would name it: `refs/heads/` and `heads/` (what `--abbrev-ref` prints for an ambiguous name) dropped. */
const branchName = (raw: string | undefined) => raw?.trim().replace(/^refs\/heads\//, '').replace(/^heads\//, '')

/** Why the configuration makes a bare push unreadable, or undefined when it is plain (`simple`, `current` or unset, no refspec). */
function pushConfigWhy(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const space = line.search(/\s/)
    const key = (space === -1 ? line : line.slice(0, space)).toLowerCase()
    const value = (space === -1 ? '' : line.slice(space + 1)).trim().toLowerCase()

    if (/^remote\..+\.push$/.test(key)) {
      return `the remote is configured to push \`${clip(value, 80)}\` (${key})`
    }

    if (/^remote\..+\.mirror$/.test(key) && !/^(false|no|off|0)$/.test(value)) {
      return `the remote is a mirror (${key})`
    }

    if (key === 'push.default' && ['upstream', 'tracking', 'matching'].includes(value)) {
      return `\`push.default\` is \`${value}\``
    }
  }

  return undefined
}

/**
 * Whether `call.actor` may run `call.command`. `gitAllowed` decides the text; then, for the lead (and the git role), a push
 * that names no destination is held to the branch that is checked out (`host.branch`) and to the push configuration
 * (`host.config`): a protected branch is denied, and so is one that cannot be read (detached HEAD, git failing, a `cd` or a
 * branch change on the line) or a configuration that sends the push elsewhere. The git role, and a lead acting as it, are
 * held to the current branch for what writes to it. A developer's commit must carry its task id.
 */
export async function gitGate(call: GitCall, host: GitHost): Promise<GitOutcome> {
  const { actor, command } = call
  const found = call.found ?? classifyGitCommand(command)
  const summary = summaryOf(found)
  const deny = (reason: string): GitOutcome => ({ allow: false, reason, summary })
  const isDev = actor === 'developer' || actor === 'ux'
  const names = call.protected ?? PROTECTED_DEFAULT

  const paths = isDev ? [...new Set(found.segments.flatMap(segment => segment.paths))].filter(isPlain).slice(0, MAX_OWNED_PATHS) : []
  const owned = new Set(paths.length > 0 ? await host.owned(paths) : [])
  const verdict = gitAllowed(actor, command, path => owned.has(path), { gitRole: call.gitRole, found, ...(call.protected ? { protected: call.protected } : {}) })

  if (!verdict.allow) {
    return deny(verdict.reason)
  }

  if (isDev && call.task !== undefined) {
    const tag = `[${call.task}]`

    for (const segment of found.segments) {
      // The task id belongs in the commit's own text (`-m`), not in an `--author` or a trailer.
      if (segment.verb === 'commit' && segment.changesState && !(segment.text ?? []).some(text => text.includes(tag))) {
        return deny(`Put the task id in the commit message, \`-m "<type>(<scope>): <summary> ${tag}"\`, so the commit can be traced to its task.`)
      }
    }
  }

  if (actor === 'lead' || actor === 'git') {
    const needs = branchNeeds(found.segments, actor === 'git' || !call.gitRole)
    const looked = new Map<string, string | undefined>()
    const configs = new Map<string, string>()

    for (const need of needs) {
      if (need.unsure) {
        return deny(need.unsure)
      }

      const key = need.dirArgs.join('\0')

      if (need.branch) {
        const how = need.verb === 'git push' ? NAME_IT : 'run it on a named branch, in its own command'
        let branch = need.named

        if (branch === undefined) {
          if (!looked.has(key)) {
            if (looked.size >= MAX_BRANCH_LOOKUPS) {
              return deny(`This line works in more than ${MAX_BRANCH_LOOKUPS} places without naming a branch; ${how}.`)
            }

            looked.set(key, branchName(await host.branch(need.dirArgs)))
          }

          branch = looked.get(key)
        }

        if (!branch || branch === 'HEAD') {
          return deny(`\`${need.verb}\` writes to the current branch, and Pantheon could not tell which one that is (detached HEAD, git failed here, or an agent that works in a directory it cannot read); ${how}.`)
        }

        if (isProtected(branch, names)) {
          return deny(`\`${need.verb}\` here writes to the current branch \`${branch}\`, a protected branch (${names.join(', ')}); work on a feature branch and open a PR/MR instead.`)
        }
      }

      // Where a push that does not write `src:dst` goes is also decided by the push settings, which the text does not show.
      if (need.settings) {
        let why = configs.get(key)

        if (why === undefined) {
          const lines = await host.config(need.dirArgs)

          why = lines === undefined ? 'the push settings could not be read' : pushConfigWhy(lines) ?? ''
          configs.set(key, why)
        }

        if (why) {
          return deny(`\`git push\` does not write its destination out, and where it goes depends on the push configuration (${why}); ${need.branch ? NAME_IT : WRITE_IT}.`)
        }
      }
    }
  }

  return { allow: true }
}
