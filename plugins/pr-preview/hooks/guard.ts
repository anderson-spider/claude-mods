import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { PrPreviewReport } from '../types'

// The parser, `resolve`, `locate` and `enter` are trimmed copies of those in
// plugins/branch-guard/hooks/guard.ts: a plugin does not import code from another. A fix
// there must be carried over here.

/** A word of the command, already unquoted, and what the shell would still do with it. */
export type Word = {
  text: string
  /** Has `$`, a backtick or braces: only the shell knows what it becomes. */
  isUnknown: boolean
  /** Has `~` outside quotes. */
  isHome: boolean
}

export type Platform = 'github' | 'gitlab'

/** `create` opens a pull or merge request; `edit` is `gh pr edit` or `glab mr update`, which only changes what it is given. */
export type Action = 'create' | 'edit'

/** A `gh pr create`, `gh pr edit`, `glab mr create` or `glab mr update` on the command line, with the options the checks need. */
export type Draft = {
  platform: Platform
  action: Action
  /** The command as typed: `gh pr create`, `glab-work mr update`. */
  name: string
  dir: string
  /** An unreadable `cd` came before: `dir` is not reliable. */
  isAdrift: boolean
  title?: Word
  description?: Word
  bodyFile?: Word
  assignees: Word[]
  labels: Word[]
  base?: string
  head?: string
  isDraft: boolean
  /** `--fill` and friends: the title and description come from the commits. */
  isFill: boolean
}

export type Problem = {
  /** What is wrong, in one sentence. */
  message: string
  /** What to change, in one sentence. */
  fix: string
}

/** What the check needs from the host; the hooks module owns `$` and hands it over this way. */
export type Probe = {
  run: (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>
  home: () => Promise<string | undefined>
}

type Language = 'pt' | 'en'

/** The conventions each platform asks for. */
export const RULES: Record<Platform, { assignee: boolean; label: boolean; description: Language }> = {
  gitlab: { assignee: true, label: true, description: 'pt' },
  github: { assignee: false, label: false, description: 'en' },
}

const GIT_MS = 15_000
const BODY_MS = 5_000
const SHOWN_DESCRIPTION = 12
const BREAKS = new Set([';', '\n', '(', ')'])
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env'])
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s
const IN_HOME = /^~(\/|$)/
const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)\s]+\))?!?: \S/
// Case-sensitive on purpose: `AI` and `IA` are acronyms, `ai` and `ia` are other words.
const AI_ACRONYM = /\b(AI|IA)\b/
const AI_MENTION = /\b(claude|anthropic|chatgpt|openai|copilot|gemini|codex)\b|co-authored-by|generated (with|by)|🤖/i
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(\n|\)|$)/

const GLAB_VALUED: Record<string, string> = {
  '-t': 'title',
  '--title': 'title',
  '-d': 'description',
  '--description': 'description',
  '-a': 'assignee',
  '--assignee': 'assignee',
  '-l': 'label',
  '--label': 'label',
  '-b': 'base',
  '--target-branch': 'base',
  '-s': 'head',
  '--source-branch': 'head',
  '-m': 'ignored',
  '--milestone': 'ignored',
  '-r': 'ignored',
  '--reviewer': 'ignored',
}
const GH_VALUED: Record<string, string> = {
  '-t': 'title',
  '--title': 'title',
  '-b': 'description',
  '--body': 'description',
  '-F': 'bodyFile',
  '--body-file': 'bodyFile',
  '-a': 'assignee',
  '--assignee': 'assignee',
  '-l': 'label',
  '--label': 'label',
  '-B': 'base',
  '--base': 'base',
  '-H': 'head',
  '--head': 'head',
  '-m': 'ignored',
  '--milestone': 'ignored',
  '-p': 'ignored',
  '--project': 'ignored',
  '-r': 'ignored',
  '--reviewer': 'ignored',
  '--template': 'ignored',
}
const FILLS = new Set(['-f', '--fill', '--fill-first', '--fill-verbose'])
const PT_WORDS = new Set([
  'não', 'nao', 'para', 'que', 'uma', 'dos', 'das', 'por', 'são', 'está', 'mais', 'já', 'também', 'pelo', 'pela',
  'entre', 'sobre', 'sem', 'ou', 'foi', 'seu', 'sua', 'ao', 'de', 'da', 'em', 'um', 'nos', 'se', 'como', 'ser',
  'isso', 'este', 'esta', 'essa', 'nova', 'novo', 'adiciona', 'remove', 'corrige', 'altera', 'atualiza',
])
const EN_WORDS = new Set([
  'the', 'and', 'of', 'to', 'in', 'is', 'for', 'with', 'this', 'that', 'from', 'are', 'not', 'it', 'on', 'be', 'by',
  'an', 'as', 'or', 'when', 'which', 'add', 'adds', 'fix', 'fixes', 'update', 'updates', 'remove', 'removes', 'use',
  'uses', 'now', 'new', 'also', 'all', 'was', 'has', 'have', 'will',
])

type Command = { words: Word[]; /** The separator that came before: `;`, `&&`, `|`, `(`… */ before: string }

// The simple commands on the line, empty ones included, each with the separator before it.
const parse = (command: string): Command[] => {
  const commands: Command[] = [{ words: [], before: '' }]
  let text = ''
  let isOpen = false
  let isUnknown = false
  let isHome = false
  let quote: string | undefined

  const endWord = () => {
    if (isOpen) {
      commands.at(-1)?.words.push({ text, isUnknown, isHome })
    }

    text = ''
    isOpen = false
    isUnknown = false
    isHome = false
  }
  const endCommand = (before: string) => {
    endWord()
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
    } else if (char === '\\') {
      text += following === '\n' ? '' : following
      isOpen ||= following !== '\n'
      at += 1
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else if (BREAKS.has(char)) {
      endCommand(char)
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
const enter = (dir: string, to: string) => resolve(IN_HOME.test(to) ? '.' : dir, to)

/** Where `dir` really is: from the home when it starts with `~`, otherwise from `cwd`. */
export const locate = (cwd: string, dir: string, home: string | undefined): string | undefined => {
  if (!IN_HOME.test(dir)) {
    return resolve(cwd, dir)
  }

  return home === undefined ? undefined : resolve(home, `.${dir.slice(1)}`)
}

const bare = (words: readonly Word[]) => {
  let start = 0

  for (; start < words.length; start += 1) {
    const text = words[start]?.text ?? ''

    if (!ASSIGNMENT.test(text) && !WRAPPERS.has(text)) {
      break
    }
  }

  return words.slice(start)
}

/** Reads the options of a create command: what each valued flag carries, and the loose flags. */
const options = (platform: Platform, args: readonly Word[]) => {
  const valued = platform === 'github' ? GH_VALUED : GLAB_VALUED
  const values = new Map<string, Word[]>()
  const flags = new Set<string>()
  const add = (name: string, word: Word) => values.set(name, [...(values.get(name) ?? []), word])

  for (let at = 0; at < args.length; at += 1) {
    const word = args[at]
    const text = word?.text ?? ''

    if (word === undefined || text === '--') {
      break
    }

    const [flag = '', ...rest] = text.split('=')
    const joined = rest.join('=')

    if (text.startsWith('--')) {
      const name = valued[flag]

      if (name === undefined) {
        flags.add(flag)
      } else if (text.includes('=')) {
        add(name, { ...word, text: joined })
      } else if (args[at + 1] !== undefined) {
        add(name, args[at + 1] as Word)
        at += 1
      }
    } else if (text.startsWith('-') && text.length > 1) {
      const head = text.slice(0, 2)
      const name = valued[head]

      if (name !== undefined) {
        if (text.length > 2) {
          add(name, { ...word, text: text.slice(2).replace(/^=/, '') })
        } else if (args[at + 1] !== undefined) {
          add(name, args[at + 1] as Word)
          at += 1
        }
      } else {
        for (const letter of text.slice(1)) {
          flags.add(`-${letter}`)
        }
      }
    }
  }

  return { values, flags }
}

const draft = (
  platform: Platform,
  action: Action,
  name: string,
  dir: string,
  isAdrift: boolean,
  args: readonly Word[],
): Draft => {
  const { values, flags } = options(platform, args)
  // The last occurrence of a single-valued option wins, as it does in the CLIs.
  const first = (key: string) => values.get(key)?.at(-1)
  // `-d` is `--draft` on GitHub and `--description` on GitLab, which `options` already took as valued.
  const isDraft = flags.has('--draft') || (platform === 'github' && flags.has('-d'))
  const split = (key: string) =>
    (values.get(key) ?? []).flatMap(word =>
      word.text === '' ? [] : word.text.split(',').map(part => ({ ...word, text: part.trim() })),
    )

  return {
    platform,
    action,
    name,
    dir,
    isAdrift,
    ...(first('title') === undefined ? {} : { title: first('title') as Word }),
    ...(first('description') === undefined ? {} : { description: first('description') as Word }),
    ...(first('bodyFile') === undefined ? {} : { bodyFile: first('bodyFile') as Word }),
    assignees: split('assignee'),
    labels: split('label'),
    ...(first('base') === undefined ? {} : { base: first('base')?.text as string }),
    ...(first('head') === undefined ? {} : { head: first('head')?.text as string }),
    isDraft,
    isFill: [...flags].some(flag => FILLS.has(flag)),
  }
}

/** The `gh pr create`, `gh pr edit`, `glab mr create` and `glab mr update` the command line carries, in order; empty for everything else. */
export const classify = (command: string): Draft[] => {
  const drafts: Draft[] = []
  let dir = '.'
  let isAdrift = false

  for (const one of parse(command)) {
    const argv = bare(one.words)
    const name = (argv[0]?.text ?? '').split('/').at(-1) ?? ''
    const args = argv.slice(1)

    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      const to = args[0]?.text ?? ''
      // A quoted `~` is a folder name, and `~someone` is another person's home.
      const isHomePath = args[0]?.isHome === true && IN_HOME.test(to)
      const isKnown =
        name === 'cd' && args.length === 1 && args[0]?.isUnknown === false && to !== '-' && (isHomePath || !to.startsWith('~'))

      isAdrift = isKnown ? isAdrift && !to.startsWith('/') && !isHomePath : true
      dir = isKnown ? enter(dir, to) : dir
    } else if (name === 'gh' && args[0]?.text === 'pr' && (args[1]?.text === 'create' || args[1]?.text === 'edit')) {
      const action = args[1]?.text === 'edit' ? 'edit' : 'create'

      drafts.push(draft('github', action, `gh pr ${action}`, dir, isAdrift, args.slice(2)))
    } else if (/^glab(-[a-z]+)*$/.test(name) && args[0]?.text === 'mr') {
      const sub = args[1]?.text
      const action = sub === 'update' ? 'edit' : sub === 'create' || sub === 'new' ? 'create' : undefined

      if (action !== undefined) {
        drafts.push(draft('gitlab', action, `${name} mr ${action === 'edit' ? 'update' : 'create'}`, dir, isAdrift, args.slice(2)))
      }
    }
  }

  return drafts
}

/** The text a word stands for; a `"$(cat <<'EOF' … EOF)"` stands for its heredoc, anything else only the shell knows is `undefined`. */
export const textOf = (word: Word | undefined): string | undefined => {
  if (word === undefined) {
    return undefined
  }

  if (!word.isUnknown) {
    return word.text
  }

  return HEREDOC.exec(word.text)?.[3]
}

/** Which language a text is written in, by the words it uses; `undefined` when it says too little to tell. */
export const language = (text: string, min = 3): Language | undefined => {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .toLowerCase()
  const tokens = plain.match(/[a-zà-ú]+/g) ?? []

  if (tokens.length < min) {
    return undefined
  }

  const pt = tokens.filter(token => PT_WORDS.has(token) || /[áâãàéêíóôõúç]/.test(token)).length
  const en = tokens.filter(token => EN_WORDS.has(token)).length

  return pt > en ? 'pt' : en > pt ? 'en' : undefined
}

/** What breaks the conventions, from what the text of the command says; `description` is the one read from a file when there is one. */
export const check = (one: Draft, description: string | undefined): Problem[] => {
  const rules = RULES[one.platform]
  const problems: Problem[] = []
  const title = textOf(one.title)
  const lang = description === undefined ? undefined : language(description)
  const spoken = rules.description === 'pt' ? 'Brazilian Portuguese' : 'English'
  // An edit changes only what it is given: a missing title, description, assignee or label is not a fault.
  const isCreate = one.action === 'create'

  if (one.title === undefined && !one.isFill && isCreate) {
    problems.push({ message: 'There is no title.', fix: 'Pass `--title` in Conventional Commits, in English.' })
  } else if (title !== undefined && title !== '') {
    if (!CONVENTIONAL.test(title)) {
      problems.push({
        message: `The title is not Conventional Commits: "${title}".`,
        fix: 'Use `type(scope): subject`, with type one of feat, fix, docs, style, refactor, perf, test, build, ci, chore or revert.',
      })
    }

    if (language(title, 2) === 'pt') {
      problems.push({ message: 'The title is not in English.', fix: 'Write the title in English.' })
    }
  }

  if (one.description === undefined && one.bodyFile === undefined && !one.isFill && isCreate) {
    problems.push({
      message: 'There is no description.',
      fix: `Pass ${one.platform === 'github' ? '`--body`' : '`--description`'}, in ${spoken}.`,
    })
  } else if (lang !== undefined && lang !== rules.description) {
    problems.push({
      message: `The description looks like ${lang === 'pt' ? 'Brazilian Portuguese' : 'English'}, and ${one.platform === 'github' ? 'GitHub' : 'GitLab'} asks for ${spoken}.`,
      fix: `Write the description in ${spoken}.`,
    })
  }

  if (isCreate && rules.assignee && !one.assignees.some(word => word.isUnknown || word.text === '@me')) {
    problems.push({ message: 'You are not the assignee.', fix: 'Add `--assignee @me`.' })
  }

  if (isCreate && rules.label && one.labels.length === 0) {
    problems.push({
      message: 'There is no label.',
      fix: 'Add `--label <label>`: an existing one that fits the change, or create it in the project.',
    })
  }

  const spoiled = [title ?? '', description ?? ''].some(text => AI_MENTION.test(text) || AI_ACRONYM.test(text))

  if (spoiled) {
    problems.push({
      message: 'The text mentions AI.',
      fix: 'Remove any mention of AI, `Co-Authored-By` and "Generated with" lines.',
    })
  }

  return problems
}

const count = (many: number, one: string, plural = `${one}s`) => `${many} ${many === 1 ? one : plural}`

// A command that fails to run (git missing, timeout, no such file) becomes `undefined`, never a hook error.
const out = async (probe: Probe, argv: readonly string[], cwd: string, timeoutMs: number) => {
  try {
    const ran = await probe.run(argv, { cwd, timeoutMs })

    return ran.exitCode === 0 ? ran.stdout.trimEnd() : undefined
  } catch {
    return undefined
  }
}

/** What the command would open or change, with the preview and what breaks the conventions, measured with git itself. */
export const measure = async (
  probe: Probe,
  drafts: readonly Draft[],
  cwd: string,
): Promise<{ report: PrPreviewReport; advice: string }> => {
  const [one] = drafts

  if (one === undefined) {
    return { report: { title: 'pull request', summary: 'open a pull request', lines: [], total: 0, problems: [], notes: [] }, advice: '' }
  }

  const notes: string[] = []
  const where = one.isAdrift ? undefined : locate(cwd, one.dir, await probe.home())
  const file = one.bodyFile
  let description = textOf(one.description)

  if (file !== undefined && where !== undefined && !file.isUnknown) {
    description = file.text === '-' ? undefined : await out(probe, ['cat', resolve(where, file.text)], where, BODY_MS)
  }

  const isCreate = one.action === 'create'
  const current =
    where === undefined || !isCreate ? undefined : await out(probe, ['git', 'branch', '--show-current'], where, GIT_MS)
  const head = one.head ?? (current === undefined || current === '' ? undefined : current)
  const title = textOf(one.title)
  const hasDescription = one.description !== undefined || one.bodyFile !== undefined
  const lines = [
    ...(isCreate || one.title !== undefined
      ? [`Title     ${title ?? (one.isFill ? 'taken from the commits' : 'not readable (only the shell knows what it is)')}`]
      : []),
    ...(isCreate ? [`Branches  ${head ?? 'current'} → ${one.base ?? 'default branch'}`] : one.base === undefined ? [] : [`Base      ${one.base}`]),
    ...(one.assignees.length > 0 ? [`Assignee  ${one.assignees.map(word => word.text).join(', ')}`] : []),
    ...(one.labels.length > 0 ? [`Labels    ${one.labels.map(word => word.text).join(', ')}`] : []),
  ]
  const body = (description ?? '').split('\n')

  if (description === undefined) {
    if (isCreate || hasDescription) {
      lines.push(one.isFill ? 'Description taken from the commits' : 'Description not readable (only the shell knows what it is)')
    }
  } else if (description.trim() !== '') {
    lines.push('', ...body.slice(0, SHOWN_DESCRIPTION))

    if (body.length > SHOWN_DESCRIPTION) {
      lines.push(`… ${count(body.length - SHOWN_DESCRIPTION, 'more line')} of the description`)
    }
  }

  if (!isCreate && lines.length === 0) {
    lines.push('No title or description change')
  }

  if (drafts.length > 1) {
    notes.push(`${count(drafts.length - 1, 'other command')} on this line ${drafts.length === 2 ? 'is' : 'are'} not previewed.`)
  }

  const problems = check(one, description)

  return {
    report: {
      title: one.name,
      summary: `${isCreate ? 'open' : one.platform === 'github' ? 'edit' : 'update'} a ${one.platform === 'github' ? 'pull request on GitHub' : 'merge request on GitLab'}${isCreate && one.isDraft ? ' as a draft' : ''}`,
      lines,
      total: lines.length,
      problems: problems.map(problem => problem.message),
      notes,
    },
    advice: problems.map(problem => `${problem.message} ${problem.fix}`).join(' '),
  }
}
