// The git gate: which git a given actor may run through Bash. Pure: no `$`, no host calls; the caller decides what a denial does.
// A safety net that reads text, not a permission system: aliases, scripts and variables that hold commands get through,
// except that anything that hides a `git` from the parser (eval, `bash -c "$x"`, xargs…) counts as opaque and fails closed.
// The shell parser below (down to "Classification") is adapted from branch-guard's shell.ts, trimmed of its path helpers.
import type { Role } from '../types'

/** A word of the command, already unquoted, and what the shell would still do with it. */
type Word = {
  text: string
  /** Has `$`, a backtick or braces: only the shell knows what it becomes (the commands inside a substitution are parsed apart). */
  isUnknown: boolean
  /** Has `~` outside quotes. */
  isHome: boolean
}

const BREAKS = new Set([';', '\n', '(', ')'])

const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env'])

// Words that open a command without being part of it: `{ git commit; }`, `if …; then git commit; fi`.
const OPENERS = new Set(['{', '!', 'if', 'then', 'else', 'elif', 'while', 'until', 'do'])

// An unquoted redirection operator (`>`, `>>`, `2>`, `&>`, `>&`, `<`…), with the target when it is attached (`>log`, `2>&1`).
const REDIRECTION = /^(?:\d*|&)(?:>>?|<)&?(.*)$/s

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s


// The word that closes a heredoc, unquoted, and where it ends; the shell reads it up to the next blank or operator.
const delimiterAt = (command: string, from: number) => {
  let word = ''
  let at = from
  let quote: string | undefined

  for (; at < command.length; at += 1) {
    const char = command[at] ?? ''

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      } else {
        word += char
      }
    } else if (char === "'" || char === '"') {
      quote = char
    } else if (char === '\\') {
      word += command[at + 1] ?? ''
      at += 1
    } else if (/[\s;|&()<>]/.test(char)) {
      break
    } else {
      word += char
    }
  }

  return { word, end: at }
}

type Heredoc = {
  word: string
  /** Index of the command that opened it. */
  owner: number
  isTabbed: boolean
  /** Fed to a shell or ssh: the body is commands. */
  isShell: boolean
  /** The delimiter is quoted: the shell expands nothing in the body. */
  isLiteral: boolean
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

// The ssh options that take a value as the next word (`-p 22`); attached values (`-p22`) are one word.
const SSH_VALUED = new Set(['b', 'c', 'D', 'E', 'e', 'F', 'I', 'i', 'J', 'L', 'l', 'm', 'O', 'o', 'p', 'Q', 'R', 'S', 'W', 'w'])

// The options of a wrapper that take the next word as their value, short ones by letter and long ones whole.
const VALUED: Record<string, { short: Set<string>; long: Set<string> }> = {
  sudo: {
    short: new Set(['u', 'g', 'C', 'h', 'p', 'r', 't', 'U', 'D', 'R', 'T']),
    long: new Set(['--user', '--group', '--close-from', '--host', '--prompt', '--role', '--type', '--other-user', '--chdir', '--chroot', '--command-timeout']),
  },
  env: { short: new Set(['u', 'S', 'C']), long: new Set(['--unset', '--split-string', '--chdir']) },
  exec: { short: new Set(['a']), long: new Set() },
}

// The options of a wrapper that take no value; any other option is unknown.
const FLAGS: Record<string, Set<string>> = { sudo: new Set('AbEHiKklnPSsVvB'), env: new Set('i0v'), exec: new Set('cl') }

// The options of a shell that take the next word as their value (`bash -o pipefail`).
const SHELL_VALUED = new Set(['-o', '-O', '+o', '+O', '--rcfile', '--init-file'])

const base = (text: string) => text.slice(text.lastIndexOf('/') + 1)

// Whether what a command reads on stdin is run as commands: a shell with no `-c` and no script, or `ssh host` with no remote command.
const readsCommands = (words: readonly Word[]) => {
  let start = 0
  // An option of a wrapper this does not know: its value, if any, is not known, so any later shell counts.
  let isUnsure = false

  while (start < words.length) {
    const text = words[start]?.text ?? ''
    const name = base(text)

    if (ASSIGNMENT.test(text) || OPENERS.has(text)) {
      start += 1
    } else if (WRAPPERS.has(name)) {
      const { short, long } = VALUED[name] ?? { short: new Set<string>(), long: new Set<string>() }

      start += 1

      // The wrapper's own options, and the value of those that take one.
      while (start < words.length && (words[start]?.text ?? '').startsWith('-')) {
        const option = words[start]?.text ?? ''
        const isLong = option.startsWith('--')

        const flags = FLAGS[name] ?? new Set<string>()

        isUnsure ||= !(isLong ? option.includes('=') || long.has(option) : [...option.slice(1)].every(char => short.has(char) || flags.has(char)))
        start += 1 + ((isLong ? long.has(option) : option.length === 2 && short.has(option[1] ?? '-')) ? 1 : 0)
      }
    } else {
      break
    }
  }

  if (isUnsure) {
    return words.slice(start).some(word => SHELLS.has(base(word.text)) || base(word.text) === 'ssh')
  }

  const name = base(words[start]?.text ?? '')
  const rest = words.slice(start + 1).map(word => word.text)

  if (SHELLS.has(name)) {
    for (let at = 0; at < rest.length; at += 1) {
      const text = rest[at] ?? ''

      if (SHELL_VALUED.has(text) || (/^[-+][A-Za-z]+[oO]$/.test(text) && !/^-[A-Za-z]*c/.test(text))) {
        at += 1
      } else if (!(/^[-+]/.test(text)) || /^-[A-Za-z]*c/.test(text)) {
        return false
      }
    }

    return true
  }

  if (name === 'ssh') {
    let hosts = 0

    for (let at = 0; at < rest.length; at += 1) {
      const text = rest[at] ?? ''

      if (text.startsWith('-')) {
        at += text.length === 2 && SSH_VALUED.has(text.slice(1)) ? 1 : 0
      } else {
        hosts += 1
      }
    }

    return hosts === 1
  }

  return false
}

// Where the line after the bodies starts, and the text of each body: it runs to its closing delimiter, or to the end when it never comes.
const afterBodies = (command: string, from: number, pending: readonly Heredoc[]) => {
  let at = from
  const bodies: string[] = []

  for (const { word, isTabbed } of pending) {
    const begin = at
    let end = at

    for (;;) {
      if (at >= command.length) {
        end = command.length
        break
      }

      const newline = command.indexOf('\n', at)
      const line = command.slice(at, newline === -1 ? command.length : newline)

      end = at
      at = newline === -1 ? command.length : newline + 1

      if ((isTabbed ? line.replace(/^\t+/, '') : line) === word) {
        break
      }
    }

    bodies.push(command.slice(begin, Math.max(begin, end)))
  }

  return { end: at, bodies }
}

// Where the `(` opened before `from` closes (the index of its `)`), or the end of the text when it never does.
// It follows quotes, escapes and heredoc bodies, so a `)` inside them does not close it.
const closeParen = (command: string, from: number): number => {
  let depth = 1
  let pending: Heredoc[] = []
  // Open `case`s, innermost last: reading its head, a pattern (whose `)` closes nothing) or an arm's commands.
  const cases: ('head' | 'pattern' | 'body')[] = []
  let word = ''

  for (let at = from; at < command.length; at += 1) {
    const char = command[at] ?? ''

    if (/\w/.test(char)) {
      word += char

      continue
    }

    const top = cases.length - 1

    if (word === 'case') {
      cases.push('head')
    } else if (word === 'in' && cases[top] === 'head') {
      cases[top] = 'pattern'
    } else if (word === 'esac' && top >= 0) {
      cases.pop()
    }

    word = ''

    // In a pattern, the optional leading `(` opens nothing and the `)` ends the pattern instead of closing anything.
    if (cases.at(-1) === 'pattern' && (char === '(' || char === ')')) {
      if (char === ')') {
        cases[cases.length - 1] = 'body'
      }
    } else if (char === ';' && cases.at(-1) === 'body' && (command[at + 1] === ';' || command[at + 1] === '&')) {
      cases[cases.length - 1] = 'pattern'
    } else if (char === '\\') {
      at += 1
    } else if (char === "'") {
      at = command.indexOf("'", at + 1)

      if (at === -1) {
        return command.length
      }
    } else if (char === '"') {
      for (at += 1; at < command.length && command[at] !== '"'; at += 1) {
        if (command[at] === '\\') {
          at += 1
        } else if (command[at] === '$' && command[at + 1] === '(') {
          at = closeParen(command, at + 2)
        }
      }
    } else if (char === '$' && command[at + 1] === '(') {
      at = closeParen(command, at + 2)
    } else if (char === '`') {
      at = backtickEnd(command, at + 1)
    } else if (char === '<' && command[at + 1] === '<' && command[at + 2] !== '<' && command[at + 2] !== '(') {
      const isTabbed = command[at + 2] === '-'
      const start = at + (isTabbed ? 3 : 2)
      const skip = /^[ \t]*/.exec(command.slice(start))?.[0].length ?? 0
      const { word, end } = delimiterAt(command, start + skip)

      pending.push({ word, isTabbed, isShell: false, isLiteral: false, owner: 0 })
      at = end - 1
    } else if (char === '\n' && pending.length > 0) {
      at = afterBodies(command, at + 1, pending).end - 1
      pending = []
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1

      if (depth === 0) {
        return at
      }
    }
  }

  return command.length
}

// Where the backtick opened before `from` closes, or the end of the text when it never does.
const backtickEnd = (command: string, from: number): number => {
  for (let at = from; at < command.length; at += 1) {
    if (command[at] === '\\') {
      at += 1
    } else if (command[at] === '`') {
      return at
    }
  }

  return command.length
}

// The commands inside a substitution, as if run on their own: the shell runs them whenever it expands the word.
const inside = (text: string): Command[] => parse(text).map((one, at) => (at === 0 ? { ...one, before: ';' } : one))

// The substitutions of a heredoc body the shell expands (unquoted delimiter), whose commands run even when the body is data.
const bodySubstitutions = (body: string): Command[] => {
  const found: Command[] = []

  for (let at = 0; at < body.length; at += 1) {
    const char = body[at] ?? ''

    if (char === '\\') {
      at += 1
    } else if (char === '$' && body[at + 1] === '(' && body[at + 2] !== '(') {
      const close = closeParen(body, at + 2)

      found.push(...inside(body.slice(at + 2, close)))
      at = close
    } else if (char === '`') {
      const close = backtickEnd(body, at + 1)

      found.push(...inside(body.slice(at + 1, close).replace(/\\([`$\\])/g, '$1')))
      at = close
    }
  }

  return found
}

type Command = {
  words: Word[]
  /** The separator that came before: `;`, `&&`, `|`, `(`… */
  before: string
  /** The commands inside the substitutions this command holds, which run first and in their own scope. */
  sub?: Command[]
}

// The simple commands on the line, empty ones included, each with the separator before it.
// The commands inside `$(…)`, backticks and `<(…)`/`>(…)` (also inside double quotes, and in the body of a heredoc
// whose delimiter is unquoted) hang from the command that holds them in `sub`, as if run on their own; the word
// that holds them stays unknown. Single-quoted text and `$((…))` are not substitutions. An unterminated one reads to the end.
const parse = (command: string): Command[] => {
  const commands: Command[] = [{ words: [], before: '' }]
  let text = ''
  let isOpen = false
  let isUnknown = false
  let isHome = false
  let isQuoted = false
  // A bare operator (`>`) is waiting for its target word.
  let isTargetNext = false
  // The pending target is a here-string fed to a shell: it is commands.
  let isHereShell = false
  let quote: string | undefined
  // Heredocs opened on this line, whose bodies start after its newline.
  let pending: Heredoc[] = []
  // `case`: how many are open, whether its `in` is still to come, and the arm pattern being read (from `patternFrom` on).
  let cases = 0
  let isAwaitingIn = false
  let isPattern = false
  let patternFrom = 0
  // Parentheses still open in `$((…))` or `((…))`, where `<<` is a shift and not a heredoc.
  let arithmetic = 0

  // The commands of a substitution belong to the command that holds it.
  const attach = (index: number, found: Command[]) => {
    const owner = commands[index]

    if (owner !== undefined) {
      owner.sub = [...(owner.sub ?? []), ...found]
    }
  }
  // The substitution that opens at `at` (`$(`, a backtick, `<(` or `>(`): its commands are kept, its text stays in the word.
  const substitute = (at: number) => {
    const isBacktick = command[at] === '`'
    const start = at + (isBacktick ? 1 : 2)
    const close = isBacktick ? backtickEnd(command, start) : closeParen(command, start)
    const inner = command.slice(start, close)

    attach(commands.length - 1, inside(isBacktick ? inner.replace(/\\([`$\\])/g, '$1') : inner))

    return { raw: command.slice(at, close + 1), end: Math.min(close, command.length - 1) }
  }
  const endPattern = () => {
    // The pattern's words are dropped, but the substitutions in any of its alternatives (`a|$(…)`) still run.
    const dropped = commands.splice(patternFrom + 1).flatMap(one => one.sub ?? [])
    const first = commands[patternFrom]

    if (first !== undefined) {
      first.words = []
    }

    if (dropped.length > 0) {
      attach(patternFrom, dropped)
    }

    isPattern = false
  }
  const startPattern = () => {
    isPattern = true
    patternFrom = commands.length - 1
  }

  const endWord = () => {
    // `<(…)` and `>(…)` are process substitutions: words that hold commands, not redirections.
    const redirection = isOpen && !isQuoted && !/^[<>]\(/.test(text) ? REDIRECTION.exec(text) : null

    if (isOpen && isTargetNext) {
      isTargetNext = false

      if (isHereShell) {
        isHereShell = false
        commands.push(...parse(text).map((one, at) => (at === 0 ? { ...one, before: ';' } : one)), { words: [], before: ';' })
      }
    } else if (redirection !== null) {
      isTargetNext = redirection[1] === ''
    } else if (isOpen) {
      const words = commands.at(-1)?.words ?? []
      const isFirst = words.every(word => OPENERS.has(word.text))

      if (!isQuoted && isFirst && text === 'esac' && cases > 0) {
        cases -= 1
        isAwaitingIn = false

        if (isPattern) {
          endPattern()
        }
      } else {
        words.push({ text, isUnknown, isHome })

        if (!isQuoted && isFirst && text === 'case') {
          cases += 1
          isAwaitingIn = true
        } else if (!isQuoted && isAwaitingIn && text === 'in' && words.length >= 3) {
          isAwaitingIn = false
          commands.push({ words: [], before: ';' })
          startPattern()
        }
      }
    }

    text = ''
    isQuoted = false
    isOpen = false
    isUnknown = false
    isHome = false
  }
  const endCommand = (before: string) => {
    endWord()
    isTargetNext = false
    commands.push({ words: [], before })
  }

  for (let at = 0; at < command.length; at += 1) {
    const char = command[at] ?? ''
    const following = command[at + 1] ?? ''

    if (quote === undefined) {
      if (arithmetic > 0) {
        arithmetic += char === '(' ? 1 : char === ')' ? -1 : 0
      } else if (char === '(' && following === '(' && (command[at - 1] === '$' || (!isOpen && commands.at(-1)?.words.length === 0))) {
        arithmetic = 1
      }
    }

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      } else if (char === '\\' && quote === '"') {
        text += following
        at += 1
      } else if (quote === '"' && ((char === '$' && following === '(' && command[at + 2] !== '(') || char === '`')) {
        const { raw, end } = substitute(at)

        isUnknown = true
        text += raw
        at = end
      } else {
        isUnknown ||= quote === '"' && (char === '$' || char === '`')
        text += char
      }
    } else if (char === "'" || char === '"') {
      quote = char
      isOpen = true
      isQuoted = true
    } else if (char === '\\') {
      text += following === '\n' ? '' : following
      isOpen ||= following !== '\n'
      isQuoted ||= following !== '\n'
      at += 1
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else if ((char === '$' && following === '(' && command[at + 2] !== '(') || char === '`' || ((char === '<' || char === '>') && following === '(' && arithmetic === 0)) {
      const { raw, end } = substitute(at)

      isUnknown = true
      isOpen = true
      text += raw
      at = end
    } else if (char === '<' && following === '<' && arithmetic === 0) {
      // A heredoc body (or here-string) is data for `cat`, `tee`, `python`…, but commands for a shell
      // (`bash`, `sh`, `zsh`, `dash`, `ksh`, with no `-c` and no script) or `ssh host` with no remote command:
      // then it is parsed as if typed on the line. Quoting the delimiter only changes expansion, not execution.
      endWord()

      const isShell = readsCommands(commands.at(-1)?.words ?? [])

      if (command[at + 2] === '<') {
        // A here-string: the next word is data, or commands for a shell.
        isTargetNext = true
        isHereShell = isShell
        at += 2
      } else {
        const isTabbed = command[at + 2] === '-'
        const start = at + (isTabbed ? 3 : 2)
        const { word, end } = delimiterAt(command, start + (/^[ \t]*/.exec(command.slice(start))?.[0].length ?? 0))

        const isLiteral = /['"\\]/.test(command.slice(start, end))

        pending.push({ word, isTabbed, isShell, isLiteral, owner: commands.length - 1 })
        at = end - 1
      }
    } else if (char === ')' && isPattern) {
      endWord()
      isTargetNext = false
      endPattern()
    } else if (char === ';' && cases > 0 && !isPattern && (following === ';' || following === '&')) {
      // `;;`, `;&` and `;;&` end an arm; the next pattern follows.
      const length = following === ';' && command[at + 2] === '&' ? 2 : 1

      endCommand(';')
      startPattern()
      at += length
    } else if (BREAKS.has(char)) {
      endCommand(char)

      if (char === '\n' && pending.length > 0) {
        const { end, bodies } = afterBodies(command, at + 1, pending)

        for (const [index, body] of bodies.entries()) {
          const heredoc = pending[index]
          let isPiped = false

          // Any later command of the same pipeline may run the body.
          for (let at = (heredoc?.owner ?? commands.length) + 1; commands[at]?.before === '|' || commands[at]?.before === '|&'; at += 1) {
            isPiped ||= readsCommands(commands[at]?.words ?? [])
          }

          if (heredoc?.isShell === true || isPiped) {
            commands.push(...parse(body).map((one, position) => (position === 0 ? { ...one, before: '\n' } : one)), { words: [], before: '\n' })
          } else if (heredoc !== undefined && !heredoc.isLiteral) {
            attach(heredoc.owner, bodySubstitutions(body))
          }
        }

        at = end - 1
        pending = []
      }
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



// ---- Classification ----

export type GitActor = 'lead' | Role
export type GitVerdict = { allow: true } | { allow: false; reason: string }

export type GitSegment = {
  /** The subcommand, `''` for a bare `git` or `git --version`. `git-push` and `…/git-core/git-push` are the verb `push`. */
  verb: string
  /** The words after the verb. */
  args: string[]
  /** The loose (non-flag) words after the verb. */
  positional: string[]
  /** The pathspecs of `add`, `mv`, `rm`, `restore` and `commit` with `-C` and `./..` folded in; a directory-like one ends with `/` and `.` is the whole tree. Empty for any other verb. */
  paths: string[]
  /** The values of `-m`, `--message`, `--trailer` and `--author` of a commit. */
  message?: string[]
  /** False only for the read-only verbs and forms. Unknown verbs count as changing state. */
  changesState: boolean
  /** The flags after the verb as written (`-m`, `--amend`…); a cluster like `-am` is listed by letter. */
  flags: string[]
  /** The options before the verb (`-C`, `-c`, `--git-dir=…`), each followed by its value. */
  global: string[]
  /** The names assigned in front of the command (`FOO=1 git …`, also after `env`), and by an enclosing `env -S`, `bash -c` or `eval`. */
  assigns: string[]
  /** An alias is defined for this call with `-c alias.*` or `--config-env`. */
  alias: boolean
  /** `-c` or `--config-env` sets an alias, a push setting, `core.hooksPath`, `core.sshCommand` or a remote's receivepack/uploadpack. */
  unsafeConfig: boolean
  /** Some word after the verb is not literal. */
  hasUnknown: boolean
  /** The paths cannot be trusted: one is not literal, `-C` is not, or a `cd` came earlier on the line. */
  uncertain: boolean
}

export type ForgeSegment = {
  /** `gh`, `glab`, `glab-work`… */
  tool: string
  args: string[]
  /** The first and second loose words (`pr merge`, `repo delete`, `api`). */
  group: string
  action: string
  /** The loose words (for `api`, the endpoint is the second). */
  positional: string[]
  changesState: boolean
}

// Commands that run what they are given: a `git` among their words cannot be read.
const RUNNERS = new Set(['xargs', 'find', 'parallel', 'ssh', 'watch', 'source', '.', 'script', 'setsid', 'timeout', 'nice', 'ionice', 'stdbuf', 'chroot', 'su', 'doas', 'osascript', 'busybox', 'coproc', 'trap'])
const GIT_WORD = /(^|[\s/;&|()`'"={,}])git($|[\s;&|()`'"{,}])/
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path', '--config-env'])
// Names that skip hooks or point git elsewhere. `GIT_PAGER`, `GIT_SSH_COMMAND`, `GIT_TRACE`… are not among them.
const HOOK_ENV = /^(GIT_DIR$|GIT_WORK_TREE$|GIT_INDEX_FILE$|GIT_CONFIG|GIT_EXEC_PATH$|HUSKY|SKIP$|LEFTHOOK|PRE_COMMIT)/
// What `export $(cat .env)` leaves in `envSets`: variables set from text the parser cannot read.
const UNKNOWN_ENV = '?'
const ENV_SETTERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local'])
// Config keys that change how git pushes, runs commands or finds hooks.
const UNSAFE_KEY = /^(alias\.|push\.|core\.(hookspath|sshcommand)$|remote\..+\.(push|receivepack|uploadpack)$)/i
const EMPTY_OPTIONS = { short: new Set<string>(), long: new Set<string>() }
const CHDIR_SHORT: Record<string, string> = { env: 'C', sudo: 'DR' }

type Effective = {
  argv: Word[]
  /** The names assigned before the command. */
  assigns: string[]
  /** A wrapper changed the directory (`env -C`, `sudo -D`). */
  moved: boolean
  /** `env -S 'text'`: the string and the words after it, which together are a command line. */
  split?: Word[]
}

// The command a simple command runs: assignments, openers, `function NAME` and wrappers (with their options and `--`) stripped.
// `command -v git` only looks the name up, so it runs nothing.
const effective = (words: readonly Word[]): Effective => {
  const assigns: string[] = []
  let moved = false
  let at = 0

  while (at < words.length) {
    const word = words[at]
    const text = word?.text ?? ''
    const name = base(text)

    if (ASSIGNMENT.test(text)) {
      assigns.push(text.slice(0, text.indexOf('=')))
      at += 1
    } else if (text === 'function') {
      at += 2
    } else if (OPENERS.has(text)) {
      at += 1
    } else if (WRAPPERS.has(name) && word?.isUnknown !== true) {
      const { short, long } = VALUED[name] ?? EMPTY_OPTIONS

      at += 1

      while ((words[at]?.text ?? '').startsWith('-') && words[at]?.text !== '--') {
        const option = words[at]?.text ?? ''
        const isLong = option.startsWith('--')

        if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(option)) {
          return { argv: [], assigns: [], moved }
        }

        moved ||= isLong ? /^--(chdir|chroot)\b/.test(option) && name !== 'exec' : (CHDIR_SHORT[name] ?? '').includes(option[1] ?? '-')

        // `env -S 'git push'`, `--split-string=…`, `-iS…`: the value is a command line.
        const cut = name !== 'env' ? -1 : isLong ? (option.startsWith('--split-string') ? option.indexOf('=') : -1) : option.indexOf('S', 1)
        const isSplit = name === 'env' && (isLong ? option.startsWith('--split-string') : cut > 0)

        if (isSplit) {
          const attached = isLong ? (cut === -1 ? '' : option.slice(cut + 1)) : option.slice(cut + 1)
          const value: Word | undefined = attached === '' ? words[at + 1] : { text: attached, isUnknown: words[at]?.isUnknown ?? false, isHome: false }

          return { argv: [], assigns, moved, split: [...(value === undefined ? [] : [value]), ...words.slice(at + (attached === '' ? 2 : 1))] }
        }

        at += (isLong ? !option.includes('=') && long.has(option) : option.length === 2 && short.has(option[1] ?? '')) ? 2 : 1
      }

      if (words[at]?.text === '--') {
        at += 1
      }
    } else {
      break
    }
  }

  return { argv: words.slice(at), assigns, moved }
}

// The commands inside substitutions run before the command that holds them.
const flatten = (commands: readonly Command[]): Command[] => commands.flatMap(one => [...flatten(one.sub ?? []), one])

const XARGS_VALUED = 'ILnPsdEa'
const XARGS_WRAPPERS = new Set(['eval', 'env', 'sudo', 'command', 'exec', 'nohup', 'time'])

// The command an `xargs` stage runs, past its options; undefined when it names none (it then runs `echo`).
const xargsCommand = (rest: readonly Word[]): Word | undefined => {
  for (let at = 0; at < rest.length; at += 1) {
    const text = rest[at]?.text ?? ''

    if (text === '--') {
      return rest[at + 1]
    }

    if (text.startsWith('--')) {
      at += !text.includes('=') && ['--max-args', '--max-procs', '--delimiter', '--arg-file', '--max-lines', '--max-chars', '--eof'].includes(text) ? 1 : 0
    } else if (text.startsWith('-') && text.length > 1) {
      at += text.length === 2 && XARGS_VALUED.includes(text[1] ?? '') ? 1 : 0
    } else {
      return rest[at]
    }
  }

  return undefined
}

// Whether a command runs text it is fed or gets from a variable: a first word that is not literal, a shell or `eval` with a
// non-literal argument (`sh -c "$X"`), or `xargs` running a shell, a wrapper or a non-literal command.
const runsUnread = (argv: readonly Word[]) => {
  const first = argv[0]
  const name = base(first?.text ?? '')
  const rest = argv.slice(1)

  if (first === undefined) {
    return false
  }

  if (first.isUnknown) {
    return true
  }

  if (SHELLS.has(name) || name === 'eval') {
    return rest.some(word => word.isUnknown)
  }

  if (name === 'xargs') {
    const command = xargsCommand(rest)
    const named = base(command?.text ?? '')

    return command !== undefined && (command.isUnknown || SHELLS.has(named) || XARGS_WRAPPERS.has(named))
  }

  return false
}

// Whether a pipe stage that runs what it is fed (`sh`, `bash`, `source`, `.`, `xargs sh`, `sh -c "$x"`, a `while read` loop that runs
// `$line`) follows a stage that mentions git.
const pipesIntoShell = (commands: readonly Command[]): boolean => {
  let isGitSeen = false
  let isFound = false
  let isLoop = false

  for (const one of commands) {
    const isPiped = one.before === '|' || one.before === '|&'
    const argv = effective(one.words).argv
    const name = base(argv[0]?.text ?? '')

    isGitSeen &&= isPiped
    isFound ||= isGitSeen && (readsCommands(one.words) || name === 'source' || name === '.' || runsUnread(argv))

    if (isGitSeen && one.words[0]?.text === 'while') {
      isLoop = true
    } else if (one.words[0]?.text === 'done') {
      isLoop = false
    }

    isFound ||= isLoop && runsUnread(argv)
    isGitSeen ||= one.words.some(word => GIT_WORD.test(` ${word.text} `))
    isFound ||= one.sub !== undefined && pipesIntoShell(one.sub)
  }

  return isFound
}

// Splits flags from loose words. `shortValued` letters and `longValued` flags take a value (attached or the next word).
const scan = (args: readonly Word[], shortValued: string, longValued: readonly string[]) => {
  const flags: string[] = []
  const values: Array<[string, string]> = []
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
      const eq = text.indexOf('=')
      const flag = eq === -1 ? text : text.slice(0, eq)
      let value = eq === -1 ? undefined : text.slice(eq + 1)

      if (value === undefined && longValued.includes(flag)) {
        at += 1
        value = args[at]?.text
      }

      flags.push(flag)

      if (value !== undefined) {
        values.push([flag, value])
      }
    } else if (text.startsWith('-') && text.length > 1) {
      for (let index = 1; index < text.length; index += 1) {
        const letter = text[index] ?? ''

        flags.push(`-${letter}`)

        if (shortValued.includes(letter)) {
          let value: string | undefined = text.slice(index + 1)

          if (value === '') {
            at += 1
            value = args[at]?.text
          }

          if (value !== undefined) {
            values.push([`-${letter}`, value])
          }

          break
        }
      }
    } else {
      positional.push(word)
    }
  }

  return { flags, values, positional }
}

// `path` folded against `dir`: no `.`, `..` or empty parts. A leading `..` that climbs out is kept.
const fold = (dir: string, path: string) => {
  const whole = path.startsWith('/') || dir === '' ? path : `${dir}/${path}`
  const isAbsolute = whole.startsWith('/')
  const parts: string[] = []

  for (const part of whole.split('/')) {
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') {
      parts.pop()
    } else if (part === '..' && !isAbsolute) {
      parts.push(part)
    } else if (part !== '' && part !== '.' && part !== '..') {
      parts.push(part)
    }
  }

  return `${isAbsolute ? '/' : ''}${parts.join('/')}`
}

// A pathspec as the segment reports it: magic (`:/`, `:(glob)…`) untouched; `.` for the whole tree; a trailing `/` kept to mark a directory.
const pathOf = (dir: string, text: string) => {
  if (text.startsWith(':')) {
    return text
  }

  const folded = fold(dir, text)

  if (folded === '') {
    return '.'
  }

  return /\/\.?$/.test(text) && folded !== '/' ? `${folded}/` : folded
}

// Read-only verbs, and the verbs that change state only with some arguments.
const READ_ONLY = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'annotate', 'grep', 'ls-tree', 'cat-file', 'describe', 'shortlog',
  'rev-list', 'show-ref', 'name-rev', 'ls-remote', 'merge-base', 'for-each-ref', 'diff-tree', 'diff-index', 'diff-files', 'check-ignore',
  'check-attr', 'var', 'count-objects', 'fsck', 'verify-commit', 'verify-tag', 'whatchanged', 'range-diff', 'cherry', 'show-branch', 'help',
  'version', 'fetch',
])
const BRANCH_MUTATING = ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description', '-t', '--track', '--no-track']
const BRANCH_LISTING = ['-l', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at']
const TAG_MUTATING = ['-d', '--delete', '-a', '--annotate', '-s', '--sign', '-f', '--force', '-m', '-F', '-u', '--local-user', '--message', '--file']
const TAG_LISTING = ['-l', '--list', '-n', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at']
const CONFIG_READING = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list', '--show-origin', '--show-scope', '--name-only']
const CONFIG_WRITING = ['--add', '--replace-all', '--unset', '--unset-all', '--edit', '-e', '--rename-section', '--remove-section']
const APPLY_READING = ['--check', '--stat', '--numstat', '--summary']

const changesState = (verb: string, args: readonly Word[]): boolean => {
  const texts = args.map(arg => arg.text)
  const has = (names: readonly string[]) => texts.some(text => names.includes(text.split('=')[0] ?? text))
  const loose = texts.filter(text => !text.startsWith('-'))
  const sub = loose[0] ?? ''

  if (verb === '' || READ_ONLY.has(verb)) {
    return false
  }

  switch (verb) {
    case 'branch':
      return has(BRANCH_MUTATING) || (!has(BRANCH_LISTING) && loose.length > 0)
    case 'tag':
      return has(TAG_MUTATING) || (!has(TAG_LISTING) && loose.length > 0)
    case 'stash':
      return !['list', 'show'].includes(sub)
    case 'worktree':
      return sub !== 'list'
    case 'remote':
      return !(sub === '' || ['show', 'get-url'].includes(sub))
    case 'config':
      // `git config <key>` with no value reads it.
      return !has(CONFIG_READING) && (has(CONFIG_WRITING) || loose.length !== 1)
    case 'submodule':
      return !(sub === '' || ['status', 'summary'].includes(sub))
    case 'reflog':
      return !(sub === '' || ['show', 'exists', 'list'].includes(sub))
    case 'notes':
      return !(sub === '' || ['list', 'show'].includes(sub))
    case 'apply':
      return !has(APPLY_READING)
    default:
      return true
  }
}

const COMMIT_LONG_VALUED = ['--message', '--file', '--author', '--date', '--template', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--cleanup', '--trailer', '--pathspec-from-file']
const PUSH_LONG_VALUED = ['--push-option', '--repo', '--receive-pack', '--exec']
// The verbs whose loose words are pathspecs, with the options that take a value.
const PATHSPEC_VERBS: Record<string, { short: string; long: string[] }> = {
  add: { short: '', long: ['--pathspec-from-file'] },
  mv: { short: '', long: [] },
  rm: { short: '', long: ['--pathspec-from-file'] },
  restore: { short: 's', long: ['--source', '--pathspec-from-file'] },
  commit: { short: 'mFCctu', long: COMMIT_LONG_VALUED },
}

// One `git …` command (the words after `git`), or undefined (opaque) when the verb is not literal.
const gitSegment = (words: readonly Word[], isAdrift: boolean, assigns: readonly string[]): GitSegment | undefined => {
  const global: string[] = []
  let alias = false
  let unsafeConfig = false
  let dir = ''
  let uncertain = isAdrift
  let at = 0

  while ((words[at]?.text ?? '').startsWith('-')) {
    const flag = words[at]?.text ?? ''
    const isValued = GIT_VALUED.has(flag)
    const value = isValued ? words[at + 1] : undefined
    const config = flag === '-c' || flag === '--config-env' ? value?.text : flag.startsWith('--config-env=') ? flag.slice(13) : undefined

    global.push(flag)

    if (value !== undefined) {
      global.push(value.text)
    }

    if (flag === '-C') {
      uncertain ||= value === undefined || value.isUnknown || value.text.startsWith('~')
      dir = fold(dir, value?.text ?? '.')
    }

    alias ||= /^alias\./i.test(config ?? '')
    unsafeConfig ||= UNSAFE_KEY.test((config ?? '').split('=')[0] ?? '')
    at += isValued ? 2 : 1
  }

  const verbWord = words[at]
  const verb = verbWord?.text ?? ''

  // A verb the shell still has to expand (`git $VERB`) could be anything.
  if (verbWord?.isUnknown === true) {
    return undefined
  }

  const args = words.slice(at + 1)
  const spec = PATHSPEC_VERBS[verb]
  const { flags, values, positional } = spec === undefined ? scan(args, verb === 'push' ? 'o' : '', verb === 'push' ? PUSH_LONG_VALUED : []) : scan(args, spec.short, spec.long)
  const base = { verb, args: args.map(arg => arg.text), positional: positional.map(word => word.text), changesState: changesState(verb, args), flags, global, assigns: [...assigns], alias, unsafeConfig, hasUnknown: args.some(arg => arg.isUnknown) }

  if (spec === undefined) {
    return { ...base, paths: [], uncertain }
  }

  const paths = positional.map(word => pathOf(dir, word.text))
  const isUnsure = uncertain || positional.some(word => word.isUnknown)

  if (verb === 'commit') {
    const message = values.filter(([flag]) => ['-m', '--message', '--trailer', '--author'].includes(flag)).map(([, value]) => value)

    return { ...base, paths, message, uncertain: isUnsure }
  }

  return { ...base, paths, uncertain: isUnsure }
}

// ---- gh and glab ----

const FORGE_READ_GROUPS = new Set(['', 'status', 'search', 'version', 'help', 'browse', 'completion'])
const FORGE_READ_ACTIONS = new Set(['', 'view', 'list', 'ls', 'status', 'diff', 'checks', 'show', 'get', 'watch', 'trace'])
const FORGE_FIELD_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input']

const forgeSegment = (tool: string, args: readonly Word[]): ForgeSegment => {
  const { flags, values, positional } = scan(args, 'RXfFH', ['--repo', '--hostname', '--method', '--field', '--raw-field', '--header', '--input', '--jq', '--template', '--preview'])
  const group = positional[0]?.text ?? ''
  const action = positional[1]?.text ?? ''
  const method = values.find(([flag]) => flag === '-X' || flag === '--method')?.[1]
  let changes: boolean

  if (flags.includes('--push')) {
    changes = true
  } else if (group === 'api') {
    changes = (method !== undefined && method.toUpperCase() !== 'GET') || flags.some(flag => FORGE_FIELD_FLAGS.includes(flag))
  } else if (FORGE_READ_GROUPS.has(group)) {
    changes = false
  } else {
    changes = !FORGE_READ_ACTIONS.has(action)
  }

  return { tool, args: args.map(arg => arg.text), group, action, positional: positional.map(word => word.text), changesState: changes }
}

type Classified = { segments: GitSegment[]; forges: ForgeSegment[]; opaque: boolean; envSets: string[] }

const classifyDepth = (command: string, depth: number, inherit: readonly string[]): Classified => {
  const found: Classified = { segments: [], forges: [], opaque: false, envSets: [] }
  let isAdrift = false

  if (depth > 4) {
    found.opaque = GIT_WORD.test(command)

    return found
  }

  const merge = (inner: Classified) => {
    found.segments.push(...inner.segments)
    found.forges.push(...inner.forges)
    found.envSets.push(...inner.envSets)
    found.opaque ||= inner.opaque
  }
  const parsed = parse(command)

  found.opaque = pipesIntoShell(parsed)

  for (const one of flatten(parsed)) {
    const eff = effective(one.words)
    const assigns = [...inherit, ...eff.assigns]
    const first = eff.argv[0]
    const name = base(first?.text ?? '')
    const rest = eff.argv.slice(1)

    isAdrift ||= eff.moved

    // `bash < <(echo git push)`: the substitution feeds a shell.
    if (one.sub !== undefined && (readsCommands(one.words) || name === 'source' || name === '.') && flatten(one.sub).some(inner => inner.words.some(word => GIT_WORD.test(` ${word.text} `)))) {
      found.opaque = true
    }

    if (eff.split !== undefined) {
      const text = eff.split.map(word => word.text).join(' ')

      merge(classifyDepth(text, depth + 1, assigns))
      found.opaque ||= eff.split.some(word => word.isUnknown) && GIT_WORD.test(` ${text} `)

      continue
    }

    if (first === undefined) {
      // A bare assignment (`HUSKY=0`) stays in the shell for the commands after it.
      found.envSets.push(...eff.assigns.filter(assigned => HOOK_ENV.test(assigned)))

      continue
    }

    if (ENV_SETTERS.has(name)) {
      for (const word of rest) {
        if (ASSIGNMENT.test(word.text)) {
          const assigned = word.text.slice(0, word.text.indexOf('='))

          if (HOOK_ENV.test(assigned)) {
            found.envSets.push(assigned)
          }
        } else if (word.isUnknown) {
          found.envSets.push(UNKNOWN_ENV)
        }
      }
    } else if (name === 'cd' || name === 'pushd' || name === 'popd') {
      isAdrift = true
    } else if (name === 'git' || /^git-[a-z][a-z-]*$/.test(name)) {
      // `git-push` is the verb `push`.
      const words = name === 'git' ? rest : [{ text: name.slice(4), isUnknown: false, isHome: false }, ...rest]
      const segment = gitSegment(words, isAdrift, assigns)

      if (segment === undefined) {
        found.opaque = true
      } else {
        found.segments.push(segment)
        found.opaque ||= segment.alias
      }
    } else if (name === 'gh' || name.startsWith('glab')) {
      found.forges.push(forgeSegment(name, rest))
    } else if (SHELLS.has(name) || name === 'eval') {
      const flagAt = rest.findIndex(word => /^-[A-Za-z]*c[A-Za-z]*$/.test(word.text))
      const body = name === 'eval' ? rest : flagAt >= 0 ? rest.slice(flagAt + 1, flagAt + 2) : []
      const text = body.map(word => word.text).join(' ')

      if (body.length > 0) {
        const inner = classifyDepth(text, depth + 1, assigns)

        merge(inner)
        found.opaque ||= body.some(word => word.isUnknown) && GIT_WORD.test(` ${text} `)
      } else {
        // `bash "$(echo git push)"`: a script argument that holds git.
        found.opaque ||= rest.some(word => word.isUnknown && GIT_WORD.test(` ${word.text} `))
      }
    } else if (RUNNERS.has(name) || (first.isUnknown && GIT_WORD.test(` ${first.text} `))) {
      found.opaque ||= (first.isUnknown && GIT_WORD.test(` ${first.text} `)) || rest.some(word => GIT_WORD.test(` ${word.text} `) || base(word.text) === 'git')
    }
  }

  return found
}

/**
 * Every git command the line runs, in order (the commands inside substitutions first), the `gh`/`glab` ones, whether a `git`
 * is hidden where the parser cannot read it, and the environment the line sets for later commands (`export`, `declare`,
 * `typeset`, bare `GIT_*`/hook-skip assignments). `bash -c '…'`, `eval '…'` and `env -S '…'` with literal text are read as if typed on the line.
 * Opaque means: `eval` or `bash -c` with text that is not literal, `xargs git`, `ssh host git`, `… | sh` after a git stage,
 * `{git,push}`, `git $VERB`, `git -c alias.x=…`.
 */
export function classifyGitCommand(command: string): Classified {
  return classifyDepth(command, 0, [])
}

// ---- Policy ----

const AI_PATTERNS = [
  /co-authored-by\s*[:=][^\n]*(claude|codex|anthropic|openai|chatgpt|copilot|gemini|\bai\b|\bgpt)/i,
  /generated\s+(with|by)[^\n]*(claude|codex|chatgpt|openai|copilot|gemini|\bai\b)/i,
  /noreply@anthropic\.com/i,
  /🤖/u,
]

const hasAiAttribution = (messages: readonly string[]) => messages.some(text => AI_PATTERNS.some(pattern => pattern.test(text)))

const ADD_FLAGS = new Set(['-v', '--verbose', '-n', '--dry-run', '-N', '--intent-to-add'])
const MV_FLAGS = new Set(['-v', '--verbose', '-n', '--dry-run', '-k'])
const RM_FLAGS = new Set(['--cached', '-n', '--dry-run', '-q', '--quiet', '--ignore-unmatch'])
const RESTORE_FLAGS = new Set(['-S', '--staged', '-W', '--worktree', '-q', '--quiet'])
const COMMIT_FLAGS = new Set(['-m', '--message', '-q', '--quiet', '-v', '--verbose', '-s', '--signoff', '--allow-empty', '--author', '--date', '--trailer', '--no-edit', '-o', '--only', '--no-status', '--cleanup'])
const COMMIT_REASONS: Record<string, string> = {
  '-a': '`git commit -a` stages everything; run `git add -- <your files>` and commit those paths.',
  '--all': '`git commit --all` stages everything; run `git add -- <your files>` and commit those paths.',
  '--amend': '`git commit --amend` rewrites history; make a follow-up commit instead.',
  '--no-verify': '`--no-verify` skips the hooks; fix the failure or report it to the lead.',
  '-n': '`-n` (`--no-verify`) skips the hooks; fix the failure or report it to the lead.',
  '-e': '`git commit -e` opens an editor that hangs; pass the message with `-m`.',
  '--edit': '`git commit --edit` opens an editor that hangs; pass the message with `-m`.',
}
const PATH_VERBS: Record<string, Set<string>> = { add: ADD_FLAGS, mv: MV_FLAGS, rm: RM_FLAGS, restore: RESTORE_FLAGS }

const deny = (reason: string): GitVerdict => ({ allow: false, reason })

const label = (segment: GitSegment) => `git ${segment.verb}`.trim()

// Whether the pathspecs of a dev's call are explicit files the dev owns.
const checkPaths = (segment: GitSegment, owns: (path: string) => boolean): GitVerdict | undefined => {
  if (segment.uncertain) {
    return deny(`Name the paths literally from the repository root, with no \`cd\`, variable or non-literal \`-C\` before ${label(segment)}: ownership cannot be checked otherwise.`)
  }

  for (const path of segment.paths) {
    if (path === '.' || path.endsWith('/') || path.startsWith(':') || path === '..' || path.startsWith('../') || /[*?[]/.test(path)) {
      return deny(`${label(segment)} must name files explicitly (no \`.\`, \`:/\`, directory, glob or catch-all pathspec); got \`${path}\`.`)
    }

    if (!owns(path)) {
      return deny(`\`${path}\` is not one of your task's files; leave it out or ask the lead.`)
    }
  }

  return undefined
}

// The first global option a dev may not use: only `-C <dir>` and `-P`/`--no-pager` may precede the verb.
const badGlobal = (global: readonly string[]) => {
  for (let at = 0; at < global.length; at += 1) {
    const option = global[at] ?? ''

    if (option === '-C') {
      at += 1
    } else if (option !== '-P' && option !== '--no-pager') {
      return option
    }
  }

  return undefined
}

const devVerdict = (segment: GitSegment, owns: (path: string) => boolean): GitVerdict | undefined => {
  // Read-only git may carry harmless variables (`GIT_PAGER=cat git log`, `LC_ALL=C git status`); anything that changes state or skips hooks may not.
  if (segment.assigns.some(name => HOOK_ENV.test(name)) || (segment.changesState && segment.assigns.length > 0)) {
    return deny('Do not set environment around git (`VAR=… git`, `env`): hooks and the repository must stay as configured.')
  }

  const option = badGlobal(segment.global)

  if (option !== undefined) {
    return deny(`Run plain git in the task worktree: \`${option}\` is not allowed before the verb (only \`-C\` and \`--no-pager\`).`)
  }

  if (!segment.changesState) {
    return undefined
  }

  const allowedFlags = PATH_VERBS[segment.verb]

  if (allowedFlags !== undefined) {
    const bad = segment.flags.find(flag => !allowedFlags.has(flag))

    if (bad !== undefined) {
      return deny(
        segment.verb === 'add'
          ? `\`git add ${bad}\` is not allowed; use \`git add -- <your files>\`, never \`-A\`, \`--all\`, \`-u\` or \`.\`.`
          : `\`git ${segment.verb} ${bad}\` is not allowed; name your own files only.`,
      )
    }

    return segment.paths.length === 0 ? deny(`\`git ${segment.verb}\` needs explicit paths: \`git ${segment.verb} -- <your files>\`.`) : checkPaths(segment, owns)
  }

  if (segment.verb === 'commit') {
    const bad = segment.flags.find(flag => !COMMIT_FLAGS.has(flag))

    if (bad !== undefined) {
      return deny(COMMIT_REASONS[bad] ?? `\`git commit ${bad}\` is not allowed; commit with \`-m\` and explicit paths only.`)
    }

    if (hasAiAttribution(segment.message ?? [])) {
      return deny('The commit message carries an AI attribution (a `Co-Authored-By` naming an AI, "Generated with …" or a robot emoji); remove it.')
    }

    // Two devs share one index: a commit without paths would take what the other staged.
    if (segment.paths.length === 0) {
      return deny('Name your task\'s paths: git commit -m <msg> -- <paths>.')
    }

    return checkPaths(segment, owns)
  }

  return deny(`Dev agents only run \`git add\`, \`mv\`, \`rm\`, \`restore\` and \`commit\` on their own files; report back so the lead can route \`${label(segment)}\` to the \`git\` role.`)
}

const PROTECTED_DEFAULT = ['main', 'master', 'develop']

// Whether `name` is one of the protected names: exact, or under a `prefix/*` pattern.
const isProtected = (name: string, patterns: readonly string[]) =>
  patterns.some(pattern => (pattern.endsWith('/*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern))

// The lead's push: no forced, deleting, mirroring or hook-skipping push, nothing to a protected branch by name, no config overrides.
const pushVerdict = (segment: GitSegment, envSets: readonly string[], protectedNames: readonly string[]): GitVerdict | undefined => {
  const longs = segment.flags.filter(flag => flag.startsWith('--'))
  // git takes unambiguous prefixes of long options.
  const hasLong = (name: string) => longs.some(flag => flag === name || (flag.length >= 4 && name.startsWith(flag)))
  const hasRepo = longs.some(flag => flag === '--repo')
  const refspecs = hasRepo ? segment.positional : segment.positional.slice(1)

  if (segment.global.some(option => option === '-c' || option.startsWith('--config-env'))) {
    return deny('Push without `-c` or `--config-env` overrides: push uses the repository configuration as is.')
  }

  if (segment.assigns.concat(envSets).some(name => HOOK_ENV.test(name) || name === UNKNOWN_ENV)) {
    return deny('Push without `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG*`, `GIT_EXEC_PATH`, hook-skip variables (`HUSKY`, `SKIP`, `LEFTHOOK`, `PRE_COMMIT`) or exports it cannot read: hooks and the repository must stay as configured.')
  }

  if (segment.flags.includes('-f') || hasLong('--force') || refspecs.some(refspec => refspec.startsWith('+'))) {
    return deny('Forced push (`-f`, `--force`, `+refspec`) is denied; use `--force-with-lease`.')
  }

  if (segment.flags.includes('-d') || hasLong('--delete') || hasLong('--prune') || refspecs.some(refspec => refspec.replace(/^\+/, '').startsWith(':'))) {
    return deny('Deleting a remote ref through push (`--delete`, `-d`, `--prune`, `:ref`) is denied; ask the person.')
  }

  if (hasLong('--mirror')) {
    return deny('`git push --mirror` is denied; push the branch by name.')
  }

  if (hasLong('--all') || hasLong('--branches')) {
    return deny('`git push --all` sends every branch, protected ones included; push the branch by name.')
  }

  if (hasLong('--no-verify')) {
    return deny('`git push --no-verify` skips the hooks; fix the failure instead.')
  }

  for (const refspec of refspecs) {
    if (refspec.includes('*')) {
      return deny('Push refspecs with `*` are denied; name the branch.')
    }

    const target = refspec.slice(refspec.lastIndexOf(':') + 1).replace(/^refs\/heads\//, '').replace(/^heads\//, '').replace(/^refs\//, '')

    if (isProtected(target, protectedNames)) {
      return deny(`Pushing to the protected branch \`${target}\` is denied; push a feature branch and open a PR/MR.`)
    }
  }

  return undefined
}

const BUILTIN_VERBS = new Set([
  '', 'add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-attr', 'check-ignore', 'checkout', 'checkout-index',
  'cherry', 'cherry-pick', 'clean', 'clone', 'column', 'commit', 'commit-tree', 'config', 'count-objects', 'describe', 'diff', 'diff-files', 'diff-index',
  'diff-tree', 'difftool', 'fast-export', 'fast-import', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init',
  'interpret-trailers', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'maintenance', 'merge', 'merge-base', 'merge-file', 'mergetool', 'mktree', 'mv', 'name-rev',
  'notes', 'pack-refs', 'prune', 'pull', 'push', 'range-diff', 'read-tree', 'rebase', 'reflog', 'remote', 'repack', 'replace', 'request-pull', 'rerere', 'reset',
  'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-branch', 'show-ref', 'sparse-checkout', 'stash', 'status', 'stripspace',
  'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var', 'verify-commit', 'verify-tag', 'version', 'whatchanged', 'worktree', 'write-tree',
])
const SCRIPT_COMMAND = /^\s*(\.{0,2}\/|\S+\.(sh|bash|zsh)\b|(ba|z|da|k)?sh\b|source\b|\.\s)/

// The values of `-x` / `--exec` in a rebase's arguments.
const execValues = (args: readonly string[]) =>
  args.flatMap((arg, at) => (arg === '-x' || (arg.startsWith('--e') && '--exec'.startsWith(arg)) ? [args[at + 1] ?? ''] : arg.startsWith('--exec=') ? [arg.slice(7)] : []))

// What the git role (or a lead acting as it) may not do beyond the push.
const gitScopeVerdict = (segment: GitSegment): GitVerdict | undefined => {
  const text = segment.args.join(' ')

  if (segment.alias) {
    return deny('Defining aliases with `-c alias.*` is not allowed: they hide the verb.')
  }

  if (segment.unsafeConfig) {
    return deny('Do not override push settings, `core.hooksPath`, `core.sshCommand` or a remote\'s upload/receive pack with `-c` or `--config-env`.')
  }

  if (segment.flags.some(flag => flag.length >= 4 && ['--upload-pack', '--receive-pack'].some(name => name.startsWith(flag)))) {
    return deny('`--upload-pack` and `--receive-pack` run another program in place of git; do not use them.')
  }

  if (segment.verb === 'config' && segment.changesState && UNSAFE_KEY.test(segment.positional[0] ?? '')) {
    return deny(`Do not write \`${segment.positional[0]}\`: aliases, push settings, \`core.hooksPath\`, \`core.sshCommand\` and remote pack programs stay as configured.`)
  }

  if (!BUILTIN_VERBS.has(segment.verb)) {
    return deny(`\`git ${segment.verb}\` is not a built-in git command and may be an alias or an external program; run the underlying command.`)
  }

  if (segment.verb === 'rebase') {
    const values = execValues(segment.args)

    if (values.some(value => /\bpush\b/.test(value))) {
      return deny('A rebase `--exec` must not push; the lead pushes.')
    }

    if (values.length > 0 && (segment.hasUnknown || values.some(value => SCRIPT_COMMAND.test(value)))) {
      return deny('A rebase `--exec` must be a literal command, not a script or a variable; run it yourself.')
    }
  }

  if ((segment.verb === 'submodule' && segment.positional.includes('foreach') && /\bpush\b/.test(text)) || (segment.verb === 'bisect' && segment.positional[0] === 'run' && /\bpush\b/.test(text))) {
    return deny(`\`git ${segment.verb} ${segment.verb === 'bisect' ? 'run' : 'foreach'}\` must not push; the lead pushes.`)
  }

  return undefined
}

// What the git role may not do on the forge: merge, or delete a repository.
const forgeScopeVerdict = (forge: ForgeSegment): GitVerdict | undefined => {
  const isApiMerge = forge.group === 'api' && forge.changesState && /\/merge\b/.test(forge.positional[1] ?? '')

  if (((forge.group === 'pr' || forge.group === 'mr') && forge.action === 'merge') || isApiMerge) {
    return deny('Merging a PR/MR is the person\'s call; open it and leave the merge.')
  }

  return forge.group === 'repo' && forge.action === 'delete' ? deny('Deleting a repository is denied.') : undefined
}

const OPAQUE_REASON = 'A `git` command is hidden in `eval`, `bash -c`, `xargs`, `ssh`, `… | sh`, an alias, brace expansion or a variable, where it cannot be checked; run the git command directly.'

const forgeReason = (forge: ForgeSegment) =>
  forge.group === 'pr' || forge.group === 'mr'
    ? `PR/MR work goes to the git role: \`${forge.tool} ${forge.args.join(' ')}\`.`
    : `\`${forge.tool} ${forge.args.join(' ')}\` changes state on the forge; route it to the git role.`

/**
 * Whether `actor` may run `command`. The strictest segment decides; a hidden `git` is denied for every actor except `git`.
 * With `gitRole: false` (the git role is disabled) the lead may do what `git` does, under the git role's own limits,
 * except push unsafely and run a hidden `git`. `protected` lists the branches a push may not name: exact names or `prefix/*`.
 */
export function gitAllowed(actor: GitActor, command: string, owns: (path: string) => boolean, opts: { gitRole?: boolean; protected?: string[] } = {}): GitVerdict {
  const { segments, forges, opaque, envSets } = classifyGitCommand(command)
  const isGitScope = actor === 'git' || (actor === 'lead' && opts.gitRole === false)
  const isDev = actor === 'developer' || actor === 'ux'
  const protectedNames = opts.protected ?? PROTECTED_DEFAULT

  for (const forge of forges) {
    const verdict = isGitScope ? forgeScopeVerdict(forge) : forge.changesState ? deny(forgeReason(forge)) : undefined

    if (verdict !== undefined) {
      return verdict
    }
  }

  if (isDev && envSets.length > 0 && (segments.length > 0 || opaque)) {
    return deny('Do not set environment for git (`GIT_DIR`, `GIT_CONFIG*`, hook-skip variables, or exports it cannot read): hooks and the repository must stay as configured.')
  }

  for (const segment of segments) {
    let verdict: GitVerdict | undefined

    // An alias defined with `-c` hides the verb (`-c alias.p=push p`).
    if (segment.alias && !isGitScope) {
      return deny(OPAQUE_REASON)
    }

    if (actor === 'git') {
      verdict = segment.verb === 'push' ? deny('The lead pushes; report back and let the lead run `git push`.') : gitScopeVerdict(segment)
    } else if (actor === 'lead') {
      if (segment.verb === 'push') {
        verdict = pushVerdict(segment, envSets, protectedNames) ?? (isGitScope ? gitScopeVerdict(segment) : undefined)
      } else if (isGitScope) {
        verdict = gitScopeVerdict(segment)
      } else if (segment.changesState) {
        verdict = deny(`Delegate \`${label(segment)}\` to the \`git\` role; the lead only pushes.`)
      }
    } else if (isDev) {
      verdict = devVerdict(segment, owns)
    } else {
      verdict = segment.changesState ? deny(`${actor} is read-only; ask the lead to route \`${label(segment)}\` to the \`git\` role.`) : undefined
    }

    if (verdict !== undefined) {
      return verdict
    }
  }

  return opaque && actor !== 'git' ? deny(OPAQUE_REASON) : { allow: true }
}
