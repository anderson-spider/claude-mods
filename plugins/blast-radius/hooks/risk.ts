import type { FsEntry, ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { BlastRadiusReport } from '../types'

/** A word of the command, already unquoted, and what the shell would still do with it. */
export type Word = {
  text: string
  /** Has `$`, a backtick or braces: only the shell knows what it becomes. */
  isUnknown: boolean
  /** Has `*`, `?` or `[` outside quotes. */
  isGlob: boolean
  /** Starts with `~` outside quotes. */
  isHome: boolean
}

export type Risk = { /** An unreadable `cd` came before: `dir` is not reliable. */ isAdrift?: boolean } & (
  | { kind: 'rm'; dir: string; targets: Word[] }
  // `isElsewhere`: a --git-dir or --work-tree points git outside `dir`.
  | { kind: 'reset'; dir: string; ref: string | undefined; isElsewhere: boolean }
  | { kind: 'clean'; dir: string; args: string[]; isElsewhere: boolean }
  | { kind: 'push'; dir: string; remote: string | undefined; refspecs: string[] }
  | {
      kind: 'migrate'
      dir: string
      tool: string
      env: Record<string, string>
      status: string[]
      pending: RegExp | undefined
    }
)

/** What the measurement needs from the host; the hooks module owns `$` and hands it over this way. */
export type Probe = {
  run: (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>
  list: (path: string) => Promise<FsEntry[]>
  home: () => Promise<string | undefined>
  /** The path with every symlink resolved; `undefined` when it does not exist. */
  real: (path: string) => Promise<string | undefined>
}

type Part = { summary: string; lines: string[]; note?: string }

const KEPT_LINES = 40
const DRY_RUN_MS = 15_000
const MIGRATION_STATUS_MS = 30_000
const BREAKS = new Set([';', '\n', '(', ')'])
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env'])
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s
const GLOB = /[*?[]/
const IN_HOME = /^~(\/|$)/
const SEQUENCE = new Set(['', ';', '\n', '&&'])
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', '{', '}'])
// Commands that change variables in a way the text does not show.
const FORGETS = new Set(['unset', 'read', 'export', 'declare', 'local', 'typeset', 'eval', 'source', '.'])

// `anchor` finds the tool, `after` the verb that follows it; `status` is its dry run.
const MIGRATIONS = [
  {
    tool: 'Django',
    anchor: /(^|\/)manage\.py$/,
    after: /^migrate( |$)/,
    keepsAnchor: true,
    status: ['showmigrations', '--plan'],
    pending: /^\s*\[ \]\s*(.+)$/,
  },
  {
    tool: 'Rails',
    anchor: /^db:migrate$/,
    after: /^/,
    keepsAnchor: false,
    status: ['db:migrate:status'],
    pending: /^\s*down\s+(.+)$/,
  },
  {
    tool: 'Prisma',
    anchor: /(^|\/)prisma$/,
    after: /^migrate (deploy|dev|reset)$/,
    keepsAnchor: true,
    status: ['migrate', 'status'],
    pending: undefined,
  },
  {
    tool: 'Laravel',
    anchor: /(^|\/)artisan$/,
    after: /^migrate( |$)/,
    keepsAnchor: true,
    status: ['migrate:status'],
    pending: /^\s*(\S+)\s.*\bPending\s*$/,
  },
]

type Command = { words: Word[]; /** The separator that came before: `;`, `&&`, `|`, `(`… */ before: string }

// The simple commands on the line, empty ones included, each with the separator before it.
const parse = (command: string): Command[] => {
  const commands: Command[] = [{ words: [], before: '' }]
  let text = ''
  let isOpen = false
  let isUnknown = false
  let isGlob = false
  let isHome = false
  let quote: string | undefined

  const endWord = () => {
    if (isOpen) {
      commands.at(-1)?.words.push({ text, isUnknown, isGlob, isHome })
    }

    text = ''
    isOpen = false
    isUnknown = false
    isGlob = false
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
      isGlob ||= GLOB.test(char)
      text += char
      isOpen = true
    }
  }

  endWord()

  return commands
}

/** The words of each simple command on the line; `$(…)` and scripts pass without being read. */
export const split = (command: string): Word[][] =>
  parse(command)
    .map(one => one.words)
    .filter(words => words.length > 0)

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
  const env: Record<string, string> = {}
  let start = 0

  for (; start < words.length; start += 1) {
    const text = words[start]?.text ?? ''
    const assigned = ASSIGNMENT.exec(text)

    if (assigned !== null) {
      env[assigned[1] ?? ''] = assigned[2] ?? ''
    } else if (!WRAPPERS.has(text)) {
      break
    }
  }

  return { env, argv: words.slice(start) }
}

const rm = (dir: string, args: readonly Word[]): Risk | undefined => {
  const end = args.findIndex(word => word.text === '--')
  const isFlag = (word: Word, at: number) =>
    (end < 0 || at < end) && word.text.startsWith('-') && word.text.length > 1
  const isRecursive = args.some(
    (word, at) =>
      isFlag(word, at) &&
      (word.text === '--recursive' || (!word.text.startsWith('--') && /[rR]/.test(word.text))),
  )

  return isRecursive
    ? { kind: 'rm', dir, targets: args.filter((word, at) => at !== end && !isFlag(word, at)) }
    : undefined
}

const git = (dir: string, words: readonly string[]): Risk | undefined => {
  let at = 0
  let where = dir
  let isElsewhere = false

  while ((words[at] ?? '').startsWith('-')) {
    const takesValue = words[at] === '-C' || words[at] === '-c'
    isElsewhere ||= /^--(git-dir|work-tree)\b/.test(words[at] ?? '')
    where = words[at] === '-C' ? enter(where, words[at + 1] ?? '.') : where
    at += takesValue ? 2 : 1
  }

  const args = words.slice(at + 1)
  const flags = args.filter(arg => arg.startsWith('-'))
  const rest = args.filter(arg => !arg.startsWith('-'))
  const short = (letter: string) => flags.some(flag => !flag.startsWith('--') && flag.includes(letter))
  const long = (...names: string[]) =>
    flags.some(flag => names.some(name => flag === name || flag.startsWith(`${name}=`)))
  const isDryRun = short('n') || long('--dry-run')

  if (words[at] === 'reset' && long('--hard')) {
    return { kind: 'reset', dir: where, ref: rest[0], isElsewhere }
  }

  if (words[at] === 'clean' && (short('f') || long('--force')) && !isDryRun) {
    const kept = args.flatMap(arg => {
      if (arg === '--force' || arg === '--interactive') {
        return []
      }

      const cluster = arg.startsWith('-') && !arg.startsWith('--') ? arg.replace(/[fi]/g, '') : arg

      return cluster === '-' ? [] : [cluster]
    })

    return { kind: 'clean', dir: where, args: ['clean', '-n', ...kept], isElsewhere }
  }

  const isForced =
    short('f') ||
    long('--force', '--force-with-lease', '--force-if-includes') ||
    rest.some(arg => arg.startsWith('+'))

  if (words[at] === 'push' && isForced && !isDryRun) {
    return { kind: 'push', dir: where, remote: rest[0], refspecs: rest.slice(1) }
  }

  return undefined
}

const migrate = (dir: string, env: Record<string, string>, words: readonly string[]): Risk | undefined => {
  for (const spec of MIGRATIONS) {
    const at = words.findIndex(
      (word, index) => spec.anchor.test(word) && spec.after.test(words.slice(index + 1, index + 3).join(' ')),
    )

    if (at >= 0) {
      const launcher = words.slice(0, spec.keepsAnchor ? at + 1 : at)

      return {
        kind: 'migrate',
        dir,
        tool: spec.tool,
        env,
        status: [...launcher, ...spec.status],
        pending: spec.pending,
      }
    }
  }

  return undefined
}

// Replaces `$NAME` and `${NAME}` with the value the line itself assigned; if something is left that
// only the shell knows, the word stays as it was.
const fill = (word: Word, values: ReadonlyMap<string, string>): Word => {
  if (!word.isUnknown) {
    return word
  }

  const text = word.text.replace(
    /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g,
    (whole, braced?: string, plain?: string) => values.get(braced ?? plain ?? '') ?? whole,
  )

  return /[$`{]/.test(text) ? word : { ...word, text, isUnknown: false }
}

/** The risks the command line carries, in order; empty for everything else. */
export const classify = (command: string): Risk[] => {
  const risks: Risk[] = []
  const parsed = parse(command)
  // With `if`, `for` and the like, the text alone cannot tell which assignments run.
  const isStraight = !parsed.some(one => KEYWORDS.has(one.words[0]?.text ?? ''))
  const values = new Map<string, string>()
  let dir = '.'
  let isAdrift = false

  for (const [at, one] of parsed.entries()) {
    // An assignment made in a subshell does not leave it.
    if (one.before === '(' || one.before === ')') {
      values.clear()
    }

    const { env, argv } = bare(one.words.map(word => fill(word, values)))
    const name = (argv[0]?.text ?? '').split('/').at(-1)
    const args = argv.slice(1)

    if (argv.length === 0) {
      // Assignments only: they hold from here on when the command always runs and in the shell itself.
      const isCertain = isStraight && SEQUENCE.has(one.before) && SEQUENCE.has(parsed[at + 1]?.before ?? '')

      for (const word of one.words) {
        const [, variable = '', value = ''] = ASSIGNMENT.exec(word.text) ?? []
        const isLiteral = !word.isUnknown && !word.isGlob && /^[^~\s][^\s]*$/.test(value)

        if (isCertain && isLiteral) {
          values.set(variable, value)
        } else {
          values.delete(variable)
        }
      }

      continue
    }

    if (FORGETS.has(name ?? '')) {
      values.clear()
      continue
    }

    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      const to = args[0]?.text ?? ''
      // A quoted `~` is a folder name, and `~someone` is another person's home.
      const isHomePath = args[0]?.isHome === true && IN_HOME.test(to)
      const isKnown =
        name === 'cd' && args.length === 1 && args[0]?.isUnknown === false && to !== '-' && (isHomePath || !to.startsWith('~'))

      isAdrift = isKnown ? isAdrift && !to.startsWith('/') && !isHomePath : true
      dir = isKnown ? enter(dir, to) : dir
      continue
    }

    const risk =
      name === 'rm'
        ? rm(dir, args)
        : name === 'git'
          ? git(dir, args.map(word => word.text))
          : migrate(dir, env, argv.map(word => word.text))

    if (risk !== undefined) {
      risks.push(isAdrift ? { ...risk, isAdrift } : risk)
    }
  }

  return risks
}

const rows = (text: string) => text.split('\n').filter(line => line.trim() !== '')
const count = (many: number, one: string, plural = `${one}s`) => `${many} ${many === 1 ? one : plural}`
const depth = (path: string) => path.split('/').filter(part => part !== '').length

export const size = (kib: number) => {
  if (kib < 1024) {
    return `${kib} KB`
  }

  return kib < 1024 * 1024 ? `${(kib / 1024).toFixed(1)} MB` : `${(kib / 1024 / 1024).toFixed(1)} GB`
}

// A dry run that fails to run (command missing, timeout) becomes "not measured", never a hook error.
const run = async (
  probe: Probe,
  argv: readonly string[],
  cwd: string,
  init: { env?: Record<string, string>; timeoutMs?: number } = {},
) => {
  try {
    return await probe.run(argv, { cwd, timeoutMs: DRY_RUN_MS, ...init })
  } catch {
    return undefined
  }
}

const globToRegExp = (pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\[!/g, '[^')}$`,
  )

/** The paths the shell would hand to `rm` for this target; `undefined` when only it knows. */
const expand = async (probe: Probe, target: Word, dir: string, home: string | undefined) => {
  const isHomePath = target.isHome && (target.text === '~' || target.text.startsWith('~/'))

  if (target.isUnknown || (target.isHome && (!isHomePath || home === undefined))) {
    return undefined
  }

  const full = resolve(dir, isHomePath ? `${home}${target.text.slice(1)}` : target.text)

  if (!target.isGlob) {
    return [full]
  }

  const cut = full.lastIndexOf('/')
  const parent = full.slice(0, cut) || '/'
  const pattern = full.slice(cut + 1)

  if (GLOB.test(parent)) {
    return undefined
  }

  const matcher = globToRegExp(pattern)
  const entries = await probe.list(parent).catch(() => [])

  return entries
    .filter(entry => matcher.test(entry.name) && (pattern.startsWith('.') || !entry.name.startsWith('.')))
    .map(entry => `${parent === '/' ? '' : parent}/${entry.name}`)
}

// Where everything is disposable, and from which level below the root on: in /var/folders the
// each user's temp directory is xx/<hash>/T, so only what is inside it counts.
const TEMP_ROOTS = [
  { root: '/tmp', floor: 1 },
  { root: '/private/tmp', floor: 1 },
  { root: '/var/folders', floor: 4 },
  { root: '/private/var/folders', floor: 4 },
]
// Claude Code's own temp directory holds scratchpads and skills for all sessions.
const SHARED = /^claude-[^/]*$/

const isInTemp = (real: string) =>
  TEMP_ROOTS.some(({ root, floor }) => {
    const below = real.startsWith(`${root}/`) ? real.slice(root.length + 1).split('/') : []

    return below.length >= floor && !(below.length === 1 && SHARED.test(below[0] ?? ''))
  })

// A target that does not exist counts where its parent really is.
const realOf = async (probe: Probe, path: string) => {
  const cut = path.lastIndexOf('/')
  const real = await probe.real(path)
  const parent = real === undefined && cut > 0 ? await probe.real(path.slice(0, cut)) : undefined

  return real ?? (parent === undefined ? undefined : `${parent}${path.slice(cut)}`)
}

// The whole repository in a temp directory: the working tree and the common .git, which in a
// linked worktree lives in the origin repository and holds its branches.
const isTempRepo = async (probe: Probe, dir: string) => {
  const asked = await run(probe, ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], dir)
  const places = asked?.exitCode === 0 ? rows(asked.stdout) : []

  for (const place of places) {
    const real = await realOf(probe, place)

    if (real === undefined || !isInTemp(real)) {
      return false
    }
  }

  return places.length === 2
}

/**
 * A risk that only touches a system temp directory: an `rm -rf` whose targets, with links
 * resolved, are all there, or a `git reset --hard` / `git clean` in a repository there.
 */
export const isDisposable = async (probe: Probe, risk: Risk, cwd: string): Promise<boolean> => {
  const home = await probe.home()
  const dir = locate(cwd, risk.dir, home)

  if (risk.isAdrift === true || dir === undefined) {
    return false
  }

  if (risk.kind === 'reset' || risk.kind === 'clean') {
    return !risk.isElsewhere && isTempRepo(probe, dir)
  }

  if (risk.kind !== 'rm' || risk.targets.length === 0) {
    return false
  }

  for (const target of risk.targets) {
    for (const path of (await expand(probe, target, dir, home)) ?? [undefined]) {
      const real = path === undefined ? undefined : await realOf(probe, path)
      // A glob directly in the temp root (`/tmp/*`) is the root by another name.
      const scope = target.isGlob ? real?.slice(0, real.lastIndexOf('/')) : real

      if (real === undefined || scope === undefined || !isInTemp(real) || !isInTemp(scope)) {
        return false
      }
    }
  }

  return true
}

const measureRm = async (probe: Probe, risk: Risk & { kind: 'rm' }, dir: string): Promise<Part> => {
  const home = await probe.home()
  const paths: string[] = []
  const notes: string[] = []

  for (const target of risk.targets) {
    const found = await expand(probe, target, dir, home)

    if (found === undefined) {
      notes.push(`${target.text}: não medido (só o shell sabe o que é)`)
    } else {
      paths.push(...found)
    }
  }

  // The root, a top-level directory or the home: find does not finish in time.
  const isHuge = (path: string) => depth(path) < 2 || path === home
  const measured = paths.filter(path => !isHuge(path))
  notes.push(...paths.filter(isHuge).map(path => `${path}: grande demais para medir`))

  if (measured.length === 0) {
    return {
      summary: notes.length > 0 ? 'apagar recursivamente alvos que não consegui medir' : 'apagar nada: sem alvos',
      lines: notes,
    }
  }

  const found = await run(probe, ['find', ...measured, '!', '-type', 'd'], dir)
  const sized = await run(probe, ['du', '-skc', ...measured], dir)

  if (found === undefined) {
    return { summary: 'apagar recursivamente alvos que não consegui medir (o find falhou ou demorou demais)', lines: [...measured, ...notes] }
  }

  const files = rows(found.stdout).map(path => (path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path))
  const kib = Number(rows(sized?.stdout ?? '').at(-1)?.split(/\s+/)[0] ?? 0) || 0
  const many = `${found.isStdoutTruncated ? 'mais de ' : ''}${count(files.length, 'arquivo')}`
  const unmeasured = notes.length > 0 ? `, mais ${count(notes.length, 'alvo')} que não medi` : ''

  return {
    summary:
      files.length === 0
        ? `apagar nada: os alvos não existem ou estão vazios${unmeasured}`
        : `apagar ${many} (${size(kib)})${unmeasured}`,
    lines: [...notes, ...files],
  }
}

const measureReset = async (probe: Probe, risk: Risk & { kind: 'reset' }, dir: string): Promise<Part> => {
  const status = await run(probe, ['git', 'status', '--porcelain'], dir)

  if (status === undefined || status.exitCode !== 0) {
    return { summary: 'descartar as alterações locais (não consegui ler o git status)', lines: [] }
  }

  const changed = rows(status.stdout).filter(line => !line.startsWith('??'))
  const log = risk.ref === undefined ? undefined : await run(probe, ['git', 'log', '--oneline', `${risk.ref}..HEAD`], dir)
  const commits = rows(log?.stdout ?? '')
  const dropped = commits.length > 0 ? ` e tirar ${count(commits.length, 'commit')} do branch` : ''
  const stat = (await run(probe, ['git', 'diff', '--shortstat', 'HEAD'], dir))?.stdout.trim() ?? ''

  return {
    summary:
      changed.length === 0 && commits.length === 0
        ? 'descartar nada: a árvore está limpa'
        : `descartar alterações não commitadas em ${count(changed.length, 'arquivo')}${dropped}`,
    lines: [...changed, ...commits],
    ...(changed.length > 0 && {
      note: `${stat === '' ? '' : `${stat}. `}Alterações não commitadas não podem ser recuperadas.`,
    }),
  }
}

const measureClean = async (probe: Probe, risk: Risk & { kind: 'clean' }, dir: string): Promise<Part> => {
  const dry = await run(probe, ['git', ...risk.args], dir)

  if (dry === undefined || dry.exitCode !== 0) {
    return { summary: 'apagar arquivos não rastreados (o git clean -n falhou)', lines: rows(dry?.stderr ?? '') }
  }

  const removed = rows(dry.stdout).map(line => line.replace(/^Would remove /, ''))

  return {
    summary: `apagar ${count(removed.length, 'item não rastreado', 'itens não rastreados')}`,
    lines: removed,
  }
}

const measurePush = async (probe: Probe, risk: Risk & { kind: 'push' }, dir: string): Promise<Part> => {
  const output = async (...args: string[]) => {
    const ran = await run(probe, ['git', ...args], dir)

    return ran?.exitCode === 0 ? ran.stdout.trim() : undefined
  }
  const branch = (await output('rev-parse', '--abbrev-ref', 'HEAD')) ?? 'HEAD'
  const upstream = (await output('rev-parse', '--abbrev-ref', '@{u}')) ?? `origin/${branch}`
  const pairs =
    risk.remote === undefined || risk.refspecs.length === 0
      ? [{ local: 'HEAD', remote: risk.remote === undefined ? upstream : `${risk.remote}/${branch}` }]
      : risk.refspecs.map(spec => {
          const [source = '', target = source] = spec.replace(/^\+/, '').split(':')
          const name = (target === 'HEAD' ? branch : target).replace(/^refs\/heads\//, '')

          return { local: source === '' ? 'HEAD' : source, remote: `${risk.remote}/${name}` }
        })
  const lost: string[] = []
  const notes: string[] = []

  for (const pair of pairs) {
    const log = await output('log', '--oneline', `${pair.local}..${pair.remote}`)

    if (log === undefined) {
      notes.push(`${pair.remote}: ref desconhecida aqui, nada a comparar`)
    } else {
      lost.push(...rows(log))
    }
  }

  const names = pairs.map(pair => pair.remote).join(', ')

  return {
    summary:
      lost.length > 0
        ? `sobrescrever ${count(lost.length, 'commit')} de ${names}`
        : `forçar o push para ${names} sem perder commit conhecido (comparado sem fetch)`,
    lines: [...notes, ...lost],
  }
}

const measureMigrate = async (probe: Probe, risk: Risk & { kind: 'migrate' }, dir: string): Promise<Part> => {
  const ran = await run(probe, risk.status, dir, { env: risk.env, timeoutMs: MIGRATION_STATUS_MS })

  if (ran === undefined || ran.exitCode !== 0) {
    return {
      summary: `aplicar migrações de banco (${risk.tool}; não consegui ler o estado)`,
      lines: rows(ran?.stderr ?? '').slice(-3),
    }
  }

  const { pending } = risk

  if (pending === undefined) {
    return { summary: `aplicar migrações de banco (${risk.tool}); o estado atual está abaixo`, lines: rows(ran.stdout) }
  }

  const names = rows(ran.stdout).flatMap(line => pending.exec(line)?.[1] ?? [])

  return {
    summary:
      names.length === 0
        ? `aplicar nenhuma migração: nada pendente (${risk.tool})`
        : `aplicar ${count(names.length, 'migração', 'migrações')} no banco (${risk.tool})`,
    lines: names,
  }
}

const measureOne = (probe: Probe, risk: Risk, dir: string): Promise<Part> => {
  switch (risk.kind) {
    case 'rm':
      return measureRm(probe, risk, dir)
    case 'reset':
      return measureReset(probe, risk, dir)
    case 'clean':
      return measureClean(probe, risk, dir)
    case 'push':
      return measurePush(probe, risk, dir)
    case 'migrate':
      return measureMigrate(probe, risk, dir)
  }
}

// The risk name in the panel title and the footer line with its target.
const describe = (risk: Risk): { title: string; note: string | undefined } => {
  switch (risk.kind) {
    case 'rm':
      return { title: 'rm -rf', note: `Caminhos: ${risk.targets.map(target => target.text).join(' ')}` }
    case 'reset':
      return { title: 'git reset --hard', note: undefined }
    case 'clean':
      return { title: 'git clean', note: undefined }
    case 'push':
      return { title: 'git push --force', note: risk.remote === undefined ? undefined : `Remoto: ${risk.remote}` }
    case 'migrate':
      return { title: `migração ${risk.tool}`, note: undefined }
  }
}

/** What the risks would change, measured with the tools' own dry runs. */
export const measure = async (
  probe: Probe,
  risks: readonly Risk[],
  cwd: string,
): Promise<BlastRadiusReport> => {
  const parts: Part[] = []
  const home = await probe.home()

  for (const risk of risks) {
    // Without a known home, the path with `~` stays as is and the measurement says it found nothing.
    parts.push(await measureOne(probe, risk, locate(cwd, risk.dir, home) ?? resolve(cwd, risk.dir)))
  }

  const lines = parts.flatMap(part => part.lines)
  const described = risks.map(describe)

  return {
    title: [...new Set(described.map(one => one.title))].join(' + '),
    notes: [...described, ...parts].flatMap(one => one.note ?? []),
    summary: parts.map(part => part.summary).join('; '),
    lines: lines.slice(0, KEPT_LINES),
    total: lines.length,
  }
}
