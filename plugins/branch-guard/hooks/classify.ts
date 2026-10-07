import { bare, enter, IN_HOME, parse } from './shell'
import type { Word } from './shell'

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

/** The branches where a direct commit or push deserves a question. Shared with measure.ts, which decides on the same pattern. */
export const PROTECTED = /^(main|master|develop|release([/_-].*)?)$/

const SEQUENCE = new Set(['', ';', '\n', '&&'])

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function'])

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

type Base = Pick<Risk, 'dir' | 'isElsewhere' | 'branchAfter'>

const commitRisk = (base: Base, args: readonly Word[], state: State): Risk | undefined => {
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

// The refs a push names after the remote, without the tags: `tag <name>` and `refs/tags/...` touch no branch.
const branchRefs = (positional: readonly Word[]): Word[] => {
  const named: Word[] = []

  for (let index = 1; index < positional.length; index += 1) {
    const word = positional[index]

    if (word?.text === 'tag') {
      index += 1
    } else if (word !== undefined && !word.text.startsWith('refs/tags/')) {
      named.push(word)
    }
  }

  return named
}

const pushRisk = (base: Base, args: readonly Word[]): Risk | undefined => {
  const { flags, positional } = scan(args, 'o', PUSH_LONG)
  // Force push and dry run are not handled here: the first is left alone on purpose, the second sends nothing.
  const isOther = [...FORCES, '-n', '--dry-run'].some(flag => flags.has(flag)) || positional.some(word => word.text.startsWith('+'))

  if (isOther) {
    return undefined
  }

  const named = branchRefs(positional)

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
  } else if (sub === 'checkout' || sub === 'switch') {
    move(state, sub, args, isSure)
  } else if (sub === 'commit') {
    return commitRisk(base, args, state)
  } else if (sub === 'push') {
    return pushRisk(base, args)
  }

  return undefined
}

/**
 * The commits and pushes the command line carries, in order; empty for everything else.
 * A safety net that reads text, not a permission system: aliases, scripts and variables that hold commands get through. The commands inside `$(…)`, backticks and `<(…)` are read as if run on their own.
 */
export const classify = (command: string): Risk[] => {
  const risks: Risk[] = []
  const parsed = parse(command)
  // With `if`, `for` and the like, the text alone cannot tell which branch switches run.
  const isStraight = !parsed.some(one => KEYWORDS.has(one.words[0]?.text ?? ''))
  const state: State = { dir: '.', isAdrift: false, branch: undefined, isStaged: false }

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
      const isSure = isStraight && SEQUENCE.has(one.before) && SEQUENCE.has(parsed[at + 1]?.before ?? '')
      const risk = git(state, args, isSure)

      if (risk !== undefined) {
        risks.push(state.isAdrift ? { ...risk, isAdrift: true } : risk)
      }
    }
  }

  return risks
}
