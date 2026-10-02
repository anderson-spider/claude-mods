import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CheckStatus, PanelView, PrSnapshot } from '../types'
import { readAll } from './panel'
import type { Probe } from './panel'

const PANE = 'review-panel'
const TITLE = 'Review'
const POLL_MS = 30_000
// Border-less pane: the tab row, the blank line after it and the scroll row.
const CHROME_ROWS = 3

const INITIAL: PanelView = {
  tab: 'diff',
  branch: '',
  diff: [],
  diffError: '',
  pr: { kind: 'none', message: 'Reading…' },
  readAt: 0,
  isLoading: false,
  offset: 0,
}

const view = atom({ plugin: 'review-panel', key: 'view' } as const, INITIAL)

type Row = { text: string; color?: 'success' | 'error' | 'warning'; isDim?: boolean; isBold?: boolean }

let isPolling = false

const probe = ($: EngineInterface): Probe => ({ run: (argv, init) => $.process.run(argv, init) })

/** Reads the worktree again and redraws; a read still running makes a second call a no-op. */
const refresh = async ($: EngineInterface) => {
  let isBusy = false

  await update($, view, now => {
    isBusy = now.isLoading

    return isBusy ? now : { ...now, isLoading: true }
  })

  if (isBusy) {
    return
  }

  const dir = await $.session.cwd()
  const found = await readAll(probe($), dir)
  const readAt = await $.clock.now()

  await update($, view, now => ({ ...now, ...found, readAt, isLoading: false }))
}

const ICON: Record<CheckStatus, string> = { success: '✓', failure: '✗', running: '●', pending: '○', skipped: '–' }
const COLOR: Record<CheckStatus, Row['color']> = {
  success: 'success',
  failure: 'error',
  running: 'warning',
  pending: undefined,
  skipped: undefined,
}

const diffRows = (now: PanelView): Row[] => {
  if (now.diffError !== '') {
    return [{ text: now.diffError, color: 'error' }]
  }

  if (now.diff.length === 0) {
    return [{ text: 'No changes against HEAD.', isDim: true }]
  }

  const rows: Row[] = []

  for (const file of now.diff) {
    rows.push({
      text: file.isUntracked ? `${file.path}  (untracked)` : `${file.path}  +${file.added} -${file.removed}`,
      isBold: true,
    })

    for (const line of file.lines) {
      rows.push({
        text: `  ${line}`,
        color: line.startsWith('+') ? 'success' : line.startsWith('-') ? 'error' : undefined,
        isDim: !line.startsWith('+') && !line.startsWith('-'),
      })
    }
  }

  return rows
}

const prRows = (pr: PrSnapshot): Row[] => {
  const rows: Row[] = [
    { text: `#${pr.number} ${pr.title}${pr.isDraft ? ' (draft)' : ''}`, isBold: true },
    { text: `${pr.state} · ${pr.headRef} → ${pr.baseRef} · merge: ${pr.merge}`, color: pr.merge === 'clean' ? undefined : 'warning' },
    { text: pr.url, isDim: true },
    { text: '' },
    { text: 'Description', isBold: true },
    ...(pr.body.trim() === '' ? [{ text: '  none', isDim: true }] : pr.body.split('\n').map(line => ({ text: `  ${line.replace(/\r$/, '')}` }))),
    { text: '' },
    { text: `Checks (${pr.checks.length})`, isBold: true },
    ...(pr.checks.length === 0 ? [{ text: '  none', isDim: true }] : pr.checks.map(check => ({ text: `  ${ICON[check.status]} ${check.name}`, color: COLOR[check.status] }))),
    { text: '' },
    { text: `Comments (${pr.comments.length})`, isBold: true },
  ]

  if (pr.comments.length === 0) {
    rows.push({ text: '  none', isDim: true })
  }

  for (const comment of pr.comments) {
    const flags = `${comment.isResolved ? ' · resolved' : ''}${comment.isOutdated ? ' · outdated' : ''}`

    rows.push({ text: `  ${comment.author} · ${comment.anchor}${flags}`, isDim: comment.isResolved || comment.isOutdated })

    for (const line of comment.body.split('\n').filter(one => one.trim() !== '')) {
      rows.push({ text: `    ${line}`, isDim: comment.isResolved || comment.isOutdated })
    }
  }

  return rows
}

const rowsOf = (now: PanelView): Row[] => {
  if (now.tab === 'diff') {
    return diffRows(now)
  }

  if (now.pr.kind === 'pr') {
    return prRows(now.pr.pr)
  }

  return [{ text: now.pr.message, color: now.pr.kind === 'error' ? 'error' : undefined, isDim: now.pr.kind === 'none' }]
}

const ago = (readAt: number, now: number): string => {
  if (readAt === 0) {
    return 'not read yet'
  }

  const seconds = Math.max(0, Math.round((now - readAt) / 1000))

  return seconds < 60 ? `read ${seconds}s ago` : `read ${Math.round(seconds / 60)}m ago`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'review-panel',
      description: 'Show the diff, the open pull request, its CI jobs and its comments in a pane',
    })

    return next(e)
  })

  on('command.run', { command: 'review-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    if (!isPolling) {
      isPolling = true
      $.clock.every(POLL_MS, () => void refresh($))
    }

    void refresh($)

    return { text: 'Review pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await read($, view)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - CHROME_ROWS)
    const rows = rowsOf(now)
    const top = Math.min(now.offset, Math.max(0, rows.length - room))
    const shown = rows.slice(top, top + room)
    const clock = await $.clock.now()

    const setTab = (tab: PanelView['tab']) => update($, view, one => ({ ...one, tab, offset: 0 }))
    const scroll = (by: number) => update($, view, one => ({ ...one, offset: Math.max(0, top + by) }))

    return (
      <Box flexDirection="column">
        <Box gap={2}>
          <Button key="diff" label={now.tab === 'diff' ? '[Diff]' : 'Diff'} hotkey="1" plain onPress={() => setTab('diff')} />
          <Button key="pr" label={now.tab === 'pr' ? '[PR]' : 'PR'} hotkey="2" plain onPress={() => setTab('pr')} />
          <Button key="refresh" label="Refresh" hotkey="r" plain onPress={() => void refresh($)} />
          <Text dimColor wrap="truncate-end">
            {now.isLoading ? 'reading…' : `${now.branch || 'no branch'} · ${ago(now.readAt, clock)}`}
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {shown.map(row => (
            <Text wrap="truncate-end" color={row.color} dimColor={row.isDim} bold={row.isBold}>
              {row.text === '' ? ' ' : row.text}
            </Text>
          ))}
        </Box>
        <Box gap={2}>
          <Button key="up" label="▲" hotkey="k" plain onPress={() => scroll(-Math.max(1, room - 1))} />
          <Button key="down" label="▼" hotkey="j" plain onPress={() => scroll(Math.max(1, room - 1))} />
          <Text dimColor>{`${rows.length === 0 ? 0 : top + 1}–${Math.min(rows.length, top + room)} of ${rows.length}`}</Text>
        </Box>
      </Box>
    )
  })
}
