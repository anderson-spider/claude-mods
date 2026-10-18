// The host fake the plugin's tests share: an in-memory file system, a scripted git, the prompt box, the pane and the clock.
import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine, Mounted, MountTarget } from 'claude-code/testing'

export const ROOT = '/proj'
export const NOW = Date.parse('2026-10-18T12:00:00Z')

// `mtimeMs` counts a folder's changes, so a refresh sees them; a file reports `modifiedAt`, set by `touch`, else none.
type Node = { kind: 'file' | 'dir'; text: string; mtimeMs: number; modifiedAt?: number; link?: string }

/** What git answers: absent, the folder is no repository. */
export type Git = { top: string; status: string; numstat?: string; lsFiles?: string; show?: string }

export type World = ReturnType<typeof world>

const parentOf = (path: string) => path.slice(0, Math.max(1, path.lastIndexOf('/')))

/** A host with the files given (`dir/` names a folder, `name -> target` a link), `git` answering when given. */
export function world(on: On, files: readonly string[], opts: { git?: Git; draft?: string } = {}) {
  const tree = new Map<string, Node>([[ROOT, { kind: 'dir', text: '', mtimeMs: 1 }]])
  const runs: string[][] = []
  const opened: string[] = []
  const copies: string[] = []
  const fills: string[] = []
  const reads: string[] = []
  const gitRuns: string[][] = []
  const prompt = { text: opts.draft ?? '' }
  const git = { current: opts.git }

  const add = (spec: string) => {
    const [name = '', link] = spec.split(' -> ')
    const isDir = name.endsWith('/')
    const path = `${ROOT}/${name.replace(/\/$/, '')}`
    for (let dir = parentOf(path); dir !== ROOT && !tree.has(dir); dir = parentOf(dir)) tree.set(dir, { kind: 'dir', text: '', mtimeMs: 1 })
    const node: Node = { kind: isDir ? 'dir' : 'file', text: isDir ? '' : `text of ${name}\n`, mtimeMs: 1 }
    if (link) node.link = `${ROOT}/${link}`
    tree.set(path, node)
    const dir = tree.get(parentOf(path))
    if (dir) dir.mtimeMs++
  }
  const remove = (name: string) => {
    const path = `${ROOT}/${name}`
    for (const key of [...tree.keys()]) if (key === path || key.startsWith(`${path}/`)) tree.delete(key)
    const dir = tree.get(parentOf(path))
    if (dir) dir.mtimeMs++
  }
  /** Sets when a file was last modified (ms since the epoch). */
  const touch = (name: string, at: number) => {
    const node = tree.get(`${ROOT}/${name}`)
    if (node) node.modifiedAt = at
  }
  files.forEach(add)
  const target = (path: string) => {
    const node = tree.get(path)
    return node?.link ? tree.get(node.link) : node
  }

  const clock = mock.clock(((name: string, ...rest: unknown[]) => (name === 'clock.now' ? undefined : (on as (...a: unknown[]) => unknown)(name, ...rest))) as unknown as On)
  on('clock.now', () => ({ value: clock.now() + NOW }))

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's1' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', (_$, e) => (opened.push(e.id), { value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: opened.map(id => ({ id, title: 'Files' })) }) as never)
  on('ui.focus', () => ({ value: {} }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', (_$, e) => (copies.push(e.text), { value: { isCopied: true } }) as never)
  on('prompt.read', () => ({ value: { text: prompt.text, cursor: prompt.text.length } }) as never)
  on('prompt.fill', (_$, e) => {
    fills.push(e.text)
    prompt.text += e.text
    return { isFilled: true, text: prompt.text } as never
  })
  for (const name of ['classic.SessionStart', 'classic.FileChanged', 'classic.CwdChanged'] as const) on(name, () => ({}) as never)

  on('fs.list', (_$, e) => {
    const dir = (e as { path?: string }).path ?? ROOT
    if (target(dir)?.kind !== 'dir') return { deny: `ENOENT: ${dir}` } as never
    const real = tree.get(dir)?.link ?? dir
    const entries = [...tree.entries()].filter(([path]) => path !== real && parentOf(path) === real).map(([path, node]) => ({
      name: path.slice(real.length + 1), kind: node.link ? 'other' : node.kind, size: node.text.length, mtimeMs: node.kind === 'file' ? node.modifiedAt ?? 0 : 0, isLink: Boolean(node.link),
    }))
    return { value: entries } as never
  })
  on('fs.stat', (_$, e) => {
    const path = (e as { path: string }).path
    const node = target(path)
    if (!node) return { deny: `ENOENT: ${path}` } as never
    return { value: { kind: node.kind, size: node.text.length, mtimeMs: node.mtimeMs, isLink: Boolean(tree.get(path)?.link) } } as never
  })
  on('fs.read', (_$, e) => {
    reads.push((e as { path: string }).path)
    const node = target((e as { path: string }).path)
    return node?.kind === 'file' ? { value: node.text } as never : { deny: 'ENOENT' } as never
  })

  const ran = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$, e) => {
    const raw = [...e.argv]
    gitRuns.push(raw)
    // Tests read the verb at argv[1]: git's global options (`--no-optional-locks`, `-c key=value`) are set aside.
    const argv = raw[0] === 'git' ? ['git', ...raw.slice(1).filter((arg, i, all) => arg !== '--no-optional-locks' && arg !== '-c' && all[i - 1] !== '-c')] : raw
    runs.push(argv)
    const repo = git.current
    if (argv[0] === 'uname') return ran('Darwin\n') as never
    if (argv[0] !== 'git') return ran() as never
    if (!repo) return ran('', 128) as never
    switch (argv[1]) {
      case 'rev-parse': return ran(`\n${repo.top}/.git\n`) as never
      case 'status': return ran(repo.status) as never
      case 'diff': return ran(repo.numstat ?? '') as never
      case 'ls-files': return ran(repo.lsFiles ?? '') as never
      case 'show': return ran(repo.show ?? '') as never
      default: return ran() as never
    }
  })

  return { tree, add, remove, touch, runs, gitRuns, opened, copies, fills, reads, prompt, git, clock }
}

export const start = ($: Engine, cwd = ROOT) => $.session.start({ cwd, surface: 'terminal', isInteractive: true } as never)

/** The pane's props for a body `columns` wide and `rows` tall. */
export const pane = (columns = 40, rows = 20): MountTarget<'terminal', 'Pane'> => ({
  plugin: 'file-explorer', component: 'Pane', surface: 'terminal', requestId: 'file-explorer',
  props: { title: 'Files', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} },
})

type Segment = { t: string; c?: string; b?: true; d?: true; s?: true }

const linesOf = async (ui: Mounted<'terminal', 'Pane'>) =>
  ((await ui.find({ type: 'Client' }))?.props.props as { lines?: Segment[][] } | undefined)?.lines ?? []

const textOf = (line: Segment[]) => line.map(one => one.t).join('').trimEnd()

/** The tree rows the pane drew, as text. */
export const rows = async (ui: Mounted<'terminal', 'Pane'>) => (await linesOf(ui)).map(textOf)

/** The row the keys act on, as the footer names it: its path from the root. */
export const cursor = async (ui: Mounted<'terminal', 'Pane'>) => (await ui.find({ type: 'Text', text: /^selected: / }))?.text.slice('selected: '.length)

/** The segments of the row whose text holds `name`. */
export const segmentsOf = async (ui: Mounted<'terminal', 'Pane'>, name: string) =>
  (await linesOf(ui)).find(line => line.some(one => one.t.includes(name)))

/** A key pressed in the rows, as the person does once the rows hold the focus. */
export const key = (ui: Mounted<'terminal', 'Pane'>, name: string) => ui.key({ key: name, in: 'rows' })
