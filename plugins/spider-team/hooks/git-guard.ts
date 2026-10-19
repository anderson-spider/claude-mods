// Which part of a shell command may change Git state or publish through `gh` or `glab`, so a spider-team agent's
// Bash call can be refused: only Main runs those. An allowlist, not a parser: Git and the two CLIs pass only in the
// read-only forms listed here, and a line that names them beside a construct this check cannot read (a substitution,
// `eval`, a heredoc, an interpreter's inline script) is refused whole. It guards against an agent forgetting the
// rule, not against one trying to get around it. Pure.

// Git subcommands that only read, whatever their arguments.
const GIT_READS = new Set([
  'blame', 'cat-file', 'check-attr', 'check-ignore', 'cherry', 'count-objects', 'describe', 'diff', 'diff-files',
  'diff-index', 'diff-tree', 'for-each-ref', 'grep', 'help', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge-base',
  'name-rev', 'range-diff', 'rev-list', 'rev-parse', 'shortlog', 'show', 'show-branch', 'show-ref', 'status', 'var',
  'version', 'whatchanged',
])
// `git branch` and `git tag` options that take a value, and those that make them list.
const LIST_VALUE_OPTIONS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort'])
const LISTING = new Set(['-l', '--list', '-v', '-vv', '--verbose', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'])
const LIST_ONLY = /^-(?:[arnv]\d*|vv|-all|-remotes|-verbose|-list|-show-current|-column|-no-column|-color|-no-color|-ignore-case|-omit-empty)$/

// Listing only: every flag lists, and a name only beside an option that makes it a filter.
function lists(args: string[]): boolean {
  const names: string[] = []
  for (let i = 0; i < args.length; i++) {
    const option = args[i]!.replace(/=.*/, '')
    if (LIST_VALUE_OPTIONS.has(args[i]!)) i++
    else if (LIST_VALUE_OPTIONS.has(option) || LISTING.has(option) || LIST_ONLY.test(option)) continue
    else if (args[i]!.startsWith('-')) return false
    else names.push(args[i]!)
  }
  return names.length === 0 || args.some(a => LISTING.has(a.replace(/=.*/, '')))
}

// Git subcommands that only read with these arguments.
const GIT_READS_WHEN: Record<string, (args: string[]) => boolean> = {
  branch: lists,
  tag: lists,
  stash: args => args[0] === 'list' || args[0] === 'show',
  worktree: args => args[0] === 'list',
  remote: args => args.length === 0 || args.every(a => a === '-v' || a === '--verbose') || args[0] === 'show' || args[0] === 'get-url',
  reflog: args => args.length === 0 || args[0] === 'show' || args[0]!.startsWith('-'),
  config: args => args[0] === 'get' || args[0] === 'list' || args.some(a => /^(?:--get(?:-all|-regexp)?|--list|-l)$/.test(a)) || (args.length === 1 && !args[0]!.startsWith('-')),
  // A refspec with a colon updates a local ref; a plain fetch only moves remote-tracking ones.
  fetch: args => !args.some(a => a.includes(':')),
  'symbolic-ref': args => args.filter(a => !a.startsWith('-')).length <= 1,
  submodule: args => args[0] === 'status' || args[0] === 'summary',
}
// Git's global options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
// `gh` and `glab` verbs that only read, under any noun, and global options that take a value.
const CLI_READS = new Set(['view', 'list', 'diff', 'checks', 'status', 'watch', 'trace'])
const CLI_VALUE_OPTIONS = new Set(['-R', '--repo'])
const CLIS = new Set(['git', 'gh', 'glab'])
// Constructs whose text this check cannot read as the shell would run it.
const UNREADABLE: [RegExp, string][] = [
  [/\$\(|`/, 'a command substitution'],
  [/(?:^|[\s;&|(])eval(?:\s|$)/, 'eval'],
  [/<<(?!<)/, 'a heredoc'],
  [/(?:^|[\s;&|(/])(?:ba|z|da|k)?sh\s+-\w*c/, 'a shell -c script'],
  [/(?:^|[\s;&|(/])(?:python3?|node|perl|ruby|php)\s+-\w*[ce]\b/, 'an inline script'],
]

const baseName = (word: string) => word.slice(word.lastIndexOf('/') + 1)

/** The words of each command on the line once quotes and backslashes are dropped, split at `;`, `&`, `|`, newlines, parentheses and backticks. */
export function segmentsOf(line: string): string[][] {
  return line
    .replace(/['"\\]/g, '')
    .split(/[;&|\n()`]/)
    .map(part => part.split(/\s+/).filter(Boolean))
    .filter(words => words.length > 0)
}

// The first word at or after `from` that is not a global option or its value.
function pastOptions(args: string[], from: number, values: Set<string>): number {
  let i = from
  while (i < args.length && args[i]!.startsWith('-')) i += values.has(args[i]!) ? 2 : 1
  return i
}

// `git <sub>` when this call is not a listed read, else undefined.
function gitCall(args: string[]): string | undefined {
  const at = pastOptions(args, 0, GIT_VALUE_OPTIONS)
  const sub = args[at]
  if (sub === undefined || GIT_READS.has(sub)) return undefined
  return GIT_READS_WHEN[sub]?.(args.slice(at + 1)) ? undefined : `git ${sub}`
}

// `gh <noun> <verb>` when this call is not a listed read, else undefined.
function cliCall(name: string, args: string[]): string | undefined {
  const at = pastOptions(args, 0, CLI_VALUE_OPTIONS)
  const [noun, verb] = [args[at], args[at + 1]]
  if (noun === undefined || noun === 'help' || noun === 'search' || (noun === 'auth' && verb === 'status')) return undefined
  return verb !== undefined && CLI_READS.has(verb) ? undefined : `${name} ${noun}${verb && !verb.startsWith('-') ? ` ${verb}` : ''}`
}

/** The call on the line spider-team refuses, as `git commit`, `gh pr create` or `git with a heredoc`; undefined when it only reads. */
export function refusedIn(line: string): string | undefined {
  const segments = segmentsOf(line)
  const named = segments.flat().map(baseName).find(word => CLIS.has(word))
  if (named === undefined) return undefined
  for (const [pattern, what] of UNREADABLE) if (pattern.test(line)) return `${named} with ${what}`
  for (const words of segments) {
    for (let i = 0; i < words.length; i++) {
      const word = baseName(words[i]!)
      if (!CLIS.has(word)) continue
      const write = word === 'git' ? gitCall(words.slice(i + 1)) : cliCall(word, words.slice(i + 1))
      if (write) return write
    }
  }
  return undefined
}

/** What a refused spider-team agent reads. */
export const refusal = (write: string) => `spider-team: only Main changes Git state or publishes, and this guard lets an agent run only Git's read-only forms, so \`${write}\` is refused. A read inside \`$(...)\` passes when run on its own first. Leave the change in the working tree and report it, with any read you needed that was refused; Main commits and publishes.`
