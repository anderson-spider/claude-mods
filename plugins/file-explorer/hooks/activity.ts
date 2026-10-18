// What Claude's tool calls did to files, read from each call's input and the result the host answered.
import type { FileExplorerActivity, FileExplorerActivityKind } from '../types'
import { resolve } from './paths'

export type ActivityKind = FileExplorerActivityKind
export type Activity = FileExplorerActivity

/** How long a touched row flashes, and how long it keeps its mark and stays in the footer. */
export const FLASH_MS = 1500
export const MARK_MS = 120_000
/** The most activities kept, and the most search hits one Grep or Glob marks. */
export const MAX_ACTIVITY = 200
export const MAX_SEARCH_MARKS = 50

/** A shell command's effects on the tree, as far as its words tell: git verbs run and paths made or removed. */
export type ShellEffects = { git: string[]; created: string[]; removed: string[] }

/** The words of one shell command line, quotes honoured; split into simple commands at `;`, `&&`, `||`, `|`, newlines. */
export function commandsOf(line: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | undefined
  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? ''
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i]
      else word += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      hasWord = true
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i]
      hasWord = true
    } else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      endCommand()
      if ((c === '&' || c === '|') && line[i + 1] === c) i++
    } else if (c === ' ' || c === '\t') endWord()
    else {
      word += c
      hasWord = true
    }
  }
  endCommand()
  return commands
}

const operands = (args: readonly string[]) => args.filter(arg => !arg.startsWith('-'))

/** What a Bash command line made, removed or ran in git, paths read against `cwd`. Unknown commands add nothing. */
export function shellEffects(line: string, cwd: string): ShellEffects {
  const effects: ShellEffects = { git: [], created: [], removed: [] }
  for (const words of commandsOf(line)) {
    // Skip leading `VAR=value` assignments and the wrappers that run the rest as a command.
    let start = 0
    while (start < words.length && (/^\w+=/.test(words[start] ?? '') || ['sudo', 'command', 'env', 'time'].includes(words[start] ?? ''))) start++
    const [name = '', ...args] = words.slice(start)
    const paths = operands(args).map(arg => resolve(cwd, arg))
    if (name === 'git') {
      // The verb is the first word after the global options (`git -C dir commit`).
      let i = 0
      while (i < args.length && (args[i] ?? '').startsWith('-')) i += ['-C', '-c'].includes(args[i] ?? '') ? 2 : 1
      const verb = args[i]
      if (verb) effects.git.push(verb)
    } else if (name === 'rm' || name === 'rmdir' || name === 'unlink') effects.removed.push(...paths)
    else if (name === 'touch' || name === 'mkdir') effects.created.push(...paths)
    else if ((name === 'mv' || name === 'cp') && paths.length >= 2) {
      if (name === 'mv') effects.removed.push(...paths.slice(0, -1))
      effects.created.push(...paths.slice(-1))
    }
  }
  return effects
}

type ToolInput = Record<string, unknown>
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)

/**
 * The files a finished, successful tool call touched. Read and the edit tools name their file; Write says whether it
 * created; Grep and Glob list the files they found (`filenames`), the first `MAX_SEARCH_MARKS`; Bash is read by
 * `shellEffects`. Any other tool touches nothing here.
 */
export function touchedBy(tool: string, input: ToolInput, result: unknown, cwd: string, at: number): Activity[] {
  const output = (result ?? {}) as Record<string, unknown>
  const one = (path: string | undefined, kind: ActivityKind) => (path ? [{ path: resolve(cwd, path), kind, at }] : [])
  switch (tool) {
    case 'Read':
      return one(text(input.file_path), 'read')
    case 'Write':
      return one(text(input.file_path), output.type === 'create' ? 'created' : 'modified')
    case 'Edit':
    case 'MultiEdit':
      return one(text(input.file_path), 'modified')
    case 'NotebookEdit':
      return one(text(input.notebook_path), 'modified')
    case 'Grep':
    case 'Glob': {
      const found = Array.isArray(output.filenames) ? output.filenames.filter((name): name is string => typeof name === 'string') : []
      return found.slice(0, MAX_SEARCH_MARKS).map(path => ({ path: resolve(cwd, path), kind: 'searched' as const, at }))
    }
    case 'Bash': {
      const effects = shellEffects(text(input.command) ?? '', cwd)
      return [
        ...effects.created.map(path => ({ path, kind: 'created' as const, at })),
        ...effects.removed.map(path => ({ path, kind: 'removed' as const, at })),
      ]
    }
    default:
      return []
  }
}

/** The file a Write, Edit, MultiEdit or NotebookEdit call is about to write, before it runs; undefined for any other call. */
export function writing(tool: string, input: ToolInput, cwd: string): string | undefined {
  const path = tool === 'NotebookEdit' ? text(input.notebook_path) : ['Write', 'Edit', 'MultiEdit'].includes(tool) ? text(input.file_path) : undefined
  return path ? resolve(cwd, path) : undefined
}

/** The newest activity per path first, the list held to `MAX_ACTIVITY`. */
export function recorded(list: readonly Activity[], added: readonly Activity[]): Activity[] {
  const fresh = new Set(added.map(one => one.path))
  return [...[...added].reverse(), ...list.filter(one => !fresh.has(one.path))].slice(0, MAX_ACTIVITY)
}

/** The mark each recently touched path shows now, and whether it still flashes. */
export function marksAt(list: readonly Activity[], now: number): Map<string, { kind: ActivityKind; isFlashing: boolean }> {
  const marks = new Map<string, { kind: ActivityKind; isFlashing: boolean }>()
  for (const one of list) {
    if (now - one.at > MARK_MS || marks.has(one.path)) continue
    marks.set(one.path, { kind: one.kind, isFlashing: now - one.at < FLASH_MS })
  }
  return marks
}

/** When the next flash ends, so one timer redraws then; undefined when nothing flashes. */
export function nextFlashEnd(list: readonly Activity[], now: number): number | undefined {
  let soonest: number | undefined
  for (const one of list) {
    const end = one.at + FLASH_MS
    if (end > now && (soonest === undefined || end < soonest)) soonest = end
  }
  return soonest
}
