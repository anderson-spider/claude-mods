// The git gate: which git a given actor may run through Bash. Pure: no `$`, no host calls; the caller decides what a denial does.
// A safety net that reads text, not a permission system: aliases, scripts and variables that hold commands get through,
// except that anything that hides a `git` from the parser (eval, `bash -c "$x"`, xargs…) counts as opaque and fails closed
// for every actor, the git role included. An unquoted `#` that starts a word is a comment, as in the shell.
// The shell parser below (down to "Classification") is adapted from branch-guard's shell.ts, trimmed of its path helpers.
import type { Role } from '../types'

/** A word of the command, already unquoted, and what the shell would still do with it. */
type Word = {
  text: string
  /** Has `$`, a backtick or braces: only the shell knows what it becomes (the commands inside a substitution are parsed apart). */
  isUnknown: boolean
  /** Has `~` outside quotes. */
  isHome: boolean
  /** Has a `$`, a backtick, a substitution or a brace outside quotes: the shell can split it into several words. */
  canSplit?: boolean
}

const BREAKS = new Set([';', '\n', '(', ')'])

const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env', 'timeout', 'gtimeout', 'nice', 'ionice', 'stdbuf', 'setsid', 'caffeinate', 'arch'])

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

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'tcsh', 'csh', 'nu', 'pwsh', 'powershell', 'xonsh', 'elvish'])
// The shells whose `-c` is a contract: the word after it is the command line. The others (PowerShell's `-Command`, `-File`,
// `-EncodedCommand`, nu's `-e`…) spell it every way, so for them a command line is read wherever it stands.
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash'])

// What a program is called as a shell: its basename, lowercased, without `.exe` (`/usr/bin/PWSH.exe` is `pwsh`).
const shellName = (text: string) => text.slice(text.lastIndexOf('/') + 1).toLowerCase().replace(/\.exe$/, '')

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
  timeout: { short: new Set(['k', 's']), long: new Set(['--kill-after', '--signal']) },
  gtimeout: { short: new Set(['k', 's']), long: new Set(['--kill-after', '--signal']) },
  caffeinate: { short: new Set(['t', 'w']), long: new Set() },
  arch: { short: new Set(['d', 'e']), long: new Set() },
  nice: { short: new Set(['n']), long: new Set(['--adjustment']) },
  ionice: { short: new Set(['c', 'n', 'p', 'P', 'u']), long: new Set(['--class', '--classdata', '--pid', '--pgid', '--uid']) },
  stdbuf: { short: new Set(['i', 'o', 'e']), long: new Set(['--input', '--output', '--error']) },
}

// The options of a wrapper that take no value; any other option is unknown.
const FLAGS: Record<string, Set<string>> = { sudo: new Set('AbEHiKklnPSsVvB'), env: new Set('i0v'), exec: new Set('cl'), timeout: new Set('fpv'), gtimeout: new Set('fpv'), ionice: new Set('t'), setsid: new Set('cfw'), caffeinate: new Set('dimsu') }

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

      // `timeout 10 bash`: the duration is not the command.
      if ((name === 'timeout' || name === 'gtimeout') && start < words.length) {
        start += 1
      }
    } else {
      break
    }
  }

  if (isUnsure) {
    return words.slice(start).some(word => SHELLS.has(shellName(word.text)) || base(word.text) === 'ssh')
  }

  const name = base(words[start]?.text ?? '')
  const rest = words.slice(start + 1).map(word => word.text)

  if (SHELLS.has(shellName(name))) {
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
    } else if (char === '#' && (at === from || /[\s;|&()]/.test(command[at - 1] ?? ' '))) {
      // A comment: a `)` in it closes nothing.
      const newline = command.indexOf('\n', at)

      at = newline === -1 ? command.length : newline - 1
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

// Whether the `$` at `at`, inside double quotes, expands to one word per element: `$@`, `$*`, `${@}`, `${A[@]}`, `${A[*]}`, `${!p@}`.
const splitsInQuotes = (command: string, at: number): boolean => {
  const next = command[at + 1] ?? ''

  if (next === '@' || next === '*') {
    return true
  }

  if (next !== '{') {
    return false
  }

  const close = command.indexOf('}', at)
  const body = command.slice(at + 2, close === -1 ? command.length : close)

  return /\[[@*]\]/.test(body) || /^[@*]/.test(body) || /^![\w]+[@*]$/.test(body)
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
  let canSplit = false
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
        words.push({ text, isUnknown, isHome, canSplit })

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
    canSplit = false
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
        // `"$@"`, `"$*"`, `"${A[@]}"` and `"${A[*]}"` still become one word per element.
        canSplit ||= quote === '"' && char === '$' && splitsInQuotes(command, at)
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
    } else if (char === '#' && !isOpen && arithmetic === 0) {
      // A `#` that starts a word comments out the rest of the line (the newline itself still ends the command).
      const newline = command.indexOf('\n', at)

      at = newline === -1 ? command.length : newline - 1
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else if ((char === '$' && following === '(' && command[at + 2] !== '(') || char === '`' || ((char === '<' || char === '>') && following === '(' && arithmetic === 0)) {
      const { raw, end } = substitute(at)

      isUnknown = true
      canSplit = true
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
      canSplit ||= char === '$' || char === '`' || char === '{'
      text += char
      isOpen = true
    }
  }

  endWord()

  return commands
}



// ---- Classification ----

export type GitActor = 'lead' | Role | 'councillor'
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
  /** The values of `-m` and `--message` only: the commit's own text, which is where a task id belongs. */
  text?: string[]
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
  /** The separator that came before the command on its line (`&&`, `;`, `||`, `|`, a newline…); empty for the first. */
  before: string
  /** The values of `-o` and `--push-option` of a push. */
  pushOptions: string[]
  /** The keys `-c` and `--config-env` set, lowercased; `?` for one that is not literal. */
  configKeys: string[]
  /** Some word after the verb is not literal. */
  hasUnknown: boolean
  /** The paths cannot be trusted: one is not literal, `-C` is not, or a `cd` came earlier on the line. */
  uncertain: boolean
}

export type ForgeSegment = {
  /** `gh`, `glab`, `glab-work`… */
  tool: string
  args: string[]
  /** The flags as written (`--force`, `--input`…). */
  flags: string[]
  /** The options that took a value, with it (`-F query=@q.graphql`, `-fquery=@-`, `--field=a=b`). */
  values: Array<[flag: string, value: string]>
  /** The group is one gh and glab are known to have; an unknown one can be an alias for anything, a merge included. */
  known: boolean
  /** Some word of the call is not literal (a variable or a substitution) and is not the value of a free-text option: the group, the action, an endpoint, a query, a field, a loose argument. */
  hasUnknown: boolean
  /** An option stands before the action (`gh pr -t x merge 1`): the CLI skips it and its next word, so the action is not the one read. */
  hidesAction: boolean
  /** The first and second loose words (`pr merge`, `repo delete`, `api`). */
  group: string
  action: string
  /** The loose words (for `api`, the endpoint is the second). */
  positional: string[]
  changesState: boolean
}

// Commands that run what they are given: a `git` among their words cannot be read.
// `xargs` and `find` run a git only through their command (`xargs git …`, `find -exec git …`), so they are read apart.
const RUNNERS = new Set(['parallel', 'ssh', 'watch', 'source', '.', 'script', 'chroot', 'su', 'doas', 'osascript', 'busybox', 'coproc', 'trap'])
const BARE_VARIABLE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/
// Commands that take names and text as data and never run an argument: a `git push` among their words is not a git command.
const READERS = new Set([
  'echo', 'printf', 'cat', 'head', 'tail', 'less', 'more', 'bat', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ls', 'tree', 'stat',
  'file', 'wc', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'comm', 'man', 'info', 'which', 'whereis', 'type', 'test', '[', '[[',
  'touch', 'mkdir', 'rmdir', 'rm', 'mv', 'cp', 'ln', 'cd', 'pushd', 'popd', 'basename', 'dirname', 'realpath', 'readlink', 'true',
  'false', 'export', 'unset', 'alias', 'unalias', 'read', 'hash',
])
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])
// `hub` and `lab` are also what a service, a package, a host or a Jupyter command is called, and they sit before options and everyday
// words all the time (`jupyter lab --no-browser`, `docker compose up hub api`, `make lab release`, `pnpm --filter hub add x`). Named
// behind another command (`op run -- hub push`, `echo "lab mr merge 1" | sh`) they are the tool only before what no other tool says:
// a git verb of theirs, a group and the action that changes it, or an `api` call with a method or an endpoint. At the start of a
// command they are always read.
const HUB_LAB_VERBS = ['push', 'merge', 'rebase', 'cherry-pick', 'am', 'pull-request']
const HUB_LAB_ACTIONS = new Map<string, readonly string[]>([
  ['pr', ['merge', 'create', 'close', 'reopen', 'edit', 'ready', 'review', 'comment', 'checkout', 'lock', 'unlock', 'update-branch']],
  ['mr', ['merge', 'accept', 'create', 'new', 'close', 'reopen', 'update', 'rebase', 'approve', 'unapprove', 'revoke', 'note', 'comment', 'delete', 'del', 'checkout']],
  ['release', ['create', 'delete', 'upload', 'edit']],
  ['repo', ['create', 'delete', 'edit', 'rename', 'archive', 'transfer', 'update', 'mirror']],
  ['project', ['create', 'delete', 'fork', 'transfer', 'update', 'archive', 'mirror']],
])
// What follows `hub` or `lab` in a text for the tool to be named there: the verbs, a group and its action, `api` and a method or an
// endpoint (a word with a `/`, or `graphql`).
const HUB_LAB_CALL = [
  ...HUB_LAB_VERBS.map(verb => `${verb}(?![\\w-])`),
  ...[...HUB_LAB_ACTIONS].map(([group, actions]) => `${group}\\s+(?:${actions.join('|')})(?![\\w-])`),
  'api\\s+(?:-X|--meth|graphql(?![\\w-])|[^\\s\'"]*/)',
].join('|')
// A word that names git or a forge tool, as a text mentions it: `git`, `git-…`, `gh`, `glab`, `glab-…`, each in any case and with a
// `.exe`, and `hub` and `lab` when what follows them is a call of theirs (`~/src/hub` and `ls lab` are names). Everything that treats
// a hidden `git` as hidden treats these the same way. `after` says what `hub` and `lab` need after them: a `call` of theirs
// (`FORGE_OR_GIT_WORD`), any `word` (`FORGE_OR_GIT_FED`: a text a shell is about to run is the command, so `echo hub -C . push | sh`
// is one), or `none` (`FORGE_OR_GIT_NAME`: a word that is not literal, `$(which hub) push`, where the command is what it names).
const toolWord = (after: 'call' | 'word' | 'none') =>
  new RegExp(
    `(^|[\\s/;&|()\`'"={,}])(?:git(?:-[\\w.-]+)?|gh|glab(?:-[\\w.-]+)?|(?:hub|lab)${after === 'none' ? '' : `(?=(?:\\.exe)?\\s+${after === 'word' ? '\\S' : `(?:${HUB_LAB_CALL})`})`})(?:\\.exe)?($|[\\s;&|()\`'"{,}])`,
    'i',
  )
const FORGE_OR_GIT_WORD = toolWord('call')
const FORGE_OR_GIT_FED = toolWord('word')
const FORGE_OR_GIT_NAME = toolWord('none')
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path', '--config-env'])
// Names that skip hooks, point git elsewhere or make it run a program (a pager, an editor, an ssh or askpass command, a
// config file). `GIT_TRACE`, `LC_ALL`, `TZ`… are not among them.
const HOOK_ENV = /^(GIT_DIR$|GIT_WORK_TREE$|GIT_INDEX_FILE$|GIT_CONFIG|GIT_EXEC_PATH$|GIT_SSH|GIT_EXTERNAL_DIFF$|GIT_ASKPASS$|SSH_ASKPASS$|GIT_PROXY_COMMAND$|GIT_EDITOR$|GIT_SEQUENCE_EDITOR$|GIT_PAGER$|PAGER$|EDITOR$|VISUAL$|HOME$|XDG_CONFIG_HOME$|GIT_TEMPLATE_DIR$|HUSKY|SKIP$|LEFTHOOK|PRE_COMMIT)/
// What `export $(cat .env)` leaves in `envSets`: variables set from text the parser cannot read.
const UNKNOWN_ENV = '?'
const ENV_SETTERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local'])
// Config keys that change how git pushes, where it pushes, or run a program (a pager, an editor, a helper, a filter driver).
const UNSAFE_KEY = /^(alias\.|push\.|url\.|credential\.|filter\.|include\.path$|includeif\..+\.path$|core\.(hookspath|sshcommand|pager|editor|fsmonitor|askpass|gitproxy)$|diff\.external$|diff\..+\.(command|textconv)$|merge\..+\.driver$|(difftool|mergetool)\..+\.cmd$|sequence\.editor$|gpg\.|remote\..+\.(push|pushurl|receivepack|uploadpack|mirror)$|branch\..+\.(remote|merge|pushremote)$)/i
// What `-c` and `--config-env` may set: display and identity. Any other key can run a program or move a push.
const SAFE_CONFIG = /^(color\.[\w.-]+|core\.quotepath|advice\.[\w.-]+|i18n\.[\w.-]+|user\.(name|email))$/i
// The transports that run a command (`ext::sh -c …`, `fd::`).
const COMMAND_URL = /^(ext|fd)::/i
// Verbs that can hand a program to the remote side: `--upload-pack`, `--receive-pack` and `--exec` (a rebase's `--exec` is read apart).
const PACK_VERBS = new Set(['push', 'fetch', 'pull', 'clone', 'ls-remote', 'archive'])
const PACK_OPTIONS = ['--upload-pack', '--receive-pack', '--exec']
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

      // `timeout 10 git push`: the duration is not the command.
      if ((name === 'timeout' || name === 'gtimeout') && at < words.length) {
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
const XARGS_WRAPPERS = new Set(['eval', 'env', 'sudo', 'command', 'exec', 'nohup', 'time', 'timeout', 'gtimeout', 'nice', 'ionice', 'stdbuf', 'setsid', 'caffeinate', 'arch'])

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

// The name a word runs under: a flake reference (`nixpkgs#git`, `github:o/r#git`) is named by what follows its last `#`, a path
// by its last part, and the case and a `.exe` do not matter (macOS and Windows find `Git.exe` for `git`).
const commandName = (text: string) => base(text.slice(text.lastIndexOf('#') + 1)).toLowerCase().replace(/\.exe$/, '')

// The forge tools: gh and its `hub` ancestor, glab and `lab`.
const isForgeTool = (name: string) => name === 'gh' || name === 'hub' || name === 'lab' || name.startsWith('glab')
// A name that is git or a forge tool whatever follows it. `hub` and `lab` are left out: they are also names of other things.
const isGitName = (name: string) => name === 'git' || /^git-[a-z]/.test(name) || name === 'gh' || name.startsWith('glab')
// The words that follow `hub` to ask the forge for something; any other is a git verb (`hub push` is `git push`).
const HUB_FORGE = new Set(['api', 'pr', 'pull-request', 'ci-status', 'release', 'issue', 'browse', 'compare', 'fork', 'create', 'delete', 'sync', 'alias', 'gist'])

// Whether the words after a `hub` or `lab` named behind another command are a call of the tool's (see `HUB_LAB_VERBS`): a verb of
// theirs, a group and its action, or `api` with a method (`-X`, `--method`) or an endpoint (a word with a `/`, or `graphql`).
const isHubOrLabCall = (following: readonly Word[]): boolean => {
  const verb = following[0]?.text ?? ''

  if (HUB_LAB_VERBS.includes(verb) || HUB_LAB_ACTIONS.get(verb)?.includes(following[1]?.text ?? '') === true) {
    return true
  }

  if (verb !== 'api') {
    return false
  }

  const calls = following.slice(1)
  const endpoint = calls.find(word => !word.text.startsWith('-'))?.text ?? ''

  return calls.some(word => word.text === '-X' || /^-X./.test(word.text) || /^--meth/.test(word.text)) || /\/|^graphql$/i.test(endpoint)
}

// Whether `named` followed by `following` is a git or a forge command: `git-<verb>` alone, `git` before a verb, an option or a word
// that is not literal, `gh` and `glab` before a group, an option or a word that is not literal, and `hub` and `lab` (which are also
// names of other things) only before a call of theirs.
const runsAs = (named: string, following: readonly Word[]): boolean => {
  if (/^git-[a-z]/.test(named)) {
    return true
  }

  const next = following[0]

  if (next === undefined) {
    return false
  }

  const isOptionOrUnknown = next.isUnknown || next.text.startsWith('-')

  if (named === 'git') {
    return isOptionOrUnknown || BUILTIN_VERBS.has(next.text)
  }

  if (named === 'hub' || named === 'lab') {
    return isHubOrLabCall(following)
  }

  if (isForgeTool(named)) {
    return isOptionOrUnknown || FORGE_ROUTED.has(next.text) || next.text === 'alias' || next.text === 'project' || next.text === 'codespace' || next.text === 'cs' || FORGE_EXTENSION.has(next.text)
  }

  return false
}

// Whether a word of a command that is none of the above, followed by what a git command takes (a verb, an option, something not
// literal), runs git: `caffeinate git push`, `op run -- git push`, `mise exec -- gh pr merge`. A `git` that stands alone, or is
// followed by a word that is no verb (`pytest -k git tests/`, `brew install git curl`), is a name, not a command.
const wrapsGit = (rest: readonly Word[]): boolean => rest.some((word, at) => runsAs(commandName(word.text), rest.slice(at + 1)))

// Whether words a shell is about to run as a command line (a pipe or a feed into it) name git or a forge tool: a word that is one
// (`git`, `Git.exe`, `GLAB`, `/usr/bin/gh`), `hub` or `lab` before any word, or a flake reference to one (`nixpkgs#git push`).
const feedsGit = (words: readonly Word[]): boolean =>
  words.some((word, at) => {
    const named = commandName(word.text)

    return FORGE_OR_GIT_FED.test(` ${word.text} `) || ((named === 'hub' || named === 'lab') && words[at + 1] !== undefined) || runsAs(named, words.slice(at + 1))
  })

// What `RUNNERS` do with the words they are given: a word that is one of the tools, or a tool and the call it runs.
const runsGitIn = (rest: readonly Word[]): boolean => wrapsGit(rest) || rest.some(word => FORGE_OR_GIT_WORD.test(` ${word.text} `) || isGitName(commandName(word.text)))

// Whether a string handed to a command is itself a command line that starts a git (`nix-shell --run "git push origin main"`,
// `docker exec c sh -c "cd x && git push"`): after `&&`, `;`, `|` or a newline, past assignments, `git` (or `gh`, `glab`)
// and a verb. A `git` in the middle of a sentence is prose.
const textRunsGit = (text: string): boolean => {
  if (!/\s/.test(text)) {
    return false
  }

  for (const piece of text.split(/&&|\|\||[;|(\n]/)) {
    const tokens = piece.trim().split(/\s+/)
    let at = 0

    while (/^[A-Za-z_]\w*=/.test(tokens[at] ?? '')) {
      at += 1
    }

    const head = commandName(tokens[at] ?? '')

    // `nix run nixpkgs#git -- push`, as a string.
    const wordsFrom = (index: number): Word[] => tokens.slice(index).map(text => ({ text, isUnknown: false, isHome: false }))

    if (head === 'nix') {
      return wrapsGit(wordsFrom(at + 1))
    }

    if (head === 'git' || head === 'hub') {
      // Past git's own options (and the value of those that take one), the verb.
      let next = at + 1

      while ((tokens[next] ?? '').startsWith('-')) {
        next += GIT_VALUED.has(tokens[next] ?? '') ? 2 : 1
      }

      if (runsAs(head, wordsFrom(next))) {
        return true
      }
    } else if (runsAs(head, wordsFrom(at + 1))) {
      return true
    }
  }

  return false
}

// Whether the command an `xargs` or a `find -exec` stage runs is a git or a forge tool, a shell, a wrapper or not literal.
const runsGit = (command: Word | undefined) => {
  const named = commandName(command?.text ?? '')

  return command !== undefined && (command.isUnknown || named === 'git' || /^git-[a-z]/.test(named) || isForgeTool(named) || SHELLS.has(shellName(named)) || XARGS_WRAPPERS.has(named))
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

  if (SHELLS.has(shellName(name)) || name === 'eval') {
    return rest.some(word => word.isUnknown)
  }

  if (name === 'xargs') {
    const command = xargsCommand(rest)
    const named = base(command?.text ?? '')

    return command !== undefined && (command.isUnknown || SHELLS.has(shellName(named)) || XARGS_WRAPPERS.has(named))
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
    isGitSeen ||= feedsGit(one.words)
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

      // git takes unambiguous prefixes of long options (`--rep origin` is `--repo origin`).
      if (value === undefined && longValued.some(name => flag === name || (flag.length >= 4 && name.startsWith(flag)))) {
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
const gitSegment = (words: readonly Word[], isAdrift: boolean, assigns: readonly string[], before = ''): GitSegment | undefined => {
  const global: string[] = []
  const configKeys: string[] = []
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

    if (flag === '-c' || flag === '--config-env' || flag.startsWith('--config-env=')) {
      const isLiteral = config !== undefined && value?.isUnknown !== true && words[at]?.isUnknown !== true

      configKeys.push(isLiteral ? config.split('=')[0]?.toLowerCase() ?? '?' : '?')
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
  const pushOptions = verb === 'push'
    ? values.filter(([flag]) => flag === '-o' || (flag.startsWith('--') && flag.length >= 4 && '--push-option'.startsWith(flag))).map(([, value]) => value)
    : []
  const base = { verb, args: args.map(arg => arg.text), positional: positional.map(word => word.text), changesState: changesState(verb, args), flags, global, assigns: [...assigns], alias, unsafeConfig, configKeys, before, pushOptions, hasUnknown: args.some(arg => arg.isUnknown) }

  if (spec === undefined) {
    return { ...base, paths: [], uncertain }
  }

  const paths = positional.map(word => pathOf(dir, word.text))
  const isUnsure = uncertain || positional.some(word => word.isUnknown)

  if (verb === 'commit') {
    // Long options are read as git reads them, by unambiguous prefix (`--mess=x` is `--message=x`).
    const named = (flag: string, long: string) => flag === long || (flag.length >= 4 && long.startsWith(flag))
    const message = values.filter(([flag]) => flag === '-m' || ['--message', '--trailer', '--author'].some(long => named(flag, long))).map(([, value]) => value)
    const text = values.filter(([flag]) => flag === '-m' || named(flag, '--message')).map(([, value]) => value)

    return { ...base, paths, message, text, uncertain: isUnsure }
  }

  return { ...base, paths, uncertain: isUnsure }
}

// ---- gh and glab ----

// The command groups that change the repository's side of the forge (pull and merge requests, the repository itself, its
// releases, a raw API call). Anything else (`issue`, `run`, `workflow`, `ci`…) is not git work and is not routed to the git role.
const FORGE_ROUTED = new Set(['pr', 'mr', 'repo', 'api', 'release'])
// Groups gh and glab have that are not git work: they pass for every actor. `alias` and `extension` are read apart, and a
// group in none of these lists is unknown (an alias such as `gh mm` can be `pr merge --admin`): it is held as state-changing.
const FORGE_OTHER = new Set([
  '', 'issue', 'run', 'workflow', 'ci', 'cache', 'codespace', 'gist', 'label', 'org', 'project', 'secret', 'variable', 'ssh-key', 'gpg-key',
  'status', 'search', 'browse', 'auth', 'config', 'completion', 'help', 'version', 'attestation', 'copilot', 'agent-task', 'ruleset',
  'incident', 'snippet', 'user', 'schedule', 'deploy-key', 'milestone', 'iteration', 'job', 'runner', 'token', 'cluster', 'securefile',
  'stack', 'check-update', 'duo', 'changelog', 'discussion', 'skill', 'licenses', 'preview', 'packages', 'container-registry',
  'dependency-firewall', 'artifact-registry', 'mcp', 'orbit', 'security', 'skills', 'todo', 'whatsnew', 'work-items', 'opentofu',
  'runner-controller',
])
const FORGE_EXTENSION = new Set(['extension', 'extensions', 'ext'])
// Groups that run a command they are given (on another machine, or an extension's): a git among their words is hidden.
const FORGE_RUNS = new Set(['codespace', 'extension', 'extensions', 'ext', 'copilot'])
// glab's own names for the same thing: `project` is `repo`, `pipe` and `pipeline` are `ci`, and a few subcommands have aliases
// (`mr accept` is `mr merge`). Read from `glab <group> <alias> --help` on the installed glab.
const GLAB_GROUPS: Record<string, string> = { project: 'repo', pipe: 'ci', pipeline: 'ci' }
const GLAB_ACTIONS: Record<string, Record<string, string>> = {
  mr: { accept: 'merge', unapprove: 'revoke', del: 'delete', open: 'reopen', comment: 'note', show: 'view', new: 'create', ls: 'list' },
  repo: { ls: 'list' },
  release: { ls: 'list' },
}
// `hub`'s own commands, as the gh command they are: `hub pull-request` is `gh pr create`.
const HUB_GROUPS: Record<string, [group: string, action: string]> = {
  'pull-request': ['pr', 'create'], fork: ['repo', 'fork'], create: ['repo', 'create'], delete: ['repo', 'delete'], sync: ['repo', 'sync'],
  'ci-status': ['ci', ''], browse: ['browse', ''], compare: ['browse', ''],
}
const FORGE_READ_ACTIONS = new Set(['', 'view', 'list', 'ls', 'status', 'diff', 'checks', 'show', 'get', 'watch', 'trace', 'clone'])
// What a call with a word that is not literal may still be: a read nobody can turn into a write by what the word holds.
const OBVIOUS_READS: Record<string, readonly string[]> = {
  pr: ['view', 'list', 'checks', 'diff', 'status'], mr: ['view', 'list', 'diff'], issue: ['view', 'list'], repo: ['view'],
}
// Whether an option is `name`: as written, or a long option as an unambiguous prefix of it (`--fie` is `--field`).
const isOption = (flag: string, name: string) => flag === name || (name.startsWith('--') && flag.startsWith('--') && flag.length >= 4 && name.startsWith(flag))
// The options of `api` that send fields (`-f`, `-F`, `--field`, `--raw-field`) and the one that sends a body (`--input`).
const isFieldOption = (flag: string) => ['-f', '-F', '--field', '--raw-field'].some(name => isOption(flag, name))
const isFieldFlag = (flag: string) => isFieldOption(flag) || isOption(flag, '--input')

// Options whose value is free text a call carries and does not act on: a title, a body, a description, notes, a message, a subject, a
// label, an assignee, a branch. A value that is not literal there (`--body "$(cat b.md)"`) changes no group, action or endpoint, so
// the call can still be read. `-t` and `-b` are the same option in gh, glab and hub for what the git role runs (a title; a body, or
// glab's target branch); `-d`, `-m` and `-n` are not (`gh pr create -d` is a draft, `gh pr merge -d` and `-m` are not text).
const FREE_TEXT_OPTIONS = new Set(['--title', '--body', '--body-file', '--description', '--notes', '--message', '--assignee', '--label', '--base', '--subject'])
const FREE_TEXT_SHORT = new Set(['-t', '-b'])

// Whether a word of the call is not literal and is something other than the value of a free-text option: the group, the action, an
// endpoint, a query, a field, a loose argument (`gh pr merge "$N"`, which can expand to `-b main --force`). The value is exempt
// only as one word: an unquoted `$X`, `$(…)` or `{a,b}` is split by the shell (`-b {main,--force}` is `-b main --force`).
const hasUnreadWord = (args: readonly Word[]): boolean => {
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at]
    const text = word?.text ?? ''

    if (word === undefined) {
      continue
    }

    if (text === '--') {
      return args.slice(at + 1).some(rest => rest.isUnknown)
    }

    const eq = text.indexOf('=')
    const isLong = text.startsWith('--') && FREE_TEXT_OPTIONS.has(eq === -1 ? text : text.slice(0, eq))
    const isShort = !text.startsWith('--') && FREE_TEXT_SHORT.has(text.slice(0, 2))

    if (isLong || isShort) {
      // The value is glued (`--body=…`, `-t…`) or the next word.
      const isGlued = isLong ? eq !== -1 : text.length > 2
      const value = isGlued ? word : args[at + 1]

      at += isGlued ? 0 : 1

      if (value?.isUnknown === true && value.canSplit === true) {
        return true
      }

      continue
    }

    if (word.isUnknown) {
      return true
    }
  }

  return false
}

// Whether an option comes before the action of a gh, glab or lab call. cobra, looking for the subcommand, reads any flag it does not
// know as taking the next word as its value, so `gh pr -t x merge 1` runs `pr merge 1` while the words read as `pr x`. Only `-R`
// and `--repo` (the group's own), the help and version flags may stand there, and so may an option with `=` or glued to its value
// (it takes none) or one with no word after it (`gh --version`).
const hidesAction = (tool: string, args: readonly Word[]): boolean => {
  if (tool !== 'gh' && tool !== 'lab' && !tool.startsWith('glab')) {
    return false
  }

  let seen = 0

  for (let at = 0; at < args.length && seen < 2; at += 1) {
    const text = args[at]?.text ?? ''

    if (text === '--') {
      return false
    }

    if (text === 'api' && seen === 0) {
      // `api` is a command of its own: its options are read after it.
      return false
    }

    if (text === '-R' || text === '--repo') {
      at += 1
    } else if (/^-[^-]$/.test(text) ? text !== '-h' && text !== '-v' : text.startsWith('--') && !text.includes('=') && text !== '--help' && text !== '--version') {
      // It hides something only when a word that is no option comes after it (`gh --version` has no action to move).
      return args.slice(at + 1).some(word => !word.text.startsWith('-'))
    } else if (!text.startsWith('-')) {
      seen += 1
    }
  }

  return false
}

const forgeSegment = (tool: string, args: readonly Word[]): ForgeSegment => {
  const { flags, values, positional } = scan(args, 'RXfFH', ['--repo', '--hostname', '--method', '--field', '--raw-field', '--header', '--input', '--jq', '--template', '--preview'])
  let group = positional[0]?.text ?? ''
  let action = positional[1]?.text ?? ''

  // The same command under another name is the same command.
  if (tool === 'hub' && HUB_GROUPS[group] !== undefined) {
    ;[group, action] = HUB_GROUPS[group] as [string, string]
  } else if (tool.startsWith('glab') || tool === 'lab') {
    group = GLAB_GROUPS[group] ?? group
    action = GLAB_ACTIONS[group]?.[action] ?? action
  } else if (group === 'co') {
    group = 'pr'
    action = 'checkout'
  } else if (group === 'cs') {
    group = 'codespace'
  }

  // `--meth PUT` is `--method PUT`: git's tools read long options by unambiguous prefix.
  const method = values.find(([flag]) => flag === '-X' || (flag.startsWith('--') && flag.length >= 4 && '--method'.startsWith(flag)))?.[1]
  const hasFields = flags.some(isFieldFlag)
  let changes: boolean

  const known = FORGE_ROUTED.has(group) || FORGE_OTHER.has(group) || group === 'alias' || group === 'codespace' || FORGE_EXTENSION.has(group)

  if (FORGE_ROUTED.has(group)) {
    if (flags.includes('--push')) {
      changes = true
    } else if (group === 'api') {
      // With a method, that method says; without one, fields make it a POST.
      changes = method === undefined ? hasFields : method.toUpperCase() !== 'GET'
    } else {
      changes = !FORGE_READ_ACTIONS.has(action)
    }
  } else if (group === 'alias') {
    // `gh alias set mm 'pr merge --admin'` hides a merge behind a word nobody reads.
    changes = action === 'set' || action === 'import'
  } else if (FORGE_EXTENSION.has(group)) {
    changes = action === 'install' || action === 'upgrade' || action === 'exec' || action === 'create'
  } else if (group === 'codespace') {
    // `gh codespace ssh -- git push origin main` runs a command on another machine, out of reach of this gate.
    changes = action === 'ssh' || action === 'cp' || action === 'exec'
  } else {
    changes = !FORGE_OTHER.has(group)
  }

  // What an option before the action hides is unknown: it is state-changing until shown otherwise.
  const hidesIt = hidesAction(tool, args)

  return { tool, args: args.map(arg => arg.text), flags, values, known, hasUnknown: group === 'api' ? args.some(arg => arg.isUnknown) : hasUnreadWord(args), hidesAction: hidesIt, group, action, positional: positional.map(word => word.text), changesState: changes || hidesIt }
}

export type Classified = { segments: GitSegment[]; forges: ForgeSegment[]; opaque: boolean; envSets: string[] }

// An option word as the shells that spell options loosely read it: PowerShell takes `-`, `--` or `/` for the first dash, in any
// case, and `-Name:value` or `--name=value` attaches a value. Returns the lowercased name, or undefined for a word that is no option.
const optionName = (text: string): string | undefined => /^(?:--|-|\/)([A-Za-z][\w-]*)(?:[=:].*)?$/s.exec(text)?.[1]?.toLowerCase()

// Whether `text` hands the shell a command line to run: `-c` (also in a cluster, `-lc`), `--command`, nu's `--commands` and
// `-e`/`--execute`, fish's `-C` and `--init-command`; PowerShell takes any prefix of `-Command` and `-CommandWithArgs`
// (`-c`, `--c`, `/Command`, `-cwa`…).
const shellCommandOption = (shell: string, text: string): boolean => {
  const name = optionName(text)

  if (name === undefined) {
    return false
  }

  if (shell === 'pwsh' || shell === 'powershell') {
    return 'command'.startsWith(name) || (name.length >= 8 && 'commandwithargs'.startsWith(name)) || name === 'cwa'
  }

  if (/^-[A-Za-z]*c[A-Za-z]*$/.test(text) || ['command', 'commands'].includes(name)) {
    return true
  }

  return (shell === 'nu' && (name === 'e' || name === 'execute')) || (shell === 'fish' && (name === 'c' || name === 'init-command'))
}

// PowerShell's encoded command (`-EncodedCommand`, `-ec`, `-e`, any prefix of the name, with `-`, `--`, `/` or none): base64 that
// cannot be read.
const isEncodedCommand = (text: string) => /^(?:--|-|\/)?e(?:c|n[a-z]*)?(?:[=:].*)?$/is.test(text)

const classifyDepth = (command: string, depth: number, inherit: readonly string[]): Classified => {
  const found: Classified = { segments: [], forges: [], opaque: false, envSets: [] }
  let isAdrift = false

  if (depth > 4) {
    found.opaque = FORGE_OR_GIT_WORD.test(command)

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
    const name = commandName(first?.text ?? '')
    const rest = eff.argv.slice(1)

    isAdrift ||= eff.moved

    // `bash < <(echo git push)`: the substitution feeds a shell.
    if (one.sub !== undefined && (readsCommands(one.words) || name === 'source' || name === '.') && flatten(one.sub).some(inner => feedsGit(inner.words))) {
      found.opaque = true
    }

    if (eff.split !== undefined) {
      const text = eff.split.map(word => word.text).join(' ')

      merge(classifyDepth(text, depth + 1, assigns))
      found.opaque ||= eff.split.some(word => word.isUnknown) && FORGE_OR_GIT_WORD.test(` ${text} `)

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
      const segment = gitSegment(words, isAdrift, assigns, one.before)

      if (segment === undefined) {
        found.opaque = true
      } else {
        found.segments.push(segment)
        found.opaque ||= segment.alias
      }
    } else if (name === 'hub' && rest[0]?.text === 'merge' && rest.some(word => /^https?:\/\//.test(word.text))) {
      // `hub merge <pull request URL>` is hub's own command: it fetches that pull request's head and runs `git merge --no-ff`
      // locally, a call to no forge API. It is still the merge of that pull request, so it is read as `pr merge` and refused as that is.
      const forge = forgeSegment(name, [{ text: 'pr', isUnknown: false, isHome: false }, ...rest])

      found.forges.push(forge)
    } else if (name === 'hub' && !HUB_FORGE.has(rest[0]?.text ?? '')) {
      // `hub` forwards what it does not know to git: `hub push origin main` is `git push origin main`.
      const segment = gitSegment(rest, isAdrift, assigns, one.before)

      if (segment === undefined) {
        found.opaque = true
      } else {
        found.segments.push(segment)
        found.opaque ||= segment.alias
      }
    } else if (isForgeTool(name)) {
      const forge = forgeSegment(name, rest)

      found.forges.push(forge)
      // `gh codespace ssh -- git push`, `gh extension exec x git push`: these groups run what they are given.
      found.opaque ||= FORGE_RUNS.has(forge.group) && (wrapsGit(rest) || rest.some(word => textRunsGit(word.text)))
    } else if (SHELLS.has(shellName(first.text)) || name === 'eval') {
      const shell = name === 'eval' ? 'eval' : shellName(first.text)
      const isPosix = shell === 'eval' || POSIX_SHELLS.has(shell)
      const isPowerShell = shell === 'pwsh' || shell === 'powershell'

      // A PowerShell command that is encoded cannot be read.
      found.opaque ||= isPowerShell && rest.some(word => isEncodedCommand(word.text))

      // The text of a word as a command line: what follows the `=` of `--command=…`.
      const lineOf = (word: Word) => (/^(?:--|-|\/)[A-Za-z][\w-]*[=:]/.test(word.text) ? word.text.slice(word.text.search(/[=:]/) + 1) : word.text)
      // Words that are handed to the shell as a command line, whatever the option before them is called.
      const bodies: Word[] = []

      if (shell === 'eval') {
        if (rest.length > 0) {
          merge(classifyDepth(rest.map(word => word.text).join(' '), depth + 1, assigns))
        }
      } else if (isPosix) {
        // `-c` is a contract: the word after it is the command line.
        rest.forEach((word, at) => {
          const attached = /^--commands?=/.test(word.text) ? word.text.indexOf('=') : -1

          if (attached !== -1) {
            bodies.push({ text: word.text.slice(attached + 1), isUnknown: word.isUnknown, isHome: false })
          } else if (shellCommandOption(shell, word.text) && rest[at + 1] !== undefined) {
            bodies.push(rest[at + 1] as Word)
          }
        })
      } else {
        // No such contract: every word that holds a command line is read as `bash -c` reads one, and an unquoted `git push`
        // among the words is a git.
        for (const word of rest) {
          if (/\s/.test(lineOf(word))) {
            bodies.push({ text: lineOf(word), isUnknown: word.isUnknown, isHome: false })
          }
        }

        found.opaque ||= wrapsGit(rest)
      }

      for (const body of bodies) {
        merge(classifyDepth(body.text, depth + 1, assigns))
      }

      // A command line that is not literal (`eval "$X"`, `fish -c "$X"`) runs whatever the variable holds: it is hidden git when
      // the line mentions git at all.
      const unknownBody = shell === 'eval'
        ? rest.some(word => word.isUnknown)
        : rest.some((word, at) => word.isUnknown && (shellCommandOption(shell, rest[at - 1]?.text ?? '') || /^(?:--|-|\/)[A-Za-z][\w-]*[=:]/.test(word.text)))

      found.opaque ||= unknownBody && (FORGE_OR_GIT_WORD.test(` ${command} `) || rest.some(word => word.isUnknown && FORGE_OR_GIT_NAME.test(` ${word.text} `)))

      if (shell !== 'eval' && bodies.length === 0 && isPosix) {
        // `bash "$(echo git push)"`: a script argument that holds git.
        found.opaque ||= rest.some(word => word.isUnknown && FORGE_OR_GIT_NAME.test(` ${word.text} `))
      }
    } else if (name === 'xargs') {
      // Only what `xargs` runs matters: `xargs grep -l git` runs no git.
      found.opaque ||= runsGit(xargsCommand(rest))
    } else if (name === 'find') {
      found.opaque ||= rest.some((word, at) => FIND_EXEC.has(word.text) && runsGit(rest[at + 1]))
    } else if (RUNNERS.has(name) || (first.isUnknown && (FORGE_OR_GIT_NAME.test(` ${first.text} `) || (BARE_VARIABLE.test(first.text) && FORGE_OR_GIT_WORD.test(` ${command} `))))) {
      found.opaque ||= (first.isUnknown && (FORGE_OR_GIT_NAME.test(` ${first.text} `) || (BARE_VARIABLE.test(first.text) && FORGE_OR_GIT_WORD.test(` ${command} `)))) || runsGitIn(rest)
    } else if (!READERS.has(name) && !ENV_SETTERS.has(name) && (wrapsGit(rest) || rest.some(word => textRunsGit(word.text)))) {
      // Any other command that runs what follows it (`caffeinate`, `op run --`, `flock f`, `xcrun`, `nix-shell --run "…"`)
      // hides the git it runs, as a word or as a command line in a string.
      found.opaque = true
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
  // Read-only git may carry harmless variables (`LC_ALL=C git status`, `TZ=UTC git log`); anything that changes state, skips hooks or runs a program may not.
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

export const PROTECTED_DEFAULT = ['main', 'master', 'develop', 'release', 'release/*']

// Whether `name` is one of the protected names: exact, or under a `prefix/*` pattern.
export const isProtected = (name: string, patterns: readonly string[]) =>
  patterns.some(pattern => (pattern.endsWith('/*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern))

// The lead's push: no forced, deleting, mirroring or hook-skipping push, nothing to a protected branch by name, no config overrides.
const pushVerdict = (segment: GitSegment, envSets: readonly string[], protectedNames: readonly string[]): GitVerdict | undefined => {
  const longs = segment.flags.filter(flag => flag.startsWith('--'))
  // git takes unambiguous prefixes of long options.
  const hasLong = (name: string) => longs.some(flag => flag === name || (flag.length >= 4 && name.startsWith(flag)))
  const hasRepo = hasLong('--repo')
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

  if (hasLong('--receive-pack') || hasLong('--exec')) {
    return deny('`--receive-pack` and `--exec` run another program on the receiving side in place of git; do not use them.')
  }

  // GitLab push options open, retarget and merge a merge request from the push itself.
  if (segment.pushOptions.some(option => /^merge_request\./i.test(option.trim()))) {
    return deny('A `merge_request.*` push option opens or merges a merge request from the push; open the MR through the git role.')
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

// The branch a ref text names: `refs/heads/x`, `heads/x`, `refs/remotes/<remote>/x` and `refs/tags/x` all read as `x`.
const refName = (text: string) => text.replace(/^refs\/(heads|tags)\//, '').replace(/^heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '')

// Whether the segment has one of these options, long ones by unambiguous prefix as git reads them.
const hasOption = (segment: GitSegment, ...names: string[]) =>
  segment.flags.some(flag => names.some(name => flag === name || (name.startsWith('--') && flag.startsWith('--') && flag.length >= 4 && name.startsWith(flag))))

// The word after the first of `names` in the arguments (`checkout -b NAME`).
const wordAfter = (segment: GitSegment, ...names: string[]) => {
  const at = segment.args.findIndex(arg => names.includes(arg))

  return at === -1 ? undefined : segment.args[at + 1]
}

// What the git role (or a lead acting as it) may not do beyond the push: change a protected branch by name, rewrite the
// configuration that decides where a push goes, or hand git another program.
const gitScopeVerdict = (segment: GitSegment, protectedNames: readonly string[]): GitVerdict | undefined => {
  const text = segment.args.join(' ')
  const isProtectedRef = (name: string) => isProtected(refName(name), protectedNames)
  const protectedReason = (name: string) => `\`${refName(name)}\` is a protected branch (${protectedNames.join(', ')}); the person changes those, not an agent.`

  if (segment.alias) {
    return deny('Defining aliases with `-c alias.*` is not allowed: they hide the verb.')
  }

  if (segment.unsafeConfig) {
    const key = segment.configKeys.find(name => UNSAFE_KEY.test(name)) ?? 'a push setting'

    return deny(`Do not override \`${key}\` with \`-c\` or \`--config-env\`: push settings, remotes, \`core.hooksPath\`, \`core.sshCommand\`, helpers and pack programs stay as configured.`)
  }

  if (segment.flags.some(flag => flag.length >= 4 && ['--upload-pack', '--receive-pack'].some(name => name.startsWith(flag)))) {
    return deny('`--upload-pack` and `--receive-pack` run another program in place of git; do not use them.')
  }

  // Any loose word may be the key: `git config set k v`, `--file x k v` and `--blob b k` put other words first.
  const unsafeKey = segment.verb === 'config' && segment.changesState ? segment.positional.find(word => UNSAFE_KEY.test(word)) : undefined

  if (unsafeKey !== undefined) {
    return deny(`Do not write \`${unsafeKey}\`: aliases, push settings, remotes, \`url.*\`, \`core.hooksPath\`, \`core.sshCommand\`, helpers and remote pack programs stay as configured.`)
  }

  if (segment.verb === 'branch' && segment.changesState) {
    const targets = hasOption(segment, '-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy')
      ? segment.positional
      : hasOption(segment, '-f', '--force') ? segment.positional.slice(0, 1) : []
    const hit = targets.find(isProtectedRef)

    if (hit !== undefined) {
      return deny(`\`git branch\` on ${protectedReason(hit)}`)
    }
  }

  if (segment.verb === 'update-ref' && hasOption(segment, '--stdin')) {
    return deny('`git update-ref --stdin` updates refs the command line does not show; name the ref.')
  }

  if (segment.verb === 'update-ref') {
    const hit = segment.positional.find(isProtectedRef)

    if (hit !== undefined) {
      return deny(`\`git update-ref\` on ${protectedReason(hit)}`)
    }
  }

  if (segment.verb === 'tag' && segment.changesState && hasOption(segment, '-d', '--delete', '-f', '--force')) {
    const names = hasOption(segment, '-d', '--delete') ? segment.positional : segment.positional.slice(0, 1)
    const hit = names.find(isProtectedRef)

    if (hit !== undefined) {
      return deny(`\`git tag\` of a name that reads as ${protectedReason(hit)}`)
    }
  }

  if (segment.verb === 'checkout' || segment.verb === 'switch' || segment.verb === 'worktree') {
    const made = wordAfter(segment, '-b', '-B', '-c', '-C', '--create', '--force-create', '--orphan')

    if (made !== undefined && isProtectedRef(made)) {
      return deny(`\`git ${segment.verb}\` creating or resetting ${protectedReason(made)}`)
    }
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
// Endpoints that move a branch or write a commit on one: refs, branches (and their protection), merges, contents and files.
const FORGE_BRANCH_ENDPOINT = /\/(git\/refs|branches|protected_branches|rulesets|contents|repository\/(branches|files|commits))\b/

// The endpoint of an `api` call as the API reads it: no scheme or host, no query string, no leading or trailing `/`, in lower case
// (`/graphql`, `GraphQL`, `https://api.github.com/graphql?x=1` and `graphql` are one endpoint).
const endpointOf = (text: string) => text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/[?#].*$/s, '').replace(/^\/+|\/+$/g, '').toLowerCase()
const isGraphql = (endpoint: string) => endpoint === 'graphql' || endpoint.endsWith('/graphql')

const forgeScopeVerdict = (forge: ForgeSegment): GitVerdict | undefined => {
  const endpoint = forge.group === 'api' && forge.changesState ? endpointOf(forge.positional[1] ?? '') : ''
  const isApiMerge = /\/merges?\b/.test(`/${endpoint}`)

  if (((forge.group === 'pr' || forge.group === 'mr') && forge.action === 'merge') || isApiMerge) {
    return deny('Merging a PR/MR is the person\'s call; open it and leave the merge.')
  }

  if (FORGE_BRANCH_ENDPOINT.test(`/${endpoint}`) || (isGraphql(endpoint) && /\bmutation\b/i.test(forge.args.join(' ')))) {
    return deny('Changing branches, refs or files through the forge API is the person\'s call; use `git` and the PR/MR commands instead.')
  }

  // A query read from a file or from stdin (`--input`, or a field whose value is `query=@file` or `query=@-`, glued to its option or
  // not) cannot be read here: it may be a mutation.
  const readsQuery = forge.flags.some(flag => isOption(flag, '--input')) || forge.values.some(([flag, value]) => isFieldOption(flag) && value.startsWith('query=@'))

  if (isGraphql(endpoint) && readsQuery) {
    return deny('A GraphQL query read from a file or stdin cannot be checked for a mutation; write the query on the command line, or leave it to the person.')
  }

  if (forge.group === 'repo' && forge.action === 'sync' && forge.flags.some(flag => flag.startsWith('--') && flag.length >= 4 && '--force'.startsWith(flag))) {
    return deny('`repo sync --force` overwrites the branch it syncs; leave it to the person.')
  }

  if (forge.changesState && (forge.group === 'alias' || FORGE_EXTENSION.has(forge.group))) {
    return deny('Aliases and extensions can hide a merge or run a program; use the documented commands.')
  }

  if (forge.hidesAction) {
    return deny('An option before the action of this call (`gh pr -t x merge 1`) makes the CLI skip the next word as its value and run another action; write the action first and the options after it (only `-R` may come before).')
  }

  // What a word that is not literal holds decides what the call changes (an endpoint, a query, a field, the action): unless the call
  // is a read whatever the word is, it cannot be checked.
  const isObviousRead = forge.group === 'api'
    ? !forge.changesState && !forge.flags.some(isFieldFlag)
    : (OBVIOUS_READS[forge.group] ?? []).includes(forge.action)

  if (forge.hasUnknown && !isObviousRead) {
    return deny(`A word of this \`${forge.tool}\` call is not literal (a variable or a substitution), so what it changes cannot be checked; rewrite it as a literal command.`)
  }

  if (forge.group === 'codespace' && forge.changesState) {
    return deny('`gh codespace ssh|cp|exec` runs commands on another machine, out of the gate\'s reach; leave it to the person.')
  }

  if (!forge.known) {
    return deny('That is not a `gh` or `glab` command Pantheon knows (it may be an alias for a merge); use the documented commands.')
  }

  if (forge.group === 'repo' && forge.action === 'delete') {
    return deny('Deleting a repository is denied.')
  }

  // The repository's own settings, owner and mirroring are not git work (`glab repo archive` only downloads an archive).
  if (forge.group === 'repo' && (['transfer', 'mirror', 'update', 'edit', 'rename'].includes(forge.action) || (forge.action === 'archive' && forge.tool === 'gh'))) {
    return deny('Changing a repository\'s settings, name, owner, mirroring or archive state is the person\'s call.')
  }

  return undefined
}

const OPAQUE_REASON = 'A `git` command is hidden in `eval`, `bash -c`, `xargs`, `ssh`, `… | sh`, an alias, brace expansion or a variable, where it cannot be checked; rewrite it as a literal command (`git push origin <branch>` written out, no variable for the verb, `eval` or pipe into a shell).'

// What no actor may do, whatever the verb: hand git a program through `-c`, the environment, a command URL or a pack option.
const commonVerdict = (segment: GitSegment, envSets: readonly string[]): GitVerdict | undefined => {
  const key = segment.configKeys.find(name => !SAFE_CONFIG.test(name))

  if (key !== undefined) {
    return deny(`\`-c ${key === '?' ? '<not literal>' : key}\` (or \`--config-env\`) can make git run a program or move a push; only color.*, core.quotepath, advice.*, i18n.*, user.name and user.email may be set that way.`)
  }

  if (segment.assigns.some(name => HOOK_ENV.test(name)) || envSets.length > 0) {
    return deny('Do not set environment around git (hook-skip variables, `GIT_DIR`, `GIT_CONFIG*`, `GIT_SSH*`, `GIT_PAGER`, `PAGER`, `EDITOR`, `HOME`, or exports it cannot read): hooks, programs and the repository must stay as configured.')
  }

  if (segment.args.some(arg => COMMAND_URL.test(arg))) {
    return deny('`ext::` and `fd::` remotes run a command; use a normal remote URL.')
  }

  if (PACK_VERBS.has(segment.verb) && hasOption(segment, ...PACK_OPTIONS)) {
    return deny('`--upload-pack`, `--receive-pack` and `--exec` run another program in place of git; do not use them.')
  }

  return undefined
}

// The tool, the group and the action, never the arguments: they can carry a token, a URL with a password or a message.
const forgeName = (forge: ForgeSegment) => (forge.group === 'api' ? `${forge.tool} api` : `${forge.tool} ${forge.group} ${forge.action}`.trim())

const forgeReason = (forge: ForgeSegment) =>
  forge.group === 'pr' || forge.group === 'mr'
    ? `PR/MR work goes to the git role: \`${forgeName(forge)}\`.`
    : `\`${forgeName(forge)}\` changes state on the forge; route it to the git role.`

/**
 * Whether `actor` may run `command`. The strictest segment decides; a hidden `git` is denied for every actor, the git role
 * included. With `gitRole: false` (the git role is disabled) the lead may do what `git` does, under the git role's own limits,
 * except push unsafely and run a hidden `git`. `protected` lists the branches a push may not name: exact names or `prefix/*`.
 * `found` is the caller's own `classifyGitCommand(command)`, to read the line once. The text cannot say which branch is
 * checked out, so a push that names none is decided by the caller (`gitguard.ts`).
 */
export function gitAllowed(actor: GitActor, command: string, owns: (path: string) => boolean, opts: { gitRole?: boolean; protected?: string[]; found?: Classified } = {}): GitVerdict {
  const { segments, forges, opaque, envSets } = opts.found ?? classifyGitCommand(command)
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
      verdict = segment.verb === 'push' ? deny('The lead pushes; report back and let the lead run `git push`.') : gitScopeVerdict(segment, protectedNames)
    } else if (actor === 'lead') {
      if (segment.verb === 'push') {
        verdict = pushVerdict(segment, envSets, protectedNames) ?? (isGitScope ? gitScopeVerdict(segment, protectedNames) : undefined)
      } else if (isGitScope) {
        verdict = gitScopeVerdict(segment, protectedNames)
      } else if (segment.changesState) {
        verdict = deny(`Delegate \`${label(segment)}\` to the \`git\` role; the lead only pushes.`)
      }
    } else if (isDev) {
      verdict = devVerdict(segment, owns)
    } else {
      verdict = segment.changesState ? deny(`${actor} is read-only; ask the lead to route \`${label(segment)}\` to the \`git\` role.`) : undefined
    }

    // What no actor may do goes last, so each actor's own reason comes first.
    verdict ??= commonVerdict(segment, envSets)

    if (verdict !== undefined) {
      return verdict
    }
  }

  return opaque ? deny(OPAQUE_REASON) : { allow: true }
}
