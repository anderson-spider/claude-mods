import { atom, read, update } from 'claude-code'
import type { Hook, Register, Timer } from 'claude-code'
import type { FileExplorerPreview as Preview, FileExplorerView as ExplorerView } from '../types'
import { nextFlashEnd, recorded, shellEffects, touchedBy, writing } from './activity'
import type { Activity } from './activity'
import { configOf } from './config'
import type { Config } from './config'
import { EMPTY_VIEW, collapse, collapseAll, cursorIndex, hitRows, navigate, revealed, rowStates, settled, treeRows, viewAt } from './explorer'
import type { Effect } from './explorer'
import { parseNumstat, parseStatus, rollUp, totals } from './git'
import type { GitStatus } from './git'
import { iconOf } from './icons'
import { openArgv, platformOf } from './open'
import type { Platform } from './open'
import { base, isInside, join, mention, normalize, parent, relative, resolve } from './paths'
import { MAX_INDEX, rank, withDirectories } from './search'
import { listingOf, scrollTop } from './tree'
import type { Entry, Listing, Row } from './tree'
import { ACTIVITY_LABEL, ago, branchSegments, colorOf, cut, rowSegments } from './view'
import type { Segment } from './view'

type Dollar = Parameters<Hook<'session.start'>>[0]

const PANE = 'file-explorer'
const TITLE = 'Files'

const viewAtom = atom({ plugin: 'file-explorer', key: 'view' } as const, EMPTY_VIEW)
const dirsAtom = atom({ plugin: 'file-explorer', key: 'dirs' } as const, {} as Record<string, Listing>)
const gitAtom = atom({ plugin: 'file-explorer', key: 'git' } as const, null as GitStatus | null)
const activityAtom = atom({ plugin: 'file-explorer', key: 'activity' } as const, [] as Activity[])
const tickAtom = atom({ plugin: 'file-explorer', key: 'tick' } as const, 0)
const editingAtom = atom({ plugin: 'file-explorer', key: 'editing' } as const, [] as string[])

/** Git and the index wait this long after the last change before they run, so a burst of edits costs one run. */
const GIT_DEBOUNCE_MS = 300
/** A second click on the same row within this long opens it. */
const DOUBLE_CLICK_MS = 450
/** A file larger than this is not previewed, and a preview keeps at most this many lines. */
const PREVIEW_BYTES = 512 * 1024
const PREVIEW_LINES = 2000
/** The search walk outside a repository goes this deep. */
const WALK_DEPTH = 8
/** The links of one listing whose targets are looked up; past it a link is shown as a file. */
const LINK_STATS = 100
/** The tools whose finished calls may change files, so the tree and git are read again after them. */
const CHANGING = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'])
/**
 * Git as the explorer runs it: no optional locks, so a background status never holds `index.lock` against Claude's own
 * `git add` or `commit`, and no fsmonitor, so a repository's config cannot make a read run a command of its own.
 */
const GIT = ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false'] as const
/** While the pane is open, the modified column's ages are drawn again this often. */
const AGES_MS = 60_000

/** What the module keeps between events: timers, caches and the last drawn size. A reload starts it over. */
type Held = {
  config: Config
  height: number
  repo?: { root: string; top?: string; gitDir?: string }
  index?: { root: string; files: string[]; dirs: Set<string> }
  /** Moves on each time the index is dropped, so a build that started before is not kept. */
  indexGeneration: number
  indexing?: { root: string; job: Promise<Held['index']> }
  platform?: Platform
  gitTimer?: Timer
  gitBusy: boolean
  gitAgain: boolean
  refresh?: Timer
  ages?: Timer
  flash?: Timer
  lastClick?: { index: number; at: number }
}

/** Observation never changes what the host answered: a failure is one debug line. */
async function observe($: Dollar, action: () => Promise<void>): Promise<void> {
  try { await action() } catch {
    try { $.ui.log('file-explorer: background work failed', { to: 'debug' }) } catch { /* Reporting cannot change the result. */ }
  }
}

/** Reads `dir` into the cache: entries sorted, links resolved to what they lead to. A directory that cannot be read lists empty. */
async function listDir($: Dollar, held: Held, dir: string): Promise<void> {
  let listing: Listing
  try {
    const [found, stat] = await Promise.all([$.fs.list(dir), $.fs.stat(dir)])
    let linksLeft = LINK_STATS
    const entries: Entry[] = await Promise.all(found.map(async (one): Promise<Entry> => {
      if (!one.isLink) return { name: one.name, kind: one.kind, isLink: false, size: one.size, mtimeMs: one.mtimeMs }
      if (linksLeft-- <= 0) return { name: one.name, kind: 'file', isLink: true, size: 0, mtimeMs: 0 }
      const target = await $.fs.stat(join(dir, one.name)).catch(() => undefined)
      return { name: one.name, kind: target?.kind ?? 'other', isLink: true, size: target?.size ?? 0, mtimeMs: target?.mtimeMs ?? 0 }
    }))
    listing = listingOf(entries, stat.mtimeMs, held.config.sort)
  } catch {
    listing = { entries: [], omitted: 0, mtimeMs: 0 }
  }
  await update($, dirsAtom, dirs => ({ ...dirs, [dir]: listing }))
}

/** Lists the root and every expanded directory not read yet. */
async function ensureLoaded($: Dollar, held: Held): Promise<void> {
  const view = await read($, viewAtom)
  const dirs = await read($, dirsAtom)
  const wanted = [view.root, ...view.expanded].filter(dir => dir && !dirs[dir])
  await Promise.all(wanted.map(dir => listDir($, held, dir)))
}

/**
 * Reads again each shown directory whose mtime moved (every one with `force`), and forgets the listings of
 * directories no longer shown, so the cache holds only what the tree draws.
 */
async function refreshDirs($: Dollar, held: Held, force: boolean): Promise<void> {
  const view = await read($, viewAtom)
  if (!view.root) return
  const shown = new Set([view.root, ...view.expanded])
  const dirs = await read($, dirsAtom)
  const stale = await Promise.all([...shown].map(async dir => {
    const listing = dirs[dir]
    if (!listing || force) return dir
    const stat = await $.fs.stat(dir).catch(() => undefined)
    return stat?.mtimeMs !== listing.mtimeMs ? dir : undefined
  }))
  if (Object.keys(dirs).some(dir => !shown.has(dir))) {
    // Read the view again: a folder expanded while the stats ran keeps its listing.
    const now = await read($, viewAtom)
    const keep = new Set([now.root, ...now.expanded])
    await update($, dirsAtom, all => Object.fromEntries(Object.entries(all).filter(([dir]) => keep.has(dir))))
  }
  const changed = stale.filter((dir): dir is string => dir !== undefined)
  if (changed.length === 0) return
  const previous = cursorIndex(view, treeRows(view, dirs, held.config))
  await Promise.all(changed.map(dir => listDir($, held, dir)))
  dropIndex(held)
  // A cursor whose file went away moves to the row now in its place, not back to the top.
  const listed = await read($, dirsAtom)
  await update($, viewAtom, current => settled(current, treeRows(current, listed, held.config), held.height, previous))
}

/**
 * The repository holding `root`: its top and git directory, asked of git once per root (again after a refresh or a
 * `git init`). The top is spelled from the root (`--show-cdup`), so a root reached through a link still matches.
 */
async function repoOf($: Dollar, held: Held, root: string): Promise<Held['repo']> {
  if (held.repo?.root === root) return held.repo
  const ran = await $.process.run([...GIT, 'rev-parse', '--show-cdup', '--absolute-git-dir'], { cwd: root, timeoutMs: 5000 }).catch(() => undefined)
  const [cdup, gitDir] = ran?.exitCode === 0 ? ran.stdout.split('\n').map(line => line.trim()) : []
  held.repo = cdup !== undefined && gitDir ? { root, top: resolve(root, cdup || '.'), gitDir: normalize(gitDir) } : { root }
  return held.repo
}

/** Reads git status (and, in `full` mode, the lines changed) into the state; one run at a time, again if asked meanwhile. */
async function refreshGit($: Dollar, held: Held): Promise<void> {
  if (held.gitBusy) {
    held.gitAgain = true
    return
  }
  held.gitBusy = true
  try {
    do {
      held.gitAgain = false
      const { root } = await read($, viewAtom)
      const repo = root && held.config.git !== 'off' ? await repoOf($, held, root) : undefined
      if (!repo?.top) {
        await update($, gitAtom, () => null)
        continue
      }
      const status = await $.process.run([...GIT, 'status', '--porcelain=v1', '-b', '-z', '--untracked-files=normal'], { cwd: root, timeoutMs: 15_000 })
      if (status.exitCode !== 0) continue
      const parsed = parseStatus(status.stdout, repo.top)
      let lines: GitStatus['lines'] = {}
      if (held.config.git === 'full') {
        const numstat = await $.process.run([...GIT, 'diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', 'HEAD'], { cwd: root, timeoutMs: 15_000 }).catch(() => undefined)
        if (numstat?.exitCode === 0) lines = parseNumstat(numstat.stdout, repo.top)
      }
      await update($, gitAtom, () => ({ ...parsed, lines, dirs: rollUp(root, parsed.files) }))
    } while (held.gitAgain)
  } finally {
    held.gitBusy = false
  }
}

function scheduleGit($: Dollar, held: Held): void {
  held.gitTimer?.cancel()
  held.gitTimer = $.clock.after(GIT_DEBOUNCE_MS, () => void observe($, () => refreshGit($, held)))
}

/** Redraws once when the next flash ends, so a touched row stops flashing with no polling. */
async function scheduleFlash($: Dollar, held: Held): Promise<void> {
  if (!held.config.animations) return
  const now = await $.clock.now()
  const end = nextFlashEnd(await read($, activityAtom), now)
  held.flash?.cancel()
  if (end !== undefined) held.flash = $.clock.after(end - now + 20, () => void observe($, () => update($, tickAtom, n => n + 1).then(() => scheduleFlash($, held))))
}

/** Points the explorer at `root`: a fresh view, cache and git status. */
async function setRoot($: Dollar, held: Held, root: string, isPinned: boolean): Promise<void> {
  const current = await read($, viewAtom)
  await update($, viewAtom, () => viewAt(root, isPinned, current.root ? current.showHidden : held.config.showHidden))
  await update($, dirsAtom, () => ({}))
  await update($, gitAtom, () => null)
  dropIndex(held)
  await listDir($, held, root)
  scheduleGit($, held)
}

/** Expands the tree down to `path` and puts the cursor on it. */
async function reveal($: Dollar, held: Held, path: string): Promise<void> {
  const view = await read($, viewAtom)
  if (!isInside(view.root, path) || path === view.root) return
  await update($, viewAtom, () => revealed(view, path))
  await ensureLoaded($, held)
}

/** Records what Claude touched, follows it when asked, and reads again what may have changed. */
async function touched($: Dollar, held: Held, tool: string, input: Record<string, unknown>, result: unknown, isReadOnly: boolean): Promise<void> {
  const view = await read($, viewAtom)
  if (!view.root) return
  const now = await $.clock.now()
  const acts = touchedBy(tool, input, result, view.root, now).filter(one => isInside(view.root, one.path))
  const verbs = tool === 'Bash' ? shellEffects(String(input.command ?? ''), view.root).git : []
  if (verbs.includes('init') || verbs.includes('clone')) held.repo = undefined
  if (acts.length > 0) {
    await update($, activityAtom, list => recorded(list, acts))
    void scheduleFlash($, held)
    const shown = acts.filter(one => one.kind === 'read' || one.kind === 'modified' || one.kind === 'created').at(-1)
    if (held.config.follow && shown && view.mode === 'tree') await reveal($, held, shown.path)
  }
  if (CHANGING.has(tool) && !isReadOnly) {
    if (acts.some(one => one.kind === 'created' || one.kind === 'removed')) dropIndex(held)
    await refreshDirs($, held, false)
    scheduleGit($, held)
  }
  if (verbs.includes('commit')) await markCommitted($, held, view.root, now)
}

/** Marks the files of the commit just made, as git lists them for HEAD. */
async function markCommitted($: Dollar, held: Held, root: string, now: number): Promise<void> {
  const repo = await repoOf($, held, root)
  if (!repo?.top) return
  const shown = await $.process.run([...GIT, 'show', '--no-ext-diff', '--no-textconv', '--name-only', '--pretty=format:', '-z', 'HEAD'], { cwd: root, timeoutMs: 10_000 }).catch(() => undefined)
  if (shown?.exitCode !== 0) return
  const top = repo.top
  const acts = shown.stdout.split('\0').map(line => line.trim()).filter(Boolean)
    .map(rel => ({ path: resolve(top, rel), kind: 'committed' as const, at: now }))
    .filter(one => isInside(root, one.path))
  if (acts.length === 0) return
  await update($, activityAtom, list => recorded(list, acts.slice(0, 50)))
  void scheduleFlash($, held)
}

/** Forgets the search index: files were made or removed, or the person refreshed. */
function dropIndex(held: Held): void {
  held.index = undefined
  held.indexing = undefined
  held.indexGeneration++
}

/** The search index for `root`, built once and shared by the searches that ask while it is built. */
async function ensureIndex($: Dollar, held: Held, root: string): Promise<Held['index']> {
  if (held.index?.root === root) return held.index
  if (held.indexing?.root === root) return held.indexing.job
  const job = buildIndex($, held, root)
  held.indexing = { root, job }
  try {
    return await job
  } finally {
    if (held.indexing?.job === job) held.indexing = undefined
  }
}

/** The relative paths search reads: `git ls-files` (tracked and untracked, ignores honoured) in a repository, else a bounded walk. */
async function buildIndex($: Dollar, held: Held, root: string): Promise<Held['index']> {
  const generation = held.indexGeneration
  const ignored = new Set(held.config.ignore)
  let files: string[] = []
  const repo = await repoOf($, held, root)
  const listed = repo?.top
    ? await $.process.run([...GIT, 'ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, timeoutMs: 15_000 }).catch(() => undefined)
    : undefined
  if (listed?.exitCode === 0) {
    files = listed.stdout.split('\0').filter(rel => rel !== '' && !rel.split('/').some(part => ignored.has(part))).slice(0, MAX_INDEX)
  } else {
    // Breadth-first, skipping ignored names and links (a link can lead back up the tree), held to MAX_INDEX entries.
    let level: string[] = ['']
    for (let depth = 0; depth < WALK_DEPTH && level.length > 0 && files.length < MAX_INDEX; depth++) {
      const next: string[] = []
      for (const rel of level) {
        const found = await $.fs.list(rel ? join(root, rel) : root).catch(() => [])
        for (const one of found) {
          if (ignored.has(one.name) || one.isLink) continue
          const path = rel ? `${rel}/${one.name}` : one.name
          if (one.kind === 'dir') next.push(path)
          else files.push(path)
        }
        if (files.length >= MAX_INDEX) break
      }
      level = next
    }
  }
  const all = withDirectories(files)
  const fileSet = new Set(files)
  const index = { root, files: all, dirs: new Set(all.filter(rel => !fileSet.has(rel))) }
  if (generation === held.indexGeneration) held.index = index
  return index
}

async function runSearch($: Dollar, held: Held, query: string): Promise<void> {
  const view = await read($, viewAtom)
  const index = await ensureIndex($, held, view.root)
  const hits = rank(index?.files ?? [], query, { mode: held.config.search, showHidden: view.showHidden })
  await update($, viewAtom, (current): ExplorerView => ({ ...current, mode: 'search', query, hits, hitCursor: 0 }))
}

async function note($: Dollar, text: string | undefined): Promise<void> {
  await update($, viewAtom, view => (text === undefined ? (({ note: _, ...rest }) => rest)(view) : { ...view, note: text }))
}

/** Shows `path` in the pane: Markdown drawn, code highlighted; too large or binary files only say so. */
async function showPreview($: Dollar, path: string): Promise<void> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat || stat.kind !== 'file') return note($, 'Not a readable file.')
  if (stat.size > PREVIEW_BYTES) return note($, `Too large to preview (${Math.round(stat.size / 1024)} KB): press e to open it.`)
  const text = await $.fs.read(path).catch(() => undefined)
  if (typeof text !== 'string') return note($, 'The file could not be read.')
  if (text.includes('\u0000')) return note($, 'A binary file: press e to open it.')
  const lines = text.split('\n')
  const preview: Preview = { path, text: lines.slice(0, PREVIEW_LINES).join('\n'), isMarkdown: /\.(md|mdx|markdown)$/i.test(path) }
  if (lines.length > PREVIEW_LINES) preview.note = `first ${PREVIEW_LINES} of ${lines.length} lines`
  await update($, viewAtom, (view): ExplorerView => ({ ...view, mode: 'preview', preview }))
}

/** Opens `path` with the configured editor command, or the platform's default app; never through a shell. */
async function openExternally($: Dollar, held: Held, path: string): Promise<void> {
  const view = await read($, viewAtom)
  if (!held.platform) {
    const uname = /^[A-Za-z]:/.test(view.root) ? undefined : await $.process.run(['uname', '-s'], { timeoutMs: 3000 }).catch(() => undefined)
    held.platform = platformOf(view.root, uname?.stdout)
  }
  const argv = openArgv(held.config.editor, path, 1, held.platform)
  if (!argv) return note($, 'The editor setting is not one command.')
  const ran = await $.process.run(argv, { cwd: parent(path), timeoutMs: 10_000 }).catch(() => undefined)
  await note($, ran?.exitCode === 0 ? `Opened ${base(path)}.` : `Could not open ${base(path)} with ${argv[0]}.`)
}

/** Puts `@path` at the prompt's cursor, unless the draft already names it. Nothing of the file is read. */
async function mentionInPrompt($: Dollar, root: string, path: string): Promise<void> {
  const text = mention(relative(root, path) || '.')
  const box = await $.prompt.read()
  // A quoted mention holds spaces, so the draft is searched for it whole, between whitespace or the ends.
  const named = new RegExp(`(^|\\s)${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`)
  if (named.test(box.text)) return note($, `${text} is already in the prompt.`)
  const filled = await $.prompt.fill({ text: `${text} `, mode: 'insert' })
  await note($, filled.isFilled ? `Added ${text} to the prompt.` : 'The prompt did not take the path.')
}

/** The rows the pane shows now: the tree, or the hits while searching. */
async function currentRows($: Dollar, held: Held, view: ExplorerView): Promise<Row[]> {
  if (view.mode === 'search') return hitRows(view, rel => held.index?.dirs.has(rel) ?? false)
  return treeRows(view, await read($, dirsAtom), held.config)
}

/** Carries out what a move asked for. */
async function apply($: Dollar, held: Held, effect: Effect, surface: string): Promise<void> {
  const view = await read($, viewAtom)
  switch (effect.kind) {
    case 'load': return ensureLoaded($, held)
    case 'reveal': return reveal($, held, effect.path)
    case 'activate': return held.config.enterAction === 'editor' ? openExternally($, held, effect.path) : showPreview($, effect.path)
    case 'preview': return showPreview($, effect.path)
    case 'editor': return openExternally($, held, effect.path)
    case 'mention': return mentionInPrompt($, view.root, effect.path)
    case 'copy': {
      const text = relative(view.root, effect.path) || '.'
      const copied = await $.ui.copy({ text, surface: surface as never })
      return note($, copied.isCopied ? `Copied ${text}.` : 'Nothing was copied.')
    }
    case 'search':
      await update($, viewAtom, (current): ExplorerView => ({ ...current, mode: 'search' }))
      void ensureIndex($, held, view.root)
      await $.ui.focus({ requestId: PANE, key: 'query' })
      return
    case 'refresh':
      dropIndex(held)
      held.repo = undefined
      await refreshDirs($, held, true)
      scheduleGit($, held)
      return note($, 'Refreshed.')
    case 'back':
      await update($, viewAtom, ({ preview: _, ...current }): ExplorerView => ({ ...current, mode: 'tree', query: '', hits: [], hitCursor: 0 }))
  }
}

/** One key from the rows, a hotkey or a click: the move, then its effect. */
async function press($: Dollar, held: Held, key: string, surface: string): Promise<void> {
  if ((await read($, viewAtom)).note) await note($, undefined)
  const view = await read($, viewAtom)
  if (view.mode === 'preview') {
    if (key === 'q' || key === 'h' || key === 'left') await apply($, held, { kind: 'back' }, surface)
    else if (key === 'e' && view.preview) await apply($, held, { kind: 'editor', path: view.preview.path }, surface)
    return
  }
  const rows = await currentRows($, held, view)
  const step = navigate(view, rows, key, held.height)
  if (step.view !== view) await update($, viewAtom, () => step.view)
  if (step.effect) await apply($, held, step.effect, surface)
}

/** A click on the row `y` cells below the first shown: selects it, toggles a directory, opens a file on a double click. */
async function click($: Dollar, held: Held, y: number, surface: string): Promise<void> {
  const view = await read($, viewAtom)
  const rows = await currentRows($, held, view)
  const top = scrollTop(view.top, cursorIndex(view, rows), held.height, rows.length)
  const index = top + y
  const row = rows[index]
  if (!row) return
  const now = await $.clock.now()
  const isDouble = held.lastClick?.index === index && now - held.lastClick.at < DOUBLE_CLICK_MS
  held.lastClick = { index, at: now }
  if (view.mode === 'search') {
    await update($, viewAtom, () => ({ ...view, hitCursor: index }))
    return isDouble ? press($, held, 'return', surface) : undefined
  }
  await update($, viewAtom, () => ({ ...view, cursor: row.path, top }))
  if (row.kind === 'dir') {
    if (row.isOpen) await update($, viewAtom, () => collapse({ ...view, top }, row.path))
    else await press($, held, 'l', surface)
  } else if (isDouble) await press($, held, 'return', surface)
}

/** Marks the file a write is about to change, and opens the tree to it when following, so its row shimmers while it runs. */
async function startWriting($: Dollar, held: Held, path: string): Promise<void> {
  await update($, editingAtom, list => (list.includes(path) ? list : [...list, path]))
  const view = await read($, viewAtom)
  if (held.config.follow && view.mode === 'tree') await reveal($, held, path)
}

type HeaderAction = 'up' | 'reveal' | 'hidden' | 'collapse'

/** The header's buttons: the root's parent, the last file Claude touched, every folder closed, dotfiles. */
async function headerAction($: Dollar, held: Held, action: HeaderAction, surface: string): Promise<void> {
  const view = await read($, viewAtom)
  switch (action) {
    case 'up': {
      const up = parent(view.root)
      if (up === view.root) return note($, 'Already at the top.')
      return setRoot($, held, up, true)
    }
    case 'reveal': {
      const last = (await read($, activityAtom)).find(one => one.kind !== 'removed' && isInside(view.root, one.path) && one.path !== view.root)
      if (!last) return note($, 'Claude has not touched a file here yet.')
      return reveal($, held, last.path)
    }
    case 'hidden': return press($, held, '.', surface)
    case 'collapse':
      await update($, viewAtom, ({ preview: _, ...current }): ExplorerView => ({ ...collapseAll(current), mode: 'tree', query: '', hits: [], hitCursor: 0 }))
  }
}

// Words, not glyphs: the API has no tooltip to explain an icon. Refresh is in the footer (`r`), and the pane's own
// frame carries a close control on every surface.
const HEADER: readonly { action: HeaderAction; label: string }[] = [
  { action: 'up', label: 'up' },
  { action: 'reveal', label: 'last file' },
  { action: 'collapse', label: 'collapse' },
  { action: 'hidden', label: 'dotfiles' },
]
const HEADER_WIDTH = HEADER.reduce((sum, one) => sum + one.label.length, 0) + 3 * (HEADER.length - 1)

const KEYS: readonly { hotkey: string; label: string }[] = [
  { hotkey: 'j', label: '↓' }, { hotkey: 'k', label: '↑' }, { hotkey: 'h', label: '←' }, { hotkey: 'l', label: '→' },
  { hotkey: 'o', label: 'open' }, { hotkey: 's', label: 'find' }, { hotkey: 'a', label: '@ref' }, { hotkey: 'r', label: '↻' },
]
// Each hotkey Button draws as `j: ↓` and a space between them.
const KEYS_WIDTH = KEYS.reduce((sum, one) => sum + one.hotkey.length + 2 + one.label.length + 1, 0)
/** Footer lines of recent activity. */
const RECENT = 2

export const register: Register = (on, options) => {
  const held: Held = { config: configOf(options as Record<string, unknown>), height: 20, gitBusy: false, gitAgain: false, indexGeneration: 0 }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'file-explorer',
      description: 'Open the file explorer pane (args: a folder to pin, "close", "refresh", "hidden")',
      argumentHint: '[folder|close|refresh|hidden]',
    })
    await observe($, async () => {
      // A write that was running when the module reloaded ends unseen: its row must not shimmer on.
      await update($, editingAtom, () => [])
      const view = await read($, viewAtom)
      const root = normalize(e.cwd)
      // A reload keeps the view the host holds, its folders read again so a changed sort applies; a new session, or
      // one in another folder, starts afresh.
      if (view.root && (view.isPinned || view.root === root)) {
        await refreshDirs($, held, true)
        scheduleGit($, held)
      } else await setRoot($, held, root, false)
      if (held.config.refreshSeconds > 0) {
        held.refresh = $.clock.every(held.config.refreshSeconds * 1000, () => void observe($, async () => {
          if ((await $.ui.panes()).some(pane => pane.id === PANE)) await refreshDirs($, held, false)
        }))
      }
      // The modified column says `3m` or `2h`: redraw it as time passes, only while the pane is open.
      if (held.config.mtime) {
        held.ages = $.clock.every(AGES_MS, () => void observe($, async () => {
          if ((await $.ui.panes()).some(pane => pane.id === PANE)) await update($, tickAtom, n => n + 1)
        }))
      }
      if (held.config.autoOpen) void $.ui.open({ id: PANE, title: TITLE })
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear or a resume goes on in this process, and no session.start follows to start the timers again.
    if (e.reason === 'clear' || String(e.reason) === 'resume') return next(e)
    held.refresh?.cancel()
    held.ages?.cancel()
    held.gitTimer?.cancel()
    held.flash?.cancel()
    return next(e)
  })

  on('command.run', { command: 'file-explorer' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'File explorer closed.' }
    }
    if (arg === 'refresh' || arg === 'hidden') {
      await press($, held, arg === 'refresh' ? 'r' : '.', 'terminal')
      return { text: arg === 'refresh' ? 'File explorer refreshed.' : 'Toggled hidden files.' }
    }
    if (arg !== '') {
      const view = await read($, viewAtom)
      const root = resolve(view.root || '/', arg.replace(/^["']|["']$/g, ''))
      const stat = await $.fs.stat(root).catch(() => undefined)
      if (stat?.kind !== 'dir') return { text: `Not a folder: ${arg}` }
      await setRoot($, held, root, true)
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: opened.isPlaced ? 'File explorer open.' : `File explorer waits for room: ${opened.reason}` }
  })

  // Each observing hook below ends in .catch(next): should it fail, what its next settled goes on as it came, and
  // nothing runs twice.

  // Git's own files: the index and HEAD change on stage, commit, checkout and pull, whoever runs them.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    try {
      const repo = await repoOf($, held, normalize(e.cwd))
      if (!repo?.gitDir) return result
      return { ...result, watchPaths: [...(result.watchPaths ?? []), `${repo.gitDir}/index`, `${repo.gitDir}/HEAD`] }
    } catch {
      return result
    }
  }).catch((_$, e, next) => next(e))

  on('classic.FileChanged', async ($, e, next) => {
    const result = await next(e)
    const gitDir = held.repo?.gitDir
    if (gitDir && isInside(gitDir, normalize(e.file_path))) scheduleGit($, held)
    return result
  }).catch((_$, e, next) => next(e))

  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    await observe($, async () => {
      const view = await read($, viewAtom)
      if (!view.isPinned) await setRoot($, held, normalize(e.new_cwd), false)
    })
    return result
  }).catch((_$, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const root = (await read($, viewAtom)).root
    const target = root ? writing(tool, e as unknown as Record<string, unknown>, root) : undefined
    const path = target && isInside(root, target) ? target : undefined
    if (path) await observe($, () => startWriting($, held, path))
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
    } finally {
      if (path) await observe($, async () => { await update($, editingAtom, list => list.filter(one => one !== path)) })
    }
    if (result.deny !== undefined || result.isError) return result
    if (CHANGING.has(tool) || ['Read', 'Grep', 'Glob'].includes(tool)) {
      await observe($, () => touched($, held, tool, e as unknown as Record<string, unknown>, result.result, result.isReadOnly === true))
    }
    return result
  }).catch((_$, e, next) => next(e))

  // `@path` in a prompt: the file is attached as the engine decides; the explorer only shows where it is.
  on('prompt.mention', async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && e.agentId === undefined) {
      await observe($, async () => {
        if ((await read($, viewAtom)).mode !== 'preview') await reveal($, held, normalize(e.path))
      })
    }
    return result
  }).catch((_$, e, next) => next(e))

  on('ui.message', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const data = (e.data ?? {}) as { key?: unknown; click?: unknown; ctrl?: unknown; meta?: unknown }
    await observe($, async () => {
      if (typeof data.key === 'string' && !data.ctrl && !data.meta) await press($, held, data.key, e.surface)
      else if (typeof data.click === 'number') await click($, held, data.click, e.surface)
    })
    return {}
  })

  // The wheel over the tree moves the rows the pane shows; the pane itself never scrolls past them.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    await observe($, async () => {
      const view = await read($, viewAtom)
      if (view.mode !== 'tree') return
      const rows = await currentRows($, held, view)
      const top = Math.max(0, Math.min(view.top + e.by, Math.max(0, rows.length - held.height)))
      const index = cursorIndex(view, rows)
      // Keep the cursor inside the window the wheel moved to.
      const cursor = rows[Math.max(top, Math.min(index, top + held.height - 1))]?.path ?? view.cursor
      await update($, viewAtom, () => ({ ...view, top, cursor }))
    })
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const view = await read($, viewAtom)
    const git = await read($, gitAtom)
    const activity = await read($, activityAtom)
    const editing = await read($, editingAtom)
    await read($, tickAtom)
    const now = await $.clock.now()
    // Nerd Font glyphs need the person's patched terminal font; every other surface draws with a font of its own.
    const config = e.surface === 'terminal' ? held.config : { ...held.config, icons: 'unicode' as const }
    const columns = Math.max(10, e.props.bodyColumns)
    const c = (tone: Parameters<typeof colorOf>[0]) => colorOf(tone, config.theme)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const paint = (segments: readonly Segment[]) => segments.map(one => <Text color={one.c} backgroundColor={one.bg} bold={one.b} dimColor={one.d}>{one.t}</Text>)

    const title: Segment[] = [
      { t: `${iconOf('', 'dir', true, false, config.icons)} ${base(view.root) || view.root} `, c: c('accent'), b: true },
      ...branchSegments(git ?? undefined, git ? totals(git.lines) : { added: 0, removed: 0 }, config),
    ]

    if (view.mode === 'preview' && view.preview) {
      const { preview } = view
      const { Code, Markdown } = table
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">{paint([{ t: relative(view.root, preview.path) || preview.path, c: c('accent'), b: true }, ...(preview.note ? [{ t: `  ${preview.note}`, c: c('dim') }] : [])])}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="back" plain hotkey="q" autoFocus label="back" onPress={() => void observe($, () => press($, held, 'q', e.surface))} />
            <Button key="edit" plain hotkey="e" label="open in editor" onPress={() => void observe($, () => press($, held, 'e', e.surface))} />
          </Box>
          {preview.isMarkdown ? <Markdown text={preview.text} /> : <Code source={preview.text} path={preview.path} startLine={1} />}
        </Box>
      )
    }

    const recent = activity.slice(0, RECENT).filter(one => now - one.at < 3_600_000)
    const keyRows = Math.ceil(KEYS_WIDTH / columns)
    const hasButtons = columns >= HEADER_WIDTH
    // Rows around the tree: the buttons, the title, the search field, a blank row, the selected line, a blank row
    // before the keys.
    const height = Math.max(3, e.props.scroll.bodyRows - (hasButtons ? 1 : 0) - 5 - recent.length - (view.note ? 1 : 0) - keyRows)
    held.height = height
    const rows = await currentRows($, held, view)
    const cursor = cursorIndex(view, rows)
    const top = scrollTop(view.top, cursor, height, rows.length)
    const shown = rows.slice(top, top + height)
    const states = rowStates(shown, cursor - top, activity, git, view.root, now, editing)
    const lines = shown.map((row, i) => rowSegments(row, states[i] ?? { hasMarkBelow: false, isCursor: false }, { columns, config, now }))
    // The footer names the row the keys act on, in full where the tree cuts it.
    const selected = rows[cursor]
    const selectedName = !selected ? undefined
      : selected.kind === 'more' || selected.kind === 'loading' ? selected.name.trim()
      : relative(view.root, selected.path) || selected.name
    if (rows.length === 0) {
      const empty = view.mode === 'search' ? (view.query ? 'No match.' : 'Type to search every file.') : 'Empty folder.'
      lines.push([{ t: ` ${empty}`, c: c('dim') }])
    }

    // The rows' module takes keys and clicks where a surface runs one; elsewhere the rows are text and the hotkeys move.
    let tree = <Box flexDirection="column">{lines.map(line => <Text wrap="truncate-end">{paint(line)}</Text>)}</Box>
    let search = null
    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Client, Input } = $.ui.resolve(e)
      tree = <Client key="rows" module="./rows.tsx" props={{ lines }} height={Math.max(1, lines.length)} />
      search = (
        <Input
          key="query"
          placeholder="/ search files"
          value={view.query}
          rows={1}
          onInput={value => void observe($, () => runSearch($, held, value))}
          onSubmit={value => void observe($, async () => {
            await runSearch($, held, value)
            const first = (await read($, viewAtom)).hits[0]
            if (first !== undefined) await reveal($, held, resolve(view.root, first))
          })}
        />
      )
    }

    return (
      <Box flexDirection="column">
        {/* The buttons have the top row to themselves, right-aligned, above the folder and its branch. */}
        {hasButtons ? (
          <Box flexDirection="row" justifyContent="flex-end">
            <Box key="head-buttons" flexDirection="row" flexShrink={0} gap={1}>
              {HEADER.flatMap((one, i) => [
                ...(i > 0 ? [<Text dimColor>·</Text>] : []),
                <Button
                  key={`head-${one.action}`}
                  plain
                  // `dotfiles` is drawn full while they are shown, dim while hidden, as the other buttons rest.
                  dimColor={!(one.action === 'hidden' && view.showHidden)}
                  label={one.label}
                  onPress={() => void observe($, () => headerAction($, held, one.action, e.surface))}
                />,
              ])}
            </Box>
          </Box>
        ) : null}
        <Text wrap="truncate-end">{paint(title)}</Text>
        {search}
        {tree}
        <Box height={1} />
        {selectedName ? <Text wrap="truncate-start">{paint([{ t: 'selected: ', c: c('dim') }, { t: selectedName, c: c('text') }])}</Text> : null}
        {recent.map(one => (
          <Text wrap="truncate-end">{paint([
            { t: '● ', c: c(one.kind) },
            { t: `${ACTIVITY_LABEL[one.kind]} `, c: c(one.kind) },
            { t: cut(relative(view.root, one.path) ?? one.path, Math.max(4, columns - 18)), c: c('text') },
            { t: ` ${ago(now - one.at)}`, c: c('dim') },
          ])}</Text>
        ))}
        {view.note ? <Text wrap="truncate-end" color={c('dim')}>{view.note}</Text> : null}
        <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
          {KEYS.map(one => (
            <Button key={`key-${one.hotkey}`} plain hotkey={one.hotkey} label={one.label} onPress={() => void observe($, () => press($, held, one.hotkey === 's' ? '/' : one.hotkey, e.surface))} />
          ))}
        </Box>
      </Box>
    )
  })
}
