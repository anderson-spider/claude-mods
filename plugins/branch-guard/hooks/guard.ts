import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { BranchGuardReport } from '../types'

// The parser, `resolve`, `locate` and the temp repository check are trimmed copies of those
// in plugins/blast-radius/hooks/risk.ts: a plugin does not import code from another. A fix
// there must be carried over here.

/** A word of the command, already unquoted, and what the shell would still do with it. */
export type Word = {
  text: string
  /** Has `$`, a backtick or braces: only the shell knows what it becomes. */
  isUnknown: boolean
  /** Has `~` outside quotes. */
  isHome: boolean
}

export type Risk = {
  dir: string
  /** An unreadable `cd` came before: `dir` is not reliable. */
  isAdrift?: boolean
  /** A --git-dir or --work-tree points git outside `dir`. */
  isElsewhere: boolean
  /** The branch a `checkout`/`switch` on the same line leaves active; `unknown` when the text does not reveal it. */
  branchAfter?: string
} & (
  | {
      kind: 'commit'
      isAll: boolean
      isAmend: boolean
      isAllowEmpty: boolean
      hasPathspec: boolean
      /** A `git add` came earlier on the line: the current index is not the commit's. */
      stagesFirst: boolean
    }
  | {
      kind: 'publish'
      remote: string | undefined
      refspecs: string[]
      isAllRefs: boolean
      hasUnknownRef: boolean
    }
)

/** What the check needs from the host; the hooks module owns `$` and hands it over this way. */
export type Probe = {
  run: (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>
  home: () => Promise<string | undefined>
  /** The path with every symlink resolved; `undefined` when it does not exist. */
  real: (path: string) => Promise<string | undefined>
}

type Part = { summary: string; lines: string[]; note?: string }

/** The branches where a direct commit or push deserves a question. */
export const PROTECTED = /^(main|master|develop|release([/_-].*)?)$/

const KEPT_LINES = 40
const GIT_MS = 15_000
const BREAKS = new Set([';', '\n', '(', ')'])
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env'])
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s
const IN_HOME = /^~(\/|$)/
const SEQUENCE = new Set(['', ';', '\n', '&&'])
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', '{', '}'])
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix'])
const STAGERS = new Set(['add', 'rm', 'mv', 'apply'])
const COMMIT_SHORT = 'mFCct'
const COMMIT_LONG = [
  '--message',
  '--file',
  '--author',
  '--date',
  '--template',
  '--reuse-message',
  '--reedit-message',
  '--fixup',
  '--squash',
  '--cleanup',
  '--trailer',
  '--pathspec-from-file',
]
const PUSH_LONG = ['--push-option', '--repo', '--receive-pack', '--exec']
const FORCES = ['-f', '--force', '--force-with-lease', '--force-if-includes']

type Command = { words: Word[]; /** The separator that came before: `;`, `&&`, `|`, `(`… */ before: string }

// The simple commands on the line, empty ones included, each with the separator before it.
const parse = (command: string): Command[] => {
  const commands: Command[] = [{ words: [], before: '' }]
  let text = ''
  let isOpen = false
  let isUnknown = false
  let isHome = false
  let quote: string | undefined

  const endWord = () => {
    if (isOpen) {
      commands.at(-1)?.words.push({ text, isUnknown, isHome })
    }

    text = ''
    isOpen = false
    isUnknown = false
    isHome = false
  }
  const endCommand = (before: string) => {
    endWord()
    commands.push({ words: [], before })
  }

  for (let at = 0; at < command.length; at += 1) {
    const char = command[at] ?? ''
    const following = command[at + 1] ?? ''

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      } else if (char === '\\' && quote === '"') {
        text += following
        at += 1
      } else {
        isUnknown ||= quote === '"' && (char === '$' || char === '`')
        text += char
      }
    } else if (char === "'" || char === '"') {
      quote = char
      isOpen = true
    } else if (char === '\\') {
      text += following === '\n' ? '' : following
      isOpen ||= following !== '\n'
      at += 1
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else if (BREAKS.has(char)) {
      endCommand(char)
    } else if (char === '|' || (char === '&' && !text.endsWith('>') && following !== '>')) {
      const isDouble = following === '|' || following === '&'
      endCommand(isDouble ? `${char}${following}` : char)
      at += isDouble ? 1 : 0
    } else {
      isHome ||= char === '~' && !isOpen
      isUnknown ||= char === '$' || char === '`' || char === '{'
      text += char
      isOpen = true
    }
  }

  endWord()

  return commands
}

/** `path` from `base`, with no `.` or `..` in the middle. */
export const resolve = (base: string, path: string): string => {
  const whole = path.startsWith('/') ? path : `${base}/${path}`
  const isAbsolute = whole.startsWith('/')
  const parts: string[] = []

  for (const part of whole.split('/')) {
    if (part === '..' && (isAbsolute || (parts.length > 0 && parts.at(-1) !== '..'))) {
      parts.pop()
    } else if (part !== '' && part !== '.') {
      parts.push(part)
    }
  }

  return `${isAbsolute ? '/' : ''}${parts.join('/')}` || '.'
}

// `dir` after a `cd to`; a destination in the home stays as `~/…` until someone knows where it is.
const enter = (dir: string, to: string) => resolve(IN_HOME.test(to) ? '.' : dir, to)

/** Where `dir` really is: from the home when it starts with `~`, otherwise from `cwd`. */
export const locate = (cwd: string, dir: string, home: string | undefined): string | undefined => {
  if (!IN_HOME.test(dir)) {
    return resolve(cwd, dir)
  }

  return home === undefined ? undefined : resolve(home, `.${dir.slice(1)}`)
}

const bare = (words: readonly Word[]) => {
  let start = 0

  for (; start < words.length; start += 1) {
    const text = words[start]?.text ?? ''

    if (!ASSIGNMENT.test(text) && !WRAPPERS.has(text)) {
      break
    }
  }

  return words.slice(start)
}

/** Splits flags from loose arguments; `shortValued` and `longValued` take a value next to them. */
const scan = (args: readonly Word[], shortValued: string, longValued: readonly string[]) => {
  const flags = new Set<string>()
  const positional: Word[] = []

  for (let at = 0; at < args.length; at += 1) {
    const word = args[at]
    const text = word?.text ?? ''

    if (word === undefined) {
      continue
    }

    if (text === '--') {
      positional.push(...args.slice(at + 1))
      break
    }

    if (text.startsWith('--')) {
      const [flag = ''] = text.split('=')

      flags.add(flag)
      at += !text.includes('=') && longValued.includes(flag) ? 1 : 0
    } else if (text.startsWith('-') && text.length > 1) {
      for (let index = 1; index < text.length; index += 1) {
        const letter = text[index] ?? ''

        flags.add(`-${letter}`)

        if (shortValued.includes(letter)) {
          at += index === text.length - 1 ? 1 : 0
          break
        }
      }
    } else {
      positional.push(word)
    }
  }

  return { flags, positional }
}

type State = {
  dir: string
  isAdrift: boolean
  branch: string | undefined
  isStaged: boolean
  isStraight: boolean
}

// Where a `checkout`/`switch` leaves the person: the name when the text reveals it, `unknown` when not.
const move = (state: State, sub: string, args: readonly Word[], isSure: boolean) => {
  const makers = ['-b', '-B', '-c', '-C', '--orphan', '--create', '--force-create']
  const at = args.findIndex(arg => makers.includes(arg.text))
  const named = at >= 0 ? args[at + 1] : undefined
  const plain = args.filter(arg => !arg.text.startsWith('-') || arg.text === '-')
  // A bare `checkout` may be of a file; only a protected branch by name counts as a switch.
  const loose = sub === 'switch' || PROTECTED.test(plain[0]?.text ?? '') ? plain[0] : undefined
  const target = at >= 0 ? named : args.some(arg => arg.text === '--') ? undefined : loose

  if (target === undefined) {
    return
  }

  state.branch = isSure && !target.isUnknown && target.text !== '-' ? target.text : 'unknown'
}

const git = (state: State, words: readonly Word[], isSure: boolean): Risk | undefined => {
  let at = 0
  let where = state.dir
  let isElsewhere = false

  while ((words[at]?.text ?? '').startsWith('-')) {
    const flag = words[at]?.text ?? ''

    isElsewhere ||= /^--(git-dir|work-tree)\b/.test(flag)
    where = flag === '-C' ? enter(where, words[at + 1]?.text ?? '.') : where
    at += GIT_VALUED.has(flag) ? 2 : 1
  }

  const sub = words[at]?.text ?? ''
  const args = words.slice(at + 1)
  const base = { dir: where, isElsewhere, ...(state.branch === undefined ? {} : { branchAfter: state.branch }) }

  if (STAGERS.has(sub)) {
    state.isStaged = true

    return undefined
  }

  if (sub === 'checkout' || sub === 'switch') {
    move(state, sub, args, isSure)

    return undefined
  }

  if (sub === 'commit') {
    const { flags, positional } = scan(args, COMMIT_SHORT, COMMIT_LONG)

    return flags.has('--dry-run')
      ? undefined
      : {
          ...base,
          kind: 'commit',
          isAll: flags.has('--all') || flags.has('-a'),
          isAmend: flags.has('--amend'),
          isAllowEmpty: flags.has('--allow-empty'),
          hasPathspec: positional.length > 0,
          stagesFirst: state.isStaged,
        }
  }

  if (sub === 'push') {
    const { flags, positional } = scan(args, 'o', PUSH_LONG)
    // Force push and dry run are not handled here: the first belongs to blast-radius, the second sends nothing.
    const isOther = [...FORCES, '-n', '--dry-run'].some(flag => flags.has(flag)) || positional.some(word => word.text.startsWith('+'))

    if (isOther) {
      return undefined
    }

    const named: Word[] = []

    for (let index = 1; index < positional.length; index += 1) {
      const word = positional[index]

      if (word?.text === 'tag') {
        index += 1
      } else if (word !== undefined && !word.text.startsWith('refs/tags/')) {
        named.push(word)
      }
    }

    // Only tags going out: touches no branch.
    if ((flags.has('--tags') || positional.some(word => word.text === 'tag') || positional.slice(1).some(word => word.text.startsWith('refs/tags/'))) && named.length === 0) {
      return undefined
    }

    return {
      ...base,
      kind: 'publish',
      remote: positional[0]?.text,
      refspecs: named.map(word => word.text),
      isAllRefs: flags.has('--all') || flags.has('--mirror') || flags.has('--branches'),
      hasUnknownRef: named.some(word => word.isUnknown),
    }
  }

  return undefined
}

/** The commits and pushes the command line carries, in order; empty for everything else. */
export const classify = (command: string): Risk[] => {
  const risks: Risk[] = []
  const parsed = parse(command)
  // With `if`, `for` and the like, the text alone cannot tell which branch switches run.
  const isStraight = !parsed.some(one => KEYWORDS.has(one.words[0]?.text ?? ''))
  const state: State = { dir: '.', isAdrift: false, branch: undefined, isStaged: false, isStraight }

  for (const [at, one] of parsed.entries()) {
    const argv = bare(one.words)
    const name = (argv[0]?.text ?? '').split('/').at(-1)
    const args = argv.slice(1)

    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      const to = args[0]?.text ?? ''
      // A quoted `~` is a folder name, and `~someone` is another person's home.
      const isHomePath = args[0]?.isHome === true && IN_HOME.test(to)
      const isKnown =
        name === 'cd' && args.length === 1 && args[0]?.isUnknown === false && to !== '-' && (isHomePath || !to.startsWith('~'))

      state.isAdrift = isKnown ? state.isAdrift && !to.startsWith('/') && !isHomePath : true
      state.dir = isKnown ? enter(state.dir, to) : state.dir
    } else if (name === 'git') {
      const isSure = state.isStraight && SEQUENCE.has(one.before) && SEQUENCE.has(parsed[at + 1]?.before ?? '')
      const risk = git(state, args, isSure)

      if (risk !== undefined) {
        risks.push(state.isAdrift ? { ...risk, isAdrift: true } : risk)
      }
    }
  }

  return risks
}

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
