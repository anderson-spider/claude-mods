import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { BranchGuardReport } from '../types'

// O parser, `resolve`, `locate` e a checagem de repositório temporário são cópias enxutas dos
// de plugins/blast-radius/hooks/risk.ts: um plugin não importa código de outro. Uma correção
// lá precisa ser levada para cá.

/** Uma palavra do comando, já sem aspas, e o que o shell ainda faria com ela. */
export type Word = {
  text: string
  /** Tem `$`, crase ou chaves: só o shell sabe no que vira. */
  isUnknown: boolean
  /** Tem `~` fora de aspas. */
  isHome: boolean
}

export type Risk = {
  dir: string
  /** Um `cd` ilegível veio antes: `dir` não é confiável. */
  isAdrift?: boolean
  /** Um --git-dir ou --work-tree aponta o git para fora de `dir`. */
  isElsewhere: boolean
  /** A branch que um `checkout`/`switch` da mesma linha deixa ativa; `unknown` quando o texto não revela. */
  branchAfter?: string
} & (
  | {
      kind: 'commit'
      isAll: boolean
      isAmend: boolean
      isAllowEmpty: boolean
      hasPathspec: boolean
      /** Um `git add` veio antes na linha: o índice de agora não é o do commit. */
      stagesFirst: boolean
    }
  | {
      kind: 'publish'
      remote: string | undefined
      refspecs: string[]
      isAllRefs: boolean
      hasUnknownRef: boolean
    }
)

/** O que a checagem precisa do host; quem tem o `$` é o módulo de hooks, que o entrega assim. */
export type Probe = {
  run: (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>
  home: () => Promise<string | undefined>
  /** O caminho com todo link simbólico resolvido; `undefined` quando ele não existe. */
  real: (path: string) => Promise<string | undefined>
}

type Part = { summary: string; lines: string[]; note?: string }

/** As branches em que um commit ou push direto merece uma pergunta. */
export const PROTECTED = /^(main|master|develop|release([/_-].*)?)$/

const KEPT_LINES = 40
const GIT_MS = 15_000
const BREAKS = new Set([';', '\n', '(', ')'])
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env'])
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s
const IN_HOME = /^~(\/|$)/
const SEQUENCE = new Set(['', ';', '\n', '&&'])
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', '{', '}'])
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix'])
const STAGERS = new Set(['add', 'rm', 'mv', 'apply'])
const COMMIT_SHORT = 'mFCct'
const COMMIT_LONG = [
  '--message',
  '--file',
  '--author',
  '--date',
  '--template',
  '--reuse-message',
  '--reedit-message',
  '--fixup',
  '--squash',
  '--cleanup',
  '--trailer',
  '--pathspec-from-file',
]
const PUSH_LONG = ['--push-option', '--repo', '--receive-pack', '--exec']
const FORCES = ['-f', '--force', '--force-with-lease', '--force-if-includes']

type Command = { words: Word[]; /** O separador que veio antes: `;`, `&&`, `|`, `(`… */ before: string }

// Os comandos simples da linha, vazios inclusive, cada um com o separador que o antecede.
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

/** `path` a partir de `base`, sem `.` nem `..` no meio. */
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

// `dir` depois de um `cd to`; um destino na home fica como `~/…` até alguém saber onde ela é.
const enter = (dir: string, to: string) => resolve(IN_HOME.test(to) ? '.' : dir, to)

/** Onde `dir` fica de verdade: a partir da home quando começa com `~`, senão a partir de `cwd`. */
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

/** Separa as flags dos argumentos soltos; `shortValued` e `longValued` levam um valor ao lado. */
const scan = (args: readonly Word[], shortValued: string, longValued: readonly string[]) => {
  const flags = new Set<string>()
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
      const [flag = ''] = text.split('=')

      flags.add(flag)
      at += !text.includes('=') && longValued.includes(flag) ? 1 : 0
    } else if (text.startsWith('-') && text.length > 1) {
      for (let index = 1; index < text.length; index += 1) {
        const letter = text[index] ?? ''

        flags.add(`-${letter}`)

        if (shortValued.includes(letter)) {
          at += index === text.length - 1 ? 1 : 0
          break
        }
      }
    } else {
      positional.push(word)
    }
  }

  return { flags, positional }
}

type State = {
  dir: string
  isAdrift: boolean
  branch: string | undefined
  isStaged: boolean
  isStraight: boolean
}

// Onde um `checkout`/`switch` deixa a pessoa: o nome quando o texto o revela, `unknown` quando não.
const move = (state: State, sub: string, args: readonly Word[], isSure: boolean) => {
  const makers = ['-b', '-B', '-c', '-C', '--orphan', '--create', '--force-create']
  const at = args.findIndex(arg => makers.includes(arg.text))
  const named = at >= 0 ? args[at + 1] : undefined
  const plain = args.filter(arg => !arg.text.startsWith('-') || arg.text === '-')
  // Um `checkout` solto pode ser de arquivo; só uma branch protegida por nome conta como troca.
  const loose = sub === 'switch' || PROTECTED.test(plain[0]?.text ?? '') ? plain[0] : undefined
  const target = at >= 0 ? named : args.some(arg => arg.text === '--') ? undefined : loose

  if (target === undefined) {
    return
  }

  state.branch = isSure && !target.isUnknown && target.text !== '-' ? target.text : 'unknown'
}

const git = (state: State, words: readonly Word[], isSure: boolean): Risk | undefined => {
  let at = 0
  let where = state.dir
  let isElsewhere = false

  while ((words[at]?.text ?? '').startsWith('-')) {
    const flag = words[at]?.text ?? ''

    isElsewhere ||= /^--(git-dir|work-tree)\b/.test(flag)
    where = flag === '-C' ? enter(where, words[at + 1]?.text ?? '.') : where
    at += GIT_VALUED.has(flag) ? 2 : 1
  }

  const sub = words[at]?.text ?? ''
  const args = words.slice(at + 1)
  const base = { dir: where, isElsewhere, ...(state.branch === undefined ? {} : { branchAfter: state.branch }) }

  if (STAGERS.has(sub)) {
    state.isStaged = true

    return undefined
  }

  if (sub === 'checkout' || sub === 'switch') {
    move(state, sub, args, isSure)

    return undefined
  }

  if (sub === 'commit') {
    const { flags, positional } = scan(args, COMMIT_SHORT, COMMIT_LONG)

    return flags.has('--dry-run')
      ? undefined
      : {
          ...base,
          kind: 'commit',
          isAll: flags.has('--all') || flags.has('-a'),
          isAmend: flags.has('--amend'),
          isAllowEmpty: flags.has('--allow-empty'),
          hasPathspec: positional.length > 0,
          stagesFirst: state.isStaged,
        }
  }

  if (sub === 'push') {
    const { flags, positional } = scan(args, 'o', PUSH_LONG)
    // O force push e o dry run não são daqui: o primeiro é do blast-radius, o segundo não envia nada.
    const isOther = [...FORCES, '-n', '--dry-run'].some(flag => flags.has(flag)) || positional.some(word => word.text.startsWith('+'))

    if (isOther) {
      return undefined
    }

    const named: Word[] = []

    for (let index = 1; index < positional.length; index += 1) {
      const word = positional[index]

      if (word?.text === 'tag') {
        index += 1
      } else if (word !== undefined && !word.text.startsWith('refs/tags/')) {
        named.push(word)
      }
    }

    // Só tags saindo: não mexe em branch nenhuma.
    if ((flags.has('--tags') || positional.some(word => word.text === 'tag') || positional.slice(1).some(word => word.text.startsWith('refs/tags/'))) && named.length === 0) {
      return undefined
    }

    return {
      ...base,
      kind: 'publish',
      remote: positional[0]?.text,
      refspecs: named.map(word => word.text),
      isAllRefs: flags.has('--all') || flags.has('--mirror') || flags.has('--branches'),
      hasUnknownRef: named.some(word => word.isUnknown),
    }
  }

  return undefined
}

/** Os commits e pushes que a linha de comando carrega, na ordem; vazio para todo o resto. */
export const classify = (command: string): Risk[] => {
  const risks: Risk[] = []
  const parsed = parse(command)
  // Com `if`, `for` e afins não dá para saber, só pelo texto, quais trocas de branch rodam.
  const isStraight = !parsed.some(one => KEYWORDS.has(one.words[0]?.text ?? ''))
  const state: State = { dir: '.', isAdrift: false, branch: undefined, isStaged: false, isStraight }

  for (const [at, one] of parsed.entries()) {
    const argv = bare(one.words)
    const name = (argv[0]?.text ?? '').split('/').at(-1)
    const args = argv.slice(1)

    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      const to = args[0]?.text ?? ''
      // Um `~` entre aspas é um nome de pasta, e `~fulano` é a home de outra pessoa.
      const isHomePath = args[0]?.isHome === true && IN_HOME.test(to)
      const isKnown =
        name === 'cd' && args.length === 1 && args[0]?.isUnknown === false && to !== '-' && (isHomePath || !to.startsWith('~'))

      state.isAdrift = isKnown ? state.isAdrift && !to.startsWith('/') && !isHomePath : true
      state.dir = isKnown ? enter(state.dir, to) : state.dir
    } else if (name === 'git') {
      const isSure = state.isStraight && SEQUENCE.has(one.before) && SEQUENCE.has(parsed[at + 1]?.before ?? '')
      const risk = git(state, args, isSure)

      if (risk !== undefined) {
        risks.push(state.isAdrift ? { ...risk, isAdrift: true } : risk)
      }
    }
  }

  return risks
}

const rows = (text: string) => text.split('\n').filter(line => line.trim() !== '')
const count = (many: number, one: string, plural = `${one}s`) => `${many} ${many === 1 ? one : plural}`

// Um comando que não sai (git ausente, tempo esgotado) vira `undefined`, nunca um erro do hook.
const out = async (probe: Probe, argv: readonly string[], cwd: string) => {
  try {
    const ran = await probe.run(argv, { cwd, timeoutMs: GIT_MS })

    return ran.exitCode === 0 ? ran.stdout.trimEnd() : undefined
  } catch {
    return undefined
  }
}

// Onde tudo é descartável, e de que nível abaixo da raiz em diante: em /var/folders o
// temporário de cada usuário é xx/<hash>/T, então só o que está dentro dele conta.
const TEMP_ROOTS = [
  { root: '/tmp', floor: 1 },
  { root: '/private/tmp', floor: 1 },
  { root: '/var/folders', floor: 4 },
  { root: '/private/var/folders', floor: 4 },
]
// O temporário do próprio Claude Code guarda scratchpads e skills de todas as sessões.
const SHARED = /^claude-[^/]*$/

const isInTemp = (real: string) =>
  TEMP_ROOTS.some(({ root, floor }) => {
    const below = real.startsWith(`${root}/`) ? real.slice(root.length + 1).split('/') : []

    return below.length >= floor && !(below.length === 1 && SHARED.test(below[0] ?? ''))
  })

// Um alvo que não existe vale onde o pai dele fica de verdade.
const realOf = async (probe: Probe, path: string) => {
  const cut = path.lastIndexOf('/')
  const real = await probe.real(path)
  const parent = real === undefined && cut > 0 ? await probe.real(path.slice(0, cut)) : undefined

  return real ?? (parent === undefined ? undefined : `${parent}${path.slice(cut)}`)
}

// O repositório inteiro num temporário: a árvore de trabalho e o .git comum.
const isTempRepo = async (probe: Probe, dir: string) => {
  const asked = await out(probe, ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], dir)
  const places = rows(asked ?? '')

  for (const place of places) {
    const real = await realOf(probe, place)

    if (real === undefined || !isInTemp(real)) {
      return false
    }
  }

  return places.length === 2
}

// A branch que o push atualizaria, por refspec: `src`, `src:dst`, `:dst`, `refs/heads/x`.
const pushed = (risk: Risk & { kind: 'publish' }, here: string, upstream: string | undefined) => {
  if (risk.refspecs.length === 0) {
    const tracked = risk.remote === undefined ? upstream?.replace(/^[^/]+\//, '') : undefined
    const names = [here, tracked].flatMap(name => (name === undefined || name === '' || name === 'unknown' ? [] : [name]))

    return [...new Set(names)].map(name => ({ local: 'HEAD', name }))
  }

  return risk.refspecs.flatMap(spec => {
    const [src = '', dst] = spec.split(':')
    const raw = (dst ?? src).replace(/^refs\/heads\//, '')
    const name = raw === 'HEAD' ? here : raw

    return name === '' || name === 'unknown' ? [] : [{ local: src === '' ? undefined : src, name }]
  })
}

const upstreamOf = (probe: Probe, dir: string) => out(probe, ['git', 'rev-parse', '--abbrev-ref', '@{u}'], dir)
const currentOf = (probe: Probe, risk: Risk, dir: string) =>
  risk.branchAfter === undefined ? out(probe, ['git', 'branch', '--show-current'], dir) : Promise.resolve(risk.branchAfter)

/** Um commit ou push cuja branch alvo é protegida; o resto passa sem perguntar. */
export const isProtectedTarget = async (probe: Probe, risk: Risk, cwd: string): Promise<boolean> => {
  const dir = locate(cwd, risk.dir, await probe.home())

  if (risk.isAdrift === true || risk.isElsewhere || dir === undefined || (await isTempRepo(probe, dir))) {
    return false
  }

  const here = (await currentOf(probe, risk, dir)) ?? ''

  if (risk.kind === 'commit') {
    if (here === '' || here === 'unknown') {
      return false
    }

    // Sem nada staged o git recusa o commit: não há o que segurar.
    const isSure = risk.isAll || risk.isAmend || risk.isAllowEmpty || risk.hasPathspec || risk.stagesFirst
    const staged = isSure ? 'sure' : await out(probe, ['git', 'diff', '--cached', '--name-only'], dir)

    return staged !== undefined && staged !== '' && PROTECTED.test(here)
  }

  if (risk.isAllRefs || risk.hasUnknownRef) {
    return true
  }

  const upstream = risk.refspecs.length === 0 && risk.remote === undefined ? await upstreamOf(probe, dir) : undefined

  return pushed(risk, here, upstream).some(target => PROTECTED.test(target.name))
}

const measureCommit = async (probe: Probe, risk: Risk & { kind: 'commit' }, dir: string): Promise<Part> => {
  const branch = (await currentOf(probe, risk, dir)) || 'HEAD'
  const isIndex = !(risk.isAll || risk.stagesFirst || risk.hasPathspec)
  const files = isIndex
    ? rows((await out(probe, ['git', 'diff', '--cached', '--name-only'], dir)) ?? '')
    : rows((await out(probe, ['git', 'status', '--porcelain'], dir)) ?? '').filter(
        line => risk.stagesFirst || !line.startsWith('??'),
      )
  const stat = isIndex ? ((await out(probe, ['git', 'diff', '--cached', '--shortstat'], dir)) ?? '').trim() : ''

  if (risk.isAmend) {
    return {
      summary: `reescrever o último commit de ${branch}${files.length > 0 ? ` com mais ${count(files.length, 'arquivo')}` : ''}`,
      lines: files,
      ...(stat !== '' && { note: stat }),
    }
  }

  return {
    summary:
      files.length === 0
        ? `commitar direto em ${branch}, sem alterações que eu consiga ver`
        : `commitar ${count(files.length, 'arquivo')} direto em ${branch}`,
    lines: files,
    ...(stat !== '' && { note: stat }),
  }
}

const measurePublish = async (probe: Probe, risk: Risk & { kind: 'publish' }, dir: string): Promise<Part> => {
  if (risk.isAllRefs) {
    return { summary: 'enviar todas as branches locais para o remoto (--all/--mirror)', lines: [] }
  }

  const here = (await currentOf(probe, risk, dir)) || 'HEAD'
  const upstream = await upstreamOf(probe, dir)
  const remote = risk.remote ?? upstream?.split('/')[0] ?? 'origin'
  const targets = pushed(risk, here, risk.refspecs.length === 0 && risk.remote === undefined ? upstream : undefined)
  const commits: string[] = []
  const notes: string[] = []

  for (const target of targets) {
    const ref = `${remote}/${target.name}`

    if (target.local === undefined && risk.refspecs.length > 0) {
      notes.push(`${ref}: será apagada`)
      continue
    }

    const log = await out(probe, ['git', 'log', '--oneline', `${ref}..${target.local ?? 'HEAD'}`], dir)

    if (log === undefined) {
      notes.push(`${ref}: ref desconhecida aqui, nada a comparar`)
    } else {
      commits.push(...rows(log))
    }
  }

  if (risk.hasUnknownRef) {
    notes.push('destino não medido (só o shell sabe qual é)')
  }

  const names = targets.map(target => `${remote}/${target.name}`).join(', ') || remote

  return {
    summary:
      commits.length > 0
        ? `enviar ${count(commits.length, 'commit')} para ${names}`
        : `enviar nada novo para ${names} (comparado sem fetch)`,
    lines: [...notes, ...commits],
  }
}

const measureOne = (probe: Probe, risk: Risk, dir: string): Promise<Part> =>
  risk.kind === 'commit' ? measureCommit(probe, risk, dir) : measurePublish(probe, risk, dir)

/** O que os commits e pushes fariam, medido com o próprio git. */
export const measure = async (
  probe: Probe,
  risks: readonly Risk[],
  cwd: string,
): Promise<BranchGuardReport> => {
  const parts: Part[] = []
  const home = await probe.home()

  for (const risk of risks) {
    parts.push(await measureOne(probe, risk, locate(cwd, risk.dir, home) ?? resolve(cwd, risk.dir)))
  }

  const lines = parts.flatMap(part => part.lines)
  const titles = risks.map(risk => (risk.kind === 'commit' ? 'git commit' : 'git push'))

  return {
    title: [...new Set(titles)].join(' + '),
    notes: parts.flatMap(part => part.note ?? []),
    summary: parts.map(part => part.summary).join('; '),
    lines: lines.slice(0, KEPT_LINES),
    total: lines.length,
  }
}
