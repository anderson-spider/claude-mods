// The Bash guard of the Spider roles: a command passes only when it is one read-only git command. Pure: the shell words
// are read here, without running anything, and anything the reader cannot be sure of is refused.
import type { Role } from './roles'

/** The git subcommands a Spider role may run. */
export const GIT_READS = ['status', 'log', 'diff', 'show', 'merge-base', 'ls-files', 'blame', 'rev-parse'] as const
// Options that write a file or run a program the call names. Git accepts a unique prefix of a long option, so a prefix of
// three characters or more counts as the option.
const WRITERS = ['--output', '--ext-diff']
const writes = (word: string) => {
  const name = word.split('=')[0]!
  return WRITERS.some(w => name.startsWith(w) || (name.length >= 3 && w.startsWith(name)))
}
// Outside quotes these would chain, redirect, substitute or expand into words the check never saw (a glob can match a
// file named `--output=x`, a brace list can spell one).
const UNQUOTED = /[;&|<>()`$\n\r{}*?[\]#]/

/** The command's shell words, or null when it holds anything beyond plain words and quotes. */
export function shellWords(command: string): string[] | null {
  const out: string[] = []
  let word = '', open = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end < 0) return null
      word += command.slice(i + 1, end); open = true; i = end
    } else if (c === '"') {
      let j = i + 1
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j]!
        if (d === '$' || d === '`') return null
        if (d === '\\' && '"\\$`'.includes(command[j + 1] ?? '')) { word += command[++j]; continue }
        if (d === '\\' && (command[j + 1] === '\n' || j + 1 >= command.length)) return null
        word += d
      }
      if (j >= command.length) return null
      open = true; i = j
    } else if (c === '\\') {
      const next = command[i + 1]
      if (next === undefined || next === '\n') return null
      word += next; open = true; i++
    } else if (c === ' ' || c === '\t') {
      if (open) out.push(word)
      word = ''; open = false
    } else if (UNQUOTED.test(c)) return null
    else { word += c; open = true }
  }
  if (open) out.push(word)
  return out
}

/** True for one read-only git command: `git`, optionally `-C <dir>` or `--no-pager`, a `GIT_READS` subcommand and its arguments. */
export function readOnlyGit(command: string): boolean {
  const words = shellWords(command)
  if (!words || words[0] !== 'git') return false
  let i = 1
  for (; words[i]?.startsWith('-'); i++) {
    if (words[i] === '-C' && words[i + 1] !== undefined) i++
    else if (words[i] !== '--no-pager') return false
  }
  if (!(GIT_READS as readonly string[]).includes(words[i] ?? '')) return false
  return !words.slice(i + 1).some(writes)
}

export const refusal = (role: Role) => `spider-team: the ${role} runs only read-only git commands (git ${GIT_READS.join(', ')}), one command at a time, with no pipes, redirection, substitution or unquoted wildcards or braces: quote patterns and revisions such as 'HEAD@{1}'. --output and --ext-diff are refused.`
export const UNCHECKED = 'spider-team: could not tell which agent runs this command, so it was refused. Try again.'

/** Which Spider role each agent id runs as, null for any other agent; the oldest dropped past the limit. */
export function createRoleCache(limit = 200) {
  const map = new Map<string, Role | null>()
  return {
    set(agentId: string, role: Role | null) {
      map.delete(agentId); map.set(agentId, role)
      while (map.size > limit) map.delete(map.keys().next().value as string)
    },
    get: (agentId: string) => map.get(agentId),
    has: (agentId: string) => map.has(agentId),
    get size() { return map.size },
  }
}
