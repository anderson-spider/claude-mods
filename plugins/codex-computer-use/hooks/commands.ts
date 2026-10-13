import { COMMAND_TEXT, commandDescription, helpText } from './presentation'

// The `/codex-cu` commands in one table: each row parses its words, lists its
// help lines and its place in the registered description. Text lives in
// presentation.ts. A new subcommand is one row here, its `COMMAND_TEXT` entry
// and its handler in register.tsx (the `Handlers` type fails until it exists).
// Pure.

type Row = {
  /** The first word that selects this row, lowercase; '' is no word at all. */
  names: readonly string[]
  /** `words` are lowercase; `raw` is what the person typed, for arguments that keep their spelling. */
  parse(words: readonly string[], raw: string): { readonly kind: string }
  /** One line per usage, in the order HELP lists them. */
  help: readonly string[]
  /** The row's piece of the registered description, if it has one. */
  synopsis?: string
}

const helpCommand = () => ({ kind: 'help' }) as const

/** A command that takes no arguments: any extra word is a mistake. */
const bare =
  <K extends 'on' | 'off' | 'status'>(kind: K) =>
  (words: readonly string[]) =>
    words.length <= 1 ? ({ kind } as const) : helpCommand()

export const COMMANDS = [
  { names: ['on'], parse: bare('on'), help: [COMMAND_TEXT.on.help], synopsis: COMMAND_TEXT.on.synopsis },
  { names: ['off'], parse: bare('off'), help: [COMMAND_TEXT.off.help], synopsis: COMMAND_TEXT.off.synopsis },
  // No words at all is a status request.
  { names: ['status', ''], parse: bare('status'), help: [COMMAND_TEXT.status.help], synopsis: COMMAND_TEXT.status.synopsis },
  {
    names: ['auto-approve'],
    parse: (words: readonly string[]) =>
      words[1] === 'on' || words[1] === 'off' ? ({ kind: 'auto-approve', isOn: words[1] === 'on' } as const) : helpCommand(),
    help: [COMMAND_TEXT['auto-approve'].help],
    synopsis: COMMAND_TEXT['auto-approve'].synopsis,
  },
  {
    names: ['forget'],
    parse: (_words: readonly string[], raw: string) => {
      // The app keeps its spelling: "TextEdit", "/Applications/Foo Bar.app", "com.apple.grapher".
      const app = raw.trim().slice('forget'.length).trim()

      return app === '' ? ({ kind: 'forget' } as const) : ({ kind: 'forget-app', app } as const)
    },
    help: [COMMAND_TEXT.forget.help, COMMAND_TEXT['forget-app'].help],
    synopsis: COMMAND_TEXT.forget.synopsis,
  },
  { names: ['help'], parse: helpCommand, help: [] },
] satisfies readonly Row[]

/** What `/codex-cu` can ask for: the union of what the rows parse, plus help for anything else. */
export type Command = ReturnType<(typeof COMMANDS)[number]['parse']>

/** `/codex-cu` and its arguments, as the person typed them. */
export const parseCommand = (args: string): Command => {
  const words = args.trim().toLowerCase().split(/\s+/).filter(word => word !== '')
  const row = COMMANDS.find(candidate => (candidate.names as readonly string[]).includes(words[0] ?? ''))

  return row === undefined ? helpCommand() : row.parse(words, args)
}

const listed: readonly Row[] = COMMANDS

/** The help text, one line per usage. */
export const HELP = helpText(listed.flatMap(row => row.help))

/** What `$.command.register` shows for `/codex-cu`. */
export const COMMAND_DESCRIPTION = commandDescription(listed.flatMap(row => row.synopsis ?? []))
