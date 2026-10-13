import { expect, test } from 'claude-code/testing'

import { COMMANDS, COMMAND_DESCRIPTION, HELP, parseCommand } from '../hooks/commands'
import { COMMAND_TEXT } from '../hooks/presentation'

// The table is the one place a `/codex-cu` command is listed: what it parses,
// what HELP says and what the registered description says come from its rows.

test('no word selects two rows', () => {
  const names = COMMANDS.flatMap(row => row.names)

  expect(new Set(names).size).toBe(names.length)
})

test('HELP is the rows’ help lines in table order and the description is their synopses', () => {
  expect(HELP.split('\n')).toEqual(COMMANDS.flatMap(row => row.help))
  expect(COMMAND_DESCRIPTION).toBe(`Codex computer use: ${COMMANDS.flatMap(row => ('synopsis' in row ? [row.synopsis] : [])).join(' | ')}`)
})

test('every usage text a row can show is listed by a row', () => {
  const lines = COMMANDS.flatMap(row => row.help)
  const synopses = COMMANDS.flatMap(row => ('synopsis' in row ? [row.synopsis] : []))

  for (const text of Object.values(COMMAND_TEXT)) {
    expect(lines).toContain(text.help)

    if ('synopsis' in text) {
      expect(synopses).toContain(text.synopsis)
    }
  }
})

test('every help line starts with the command and names a usage the parser accepts', () => {
  const usages = HELP.split('\n').map(line => line.split(/\s{2,}/)[0] ?? '')

  for (const usage of usages) {
    expect(usage.startsWith('/codex-cu ')).toBe(true)
    const kinds = parseCommand(usage.slice('/codex-cu '.length).replace('|off', '').replace('<app>', 'Some App')).kind

    expect(kinds).not.toBe('help')
  }
})

test('each row’s first word, alone, parses to its own command', () => {
  const kinds = COMMANDS.flatMap(row => row.names.map(name => [name, parseCommand(name).kind] as const))

  expect(kinds).toEqual([
    ['on', 'on'],
    ['off', 'off'],
    ['status', 'status'],
    ['', 'status'],
    ['auto-approve', 'help'],
    ['forget', 'forget'],
    ['help', 'help'],
  ])
})
