// The parser, `resolve`, `locate` and the temp repository check are trimmed from the blast-radius
// plugin, which has since been removed; they live only here now.

/** A word of the command, already unquoted, and what the shell would still do with it. */
export type Word = {
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

export const IN_HOME = /^~(\/|$)/

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
  env: { short: new Set(['u', 'S']), long: new Set(['--unset', '--split-string']) },
}

// The options of a wrapper that take no value; any other option is unknown.
const FLAGS: Record<string, Set<string>> = { sudo: new Set('AbEHiKklnPSsVvB'), env: new Set('i0vPC') }

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

export type Command = {
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
export const parse = (command: string): Command[] => {
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
    commands.length = patternFrom + 1
    const first = commands[patternFrom]

    if (first !== undefined) {
      first.words = []
    }

    isPattern = false
  }
  const startPattern = () => {
    isPattern = true
    patternFrom = commands.length - 1
  }

  const endWord = () => {
    const redirection = isOpen && !isQuoted ? REDIRECTION.exec(text) : null

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
export const enter = (dir: string, to: string) => resolve(IN_HOME.test(to) ? '.' : dir, to)

/** Where `dir` really is: from the home when it starts with `~`, otherwise from `cwd`. */
export const locate = (cwd: string, dir: string, home: string | undefined): string | undefined => {
  if (!IN_HOME.test(dir)) {
    return resolve(cwd, dir)
  }

  return home === undefined ? undefined : resolve(home, `.${dir.slice(1)}`)
}

export const bare = (words: readonly Word[]) => {
  let start = 0

  for (; start < words.length; start += 1) {
    const text = words[start]?.text ?? ''

    if (!ASSIGNMENT.test(text) && !WRAPPERS.has(text) && !OPENERS.has(text)) {
      break
    }
  }

  return words.slice(start)
}
