// The argv that opens a file outside the session. Commands run by argv with no shell, so a file name is one argument
// to the program named, and a template whose program would read its arguments as code is refused.
import { commandsOf } from './activity'
import { base, parent } from './paths'

export type Platform = 'darwin' | 'linux' | 'win32'

// Programs that run their arguments as a command line (a shell, a multiplexer, a remote login, a re-exec): a file
// name handed to them would be parsed as code.
const LAUNCHERS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'nu', 'cmd', 'powershell', 'pwsh',
  'tmux', 'screen', 'ssh', 'osascript', 'env', 'xargs', 'nohup', 'sudo', 'doas', 'su', 'eval', 'exec',
])
// Files the system's default app would run rather than show.
const RUNNABLE = /\.(app|command|terminal|tool|jar|exe|bat|cmd|com|msi|ps1|vbs|scr|desktop|appimage|pkg|workflow|scpt)$/i

const programOf = (word: string) => base(word.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '')

/**
 * The argv for `editor` (a command template: `code -g {path}:{line}`, placeholders `{path}`, `{dir}` and `{line}`,
 * quotes grouping words), the path appended when the template names no placeholder; with no template, the platform's
 * opener for the default app. Undefined when the template is not one simple command, names a launcher, or the default
 * app would run the file.
 */
export function openArgv(editor: string, path: string, line: number, platform: Platform): string[] | undefined {
  if (editor === '') {
    if (RUNNABLE.test(path)) return undefined
    if (platform === 'darwin') return ['open', path]
    if (platform === 'win32') return ['explorer', path.replace(/\//g, '\\')]
    return ['xdg-open', path]
  }
  const commands = commandsOf(editor)
  const words = commands[0]
  if (commands.length !== 1 || !words || words.length === 0 || LAUNCHERS.has(programOf(words[0] ?? ''))) return undefined
  const dir = parent(path)
  const hasPlaceholder = words.some(word => /\{(path|dir|line)\}/.test(word))
  const filled = words.map(word => word.replace(/\{path\}/g, path).replace(/\{dir\}/g, dir).replace(/\{line\}/g, String(line)))
  return hasPlaceholder ? filled : [...filled, path]
}

/** The platform a `uname -s` answer names, or Windows when the root is a drive path. */
export function platformOf(root: string, uname: string | undefined): Platform {
  if (/^[A-Za-z]:/.test(root)) return 'win32'
  return uname?.trim() === 'Darwin' ? 'darwin' : 'linux'
}
