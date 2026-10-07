// The parser, `resolve`, `locate` and the temp repository check are trimmed from the blast-radius
// plugin, which has since been removed; they live only here now.

/** A word of the command, already unquoted, and what the shell would still do with it. */
export type Word = {
  text: string
  /** Has `$`, a backtick or braces: only the shell knows what it becomes. */
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

type Heredoc = { word: string; isTabbed: boolean }

// Where the line after the bodies starts: each body runs to its closing delimiter, or to the end when it never comes.
const afterBodies = (command: string, from: number, pending: readonly Heredoc[]) => {
  let at = from

  for (const { word, isTabbed } of pending) {
    for (;;) {
      if (at >= command.length) {
        return command.length
      }

      const newline = command.indexOf('\n', at)
      const line = command.slice(at, newline === -1 ? command.length : newline)

      at = newline === -1 ? command.length : newline + 1

      if ((isTabbed ? line.replace(/^\t+/, '') : line) === word) {
        break
      }
    }
  }

  return at
}

type Command = { words: Word[]; /** The separator that came before: `;`, `&&`, `|`, `(`… */ before: string }

// The simple commands on the line, empty ones included, each with the separator before it.
export const parse = (command: string): Command[] => {
  const commands: Command[] = [{ words: [], before: '' }]
  let text = ''
  let isOpen = false
  let isUnknown = false
  let isHome = false
  let isQuoted = false
  // A bare operator (`>`) is waiting for its target word.
  let isTargetNext = false
  let quote: string | undefined
  // Heredocs opened on this line, whose bodies start after its newline.
  let pending: Heredoc[] = []
  // `case`: how many are open, whether its `in` is still to come, and the arm pattern being read (from `patternFrom` on).
  let cases = 0
  let isAwaitingIn = false
  let isPattern = false
  let patternFrom = 0

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
      isQuoted = true
    } else if (char === '\\') {
      text += following === '\n' ? '' : following
      isOpen ||= following !== '\n'
      isQuoted ||= following !== '\n'
      at += 1
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else if (char === '<' && following === '<') {
      endWord()

      if (command[at + 2] === '<') {
        // A here-string: the next word is data.
        isTargetNext = true
        at += 2
      } else {
        const isTabbed = command[at + 2] === '-'
        const start = at + (isTabbed ? 3 : 2)
        const { word, end } = delimiterAt(command, start + (/^[ \t]*/.exec(command.slice(start))?.[0].length ?? 0))

        pending.push({ word, isTabbed })
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
        at = afterBodies(command, at + 1, pending) - 1
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
